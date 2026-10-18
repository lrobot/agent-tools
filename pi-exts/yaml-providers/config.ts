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
