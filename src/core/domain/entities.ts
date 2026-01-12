// Domain entities & value objects for the "authord" project.
// Pure types with small factory helpers & guards. No external imports.

// todo remove page

/** Opaque brand for ExportHash */
declare const EXPORT_HASH_BRAND: unique symbol;

/**
 * ExportHash is an opaque string that captures the content/export state
 * of a publication. Treat it as an identity/value object, not a raw string.
 */
export type ExportHash = string & { readonly [EXPORT_HASH_BRAND]: "ExportHash" };

/** Type guard for ExportHash */
export function isExportHash(v: unknown): v is ExportHash {
  return typeof v === "string" && /^[a-f0-9]{8,}$/i.test(v);
}

/** Factory to brand a string as ExportHash (validates by regex). */
export function makeExportHash(value: string): ExportHash {
  if (!isExportHash(value)) {
    // Keep domain layer free of error-class imports; throw a plain Error.
    throw new Error(
      "Invalid ExportHash: must be a hex string with length >= 8 characters.",
    );
  }
  return value as ExportHash;
}

/** Attachment entity (immutable) */
export interface Attachment {
  readonly fileName: string; // logical name (e.g., "diagram.png")
  readonly path: string; // project-relative or absolute path to file
  readonly mediaType?: string; // e.g., "image/png"
  readonly sizeBytes?: number; // optional hint
}

/** Page entity (immutable) — a source Markdown page within the project */
export interface Page {
  /** Project-relative or absolute file path to the Markdown source */
  readonly filePath: string;

  /** Page title, typically derived from frontmatter or first heading */
  readonly title: string;

  /** Normalized Markdown content for this page */
  readonly markdown: string;

  /** Page-local attachments referenced by the page (optional) */
  readonly attachments?: readonly Attachment[];
}

/** Topic entity (immutable) — represents a Writerside/Authord topic */
export interface Topic {
  /** Stable topic identifier (file stem, slug, or canonical ID) */
  readonly id: string;

  /** Human-readable label */
  readonly title: string;

  /** Optional canonical path to the topic's entry file */
  readonly path?: string;

  /** Child topics; structure is optional/flattenable */
  readonly children?: readonly Topic[];
}

/**
 * Document value object (immutable) — the flattened Markdown document
 * that will be transformed to Confluence Storage format by a transformer port.
 */
export interface Document {
  /** The single, final document title */
  readonly title: string;

  /** The flattened Markdown body (pre-transformation) */
  readonly markdown: string;

  /** All attachments required by the final document */
  readonly attachments: readonly Attachment[];
}

/* Utility constructors & guards
   ----------------------------- */

/** Create an immutable Attachment */
export function createAttachment(input: {
  fileName: string;
  path: string;
  mediaType?: string;
  sizeBytes?: number;
}): Attachment {
  const a: Attachment = {
    fileName: input.fileName,
    path: input.path,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
  };
  return Object.freeze(a);
}

export function isAttachment(v: unknown): v is Attachment {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as Attachment).fileName === "string" &&
      typeof (v as Attachment).path === "string",
  );
}

/** Create an immutable Page */
export function createPage(input: {
  filePath: string;
  title: string;
  markdown: string;
  attachments?: readonly Attachment[];
}): Page {
  const p: Page = {
    filePath: input.filePath,
    title: input.title,
    markdown: input.markdown,
    attachments: input.attachments
      ? Object.freeze([...input.attachments])
      : undefined,
  };
  return Object.freeze(p);
}

export function isPage(v: unknown): v is Page {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as Page).filePath === "string" &&
      typeof (v as Page).title === "string" &&
      typeof (v as Page).markdown === "string",
  );
}

/** Create an immutable Topic (shallow freeze; children array is frozen too) */
export function createTopic(input: {
  id: string;
  title: string;
  path?: string;
  children?: readonly Topic[];
}): Topic {
  const t: Topic = {
    id: input.id,
    title: input.title,
    path: input.path,
    children: input.children ? Object.freeze([...input.children]) : undefined,
  };
  return Object.freeze(t);
}

export function isTopic(v: unknown): v is Topic {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as Topic).id === "string" &&
      typeof (v as Topic).title === "string",
  );
}

/** Create an immutable Document */
export function createDocument(input: {
  title: string;
  markdown: string;
  attachments: readonly Attachment[];
}): Document {
  const d: Document = {
    title: input.title,
    markdown: input.markdown,
    attachments: Object.freeze([...input.attachments]),
  };
  return Object.freeze(d);
}

export function isDocument(v: unknown): v is Document {
  return Boolean(
    v &&
      typeof v === "object" &&
      typeof (v as Document).title === "string" &&
      typeof (v as Document).markdown === "string" &&
      Array.isArray((v as Document).attachments),
  );
}
