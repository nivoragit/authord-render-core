// xsd_validator.ts
// Strictly validate xast AST against our XSD index (order + cardinality + common attribute constraints).
// todo check xsd index is used, what are matched?
import type { Element as XEl, Node } from "xast";
import { localName } from "./xast_xml.ts";
import type { XsdIndex, XsdElementDef, XsdParticle, Occurs } from "./xsd_index.ts";

const IGNORED_ATTR_PREFIXES = ["xmlns", "xml:", "xsi:"];
const COMPAT_ATTR_ALLOWLIST = new Map<string, Set<string>>([
  ["topics", new Set(["web-path"])],
  ["a", new Set(["type", "target"])],
]);
const RELAXED_CHILD_ORDER = new Set([
  "topic",
  "section-starting-page",
  "links",
  "snippet",
]);

function isCompatAttrAllowed(elName: string, attrName: string): boolean {
  return COMPAT_ATTR_ALLOWLIST.get(elName)?.has(attrName) ?? false;
}

type ValidationError = { path: string; msg: string };

export function validateAgainstXsd(root: XEl, expectedRoot: string, xsd: XsdIndex): void {
  const errors: ValidationError[] = [];
  walk(root, "", expectedRoot, xsd, errors);
  if (errors.length) {
    const msg = errors.map((e) => `- ${e.path}: ${e.msg}`).join("\n");
    throw new Error(`XSD validation failed:\n${msg}`);
  }
}

function walk(el: XEl, path: string, expectedRoot: string, xsd: XsdIndex, errors: ValidationError[]) {
  const name = localName(el.name);
  const here = path ? `${path}/${name}` : `/${name}`;

  if (!path && name !== expectedRoot) {
    errors.push({ path: here, msg: `Root must be <${expectedRoot}>` });
  }

  const def = resolveElementDef(name, xsd);
  if (!def) {
    errors.push({ path: here, msg: `Element <${name}> not declared in XSD` });
  } else {
    validateAttrs(el, name, def, here, errors);
    validateChildren(el, name, def, here, xsd, errors);
  }

  for (const k of childElements(el)) {
    walk(k, here, expectedRoot, xsd, errors);
  }
}

function validateAttrs(el: XEl, elementName: string, def: XsdElementDef, here: string, errors: ValidationError[]) {
  const attrsObj = el.attributes ?? {};
  const present = Object.keys(attrsObj).filter((a) => !IGNORED_ATTR_PREFIXES.some((p) => a.startsWith(p)));

  // unknown attributes
  if (!def.allowAnyAttribute) {
    for (const a of present) {
      if (!def.attributes.has(a) && !isCompatAttrAllowed(elementName, a)) {
        errors.push({ path: here, msg: `Unknown attribute "${a}" on <${elementName}>` });
      }
    }
  }

  // required attributes
  for (const [a, decl] of def.attributes) {
    if (decl.use === "required" && !(a in attrsObj)) {
      errors.push({ path: here, msg: `Missing required attribute "${a}" on <${elementName}>` });
    }
  }

  // enum/fixed checks
  for (const a of present) {
    const decl = def.attributes.get(a);
    if (!decl) continue; // unknown allowed only if allowAnyAttribute or compat

    const value = String(attrsObj[a]);

    if (decl.fixed !== undefined && value !== decl.fixed) {
      errors.push({ path: here, msg: `Attribute "${a}" is fixed to "${decl.fixed}", got "${value}"` });
    }
    if (decl.enum && !decl.enum.has(value)) {
      errors.push({ path: here, msg: `Attribute "${a}" must be one of (${Array.from(decl.enum).join("|")}), got "${value}"` });
    }
  }
}

