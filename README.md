# @authord/render-core

Core rendering and AST utilities shared between the Authord CLI and VS Code extension.

- Framework-agnostic rendering pipeline (Markdown/Topic → Confluence Storage XHTML)
- Writerside parsers, XSD/DTD validation, and docset assembly
- Runtime-agnostic I/O via `RenderRuntime`

## Usage

```ts
import { renderContent, setRenderRuntime } from "@authord/render-core";
import { createNodeRuntime } from "@authord/runtime-node";

setRenderRuntime(createNodeRuntime());
const html = await renderContent(markdown, "images");
```
