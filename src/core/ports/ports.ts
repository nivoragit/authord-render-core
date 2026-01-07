// Hexagonal ports (interfaces only). Adapters will implement these.
// Use cases depend on these interfaces; domain stays pure.

import type {
  ConfluenceCfg,
  PublishSingleOptions,
  StorageXhtml,
  PageId,
  Path,
} from "../shared/types.ts";
import type { ExportHash } from "../domain/entities.ts";

/** Validates a Writerside/Authord project structure & configuration. */
export interface IProjectValidator {
  /**
   * Validate the project before publishing.
   * Return ok=false with errors array if validation fails.
   */
  validate(
    options: PublishSingleOptions,
    cfg?: ConfluenceCfg,
  ): Promise<{ ok: true } | { ok: false; errors: readonly string[] }>;
}

/**
 * Resolves Markdown file paths in a deterministic DFS order, typically starting
 * from an entrypoint (e.g., README.md) within rootDir.
 */
export interface IOrderingResolver {
  /**
   * Produce an ordered list of Markdown file paths (project-relative or absolute).
   * Must be stable/deterministic given the same tree.
   */
  resolve(rootDir: Path): Promise<readonly Path[]>;
}

/** Transforms Markdown to Confluence Storage (XHTML) representation. */
export interface IMarkdownTransformer {
  /**
   * Convert Markdown to Storage XHTML string ready for Confluence API.
   * Implementations should handle GFM, directives, raw HTML passthrough, etc.
   */
  toStorage(markdown: string): Promise<StorageXhtml>;
}

/** Basic Confluence page operations required by publishing. */
export interface IPageRepository {
  /**
   * Fetch page metadata and current version.
   * Returns null if the page does not exist or is not visible.
   */
  get(pageId: PageId): Promise<{ id: PageId; version: number; title: string } | null>;

  /**
   * Update the page body with Storage XHTML (and optional title).
   * Returns the new page version.
   */
  putStorageBody(
    pageId: PageId,
    storage: StorageXhtml,
    title?: string,
  ): Promise<{ id: PageId; version: number }>;
}

/** Minimal attachment metadata returned by repositories. */
export interface AttachmentInfo {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
}

/** Confluence attachment operations. */
export interface IAttachmentRepository {
  /** List attachments currently associated with the page. */
  list(pageId: PageId): Promise<readonly AttachmentInfo[]>;

  /**
   * Upload an attachment or heal an existing one (replace if changed).
   * Returns the final server-side info.
   */
  uploadOrHeal(
    pageId: PageId,
    filePath: Path,
    fileName?: string,
    contentType?: string,
  ): Promise<AttachmentInfo>;

  /**
   * Ensure an attachment exists and is up-to-date; upload if missing or changed.
   * Returns the final server-side info.
   */
  ensure(
    pageId: PageId,
    filePath: Path,
    contentType?: string,
  ): Promise<AttachmentInfo>;
}

/** Storage for per-page export state (idempotency/skip unchanged). */
export interface IPropertyStore {
  getExportHash(pageId: PageId): Promise<ExportHash | null>;
  setExportHash(pageId: PageId, hash: ExportHash): Promise<void>;
}

/** Minimal filesystem abstraction for testability & portability. */
export interface IFileSystem {
  readText(path: Path): Promise<string>;
  exists(path: Path): Promise<boolean>;

  /**
   * Glob paths relative to an optional cwd, returning normalized absolute or
   * project-relative paths (implementation-defined, but consistent).
   */
  glob(pattern: string, cwd?: Path): Promise<readonly Path[]>;

  /** List direct children of a directory. */
  list(dir: Path): Promise<readonly Path[]>;
}

/** Renders Mermaid diagrams to PNG files at a target path. */
export interface IDiagramRenderer {
  /**
   * Render a Mermaid definition to a PNG at outPath.
   * Returns the final path to the PNG (may equal outPath or a derived path).
   */
  renderMermaid(mermaid: string, outPath: Path): Promise<Path>;
}
