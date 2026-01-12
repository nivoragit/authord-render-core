// deno-lint-ignore-file no-explicit-any
/**
 * DocsetAssembler
 * ---------------------------------------------------------------------------
 * Domain language:
 * - "topic page" => a .topic file parsed into xast Element <topic>
 * - "md page"    => a .md file wrapped as a synthetic xast <md-page>
 * - "final AST"  => a composite object that carries validated instance ASTs,
 *                   resolved topic ASTs, and md wrappers (all xast-based)
 *
 * Responsibilities:
 * 1) Parse Writerside cfg (XML) → IRConfig
 * 2) Parse instance profiles (XML + DTD) → xast <instance>, collect page refs
 * 3) Parse topic pages (XML; lenient, no validation yet)
 * 4) Preload the *transitive closure* of <include> targets that actually exist
 * 5) Wrap Markdown pages as synthetic xast (<md-page> with raw text)
 * 6) Resolve <include> transclusions (fixed-point with depth cap)
 * 7) Inline external code into <code-block src>, honoring include-lines
 * 8) Validate only final resolved topic trees (XSD, robust to remote schemas)
 */

import type { Element as XEl, ElementContent } from "xast";
import { WritersideCfgParser } from "../domain/parse/cfg_parser.ts";
import type { IRConfig } from "../domain/parse/cfg_parser.ts";
import { InstanceProfileParser } from "../domain/parse/instance_profile_parser.ts";
import { TopicParser } from "../domain/parse/topic_parser.ts";
import { localName } from "../domain/parse/xast_xml.ts";
import { buildXsdIndex } from "../domain/parse/xsd_index.ts";
import { validateAgainstXsd } from "../domain/parse/xsd_validator.ts";
import type { Fetcher } from "../shared/fetcher.ts";
import type { Resource } from "../shared/resource.ts";

const PLACEHOLDER_RE = /%([A-Za-z][A-Za-z0-9._-]*)%/g;

/** Builder options */
export type BuildDocsetOptions = {
  cfgPath: string;
  resource: Resource;
  macros?: Record<string, string>;
  fetchExternalCode?: boolean;
  maxIncludeDepth?: number;
  /** If true, allow fetching http(s) XSDs for final validation. Default: false. */
  allowRemoteSchemaFetch?: boolean;
  fetcher: Fetcher;
};

/** Final composite AST (xast everywhere). */
export type AuthordAst = {
  type: "docset";
  data: { cfg: IRConfig };
  instances: { path: string; ast: XEl }[];
  pages: { path: string; kind: "topic" | "markdown"; ast: XEl }[];
};

export class AuthordAstAssembler {
  constructor(
    private readonly writersideCfgParser = new WritersideCfgParser(),
    private readonly instanceProfileParser = new InstanceProfileParser(),
    private readonly topicPageParser = new TopicParser(),
  ) {}

  async build({
    cfgPath: cfgFilePath,
    resource,
    macros = {},
    fetchExternalCode = false,
    maxIncludeDepth = 12,
    fetcher,
    allowRemoteSchemaFetch = false,
  }: BuildDocsetOptions): Promise<AuthordAst> {
    
    // 1) Parse + validate cfg
    const cfgXmlRaw = await resource.readText(cfgFilePath);
    const cfg = await this.writersideCfgParser.parse(cfgXmlRaw, fetcher); // todo move this to top layer
    const topicsRootDir = resource.resolve(cfgFilePath, cfg.topicsDir);

    // 2) Parse instances + collect page refs
    const parsedInstances: { path: string; ast: XEl }[] = [];
    const topicPagePaths = new Set<string>();
    const mdPagePaths = new Set<string>();
    for (const inst of cfg.instances) {
      const absInstancePath = resource.resolve(cfgFilePath, inst.src);
      const instanceXml = applyMacros(await resource.readText(absInstancePath), macros);
      const instanceAst = await this.instanceProfileParser.parse(instanceXml , fetcher);
      parsedInstances.push({ path: absInstancePath, ast: instanceAst });
      collectTopicPageRefsFromInstanceAst(instanceAst, (refPath) => {
        const absPagePath = resource.resolve(topicsRootDir, refPath);
        if (refPath.toLowerCase().endsWith(".topic")) topicPagePaths.add(absPagePath);
        else if (refPath.toLowerCase().endsWith(".md")) mdPagePaths.add(absPagePath);
      });
    }

    // 3) Parse top-level topic pages + preload transitive includes
    const topicAstByPath = new Map<string, XEl>();
    for (const p of topicPagePaths) {
      topicAstByPath.set(p, await this.#parseTopicPage(resource, macros, p, fetcher));
    }
    await this.#preloadIncludeTransitiveClosure({
      topicAstByPath,
      resource,
      macros,
      maxDepth: maxIncludeDepth,
      fetcher,
    });

