// instance_profile_parser.ts
// Instance-profile (.dtd) → xast AST
import type { Element as XEl } from "xast";
import { Parser } from "./parser_base.ts";
import { buildDtdIndex, type DtdIndex } from "./dtd_index.ts";
import { validateAgainstDtd } from "./dtd_validator.ts";

export class InstanceProfileParser extends Parser<XEl, DtdIndex> {
  protected expectedRoot = "instance-profile" as const;

  protected resolveSchema(xml: string, _root: XEl) {
    const m = xml.match(/<!DOCTYPE\s+[^\s>]+\s+SYSTEM\s+"([^"]+)"/i);
    if (!m) throw new Error("instance-profile: missing DOCTYPE SYSTEM identifier");
    return { kind: "dtd" as const, url: m[1] };
  }

  protected buildIndex(schemaText: string): DtdIndex {
    return buildDtdIndex(schemaText);
  }

  protected validate(root: XEl, index: DtdIndex): void {
    validateAgainstDtd(root, this.expectedRoot, index);
  }

  // project(): default returns AST (from base)
}
