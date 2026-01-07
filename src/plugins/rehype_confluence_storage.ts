// deno-lint-ignore-file no-explicit-any
/**
 * Rehype plugin: HAST → Confluence/DC storage XHTML.
 *
 * Responsibilities (single-pass, local rewrites):
 *  - Images: <img> → <ac:image><ri:attachment/></ac:image>, Writerside @@ATTACH, trailing "{width=..}" blocks,
 *            memoized original size (runtime readFile), unwrap <a><ac:image/></a>
 *  - Video: <video> → widget/multimedia macros (YouTube/Vimeo URL or local attachment), map width/height
 *  - Code: <code-block> → Confluence "code" macro (language, collapse, disable-links, title),
 *           CDATA rewrite for lang="xml" (also replaces <img> inside CDATA to @@ATTACH)
 *  - Compare: <compare> → 2-col table (or top-bottom) with before/after titles
 *  - Links: <a> with Writerside anchor → href#anchor; unwrap <a><ac:image/></a>
 *  - Inline: <emphasis>→<em>, <format>→<span style=...>, <code> stays <code>
 *  - UI text: <control>/<path>/<ui-path> → <span>/<code> with classes
 *  - Admonitions: <note>/<tip>/<warning> → Confluence info/tip/warning macros
 *  - Lists: <list>/<li> → ul/ol, type/start/columns
 *  - Tables: header-row/column/both, border, width, table-layout fixed, colspan/rowspan
 *  - TOC: <show-structure> drives ac:structured-macro name="toc" (depth), plus options.insertToc
 *  - Hygiene: self-close voids, normalize attributes/classes, wrap top-level ac:image in <p>, keep <del> mapping
 *  - Reporting: compute "filtered list (missing tags)" vs. a configured Writerside tag set and expose it.
 */

import * as path from "node:path";
import { imageSize } from "image-size";
import { IMAGE_DIR } from "../utils/images.ts";
import { getRenderRuntime } from "../core/shared/runtime.ts";

/* ────────────────────────────── HAST Types ────────────────────────────── */

type HNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, any>;
  children?: HNode[];
  value?: string;
  selfClosing?: boolean;
};
type HRoot = HNode;

/* ────────────────────────────── Missing-tags reporting ────────────────────────────── */

export interface MissingTagsReport {
  /** union of all filtered tags that actually appeared (lowercased, no angle brackets) */
  encountered: string[];
  /** group → missing tags (sorted) */
  missingByGroup: Record<string, string[]>;
  /** flat set of missing tags across all groups (sorted, unique) */
  missingFlat: string[];
}

/** Filtered tag groups from your spec (all lowercased, no angle brackets) */
const FILTER_TAG_GROUPS: Record<string, ReadonlyArray<string>> = {
  "API Documentation": ["api-doc","api-endpoint","api-schema","api-webhook"],
  "Section / Navigation / Summary": [
    "section-starting-page","cards","card","card-summary","category","group",
    "links","misc","primary","primary-label","secondary","secondary-label",
    "seealso","contribute-url","description"
  ],
  "Definition Lists": ["def","deflist"],
  "Procedures & Steps": ["procedure","step"],
  "Snippet / Include": ["snippet","include"],
  "Conditionals": ["if"],
  "Metadata": ["help-id","link-summary","web-file-name","web-summary"],
  "Glossary / Tooltip": ["tooltip"],
  "Shortcuts / UI": ["shortcut","ui-path"], // ui-menu intentionally excluded
  "Variables": ["var","value"],
  "Titles": ["title"],
  "Topic Wrapper": ["topic"],
  "Resource / Properties": ["resource","property"],
};

const FILTER_TAGS_UNION: ReadonlySet<string> = new Set(
  Object.values(FILTER_TAG_GROUPS).flat().map((t) => t.toLowerCase())
);

export interface RehypeConfluenceOptions {
  insertToc?: boolean;
  tocMacroId?: string;
  tocMaxLevel?: number;
  tocPosition?: "top" | "after-first-h1";
  /** Directory for resolving local image sizes. Defaults to IMAGE_DIR. */
  imagesDir?: string;
  /** Optional override for reading image bytes (for size detection). */
  readFile?: (path: string) => Promise<Uint8Array>;

  /** Log the missing-tags report to console.warn at the end of a run */
  reportMissingTags?: boolean;
  /**
   * Callback to receive the missing-tags report.
   * Also available on tree.data.confluenceMissingTags.
   */
  onMissingTags?: (report: MissingTagsReport) => void;
}

/* ────────────────────────────── Constants ────────────────────────────── */

const HTML_VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/* ────────────────────────────── I/O helpers ────────────────────────────── */

function resolveReadFile(
  override?: (path: string) => Promise<Uint8Array>,
): ((path: string) => Promise<Uint8Array>) | null {
  if (override) return override;
  const rt = getRenderRuntime();
  return rt?.fs?.readFile ?? null;
}

