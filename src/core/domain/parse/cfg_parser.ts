// cfg_parser.ts
// Writerside config (.cfg, XSD) → IRConfig
import type { Element as XEl } from "xast";
import { Parser } from "./parser_base.ts";
import { getAttr, firstChild, childElements } from "./xast_xml.ts";
import { buildXsdIndex, type XsdIndex } from "./xsd_index.ts";
import { validateAgainstXsd } from "./xsd_validator.ts";

export interface IRConfig {
  topicsDir: string;
  snippetsDir: string;
  imagesDir: { dir: string; webPath?: string };
  instances: { src: string; webPath?: string }[];
}

export class WritersideCfgParser extends Parser<IRConfig, XsdIndex> {
  protected expectedRoot = "ihp" as const;

  protected resolveSchema(_xml: string, root: XEl) {
    const kv = Object.entries(root.attributes ?? {}).find(([k]) => k.endsWith(":noNamespaceSchemaLocation"));
    if (!kv) throw new Error("cfg: missing xsi:noNamespaceSchemaLocation");
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

  protected override project(root: XEl): IRConfig {
    const topicsDir = getAttr(firstChild(root, "topics") ?? ({} as XEl), "dir") ?? "topics";
    const images = firstChild(root, "images");
    const imagesDir = images ? (getAttr(images, "dir") ?? "images") : "images";
    const imagesWebPath = images ? getAttr(images, "web-path") : undefined;
    const snippetsDir = getAttr(firstChild(root, "snippets") ?? ({} as XEl), "src") ?? "snippets";

    const instances = childElements(root, "instance")
      .map((i) => ({ src: getAttr(i, "src"), webPath: getAttr(i, "web-path") }))
      .filter((o): o is { src: string; webPath: string } => !!o.src);

    return {
      topicsDir,
      snippetsDir,
      imagesDir: { dir: imagesDir, webPath: imagesWebPath },
      instances,
    };
  }
}



