// dtd_index.ts
// Build an in-memory index from a DTD (ELEMENT + ATTLIST) with a real content-model AST.
// This is "strict enough" to validate Writerside-style DTDs (like ihp.dtd / instance-profile.dtd).

export type DtdOccurs = "1" | "?" | "*" | "+";

export type DtdContentModel =
  | { kind: "NAME"; name: string; occurs: DtdOccurs }
  | { kind: "PCDATA"; occurs: DtdOccurs }
  | { kind: "SEQ"; items: DtdContentModel[]; occurs: DtdOccurs }
  | { kind: "CHOICE"; items: DtdContentModel[]; occurs: DtdOccurs };

export type DtdAttrType =
  | { kind: "CDATA" }
  | { kind: "ENUM"; values: ReadonlySet<string> }
  | { kind: "OTHER"; name: string }; // ID, NMTOKEN, etc (treated as string for now)

export type DtdAttrDefault =
  | { kind: "#REQUIRED" }
  | { kind: "#IMPLIED" }
  | { kind: "#FIXED"; value: string }
  | { kind: "DEFAULT"; value: string };

export type DtdAttributeDecl = {
  name: string;
  type: DtdAttrType;
  defaultDecl: DtdAttrDefault;
};

export type DtdElement = {
  name: string;
  /** Content model: "ANY", "EMPTY", or a parsed model AST. */
  content: "ANY" | "EMPTY" | DtdContentModel;

  /** Derived convenience set (for fast checks / error messages). */
  allowedChildren: Set<string> | "ANY" | "EMPTY";

  /** Attribute declarations keyed by attribute name. */
  attrs: Map<string, DtdAttributeDecl>;

  /** Derived convenience sets. */
  declaredAttrs: Set<string>;
  requiredAttrs: Set<string>;
};

export type DtdIndex = { elements: Map<string, DtdElement> };

// -------------------------
// Public API
// -------------------------

/** Parse a DTD text into an index for validation. */
export function buildDtdIndex(dtdText: string): DtdIndex {
  const elements = new Map<string, DtdElement>();

  const decls = extractDeclarations(dtdText);

  for (const decl of decls) {
    const inner = stripOuterDecl(decl);

    if (inner.startsWith("ELEMENT ")) {
      const { name, model } = parseElementDecl(inner);
      const content = parseElementModel(model);
      const allowedChildren = deriveAllowedChildren(content);

      const existing = elements.get(name);
      const base: DtdElement = existing ?? {
        name,
        content,
        allowedChildren,
        attrs: new Map(),
        declaredAttrs: new Set(),
        requiredAttrs: new Set(),
      };

      // If the element was already created from ATTLIST, fill in content info.
      base.content = content;
      base.allowedChildren = allowedChildren;
      elements.set(name, base);
    }

    if (inner.startsWith("ATTLIST ")) {
      const { elementName, attrs } = parseAttlistDecl(inner);

      const existing = elements.get(elementName);
      const base: DtdElement = existing ?? {
        name: elementName,
        content: "ANY",
        allowedChildren: "ANY",
        attrs: new Map(),
        declaredAttrs: new Set(),
        requiredAttrs: new Set(),
      };

      for (const a of attrs) {
        base.attrs.set(a.name, a);
        base.declaredAttrs.add(a.name);
        if (a.defaultDecl.kind === "#REQUIRED") base.requiredAttrs.add(a.name);
      }

      elements.set(elementName, base);
    }
  }

  return { elements };
}

// -------------------------
// DTD declaration scanning
// -------------------------

function extractDeclarations(dtd: string): string[] {
  // Extract "<! ... >" blocks while respecting quotes.
  const out: string[] = [];
  let i = 0;

  while (true) {
    const start = dtd.indexOf("<!", i);
    if (start === -1) break;

    let j = start + 2;
    let quote: string | null = null;
    for (; j < dtd.length; j++) {
      const ch = dtd[j];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === `"` || ch === `'`) {
        quote = ch;
        continue;
      }
      if (ch === ">") break;
    }
    if (j >= dtd.length) break;

    out.push(dtd.slice(start, j + 1));
    i = j + 1;
  }

  return out;
}

function stripOuterDecl(decl: string): string {
  // "<!ELEMENT ...>" -> "ELEMENT ..."
  const s = decl.trim();
  if (!s.startsWith("<!") || !s.endsWith(">")) return s;
  return s.slice(2, -1).trim();
}

