// deno-lint-ignore-file no-explicit-any
import { XMLParser } from "fxp";
import type { Resource } from "../../shared/resource.ts";


/** Parse a Writerside vars XML string into { [name]: value }. */
function parseVarsXmlToMacros(xml: string): Record<string, string> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    // Safe defaults: we don't need tagValuesProcessor, etc.
  });

  const jObj: any = parser.parse(xml);

  const items = Array.isArray(jObj?.vars?.var)
    ? jObj.vars.var
    : (jObj?.vars?.var ? [jObj.vars.var] : []);

  const macros: Record<string, string> = {};
  for (const v of items) {
    const name = (v?.["@_name"] ?? "").toString().trim();
    const value = (v?.["@_value"] ?? "").toString();
    if (name) macros[name] = escapeXml(value);
  }
  return macros;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      default: return ch;
    }
  });
}



/**
 * Load macros from a Writerside `v.list` file located *next to* the provided cfg.
 * - Resolves `./v.list` relative to `cfgPath` via Resource.resolve.
 * - Returns {} if the file does not exist.
 */
export async function loadMacrosFromVars(
  resource: Resource,
  cfgPath: string,
): Promise<Record<string, string>> {
  // Resolve a sibling `v.list` next to the config file
  const varsPath = resource.resolve(cfgPath, "v.list");

  if (!(await resource.exists(varsPath))) {
    console.warn(`No vars file found at ${varsPath}, proceeding without.`); // todo
    return {};
  }

  const xml = await resource.readText(varsPath);
  return parseVarsXmlToMacros(xml);
}
