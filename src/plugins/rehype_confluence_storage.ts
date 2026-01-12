// deno-lint-ignore-file no-explicit-any
/**
 * Rehype plugin: HAST → Confluence/DC storage XHTML.
 *
 * Responsibilities (single-pass, local rewrites):
 *  - Images: <img> → <ac:image><ri:attachment/></ac:image>, trailing "{width=..}" blocks,
 *            memoized original size (Deno.readFileSync-first, Node fallback), unwrap <a><ac:image/></a>
 *  - Video: <video> → widget/multimedia macros (YouTube/Vimeo URL or local attachment), map width/height
 *  - Code: <code-block> → Confluence "code" macro (language, collapse, disable-links, title),
 *           optional CDATA rewrite for lang="xml" (legacy @@ATTACH behavior)
 *  - Compare: <compare> → Confluence layout (section/column), optionally stacked for top-bottom
 *  - Links: <a> with Writerside anchor → href#anchor; unwrap <a><ac:image/></a>
 *  - Inline: <emphasis>→<em>, <format>→<span style=...>, <code> stays <code>
 *  - UI text: <control>/<path>/<ui-path> → <span>/<code> with classes
 *  - Admonitions: <note>/<tip>/<warning> → Confluence info/tip/warning macros
 *  - Lists: <list>/<li> → ul/ol, type/start/columns
 *  - Tables: header-row/column/both, border, width, table-layout fixed, colspan/rowspan
 *  - TOC: <show-structure> drives ac:structured-macro name="toc" (depth), plus options.insertToc
 *  - Hygiene: self-close voids, normalize attributes/classes, keep <del> mapping
 *  - Reporting: compute "filtered list (missing tags)" vs. a configured Writerside tag set and expose it.
 */

import * as path from "node:path";
import { imageSize } from "npm:image-size@1";
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

  /** Insert a "Last modified" line after the first H1. Defaults to true. */
  insertLastModified?: boolean;
  /** Override the date shown in the "Last modified" line. If omitted, uses current date. */
  lastModified?: string | Date;
  /** IANA time zone used when formatting the current date. Defaults to "Asia/Colombo". */
  lastModifiedTimeZone?: string;
  /** Directory for resolving local image sizes. Defaults to IMAGE_DIR. */
  imagesDir?: string;
  /** Optional override for reading image bytes (for size detection). */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Map category ref -> display name for <category ref="..."> in <seealso>. */
  categoryTitles?: Record<string, string>;
  /** Rewrite <img> in XML code blocks into @@ATTACH stubs (legacy behavior). */
  rewriteCodeBlockImages?: boolean;

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
function stripQuotes(val: string): string {
  if (val.length >= 2) {
    const first = val[0];
    const last = val[val.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return val.slice(1, -1);
    }
  }
  return val;
}
function parseBraceAttributes(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = inner.length;
  let i = 0;
  const isSep = (ch: string) => ch === "," || ch === ";" || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ";
  while (i < n) {
    while (i < n && isSep(inner[i]!)) i++;
    if (i >= n) break;
    let key = "";
    while (i < n) {
      const ch = inner[i]!;
      if (ch === "=" || ch === ":" || isSep(ch)) break;
      key += ch;
      i++;
    }
    key = key.trim().toLowerCase();
    while (i < n && isSep(inner[i]!)) i++;
    if (!key) break;

    let val = "true";
    if (i < n && (inner[i] === "=" || inner[i] === ":")) {
      i++;
      while (i < n && isSep(inner[i]!)) i++;
      if (i < n && (inner[i] === "\"" || inner[i] === "'")) {
        const quote = inner[i]!;
        i++;
        let buf = "";
        while (i < n && inner[i] !== quote) {
          buf += inner[i]!;
          i++;
        }
        if (i < n && inner[i] === quote) i++;
        val = buf;
      } else {
        let buf = "";
        while (i < n && !isSep(inner[i]!)) {
          buf += inner[i]!;
          i++;
        }
        val = buf;
      }
    }
    out[key] = stripQuotes(val.trim());
  }
  return out;
}
function truthyAttrValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t !== "" && t !== "false" && t !== "0";
  }
  return true;
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

