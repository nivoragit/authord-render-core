// xsd_index.ts
// Build a strict-enough in-memory index from XSD for Writerside-style schemas.
// Supports: global elements, complexType (named & inline), sequence/choice/all/group, min/maxOccurs,
// attributes (global/ref), attributeGroup, enumerations, fixed values, and anyAttribute.
//
// Notes:
// - This is NOT a full XSD 1.0 validator, but it enforces element order and cardinality, and common attribute constraints.
// - It ignores namespaces for matching element names (uses localName()).

import type { Root, Element as XEl, Node } from "xast";
import { parseXmlToXast, localName } from "./xast_xml.ts";

export type AttrUse = "required" | "optional";
export type MaxOccurs = number | "unbounded";
export type Occurs = { min: number; max: MaxOccurs };

export type XsdAttrDef = {
  use: AttrUse;
  enum?: ReadonlySet<string>;
  fixed?: string;
};

export type XsdParticle =
  | { kind: "empty"; occurs: Occurs }
  | { kind: "element"; name: string; occurs: Occurs }
  | { kind: "sequence"; items: XsdParticle[]; occurs: Occurs }
  | { kind: "choice"; items: XsdParticle[]; occurs: Occurs }
  | { kind: "all"; items: XsdParticle[]; occurs: Occurs }
  | { kind: "groupRef"; ref: string; occurs: Occurs }
  | { kind: "any"; occurs: Occurs };

export type XsdComplexTypeDef = {
  content: XsdParticle;
  attributes: Map<string, XsdAttrDef>;
  mixed: boolean;
  allowAnyAttribute: boolean;
};

export type XsdElementDef = {
  name: string;
  content: XsdParticle;
  attributes: Map<string, XsdAttrDef>;
  mixed: boolean;
  allowAnyAttribute: boolean;

  /** Derived: child element names reachable (ignores order/occurs). */
  allowedChildren: Set<string> | "ANY" | "EMPTY";
};

export type XsdIndex = {
  elements: Map<string, XsdElementDef>;
  complexTypes: Map<string, XsdComplexTypeDef>;
  groups: Map<string, XsdParticle>;
  attributeGroups: Map<string, Map<string, XsdAttrDef>>;
  attributes: Map<string, XsdAttrDef>; // global attributes
  substitutionGroups: Map<string, Set<string>>; // head -> members
  substitutionGroupFor: Map<string, string>; // member -> head
};

function isEl(n: Node, ln?: string): n is XEl {
  return n.type === "element" && (!ln || localName((n as XEl).name) === ln);
}
function attr(e: XEl, k: string) {
  return e.attributes?.[k] as string | undefined;
}

function occursFromEl(e: XEl): Occurs {
  const min = parseInt(attr(e, "minOccurs") ?? "1", 10);
  const rawMax = attr(e, "maxOccurs") ?? "1";
  const max: MaxOccurs = rawMax === "unbounded" ? "unbounded" : parseInt(rawMax, 10);
  return { min: Number.isFinite(min) ? min : 1, max: (max === "unbounded" || Number.isFinite(max)) ? max : 1 };
}

function emptyParticle(): XsdParticle {
  return { kind: "empty", occurs: { min: 1, max: 1 } };
}

