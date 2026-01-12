// dtd_validator.ts
// Strictly validate a xast AST against a DTD index (ELEMENT + ATTLIST).
import type { Element as XEl, Node } from "xast";
import { localName } from "./xast_xml.ts";
import type { DtdIndex, DtdElement, DtdContentModel, DtdAttributeDecl } from "./dtd_index.ts";

const IGNORE_ATTR_PREFIX = ["xmlns", "xml:", "xsi:"];

type ValidationError = { path: string; msg: string };

export function validateAgainstDtd(root: XEl, expectedRoot: string, dtd: DtdIndex): void {
  const errors: ValidationError[] = [];
  walk(root, "", expectedRoot, dtd, errors);
  if (errors.length) {
    const msg = errors.map((e) => `- ${e.path}: ${e.msg}`).join("\n");
    throw new Error(`DTD validation failed:\n${msg}`);
  }
}

function walk(el: XEl, path: string, expectedRoot: string, dtd: DtdIndex, errors: ValidationError[]) {
  const name = localName(el.name);
  const here = path ? `${path}/${name}` : `/${name}`;

  if (!path && name !== expectedRoot) {
    errors.push({ path: here, msg: `Root must be <${expectedRoot}>` });
  }

  const def = dtd.elements.get(name);
  if (!def) {
    errors.push({ path: here, msg: `Element <${name}> not declared in DTD` });
    // still walk children to surface more errors
  } else {
    validateAttrs(el, def, here, errors);
    validateChildren(el, def, here, errors);
  }

  for (const k of childElements(el)) {
    walk(k, here, expectedRoot, dtd, errors);
  }
}

function validateAttrs(el: XEl, def: DtdElement, here: string, errors: ValidationError[]) {
  const attrsObj = el.attributes ?? {};
  const attrNames = Object.keys(attrsObj);

  for (const a of attrNames) {
    if (IGNORE_ATTR_PREFIX.some((p) => a.startsWith(p))) continue;

    const decl = def.attrs.get(a);
    if (!decl) {
      errors.push({ path: here, msg: `Unknown attribute "${a}" on <${def.name}>` });
      continue;
    }
    validateAttrValue(decl, String(attrsObj[a]), here, errors);
  }

  for (const req of def.requiredAttrs) {
    if (!(req in attrsObj)) {
      errors.push({ path: here, msg: `Missing required attribute "${req}" on <${def.name}>` });
    }
  }
}

function validateAttrValue(decl: DtdAttributeDecl, value: string, here: string, errors: ValidationError[]) {
  if (decl.type.kind === "ENUM") {
    if (!decl.type.values.has(value)) {
      errors.push({
        path: here,
        msg: `Attribute "${decl.name}" must be one of (${Array.from(decl.type.values).join("|")}), got "${value}"`,
      });
    }
  }
  if (decl.defaultDecl.kind === "#FIXED" && value !== decl.defaultDecl.value) {
    errors.push({
      path: here,
      msg: `Attribute "${decl.name}" is #FIXED to "${decl.defaultDecl.value}", got "${value}"`,
    });
  }
}

function validateChildren(el: XEl, def: DtdElement, here: string, errors: ValidationError[]) {
  const kids = childElements(el);
  const kidNames = kids.map((k) => localName(k.name));

  const nonWsText = nonWhitespaceText(el);

  if (def.content === "EMPTY") {
    if (kidNames.length) errors.push({ path: here, msg: `<${def.name}> must be EMPTY (no child elements)` });
    if (nonWsText) errors.push({ path: here, msg: `<${def.name}> must be EMPTY (no character data)` });
    return;
  }

  if (def.content === "ANY") {
    // ANY allows any declared elements and any character data.
    return;
  }

  const model = def.content;

  // PCDATA-only: no element children allowed, but text is allowed.
  if (isPcdataOnly(model)) {
    if (kidNames.length) errors.push({ path: here, msg: `<${def.name}> allows only #PCDATA (no child elements)` });
    return;
  }

  // Mixed content like (#PCDATA|a|b)* : allow any order/any count of declared non-PCDATA names, and allow text.
  const mixed = getMixedAllowedNames(model);
  if (mixed) {
    for (const childName of kidNames) {
      if (!mixed.has(childName)) {
        errors.push({ path: `${here}/${childName}`, msg: `Child <${childName}> not allowed in mixed content of <${def.name}>` });
      }
    }
    return;
  }

  // Element-only model: no non-whitespace character data.
  if (nonWsText) {
    errors.push({ path: here, msg: `<${def.name}> does not allow character data` });
  }

  const ok = matchesDtdModel(model, kidNames);
  if (!ok) {
    errors.push({
      path: here,
      msg: `Child elements do not match DTD content model: expected ${formatDtdModel(model)}, got (${kidNames.join(", ")})`,
    });
  }
}