function escapeAttrValue(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function propsToAttrString(props: Record<string, any>): string {
  const parts: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(props || {})) {
    const key = rawKey === "className" ? "class" : rawKey;
    if (rawVal == null || rawVal === false) continue;
    if (rawVal === true) {
      parts.push(key);
      continue;
    }
    if (rawVal === "") {
      parts.push(`${key}=""`);
      continue;
    }
    const val = Array.isArray(rawVal) ? rawVal.join(" ") : String(rawVal);
    parts.push(`${key}="${escapeAttrValue(val)}"`);
  }
  return parts.join(" ");
}

function serializeElementNode(node: HNode): string {
  const tag = node.tagName ?? "";
  if (!tag) {
    return (node.children || []).map(serializeCodeNode).join("");
  }
  const attrs = propsToAttrString(node.properties || {});
  const open = attrs ? `<${tag} ${attrs}` : `<${tag}`;
  const isVoid = node.selfClosing === true || HTML_VOID.has(tag.toLowerCase());
  if (isVoid) return `${open}/>`;
  const inner = (node.children || []).map(serializeCodeNode).join("");
  return `${open}>${inner}</${tag}>`;
}

function serializeCodeNode(node: HNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text" && typeof (node as any).value === "string") return String((node as any).value);
  if (node.type === "comment" && typeof (node as any).value === "string") return `<!--${String((node as any).value)}-->`;
  if (node.type === "raw" && typeof (node as any).value === "string") return String((node as any).value);
  if (node.type === "element") return serializeElementNode(node);
  if (Array.isArray(node.children)) return node.children.map(serializeCodeNode).join("");
  return "";
}

function collectCodeBlockText(n: HNode): string {
  if (!n || n.type !== "element" || !Array.isArray(n.children)) return "";
  return n.children.map(serializeCodeNode).join("");
}

function normalizeCodeBlockText(text: string): string {
  if (!text) return "";
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");

  // Strip a single leading/trailing whitespace-only line from XML formatting.
  if (lines.length && lines[0]!.trim() === "") lines.shift();
  if (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  let indent: string | null = null;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = /^[\t ]+/.exec(line);
    const leading = m ? m[0] : "";
    if (indent == null) indent = leading;
    else {
      let i = 0;
      const max = Math.min(indent.length, leading.length);
      while (i < max && indent[i] === leading[i]) i++;
      indent = indent.slice(0, i);
      if (indent === "") break;
    }
  }

  if (indent && indent.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith(indent)) lines[i] = line.slice(indent.length);
    }
  }

  return lines.join("\n");
}

/* ────────────────────────────── Trailing {width=..} blocks ────────────────────────────── */