export function buildXsdIndex(xsdText: string): XsdIndex {
  const ast = parseXmlToXast(xsdText) as Root;
  const schema = ast.children.find((n) => isEl(n, "schema")) as XEl | undefined;
  if (!schema) throw new Error("XSD: missing <schema> root element");

  // ---- collect globals ----
  const globalElements = new Map<string, XEl>();
  const complexTypeEls = new Map<string, XEl>();
  const groupEls = new Map<string, XEl>();
  const attributeGroupEls = new Map<string, XEl>();
  const globalAttrEls = new Map<string, XEl>();
  const substitutionGroups = new Map<string, Set<string>>();
  const substitutionGroupFor = new Map<string, string>();

  for (const n of schema.children) {
    if (!isEl(n)) continue;
    const ln = localName(n.name);
    if (ln === "element") {
      const nm = attr(n, "name");
      if (nm) {
        globalElements.set(nm, n);
        const sg = attr(n, "substitutionGroup");
        if (sg) {
          const head = localName(sg);
          if (head) {
            substitutionGroupFor.set(nm, head);
            const members = substitutionGroups.get(head) ?? new Set<string>();
            members.add(nm);
            substitutionGroups.set(head, members);
          }
        }
      }
    } else if (ln === "complexType") {
      const nm = attr(n, "name");
      if (nm) complexTypeEls.set(nm, n);
    } else if (ln === "group") {
      const nm = attr(n, "name");
      if (nm) groupEls.set(nm, n);
    } else if (ln === "attributeGroup") {
      const nm = attr(n, "name");
      if (nm) attributeGroupEls.set(nm, n);
    } else if (ln === "attribute") {
      const nm = attr(n, "name");
      if (nm) globalAttrEls.set(nm, n);
    }
  }

  // ---- global attributes ----
  const attributes = new Map<string, XsdAttrDef>();
  for (const [nm, el] of globalAttrEls) {
    attributes.set(nm, parseAttributeDef(el, attributes));
  }

  // ---- attribute groups (lazy resolve, handles nesting) ----
  const attributeGroups = new Map<string, Map<string, XsdAttrDef>>();
  function resolveAttrGroup(name: string, seen = new Set<string>()): Map<string, XsdAttrDef> {
    if (attributeGroups.has(name)) return attributeGroups.get(name)!;
    if (seen.has(name)) return new Map(); // defensive
    seen.add(name);

    const host = attributeGroupEls.get(name);
    const out = new Map<string, XsdAttrDef>();
    if (host) {
      for (const c of host.children) {
        if (!isEl(c)) continue;
        const ln = localName(c.name);
        if (ln === "attribute") {
          const def = parseAttributeDef(c, attributes);
          const nm = attr(c, "name") ?? localName(attr(c, "ref") ?? "");
          if (nm) out.set(nm, def);
        } else if (ln === "attributeGroup") {
          const ref = localName(attr(c, "ref") ?? "");
          if (ref) {
            for (const [k, v] of resolveAttrGroup(ref, new Set(seen))) out.set(k, v);
          }
        }
      }
    }
    attributeGroups.set(name, out);
    return out;
  }
  for (const name of attributeGroupEls.keys()) resolveAttrGroup(name);

  // ---- groups (content model) ----
  const groups = new Map<string, XsdParticle>();
  function resolveGroup(name: string, seen = new Set<string>()): XsdParticle {
    if (groups.has(name)) return groups.get(name)!;
    if (seen.has(name)) return emptyParticle(); // defensive cycle break
    seen.add(name);

    const host = groupEls.get(name);
    if (!host) return emptyParticle();

    // group body is usually a sequence/choice/all
    const body = findFirstParticleChild(host);
    const parsed = body ? parseParticle(body) : emptyParticle();
    groups.set(name, parsed);
    return parsed;
  }
  for (const name of groupEls.keys()) resolveGroup(name);

  // ---- complex types ----
  const complexTypes = new Map<string, XsdComplexTypeDef>();

  function resolveComplexType(name: string, seen = new Set<string>()): XsdComplexTypeDef {
    if (complexTypes.has(name)) return complexTypes.get(name)!;
    if (seen.has(name)) return { content: emptyParticle(), attributes: new Map(), mixed: false, allowAnyAttribute: false };
    seen.add(name);

    const host = complexTypeEls.get(name);
    if (!host) return { content: emptyParticle(), attributes: new Map(), mixed: false, allowAnyAttribute: false };

    const def = parseComplexType(host, { resolveComplexType, resolveAttrGroup, attributes });
    complexTypes.set(name, def);
    return def;
  }

  for (const name of complexTypeEls.keys()) resolveComplexType(name);

  // ---- elements ----
  const elements = new Map<string, XsdElementDef>();

  function resolveElementDefByName(name: string, seen = new Set<string>()): XsdElementDef {
    if (elements.has(name)) return elements.get(name)!;
    if (seen.has(name)) {
      const def: XsdElementDef = {
        name,
        content: emptyParticle(),
        attributes: new Map(),
        mixed: false,
        allowAnyAttribute: false,
        allowedChildren: "EMPTY",
      };
      elements.set(name, def);
      return def;
    }
    seen.add(name);

    const el = globalElements.get(name);
    if (!el) {
      const def: XsdElementDef = {
        name,
        content: emptyParticle(),
        attributes: new Map(),
        mixed: false,
        allowAnyAttribute: false,
        allowedChildren: "EMPTY",
      };
      elements.set(name, def);
      return def;
    }

    const def = parseElementDef(el, { resolveComplexType, resolveElementDefByName, resolveAttrGroup, attributes, resolveGroup });
    elements.set(name, def);
    return def;
  }

  for (const name of globalElements.keys()) resolveElementDefByName(name);

  const index: XsdIndex = {
    elements,
    complexTypes,
    groups,
    attributeGroups,
    attributes,
    substitutionGroups,
    substitutionGroupFor,
  };
  applyCompatibilityOverrides(index);
  return index;
}

