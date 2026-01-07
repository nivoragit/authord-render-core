/**
 * XML → xast utilities (stream/token-based sanitization; no brittle slicing).
 * - Removes prolog (BOM, XML declaration, DOCTYPE)
 * - Repairs invalid comment bodies (no `--` inside)
 * - Scrubs invalid XML 1.0 chars from text
 * - Masks protected segments (CDATA, comments, PIs) during entity/angle transforms
 * - Normalizes Unicode spaces *inside tags* (outside quotes) → ASCII space
 *   and drops zero-width marks inside tags
 * - Normalizes entities & stray ampersands
 * - Applies *container-aware* text policies via a single streaming pass
 *
 * Public surface:
 *   - preSanitize(xml, options?)
 *   - parseXmlToXast(xml, options?)
 *   - getRootElement, localName, getAttr, childElements, firstChild
 */

import { fromXml } from "xast-util-from-xml";
import type { Element as XEl, Root } from "xast";

/* ────────────────────────────── Types ────────────────────────────── */

export interface XmlSanitizeOptions {
  // Step toggles
  stripProlog?: boolean; // default true
  fixInvalidComments?: boolean; // default true
  scrubInvalidXmlChars?: boolean; // default true
  normalizeUnicodeSpacesInTags?: boolean; // default true

  // Entities
  entityPolicy?: "convert" | "escape" | "error"; // default "convert"
  namedEntities?: Record<string, number>; // extend/override built-ins

  // Container policies
  /**
   * Container names where we treat content as "text-ish" but allow rich HTML tags.
   * Match is by *local name* (namespace-agnostic). Defaults include Writerside/Docs needs.
   * e.g. <xs:documentation>…</xs:documentation>
   */
  richTextContainers?: string[]; // default ["documentation", "link-summary", "card-summary", "web-summary"]

  /**
   * Container names where we want a stricter, inline-only set (legacy behavior).
   * Match by local name. Keep if you still rely on these.
   */
  inlineTextContainers?: string[]; // default ["p"]

  /**
   * If true, within any configured container we neutralize *all* tags (except the container’s own closer).
   * Useful for “treat everything as literal text” cases.
   */
  forceTextInContainers?: boolean; // default false

  /**
   * When NOT forcing text: if true, unknown tags inside containers are turned into literal text (&lt;…&gt;).
   * Namespaced tags (like ac:image) are preserved by default.
   */
  escapeUnknownTagMentionsInText?: boolean; // default true

  /**
   * Extra inline tags allowed inside *inline* containers (names are local, lowercased).
   * NOTE: block tags intentionally omitted here to avoid HTML-in-<p> oddities.
   */
  allowedInlineTags?: string[]; // see DEFAULTS

  /**
   * Tags allowed inside *rich* containers (e.g., xs:documentation).
   * Includes a broad set of block + inline HTML-ish names.
   */
  allowedRichTags?: string[]; // see DEFAULTS

  /**
   * Whether to escape bare '<' that are not part of a well-formed tag while inside containers.
   */
  escapeBareAnglesInText?: boolean; // default true

  // Audit
  onChange?: (kind: string, detail: string) => void; // optional audit hook
}

const NOOP: (kind: string, detail: string) => void = () => {};

/* ───────────────── Allowed tags: updated for Writerside ───────────────── */

const ALLOW_INLINE_DEFAULT = [
  // HTML/common inline
  "a",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "code",
  "kbd",
  "var",
  "samp",
  "sub",
  "sup",
  "span",
  "small",
  "abbr",
  "cite",
  "q",
  "mark",
  "del",
  "ins",
  "br",
  "img",
  "tt",

  // Writerside inline (new)
  "emphasis", // <emphasis>
  "format", // <format style="..." color="...">
  "path", // <path>
  "control", // <control>
  "tooltip", // <tooltip term="...">
  "math", // <math>
  "icon", // <icon src="..." ...>
  "ui-path", // <ui-path>
  "shortcut", // <shortcut key="..."> / <shortcut>...</shortcut>
];

