import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getModelIds } from "./models";
import { writeCache } from "./cache";

test("uses fresh cache without calling fetchFn", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  writeCache(dir, "agnes", [{ id: "cached-model" }]);
  let called = false;
  const result = await getModelIds("agnes", "https://x", undefined, "key", {
    cacheDir: dir,
    fetchFn: async () => {
      called = true;
      return { ok: true, ids: ["live"], models: [{ id: "live" }], source: "openai", url: "x" };
    },
  });
  expect(result.models).toEqual([{ id: "cached-model" }]);
  expect(called).toBe(false);
});

test("fetches and writes cache when stale, keeping context/max-token metadata", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  const result = await getModelIds("agnes", "https://x", undefined, "key", {
    cacheDir: dir,
    fetchFn: async () => ({
      ok: true,
      ids: ["live-a", "live-b"],
      models: [{ id: "live-a", contextWindow: 200000, maxTokens: 8192 }, { id: "live-b" }],
      source: "openai",
      url: "x",
    }),
  });
  expect(result.models).toEqual([{ id: "live-a", contextWindow: 200000, maxTokens: 8192 }, { id: "live-b" }]);
});

test("falls back to stale cache when fetch fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  writeCache(dir, "agnes", [{ id: "stale-model" }]);
  const result = await getModelIds("agnes", "https://x", undefined, "key", {
    cacheDir: dir,
    ttlMs: 1,
    now: Date.now() + 1000 * 60 * 60,
    fetchFn: async () => ({ ok: false, error: "boom", url: "x" }),
  });
  expect(result.models).toEqual([{ id: "stale-model" }]);
  expect(result.warning).toMatch(/stale cache/);
});

test("returns empty models with warning when no cache and fetch fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  const result = await getModelIds("agnes", "https://x", undefined, "key", {
    cacheDir: dir,
    fetchFn: async () => ({ ok: false, error: "boom", url: "x" }),
  });
  expect(result.models).toEqual([]);
  expect(result.warning).toMatch(/no cache and no static models/);
});

test("falls back to static ids when fetch fails and no cache exists", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  const result = await getModelIds("bigmodel", "https://x", undefined, "key", {
    cacheDir: dir,
    staticIds: ["glm-4-plus", "glm-4-flash"],
    fetchFn: async () => ({ ok: false, error: "boom", url: "x" }),
  });
  expect(result.models).toEqual([{ id: "glm-4-plus" }, { id: "glm-4-flash" }]);
  expect(result.warning).toMatch(/static models/);
});

test("stale cache still wins over static ids when both are available", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  writeCache(dir, "bigmodel", [{ id: "cached-model" }]);
  const result = await getModelIds("bigmodel", "https://x", undefined, "key", {
    cacheDir: dir,
    ttlMs: 1,
    now: Date.now() + 1000 * 60 * 60,
    staticIds: ["glm-4-plus"],
    fetchFn: async () => ({ ok: false, error: "boom", url: "x" }),
  });
  expect(result.models).toEqual([{ id: "cached-model" }]);
});

test("force bypasses a fresh cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-models-"));
  writeCache(dir, "agnes", [{ id: "cached-model" }]);
  const result = await getModelIds("agnes", "https://x", undefined, "key", {
    cacheDir: dir,
    force: true,
    fetchFn: async () => ({ ok: true, ids: ["fresh"], models: [{ id: "fresh" }], source: "openai", url: "x" }),
  });
  expect(result.models).toEqual([{ id: "fresh" }]);
});