    // 4) Wrap Markdown
    const mdAstByPath = new Map<string, XEl>();
    for (const p of mdPagePaths) {
      const mdRaw = applyMacros(await resource.readText(p), macros);
      mdAstByPath.set(p, wrapMarkdownAsMdPageXast(mdRaw, p));
    }

    // 5) Resolve includes
    for (const [topicPath, topicAst] of topicAstByPath) {
      await resolveIncludeTransclusions({
        currentTopicPath: topicPath,
        root: topicAst,
        getTopicPageByPath: (fromOrAbs, base) => {
          const absPath = isAbsolute(fromOrAbs) ? fromOrAbs : resource.resolve(base, fromOrAbs);
          return topicAstByPath.get(absPath);
        },
        resource,
        maxDepth: maxIncludeDepth,
      });
    }

    // 6) Inline code-block src
    for (const [, topicAst] of topicAstByPath) {
      await inlineCodeBlockSources(topicAst, async (src) => {
        if (/^https?:\/\//i.test(src) && !fetchExternalCode) return "";
        const abs = isAbsolute(src)
          ? src
          : resource.resolve((topicAst.attributes?.["src"] as string) ?? "", src);
        try {
          return applyMacros(await resource.readText(abs), macros);
        } catch {
          return "";
        }
      });
    }

    // 7) Validate final resolved topic trees
    for (const [topicPath, topicAst] of topicAstByPath) {
      await validateFinalResolvedTopicTree(topicAst, topicPath, resource, {
        allowRemoteSchemaFetch,
      });
    }

    // 8) Assemble
    const pages: AuthordAst["pages"][number][] = [];
    for (const [path, ast] of topicAstByPath) pages.push({ path, kind: "topic", ast });
    for (const [path, ast] of mdAstByPath) pages.push({ path, kind: "markdown", ast });
    return { type: "docset", data: { cfg }, instances: parsedInstances, pages };
  }

  async #parseTopicPage(
    resource: Resource,
    macros: Record<string, string>,
    absPath: string,
    fetcher: Fetcher,
  ): Promise<XEl> {
    const xml = applyMacros(await resource.readText(absPath), macros);
    const parsed = await this.topicPageParser.parse(xml,fetcher);
    const cloned: XEl = (globalThis as any).structuredClone
      ? (structuredClone as any)(parsed)
      : JSON.parse(JSON.stringify(parsed));
    (cloned.attributes ??= {})["src"] = absPath;
    return cloned;
  }

  async #preloadIncludeTransitiveClosure(
    {
      topicAstByPath,
      resource,
      macros,
      maxDepth,
      fetcher,
    }: {
      topicAstByPath: Map<string, XEl>;
      resource: Resource;
      macros: Record<string, string>;
      maxDepth: number;
      fetcher: Fetcher;
    },
  ) {
    const workQueue: Array<{ path: string; ast: XEl; depth: number }> = [
      ...topicAstByPath.entries(),
    ].map(([path, ast]) => ({ path, ast, depth: 0 }));
    const visitedPaths = new Set<string>([...topicAstByPath.keys()]);
    while (workQueue.length) {
      const { path: currentTopicPath, ast: currentTopicAst, depth } = workQueue.pop()!;
      if (depth >= maxDepth) continue;
      for (const rawFrom of collectIncludeFromTargets(currentTopicAst)) {
        const absTargetPath = resource.resolve(currentTopicPath, rawFrom);
        if (visitedPaths.has(absTargetPath)) continue;
        const exists = await resource.exists(absTargetPath);
        if (!exists) continue;
        const parsedTarget = await this.#parseTopicPage(resource, macros, absTargetPath,fetcher);
        topicAstByPath.set(absTargetPath, parsedTarget);
        workQueue.push({ path: absTargetPath, ast: parsedTarget, depth: depth + 1 });
        visitedPaths.add(absTargetPath);
      }
    }
  }
}

/* ──────────────────────────────── Helpers ──────────────────────────────── */

function applyMacros(text: string, macros: Record<string, string>): string {
  if (Object.keys(macros).length === 0) return text;
  return text.replace(PLACEHOLDER_RE, (_, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(macros, key)) {
      console.error(
        `[authord] error: no macro value provided for: ${key}\n` +
          `→ To fix: open your v.list file and add:\n` +
          `   <var name="${key}" value="YOUR_VALUE_HERE" />`,
      );
      console.log(text); // todo remove
      throw new Error(`No macro value provided for: ${key}`);
    }
    return macros[key];
  });
}

