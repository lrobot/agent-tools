import { readFileSync } from "fs";
import { parse } from "yaml";

export interface ProviderEntry {
  name?: string;
  base_url: string;
  base_url_v1?: string;
  models_url?: string;
  secret_use_as_auth_token?: boolean;
  models?: Record<string, string>;
  // URL to a models.dev-shaped catalog (`{ [vendor]: { models: { [id]: { limit
  // : { context, output } } } } }`) used to correct context/output-token
  // limits for models whose own /models listing doesn't publish them - see
  // cld-ts/lib.ts's parseContextRefCatalog/lookupContextRef and index.ts's
  // toModelConfigs.
  max_context_ref?: string;
}

export interface InstanceEntry {
  provider_name: string;
  secret_key_name: string;
  pi_profile?: string[];
  // Regex patterns matched against model ids; matching models are excluded
  // from pi's model list at registration time (applies to live fetch, cache
  // and the static providers.yaml fallback alike, since filtering happens
  // after getModelIds). Invalid patterns are ignored with a warning.
  pi_models_exclude?: string[];
}

export function compileModelExcludes(patterns?: string[]): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const pattern of patterns ?? []) {
    try {
      regexes.push(new RegExp(pattern));
    } catch {
      invalid.push(pattern);
    }
  }
  return { regexes, invalid };
}

export function isModelExcluded(id: string, regexes: RegExp[]): boolean {
  return regexes.some((re) => re.test(id));
}

// config.yaml (optional, lives next to the extension): a global
// `exclude_models` list of exact model ids (generated from `pi
// --list-models`) applied to every instance on top of any per-instance
// pi_models_exclude regexes. Missing file = no excludes (unlike
// providers.yaml, which must exist).
export function loadExcludeModels(filePath: string): string[] {
  try {
    const parsed: { exclude_models?: unknown } = parse(readFileSync(filePath, "utf8")) ?? {};
    return Array.isArray(parsed.exclude_models)
      ? parsed.exclude_models.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

// Exact-match semantics for exclude_models entries. Ids were copied from
// `pi --list-models`, so some entries carry api/vendor prefixes (e.g.
// "anthropic/deepseek/deepseek-v4.1-flash-1017[1m]") while others are bare
// ids: a model matches when id === entry, the id ends with "/"+entry, or
// the entry ends with "/"+id. Deliberately NOT regex - entries contain
// regex-significant characters like `[1m]`.
export function isExactExcluded(id: string, entries: string[]): boolean {
  return entries.some((entry) => entry === id || id.endsWith(`/${entry}`) || entry.endsWith(`/${id}`));
}

export function isInstanceInProfile(
  inst: InstanceEntry,
  activeProfile = process.env.PI_PROFILE?.trim() || "default",
): boolean {
  let profiles: string[];
  if (Array.isArray(inst.pi_profile)) {
    profiles = inst.pi_profile;
  } else if (typeof inst.pi_profile === "string") {
    profiles = [inst.pi_profile];
  } else {
    profiles = ["default"];
  }
  return profiles.includes(activeProfile) || profiles.includes("*");
}

export interface SecretEntry {
  secret: string;
}

export function loadProviders(filePath: string): Record<string, ProviderEntry> {
  return parse(readFileSync(filePath, "utf8")) ?? {};
}

export function loadInstances(filePath: string): Record<string, InstanceEntry> {
  return parse(readFileSync(filePath, "utf8")) ?? {};
}

export function loadSecrets(filePath: string): Record<string, SecretEntry> {
  return parse(readFileSync(filePath, "utf8")) ?? {};
}

// Ported 1:1 from pi.sh's pi_infer_api() bash case statement.
export function inferApi(baseUrl: string): "anthropic-messages" | "openai-completions" {
  const anthropicSuffixes = ["/anthropic", "/apps/anthropic", "/coding", "/coding/"];
  const openaiSuffixes = ["/v1", "/api/v1", "/compatible", "/completions", "/openai/v1"];
  if (anthropicSuffixes.some((s) => baseUrl.endsWith(s)) || baseUrl.includes("minimaxi.com/anthropic")) {
    return "anthropic-messages";
  }
  if (openaiSuffixes.some((s) => baseUrl.endsWith(s)) || baseUrl.includes("openrouter.ai")) {
    return "openai-completions";
  }
  return "anthropic-messages";
}

// Cross-machine yaml path resolvers live in ts-lib/lib.ts; re-exported here
// so index.ts (pi's extension entry point) never runtime-imports from
// ../../ts-lib/lib directly - see the comment in contextRef.ts.
export { resolveInstancesYaml, resolveProvidersYaml } from "../../ts-lib/lib";
