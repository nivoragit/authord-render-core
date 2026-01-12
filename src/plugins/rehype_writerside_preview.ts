import type { Content, Element, Parent, Properties, Root, Text } from "hast";

export interface RehypeWritersidePreviewOptions {
  /** Base heading level for top-level <chapter>. Default: 2. */
  chapterBaseLevel?: number;
  /** Remove <show-structure> nodes. Default: true. */
  removeShowStructure?: boolean;
  /** Custom tag handlers keyed by tag name (lowercased). */
  customHandlers?: Record<string, CustomTagHandler>;
}

type Ctx = { chapterDepth: number; chapterBaseLevel: number };
export type CustomTagHandler = (el: Element, ctx: Ctx) => void;

export default function rehypeWritersidePreview(
  opts: RehypeWritersidePreviewOptions = {},
) {
  const chapterBaseLevel = clampHeadingLevel(opts.chapterBaseLevel ?? 2);
  const removeShowStructure = opts.removeShowStructure ?? true;
  const customHandlers = normalizeCustomHandlers(opts.customHandlers);

  return (tree: Root) => {
    transformChildren(tree as Parent, { chapterDepth: 0, chapterBaseLevel }, {
      removeShowStructure,
      customHandlers,
    });
  };
}

function transformChildren(
  parent: Parent,
  ctx: Ctx,
  opts: { removeShowStructure: boolean; customHandlers: Record<string, CustomTagHandler> },
) {
  const kids = parent.children;
  if (!Array.isArray(kids)) return;

  for (let i = 0; i < kids.length; i++) {
    const node = kids[i];
    if (!node || node.type !== "element") continue;

    const el = node as Element;
    const originalTag = (el.tagName ?? "").toLowerCase();

    if (originalTag === "show-structure") {
      if (opts.removeShowStructure) {
        kids.splice(i, 1);
        i--;
        continue;
      } else {
        transformShowStructure(el);
      }
    }

    const isChapter = originalTag === "chapter";

    if (originalTag === "chapter") {
      transformChapter(el, ctx);
    } else if (originalTag === "list") {
      transformList(el);
    } else if (originalTag === "item") {
      el.tagName = "li";
    } else if (originalTag === "code-block") {
      const replacement = transformCodeBlock(el);
      kids[i] = replacement;
    } else if (originalTag === "format") {
      transformFormat(el);
    } else if (
      originalTag === "note" ||
      originalTag === "tip" ||
      originalTag === "warning" ||
      originalTag === "important"
    ) {
      transformAdmonition(el, originalTag);
    } else if (originalTag === "spotlight") {
      transformSpotlight(el);
    } else if (originalTag === "image") {
      transformImage(el);
    }

    const nextCtx = isChapter
      ? { ...ctx, chapterDepth: ctx.chapterDepth + 1 }
      : ctx;

    const currentNode = kids[i];
    if (currentNode && currentNode.type === "element") {
      const currentEl = currentNode as Element;
      const currentTag = (currentEl.tagName ?? "").toLowerCase();
      applyCustomHandler(opts.customHandlers, originalTag, currentTag, currentEl, nextCtx);
      transformChildren(currentEl as Parent, nextCtx, opts);
    }
  }
}

function transformChapter(el: Element, ctx: Ctx) {
  const props = (el.properties ??= {});
  const titleAttr = stringProp(props, "title");
  const idAttr = stringProp(props, "id");

  const titleChildIdx = findChildIndex(el, "title");
  const titleChildText = titleChildIdx >= 0
    ? extractText(el.children?.[titleChildIdx] as Content)
    : "";

  const title = (titleAttr || titleChildText || "").trim();

  if (titleChildIdx >= 0) {
    el.children?.splice(titleChildIdx, 1);
  }

  if (title) {
    const level = clampHeadingLevel(ctx.chapterBaseLevel + ctx.chapterDepth);
    const heading: Element = {
      type: "element",
      tagName: `h${level}`,
      properties: idAttr ? { id: idAttr } : {},
      children: [{ type: "text", value: title } as Text],
    };
    el.children = [heading, ...(el.children ?? [])];
    if ("title" in props) delete (props as Record<string, unknown>).title;
    if (idAttr && "id" in props) delete (props as Record<string, unknown>).id;
  }

  el.tagName = "section";
  addClass(props, "ws-chapter");
}

function transformList(el: Element) {
  const props = (el.properties ??= {});
  const kind = (stringProp(props, "type") ?? stringProp(props, "kind") ?? "").toLowerCase();
  el.tagName = (kind === "numbered" || kind === "ordered") ? "ol" : "ul";
  if ("type" in props) delete (props as Record<string, unknown>).type;
  if ("kind" in props) delete (props as Record<string, unknown>).kind;
}

