// parser_base.ts
// Abstract Parser<TOut, TIndex> (Template Method)
// import type { Element as XEl } from "npm:xast@2.0.0";
import type { Element as XEl } from "xast";
import { parseXmlToXast, getRootElement, localName } from "./xast_xml.ts";
import type { Fetcher } from "../../shared/fetcher.ts";

export abstract class Parser<TOut, TIndex> {
  /** The local name we expect for the document root. */
  protected abstract expectedRoot: string;

  /** Resolve a schema URL (XSD/DTD) from raw XML + root element. */
  protected abstract resolveSchema(xml: string, root: XEl): { kind: "xsd" | "dtd"; url: string };

  /** Build an in-memory index for validation (XSD or DTD). */
  protected abstract buildIndex(schemaText: string): TIndex;

  /** Validate the AST root against the index. Throw on failure. */
  protected abstract validate(root: XEl, index: TIndex): void;

  /** Optional post-processing: project to a domain result (default: identity). */
  // deno-lint-ignore no-explicit-any
  protected project(root: XEl): any { return root; }

  async parse(xml: string, fetcher: Fetcher = defaultFetcher): Promise<TOut> {
    const ast = parseXmlToXast(xml);
    const root = getRootElement(ast);
    if (localName(root.name) !== this.expectedRoot) {
      throw new Error(`Root must be <${this.expectedRoot}>, got <${localName(root.name)}>`);
    }

    const { url } = this.resolveSchema(xml, root);
    const schema = await fetcher(url);
    const index = this.buildIndex(schema);
    this.validate(root, index);

    return this.project(root) as TOut;
  }
}

async function defaultFetcher(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch schema: ${r.status} ${r.statusText}`);
  return r.text();
}