function collectTopicPageRefsFromInstanceAst(root: XEl, visit: (topicRelPath: string) => void) {
  walk(root, (el) => {
    if (localName(el.name) === "toc-element") {
      const topicAttr = el.attributes?.["topic"] as string | undefined;
      if (topicAttr) visit(topicAttr);
    }
  });
}

function collectIncludeFromTargets(root: XEl): string[] {
  const targets: string[] = [];
  walk(root, (el) => {
    if (localName(el.name) === "include") {
      const from = el.attributes?.["from"] as string | undefined;
      if (from) targets.push(from);
    }
  });
  return targets;
}

function walk(el: XEl, fn: (e: XEl) => void) {
  fn(el);
  for (const c of el.children) {
    if (c.type === "element") walk(c as XEl, fn);
  }
}

function findById(root: XEl, id: string): XEl | undefined {
  let found: XEl | undefined;
  walk(root, (el) => {
    if (!found && (el.attributes?.["id"] as string | undefined) === id) found = el;
  });
  return found;
}

function deepClone<T extends ElementContent>(n: T): T {
  return (globalThis as any).structuredClone ? structuredClone(n) : JSON.parse(JSON.stringify(n));
}

function replaceNode(parent: XEl, target: XEl, replacementNodes: ElementContent[]) {
  const i = parent.children.indexOf(target);
  if (i >= 0) parent.children.splice(i, 1, ...replacementNodes);
}

function findParent(root: XEl, target: XEl): XEl | undefined {
  let parent: XEl | undefined;
  (function search(node: XEl) {
    for (const c of node.children) {
      if (c === target) {
        parent = node;
        return;
      }
      if (c.type === "element") search(c as XEl);
    }
  })(root);
  return parent;
}

function isAbsolute(p: string): boolean {
  return /^https?:\/\//i.test(p) || p.startsWith("/");
}

/* ──────────────────────── <include> resolution ─────────────────────────── */

type IncludeResolutionInput = {
  currentTopicPath: string;
  root: XEl;
  getTopicPageByPath: (from: string, base: string) => XEl | undefined;
  resource: Resource;
  maxDepth: number;
};

async function resolveIncludeTransclusions({
  currentTopicPath,
  root,
  getTopicPageByPath,
  resource,
  maxDepth,
}: IncludeResolutionInput) {
  for (let pass = 0; pass < maxDepth; pass++) {
    let mutatedThisPass = false;
    const includeNodes: XEl[] = [];
    walk(root, (el) => {
      if (localName(el.name) === "include") includeNodes.push(el);
    });
    for (const includeEl of includeNodes) {
      const from = includeEl.attributes?.["from"] as string | undefined;
      const elementId = includeEl.attributes?.["element-id"] as string | undefined;
      const isNullable = (includeEl.attributes?.["nullable"] as string | undefined) === "true";
      if (!from || !elementId) continue;
      const absFromPath = isAbsolute(from) ? from : resource.resolve(currentTopicPath, from);
      const looksRemote = /^https?:\/\//i.test(absFromPath);
      if (!looksRemote) {
        const exists = await resource.exists(absFromPath);
        if (!exists) {
          if (isNullable) replaceIncludeWithEmptyContent(root, includeEl);
          continue;
        }
      }
      const targetTopicAst = getTopicPageByPath(absFromPath, currentTopicPath);
      if (!targetTopicAst) {
        if (isNullable) replaceIncludeWithEmptyContent(root, includeEl);
        continue;
      }
      const targetElement = findById(targetTopicAst, elementId);
      if (!targetElement) {
        if (isNullable) replaceIncludeWithEmptyContent(root, includeEl);
        continue;
      }
      const contentPayload = targetElement.children.map((n) => deepClone(n));
      const parent = findParent(root, includeEl);
      if (!parent) continue;
      replaceNode(parent, includeEl, contentPayload);
      mutatedThisPass = true;
    }
    if (!mutatedThisPass) break;
  }
}
function replaceIncludeWithEmptyContent(root: XEl, inc: XEl) {
  const parent = findParent(root, inc);
  if (!parent) return;
  replaceNode(parent, inc, []);
}

/* ──────────────────────── <code-block src> inlining ─────────────────────── */

type FetchCode = (src: string) => Promise<string>;

