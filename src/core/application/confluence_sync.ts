// sync/confluence-sync.ts
// ConfluenceSync: synchronizes local page/folder structures to a remote Confluence space.
// - SRP: this class orchestrates sync; persistence lives in injected repos.
// - Testable: pure branching based on injected ports; no global I/O.
// - Ubiquitous language: "page", "folder", "export hash", "attachments".

import type {
  StorageXhtml,
  PageId,
  Path,
} from "../shared/types.ts";
import type {
  IPageRepository,
  IAttachmentRepository,
  IPropertyStore,
  AttachmentInfo,
} from "../ports/ports.ts";

// ---- Local structures (domain values used by sync) --------------------------

/** Local page representation to sync. */
export interface ConfluencePage {
  /** Page display title (used for updates; remote page is identified by pageId). */
  readonly title: string;
  /** Confluence Storage XHTML (already transformed). */
  readonly storageHtml: StorageXhtml;
  /** Optional attachments to ensure on the target page. */
  readonly attachments?: ReadonlyArray<{
    filePath: Path;            // absolute or project-resolved path
    fileName?: string;         // optional override filename
    contentType?: string;      // e.g., "image/png"
  }>;
}

/** Local folder that contains pages and nested folders. */
export interface ConfluenceFolder {
  readonly title: string;
  readonly pages: ReadonlyArray<ConfluencePage>;
  readonly children?: ReadonlyArray<ConfluenceFolder>;
}

// ---- Target locator contracts ------------------------------------------------

/** Options to target a specific remote page. */
export interface TargetPageOptions {
  /** Remote page id to publish to. */
  readonly pageId: PageId;
  /** If provided, override the title stored on the remote page. Defaults to page.title. */
  readonly titleOverride?: string;
}

/** Options to target a parent under which child pages live. */
export interface TargetParentOptions {
  /** Remote parent page id under which pages/folders reside. */
  readonly parentId: PageId;
  /**
   * Resolve (or create) a child page id for a given title under the parent.
   * Returning null/undefined will skip that page.
   */
  readonly resolveChildPageId: (args: {
    parentId: PageId;
    childTitle: string;
  }) => Promise<PageId | null | undefined>;
}

// ---- Sync result types -------------------------------------------------------

export interface PageSyncResult {
  readonly pageId: PageId;
  readonly updatedBody: boolean;
  readonly uploadedAttachments: ReadonlyArray<AttachmentInfo>;
}

export interface FolderSyncResult {
  readonly parentId: PageId;
  /** Map of child page titles to their PageSyncResult (if synced). */
  readonly pages: Record<string, PageSyncResult>;
  /** Map of child folder titles to nested FolderSyncResult. */
  readonly children: Record<string, FolderSyncResult>;
}

// ---- Implementation ----------------------------------------------------------

export class ConfluenceSync {
  constructor(
    private readonly pages: IPageRepository,
    private readonly attachments: IAttachmentRepository,
    private readonly props: IPropertyStore,
  ) {}

  /** Compute a stable export hash for a page body (sha256 of storageHtml). */
  static async computeExportHash(storageHtml: StorageXhtml): Promise<string> {
    const enc = new TextEncoder().encode(storageHtml as unknown as string);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    const bytes = new Uint8Array(buf);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Publish/update a single page into Confluence.
   * - Skips body update if export hash matches.
   * - Always ensures attachments (the repo optimizes via its manifest).
   */
  async sync(
    page: ConfluencePage,
    target: TargetPageOptions,
  ): Promise<PageSyncResult> {
    const { pageId, titleOverride } = target;

    // 1) Hash the body to detect changes vs. previous export.
    const nextHash = await ConfluenceSync.computeExportHash(page.storageHtml);
    const prevHash = await this.props.getExportHash(pageId);

    // 2) Update body only if hash changed.
    let updatedBody = false;
    if (!prevHash || String(prevHash) !== nextHash) {
      await this.pages.putStorageBody(pageId, page.storageHtml, titleOverride ?? page.title);
      await this.props.setExportHash(pageId, nextHash as unknown as any); // ExportHash is a branded string
      updatedBody = true;
    }

    // 3) Ensure attachments (repo will no-op if unchanged).
    const uploaded: AttachmentInfo[] = [];
    if (page.attachments?.length) {
      for (const att of page.attachments) {
        const info = await this.attachments.ensure(
          pageId,
          att.filePath,
          att.contentType,
        );
        uploaded.push(info);
      }
    }

    return { pageId, updatedBody, uploadedAttachments: uploaded };
  }

  /**
   * Publish/update a whole folder hierarchy under a parent page.
   * Page creation/lookup is delegated to resolveChildPageId for isolation and testability.
   * Any page that cannot be resolved is skipped.
   */
  async syncFolder(
    folder: ConfluenceFolder,
    target: TargetParentOptions,
  ): Promise<FolderSyncResult> {
    const { parentId, resolveChildPageId } = target;

    const pagesResults: Record<string, PageSyncResult> = {};
    for (const p of folder.pages) {
      const childId = await resolveChildPageId({ parentId, childTitle: p.title });
      if (!childId) continue;
      pagesResults[p.title] = await this.sync(p, { pageId: childId, titleOverride: p.title });
    }

    const childrenResults: Record<string, FolderSyncResult> = {};
    for (const child of folder.children ?? []) {
      // Resolve or create a page that represents the folder node itself.
      const childParentId = await resolveChildPageId({ parentId, childTitle: child.title });
      if (!childParentId) continue;
      childrenResults[child.title] = await this.syncFolder(child, {
        parentId: childParentId,
        resolveChildPageId,
      });
    }

    return { parentId, pages: pagesResults, children: childrenResults };
  }
}