/* ────────────────────────────── String helpers ────────────────────────────── */

function basenameFromSrc(src: string): string {
  let s = String(src);
  const q = s.indexOf("?"); if (q >= 0) s = s.slice(0, q);
  const h = s.indexOf("#"); if (h >= 0) s = s.slice(0, h);
  let i = s.length - 1;
  for (; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === 47 /*/ */ || c === 92 /*\ */) break;
  }
  return s.slice(i + 1);
}

function isDigits(str: string | undefined | null): str is string {
  if (!str || str.length === 0) return false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function getClassList(props: Record<string, any>): string[] {
  const cls = props.className ?? props.class;
  if (Array.isArray(cls)) return cls.slice();
  if (typeof cls === "string") {
    const out: string[] = [];
    let token = "";
    for (let i = 0; i < cls.length; i++) {
      const ch = cls[i];
      if (/\s/.test(ch)) { if (token) { out.push(token); token = ""; } }
      else token += ch;
    }
    if (token) out.push(token);
    return out;
  }
  return [];
}
function setClassList(props: Record<string, any>, tokens: string[]) {
  if (!tokens || tokens.length === 0) { delete props.className; delete props.class; }
  else { props.className = tokens; delete props.class; }
}

function readSizeFromStyle(style: unknown): { w?: string; h?: string } {
  if (typeof style !== "string" || !style) return {};
  let w: string | undefined; let h: string | undefined;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":"); if (i <= 0) continue;
    const key = decl.slice(0, i).trim().toLowerCase();
    let val = decl.slice(i + 1).trim().toLowerCase();
    if (key !== "width" && key !== "height") continue;
    if (val.endsWith("px")) val = val.slice(0, -2);
    if (isDigits(val)) {
      if (key === "width" && w == null) w = val;
      if (key === "height" && h == null) h = val;
    }
  }
  return { w, h };
}
function normalizePx(v: unknown): string | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    let s = v.trim().toLowerCase();
    if (s.endsWith("px")) s = s.slice(0, -2);
    return isDigits(s) ? s : undefined;
  }
  return undefined;
}

/* ────────────────────────────── Image size cache ────────────────────────────── */

const sizeCache = new Map<string, { w?: number; h?: number }>();
const sizePending = new Map<string, Promise<{ w?: number; h?: number }>>();

async function getOriginalSize(
  file: string,
  readFile: ((path: string) => Promise<Uint8Array>) | null,
  imagesDir: string,
): Promise<{ w?: number; h?: number }> {
  const filePath = path.join(imagesDir, file);
  if (sizeCache.has(filePath)) return sizeCache.get(filePath)!;
  if (sizePending.has(filePath)) return await sizePending.get(filePath)!;

  const pending = (async () => {
    if (!readFile) return { w: undefined, h: undefined };
    try {
      const buf = await readFile(filePath);
      const { width, height } = imageSize(buf as any) as any;
      const out = { w: width || undefined, h: height || undefined };
      sizeCache.set(filePath, out);
      return out;
    } catch { /* ignore */ }
    const out = { w: undefined, h: undefined };
    sizeCache.set(filePath, out);
    return out;
  })();

  sizePending.set(filePath, pending);
  try {
    return await pending;
  } finally {
    sizePending.delete(filePath);
  }
}

/* ────────────────────────────── Writerside/XML helpers ────────────────────────────── */

function parseTagAttributes(attrStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = attrStr.length;
  let i = 0;
  const ws = /\s/;
  const skipWs = () => { while (i < n && ws.test(attrStr[i]!)) i++; };

  while (i < n) {
    skipWs();
    let key = "";
    while (i < n) {
      const ch = attrStr[i]!;
      if (ws.test(ch) || ch === "=" || ch === ">" || ch === "/") break;
      key += ch; i++;
    }
    if (!key) { i++; continue; }
    skipWs();
    if (attrStr[i] !== "=") { out[key.toLowerCase()] = key.toLowerCase(); continue; }
    i++; skipWs();

    let val = "";
    const q = attrStr[i];
    if (q === `"` || q === `'`) {
      i++;
      while (i < n && attrStr[i] !== q) { val += attrStr[i]!; i++; }
      if (i < n && attrStr[i] === q) i++;
    } else {
      while (i < n && !ws.test(attrStr[i]!) && attrStr[i] !== ">") { val += attrStr[i]!; i++; }
    }
    out[key.toLowerCase()] = val;
  }
  return out;
}

