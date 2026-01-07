import { assertRejects, assertStringIncludes } from "std/assert";
import { renderMarkdown, renderTopicXml, renderXast } from "../src/mod.ts";
import { getRootElement, parseXmlToXast } from "../src/core/domain/parse/xast_xml.ts";

Deno.test("renderMarkdown renders images to Confluence storage", async () => {
  const markdown = "![Alt text](cat.png)";
  const html = await renderMarkdown(markdown);
  assertStringIncludes(html, "<ac:image");
  assertStringIncludes(html, "ri:filename=\"cat.png\"");
});

Deno.test("renderTopicXml renders a simple topic", async () => {
  const xml = "<topic><title>My Title</title><p>Body</p></topic>";
  const html = await renderTopicXml(xml);
  assertStringIncludes(html, "My Title");
  assertStringIncludes(html, "Body");
});

Deno.test("renderXast rejects unsupported root elements", async () => {
  const xml = "<unknown />";
  const root = getRootElement(parseXmlToXast(xml));
  await assertRejects(
    () => renderXast(root),
    Error,
    "renderXast: unsupported root",
  );
});