// -------------------------
// ELEMENT
// -------------------------

function parseElementDecl(inner: string): { name: string; model: string } {
  const m = inner.match(/^ELEMENT\s+([A-Za-z][\w\-]*)\s+([\s\S]+)$/);
  if (!m) throw new Error(`Bad ELEMENT decl: ${inner}`);
  return { name: m[1], model: m[2].trim() };
}

function parseElementModel(model: string): DtdElement["content"] {
  const m = model.trim();
  if (m === "ANY") return "ANY";
  if (m === "EMPTY") return "EMPTY";
  return new DtdModelParser(m).parse();
}

function deriveAllowedChildren(content: DtdElement["content"]): DtdElement["allowedChildren"] {
  if (content === "ANY") return "ANY";
  if (content === "EMPTY") return "EMPTY";
  const names = new Set<string>();
  collectNames(content, names);
  return names;
}

function collectNames(cm: DtdContentModel, out: Set<string>) {
  switch (cm.kind) {
    case "NAME":
      out.add(cm.name);
      return;
    case "PCDATA":
      return;
    case "SEQ":
    case "CHOICE":
      for (const it of cm.items) collectNames(it, out);
      return;
  }
}

// -------------------------
// ATTLIST
// -------------------------

function parseAttlistDecl(inner: string): { elementName: string; attrs: DtdAttributeDecl[] } {
  const m = inner.match(/^ATTLIST\s+([A-Za-z][\w\-]*)\s+([\s\S]+)$/);
  if (!m) throw new Error(`Bad ATTLIST decl: ${inner}`);

  const elementName = m[1];
  const rhs = m[2];

  const toks = tokenizeDtdRhs(rhs);
  const attrs: DtdAttributeDecl[] = [];

  let i = 0;
  while (i < toks.length) {
    const name = toks[i++];
    const typeTok = toks[i++];
    const defTok = toks[i++];

    if (!name || !typeTok || !defTok) {
      throw new Error(`Incomplete ATTLIST for <${elementName}> near token ${i}`);
    }

    const type = parseAttrType(typeTok);
    const { defaultDecl, consumedExtra } = parseAttrDefault(defTok, toks, i);
    i += consumedExtra;

    attrs.push({ name, type, defaultDecl });
  }

  return { elementName, attrs };
}

function parseAttrType(tok: string): DtdAttrType {
  if (tok === "CDATA") return { kind: "CDATA" };

  // Enumeration: (a|b|c)
  if (tok.startsWith("(") && tok.endsWith(")")) {
    const body = tok.slice(1, -1).trim();
    const values = body
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean);
    return { kind: "ENUM", values: new Set(values) };
  }

  return { kind: "OTHER", name: tok };
}

function parseAttrDefault(firstTok: string, toks: string[], idxAfterFirst: number): { defaultDecl: DtdAttrDefault; consumedExtra: number } {
  if (firstTok === "#REQUIRED") return { defaultDecl: { kind: "#REQUIRED" }, consumedExtra: 0 };
  if (firstTok === "#IMPLIED") return { defaultDecl: { kind: "#IMPLIED" }, consumedExtra: 0 };

  if (firstTok === "#FIXED") {
    const v = toks[idxAfterFirst];
    if (!v) throw new Error("Expected value after #FIXED");
    return { defaultDecl: { kind: "#FIXED", value: unquote(v) }, consumedExtra: 1 };
  }

  // Otherwise it's a default literal (usually quoted).
  return { defaultDecl: { kind: "DEFAULT", value: unquote(firstTok) }, consumedExtra: 0 };
}