function replaceImgTagsWithAttach(text: string): string {
  // Replace <img ...> inside raw text/CDATA with Writerside @@ATTACH token
  let out = "";
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { out += text.slice(i); break; }
    out += text.slice(i, lt);
    if (text.slice(lt + 1, lt + 4).toLowerCase() === "img") {
      let j = lt + 4, attrs = "";
      while (j < n) { const ch = text[j]!; if (ch === ">") { j++; break; } attrs += ch; j++; }
      const kv = parseTagAttributes(attrs);
      const file = basenameFromSrc(kv["src"] || "");
      const w = normalizePx(kv["width"]);
      const parts = [`@@ATTACH|file=${file}`];
      if (w) parts.push(`width=${w}`);
      out += parts.join("|") + "@@";
      i = j;
    } else {
      out += "<"; i = lt + 1;
    }
  }
  return out;
}

function rewriteAnyCdataText(text: string): string | null {
  const openRaw = text.indexOf("<![CDATA[");
  const openCom = text.indexOf("<!--[CDATA[");
  const openIdx = (openRaw >= 0 && (openCom < 0 || openRaw < openCom)) ? openRaw : openCom;
  if (openIdx < 0) return null;

  const openLen = (openIdx === openRaw) ? "<![CDATA[".length : "<!--[CDATA[".length;
  const closeRaw = text.lastIndexOf("]]>");
  const closeCom = text.lastIndexOf("]]-->");
  const closeIdx = Math.max(closeRaw, closeCom);
  if (closeIdx < 0 || closeIdx <= openIdx + openLen) return null;

  const inner = text.slice(openIdx + openLen, closeIdx);
  const replaced = replaceImgTagsWithAttach(inner);
  return `<!--[CDATA[${replaced}]]-->`;
}

function collectCodeBlockText(n: HNode): string {
  if (!n || n.type !== "element" || !Array.isArray(n.children)) return "";
  let out = "";
  const push = (node: HNode | null | undefined) => {
    if (!node) return;
    if (node.type === "text" && typeof (node as any).value === "string") out += String((node as any).value);
    else if (node.type === "comment" && typeof (node as any).value === "string") out += `<!--${String((node as any).value)}-->`;
    else if (node.type === "element" && Array.isArray(node.children)) for (const gc of node.children) push(gc as HNode);
  };
  for (const ch of n.children) push(ch as HNode);
  return out;
}

/* ────────────────────────────── Trailing {width=..} blocks ────────────────────────────── */

function consumeAttrBlocksFromFollowingText(
  parent: HNode,
  startIndex: number,
): { w?: string; h?: string; consumed: boolean } {
  const kids = parent.children || [];
  const textSegs: { idx: number; node: HNode; text: string }[] = [];
  let i = startIndex + 1;
  while (i < kids.length) {
    const n = kids[i]!;
    if (n.type === "text" && typeof (n as any).value === "string") {
      textSegs.push({ idx: i, node: n, text: String((n as any).value) });
      i++;
      continue;
    }
    break;
  }
  if (textSegs.length === 0) return { consumed: false };

  let buf = ""; for (const s of textSegs) buf += s.text;

  let pos = 0;
  let w: string | undefined;
  let h: string | undefined;
  let consumedAny = false;

  while (pos < buf.length) {
    while (pos < buf.length && /\s/.test(buf[pos]!)) pos++;
    if (buf[pos] !== "{") break;
    const close = buf.indexOf("}", pos + 1);
    if (close === -1) break;

    const inner = buf.slice(pos + 1, close);
    let token = ""; const tokens: string[] = [];
    for (let j = 0; j < inner.length; j++) {
      const ch = inner[j]!;
      if (ch === " " || ch === "\t" || ch === ",") { if (token) { tokens.push(token); token = ""; } }
      else token += ch;
    }
    if (token) tokens.push(token);

    for (const kv of tokens) {
      const eq = kv.indexOf(":") >= 0 ? kv.indexOf(":") : kv.indexOf("=");
      if (eq <= 0) continue;
      const k = kv.slice(0, eq).trim().toLowerCase();
      let v = kv.slice(eq + 1).trim().toLowerCase();
      if (v.endsWith("px")) v = v.slice(0, -2);
      if (isDigits(v)) { if (k === "width" && w == null) w = v; if (k === "height" && h == null) h = v; }
    }
    pos = close + 1;
    consumedAny = true;
  }

  if (!consumedAny) return { consumed: false };

  let remaining = pos;
  for (const s of textSegs) {
    const len = s.text.length;
    if (remaining <= 0) break;
    if (remaining >= len) {
      (s.node as any).value = "";
      remaining -= len;
    } else {
      (s.node as any).value = s.text.slice(remaining);
      remaining = 0;
      break;
    }
  }
  for (let k = textSegs.length - 1; k >= 0; k--) {
    const s = textSegs[k];
    if (((s.node as any).value || "") === "") kids.splice(s.idx, 1);
  }
  return { w, h, consumed: true };
}

/* ────────────────────────────── Confluence builders ────────────────────────────── */