// -------------------------
// Parsing: elements/types/particles
// -------------------------

function applyCompatibilityOverrides(index: XsdIndex): void {
  applyWritersideCfgCompat(index);
  applyWritersideTopicCompat(index);
  expandAllowedChildrenForSubstitutions(index);
}

function applyWritersideCfgCompat(index: XsdIndex): void {
  const ihp = index.elements.get("ihp");
  if (!ihp) return;

  // Writerside configs often omit api-specifications; relax it to be optional.
  relaxElementMinOccurs(ihp.content, index.groups, new Set(["api-specifications"]));
}

function applyWritersideTopicCompat(index: XsdIndex): void {
  const topic = index.elements.get("topic");
  if (!topic) return;

  // Writerside topic.v2.xsd requires include-in-head, but many projects omit it.
  relaxElementMinOccurs(topic.content, index.groups, new Set(["include-in-head"]));

  // Inline elements in Writerside schemas often allow text even when not marked mixed.
  const inlineGroup = index.groups.get("InlineElements");
  if (inlineGroup) {
    const inlineNames = collectElementNamesFromParticle(inlineGroup, index.groups);
    for (const name of inlineNames) {
      const def = index.elements.get(name);
      if (def && !def.mixed) def.mixed = true;
    }
  }

  // Section groups allow spotlight without a title in real-world content.
  const sectionGroup = index.elements.get("SectionGroupElementBase");
  if (sectionGroup) {
    relaxElementMinOccurs(sectionGroup.content, index.groups, new Set(["title"]));
  }

  // Snippets are often used for section-starting-page fragments like <spotlight>.
  const snippet = index.elements.get("snippet");
  if (snippet && snippet.allowedChildren !== "ANY" && snippet.allowedChildren !== "EMPTY") {
    snippet.allowedChildren.add("spotlight");
  }
}

function relaxElementMinOccurs(
  p: XsdParticle,
  groups: Map<string, XsdParticle>,
  names: Set<string>,
  seenGroups = new Set<string>(),
): void {
  switch (p.kind) {
    case "element":
      if (names.has(p.name) && p.occurs.min > 0) {
        p.occurs = { min: 0, max: p.occurs.max };
      }
      return;
    case "sequence":
    case "choice":
    case "all":
      for (const it of p.items) relaxElementMinOccurs(it, groups, names, seenGroups);
      return;
    case "groupRef": {
      if (seenGroups.has(p.ref)) return;
      const nextSeen = new Set(seenGroups);
      nextSeen.add(p.ref);
      const g = groups.get(p.ref);
      if (g) relaxElementMinOccurs(g, groups, names, nextSeen);
      return;
    }
    case "empty":
    case "any":
      return;
  }
}

