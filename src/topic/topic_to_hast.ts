// deno-lint-ignore-file no-explicit-any
/**
 * TopicXastToHast (enhanced)
 * Writerside Topic (XAST) -> HAST
 */

import type { Element as XEl } from "xast";

export type HastNode = {
  type: "root" | "element" | "text" | "comment";
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};
export type HastRoot = HastNode & { type: "root"; children: HastNode[] };

export type TopicToHastOptions = {
  /** Base heading level for the first <title>. Default: 1 => <h1> */
  baseHeadingLevel?: number;
};

export class TopicXastToHast {
  constructor(private readonly opts: TopicToHastOptions = {}) {}

  toHast(topicRoot: XEl): HastRoot {
    if (!topicRoot || topicRoot.type !== "element" || localName(topicRoot.name) !== "topic") {
      throw new Error("TopicXastToHast: expected <topic> element as root");
    }
    const level = this.opts.baseHeadingLevel ?? 1;
    const children = this.#convertChildren(topicRoot, { headingLevel: level, chapterDepth: 0 });
    return { type: "root", children };
  }

  /* ---------------------------- private ---------------------------- */

  #convertChildren(node: XEl, ctx: Ctx): HastNode[] {
    const out: HastNode[] = [];
    for (const c of node.children ?? []) {
      if (c.type === "text" || c.type === "cdata") {
        const v = (c as any).value ?? "";
        if (v !== "") out.push({ type: "text", value: String(v) });
        continue;
      }
      if (c.type !== "element") continue;

      const el = c as XEl;
      const ln = localName(el.name);

      switch (ln) {
        /* Headings and structural */
        case "title": {
          const tag = clampHeading(ctx.headingLevel);
          out.push(h(tag, {}, this.#convertChildren(el, ctx)));
          break;
        }
        case "section": {
          const hasOwnTitle = hasDirectChild(el, "title");
          const next = { ...ctx, headingLevel: hasOwnTitle ? ctx.headingLevel + 1 : ctx.headingLevel };
          out.push(h("section", pick(el, ["id", "class"]), this.#convertChildren(el, next)));
          break;
        }
        case "chapter": {
          // Synthetic structure (from old domain model)
          const id = attrOf(el, "id");
          const title = textOfFirst(el, "title");
          const level = clampHeadingNumber(2 + ctx.chapterDepth);
          if (title) out.push(h(`h${level}`, id ? { id } : {}, [{ type: "text", value: title }]));
          const next = { ...ctx, chapterDepth: ctx.chapterDepth + 1 };
          out.push(...this.#convertChildren(el, next));
          break;
        }

        /* Paragraph & inline */
        case "p":
        case "para":
          out.push(h("p", pick(el, ["id", "class"]), this.#convertChildren(el, ctx)));
          break;

        case "format": {
          // Try semantic role first
          const role = (el.attributes?.["role"] ?? "").toString().toLowerCase();
          const style = (el.attributes?.["style"] ?? "").toString();
          const kids = this.#convertChildren(el, ctx);
          if (role === "em" || role === "i") out.push(h("em", {}, kids));
          else if (role === "strong" || role === "b") out.push(h("strong", {}, kids));
          else if (role === "code") out.push(h("code", {}, kids));
          else if (role === "kbd") out.push(h("kbd", {}, kids));
          else if (role === "del" || role === "strike") out.push(h("del", {}, kids));
          else out.push(h("span", style ? { style } : {}, kids));
          break;
        }

        case "a":
        case "link": {
          const href = (el.attributes?.["href"] ?? el.attributes?.["url"] ?? "").toString();
          const props: Record<string, unknown> = { href };
          const titleAttr = el.attributes?.["title"] ?? el.attributes?.["summary"];
          if (titleAttr) props.title = String(titleAttr);
          const target = el.attributes?.["target"];
          if (target) props.target = String(target);
          Object.assign(props, pick(el, ["id", "class"]));
          out.push(h("a", props, this.#convertChildren(el, ctx)));
          break;
        }

        case "em":
        case "i": out.push(h("em", {}, this.#convertChildren(el, ctx))); break;
        case "strong":
        case "b": out.push(h("strong", {}, this.#convertChildren(el, ctx))); break;
        case "code": out.push(h("code", {}, this.#convertChildren(el, ctx))); break;
        case "kbd": out.push(h("kbd", {}, this.#convertChildren(el, ctx))); break;
        case "del":
        case "strike": out.push(h("del", {}, this.#convertChildren(el, ctx))); break;

        /* Admonitions (preserve tag for downstream Confluence mapping) */
        case "note":
        case "tip":
        case "warning":
        case "important":
          out.push(h(ln, pickAll(el), this.#convertChildren(el, ctx)));
          break;

        /* Spotlight */
        case "spotlight":
          out.push(h("div", { className: "spotlight" }, this.#convertChildren(el, ctx)));
          break;

        /* Writerside structures preserved for downstream Confluence mapping */
        case "procedure":
        case "step":
        case "tabs":
        case "tab":
        case "seealso":
        case "category":
        case "shortcut":
          out.push(h(ln, pickAll(el), this.#convertChildren(el, ctx)));
          break;

        /* Lists */
        case "list": {
          const kind = (el.attributes?.["type"] ?? el.attributes?.["kind"])?.toString().toLowerCase();
          const tag = (kind === "numbered" || kind === "ordered") ? "ol" : "ul";
          out.push(h(tag, pick(el, ["id", "class"]), this.#convertChildren(el, ctx)));
          break;
        }
        case "item":
        case "li":
          out.push(h("li", pick(el, ["id", "class"]), this.#convertChildren(el, ctx)));
          break;

        /* Images */
        case "image":
        case "img": {
          const src = String(el.attributes?.["src"] ?? el.attributes?.["href"] ?? el.attributes?.["file"] ?? "");
          const width = normalizePx(el.attributes?.["width"]);
          const height = normalizePx(el.attributes?.["height"]);
          const alt = (el.attributes?.["alt"] ?? "") ? String(el.attributes?.["alt"]) : undefined;
          const props: Record<string, unknown> = { src };
          if (width) props.width = width;
          if (height) props.height = height;
          if (alt) props.alt = alt;
          out.push(h("img", props, []));
          break;
        }

        /* Tables */
        case "table": out.push(h("table", {}, this.#convertChildren(el, ctx))); break;
        case "thead": out.push(h("thead", {}, this.#convertChildren(el, ctx))); break;
        case "tbody": out.push(h("tbody", {}, this.#convertChildren(el, ctx))); break;
        case "tr": out.push(h("tr", {}, this.#convertChildren(el, ctx))); break;
        case "th": out.push(h("th", {}, this.#convertChildren(el, ctx))); break;
        case "td": out.push(h("td", {}, this.#convertChildren(el, ctx))); break;

        /* Code block (props passthrough for storage plugin) */
        case "code-block": {
          const props: Record<string, unknown> = {};
          const lang = (el.attributes?.["lang"] ?? el.attributes?.["language"])?.toString();
          if (lang) props.lang = lang;
          if (el.attributes?.["collapsed-title"]) props["collapsed-title"] = String(el.attributes!["collapsed-title"]);
          if (el.attributes?.["collapsible"]) props["collapsible"] = String(el.attributes!["collapsible"]);
          if (el.attributes?.["include-lines"]) props["include-lines"] = String(el.attributes!["include-lines"]);
          if (el.attributes?.["src"]) props["src"] = String(el.attributes!["src"]);
          out.push(h("code-block", props, this.#convertChildren(el, ctx)));
          break;
        }

        /* Residual include markers (should be resolved upstream) */
        case "include":
        case "include-marker":
          // Drop marker, keep nothing.
          break;

        /* Unknown: unwrap unless attrs matter */
        default: {
          const kids = this.#convertChildren(el, ctx);
          if (hasRenderableAttrs(el)) out.push(h("div", pick(el, ["id", "class"]), kids));
          else out.push(...kids);
        }
      }
    }
    return out;
  }
}

/* ---------------------------- helpers ---------------------------- */

type Ctx = { headingLevel: number; chapterDepth: number };

function localName(q: string): string {
  const i = q.lastIndexOf(":");
  return i >= 0 ? q.slice(i + 1).toLowerCase() : q.toLowerCase();
}

function h(tagName: string, properties: Record<string, unknown>, children: HastNode[]): HastNode {
  const props = normalizeProps(properties);
  return { type: "element", tagName, properties: props, children };
}

function clampHeading(n: number): string {
  return `h${clampHeadingNumber(n)}`;
}
function clampHeadingNumber(n: number): number {
  return Math.min(6, Math.max(1, Math.floor(n)));
}

function pick(el: XEl, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = el.attributes?.[k];
    if (v != null && v !== "") out[k === "class" ? "className" : k] = v;
  }
  return out;
}

function pickAll(el: XEl): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el.attributes ?? {})) {
    if (v != null && v !== "") out[k === "class" ? "className" : k] = v;
  }
  return out;
}

function attrOf(el: XEl, name: string): string | undefined {
  const v = el.attributes?.[name];
  return v == null ? undefined : String(v);
}

function hasRenderableAttrs(el: XEl): boolean {
  const a = el.attributes ?? {};
  return a["id"] != null || a["class"] != null || a["style"] != null || a["data-*"] != null;
}

function normalizeProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "class") out["className"] = v;
    else out[k] = v;
  }
  return out;
}

function normalizePx(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    let s = v.trim().toLowerCase();
    if (s.endsWith("px")) s = s.slice(0, -2);
    return /^\d+$/.test(s) ? s : undefined;
  }
  return undefined;
}

function hasDirectChild(el: XEl, local: string): boolean {
  return (el.children ?? []).some((c) => c.type === "element" && localName((c as XEl).name) === local);
}

function textOfFirst(el: XEl, local: string): string | null {
  const n = (el.children ?? []).find((c) => c.type === "element" && localName((c as XEl).name) === local) as XEl | undefined;
  if (!n) return null;
  let buf = "";
  for (const c of n.children ?? []) if ((c as any).type === "text") buf += String((c as any).value ?? "");
  return buf || null;
}
