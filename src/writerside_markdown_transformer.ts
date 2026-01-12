// WritersideMarkdownTransformer
// Unified pipeline:
//  remark-parse + remark-gfm + remark-directive + remark-confluence-media
//  -> remark-rehype({ allowDangerousHtml: true })
//  -> rehype-raw
//  -> rehype-confluence-storage
//  -> rehype-stringify({ allowDangerousHtml: true, closeSelfClosing: true, tightSelfClosing: true })

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";

import remarkConfluenceMedia from "./plugins/remark_confluence_media.ts";
import remarkWritersideCustomElements from "./plugins/remark_writerside_custom_elements.ts";
import rehypeConfluenceStorage from "./plugins/rehype_confluence_storage.ts";
import rehypeEscapeCodeBlockRaw from "./plugins/rehype_escape_code_block_raw.ts";

import type { IMarkdownTransformer } from "./core/ports/ports.ts";
import { asStorageXhtml, type StorageXhtml } from "./core/shared/types.ts";

export class WritersideMarkdownTransformer implements IMarkdownTransformer {
  constructor(private imagesDir: string) {}

  async toStorage(markdown: string): Promise<StorageXhtml> {
    const file = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkDirective)
      .use(remarkWritersideCustomElements)
      .use(remarkConfluenceMedia, {
        imagesDir: this.imagesDir,
        renderMermaid: true, 
        htmlImgToAttach: false,
      })
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeEscapeCodeBlockRaw)
      .use(rehypeRaw)
      .use(rehypeConfluenceStorage, { imagesDir: this.imagesDir })
      .use(rehypeStringify, {
        allowDangerousHtml: true,
        closeSelfClosing: true,
        tightSelfClosing: true,
      })
      .process(markdown);

    const out = String(file);
    return asStorageXhtml(out);
  }
}