function expandAllowedChildrenForSubstitutions(index: XsdIndex): void {
  if (index.substitutionGroups.size === 0) return;
  for (const def of index.elements.values()) {
    if (def.allowedChildren === "ANY" || def.allowedChildren === "EMPTY") continue;
    const extra = new Set<string>();
    for (const name of def.allowedChildren) {
      const subs = index.substitutionGroups.get(name);
      if (!subs) continue;
      for (const sub of subs) extra.add(sub);
    }
    if (extra.size === 0) continue;
    for (const sub of extra) def.allowedChildren.add(sub);
  }
}

function collectElementNamesFromParticle(
  p: XsdParticle,
  groups: Map<string, XsdParticle>,
  names = new Set<string>(),
  seenGroups = new Set<string>(),
): Set<string> {
  switch (p.kind) {
    case "element":
      names.add(p.name);
      return names;
    case "sequence":
    case "choice":
    case "all":
      for (const it of p.items) collectElementNamesFromParticle(it, groups, names, seenGroups);
      return names;
    case "groupRef": {
      if (seenGroups.has(p.ref)) return names;
      const nextSeen = new Set(seenGroups);
      nextSeen.add(p.ref);
      const g = groups.get(p.ref);
      if (g) collectElementNamesFromParticle(g, groups, names, nextSeen);
      return names;
    }
    case "empty":
    case "any":
      return names;
  }
}

function parseElementDef(el: XEl, ctx: {
  resolveComplexType: (name: string, seen?: Set<string>) => XsdComplexTypeDef;
  resolveElementDefByName: (name: string, seen?: Set<string>) => XsdElementDef;
  resolveAttrGroup: (name: string, seen?: Set<string>) => Map<string, XsdAttrDef>;
  attributes: Map<string, XsdAttrDef>;
  resolveGroup: (name: string, seen?: Set<string>) => XsdParticle;
}): XsdElementDef {
  const name = attr(el, "name");
  const ref = attr(el, "ref");
  if (!name && ref) {
    const rn = localName(ref);
    // for a ref, validate as that global element
    return ctx.resolveElementDefByName(rn);
  }
  if (!name) {
    // anonymous element (shouldn't happen for top-level), fallback
    return {
      name: "(anonymous)",
      content: emptyParticle(),
      attributes: new Map(),
      mixed: false,
      allowAnyAttribute: false,
      allowedChildren: "EMPTY",
    };
  }

  // inline complexType?
  const inlineCt = el.children.find((n) => isEl(n, "complexType")) as XEl | undefined;
  let ct: XsdComplexTypeDef | null = null;

  if (inlineCt) {
    ct = parseComplexType(inlineCt, ctx);
  } else {
    const typeName = attr(el, "type");
    if (typeName) ct = ctx.resolveComplexType(localName(typeName));
  }

  const content = ct?.content ?? emptyParticle();
  const attributes = ct?.attributes ?? new Map();
  const mixed = ct?.mixed ?? false;
  const allowAnyAttribute = ct?.allowAnyAttribute ?? false;

  const allowedChildren = deriveAllowedChildrenFromParticle(content, ctx.resolveGroup);
  return { name, content, attributes, mixed, allowAnyAttribute, allowedChildren };
}