function validateChildren(el: XEl, elementName: string, def: XsdElementDef, here: string, xsd: XsdIndex, errors: ValidationError[]) {
  const kids = childElements(el);
  const kidNames = kids.map((k) => localName(k.name));
  const compatKidNames = filterCompatChildren(kidNames);

  const nonWsText = nonWhitespaceText(el);
  if (nonWsText && !def.mixed) {
    errors.push({ path: here, msg: `<${elementName}> does not allow character data` });
  }

  const ok = matchesParticle(def.content, kidNames, xsd) ||
    (compatKidNames !== kidNames && matchesParticle(def.content, compatKidNames, xsd));
  if (ok) return;

  if (RELAXED_CHILD_ORDER.has(elementName) && childrenAllowedBySet(def.allowedChildren, compatKidNames)) {
    const counts = countChildren(compatKidNames);
    if (requiredChildrenSatisfied(def.content, counts, xsd)) {
      return;
    }
  }

  errors.push({
    path: here,
    msg: `Child elements do not match XSD model: expected ${formatParticle(def.content)}, got (${kidNames.join(", ")})`,
  });
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

function resolveElementDef(name: string, xsd: XsdIndex): XsdElementDef | undefined {
  const def = xsd.elements.get(name);
  if (!def) return undefined;
  const head = xsd.substitutionGroupFor.get(name);
  if (!head) return def;
  return xsd.elements.get(head) ?? def;
}

function matchesElementName(expected: string, actual: string, xsd: XsdIndex): boolean {
  if (expected === actual) return true;
  const subs = xsd.substitutionGroups.get(expected);
  return subs ? subs.has(actual) : false;
}

function childrenAllowedBySet(
  allowed: XsdElementDef["allowedChildren"],
  kidNames: string[],
): boolean {
  if (allowed === "ANY") return true;
  if (allowed === "EMPTY") return kidNames.length === 0;
  return kidNames.every((n) => allowed.has(n));
}

function filterCompatChildren(kidNames: string[]): string[] {
  const filtered = kidNames.filter((n) => n !== "include");
  return filtered.length === kidNames.length ? kidNames : filtered;
}

function countChildren(kidNames: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of kidNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function countForName(name: string, counts: Map<string, number>, xsd: XsdIndex): number {
  let total = counts.get(name) ?? 0;
  const subs = xsd.substitutionGroups.get(name);
  if (subs) {
    for (const s of subs) total += counts.get(s) ?? 0;
  }
  return total;
}

function requiredChildrenSatisfied(
  particle: XsdParticle,
  counts: Map<string, number>,
  xsd: XsdIndex,
): boolean {
  switch (particle.kind) {
    case "empty":
    case "any":
      return true;
    case "element": {
      const present = countForName(particle.name, counts, xsd);
      return present >= particle.occurs.min;
    }
    case "sequence":
    case "all": {
      if (particle.occurs.min === 0) return true;
      for (const item of particle.items) {
        if (!requiredChildrenSatisfied(item, counts, xsd)) return false;
      }
      return true;
    }
    case "choice": {
      if (particle.occurs.min === 0) return true;
      return particle.items.some((item) => requiredChildrenSatisfied(item, counts, xsd));
    }
    case "groupRef": {
      if (particle.occurs.min === 0) return true;
      const group = xsd.groups.get(particle.ref);
      if (!group) return true;
      return requiredChildrenSatisfied(group, counts, xsd);
    }
    default:
      return true;
  }
}

// -------------------------
// Particle matching (order + min/maxOccurs)
// -------------------------

function matchesParticle(p: XsdParticle, children: string[], xsd: XsdIndex): boolean {
  const memo = new Map<string, number[]>();
  const ends = match(p, children, 0, xsd, memo);
  return ends.includes(children.length);
}

function match(node: XsdParticle, children: string[], pos: number, xsd: XsdIndex, memo: Map<string, number[]>): number[] {
  const key = `${idOf(node)}@${pos}`;
  const cached = memo.get(key);
  if (cached) return cached;

  const { min, max } = node.occurs;
  const maxCount = max === "unbounded" ? (children.length - pos) : max;

  // one occurrence ignoring node.occurs
  const onceEnds = (p: number) => matchOnce(node, children, p, xsd, memo);

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

  // optional extra occurrences up to max
  let prev = current;
  for (let i = min; i < maxCount; i++) {
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

function matchOnce(node: XsdParticle, children: string[], pos: number, xsd: XsdIndex, memo: Map<string, number[]>): number[] {
  switch (node.kind) {
    case "empty":
      return [pos];

    case "element":
      return (pos < children.length && matchesElementName(node.name, children[pos], xsd)) ? [pos + 1] : [];

    case "any":
      return (pos < children.length) ? [pos + 1] : [];

    case "groupRef": {
      const grp = xsd.groups.get(node.ref);
      if (!grp) return []; // unknown group
      return match(grp, children, pos, xsd, memo);
    }

    case "sequence": {
      let positions = new Set<number>([pos]);
      for (const it of node.items) {
        const next = new Set<number>();
        for (const p of positions) for (const e of match(it, children, p, xsd, memo)) next.add(e);
        positions = next;
        if (positions.size === 0) break;
      }
      return Array.from(positions);
    }

    case "choice": {
      const out = new Set<number>();
      for (const it of node.items) for (const e of match(it, children, pos, xsd, memo)) out.add(e);
      return Array.from(out);
    }

    case "all": {
      // xs:all allows children in any order. Implement as "prefix length" matcher:
      // try consuming k children from pos and check if that prefix multiset satisfies all item constraints.
      const ends: number[] = [];
      for (let end = pos; end <= children.length; end++) {
        const prefix = children.slice(pos, end);
        if (allSatisfied(node.items, prefix)) ends.push(end);
      }
      return ends;
    }
  }
}

function allSatisfied(items: XsdParticle[], prefix: string[]): boolean {
  const counts = new Map<string, number>();
  for (const n of prefix) counts.set(n, (counts.get(n) ?? 0) + 1);

  const anyItems = items.filter((i) => i.kind === "any");
  if (anyItems.length === 0) {
    const allowed = new Set<string>();
    for (const it of items) {
      if (it.kind !== "element") return false;
      allowed.add(it.name);
    }
    for (const n of prefix) if (!allowed.has(n)) return false;
  }

  for (const it of items) {
    if (it.kind === "element") {
      const c = counts.get(it.name) ?? 0;
      const { min, max } = it.occurs;
      const maxN = max === "unbounded" ? Number.MAX_SAFE_INTEGER : max;
      if (c < min || c > maxN) return false;
    } else if (it.kind === "any") {
      continue;
    } else {
      return false;
    }
  }

  return true;
}

// -------------------------
// Formatting
// -------------------------

function formatParticle(p: XsdParticle): string {
  const core = (() => {
    switch (p.kind) {
      case "empty": return "∅";
      case "any": return "<any>";
      case "element": return `<${p.name}>`;
      case "groupRef": return `group(${p.ref})`;
      case "sequence": return `seq(${p.items.map(formatParticle).join(", ")})`;
      case "choice": return `choice(${p.items.map(formatParticle).join(" | ")})`;
      case "all": return `all(${p.items.map(formatParticle).join(", ")})`;
    }
  })();

  return `${core}${formatOccurs(p.occurs)}`;
}

function formatOccurs(o: Occurs): string {
  const max = o.max === "unbounded" ? "∞" : String(o.max);
  if (o.min === 1 && o.max === 1) return "";
  return `{${o.min}..${max}}`;
}

// Give each particle a stable id for memoization.
const _id = new WeakMap<object, number>();
let _nextId = 1;
function idOf(o: object): number {
  const got = _id.get(o);
  if (got) return got;
  const n = _nextId++;
  _id.set(o, n);
  return n;
}
