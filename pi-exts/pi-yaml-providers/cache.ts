import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import type { ContextRefCatalog, ContextRefEntry, LiveModel } from "../../ts-lib/lib";

export interface CacheEntry {
  fetchedAt: number;
  models: LiveModel[];
}

export function readCache(cacheDir: string, instanceName: string): CacheEntry | null {
  const file = path.join(cacheDir, `${instanceName}.json`);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed?.fetchedAt === "number" && Array.isArray(parsed?.models)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function writeCache(cacheDir: string, instanceName: string, models: LiveModel[]): void {
  mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `${instanceName}.json`);
  writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
}

export function isFresh(entry: CacheEntry, ttlMs: number, now: number): boolean {
  return now - entry.fetchedAt < ttlMs;
}

// ── max_context_ref catalog cache (keyed by URL, not instance name - several
// instances can share one provider, and therefore one catalog URL) ────────
// Sanitized-filename key rather than a hash: keeps `.cache/` human-readable,
// same convention as the instance-name keyed model cache above.
function contextRefCacheFile(cacheDir: string, url: string): string {
  const key = url.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return path.join(cacheDir, `_context_ref_${key}.json`);
}

export interface ContextRefCacheEntry {
  fetchedAt: number;
  catalog: ContextRefCatalog;
}

export function readContextRefCache(cacheDir: string, url: string): ContextRefCacheEntry | null {
  const file = contextRefCacheFile(cacheDir, url);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed?.fetchedAt !== "number" || typeof parsed?.catalog !== "object" || parsed.catalog === null) {
      return null;
    }
    const catalog: ContextRefCatalog = new Map(
      Object.entries(parsed.catalog as Record<string, ContextRefEntry[]>),
    );
    return { fetchedAt: parsed.fetchedAt, catalog };
  } catch {
    return null;
  }
}

export function writeContextRefCache(cacheDir: string, url: string, catalog: ContextRefCatalog): void {
  mkdirSync(cacheDir, { recursive: true });
  const file = contextRefCacheFile(cacheDir, url);
  writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), catalog: Object.fromEntries(catalog) }, null, 2));
}
