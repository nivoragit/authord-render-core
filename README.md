# @authord/render-core

Shared rendering and parsing core for Authord.

## Usage

```ts
import { renderDocset, setRenderRuntime } from "@authord/render-core";
import { createNodeRuntime } from "@authord/render-core/runtime-node";

setRenderRuntime(createNodeRuntime());

import { createDenoRuntime } from "@authord/render-core/runtime-deno";

setRenderRuntime(createDenoRuntime());
```

Raw import URLs (Deno):

```ts
import { renderDocset } from "https://raw.githubusercontent.com/nivoragit/authord-render-core/main/mod.ts";
import { createNodeRuntime } from "https://raw.githubusercontent.com/nivoragit/authord-render-core/main/runtime-node.ts";
import { createDenoRuntime } from "https://raw.githubusercontent.com/nivoragit/authord-render-core/main/runtime-deno.ts";
```