const ALLOW_RICH_DEFAULT = [
  ...ALLOW_INLINE_DEFAULT,

  // HTML/common block
  "p",
  "pre",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "figure",
  "figcaption",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",

  // Writerside block-ish (safe to keep when author uses them in rich text containers)
  "list",
  "deflist",
  "def",
  "tabs",
  "tab",
  "compare",
  "code-block",
  "video",
  "inline-frame",
  "resource",
  "property",
  "seealso",
  "category",
  "group",
  "links",
  "cards",
  "card",
  "spotlight",
  "description",
  "tldr",
  "primary",
  "secondary",
  "misc",
];

const DEFAULTS: Required<Omit<XmlSanitizeOptions, "onChange">> & {
  onChange: NonNullable<XmlSanitizeOptions["onChange"]>;
} = {
  stripProlog: true,
  fixInvalidComments: true,
  scrubInvalidXmlChars: true,
  normalizeUnicodeSpacesInTags: true,

  entityPolicy: "convert",
  namedEntities: {},

  // Treat these as “rich text” containers when they appear with real open/close tags
  // (self-closing instances will NOT push context; see function below).
  richTextContainers: [
    "documentation", // xs:documentation
    "link-summary",
    "card-summary",
    "web-summary",
    "description",
    "tldr",
  ],
  inlineTextContainers: ["p"],

  forceTextInContainers: false,
  escapeUnknownTagMentionsInText: true,
  allowedInlineTags: ALLOW_INLINE_DEFAULT,
  allowedRichTags: ALLOW_RICH_DEFAULT,
  escapeBareAnglesInText: true,

  onChange: NOOP,
};

/* ────────────────────── Utilities: chars, names, fences ────────────────────── */

function isAlphaNum(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    ch === "_" || ch === ":" || ch === "-" || ch === "."
  );
}

export function localName(qname: string): string {
  const i = qname.indexOf(":");
  return i >= 0 ? qname.slice(i + 1) : qname;
}

/** Remove leading/trailing Markdown fences. */
function stripCodeFences(input: string): string {
  let s = input;

  const start = s.match(/^\s*(?:(```+|~~~+)[^\n]*\n|``[^\n]*\n)/);
  if (start) s = s.slice(start[0].length);

  s = s.replace(/\n(?:```+|~~~+)\s*$/, "");
  s = s.replace(/\n``\s*$/, "");
  return s;
}

function startsWithAt(s: string, i: number, marker: string): boolean {
  return s.slice(i, i + marker.length) === marker;
}

/* ────────────────────── Prolog & structural scrubs ────────────────────── */

function stripProlog(input: string): string {
  let i = 0;
  if (input.charCodeAt(0) === 0xFEFF) i = 1; // BOM
  let s = input.slice(i);

  while (true) {
    let advanced = false;

    // leading whitespace
    let j = 0;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    if (j) {
      s = s.slice(j);
      advanced = true;
    }

    // <?xml ...?>
    if (s.startsWith("<?xml")) {
      const end = s.indexOf("?>");
      if (end >= 0) {
        s = s.slice(end + 2);
        advanced = true;
        continue;
      }
    }

    // <!DOCTYPE ... [ ... ]>
    if (s.startsWith("<!DOCTYPE")) {
      const gt = s.indexOf(">");
      const br = s.indexOf("[");
      if (gt >= 0 && (br < 0 || br > gt)) {
        s = s.slice(gt + 1);
        advanced = true;
        continue;
      }
      if (br >= 0) {
        const endSubset = s.indexOf("]>");
        if (endSubset >= 0) {
          s = s.slice(endSubset + 2);
          advanced = true;
          continue;
        }
      }
    }

    if (!advanced) break;
  }
  return s;
}

function repairInvalidComments(s: string): string {
  // Replace `--` inside comments with `- -` (keeps length stable-ish)
  let out = "";
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("<!--", i);
    if (open < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, open);
    const close = s.indexOf("-->", open + 4);
    if (close < 0) {
      out += s.slice(open);
      break;
    }
    const body = s.slice(open + 4, close).replace(/--/g, "- -");
    out += "<!--" + body + "-->";
    i = close + 3;
  }
  return out;
}

