// Deno + npm interop, HAST v3
import type { Root, Element, Text, Properties, Content } from "hast";
import { visit } from "unist-util-visit" ;
import * as path from "node:path";

import { renderMermaidDefinitionToFile } from "../utils/mermaid.ts";
import { IMAGE_DIR, hashString, isPngFileOK } from "../utils/images.ts";
import { readEnv, resolveRuntime, type RenderRuntime } from "../core/shared/runtime.ts";

/* ------------------------------ Options -------------------------------- */
export interface RehypeConfluenceMediaOptions {
  onMermaid?: (args: { code: string; index: number }) =>
    | { filename: string; alt?: string; width?: number | string; height?: number | string }
    | Promise<{ filename: string; alt?: string; width?: number | string; height?: number | string }>;
  renderMermaid?: boolean;                 // default true
  emitMode?: "hast" | "html";             // default "hast"
  htmlImgToAttach?: boolean;              // default false (topics usually not raw HTML)
  imagesDir?: string;                     // default IMAGE_DIR
  runtime?: RenderRuntime;
}

/* ----------------------------- Utilities ------------------------------- */
function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function basenameOf(url?: string): string {
  if (!url) return "";
  const base = url.split(/[?#]/)[0]!;
  return path.basename(base);
}
function normalizeSizePx(v?: string | number): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return String(v);
  const s = String(v).trim().toLowerCase();
  const m = s.match(/^(\d+)(px)?$/);
  return m ? m[1] : undefined;
}
async function fileExists(rt: RenderRuntime | undefined, filePath: string): Promise<boolean> {
  const st = await rt?.fs?.stat(filePath);
  return Boolean(st?.isFile);
}
async function removeFile(rt: RenderRuntime | undefined, filePath: string): Promise<void> {
  if (!rt?.fs?.remove) return;
  try {
    await rt.fs.remove(filePath);
  } catch {
    // ignore
  }
}
function readEnvNumber(name: string, rt: RenderRuntime | undefined): number | undefined {
  const raw = readEnv(name, rt);
  if (raw == null) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}
function hasClass(el: Element, klass: string): boolean {
  const v = el.properties?.className as unknown;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s+/) : [];
  return list.includes(klass);
}
function dimsFromProps(props?: Properties): { width?: string; height?: string; alt?: string } {
  const out: { width?: string; height?: string; alt?: string } = {};
  if (!props) return out;
  if (props.width != null) out.width = normalizeSizePx(props.width as any);
  if (props.height != null) out.height = normalizeSizePx(props.height as any);

  // Parse inline style e.g. "width:120px; height:80px"
  const style = (props.style ?? "") as string;
  if (typeof style === "string" && style) {
    const w = /(?:^|;)\s*width\s*:\s*(\d+)px\b/i.exec(style)?.[1];
    const h = /(?:^|;)\s*height\s*:\s*(\d+)px\b/i.exec(style)?.[1];
    if (!out.width && w) out.width = w;
    if (!out.height && h) out.height = h;
  }

  if (props.alt != null) out.alt = String(props.alt);
  return out;
}
function confluenceImageElement(filename: string, meta?: { alt?: string; width?: string; height?: string }): Element {
  const props: Properties = { filename };
  if (meta?.alt) props.alt = meta.alt;
  if (meta?.width) props.width = meta.width;
  if (meta?.height) props.height = meta.height;
  return { type: "element", tagName: "confluence-image", properties: props, children: [] };
}
function rawNodeOfConfluenceImage(filename: string, meta?: { alt?: string; width?: string; height?: string }): Content {
  return {
    type: "raw",
    value:
      `<confluence-image filename="${escapeAttr(filename)}"` +
      (meta?.alt ? ` alt="${escapeAttr(meta.alt)}"` : "") +
      (meta?.width ? ` width="${escapeAttr(meta.width)}"` : "") +
      (meta?.height ? ` height="${escapeAttr(meta.height)}"` : "") +
      ` />`,
  } as unknown as Content;
}
function attachStub(file: string, width?: string, height?: string): Content {
  let s = `@@ATTACH|file=${file}`;
  if (width) s += `|width=${width}`;
  if (height) s += `|height=${height}`;
  s += "@@";
  return { type: "text", value: s } as Content;
}

