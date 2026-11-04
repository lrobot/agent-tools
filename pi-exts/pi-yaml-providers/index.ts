import os from "os";
import path from "path";
import { realpathSync } from "fs";
import {
  isInstanceInProfile,
  loadInstances,
  loadProviders,
  loadSecrets,
  resolveInstancesYaml,
  resolveProvidersYaml,
  compileModelExcludes,
  isModelExcluded,
  isExactExcluded,
  loadExcludeModels,
  type InstanceEntry,
  type ProviderEntry,
} from "./config";
import { getModelIds } from "./models";
import { getContextRef, lookupContextRef, type ContextRefEntry } from "./contextRef";
// Type-only import: erased at transpile time, so it never hits jiti's runtime
// resolver - safe even though index.ts must not RUNTIME-import from
// ../../ts-lib/lib directly (see the comment in contextRef.ts).
import type { LiveModel } from "../../ts-lib/lib";

// Cross-machine config locations (see ts-lib/lib.ts resolve*Yaml for the full
// rationale): instances is a home-dir dotfile synced via dotfiles; providers
// lives in this repo and is reached through a per-machine symlink
// ~/.local/bin/providers.yaml -> <repo>/pi-exts/yaml-providers/providers.yaml
// created by the setup-providers-link mise task.
const CACHE_DIR = path.join(os.homedir(), ".cache", "yaml-providers");
// realpathSync: providers.yaml is reached through a per-machine symlink
// (~/.local/bin/providers.yaml -> <repo>/pi-exts/yaml-providers/providers.yaml);
// dirname() of the unresolved symlink path would point CONFIG_YAML at
// ~/.local/bin/config.yaml instead of the repo dir. Falls back to the raw
// path when the symlink target is missing.
const PROVIDERS_YAML = (() => {
  const p = resolveProvidersYaml();
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
})();
// Global optional exclude list (exclude_models: exact ids), resolved relative
// to providers.yaml so it lands in the same repo dir on every machine.
const CONFIG_YAML = path.join(path.dirname(PROVIDERS_YAML), "config.yaml");
const INSTANCES_YAML = resolveInstancesYaml();
const SECRETS_YAML = path.join(os.homedir(), ".ssh", "secret.yaml");
const TTL_MS = 24 * 60 * 60 * 1000;

// Placeholder defaults for models whose /models listing doesn't expose
// context/output-token limits (most providers - see design_pi_extension.md
// §5). Real values from the live response (or cache) win when present.
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

type ModelConfig = ReturnType<typeof toModelConfigs>[number];

// contextRefFor: optional lookup into a provider's `max_context_ref` catalog
// (see cld-ts/lib.ts's lookupContextRef) - only consulted when the live
// /models listing itself didn't say (contextWindow/maxTokens undefined).
// Precedence is therefore: live value > max_context_ref > placeholder default.
export function toModelConfigs(models: LiveModel[], contextRefFor?: (id: string) => ContextRefEntry) {
  return models.map(({ id, contextWindow, maxTokens, reasoning, images }) => {
    const ref = contextWindow === undefined || maxTokens === undefined ? contextRefFor?.(id) ?? {} : {};
    return {
      id,
      name: id,
      // Unknown (most providers don't expose this) defaults to false/text-only,
      // same conservative default as before - only flips to true when the
      // live listing says so explicitly.
      reasoning: reasoning ?? false,
      input: images ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: contextWindow ?? ref.context ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxTokens ?? ref.output ?? DEFAULT_MAX_TOKENS,
    };
  });
}

export function groupModelsByApi(models: ModelConfig[]) {
  const groups = new Map<"openai-completions" | "anthropic-messages", ModelConfig[]>();
  for (const model of models) {
    const api = /^(gpt|codex)/i.test(model.name) ? "openai-completions" : "anthropic-messages";
    const group = groups.get(api) ?? [];
    group.push(model);
    groups.set(api, group);
  }
  return groups;
}

export function resolveBaseUrlV1(provider: Pick<ProviderEntry, "base_url" | "base_url_v1">) {
  //return provider.base_url_v1 ?? `${provider.base_url.replace(/\/$/, "")}/v1`;
  return provider.base_url;
}

// Provider ids use the yaml instance name directly (kimiqq, deepseektoken).
// A provider serving both APIs gets the bare name for anthropic-messages (the
// coding-agent transport) and a short -openai suffix for the extra group.
// Names colliding with pi builtin providers keep the legacy dotted id and a
// warning, so a stray "openai" instance cannot shadow the real builtin.
const RESERVED_PROVIDER_IDS = new Set([
  "anthropic",
  "antigravity",
  "github-copilot",
  "google",
  "kimi-coding",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "xai",
  "zai",
  "zai-coding-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
]);

export function providerRegistrationId(instanceName: string, api: string, apiGroupCount: number): string {
  if (RESERVED_PROVIDER_IDS.has(instanceName)) return `dotc-${instanceName}-${api}`;
  if (apiGroupCount <= 1) return instanceName;
  return api === "anthropic-messages" ? instanceName : `${instanceName}-openai`;
}

interface BuildResult {
  warning?: string;
  registrations?: Array<{ id: string; config: Record<string, unknown> }>;
}

