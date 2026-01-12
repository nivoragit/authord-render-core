// schema_fetcher.ts
import type { Fetcher } from "../core/shared/fetcher.ts";

type CacheMap = Record<string, string>; // url -> local filepath

async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}

async function ensureDirForFile(path: string) {
  const parts = path.split("/").slice(0, -1);
  if (parts.length === 0) return;
  await Deno.mkdir(parts.join("/"), { recursive: true });
}

export function makeLocalFirstCachingFetcher(opts: {
  cacheMap: CacheMap;
  allowNetwork?: boolean; // default true
}): Fetcher {
  const allowNetwork = opts.allowNetwork ?? true;

  return async (url: string): Promise<string> => {
    // 1) file:// support
    if (url.startsWith("file://")) {
      const p = new URL(url).pathname;
      return await Deno.readTextFile(p);
    }

    // 2) mapped local cache
    const localPath = opts.cacheMap[url];
    if (localPath) {
      if (await fileExists(localPath)) {
        return await Deno.readTextFile(localPath);
      }
      if (!allowNetwork) {
        throw new Error(`Schema not found locally and network disabled: ${url} -> ${localPath}`);
      }
      // download + save
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed to fetch schema: ${r.status} ${r.statusText} (${url})`);
      const text = await r.text();
      await ensureDirForFile(localPath);
      await Deno.writeTextFile(localPath, text);
      return text;
    }

    // 3) not mapped: either fetch (if allowed) or fail
    if (!allowNetwork) {
      throw new Error(`Schema URL not mapped and network disabled: ${url}`);
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch schema: ${r.status} ${r.statusText} (${url})`);
    return await r.text();
  };
}