export default function rehypeConfluenceMedia(options: RehypeConfluenceMediaOptions = {}) {
  const {
    renderMermaid = true,
    emitMode = "hast",
    htmlImgToAttach = false,
    imagesDir = IMAGE_DIR,
  } = options;

  return async function transformer(tree: Root) {
    const tasks: Promise<void>[] = [];
    let mermaidIndex = 0;
    const runtime = resolveRuntime(options.runtime) ?? undefined;

    // 1) Mermaid: <code-block lang="mermaid">...</code-block> → <confluence-image .../>
visit(tree, "element", (node: Element, index, parent) => {
  if (!parent || typeof index !== "number") return;

  if (node.tagName !== "code-block") return;
  if (String(node.properties?.lang).toLowerCase() !== "mermaid") return;

  // Extract code text (join all text children, in case of multiple lines)
  const codeText = (node.children ?? [])
    .filter((c): c is Text => c.type === "text" && typeof c.value === "string")
    .map((c) => c.value)
    .join("\n")
    .trim();

  if (!codeText || !renderMermaid) return;

  const replaceWith = (content: Content) => {
    (parent.children as Content[])[index] = content;
  };

  tasks.push((async () => {
    let fileName: string | null = null;
    let metaWidth: string | undefined;
    let metaHeight: string | undefined;
    let metaAlt: string | undefined;

    if (options.onMermaid) {
      const res = await options.onMermaid({ code: codeText, index: ++mermaidIndex });
      fileName = basenameOf(res.filename);
      metaWidth = normalizeSizePx(res.width ?? undefined);
      metaHeight = normalizeSizePx(res.height ?? undefined);
      if (res.alt) metaAlt = String(res.alt);
    } else {
      mermaidIndex++;
    }

    if (!fileName) {
      const out = path.join(imagesDir, `${hashString("mermaid::" + codeText)}.png`);
      let ok = false;
      try {
        ok = (await fileExists(runtime, out)) ? await isPngFileOK(out, runtime) : false;
      } catch {
        ok = false;
      }

      if (!ok && runtime?.fs && runtime.exec) {
        try {
          await renderMermaidDefinitionToFile(codeText, out, {
            width: readEnvNumber("MMD_WIDTH", runtime),
            height: readEnvNumber("MMD_HEIGHT", runtime),
            scale: readEnvNumber("MMD_SCALE", runtime),
            backgroundColor: readEnv("MMD_BG", runtime),
            theme: readEnv("MMD_THEME", runtime),
            configFile: readEnv("MMD_CONFIG", runtime),
            runtime,
          } as Record<string, unknown>);
          ok = await isPngFileOK(out, runtime);
          if (!ok) throw new Error("bad png");
        } catch {
          await removeFile(runtime, out);
        }
      }

      if (ok) fileName = path.basename(out);
    }

    if (fileName) {
      const meta = { alt: metaAlt, width: metaWidth, height: metaHeight };
      if (emitMode === "html") {
        replaceWith(rawNodeOfConfluenceImage(fileName, meta));
      } else {
        replaceWith(confluenceImageElement(fileName, meta));
      }
    }
  })());
});


    // 2) <img src="..."> → <confluence-image filename="..."/>
    visit(tree, "element", (node: Element, index, parent) => {
      if (!parent || typeof index !== "number") return;
      if (node.tagName !== "img" || !node.properties) return;

      const src = String(node.properties.src ?? "");
      if (!src) return;

      const file = basenameOf(src);
      const meta = dimsFromProps(node.properties);

      if (emitMode === "html") {
        (parent.children as Content[])[index] = rawNodeOfConfluenceImage(file, meta);
      } else {
        (parent.children as Content[])[index] = confluenceImageElement(file, meta);
      }
    });

    // 3) Optional: raw HTML <img> (rare for topics). If requested, map to @@ATTACH
    if (htmlImgToAttach) {
      visit(tree, "raw", (node: any, index, parent) => {
        if (!parent || typeof index !== "number") return;
        const val = String(node.value ?? "");
        if (!/<img\b/i.test(val)) return;

        // Very lightweight extraction (mirrors remark version behavior)
        const m = /<img\b([^>]*?)\/?>/i.exec(val);
        if (!m) return;
        const attrs = m[1] ?? "";
        const pick = (name: string) => {
          const r = new RegExp(`(?:\\s|^)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
          return r ? (r[2] ?? r[3] ?? r[4] ?? "").trim() : "";
        };
        const src = pick("src");
        if (!src) return;

        const width = normalizeSizePx(pick("width"));
        const height = normalizeSizePx(pick("height"));
        const file = basenameOf(src);

        (parent.children as Content[])[index] = attachStub(file, width, height);
      });
    }

    await Promise.all(tasks);
  };
}