function parseComplexType(ctEl: XEl, ctx: {
  resolveComplexType: (name: string, seen?: Set<string>) => XsdComplexTypeDef;
  resolveAttrGroup: (name: string, seen?: Set<string>) => Map<string, XsdAttrDef>;
  attributes: Map<string, XsdAttrDef>;
  resolveGroup?: (name: string, seen?: Set<string>) => XsdParticle;
}): XsdComplexTypeDef {
  const mixedAttr = (attr(ctEl, "mixed") ?? "").toLowerCase();
  const mixed = mixedAttr === "true" || mixedAttr === "1";

  // Simple content: no child elements.
  const hasSimpleContent = ctEl.children.some((n) => isEl(n, "simpleContent"));
  if (hasSimpleContent) {
    const { attrs, allowAnyAttribute } = collectAttrs(ctEl, ctx);
    return { content: emptyParticle(), attributes: attrs, mixed: true, allowAnyAttribute };
  }

  // complexContent extension?
  const complexContent = ctEl.children.find((n) => isEl(n, "complexContent")) as XEl | undefined;
  if (complexContent) {
    const ext = complexContent.children.find((n) => isEl(n, "extension")) as XEl | undefined;
    if (ext) {
      const baseName = localName(attr(ext, "base") ?? "");
      const base = baseName ? ctx.resolveComplexType(baseName) : { content: emptyParticle(), attributes: new Map(), mixed: false, allowAnyAttribute: false };

      const extParticleHost = findFirstParticleChild(ext);
      const extParticle = extParticleHost ? parseParticle(extParticleHost) : emptyParticle();

      const content = mergeExtensionContent(base.content, extParticle);

      const { attrs: extAttrs, allowAnyAttribute: extAnyAttr } = collectAttrs(ext, ctx);
      const mergedAttrs = new Map<string, XsdAttrDef>(base.attributes);
      for (const [k, v] of extAttrs) mergedAttrs.set(k, v);

      return {
        content,
        attributes: mergedAttrs,
        mixed: mixed || base.mixed,
        allowAnyAttribute: base.allowAnyAttribute || extAnyAttr,
      };
    }
  }

  // regular complexType with direct particle
  const host = findFirstParticleChild(ctEl);
  const content = host ? parseParticle(host) : emptyParticle();
  const { attrs, allowAnyAttribute } = collectAttrs(ctEl, ctx);
  return { content, attributes: attrs, mixed, allowAnyAttribute };
}

function mergeExtensionContent(base: XsdParticle, extra: XsdParticle): XsdParticle {
  const bEmpty = base.kind === "empty" && base.occurs.min === 1 && base.occurs.max === 1;
  const eEmpty = extra.kind === "empty" && extra.occurs.min === 1 && extra.occurs.max === 1;
  if (bEmpty) return extra;
  if (eEmpty) return base;
  return { kind: "sequence", items: [base, extra], occurs: { min: 1, max: 1 } };
}

function findFirstParticleChild(host: XEl): XEl | null {
  // Find the first particle-ish child: sequence/choice/all/group/element/any
  for (const c of host.children) {
    if (!isEl(c)) continue;
    const ln = localName(c.name);
    if (ln === "sequence" || ln === "choice" || ln === "all" || ln === "group" || ln === "element" || ln === "any") return c;
    // wrappers can contain particles too (e.g., complexContent/extension)
    const nested = findFirstParticleChild(c);
    if (nested) return nested;
  }
  return null;
}

function parseParticle(el: XEl): XsdParticle {
  const ln = localName(el.name);
  const occurs = occursFromEl(el);

  if (ln === "sequence") {
    const items = el.children
      .filter((n) => isEl(n))
      .map((c) => parseParticle(c as XEl))
      .filter((p) => p.kind !== "empty" || (p.occurs.min !== 1 || p.occurs.max !== 1));
    return { kind: "sequence", items, occurs };
  }

  if (ln === "choice") {
    const items = el.children
      .filter((n) => isEl(n))
      .map((c) => parseParticle(c as XEl))
      .filter((p) => p.kind !== "empty" || (p.occurs.min !== 1 || p.occurs.max !== 1));
    return { kind: "choice", items, occurs };
  }

  if (ln === "all") {
    const items = el.children
      .filter((n) => isEl(n))
      .map((c) => parseParticle(c as XEl))
      .filter((p) => p.kind !== "empty" || (p.occurs.min !== 1 || p.occurs.max !== 1));
    return { kind: "all", items, occurs };
  }

  if (ln === "group") {
    const ref = localName(attr(el, "ref") ?? "");
    if (ref) return { kind: "groupRef", ref, occurs };
    // named group definition: parse its body
    const body = findFirstParticleChild(el);
    const p = body ? parseParticle(body) : emptyParticle();
    // Apply group element's own occurs to the parsed content by wrapping it in a sequence particle with occurs.
    return { kind: "sequence", items: [p], occurs };
  }

  if (ln === "element") {
    const nm = localName(attr(el, "ref") ?? attr(el, "name") ?? "");
    if (!nm) return { kind: "empty", occurs };
    return { kind: "element", name: nm, occurs };
  }

  if (ln === "any") {
    return { kind: "any", occurs };
  }

  // Ignore non-particle nodes (annotation, attribute, etc.)
  return { kind: "empty", occurs: { min: 1, max: 1 } };
}

