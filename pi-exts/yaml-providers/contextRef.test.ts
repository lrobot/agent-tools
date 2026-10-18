import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getContextRef } from "./contextRef";
import { readContextRefCache, writeContextRefCache } from "./cache";

const URL = "https://models.dev/api.json";

test("uses fresh cache without calling fetchFn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  writeContextRefCache(dir, URL, new Map([["m", [{ context: 1000000, output: 384000 }]]]));
  let called = false;
  const result = await getContextRef(URL, {
    cacheDir: dir,
    fetchFn: async () => {
      called = true;
      return { ok: true, catalog: new Map(), url: URL };
    },
  });
  expect(called).toBe(false);
  expect(result.catalog.get("m")).toEqual([{ context: 1000000, output: 384000 }]);
});

test("fetches and writes cache when stale", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  const result = await getContextRef(URL, {
    cacheDir: dir,
    fetchFn: async () => ({ ok: true, catalog: new Map([["m", [{ context: 500, output: 100 }]]]), url: URL }),
  });
  expect(result.catalog.get("m")).toEqual([{ context: 500, output: 100 }]);
  // Second call, fresh cache this time: fetchFn must not be called again.
  let called = false;
  const second = await getContextRef(URL, {
    cacheDir: dir,
    fetchFn: async () => {
      called = true;
      return { ok: true, catalog: new Map(), url: URL };
    },
  });
  expect(called).toBe(false);
  expect(second.catalog.get("m")).toEqual([{ context: 500, output: 100 }]);
});

test("falls back to stale cache when fetch fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  writeContextRefCache(dir, URL, new Map([["m", [{ context: 42, output: 7 }]]]));
  const result = await getContextRef(URL, {
    cacheDir: dir,
    ttlMs: 1,
    now: Date.now() + 1000 * 60 * 60,
    fetchFn: async () => ({ ok: false, error: "boom", url: URL }),
  });
  expect(result.catalog.get("m")).toEqual([{ context: 42, output: 7 }]);
  expect(result.warning).toMatch(/stale cache/);
});

test("returns empty catalog with warning when no cache and fetch fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  const result = await getContextRef(URL, {
    cacheDir: dir,
    fetchFn: async () => ({ ok: false, error: "boom", url: URL }),
  });
  expect(result.catalog.size).toBe(0);
  expect(result.warning).toMatch(/no cache available/);
});

test("force bypasses a fresh cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  writeContextRefCache(dir, URL, new Map([["m", [{ context: 1, output: 1 }]]]));
  const result = await getContextRef(URL, {
    cacheDir: dir,
    force: true,
    fetchFn: async () => ({ ok: true, catalog: new Map([["m", [{ context: 2, output: 2 }]]]), url: URL }),
  });
  expect(result.catalog.get("m")).toEqual([{ context: 2, output: 2 }]);
});

test("dedupes concurrent callers sharing the same url (in-process memoization)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { ok: true as const, catalog: new Map([["m", [{ context: 9, output: 9 }]]]), url: URL };
  };
  const [a, b] = await Promise.all([
    getContextRef(URL, { cacheDir: dir, fetchFn }),
    getContextRef(URL, { cacheDir: dir, fetchFn }),
  ]);
  expect(calls).toBe(1);
  expect(a.catalog.get("m")).toEqual([{ context: 9, output: 9 }]);
  expect(b.catalog.get("m")).toEqual([{ context: 9, output: 9 }]);
});

test("readContextRefCache/writeContextRefCache round-trip a Map through disk", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-ctxref-"));
  const catalog = new Map([
    ["a", [{ context: 1, output: 2 }]],
    ["b", [{ context: 3, output: undefined }]],
  ]);
  writeContextRefCache(dir, URL, catalog);
  const read = readContextRefCache(dir, URL);
  expect(read?.catalog.get("a")).toEqual([{ context: 1, output: 2 }]);
  expect(read?.catalog.get("b")).toEqual([{ context: 3, output: undefined }]);
});