// -------------------------
// Helpers: children/text extraction
// -------------------------

function childElements(el: XEl): XEl[] {
  return (el.children?.filter((c: Node) => c.type === "element") as XEl[]) ?? [];
}

function nonWhitespaceText(el: XEl): string | null {
  const texts = (el.children?.filter((c: Node) => c.type === "text") as Array<{ type: "text"; value: string }>) ?? [];
  for (const t of texts) {
    if ((t.value ?? "").trim() !== "") return t.value;
  }
  return null;
}

// -------------------------
// Content model matching
// -------------------------

function isPcdataOnly(m: DtdContentModel): boolean {
  return m.kind === "PCDATA";
}

function getMixedAllowedNames(m: DtdContentModel): Set<string> | null {
  // Detect classic mixed model: (#PCDATA|a|b|c)*
  if (m.kind !== "CHOICE") return null;
  if (m.occurs !== "*") return null;

  let hasPcdata = false;
  const names = new Set<string>();

  for (const it of m.items) {
    if (it.kind === "PCDATA" && it.occurs === "1") hasPcdata = true;
    else if (it.kind === "NAME" && it.occurs === "1") names.add(it.name);
    else return null; // not the simple mixed pattern
  }
  return hasPcdata ? names : null;
}

function matchesDtdModel(model: DtdContentModel, children: string[]): boolean {
  const memo = new Map<string, number[]>();
  const ends = match(model, children, 0, memo);
  return ends.includes(children.length);
}

function match(node: DtdContentModel, children: string[], pos: number, memo: Map<string, number[]>): number[] {
  const key = `${idOf(node)}@${pos}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const { min, max } = occursToRange(node.occurs);

  // One occurrence matcher ignores node.occurs.
  const onceEnds = (p: number) => matchOnce(node, children, p, memo);

  let current = new Set<number>([pos]);

  // required occurrences
  for (let i = 0; i < min; i++) {
    const next = new Set<number>();
    for (const p of current) for (const e of onceEnds(p)) next.add(e);
    current = next;
    if (current.size === 0) {
      memo.set(key, []);
      return [];
    }
  }

  const results = new Set<number>(current);

  // optional extra occurrences
  const maxExtra = max === "unbounded" ? (children.length - pos) : (max - min);
  let prev = current;
  for (let i = 0; i < maxExtra; i++) {
    const next = new Set<number>();
    for (const p of prev) for (const e of onceEnds(p)) next.add(e);

    // prevent infinite loops on zero-width matches
    const progressed = Array.from(next).some((e) => !prev.has(e));
    for (const e of next) results.add(e);
    if (next.size === 0 || !progressed) break;

    prev = next;
  }

  const out = Array.from(results).sort((a, b) => a - b);
  memo.set(key, out);
  return out;
}

function matchOnce(node: DtdContentModel, children: string[], pos: number, memo: Map<string, number[]>): number[] {
  switch (node.kind) {
    case "NAME":
      return (pos < children.length && children[pos] === node.name) ? [pos + 1] : [];
    case "PCDATA":
      // PCDATA in element-only matching: consumes no child elements.
      return [pos];
    case "SEQ": {
      let positions = new Set<number>([pos]);
      for (const it of node.items) {
        const next = new Set<number>();
        for (const p of positions) for (const e of match(it, children, p, memo)) next.add(e);
        positions = next;
        if (positions.size === 0) break;
      }
      return Array.from(positions);
    }
    case "CHOICE": {
      const out = new Set<number>();
      for (const it of node.items) for (const e of match(it, children, pos, memo)) out.add(e);
      return Array.from(out);
    }
  }
}

function occursToRange(o: string): { min: number; max: number | "unbounded" } {
  switch (o) {
    case "?": return { min: 0, max: 1 };
    case "*": return { min: 0, max: "unbounded" };
    case "+": return { min: 1, max: "unbounded" };
    case "1":
    default: return { min: 1, max: 1 };
  }
}

// Give each node a stable id for memoization.
const _id = new WeakMap<object, number>();
let _nextId = 1;
function idOf(o: object): number {
  const got = _id.get(o);
  if (got) return got;
  const n = _nextId++;
  _id.set(o, n);
  return n;
}

// -------------------------
// Formatting
// -------------------------

function formatDtdModel(m: DtdContentModel): string {
  const core = (() => {
    switch (m.kind) {
      case "NAME": return m.name;
      case "PCDATA": return "(#PCDATA)";
      case "SEQ": return `(${m.items.map(formatDtdModel).join(",")})`;
      case "CHOICE": return `(${m.items.map(formatDtdModel).join("|")})`;
    }
  })();

  return applyOccurs(core, m.occurs);
}

function applyOccurs(s: string, o: string): string {
  if (o === "1") return s;
  return `${s}${o}`;
}
