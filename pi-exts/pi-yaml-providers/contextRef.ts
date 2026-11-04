import { fetchContextRefCatalog, type ContextRefCatalog, type ContextRefFetchResult } from "../../ts-lib/lib";
import { readContextRefCache, writeContextRefCache } from "./cache";

// Re-exported so index.ts (pi's extension entry point) never has to import
// directly from "../../ts-lib/lib" itself. When this extension was symlinked
// into ~/.pi/agent/extensions, jiti loaded index.ts through the symlink
// without canonicalizing it, so a ".." written inside index.ts escaped to the
// symlink's parent instead of the real repo dir (see the jiti cache entry
// names from that era: pi-ext- vs dotc-providers-). The extension is now a
// pi-install local-path package loaded from its real location, but keep the
// indirection: it costs nothing and guards against any future loading scheme
// that reintroduces a symlink. Sibling files may import "../../ts-lib/lib"
// directly; index.ts must always go through one of them.
export { lookupContextRef, type ContextRefEntry } from "../../ts-lib/lib";

export type FetchContextRefFn = (url: string) => ContextRefFetchResult | Promise<ContextRefFetchResult>;

export interface GetContextRefOptions {
  cacheDir: string;
  ttlMs?: number;
  now?: number;
  force?: boolean;
  fetchFn?: FetchContextRefFn;
}

export interface GetContextRefResult {
  catalog: ContextRefCatalog;
  warning?: string;
}

// In-process de-dup, on top of the disk cache: several instances can share
// the same provider (e.g. globalai / globalaijc both point at the ~5MB
// models.dev catalog) and get built concurrently via Promise.all in
// index.ts - without this, a cold cache means every one of them kicks off
// its own redundant download at the same time.
const inflight = new Map<string, Promise<GetContextRefResult>>();

export async function getContextRef(url: string, options: GetContextRefOptions): Promise<GetContextRefResult> {
  const existing = !options.force ? inflight.get(url) : undefined;
  if (existing) return existing;

  const promise = getContextRefUncached(url, options);
  inflight.set(url, promise);
  try {
    return await promise;
  } finally {
    // Drop the slot once settled so a later TTL expiry or /modelreload
    // (force) triggers a genuinely fresh fetch instead of reusing this result.
    if (inflight.get(url) === promise) inflight.delete(url);
  }
}

async function getContextRefUncached(url: string, options: GetContextRefOptions): Promise<GetContextRefResult> {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? fetchContextRefCatalog;

  const cached = readContextRefCache(options.cacheDir, url);
  if (!options.force && cached && now - cached.fetchedAt < ttlMs) {
    return { catalog: cached.catalog };
  }

  const result = await fetchFn(url);
  if (result.ok) {
    writeContextRefCache(options.cacheDir, url, result.catalog);
    return { catalog: result.catalog };
  }

  if (cached) {
    return {
      catalog: cached.catalog,
      warning: `max_context_ref ${url}: fetch failed (${result.error}), using stale cache from ${new Date(cached.fetchedAt).toISOString()}`,
    };
  }

  return {
    catalog: new Map(),
    warning: `max_context_ref ${url}: fetch failed (${result.error}), no cache available`,
  };
}