function acParam(name: string, value: string): HNode {
  return { type: "element", tagName: "ac:parameter", properties: { "ac:name": name }, children: [{ type: "text", value }] };
}
function acRichTextBody(children: HNode[]): HNode {
  return { type: "element", tagName: "ac:rich-text-body", properties: {}, children };
}
function acPlainTextBody(text: string): HNode {
  // Confluence will serialize this as CDATA
  return { type: "element", tagName: "ac:plain-text-body", properties: {}, children: [{ type: "text", value: text }] };
}
function acMacro(name: string, params?: Record<string, string>, bodyChildren?: HNode[]): HNode {
  const kids: HNode[] = [];
  if (params) for (const [k, v] of Object.entries(params)) kids.push(acParam(k, v));
  if (bodyChildren && bodyChildren.length) kids.push(acRichTextBody(bodyChildren));
  return { type: "element", tagName: "ac:structured-macro", properties: { "ac:name": name, "ac:schema-version": "1" }, children: kids };
}

async function makeAcImageFromSrc(
  src: string,
  width?: string | number,
  height?: string | number,
  style?: unknown,
  alt?: string,
  readFile?: ((path: string) => Promise<Uint8Array>) | null,
  imagesDir: string = IMAGE_DIR,
): Promise<HNode> {
  const file = basenameFromSrc(src);
  const props: Record<string, any> = {};
  const styleSz = readSizeFromStyle(style);

  const wStr =
    typeof width === "number" ? String(width)
      : typeof width === "string" ? normalizePx(width)
        : styleSz.w;
  const hStr =
    typeof height === "number" ? String(height)
      : typeof height === "string" ? normalizePx(height)
        : styleSz.h;

  if (wStr && isDigits(wStr)) props["ac:width"] = wStr;
  if (hStr && isDigits(hStr)) props["ac:height"] = hStr;
  if (props["ac:width"] || props["ac:height"]) props["ac:thumbnail"] = "true";

  const { w: ow, h: oh } = await getOriginalSize(file, readFile ?? null, imagesDir);
  if (ow) props["ac:original-width"] = String(ow);
  if (oh) props["ac:original-height"] = String(oh);
  if (alt) props.alt = String(alt);

  return {
    type: "element",
    tagName: "ac:image",
    properties: props,
    children: [{
      type: "element",
      tagName: "ri:attachment",
      properties: { "ri:filename": file },
      children: [],
      selfClosing: true,
    }],
  };
}

function convertImgToAttachToken(imgProps: Record<string, any>): HNode {
  const src = String(imgProps.src ?? "").trim();
  const file = basenameFromSrc(src);
  const width = normalizePx(imgProps.width);
  const parts = [`@@ATTACH|file=${file}`];
  if (width) parts.push(`width=${width}`);
  return { type: "text", value: parts.join("|") + "@@" };
}

/* ────────────────────────────── URL helpers ────────────────────────────── */