function scrubInvalidXmlCharsInText(s: string): string {
  // Remove C0 controls except TAB, LF, CR; also remove FFFE/FFFF
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0B || code === 0x0C ||
      (code >= 0x0E && code <= 0x1F) ||
      code === 0xFFFE || code === 0xFFFF
    ) continue;
    out += s[i]!;
  }
  return out;
}

/* ────────────────────── Protected-segment masking ────────────────────── */

type Masked = { text: string; restore: (t: string) => string };

function maskProtectedSegments(s: string): Masked {
  const holes: string[] = [];
  const token = (k: number) => `\u0000__HOLE_${k}__\u0000`;
  let out = "";
  let i = 0;

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);

    if (startsWithAt(s, lt, "<![CDATA[")) {
      const end = s.indexOf("]]>", lt + 9);
      if (end >= 0) {
        holes.push(s.slice(lt, end + 3));
        out += token(holes.length - 1);
        i = end + 3;
        continue;
      }
    }
    if (startsWithAt(s, lt, "<?")) {
      const end = s.indexOf("?>", lt + 2);
      if (end >= 0) {
        holes.push(s.slice(lt, end + 2));
        out += token(holes.length - 1);
        i = end + 2;
        continue;
      }
    }
    if (startsWithAt(s, lt, "<!--")) {
      const end = s.indexOf("-->", lt + 4);
      if (end >= 0) {
        holes.push(s.slice(lt, end + 3));
        out += token(holes.length - 1);
        i = end + 3;
        continue;
      }
    }

    out += "<";
    i = lt + 1;
  }

  const restore = (t: string) =>
    t.replace(/\u0000__HOLE_(\d+)__\u0000/g, (_m, n) => holes[Number(n)]!);

  return { text: out, restore };
}

/* ────────────────────── Entities & ampersands ────────────────────── */

const XML5 = new Set(["lt", "gt", "amp", "quot", "apos"]);
const BUILTIN_ENTITIES: Record<string, number> = {
  nbsp: 160,
  thinsp: 8201,
  ensp: 8194,
  emsp: 8195,
  shy: 173,
  ndash: 8211,
  mdash: 8212,
  hellip: 8230,
  middot: 183,
  bull: 8226,
  copy: 169,
  reg: 174,
  trade: 8482,
  euro: 8364,
  pound: 163,
  yen: 165,
  sect: 167,
  para: 182,
  deg: 176,
  sup1: 185,
  sup2: 178,
  sup3: 179,
  laquo: 171,
  raquo: 187,
  lsquo: 8216,
  rsquo: 8217,
  ldquo: 8220,
  rdquo: 8221,
  larr: 8592,
  uarr: 8593,
  rarr: 8594,
  darr: 8595,
  harr: 8596,
  times: 215,
  divide: 247,
};

/* ────────────────────── NEW: normalize Unicode spaces inside tags ────────────────────── */

const UNICODE_SPACE_IN_TAG = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u2028\u2029]/;
const ZERO_WIDTH_MARKS = /[\u200B-\u200D\u2060\uFEFF]/;

function isLikelyTagStart(s: string, i: number): boolean {
  // assumes s[i] === '<'
  const n = s[i + 1];
  // element start, closing tag, PI/doctype; comments/CDATA are already masked earlier
  return !!n && /[A-Za-z_/?]/.test(n);
}

/**
 * Replace Unicode space separators with ASCII space *inside tag markup* (outside quotes),
 * and drop zero-width marks inside tags. Leaves text content and quoted attribute values intact.
 */
