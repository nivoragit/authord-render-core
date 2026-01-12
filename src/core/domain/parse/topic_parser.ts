// topic_parser.ts
// Topic (.xsd) → xast AST (strictly validated)
import type { Element as XEl } from "xast";
import { Parser } from "./parser_base.ts";
import { buildXsdIndex, type XsdIndex } from "./xsd_index.ts";
import { validateAgainstXsd } from "./xsd_validator.ts";

export class TopicParser extends Parser<XEl, XsdIndex> {
  protected expectedRoot = "topic" as const;

  protected resolveSchema(_xml: string, root: XEl) {
    const kv = Object.entries(root.attributes ?? {}).find(([k]) => k.endsWith(":noNamespaceSchemaLocation"));
    if (!kv) throw new Error("topic: missing xsi:noNamespaceSchemaLocation");
    const raw = String(kv[1]).trim();
    const parts = raw.split(/\s+/);
    return { kind: "xsd" as const, url: parts[parts.length - 1] };
  }

  protected buildIndex(schemaText: string): XsdIndex {
    return buildXsdIndex(schemaText);
  }

  protected validate(root: XEl, index: XsdIndex): void {
    validateAgainstXsd(root, this.expectedRoot, index);
  }
}
