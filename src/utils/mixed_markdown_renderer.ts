import { unified } from "unified";
import type { PluggableList } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import rehypeWritersidePreview, {
  type RehypeWritersidePreviewOptions,
} from "../plugins/rehype_writerside_preview.ts";
import rehypeEscapeCodeBlockRaw from "../plugins/rehype_escape_code_block_raw.ts";

export interface MixedMarkdownRenderOptions extends RehypeWritersidePreviewOptions {
  /** Preserve raw HTML in the output. Default: true. */
  allowDangerousHtml?: boolean;
  /** Extra remark plugins to extend Markdown syntax. */
  remarkPlugins?: PluggableList;
  /** Extra rehype plugins to extend HTML handling. */
  rehypePlugins?: PluggableList;
}

export async function renderMixedMarkdownToHtml(
  markdown: string,
  opts: MixedMarkdownRenderOptions = {},
): Promise<string> {
  const {
    allowDangerousHtml = true,
    remarkPlugins,
    rehypePlugins,
    ...previewOpts
  } = opts;

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective);

  if (remarkPlugins && remarkPlugins.length > 0) {
    processor.use(remarkPlugins);
  }

  processor
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeEscapeCodeBlockRaw)
    .use(rehypeRaw)
    .use(rehypeWritersidePreview, previewOpts);

  if (rehypePlugins && rehypePlugins.length > 0) {
    processor.use(rehypePlugins);
  }

  const file = await processor
    .use(rehypeStringify, { allowDangerousHtml })
    .process(markdown);

  return String(file);
}