function normalizeUnicodeSpacesInsideTags(s: string): string {
  let out = "";
  let i = 0;
  let inTag = false;
  let quote: '"' | "'" | null = null;

  while (i < s.length) {
    const ch = s[i]!;
    if (!inTag) {
      if (ch === "<" && isLikelyTagStart(s, i)) {
        inTag = true;
      }
      out += ch;
      i++;
      continue;
    }

    // inTag === true
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      out += ch;
      i++;
      continue;
    }

    if (ch === ">") {
      inTag = false;
      out += ch;
      i++;
      continue;
    }

    // unquoted, still inside tag: normalize
    if (UNICODE_SPACE_IN_TAG.test(ch)) {
      out += " ";
    } else if (ZERO_WIDTH_MARKS.test(ch)) {
      // drop it
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

function normalizeEntitiesAndAmpersands(
  s: string,
  entityPolicy: XmlSanitizeOptions["entityPolicy"],
  entityMap: Record<string, number>,
  onChange: (kind: string, detail: string) => void,
): string {
  let out = "";

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "&") {
      out += ch;
      continue;
    }

    // Numeric ref
    if (s[i + 1] === "#") {
      let j = i + 2, isHex = false;
      if (s[j] === "x" || s[j] === "X") {
        isHex = true;
        j++;
      }
      let digits = "";
      while (
        j < s.length && ((isHex && /[0-9A-Fa-f]/.test(s[j]!)) || (!isHex && /[0-9]/.test(s[j]!)))
      ) {
        digits += s[j]!;
        j++;
      }
      if (digits && s[j] === ";") {
        out += s.slice(i, j + 1);
        i = j;
        continue;
      }
      out += "&amp;";
      continue; // stray '&' before a broken numeric entity
    }

    // Named entity
    let j = i + 1, name = "";
    if (/[A-Za-z]/.test(s[j]!)) {
      name += s[j]!;
      j++;
      while (j < s.length && isAlphaNum(s[j]!)) {
        name += s[j]!;
        j++;
      }
      if (s[j] === ";") {
        const lower = name.toLowerCase();
        if (XML5.has(lower)) {
          out += `&${lower};`;
        } else if (entityMap[lower] != null) {
          const code = entityMap[lower]!;
          out += `&#${code};`;
          onChange("entity", `&${name};→&#${code};`);
        } else {
          if (entityPolicy === "error") {
            throw new Error(`[authord] Unknown named entity: &${name};`);
          }
          out += `&amp;${name};`;
          onChange("entity-unknown", `&${name};→&amp;${name};`);
        }
        i = j;
        continue;
      }
    }

    // Bare ampersand
    out += "&amp;";
  }
  return out;
}

/* ────────────────────── Tag tokenizer (quote-aware) ────────────────────── */

type DetailedTag =
  | {
    valid: true;
    end: number;
    qname: string;
    local: string;
    closing: boolean;
    selfClosing: boolean;
  }
  | { valid: false; end: number };

function parseTagDetailed(s: string, lt: number): DetailedTag {
  let i = lt + 1;
  if (i >= s.length) return { valid: false, end: lt + 1 };

  let closing = false;
  if (s[i] === "/") {
    closing = true;
    i++;
  }

  const c0 = s[i];
  if (!c0 || !(/[A-Za-z_]/.test(c0))) return { valid: false, end: lt + 1 };

  let name = "";
  while (i < s.length && /[\w:.\-]/.test(s[i]!)) {
    name += s[i]!;
    i++;
  }
  const qname = name;
  const local = localName(name).toLowerCase();

  let quote: string | null = null;
  let selfClosing = false;
  let lastNonWs: string | null = null;

  while (i < s.length) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === ">") {
      selfClosing = lastNonWs === "/";
      return { valid: true, end: i + 1, qname, local, closing, selfClosing };
    }
    if (ch === "<") return { valid: false, end: lt + 1 }; // nested '<' before closing
    if (!/\s/.test(ch)) lastNonWs = ch;
    i++;
  }
  return { valid: false, end: lt + 1 };
}