function isHttpUrl(u: string): boolean { return /^https?:\/\//i.test(u); }
function isYouTube(u: string): boolean { return /(^https?:\/\/(www\.)?youtube\.com\/watch\?v=|^https?:\/\/youtu\.be\/)/i.test(u); }
function isVimeo(u: string): boolean { return /^https?:\/\/(www\.)?vimeo\.com\//i.test(u); }

/* ────────────────────────────── TOC helpers ────────────────────────────── */

function hasTocMacro(el: HNode): boolean {
  return (
    el.type === "element" &&
    el.tagName === "ac:structured-macro" &&
    (el.properties || {})["ac:name"] === "toc"
  );
}
function buildTocMacro(macroId: string, maxLevel: number): HNode {
  return {
    type: "element",
    tagName: "ac:structured-macro",
    properties: { "ac:name": "toc", "ac:schema-version": "1", "ac:macro-id": macroId },
    children: [acParam("maxLevel", String(maxLevel))],
  };
}

/* ────────────────────────────── Main plugin ────────────────────────────── */

export default function rehypeConfluenceStorage(opts: RehypeConfluenceOptions = {}) {
  const insertToc = opts.insertToc === true;
  const tocMacroId = opts.tocMacroId ?? "a854a720-dea6-4d0f-a0a2-e4591c07d85e";
  const defaultTocMaxLevel = Number.isFinite(opts.tocMaxLevel) ? Number(opts.tocMaxLevel) : 3;
  const tocPosition: "top" | "after-first-h1" = opts.tocPosition ?? "top";
  const imagesDir = opts.imagesDir ?? IMAGE_DIR;
  const readFileFn = resolveReadFile(opts.readFile);

  return async (tree: HRoot) => {
    const state = {
      foundToc: false,
      requestedToc: false,
      requestedTocDepth: defaultTocMaxLevel,
    };

    // ── Missing-tags reporting accumulators
    const encounteredFiltered = new Set<string>();

    /* ────────────── Small helpers per-visit ────────────── */

    function stripTaskClasses(el: HNode) {
      const props = el.properties || (el.properties = {});
      const tokens = getClassList(props);
      const kept = tokens.filter((t) => t !== "contains-task-list" && t !== "task-list-item");
      setClassList(props, kept);
    }

    function replaceNode(parent: HNode, idx: number, repl: HNode) {
      parent.children!.splice(idx, 1, repl);
    }

    /* ────────────── Tag handlers ────────────── */

    type Handler = (el: HNode, parent: HNode, idx: number) => void | Promise<void>;
    const handlers: Record<string, Handler> = {
      /* code-block → code macro with plain-text-body */
      "code-block": (el, parent, idx) => {
        const props = el.properties || {};
        const lang = (props.lang ?? props.language ?? "plain text").toString();
        let codeText = collectCodeBlockText(el);

        // Special case: fix CDATA/embedded <img> for XML blocks
        if (String(lang).toLowerCase() === "xml") {
          const rewritten = rewriteAnyCdataText(codeText);
          if (rewritten) codeText = rewritten;
          else if (codeText.indexOf("<img") >= 0) {
            codeText = `<!--[CDATA[${replaceImgTagsWithAttach(codeText)}]]-->`;
          }
        }

        const params: Record<string, string> = { language: String(lang) };
        if (props["collapsed-title"]) params.title = String(props["collapsed-title"]);
        if (props["disable-links"] === "true" || props["disable-links"] === true) params.disableLinks = "true";
        const collapsible = props.collapsible === "true" || props.collapsible === true;
        if (collapsible) params.collapse = (props["default-state"] === "collapsed") ? "true" : "false";

        const macro = acMacro("code", params);
        (macro.children ||= []).push(acPlainTextBody(codeText));

        replaceNode(parent, idx, macro);
      },

      /* Compare: 2-up table by default, top-bottom if type=top-bottom */
      "compare": (el, parent, idx) => {
        const p = el.properties || {};
        const type = String(p.type ?? p.style ?? "left-right").toLowerCase();
        const titleA = String(p["title-before"] ?? p["first-title"] ?? "Before");
        const titleB = String(p["title-after"] ?? p["second-title"] ?? "After");

        // Find first two content children (usually code-blocks already converted by recursion)
        const kids = (el.children || []).filter((c) => c && typeof c === "object") as HNode[];

        if (type === "top-bottom" || type === "top-down") {
          const container: HNode = { type: "element", tagName: "div", properties: { className: ["ws-compare", "ws-vertical"] }, children: [] };
          const sec = (title: string, body: HNode | null): HNode => ({
            type: "element",
            tagName: "div",
            properties: { className: ["ws-compare-pane"] },
            children: [
              { type: "element", tagName: "h4", properties: {}, children: [{ type: "text", value: title }] },
              ...(body ? [body] : []),
            ],
          });
          container.children!.push(sec(titleA, kids[0] ?? null));
          container.children!.push(sec(titleB, kids[1] ?? null));
          replaceNode(parent, idx, container);
        } else {
          const table: HNode = {
            type: "element",
            tagName: "table",
            properties: { className: ["ws-compare", "ws-grid-2"] },
            children: [
              {
                type: "element",
                tagName: "tr",
                properties: {},
                children: [
                  { type: "element", tagName: "th", properties: {}, children: [{ type: "text", value: titleA }] },
                  { type: "element", tagName: "th", properties: {}, children: [{ type: "text", value: titleB }] },
                ],
              },
              {
                type: "element",
                tagName: "tr",
                properties: {},
                children: [
                  { type: "element", tagName: "td", properties: {}, children: kids[0] ? [kids[0]] : [] },
                  { type: "element", tagName: "td", properties: {}, children: kids[1] ? [kids[1]] : [] },
                ],
              },
            ],
          };
          replaceNode(parent, idx, table);
        }
      },

      /* Input checkbox → [x]/[ ] text */
      "input": (el, parent, idx) => {
        const props = el.properties || {};
        if (props.type === "checkbox") {
          const checked = (("checked" in props && props.checked !== false) || props["aria-checked"] === "true");
          parent.children!.splice(idx, 1, { type: "text", value: checked ? "[x]" : "[ ]" });
        }
      },

      /* Lists hygiene and mapping */
      "ul": stripTaskClasses,
      "li": stripTaskClasses,

      /* Writerside pseudo "confluence-image" → ac:image */
      "confluence-image": async (el, parent, idx) => {
        const p = el.properties || {};
        const filename = String(p.filename ?? "").trim();
        if (!filename) return;
        const ac = await makeAcImageFromSrc(
          filename,
          p.width,
          p.height,
          undefined,
          p.alt,
          readFileFn,
          imagesDir,
        );
        const consumed = consumeAttrBlocksFromFollowingText(parent, idx);
        if (consumed.consumed) {
          const q = ac.properties || {};
          if (consumed.w) q["ac:width"] = consumed.w;
          if (consumed.h) q["ac:height"] = consumed.h;
          if (consumed.w || consumed.h) q["ac:thumbnail"] = "true";
          ac.properties = q;
        }
        replaceNode(parent, idx, ac);
      },

      /* <img> → <ac:image> (unless border-effect → @@ATTACH token) */
      "img": async (el, parent, idx) => {
        const p = el.properties || {};
        const src = p.src ?? "";
        if (!src) return;

        if (Object.prototype.hasOwnProperty.call(p, "border-effect")) {
          parent.children!.splice(idx, 1, convertImgToAttachToken(p));
          return;
        }

        const ac = await makeAcImageFromSrc(
          String(src),
          p.width,
          p.height,
          p.style,
          p.alt,
          readFileFn,
          imagesDir,
        );
        const consumed = consumeAttrBlocksFromFollowingText(parent, idx);
        if (consumed.consumed) {
          const q = ac.properties || {};
          if (consumed.w) q["ac:width"] = consumed.w;
          if (consumed.h) q["ac:height"] = consumed.h;
          if (consumed.w || consumed.h) q["ac:thumbnail"] = "true";
          ac.properties = q;
        }
        replaceNode(parent, idx, ac);
      },

      /* <video> → widget/multimedia macro */
      "video": (el, parent, idx) => {
        const p = el.properties || {};
        const src = String(p.src ?? "").trim();
        if (!src) return;

        const w = normalizePx(p.width);
        const h = normalizePx(p.height);
        const borderEffect = p["border-effect"];

        if (isHttpUrl(src) && (isYouTube(src) || isVimeo(src))) {
          const params: Record<string, string> = { url: src };
          if (w) params.width = w;
          if (h) params.height = h;
          const macro = acMacro("widget", params);
          replaceNode(parent, idx, macro);
        } else {
          // Assume local attachment (mp4/webm)
          const file = basenameFromSrc(src);
          const params: Record<string, string> = {};
          if (w) params.width = w;
          if (h) params.height = h;
          if (borderEffect && borderEffect !== "none") params.border = String(borderEffect);

          const macro: HNode = acMacro("multimedia", params);
          (macro.children ||= []).push({
            type: "element",
            tagName: "ri:attachment",
            properties: { "ri:filename": file },
            children: [],
            selfClosing: true,
          });
          replaceNode(parent, idx, macro);
        }
      },

      /* <a> with Writerside anchor attribute */
      "a": (el, parent, idx) => {
        // unwrap <a><ac:image/></a> later too (keep here if already in tree)
        if (el.children && el.children.length === 1) {
          const only = el.children[0]!;
          if (only.type === "element" && (only as any).tagName === "ac:image") {
            parent.children!.splice(idx, 1, only);
            return;
          }
        }
        const p = el.properties || {};
        const href = String(p.href ?? "");
        const anchor = String(p.anchor ?? "");
        if (anchor && href) {
          p.href = `${href}#${anchor}`;
          delete p.anchor;
        } else if (anchor && !href) {
          p.href = `#${anchor}`;
          delete p.anchor;
        }
      },

      /* Inline emphasis/format/code + UI helpers */
      "emphasis": (el) => { el.tagName = "em"; },
      "code": (_el) => { /* keep as <code> */ },
      "format": (el) => {
        const p = el.properties || {};
        const styles = (String(p.style ?? "")).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        const css: string[] = [];
        if (styles.includes("bold")) css.push("font-weight:bold");
        if (styles.includes("italic")) css.push("font-style:italic");
        if (styles.includes("subscript")) css.push("vertical-align:sub");
        if (styles.includes("superscript")) css.push("vertical-align:super");
        if (p.color) css.push(`color:${String(p.color)}`);
        el.tagName = "span";
        el.properties = { ...(el.properties || {}), style: css.join(";") };
      },
      "control": (el) => { el.tagName = "span"; el.properties = { ...(el.properties || {}), className: ["ws-control"] }; },
      "path": (el) => { el.tagName = "code"; el.properties = { ...(el.properties || {}), className: ["ws-path"] }; },
      "ui-path": (el) => { el.tagName = "span"; el.properties = { ...(el.properties || {}), className: ["ws-ui-path"] }; },

      /* Admonitions → Confluence panel macros */
      "note": (el, parent, idx) => {
        const macro = acMacro("info", undefined, el.children || []);
        replaceNode(parent, idx, macro);
      },
      "tip": (el, parent, idx) => {
        const macro = acMacro("tip", undefined, el.children || []);
        replaceNode(parent, idx, macro);
      },
      "warning": (el, parent, idx) => {
        const macro = acMacro("warning", undefined, el.children || []);
        replaceNode(parent, idx, macro);
      },

      /* Writerside <list> → ul/ol */
      "list": (el) => {
        const p = el.properties || {};
        const type = String(p.type ?? "bullet").toLowerCase();
        const columns = Number(p.columns ?? 0);
        const start = p.start != null ? String(p.start) : undefined;

        if (type === "decimal" || type.startsWith("alpha")) {
          el.tagName = "ol";
          const props: Record<string, any> = {};
          if (start && isDigits(start)) props.start = start;
          el.properties = props;
        } else if (type === "none") {
          el.tagName = "ul";
          el.properties = { style: "list-style-type:none" };
        } else {
          el.tagName = "ul";
        }
        if (columns && Number.isFinite(columns) && columns > 1) {
          const props = el.properties || (el.properties = {});
          const style = String(props.style ?? "");
          props.style = style ? `${style};column-count:${columns}` : `column-count:${columns}`;
        }
      },

      /* Table enhancements */
      "table": (el) => {
        const p = el.properties || {};
        const styleAttr = String(p.style ?? "header-row"); // default header-row per spec
        const border = String(p.border ?? "true").toLowerCase() === "true";
        const widthPx = normalizePx(p.width);
        const fixed = String(p["column-width"] ?? "").toLowerCase() === "fixed";
        const cellpadding = p.cellpadding != null ? String(p.cellpadding) : "";
        const cellspacing = p.cellspacing != null ? String(p.cellspacing) : "";

        // Map header-row/column/both
        const rows = (el.children || []).filter((c) => c.type === "element" && (c as HNode).tagName === "tr") as HNode[];
        if (rows.length) {
          const firstRow = rows[0];
          const headerRow = styleAttr === "header-row" || styleAttr === "both";
          const headerCol = styleAttr === "header-column" || styleAttr === "both";
          if (headerRow && firstRow.children) {
            for (const c of firstRow.children) {
              if (c.type === "element" && (c as HNode).tagName === "td") (c as HNode).tagName = "th";
            }
          }
          if (headerCol) {
            for (const r of rows) {
              const first = (r.children || []).find((c) => c.type === "element" && ((c as HNode).tagName === "td" || (c as HNode).tagName === "th")) as HNode | undefined;
              if (first) first.tagName = "th";
            }
          }
        }

        // Table styling
        const css: string[] = [];
        if (border) css.push("border-collapse:collapse");
        if (widthPx) css.push(`width:${widthPx}px`);
        if (fixed) css.push("table-layout:fixed");
        if (cellspacing) css.push(`border-spacing:${cellspacing}px`);
        if (css.length) (el.properties ||= {}).style = css.join(";");

        // Cell padding
        if (cellpadding) {
          for (const r of rows) {
            for (const c of r.children || []) {
              if (c.type === "element" && ((c as HNode).tagName === "td" || (c as HNode).tagName === "th")) {
                const cp = (c as HNode).properties ||= {};
                const st = String(cp.style ?? "");
                cp.style = st ? `${st};padding:${cellpadding}px` : `padding:${cellpadding}px`;
              }
            }
          }
        }
      },

      /* <show-structure> influences TOC injection (depth) */
      "show-structure": (el, parent, idx) => {
        const p = el.properties || {};
        const depth = Number(p.depth ?? defaultTocMaxLevel);
        if (Number.isFinite(depth) && depth > 0) {
          state.requestedToc = true;
          state.requestedTocDepth = depth;
        }
        // remove the directive node
        parent.children!.splice(idx, 1);
      },

      /* Deprecated <anchor> → <span id="..."/> */
      "anchor": (el, parent, idx) => {
        const p = el.properties || {};
        const name = String(p.name ?? "").trim();
        const repl: HNode = { type: "element", tagName: "span", properties: { id: name }, children: [], selfClosing: true };
        replaceNode(parent, idx, repl);
      },

      /* Icon behaves like small image attachment */
      "icon": async (el, parent, idx) => {
        const p = el.properties || {};
        const src = String(p.src ?? "").trim();
        if (!src) return;
        const ac = await makeAcImageFromSrc(
          src,
          p.width,
          p.height,
          undefined,
          p.alt,
          readFileFn,
          imagesDir,
        );
        replaceNode(parent, idx, ac);
      },

      /* Inline frame → widget macro */
      "inline-frame": (el, parent, idx) => {
        const p = el.properties || {};
        const src = String(p.src ?? "").trim();
        if (!src) return;
        const params: Record<string, string> = { url: src };
        const w = normalizePx(p.width);
        const h = normalizePx(p.height);
        if (w) params.width = w;
        if (h) params.height = h;
        const macro = acMacro("widget", params);
        replaceNode(parent, idx, macro);
      },

      /* math: fallback span with class (safe default) */
      "math": (el) => {
        el.tagName = "span";
        const text = (el.children || []).map((c) => (c as any).value ?? "").join("");
        el.children = [{ type: "text", value: String(text) }];
        el.properties = { ...(el.properties || {}), className: ["ws-math-latex"] };
      },

      /* del → span with line-through (kept from original) */
      "del": (el) => {
        const props = el.properties || {};
        el.tagName = "span";
        const style = String(props.style || "");
        el.properties = {
          ...props,
          style: style ? (style.includes("text-decoration") ? style : `${style};text-decoration:line-through;`)
            : "text-decoration:line-through;",
        };
      },
    };

    /* ────────────── DFS visit ────────────── */

    async function visit(node: HNode, parent: HNode | null, idx: number | null, inPre: boolean) {
      if (!node || node.type !== "element") return;
      const el = node;
      const tag = (el.tagName || "").toLowerCase();
      const nextInPre = inPre || tag === "pre" || tag === "code";

      // Record tag for filtered missing-tags report
      if (FILTER_TAGS_UNION.has(tag)) encounteredFiltered.add(tag);

      if (!state.foundToc && hasTocMacro(el)) state.foundToc = true;

      // Skip transforming <img> inside <pre>/<code>, but still normalize props later
      if (!(tag === "img" && nextInPre)) {
        const handler = handlers[tag];
        if (handler) await handler(el, parent as HNode, idx as number);
      }

      // Recurse
      if (Array.isArray(el.children)) {
        for (let i = 0; i < el.children.length; i++) {
          await visit(el.children[i] as HNode, el, i, nextInPre);
        }
      }

      // Normalize/self-close after children
      if (HTML_VOID.has(tag)) { el.children = []; el.selfClosing = true; }
      if (el.properties) {
        const p = el.properties;
        for (const key of Object.keys(p)) {
          if (key === "className" || key === "class") continue;
          const val = p[key];
          if (val === true || val === "") p[key] = key;
          else if (val == null) delete p[key];
          else if (Array.isArray(val)) p[key] = val.join(" ");
        }
      }

      // Unwrap <a><ac:image/></a> pattern (in case created after recursion)
      if (tag === "a" && el.children && el.children.length === 1) {
        const only = el.children[0]!;
        if (only.type === "element" && (only as any).tagName === "ac:image" && parent && idx != null) {
          (parent.children ||= [])[idx] = only;
        }
      }
    }

    /* Visit only root children (not the root node itself) */
    if (Array.isArray(tree.children)) {
      for (let i = 0; i < tree.children.length; i++) {
        await visit(tree.children[i] as HNode, tree, i, /*inPre*/ false);
      }
    }

    // Wrap top-level ac:image in <p>
    const newRootChildren: HNode[] = [];
    for (const child of tree.children || []) {
      if (child && child.type === "element" &&
        (child.tagName === "ac:image" || child.tagName === "confluence-image")) {
        newRootChildren.push({ type: "element", tagName: "p", properties: {}, children: [child] });
      } else {
        newRootChildren.push(child);
      }
    }

    // TOC injection (from options or <show-structure>)
    let wrappedChildren: HNode[] = [];
    const shouldAddToc = (insertToc || state.requestedToc) && !state.foundToc;
    const tocMacro = shouldAddToc ? buildTocMacro(tocMacroId, state.requestedToc ? state.requestedTocDepth : defaultTocMaxLevel) : null;

    if (tocMacro && tocPosition === "after-first-h1") {
      let inserted = false;
      for (const c of newRootChildren) {
        wrappedChildren.push(c);
        if (!inserted && c.type === "element" && c.tagName === "h1") {
          wrappedChildren.push(tocMacro); inserted = true;
        }
      }
      if (!inserted) wrappedChildren = [tocMacro, ...wrappedChildren];
    } else if (tocMacro) {
      wrappedChildren = [tocMacro, ...newRootChildren];
    } else {
      wrappedChildren = newRootChildren;
    }

    // Namespaces container
    tree.children = [{
      type: "element",
      tagName: "div",
      properties: {
        "xmlns:ac": "http://atlassian.com/content",
        "xmlns:ri": "http://atlassian.com/resource/identifier",
      },
      children: wrappedChildren,
    }];

    // ── Finalize & expose missing-tags report
    const missingByGroup: Record<string, string[]> = {};
    const missingFlatSet = new Set<string>();
    for (const [group, tags] of Object.entries(FILTER_TAG_GROUPS)) {
      const missing = tags.filter((t) => !encounteredFiltered.has(t));
      if (missing.length) {
        missingByGroup[group] = [...missing].sort();
        for (const t of missing) missingFlatSet.add(t);
      }
    }
    const report: MissingTagsReport = {
      encountered: [...encounteredFiltered].sort(),
      missingByGroup,
      missingFlat: [...missingFlatSet].sort(),
    };
    (tree as any).data ||= {};
    (tree as any).data.confluenceMissingTags = report;

    if (typeof opts.onMissingTags === "function") {
      try { opts.onMissingTags(report); } catch { /* ignore */ }
    }
    if (opts.reportMissingTags) {
      const missingCount = report.missingFlat.length;
      if (missingCount > 0) {
        console.warn(
          `[rehype-confluence] Missing filtered tags (${missingCount}): ` +
          report.missingFlat.join(", ")
        );
      }
    }
  };
}