function consumeAttrBlocksFromFollowingText(
  parent: HNode,
  startIndex: number,
): { w?: string; h?: string; thumbnail?: boolean; consumed: boolean } {
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
  let thumbnail: boolean | undefined;
  let consumedAny = false;

  while (pos < buf.length) {
    while (pos < buf.length && /\s/.test(buf[pos]!)) pos++;
    if (buf[pos] !== "{") break;
    const close = buf.indexOf("}", pos + 1);
    if (close === -1) break;

    const inner = buf.slice(pos + 1, close);
    const attrs = parseBraceAttributes(inner);
    for (const [k, rawVal] of Object.entries(attrs)) {
      const v = rawVal.trim().toLowerCase();
      const num = v.endsWith("px") ? v.slice(0, -2) : v;
      if (isDigits(num)) {
        if (k === "width" && w == null) w = num;
        if (k === "height" && h == null) h = num;
      }
      if (k === "thumbnail" && truthyAttrValue(v)) thumbnail = true;
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
  return { w, h, thumbnail, consumed: true };
}

/* ────────────────────────────── Confluence builders ────────────────────────────── */

function acParam(name: string, value: string): HNode {
  return { type: "element", tagName: "ac:parameter", properties: { "ac:name": name }, children: [{ type: "text", value }] };
}
function acRichTextBody(children: HNode[]): HNode {
  return { type: "element", tagName: "ac:rich-text-body", properties: {}, children };
}
function toCdataSections(text: string): string {
  if (!text.includes("]]>")) return `<![CDATA[${text}]]>`;
  return `<![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
function acPlainTextBody(text: string): HNode {
  // Emit explicit CDATA to preserve literal text like "]]>" safely.
  return {
    type: "element",
    tagName: "ac:plain-text-body",
    properties: {},
    children: [{ type: "raw", value: toCdataSections(String(text ?? "")) }],
  };
}
function acMacro(name: string, params?: Record<string, string>, bodyChildren?: HNode[]): HNode {
  const kids: HNode[] = [];
  if (params) for (const [k, v] of Object.entries(params)) kids.push(acParam(k, v));
  if (bodyChildren && bodyChildren.length) kids.push(acRichTextBody(bodyChildren));
  return { type: "element", tagName: "ac:structured-macro", properties: { "ac:name": name, "ac:schema-version": "1" }, children: kids };
}

function macroTitleFromProps(props: Record<string, any> | undefined): string | undefined {
  if (!props) return undefined;
  const raw = props.title ?? props.summary ?? props.name;
  if (raw == null) return undefined;
  const s = String(raw).trim();
  return s ? s : undefined;
}

function headingLevel(tag: string | undefined): number | null {
  if (!tag) return null;
  const m = /^h([1-6])$/i.exec(tag);
  return m ? Number(m[1]) : null;
}

function nodeTextContent(node: HNode): string {
  let out = "";
  const walk = (n: HNode | null | undefined) => {
    if (!n) return;
    if (n.type === "text" && typeof n.value === "string") {
      out += n.value;
      return;
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c as HNode);
    }
  };
  walk(node);
  return out;
}

function collapsibleTitleFromHeading(el: HNode): string | null {
  const raw = nodeTextContent(el);
  const re = /\s*\{[^}]*collapsible\s*=\s*(?:"true"|'true'|true)\s*[^}]*\}\s*$/i;
  if (!re.test(raw)) return null;
  const title = raw.replace(re, "").trim();
  return title ? title : null;
}

function applyCollapsibleHeadings(node: HNode) {
  if (!node || !Array.isArray(node.children)) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as HNode;
    if (!child || child.type !== "element") continue;

    const level = headingLevel(child.tagName);
    const title = level != null ? collapsibleTitleFromHeading(child) : null;
    if (level != null && title) {
      const body: HNode[] = [];
      let j = i + 1;
      while (j < node.children.length) {
        const sib = node.children[j] as HNode;
        if (sib && sib.type === "element") {
          const sibLevel = headingLevel(sib.tagName);
          if (sibLevel != null && sibLevel <= level) break;
        }
        body.push(sib);
        j++;
      }
      if (body.length) {
        const macro = acMacro("expand", { title }, body);
        node.children.splice(i, body.length + 1, macro);
        continue;
      }
    }

    applyCollapsibleHeadings(child);
  }
}

function isWhitespaceText(node: HNode): boolean {
  return node.type === "text" && String((node as any).value ?? "").trim() === "";
}

function collectCompareChildren(el: HNode): HNode[] {
  const kids = el.children || [];
  return kids.filter((c) => {
    if (!c || typeof c !== "object") return false;
    if ((c as HNode).type === "text") return !isWhitespaceText(c as HNode);
    return true;
  }) as HNode[];
}

function collectTableRows(el: HNode): HNode[] {
  const rows: HNode[] = [];
  const kids = el.children || [];
  for (const child of kids) {
    if (!child || child.type !== "element") continue;
    const tag = String(child.tagName || "").toLowerCase();
    if (tag === "tr") {
      rows.push(child);
      continue;
    }
    if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const sub of child.children || []) {
        if (sub && sub.type === "element" && String(sub.tagName || "").toLowerCase() === "tr") {
          rows.push(sub);
        }
      }
    }
  }
  return rows;
}

function applyTableEnhancements(el: HNode) {
  const p = el.properties || {};
  const styleAttr = String(p.style ?? "header-row"); // default header-row per spec
  const border = String(p.border ?? "true").toLowerCase() === "true";
  const widthPx = normalizePx(p.width);
  const fixed = String(p["column-width"] ?? "").toLowerCase() === "fixed";
  const cellpadding = p.cellpadding != null ? String(p.cellpadding) : "";
  const cellspacing = p.cellspacing != null ? String(p.cellspacing) : "";

  // Map header-row/column/both
  const rows = collectTableRows(el);
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
        const first = (r.children || []).find((c) =>
          c.type === "element" && ((c as HNode).tagName === "td" || (c as HNode).tagName === "th")
        ) as HNode | undefined;
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
}

async function makeAcImageFromSrc(
  src: string,
  width?: string | number,
  height?: string | number,
  style?: unknown,
  alt?: string,
  title?: string,
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
  if (alt) props["ac:alt"] = String(alt);
  const titleVal = title ?? alt;
  if (titleVal) props["ac:title"] = String(titleVal);

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



function formatLastModifiedDate(d: Date, timeZone: string): string {
  try {
    // en-GB formats as "10 January 2026"
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }).format(d);
  } catch {
    // Fallback if timeZone isn't supported in the runtime
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  }
}

function buildLastModifiedParagraph(dateText: string): HNode {
  const txt = `Last modified: ${dateText}`;
  return {
    type: "element",
    tagName: "p",
    properties: {},
    children: [
      {
        type: "element",
        tagName: "em",
        properties: {},
        children: [{ type: "text", value: txt }],
      },
    ],
  };
}

function isLastModifiedParagraph(node: HNode | null | undefined): boolean {
  if (!node || node.type !== "element" || node.tagName !== "p") return false;
  const kids = (node as any).children;
  if (!Array.isArray(kids) || kids.length !== 1) return false;
  const em = kids[0] as HNode;
  if (!em || em.type !== "element" || em.tagName !== "em") return false;
  const txt = nodeTextContent(em).trim();
  return /^last modified:/i.test(txt);
}

function stripMacroIdFromCodeMacros(node: HNode) {
  if (!node || typeof node !== "object") return;
  if ((node as any).type === "element") {
    const el = node as HNode;
    if (String(el.tagName || "").toLowerCase() === "ac:structured-macro") {
      const props = (el.properties ||= {});
      if (props["ac:name"] === "code" && (props as any)["ac:macro-id"]) {
        delete (props as any)["ac:macro-id"];
      }
    }
    if (Array.isArray((el as any).children)) {
      for (const ch of (el as any).children as HNode[]) stripMacroIdFromCodeMacros(ch);
    }
  }
}

/* ────────────────────────────── Main plugin ────────────────────────────── */

export default function rehypeConfluenceStorage(opts: RehypeConfluenceOptions = {}) {
  const insertToc = opts.insertToc === true;
  const tocMacroId = opts.tocMacroId ?? "a854a720-dea6-4d0f-a0a2-e4591c07d85e";
  const defaultTocMaxLevel = Number.isFinite(opts.tocMaxLevel) ? Number(opts.tocMaxLevel) : 3;
  const tocPosition: "top" | "after-first-h1" = opts.tocPosition ?? "top";
  const insertLastModified = opts.insertLastModified !== false;
  const lastModifiedTimeZone = opts.lastModifiedTimeZone ?? "Asia/Colombo";
  const lastModifiedText = insertLastModified
    ? (typeof opts.lastModified === "string"
        ? String(opts.lastModified).trim()
        : formatLastModifiedDate(
            opts.lastModified instanceof Date ? opts.lastModified : new Date(),
            lastModifiedTimeZone,
          ))
    : "";
  const imagesDir = opts.imagesDir ?? IMAGE_DIR;
  const readFileFn = resolveReadFile(opts.readFile);
  const categoryTitles = opts.categoryTitles ?? {};
  const rewriteCodeBlockImages = opts.rewriteCodeBlockImages === true;

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
    function removeNode(parent: HNode, idx: number) {
      parent.children!.splice(idx, 1);
    }
    function unwrapNode(parent: HNode, idx: number, kids: HNode[] | undefined) {
      parent.children!.splice(idx, 1, ...(kids || []));
    }

    /* ────────────── Tag handlers ────────────── */

    type Handler = (el: HNode, parent: HNode, idx: number) => void | Promise<void>;
    const handlers: Record<string, Handler> = {
      /* code-block → code macro with plain-text-body */
      "code-block": (el, parent, idx) => {
        const props = el.properties || {};
        const lang = (props.lang ?? props.language ?? "plain text").toString();
        let codeText = normalizeCodeBlockText(collectCodeBlockText(el));

        // Special case: fix CDATA/embedded <img> for XML blocks
        if (rewriteCodeBlockImages && String(lang).toLowerCase() === "xml") {
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

      /* Compare: layout macros (section/column) */
      "compare": (el, parent, idx) => {
        const p = el.properties || {};
        const type = String(p.type ?? p.style ?? "left-right").toLowerCase();
        const titleA = String(p["title-before"] ?? p["first-title"] ?? "Before");
        const titleB = String(p["title-after"] ?? p["second-title"] ?? "After");

        const kids = collectCompareChildren(el);

        const h4 = (t: string): HNode | null => {
          const txt = String(t ?? "").trim();
          if (!txt) return null;
          return {
            type: "element",
            tagName: "h4",
            properties: {},
            children: [{ type: "text", value: txt }],
          };
        };

        const asBody = (n: HNode | undefined): HNode[] => (n ? [n] : []);

        let section: HNode;

        // Top-bottom: single column with stacked content
        if (type === "top-bottom" || type === "top-down") {
          const body: HNode[] = [];
          const headA = h4(titleA);
          if (headA) body.push(headA);
          body.push(...asBody(kids[0]));
          const headB = h4(titleB);
          if (headB) body.push(headB);
          body.push(...asBody(kids[1]));
          for (let i = 2; i < kids.length; i++) body.push(kids[i]!);

          const col = acMacro("column", undefined, body);
          section = acMacro("section", undefined, [col]);
        } else {
          const colAHead = h4(titleA);
          const colBHead = h4(titleB);
          const colA = acMacro("column", undefined, [ ...(colAHead ? [colAHead] : []), ...asBody(kids[0]) ]);
          const colBBody: HNode[] = [ ...(colBHead ? [colBHead] : []), ...asBody(kids[1]) ];
          for (let i = 2; i < kids.length; i++) colBBody.push(kids[i]!);
          const colB = acMacro("column", undefined, colBBody);

          section = acMacro("section", undefined, [colA, colB]);
        }

        replaceNode(parent, idx, section);
      },

      /* Input checkbox → [x]/[ ] text */
      "input": (el, parent, idx) => {
        const props = el.properties || {};
        if (props.type === "checkbox") {
          const checked = (("checked" in props && props.checked !== false) || props["aria-checked"] === "true");
          parent.children!.splice(idx, 1, { type: "text", value: checked ? "[x]" : "[ ]" });
        }
      },

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
          p.title ?? p.alt,
          readFileFn,
          imagesDir,
        );
        const consumed = consumeAttrBlocksFromFollowingText(parent, idx);
        if (consumed.consumed) {
          const q = ac.properties || {};
          if (consumed.w) q["ac:width"] = consumed.w;
          if (consumed.h) q["ac:height"] = consumed.h;
          if (consumed.w || consumed.h || consumed.thumbnail) q["ac:thumbnail"] = "true";
          ac.properties = q;
        }
        if (truthyAttrValue(p.thumbnail) || truthyAttrValue(p["thumbnail"])) {
          const q = ac.properties || {};
          q["ac:thumbnail"] = "true";
          ac.properties = q;
        }
        replaceNode(parent, idx, ac);
      },

      /* <img> → <ac:image> */
      "img": async (el, parent, idx) => {
        const p = el.properties || {};
        const src = p.src ?? "";
        if (!src) return;

        const ac = await makeAcImageFromSrc(
          String(src),
          p.width,
          p.height,
          p.style,
          p.alt,
          p.title ?? p.alt,
          readFileFn,
          imagesDir,
        );
        const consumed = consumeAttrBlocksFromFollowingText(parent, idx);
        if (consumed.consumed) {
          const q = ac.properties || {};
          if (consumed.w) q["ac:width"] = consumed.w;
          if (consumed.h) q["ac:height"] = consumed.h;
          if (consumed.w || consumed.h || consumed.thumbnail) q["ac:thumbnail"] = "true";
          ac.properties = q;
        }
        if (truthyAttrValue(p.thumbnail) || truthyAttrValue(p["thumbnail"])) {
          const props = ac.properties || {};
          props["ac:thumbnail"] = "true";
          ac.properties = props;
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
        const title = macroTitleFromProps(el.properties || {});
        const params = title ? { title } : undefined;
        const macro = acMacro("info", params, el.children || []);
        replaceNode(parent, idx, macro);
      },
      "tip": (el, parent, idx) => {
        const title = macroTitleFromProps(el.properties || {});
        const params = title ? { title } : undefined;
        const macro = acMacro("tip", params, el.children || []);
        replaceNode(parent, idx, macro);
      },
      "warning": (el, parent, idx) => {
        const title = macroTitleFromProps(el.properties || {});
        const params = title ? { title } : undefined;
        const macro = acMacro("warning", params, el.children || []);
        replaceNode(parent, idx, macro);
      },

      /* Writerside procedure/steps → heading + ordered list */
      "procedure": (el) => {
        const p = el.properties || {};
        const title = String(p.title ?? "").trim();
        const id = String(p.id ?? "").trim();

        const steps: HNode[] = [];
        const other: HNode[] = [];
        for (const ch of el.children || []) {
          if (ch && ch.type === "element" && (ch as any).tagName === "step") steps.push(ch);
          else if (ch && (ch.type !== "text" || String((ch as any).value || "").trim() !== "")) other.push(ch);
        }

        const kids: HNode[] = [];
        if (!title && steps.length) {
          kids.push({
            type: "element",
            tagName: "p",
            properties: {},
            children: [
              {
                type: "element",
                tagName: "strong",
                properties: {},
                children: [{ type: "text", value: "Untitled Procedure" }],
              },
            ],
          });
        }
        if (title) {
          kids.push({
            type: "element",
            tagName: "h3",
            properties: id ? { id } : {},
            children: [{ type: "text", value: title }],
          });
        }
        if (other.length) kids.push(...other);
        kids.push({
          type: "element",
          tagName: "ol",
          properties: {},
          children: steps,
        });

        el.tagName = "section";
        el.properties = {};
        el.children = kids;
      },

      "step": (el) => {
        el.tagName = "li";
      },

      /* Writerside tabs → expand macros */
      "tabs": (el) => {
        const tabs = (el.children || []).filter((c) =>
          c && c.type === "element" && (c as any).tagName === "tab"
        ) as HNode[];

        const kids: HNode[] = [];
        for (const tab of tabs) {
          const tp = (tab as any).properties || {};
          const title = String(tp.title ?? tp.name ?? "").trim();
          const body = ((tab as any).children || []).filter((c: any) => {
            if (!c || typeof c !== "object") return false;
            if ((c as HNode).type === "text") return !isWhitespaceText(c as HNode);
            return true;
          }) as HNode[];
          const params = title ? { title } : undefined;
          kids.push(acMacro("expand", params, body));
        }

        el.tagName = "div";
        el.properties = {};
        el.children = kids;
      },

      "tab": (_el) => {
        /* handled by parent <tabs> */
      },

      /* Writerside <seealso> → heading + category blocks */
      "seealso": (el) => {
        const kids = el.children || [];
        const heading: HNode = {
          type: "element",
          tagName: "h3",
          properties: {},
          children: [{ type: "text", value: "See also" }],
        };
        el.tagName = "section";
        el.properties = {};
        el.children = [heading, ...kids];
      },

      /* Writerside <category> → heading + list of links */
      "category": (el) => {
        const p = el.properties || {};
        const ref = String(p.ref ?? "").trim();
        const label = String(categoryTitles[ref] ?? p.name ?? p.title ?? ref ?? "").trim();
        const links = (el.children || []).filter((c) =>
          c && c.type === "element" && (c as any).tagName === "a"
        ) as HNode[];
        const liChildren = links.map((link) => ({
          type: "element",
          tagName: "li",
          properties: {},
          children: [link],
        }));
        const kids: HNode[] = [];
        if (label) {
          kids.push({
            type: "element",
            tagName: "h4",
            properties: {},
            children: [{ type: "text", value: label }],
          });
        }
        kids.push({
          type: "element",
          tagName: "ul",
          properties: {},
          children: liChildren,
        });
        el.tagName = "div";
        el.properties = {};
        el.children = kids;
      },

      /* Writerside shortcut → code */
      "shortcut": (el) => {
        el.tagName = "code";
        el.properties = {};
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
        applyTableEnhancements(el);
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
        removeNode(parent, idx);
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
          p.title ?? p.alt,
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

      /* Writerside <chapter> → mark for flattening in post-processing */
      "chapter": (_el) => {
        /* Will be flattened in post-processing step */
      },

      /* Writerside <link-summary> → removed (content not rendered) */
      "link-summary": (_el, parent, idx) => {
        if (parent && idx != null) removeNode(parent, idx);
      },

      /* Writerside <card-summary> → removed (content not rendered) */
      "card-summary": (_el, parent, idx) => {
        if (parent && idx != null) removeNode(parent, idx);
      },

      /* Writerside <tldr> → unwrap children (remove wrapper) */
      "tldr": (el, parent, idx) => {
        if (parent && idx != null && Array.isArray(el.children)) {
          unwrapNode(parent, idx, el.children);
        }
      },

      /* Writerside <cards> → unwrap children (remove wrapper) */
      "cards": (el, parent, idx) => {
        if (parent && idx != null && Array.isArray(el.children)) {
          unwrapNode(parent, idx, el.children);
        }
      },

      /* Writerside <deflist> → table with Term/Definition columns */
      "deflist": (el) => {
        const defs = (el.children || []).filter((c) =>
          c && c.type === "element" && (c as any).tagName === "def"
        ) as HNode[];

        if (!defs.length) {
          el.tagName = "div";
          el.properties = {};
          el.children = [];
          return;
        }

        const headerRow: HNode = {
          type: "element",
          tagName: "tr",
          properties: {},
          children: [
            { type: "element", tagName: "th", properties: {}, children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "Term" }] }] },
            { type: "element", tagName: "th", properties: {}, children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "Definition" }] }] },
          ],
        };

        const bodyRows = defs.map((def) => {
          const p = (def as any).properties || {};
          const termTitle = String(p.title ?? "").trim();
          const defBody = Array.isArray((def as any).children) ? ((def as any).children as HNode[]) : [];

          return {
            type: "element",
            tagName: "tr",
            properties: {},
            children: [
              { type: "element", tagName: "td", properties: {}, children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: termTitle }] }] },
              { type: "element", tagName: "td", properties: {}, children: defBody.length ? defBody : [{ type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "" }] }] },
            ],
          };
        });

        el.tagName = "table";
        el.properties = {};
        el.children = [
          { type: "element", tagName: "thead", properties: {}, children: [headerRow] },
          { type: "element", tagName: "tbody", properties: {}, children: bodyRows },
        ];

        applyTableEnhancements(el);
      },

      /* Writerside <def> → handled by parent deflist */
      "def": (_el) => {
        /* Removed by parent deflist handler */
      },

      /* Writerside <include> → removed (inclusion handled at parse stage if needed) */
      "include": (_el, parent, idx) => {
        if (parent && idx != null) removeNode(parent, idx);
      },
    };

    /* ────────────── DFS visit ────────────── */

    async function visitChildren(parent: HNode, inPre: boolean, chapterDepth: number) {
      if (!Array.isArray(parent.children)) return;
      for (let i = 0; i < parent.children.length;) {
        const child = parent.children[i] as HNode;
        const before = child;
        await visit(child, parent, i, inPre, chapterDepth);
        if (parent.children[i] === before) i++;
      }
    }

    async function visit(node: HNode, parent: HNode | null, idx: number | null, inPre: boolean, chapterDepth: number = 0) {
      if (!node || node.type !== "element") return;
      const el = node;
      const tag = (el.tagName || "").toLowerCase();
      const nextInPre = inPre || tag === "pre" || tag === "code";

      // Record tag for filtered missing-tags report
      if (FILTER_TAGS_UNION.has(tag)) encounteredFiltered.add(tag);

      if (!state.foundToc && hasTocMacro(el)) state.foundToc = true;

      if (tag === "compare") {
        await visitChildren(el, nextInPre, chapterDepth);
        const handler = handlers[tag];
        if (handler && parent && idx != null) await handler(el, parent, idx);
        return;
      }

      if (tag === "chapter") {
        // Process children first with increased depth
        await visitChildren(el, nextInPre, chapterDepth + 1);
        // Then flatten this chapter in its parent
        if (parent && idx != null) {
          const p = el.properties || {};
          const title = String(p.title ?? "").trim();
          const id = String(p.id ?? "").trim();
          
          // Use the passed-in depth
          const headingLevel = Math.min(6, 3 + chapterDepth);
          
          const kids: HNode[] = [];
          
          // Add heading if title exists
          if (title) {
            kids.push({
              type: "element",
              tagName: `h${headingLevel}`,
              properties: id ? { id } : {},
              children: [{ type: "text", value: title }],
            });
          }
          
          // Add children of chapter
          if (Array.isArray(el.children)) {
            kids.push(...el.children);
          }
          
          // Replace chapter with its flattened children
          if (kids.length > 0) {
            parent.children!.splice(idx, 1, ...kids);
          }
        }
        return;
      }

      // Skip transforming <img> inside <pre>/<code>, but still normalize props later
      if (!(tag === "img" && nextInPre)) {
        const handler = handlers[tag];
        if (handler) await handler(el, parent as HNode, idx as number);
      }

      const stillInParent = !parent || idx == null || (Array.isArray(parent.children) && parent.children[idx] === el);
      if (!stillInParent) return;

      // Recurse
      await visitChildren(el, nextInPre, chapterDepth);

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

      // Unwrap <p> that only wraps a block macro/image
      if (tag === "p" && el.children && el.children.length === 1) {
        const only = el.children[0]!;
        if (
          only.type === "element" &&
          ((only as any).tagName === "ac:image" || (only as any).tagName === "ac:structured-macro") &&
          parent &&
          idx != null
        ) {
          (parent.children ||= [])[idx] = only;
        }
      }
    }

    /* Visit only root children (not the root node itself) */
    await visitChildren(tree, /*inPre*/ false, /*chapterDepth*/ 0);

    // Post-pass: convert collapsible headings into expand macros
    applyCollapsibleHeadings(tree);
    stripMacroIdFromCodeMacros(tree);


    // TOC injection (from options or <show-structure>)
    let wrappedChildren: HNode[] = [];
    const rootChildren = tree.children || [];
    const shouldAddToc = (insertToc || state.requestedToc) && !state.foundToc;
    const tocMacro = shouldAddToc ? buildTocMacro(tocMacroId, state.requestedToc ? state.requestedTocDepth : defaultTocMaxLevel) : null;

    if (tocMacro && tocPosition === "after-first-h1") {
      let inserted = false;
      for (const c of rootChildren) {
        wrappedChildren.push(c);
        if (!inserted && c.type === "element" && c.tagName === "h1") {
          wrappedChildren.push(tocMacro); inserted = true;
        }
      }
      if (!inserted) wrappedChildren = [tocMacro, ...wrappedChildren];
    } else if (tocMacro) {
      wrappedChildren = [tocMacro, ...rootChildren];
    } else {
      wrappedChildren = rootChildren;
    }

    // Insert "Last modified" line immediately after the first H1 (Markdown "#")
    if (insertLastModified && lastModifiedText) {
      const h1Idx = wrappedChildren.findIndex((n) => n && n.type === "element" && (n as any).tagName === "h1");
      if (h1Idx !== -1) {
        const next = wrappedChildren[h1Idx + 1] as HNode | undefined;
        if (!isLastModifiedParagraph(next)) {
          wrappedChildren.splice(h1Idx + 1, 0, buildLastModifiedParagraph(lastModifiedText));
        }
      }
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
