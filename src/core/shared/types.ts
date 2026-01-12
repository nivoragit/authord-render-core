// Cross-layer, small, dependency-free types & branded strings.

/** Generic nominal brand helper */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Branded URL and path types for safety */
export type UrlString = Brand<string, "UrlString">;
export type Path = Brand<string, "Path">;

/** Confluence Storage XHTML (post-transform) */
export type StorageXhtml = Brand<string, "StorageXhtml">;

/** Confluence Page identifier */
export type PageId = Brand<string, "PageId">;

/** Basic auth credentials for Confluence/Data Center/Cloud */
export interface BasicAuth {
  readonly username: string;
  readonly password: string;
}

/** Connection/config for Confluence */
export interface ConfluenceCfg {
  readonly baseUrl: UrlString;
  readonly basicAuth: BasicAuth;
}

/**
 * Options required to publish a single flattened document.
 *
 * rootDir  - project root directory
 * md       - entry Markdown file to flatten (project-relative or absolute)
 * images   - directory containing images/assets referenced by the doc
 * baseUrl  - Confluence base URL
 * basicAuth- credentials
 * pageId   - target page identifier
 * title    - optional override title for the resulting page
 */
export interface PublishSingleOptions {
  readonly rootDir: Path;
  readonly md: Path;
  readonly images: Path;
  readonly baseUrl: UrlString;
  readonly basicAuth: BasicAuth;
  readonly pageId: PageId;
  readonly title?: string;
}

/* Small factory helpers to apply brands (lightweight, no validation here).
   Adapters/validators can impose stricter checks where appropriate. */

export const asUrl = (v: string): UrlString => v as UrlString;
export const asPath = (v: string): Path => v as Path;
export const asStorageXhtml = (v: string): StorageXhtml => v as StorageXhtml;
export const asPageId = (v: string): PageId => v as PageId;
