import { fetchLiveModels, type LiveModel, type LiveModelsResult } from "../../ts-lib/lib";
import { readCache, writeCache, isFresh } from "./cache";

export type FetchModelsFn = (
  baseUrl: string,
  apiKey: string,
  modelsUrlOverride: string,
) => LiveModelsResult | Promise<LiveModelsResult>;

export interface GetModelIdsOptions {
  cacheDir: string;
  ttlMs?: number;
  now?: number;
  force?: boolean;
  fetchFn?: FetchModelsFn;
  // Static models: list from providers.yaml, used only when live
  // detection (fresh cache or fetch) yields no ids at all - see
  // design_pi_extension.md §4 "detect first, static list is the fallback".
  staticIds?: string[];
}

export interface GetModelIdsResult {
  models: LiveModel[];
  warning?: string;
}

export async function getModelIds(
  instanceName: string,
  baseUrl: string,
  modelsUrlOverride: string | undefined,
  apiKey: string,
  options: GetModelIdsOptions,
): Promise<GetModelIdsResult> {
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? fetchLiveModels;
  const force = options.force ?? false;

  const cached = readCache(options.cacheDir, instanceName);
  if (!force && cached && isFresh(cached, ttlMs, now)) {
    return { models: cached.models };
  }

  const result = await fetchFn(baseUrl, apiKey, modelsUrlOverride ?? "");
  if (result.ok) {
    writeCache(options.cacheDir, instanceName, result.models);
    return { models: result.models };
  }

  if (cached) {
    return {
      models: cached.models,
      warning: `${instanceName}: live fetch failed (${result.error}), using stale cache from ${new Date(cached.fetchedAt).toISOString()}`,
    };
  }

  const staticIds = options.staticIds ?? [];
  if (staticIds.length > 0) {
    return {
      models: staticIds.map((id) => ({ id })),
      warning: `${instanceName}: live fetch failed (${result.error}), using static models: list from providers.yaml`,
    };
  }

  return { models: [], warning: `${instanceName}: live fetch failed (${result.error}), no cache and no static models: list available` };
}
