// deno-lint-ignore-file no-explicit-any
/**
 * SinglePageComposer
 * ---------------------------------------------------------------------------
 * Middleware to wire: FinalDocsetAst -> (render each page) -> ONE Storage XHTML
 * + attachment gathering -> ConfluencePage for ConfluenceSync.
 *
 * Order:
 *  - Primary: the first instance profile's <toc-element topic="..."> sequence
 *  - Fallback: docset.pages iteration order
 *
 * Notes:
 *  - We concatenate storage fragments and rewrap them in a single namespace container
 *    so <ac:*> and <ri:*> prefixes are always declared.
 *  - We do not parse/alter inner XHTML; we optionally prefix each section with a
 *    heading to aid navigation on a single large page.
 *  - Attachments are discovered by scanning for ri:attachment references and resolved
 *    via an injected resolver so paths remain project-specific.
 */

import type { ConfluencePage } from "./confluence_sync.ts";
import type { Element as XEl } from "xast";
import { ConfluenceStorageRenderer } from "./confluence_storage_renderer.ts";
import type { IMarkdownTransformer } from "../ports/ports.ts";
import { asStorageXhtml, type StorageXhtml, type Path } from "../shared/types.ts";
import { AuthordAst } from "./authord_ast_assembler.ts";

export type AttachmentResolution = {
  filePath: Path;
  fileName?: string;
  contentType?: string;
} | null | undefined;

export type AttachmentResolver = (filename: string) => AttachmentResolution;

export type SinglePageComposerOptions = {
  /** Title of the final consolidated page. */
  title: string;
  /** Insert a Confluence TOC macro at the top. Default: true. */
  insertToc?: boolean;
  /** Heading level for each section heading we insert. Default: 2 (=> <h2>). */
  sectionHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Insert an <hr/> between sections. Default: false. */
  insertSeparators?: boolean;
  /**
   * Resolve attachment filenames (from ri:filename="...") to file paths.
   * Default: returns null (no attachments). Provide if you want auto-upload.
   */
  resolveAttachment?: AttachmentResolver;
};

export class SinglePageComposer {
  constructor(
    private readonly renderer: ConfluenceStorageRenderer,
    private readonly markdown: IMarkdownTransformer, // kept for flexibility if needed later
  ) {}

  /**
   * Build a single ConfluencePage that contains all docset pages in order.
   */
  async build(docset: AuthordAst, opts: SinglePageComposerOptions): Promise<ConfluencePage> {
    const {
      title,
      insertToc = true,
      sectionHeadingLevel = 2,
      insertSeparators = false,
      resolveAttachment,
    } = opts;

    // 1) Compute reading order from first instance TOC (fallback to docset order).
    const ordered = orderPagesFromFirstInstance(docset);

    // 2) Render all pages once; index by absolute path for quick lookup.
    const rendered = await this.renderer.renderDocset(docset);
    const byPath = new Map<string, StorageXhtml>();
    for (const p of rendered) byPath.set(p.path, p.xhtml);

    // 3) Stitch sections in the chosen order.
    const sections: string[] = [];
    const attachments = new Map<string, { filePath: Path; fileName?: string; contentType?: string }>();

    for (const page of ordered) {
      const html = byPath.get(page.path);
      if (!html) continue;

      const sectionTitle = getPageDisplayTitle(page.ast, page.path) ?? page.path;
      const headingTag = `h${Math.min(Math.max(1, sectionHeadingLevel), 6)}`;

      // Optional per-section heading for the compounded page
      const headingBlock = `<${headingTag} id="${anchorIdFromPath(page.path)}">${escapeHtml(sectionTitle)}</${headingTag}>`;

      const raw = storageToString(html);
      const inner = stripNamespaceWrapper(raw);

      // Concat: heading + original storage XHTML (inside namespace wrapper)
      sections.push(`${headingBlock}\n${inner}`);
      if (insertSeparators) sections.push("<hr/>");

      // Find and resolve attachments referenced by this section and collect
      if (resolveAttachment) {
        for (const fn of findAttachmentFilenames(storageToString(html))) {
          if (!attachments.has(fn)) {
            const res = resolveAttachment(fn);
            if (res && res.filePath) attachments.set(fn, { filePath: res.filePath, fileName: res.fileName, contentType: res.contentType });
          }
        }
      }
    }

    // 4) Optional top-level TOC macro
    const tocMacro = insertToc
      ? `<ac:structured-macro ac:name="toc" ac:schema-version="1" ac:macro-id="a854a720-dea6-4d0f-a0a2-e4591c07d85e"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>`
      : "";

    const finalInner = `${tocMacro}\n${sections.join("\n")}`;
    const storageHtml = asStorageXhtml(wrapWithNamespace(finalInner));

    return {
      title,
      storageHtml,
      attachments: attachments.size
        ? Array.from(attachments.values()).map(a => ({ filePath: a.filePath, fileName: a.fileName, contentType: a.contentType }))
        : [],
    };
  }
}

