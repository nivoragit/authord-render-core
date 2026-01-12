import { visit } from "unist-util-visit";

type RawNode = { type: "raw"; value?: string };

function escapeCodeBlockRaw(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const start = lower.indexOf("<code-block", i);
    if (start < 0) {
      out += html.slice(i);
      break;
    }
    const startTagEnd = html.indexOf(">", start);
    if (startTagEnd < 0) {
      out += html.slice(i);
      break;
    }
    const endTag = "</code-block>";
    const end = lower.indexOf(endTag, startTagEnd + 1);
    if (end < 0) {
      out += html.slice(i);
      break;
    }

    out += html.slice(i, startTagEnd + 1);
    const inner = html.slice(startTagEnd + 1, end);
    out += inner.includes("<") ? inner.replace(/</g, "&lt;") : inner;
    out += html.slice(end, end + endTag.length);
    i = end + endTag.length;
  }
  return out;
}

export default function rehypeEscapeCodeBlockRaw() {
  return (tree: unknown) => {
    visit(tree as any, "raw", (node: RawNode) => {
      const raw = node.value;
      if (!raw || raw.indexOf("<code-block") < 0 || raw.indexOf("</code-block>") < 0) return;
      const escaped = escapeCodeBlockRaw(raw);
      if (escaped !== raw) node.value = escaped;
    });
  };
}
