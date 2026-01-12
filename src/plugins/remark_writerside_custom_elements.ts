// remark plugin to handle Writerside custom elements that appear in HTML raw blocks
// This converts self-closing tags to explicit opening/closing pairs to avoid parsing issues

import type { Transformer } from "unified";
import type { Root } from "mdast";

export default function remarkWritersideCustomElements(): Transformer<Root> {
  return (tree: Root) => {
    visit(tree);
  };
}

function visit(node: any): void {
  if (!node) return;

  if (Array.isArray(node.children)) {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];

      if (child.type === "html" && typeof child.value === "string") {
        const fixed = fixSelfClosingTags(child.value);
        if (fixed !== child.value) {
          child.value = fixed;
        }
      }

      visit(child);
    }
  }
}

function fixSelfClosingTags(html: string): string {
  // Writerside elements that are frequently self-closing in Markdown/HTML
  const selfClosingElements = [
    "show-structure",
    "include",
    "link-summary",
    "card-summary",
  ];

  let result = html;

  for (const elem of selfClosingElements) {
    // Matches:
    //   <elem/>
    //   <elem />
    //   <elem attr="x"/>
    //   <elem attr="x" />
    const pattern = new RegExp(`<${elem}(\\s[^>]*)?\\s*/>`, "g");
    result = result.replace(pattern, (_m, attrs) => {
      const a = attrs ? String(attrs) : "";
      return `<${elem}${a}></${elem}>`;
    });
  }

  return result;
}