/* ─────────────── Streaming container-aware transform (core redesign) ─────────────── */

function applyContainerPoliciesStream(
  s: string,
  o: Required<
    Pick<
      XmlSanitizeOptions,
      | "richTextContainers"
      | "inlineTextContainers"
      | "forceTextInContainers"
      | "escapeUnknownTagMentionsInText"
      | "allowedInlineTags"
      | "allowedRichTags"
      | "escapeBareAnglesInText"
    >
  >,
): string {
  const richNames = new Set(o.richTextContainers.map((x) => x.toLowerCase()));
  const inlineNames = new Set(o.inlineTextContainers.map((x) => x.toLowerCase()));

  const allowInline = new Set(o.allowedInlineTags.map((x) => x.toLowerCase()));
  const allowRich = new Set(o.allowedRichTags.map((x) => x.toLowerCase()));

  type Ctx = { kind: "rich" | "inline"; nameLocal: string; innerStack: string[] };
  const ctxStack: Ctx[] = [];
  const top = () => ctxStack[ctxStack.length - 1];

  const isContainerOpen = (local: string) => richNames.has(local) || inlineNames.has(local);
  const containerKindOf = (local: string): Ctx["kind"] => richNames.has(local) ? "rich" : "inline";
  const allowedForKind = (kind: Ctx["kind"]) => (kind === "rich" ? allowRich : allowInline);

  let out = "";
  let i = 0;

  while (i < s.length) {
    const ch = s[i]!;
    if (ch !== "<") {
      out += ch;
      i++;
      continue;
    }

    const tag = parseTagDetailed(s, i);
    if (!tag.valid) {
      // Only escape bare '<' while INSIDE a text container
      if (ctxStack.length && o.escapeBareAnglesInText) {
        out += "&lt;";
        i++;
      } else {
        out += "<";
        i++;
      }
      continue;
    }

    const tagText = s.slice(i, tag.end);
    const current = top();

    // 1) Entering a container? (ignore self-closing)
    if (!tag.closing && isContainerOpen(tag.local)) {
      out += tagText;
      i = tag.end;
      if (!tag.selfClosing) {
        ctxStack.push({ kind: containerKindOf(tag.local), nameLocal: tag.local, innerStack: [] });
      }
      continue;
    }

    // 2) Leaving a container?
    if (tag.closing && current && tag.local === current.nameLocal) {
      out += tagText;
      ctxStack.pop();
      i = tag.end;
      continue;
    }

    // 3) Inside a container → enforce allowed content
    if (current) {
      if (o.forceTextInContainers) {
        // Treat any tag as literal text inside containers
        out += "&lt;" + tagText.slice(1, -1).replace(/</g, "&lt;").replace(/>/g, "&gt;") + "&gt;";
        i = tag.end;
        continue;
      }

      const allowSet = allowedForKind(current.kind);
      const isNamespaced = tag.qname.includes(":");

      // Namespaced tags are preserved (Confluence/ri/ac, xs:…, etc.)
      if (isNamespaced) {
        // maintain simple inner balance for prettiness
        if (!tag.closing && !tag.selfClosing) current.innerStack.push(tag.local);
        else if (tag.closing && current.innerStack[current.innerStack.length - 1] === tag.local) {
          current.innerStack.pop();
        }
        out += tagText;
        i = tag.end;
        continue;
      }

      // Non-namespaced: check allowed
      const allowed = allowSet.has(tag.local);
      if (allowed) {
        if (tag.closing) {
          const top = current.innerStack[current.innerStack.length - 1];
          if (top === tag.local) {
            current.innerStack.pop();
            out += tagText;
          } else {
            // stray closing tag -> escape
            out += "&lt;" + tagText.slice(1, -1) + "&gt;";
          }
          i = tag.end;
          continue;
        }

        // opening tag
        if (!tag.selfClosing) current.innerStack.push(tag.local);
        out += tagText;
        i = tag.end;
        continue;
      }

      // Unknown inside text container → either escape or keep verbatim
      if (o.escapeUnknownTagMentionsInText) {
        out += "&lt;" + tagText.slice(1, -1).replace(/</g, "&lt;").replace(/>/g, "&gt;") + "&gt;";
      } else {
        out += tagText;
      }
      i = tag.end;
      continue;
    }

    // 4) Outside containers → pass-through
    out += tagText;
    i = tag.end;
  }

  return out;
}