// -------------------------
// Attributes
// -------------------------

function collectAttrs(host: XEl, ctx: { resolveAttrGroup: (name: string, seen?: Set<string>) => Map<string, XsdAttrDef>; attributes: Map<string, XsdAttrDef> }): { attrs: Map<string, XsdAttrDef>; allowAnyAttribute: boolean } {
  const attrs = new Map<string, XsdAttrDef>();
  let allowAnyAttribute = false;

  const walk = (el: XEl) => {
    for (const c of el.children) {
      if (!isEl(c)) continue;
      const ln = localName(c.name);
      if (ln === "attribute") {
        const nm = attr(c, "name") ?? localName(attr(c, "ref") ?? "");
        if (nm) attrs.set(nm, parseAttributeDef(c, ctx.attributes));
      } else if (ln === "attributeGroup") {
        const ref = localName(attr(c, "ref") ?? "");
        if (ref) {
          for (const [k, v] of ctx.resolveAttrGroup(ref)) attrs.set(k, v);
        }
      } else if (ln === "anyAttribute") {
        allowAnyAttribute = true;
      } else {
        walk(c);
      }
    }
  };

  walk(host);
  return { attrs, allowAnyAttribute };
}

function parseAttributeDef(attrEl: XEl, globalAttributes: Map<string, XsdAttrDef>): XsdAttrDef {
  const use = ((attr(attrEl, "use") as AttrUse | undefined) ?? "optional") as AttrUse;
  const fixed = attr(attrEl, "fixed") ?? undefined;

  // enumeration restriction?
  const enumVals = extractAttributeEnum(attrEl);

  const ref = attr(attrEl, "ref");
  if (ref) {
    const baseName = localName(ref);
    const base = globalAttributes.get(baseName);
    // use from the referencing site can override; fixed/enum from base retained unless overridden
    return {
      use,
      fixed: fixed ?? base?.fixed,
      enum: enumVals ?? base?.enum,
    };
  }

  return { use, fixed, enum: enumVals ?? undefined };
}

function extractAttributeEnum(attrEl: XEl): ReadonlySet<string> | undefined {
  // xs:attribute -> xs:simpleType -> xs:restriction -> xs:enumeration@value
  const simpleType = attrEl.children.find((n) => isEl(n, "simpleType")) as XEl | undefined;
  const restriction = simpleType?.children.find((n) => isEl(n, "restriction")) as XEl | undefined;
  const enums = restriction?.children.filter((n) => isEl(n, "enumeration")) as XEl[] | undefined;
  if (!enums || enums.length === 0) return undefined;

  const values = enums
    .map((e) => attr(e, "value"))
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  return values.length ? new Set(values) : undefined;
}

// -------------------------
// Derived allowedChildren
// -------------------------

function deriveAllowedChildrenFromParticle(
  p: XsdParticle,
  resolveGroup: (name: string, seen?: Set<string>) => XsdParticle,
): Set<string> | "ANY" | "EMPTY" {
  // If schema uses xs:any anywhere, call it "ANY" to avoid false negatives.
  let hasAny = false;
  const names = new Set<string>();

  const walk = (n: XsdParticle, stack = new Set<string>()) => {
    switch (n.kind) {
      case "any":
        hasAny = true;
        return;
      case "element":
        names.add(n.name);
        return;
      case "groupRef": {
        const ref = n.ref;
        if (stack.has(ref)) return; // defensive cycle break
        stack.add(ref);
        const g = resolveGroup(ref, new Set(stack));
        walk(g, stack);
        return;
      }
      case "sequence":
      case "choice":
      case "all":
        for (const it of n.items) walk(it, stack);
        return;
      case "empty":
        return;
    }
  };

  walk(p);

  if (hasAny) return "ANY";
  if (names.size === 0) return "EMPTY";
  return names;
}
