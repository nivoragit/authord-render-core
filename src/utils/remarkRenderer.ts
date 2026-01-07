import { unified } from "unified";
import rehypeStringify from "rehype-stringify";

import rehypeConfluenceMedia from "../plugins/rehype-confluence-media.ts";
import rehypeConfluenceStorage, { type RehypeConfluenceOptions } from "../plugins/rehype_confluence_storage.ts";
import { WritersideMarkdownTransformer } from "../writerside_markdown_transformer.ts";
import { TopicXastToHast } from "../topic/topic_to_hast.ts";
import { parseXmlToXast, getRootElement, localName, type XmlSanitizeOptions } from "../core/domain/parse/xast_xml.ts";
import { AuthordAstAssembler, type AuthordAst, type BuildDocsetOptions, wrapMarkdownAsMdPageXast } from "../core/application/authord_ast_assembler.ts";
import { IMAGE_DIR, getDefaultImageDir } from "./images.ts";
import type { Element as XEl } from "xast";

export type RenderMarkdownOptions = {
  imageFolder?: string;
};

export type RenderTopicOptions = {
  imageFolder?: string;
  rehypeOpts?: RehypeConfluenceOptions;
};

export type RenderXmlOptions = RenderTopicOptions & {
  sanitize?: XmlSanitizeOptions;
};

export type RenderDocsetOptions = RenderTopicOptions;

export type RenderDocsetFromCfgOptions = BuildDocsetOptions & RenderDocsetOptions;

/**
 * Renders Markdown to Confluence-compatible XHTML using the project's markdown pipeline.
 * @param markdown - The Markdown content to render.
 * @param imageFolder - The folder for storing images.
 * @param docPath - The path of the document being processed (currently unused).
 * @returns The rendered XHTML string.
 */
export async function renderContent(
  markdown: string,
  imageFolder: string = getDefaultImageDir() ?? IMAGE_DIR,
  _docPath?: string,
): Promise<string> {
  return await renderMarkdown(markdown, { imageFolder });
}

export async function renderMarkdown(
  markdown: string,
  opts: RenderMarkdownOptions = {},
): Promise<string> {
  const imageFolder = opts.imageFolder ?? getDefaultImageDir();
  const transformer = new WritersideMarkdownTransformer(imageFolder);
  const xhtml = await transformer.toStorage(markdown);
  return String(xhtml);
}

export async function renderMarkdownAsMdPage(
  markdown: string,
  docPath: string,
  opts: RenderMarkdownOptions = {},
): Promise<string> {
  const mdPage = wrapMarkdownAsMdPageXast(markdown, docPath);
  return await renderXast(mdPage, opts);
}

export async function renderTopicXml(
  xml: string,
  opts: RenderXmlOptions = {},
): Promise<string> {
  const root = getRootElement(parseXmlToXast(xml, opts.sanitize));
  return await renderXast(root, opts);
}

export async function renderXast(
  root: XEl,
  opts: RenderTopicOptions = {},
): Promise<string> {
  const tag = localName(root.name);
  if (tag === "md-page") {
    const markdown = extractMarkdownFromMdPage(root);
    return await renderMarkdown(markdown, { imageFolder: opts.imageFolder });
  }
  if (tag === "topic") {
    return await renderTopicXast(root, opts);
  }
  throw new Error(`renderXast: unsupported root <${tag}> (expected <topic> or <md-page>).`);
}

export async function renderTopicXast(
  topic: XEl,
  opts: RenderTopicOptions = {},
): Promise<string> {
  const imageFolder = opts.imageFolder ?? getDefaultImageDir();
  const toHast = new TopicXastToHast();
  const hast = toHast.toHast(topic);

  const rehypeOpts = { ...(opts.rehypeOpts ?? {}) };
  if (!("imagesDir" in rehypeOpts) || !rehypeOpts.imagesDir) {
    rehypeOpts.imagesDir = imageFolder;
  }
  const proc = unified()
    .use(rehypeConfluenceMedia, { imagesDir: imageFolder, renderMermaid: true })
    .use(rehypeConfluenceStorage, rehypeOpts)
    .use(rehypeStringify, {
      allowDangerousHtml: true,
      closeSelfClosing: true,
      tightSelfClosing: true,
    });

  const transformed = await proc.run(hast as any);
  const html = String(proc.stringify(transformed as any));
  return html;
}

export async function renderDocset(
  docset: AuthordAst,
  opts: RenderDocsetOptions = {},
): Promise<Array<{ path: string; xhtml: string }>> {
  const imageFolder = opts.imageFolder ?? getDefaultImageDir();
  const transformer = new WritersideMarkdownTransformer(imageFolder);
  const out: Array<{ path: string; xhtml: string }> = [];

  for (const page of docset.pages) {
    if (page.kind === "markdown") {
      const markdown = extractMarkdownFromMdPage(page.ast);
      const xhtml = await transformer.toStorage(markdown);
      out.push({ path: page.path, xhtml: String(xhtml) });
      continue;
    }
    const xhtml = await renderTopicXast(page.ast, opts);
    out.push({ path: page.path, xhtml });
  }

  return out;
}

export async function renderDocsetFromCfg(
  opts: RenderDocsetFromCfgOptions,
): Promise<Array<{ path: string; xhtml: string }>> {
  const { imageFolder, rehypeOpts, ...buildOpts } = opts;
  const assembler = new AuthordAstAssembler();
  const docset = await assembler.build(buildOpts);
  return await renderDocset(docset, { imageFolder, rehypeOpts });
}

function extractMarkdownFromMdPage(mdPage: XEl): string {
  const parts: string[] = [];
  for (const child of mdPage.children ?? []) {
    if (child.type === "text") {
      const value = (child as { value?: unknown }).value;
      parts.push(String(value ?? ""));
    }
  }
  return parts.join("");
}