/* ───────────────────────── Public sanitize API ───────────────────────── */

export function preSanitize(xml: string, opts: XmlSanitizeOptions = {}): string {
  const o = { ...DEFAULTS, ...opts };
  const entities = { ...BUILTIN_ENTITIES, ...o.namedEntities };
  const log = o.onChange ?? NOOP;

  const s0 = stripCodeFences(xml);

  // 1) Prolog/doctype/comment/char scrubs
  let s = o.stripProlog ? stripProlog(s0) : s0;
  if (o.fixInvalidComments) s = repairInvalidComments(s);
  if (o.scrubInvalidXmlChars) s = scrubInvalidXmlCharsInText(s);

  // 2) Mask protected segments while we normalize inside-tag whitespace & entities
  const masked = maskProtectedSegments(s);
  let work = masked.text;

  // 2a) Normalize Unicode whitespace inside tag markup (outside quotes)
  if (o.normalizeUnicodeSpacesInTags) {
    work = normalizeUnicodeSpacesInsideTags(work);
  }

  // 3) Entities / ampersands
  work = normalizeEntitiesAndAmpersands(work, o.entityPolicy, entities, log);

  // 4) Container-aware streaming transform (core)
  work = applyContainerPoliciesStream(work, {
    richTextContainers: o.richTextContainers,
    inlineTextContainers: o.inlineTextContainers,
    forceTextInContainers: o.forceTextInContainers,
    escapeUnknownTagMentionsInText: o.escapeUnknownTagMentionsInText,
    allowedInlineTags: o.allowedInlineTags,
    allowedRichTags: o.allowedRichTags,
    escapeBareAnglesInText: o.escapeBareAnglesInText,
  });

  // 5) Restore masked segments
  s = masked.restore(work);
  return s;
}

/* ───────────────────────── Parse & helpers ───────────────────────── */

export function parseXmlToXast(xml: string, opts?: XmlSanitizeOptions): Root {
  // if (opts) {
  //   opts.escapeUnknownTagMentionsInText = true; // safe default
  //   // (optional) add any additional Writerside containers you use often:
  //   opts.richTextContainers = ["documentation","link-summary","card-summary","web-summary","description","tldr"] ;
  // }

  const sanitized = preSanitize(xml, opts);
  try {
    return fromXml(sanitized);
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message ?? String(err);
    const m = msg.match(/line\s+(\d+),\s*column\s+(\d+)/i);
    const where = m ? ` (at line ${m[1]}, column ${m[2]})` : "";
    console.error(`[authord] XML parse error${where}: ${msg}`);
    throw new Error(`[authord] XML parse error${where}: ${msg}`);
  }
}

export function getRootElement(ast: Root): XEl {
  const el = ast.children.find((n: any) => n.type === "element") as XEl | undefined;
  if (!el) throw new Error("XML has no root element");
  return el;
}

export function getAttr(el: XEl, name: string): string | undefined {
  return (el.attributes?.[name] as string | undefined) ?? undefined;
}

export function childElements(el: XEl, name?: string): XEl[] {
  const local = (q: string) => {
    const i = q.indexOf(":");
    return i >= 0 ? q.slice(i + 1) : q;
  };
  return (el.children.filter((c: any) => c.type === "element") as XEl[])
    .filter((c) => (name ? local(c.name) === name : true));
}

export function firstChild(el: XEl, name: string): XEl | undefined {
  return childElements(el, name)[0];
}
