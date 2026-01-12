// deno-lint-ignore-file no-explicit-any
/**
 * ConfluenceStorageRenderer
 * FinalDocsetAst -> Confluence Storage XHTML
 * - Topic pages: XAST -> HAST (TopicXastToHast) -> rehype-confluence-storage (AST) -> stringify
 * - Markdown pages: delegate to IMarkdownTransformer.toStorage
 */

import { unified } from "unified";
import rehypeStringify from "rehype-stringify";
import rehypeConfluenceStorage, { type RehypeConfluenceOptions } from "../../plugins/rehype_confluence_storage.ts";
import type { IMarkdownTransformer } from "../ports/ports.ts";
import type { Element as XEl } from "xast";
import { asStorageXhtml, type StorageXhtml } from "../shared/types.ts";
import { TopicXastToHast, type HastRoot } from "../../topic/topic_to_hast.ts";
import { AuthordAst } from "./authord_ast_assembler.ts";
import rehypeConfluenceMedia from "../../plugins/rehype-confluence-media.ts";
import { preSanitize } from "../domain/parse/xast_xml.ts";
import { log } from "node:console";

export type PageRender = { path: string; media: "storage-xhtml"; xhtml: StorageXhtml };

export type ConfluenceStorageRendererDeps = {
  markdown: IMarkdownTransformer;
  topicToHast?: TopicXastToHast;
  rehypeOpts?: RehypeConfluenceOptions;
};

export class ConfluenceStorageRenderer {
  private readonly topicToHast: TopicXastToHast;
  private readonly rehypeOpts: RehypeConfluenceOptions;

  constructor(private readonly deps: ConfluenceStorageRendererDeps, private imagesDir: string) {
    this.topicToHast = deps.topicToHast ?? new TopicXastToHast();
    this.rehypeOpts = deps.rehypeOpts ?? {};
  }

  /** Render the whole docset to Confluence Storage XHTML. */
  async renderDocset(docset: AuthordAst): Promise<PageRender[]> {
    const out: PageRender[] = [];
    for (const page of docset.pages) {
      if (page.kind === "markdown") {
        const text = extractMdText(page.ast);
        const storage = await this.deps.markdown.toStorage(text);
        out.push({ path: page.path, media: "storage-xhtml", xhtml: storage });
      } else {
        const xhtml = await this.renderTopicAst(page.ast);
        out.push({ path: page.path, media: "storage-xhtml", xhtml });
      }
    }
    // log(out) todo remove 
    return out;
  }

  /** Topic XAST -> Storage XHTML string (safe: no .process on AST). */
  async renderTopicAst(topic: XEl): Promise<StorageXhtml> {
    const storageAst = await this.toStorageAstForTopic(topic);

    // We already have a HAST tree -> run compiler pipeline only.
    const proc = unified().use(rehypeStringify, {
      allowDangerousHtml: true,
      closeSelfClosing: true,
      tightSelfClosing: true,
    });

    const transformed = await proc.run(storageAst as any);      // no parser
    const html = String(proc.stringify(transformed as any));    // compile to string
    return asStorageXhtml(html);
  }

  /** Topic XAST -> HAST transformed by rehype-confluence-storage (AST). */
  async toStorageAstForTopic(topic: XEl): Promise<HastRoot> {
    const initialHast = this.topicToHast.toHast(topic);
    const rehypeOpts = { ...this.rehypeOpts };
    if (!("imagesDir" in rehypeOpts) || !rehypeOpts.imagesDir) {
      rehypeOpts.imagesDir = this.imagesDir;
    }
    const proc = unified()
    // IMPORTANT: media first → creates <confluence-image> nodes
    .use(rehypeConfluenceMedia, {
      imagesDir: this.imagesDir,       // wherever your attachment sync picks up from
      renderMermaid: true,
      // htmlImgToAttach: false,   // leave false for topics unless you really need stubs
    })
    // Then map HAST → Confluence Storage AST
    .use(rehypeConfluenceStorage, rehypeOpts);
    const transformed = await proc.run(initialHast as any);     // transform AST
    return transformed as HastRoot;
  }
}

/* ----------------------------- helpers ----------------------------- */

function extractMdText(mdPageAst: XEl): string {
  // from wrapMarkdownAsMdPageXast(): <md-page src="...">#text</md-page>
  const t = (mdPageAst.children ?? []).find((c) => c.type === "text") as any;
  return t?.value ?? "";
}
