import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { readCache, writeCache, isFresh } from "./cache";

test("readCache returns null when no cache file exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-cache-"));
  expect(readCache(dir, "deepseek")).toBeNull();
});

test("writeCache then readCache round-trips models", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ext-cache-"));
  writeCache(dir, "deepseek", [{ id: "a", contextWindow: 200000 }, { id: "b" }]);
  const entry = readCache(dir, "deepseek");
  expect(entry?.models).toEqual([{ id: "a", contextWindow: 200000 }, { id: "b" }]);
});

test("isFresh respects the ttl window", () => {
  const entry = { fetchedAt: 1000, models: [] };
  expect(isFresh(entry, 500, 1400)).toBe(true);
  expect(isFresh(entry, 500, 1600)).toBe(false);
});