async function buildProviderConfig(
  instanceName: string,
  inst: InstanceEntry,
  providers: Record<string, ProviderEntry>,
  secrets: Record<string, { secret: string }>,
  opts?: { force?: boolean; globalExcludes?: string[] },
): Promise<BuildResult> {
  const provider = providers[inst.provider_name];
  if (!provider) return { warning: `instance ${instanceName}: unknown provider ${inst.provider_name}` };

  const secretEntry = secrets[inst.secret_key_name];
  if (!secretEntry?.secret) return { warning: `instance ${instanceName}: no secret for ${inst.secret_key_name}` };

  // Detect first, static models: block (if any) is only the fallback when
  // live detection (fresh cache or fetch) comes back empty - mirrors
  // cld-ts/core.ts's runModelSelect. See design_pi_extension.md §4.
  const r = await getModelIds(instanceName, provider.base_url, provider.models_url, secretEntry.secret, {
    cacheDir: CACHE_DIR,
    ttlMs: TTL_MS,
    force: opts?.force,
    staticIds: provider.models ? Object.values(provider.models) : undefined,
  });

  // Two-layer exclusion, both applied after getModelIds so they cover all
  // three sources (live fetch, cache, static fallback) uniformly:
  //   - per-instance pi_models_exclude regexes (instances yaml)
  //   - global config.yaml exclude_models exact ids (see isExactExcluded)
  const { regexes: excludes, invalid: invalidExcludes } = compileModelExcludes(inst.pi_models_exclude);
  const globalExcludes = opts?.globalExcludes ?? [];
  const excludeWarning = invalidExcludes.length
    ? `instance ${instanceName}: invalid pi_models_exclude patterns ignored: ${invalidExcludes.join(", ")}`
    : undefined;
  const models = r.models.filter(
    (m) => !isModelExcluded(m.id, excludes) && !isExactExcluded(m.id, globalExcludes),
  );

  // Only fetched when the provider opts in - most providers' /models listing
  // already publishes real limits and never needs this (see design_pi_extension.md).
  let contextRefFor: ((id: string) => ContextRefEntry) | undefined;
  let contextRefWarning: string | undefined;
  if (provider.max_context_ref) {
    const ref = await getContextRef(provider.max_context_ref, {
      cacheDir: CACHE_DIR,
      ttlMs: TTL_MS,
      force: opts?.force,
    });
    contextRefWarning = ref.warning;
    contextRefFor = (id) => lookupContextRef(ref.catalog, id);
  }

  const baseUrl = resolveBaseUrlV1(provider);
  const groups = [...groupModelsByApi(toModelConfigs(models, contextRefFor))];
  const reservedWarning = RESERVED_PROVIDER_IDS.has(instanceName)
    ? `instance ${instanceName}: name collides with a builtin provider; registered with legacy dotc- id`
    : undefined;
  const registrations = groups.map(([api, groupModels]) => ({
    id: providerRegistrationId(instanceName, api, groups.length),
    config: {
      name: provider.name ?? instanceName,
      baseUrl,
      apiKey: secretEntry.secret,
      api,
      authHeader: !!provider.secret_use_as_auth_token && api === "anthropic-messages",
      models: groupModels,
    },
  }));

  return {
    warning: [r.warning, contextRefWarning, excludeWarning, reservedWarning].filter(Boolean).join("; ") || undefined,
    registrations,
  };
}

function registerResult(pi: any, result: BuildResult) {
  for (const registration of result.registrations ?? []) {
    pi.registerProvider(registration.id, registration.config);
  }
}

export default async function (pi: any) {
  const providers = loadProviders(PROVIDERS_YAML);
  const instances = loadInstances(INSTANCES_YAML);
  const secrets = loadSecrets(SECRETS_YAML);
  const globalExcludes = loadExcludeModels(CONFIG_YAML);
  const warnings: string[] = [];

  await Promise.all(
    Object.entries(instances).map(async ([name, inst]) => {
      if (!isInstanceInProfile(inst)) return;
      const result = await buildProviderConfig(name, inst, providers, secrets, { globalExcludes });
      if (result.warning) warnings.push(result.warning);
      registerResult(pi, result);
    }),
  );

  if (warnings.length) {
    pi.on("session_start", (_event: unknown, ctx: any) => {
      for (const w of warnings) ctx.ui.notify(w, "warning");
    });
  }

  pi.registerCommand("modelreload", {
    description: "Force-refresh live model lists for yaml providers, bypassing the cache",
    handler: async (args: string, ctx: any) => {
      const activeTargets = Object.keys(instances).filter((name) => isInstanceInProfile(instances[name]));
      const targets = args.trim() ? [args.trim()] : activeTargets;
      for (const name of targets) {
        if (!instances[name] || !isInstanceInProfile(instances[name])) {
          ctx.ui.notify(`modelreload: unknown or inactive instance ${name}`, "warning");
          continue;
        }
        const result = await buildProviderConfig(name, instances[name], providers, secrets, {
          force: true,
          globalExcludes,
        });
        if (result.warning) {
          ctx.ui.notify(`modelreload ${name}: ${result.warning}`, "warning");
        }
        if (result.registrations?.length) {
          registerResult(pi, result);
          const count = result.registrations.reduce((sum, registration) => {
            return sum + ((registration.config.models as unknown[] | undefined)?.length ?? 0);
          }, 0);
          ctx.ui.notify(`modelreload ${name}: ok (${count} models)`, "info");
        }
      }
    },
  });
}
