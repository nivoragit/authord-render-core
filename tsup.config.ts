import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/mod.ts", "runtime-node": "src/runtime/node.ts", "runtime-deno": "src/runtime/deno.ts" },
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  platform: "node",
  external: [
    "image-size",
    "rehype-raw",
    "rehype-stringify",
    "remark-directive",
    "remark-gfm",
    "remark-parse",
    "remark-rehype",
    "unified",
    "unist-util-visit",
    "xast-util-from-xml"
  ]
});