async function inlineCodeBlockSources(root: XEl, fetchCode: FetchCode) {
  const tasks: Promise<void>[] = [];
  walk(root, (el) => {
    if (localName(el.name) !== "code-block") return;
    const src = el.attributes?.["src"] as string | undefined;
    if (!src) return;
    const includeSpec = (el.attributes?.["include-lines"] as string | undefined)?.trim();
    tasks.push((async () => {
      const raw = await fetchCode(src);
      const content = sliceLines(raw, includeSpec);
      const nonTextChildren = el.children.filter((c) => c.type !== "text");
      el.children = [...nonTextChildren, { type: "text", value: content }];
    })());
  });
  await Promise.all(tasks);
}

function sliceLines(content: string, spec?: string) {
  if (!spec) return content;
  const lines = content.split(/\r?\n/);
  if (spec.includes(",")) {
    return spec.split(",").map((s) => lines[(safeInt(s) ?? 1) - 1] ?? "").join("\n");
  }
  if (spec.includes("-")) {
    const [rawA, rawB] = spec.split("-");
    const a = safeInt(rawA);
    const b = safeInt(rawB);
    const start = Math.max((a ?? 1) - 1, 0);
    if (b === undefined) return lines.slice(start).join("\n");
    const end = Math.min(Math.max(b, 0), lines.length);
    return lines.slice(start, end).join("\n");
  }
  const n = safeInt(spec);
  return Number.isFinite(n) ? (lines[(n ?? 1) - 1] ?? "") : content;
}
function safeInt(s?: string) {
  if (s === undefined) return undefined;
  const trimmed = String(s).trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/* ────────────── Final XSD validation helpers ─────────────── */

function getNoNsSchemaLocation(root: XEl): string | undefined {
  const kv = Object.entries(root.attributes ?? {}).find(([k]) =>
    k.endsWith(":noNamespaceSchemaLocation") || k === "noNamespaceSchemaLocation"
  );
  if (!kv) return undefined;
  const raw = String(kv[1]).trim();
  const parts = raw.split(/\s+/);
  return parts[parts.length - 1];
}
function urlBasename(u: string): string {
  try {
    const { pathname } = new URL(u);
    const idx = pathname.lastIndexOf("/");
    return idx >= 0 ? pathname.slice(idx + 1) : pathname;
  } catch {
    const idx = u.lastIndexOf("/");
    return idx >= 0 ? u.slice(idx + 1) : u;
  }
}
async function tryReadLocalVendoredSchema(
  schemaUrl: string,
  topicAbsPath: string,
  resource: Resource,
) {
  const candidate = resource.resolve(topicAbsPath, urlBasename(schemaUrl));
  try {
    if (await resource.exists(candidate)) return await resource.readText(candidate);
  } catch { /* ignore */ }
  return undefined;
}
async function validateFinalResolvedTopicTree(
  root: XEl,
  topicAbsPath: string,
  resource: Resource,
  opts: { allowRemoteSchemaFetch?: boolean } = {},
) {
  const schemaUrl = getNoNsSchemaLocation(root);
  if (!schemaUrl) return;
  const isRemote = /^https?:\/\//i.test(schemaUrl);

  if (isRemote && opts.allowRemoteSchemaFetch) {
    try {
      const res = await fetch(schemaUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const schemaText = await res.text();
      const index = buildXsdIndex(schemaText);
      validateAgainstXsd(root, "topic", index);
      return;
    } catch (e) {
      console.warn(`[authord] warn: failed to fetch schema ${schemaUrl}: ${String(e)}`);
    }
  }

  if (isRemote) {
    const vendored = await tryReadLocalVendoredSchema(schemaUrl, topicAbsPath, resource);
    if (vendored !== undefined) {
      const index = buildXsdIndex(vendored);
      validateAgainstXsd(root, "topic", index);
      return;
    }
    console.warn(`[authord] warn: skipping XSD validation (no local copy for ${schemaUrl}).`);
    return;
  }

  try {
    const abs = resource.resolve(topicAbsPath, schemaUrl);
    const schemaText = await resource.readText(abs);
    const index = buildXsdIndex(schemaText);
    validateAgainstXsd(root, "topic", index);
  } catch (e) {
    console.warn(
      `[authord] warn: failed to read local schema '${schemaUrl}' for '${topicAbsPath}': ${
        String(e)
      }. Skipping validation.`,
    );
  }
}

/* ────────────── Markdown wrapper ─────────────── */
export function wrapMarkdownAsMdPageXast(markdown: string, path: string): XEl {
  return {
    type: "element",
    name: "md-page",
    attributes: { src: path },
    children: [{ type: "text", value: markdown }],
  };
}