/* ───────────────────────────── ordering ───────────────────────────── */

function orderPagesFromFirstInstance(docset: AuthordAst): Array<{ path: string; ast: XEl }> {
  // Prefer first instance profile's explicit order if available
  const firstInstance = docset.instances?.[0]?.ast;
  if (firstInstance) {
    const rels: string[] = [];
    walk(firstInstance, (el) => {
      if (localName(el.name) === "toc-element") {
        const topicAttr = el.attributes?.["topic"] as string | undefined;
        if (topicAttr) rels.push(topicAttr);
      }
    });
    if (rels.length) {
      const out: Array<{ path: string; ast: XEl }> = [];
      const remaining = new Map(docset.pages.map(p => [p.path, p.ast as XEl]));
      const lower = docset.pages.map(p => p.path.toLowerCase());

      for (const rel of rels) {
        const relLower = rel.toLowerCase();
        const idx = lower.findIndex(p => p.endsWith("/" + relLower) || p.endsWith(relLower));
        if (idx >= 0) {
          const p = docset.pages[idx]!;
          out.push({ path: p.path, ast: p.ast as XEl });
          remaining.delete(p.path);
        }
      }
      // Append anything not referenced, preserving docset order
      for (const p of docset.pages) {
        if (remaining.has(p.path)) out.push({ path: p.path, ast: p.ast as XEl });
      }
      return out;
    }
  }
  // Fallback: docset.pages order
  return docset.pages.map(p => ({ path: p.path, ast: p.ast as XEl }));
}

/* ─────────────────────── titles / anchors / scan ─────────────────────── */

function getPageDisplayTitle(ast: XEl, path: string): string | null {
  // Prefer <title> text for topic pages
  if (localName(ast.name) === "topic") {
    const t = findFirstChild(ast, "title");
    if (t) {
      let buf = "";
      for (const c of t.children ?? []) if ((c as any).type === "text") buf += String((c as any).value ?? "");
      if (buf.trim()) return buf.trim();
    }
  }
  // Fallback: filename WITHOUT extension (so readme.md -> "readme")
  const base = path.replace(/^[\s\S]*[\/\\]/, "");
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt || null;
}

function anchorIdFromPath(path: string): string {
  const base = path.replace(/^[\s\S]*[\/\\]/, "").replace(/\.[^.]+$/, "");
  return "sec-" + base.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function findAttachmentFilenames(storage: string): string[] {
  const out: string[] = [];
  const rx = /ri:filename="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(storage)) != null) {
    const fn = (m[1] ?? "").trim();
    if (fn && !out.includes(fn)) out.push(fn);
  }
  return out;
}

function storageToString(x: StorageXhtml): string {
  return (x as unknown as any).value ?? (x as unknown as string);
}

function stripNamespaceWrapper(html: string): string {
  const m = /^<div\b[^>]*\bxmlns:ac="[^"]+"[^>]*\bxmlns:ri="[^"]+"[^>]*>/i.exec(html);
  if (!m) return html;
  if (!html.endsWith("</div>")) return html;
  const openTag = m[0];
  return html.slice(openTag.length, html.length - "</div>".length);
}

function wrapWithNamespace(inner: string): string {
  return `<div xmlns:ac="http://atlassian.com/content" xmlns:ri="http://atlassian.com/resource/identifier">${inner}</div>`;
}

/* ───────────────────────────── small utils ───────────────────────────── */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function localName(q: string): string {
  const i = q.lastIndexOf(":");
  return i >= 0 ? q.slice(i + 1).toLowerCase() : q.toLowerCase();
}
function findFirstChild(el: XEl, local: string): XEl | null {
  const n = (el.children ?? []).find(c => c.type === "element" && localName((c as XEl).name) === local) as XEl | undefined;
  return n ?? null;
}
function walk(el: XEl, fn: (e: XEl) => void) {
  fn(el);
  for (const c of el.children ?? []) if (c.type === "element") walk(c as XEl, fn);
}