function tokenizeDtdRhs(s: string): string[] {
  // Tokens:
  // - quoted strings: "aswritten"
  // - parenthesized groups: (a|b|c) OR (caps+|default-property*)
  // - bare tokens: CDATA, #REQUIRED, name, etc.
  const tokens: string[] = [];
  let i = 0;

  const isWs = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";

  while (i < s.length) {
    while (i < s.length && isWs(s[i])) i++;
    if (i >= s.length) break;

    const ch = s[i];

    // quoted string
    if (ch === `"` || ch === `'`) {
      const q = ch;
      i++;
      let val = "";
      while (i < s.length && s[i] !== q) val += s[i++];
      if (i >= s.length) throw new Error("Unterminated string in DTD");
      i++; // closing quote
      tokens.push(`${q}${val}${q}`);
      continue;
    }

    // parenthesized group (balanced)
    if (ch === "(") {
      let depth = 0;
      let val = "";
      while (i < s.length) {
        const c = s[i++];
        val += c;
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new Error("Unbalanced parentheses in DTD");
      tokens.push(val);
      continue;
    }

    // bare token
    let val = "";
    while (i < s.length && !isWs(s[i])) val += s[i++];
    if (val) tokens.push(val);
  }

  return tokens;
}

function unquote(s: string): string {
  if ((s.startsWith(`"`) && s.endsWith(`"`)) || (s.startsWith(`'`) && s.endsWith(`'`))) {
    return s.slice(1, -1);
  }
  return s;
}

// -------------------------
// Content model parser (ELEMENT)
// -------------------------

class DtdModelParser {
  private i = 0;
  constructor(private s: string) {}

  parse(): DtdContentModel {
    const node = this.parseExpr();
    this.skipWs();
    if (this.i !== this.s.length) {
      throw new Error(`Trailing content-model input at ${this.i}: "${this.s.slice(this.i)}"`);
    }
    return node;
  }

  // expr := term (('|'|',') term)*
  // DTD does not allow mixing '|' and ',' at the same paren nesting level without extra parentheses.
  private parseExpr(): DtdContentModel {
    let left = this.parseTerm();
    this.skipWs();

    const items: DtdContentModel[] = [left];
    let mode: "CHOICE" | "SEQ" | null = null;

    while (true) {
      this.skipWs();
      const op = this.peek();
      if (op !== "|" && op !== ",") break;

      const nextMode = op === "|" ? "CHOICE" : "SEQ";
      if (mode && mode !== nextMode) {
        throw new Error(`Mixed '|' and ',' without parentheses near index ${this.i}`);
      }
      mode = nextMode;

      this.i++; // consume op
      const right = this.parseTerm();
      items.push(right);
    }

    if (!mode) return left;
    return mode === "CHOICE"
      ? { kind: "CHOICE", items, occurs: "1" }
      : { kind: "SEQ", items, occurs: "1" };
  }

  // term := atom quantifier?
  private parseTerm(): DtdContentModel {
    this.skipWs();
    let node = this.parseAtom();
    this.skipWs();

    const q = this.peek();
    if (q === "?" || q === "*" || q === "+") {
      this.i++;
      node = { ...node, occurs: q } as DtdContentModel;
    }
    return node;
  }

  // atom := NAME | '(' expr ')' | '(#PCDATA)' | '(#PCDATA|a|b)*'
  private parseAtom(): DtdContentModel {
    this.skipWs();

    if (this.peek() === "(") {
      this.i++; // '('
      this.skipWs();

      // Mixed / PCDATA:
      //   (#PCDATA)                  -> PCDATA
      //   (#PCDATA|a|b|c)            -> CHOICE(PCDATA,a,b,c)
      // The quantifier (* ? +) is applied outside the ')', by parseTerm().
      if (this.s.slice(this.i, this.i + 7) === "#PCDATA") {
        this.i += 7;
        this.skipWs();

        // plain (#PCDATA)
        if (this.peek() === ")") {
          this.i++;
          return { kind: "PCDATA", occurs: "1" };
        }

        // mixed (#PCDATA|a|b|c)
        const items: DtdContentModel[] = [{ kind: "PCDATA", occurs: "1" }];
        while (true) {
          this.skipWs();
          if (this.peek() !== "|") break;
          this.i++; // '|'
          const nm = this.readName();
          if (!nm) throw new Error(`Expected NAME in mixed model at index ${this.i}`);
          items.push({ kind: "NAME", name: nm, occurs: "1" });
        }
        this.skipWs();
        this.expect(")");
        return { kind: "CHOICE", items, occurs: "1" };
      }

      const inner = this.parseExpr();
      this.skipWs();
      this.expect(")");
      return inner;
    }

    const name = this.readName();
    if (!name) throw new Error(`Expected NAME at index ${this.i}`);
    return { kind: "NAME", name, occurs: "1" };
  }

  private readName(): string {
    this.skipWs();
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (/\s/.test(c) || c === "(" || c === ")" || c === "|" || c === "," || c === "?" || c === "*" || c === "+") break;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  private skipWs() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private peek(): string | undefined {
    return this.s[this.i];
  }

  private expect(ch: string) {
    if (this.s[this.i] !== ch) throw new Error(`Expected '${ch}' at ${this.i}`);
    this.i++;
  }
}