function transformCodeBlock(el: Element): Element {
  const props = (el.properties ??= {});
  const lang = stringProp(props, "lang") ?? stringProp(props, "language");
  const codeText = normalizeCodeText(extractText(el));

  const codeProps: Properties = {};
  if (lang) codeProps.className = [`language-${lang}`];

  const preProps: Properties = {};
  if (props.id) preProps.id = props.id;
  if (props.className) preProps.className = props.className;
  if (props.style) preProps.style = props.style;

  return {
    type: "element",
    tagName: "pre",
    properties: preProps,
    children: [{
      type: "element",
      tagName: "code",
      properties: codeProps,
      children: [{ type: "text", value: codeText } as Text],
    }],
  };
}

function transformFormat(el: Element) {
  const props = (el.properties ??= {});
  const role = (stringProp(props, "role") ?? "").toLowerCase();
  const style = stringProp(props, "style") ?? "";

  if (role === "em" || role === "i") el.tagName = "em";
  else if (role === "strong" || role === "b") el.tagName = "strong";
  else if (role === "code") el.tagName = "code";
  else if (role === "kbd") el.tagName = "kbd";
  else if (role === "del" || role === "strike") el.tagName = "del";
  else {
    el.tagName = "span";
    if (style) props.style = style;
  }

  if ("role" in props) delete (props as Record<string, unknown>).role;
}

function transformAdmonition(el: Element, kind: string) {
  el.tagName = "div";
  addClass((el.properties ??= {}), `admonition-${kind}`);
}

function transformSpotlight(el: Element) {
  el.tagName = "div";
  addClass((el.properties ??= {}), "spotlight");
}

function transformImage(el: Element) {
  const props = (el.properties ??= {});
  const src = stringProp(props, "src") ?? stringProp(props, "href") ?? stringProp(props, "file");
  if (src) props.src = src;
  el.tagName = "img";
}

function transformShowStructure(el: Element) {
  const props = (el.properties ??= {});
  const depth = stringProp(props, "depth");
  const forAttr = stringProp(props, "for");
  el.tagName = "nav";
  addClass(props, "ws-toc");
  if (depth) (props as Record<string, unknown>)["data-depth"] = depth;
  if (forAttr) (props as Record<string, unknown>)["data-for"] = forAttr;
}

function findChildIndex(parent: Parent, tagName: string): number {
  const kids = parent.children ?? [];
  const target = tagName.toLowerCase();
  return kids.findIndex((c) =>
    c && c.type === "element" && ((c as Element).tagName ?? "").toLowerCase() === target
  );
}

function extractText(node?: Content | null): string {
  if (!node) return "";
  if (node.type === "text") return String((node as Text).value ?? "");
  if (node.type === "element") {
    const kids = (node as Parent).children ?? [];
    let out = "";
    for (const c of kids) out += extractText(c as Content);
    return out;
  }
  return "";
}

function normalizeCodeText(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  if (out.startsWith("\n")) out = out.slice(1);
  if (out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

function clampHeadingLevel(level: number): number {
  const n = Math.floor(level);
  if (n < 1) return 1;
  if (n > 6) return 6;
  return n;
}

function stringProp(props: Properties | undefined, key: string): string | undefined {
  if (!props) return undefined;
  const val = (props as Record<string, unknown>)[key];
  if (val == null) return undefined;
  if (Array.isArray(val)) return val.join(" ");
  return String(val);
}

function addClass(props: Properties, className: string) {
  const raw = (props as Record<string, unknown>).className ?? (props as Record<string, unknown>).class;
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
    ? raw.split(/\s+/).filter(Boolean)
    : [];
  if (!list.includes(className)) list.push(className);
  (props as Record<string, unknown>).className = list;
  if ("class" in props) delete (props as Record<string, unknown>).class;
}

function normalizeCustomHandlers(
  handlers?: Record<string, CustomTagHandler>,
): Record<string, CustomTagHandler> {
  const out: Record<string, CustomTagHandler> = {};
  if (!handlers) return out;
  for (const [key, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    out[key.toLowerCase()] = handler;
  }
  return out;
}

function applyCustomHandler(
  handlers: Record<string, CustomTagHandler>,
  originalTag: string,
  currentTag: string,
  el: Element,
  ctx: Ctx,
) {
  const primary = handlers[originalTag];
  if (primary) primary(el, ctx);
  if (currentTag !== originalTag) {
    const secondary = handlers[currentTag];
    if (secondary) secondary(el, ctx);
  }
}
