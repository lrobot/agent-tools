// lib.ts: shared helpers for cld-ts/core.ts.
// Ported 1:1 from the bash reference implementation (cld.sh / cld_lib.sh) -
// see ~/.dotc/doc/design_cld_ts.md for the rationale.
import { execFileSync, spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import path from "path";

// ── Cross-machine config locations ────────────────────────────────────────
// Both resolvers avoid machine-specific absolute paths so the same code runs
// on any machine (mac/Linux today, Windows later):
//  - instances yaml is a home-dir dotfile, synced between machines as part of
//    the personal dotfiles (same path everywhere via os.homedir()).
//  - providers yaml lives in this repo (pi-exts/pi-yaml-providers/providers.yaml);
//    the repo may be cloned anywhere per machine, so the resolved path is a
//    stable per-machine symlink ~/.local/bin/providers.yaml -> <repo>/...,
//    created by the setup-providers-link mise task. An env var overrides both.
export function resolveInstancesYaml(): string {
  return process.env.AGENT_INSTANCES_YAML || path.join(homedir(), ".agent_instances.yaml");
}

export function resolveProvidersYaml(): string {
  return process.env.AGENT_PROVIDERS_YAML || path.join(homedir(), ".local", "bin", "providers.yaml");
}

export const MODEL_VARS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

export const IS_WIN = process.platform === "win32";

// ── PATH lookup (avoids shelling out to `command -v` / `where`) ──────────
export function findInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = IS_WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (IS_WIN ? ext : ""));
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

// ── bash resolution (Windows: must NOT be WSL's bash) ────────────────────
// On Windows, PATH lookup for "bash" hits C:\WINDOWS\System32\bash.exe first
// - the WSL launcher, which runs inside the Linux VM where the Windows-side
// ~/.ssh/secret.sh does not exist. Prefer a real Win32 bash (Git Bash /
// msys2), whose filesystem view matches ours. $CLD_BASH overrides.
export function resolveBash(): string {
  if (process.env.CLD_BASH) return process.env.CLD_BASH;
  if (!IS_WIN) return "bash";

  const candidates: string[] = [];
  // git.exe lives in <root>\cmd or <root>\bin; bash.exe is at <root>\bin.
  const git = findInPath("git");
  if (git) candidates.push(path.join(path.dirname(path.dirname(git)), "bin", "bash.exe"));
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\msys64\\usr\\bin\\bash.exe",
  );
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }

  // Last resort: any bash on PATH that isn't the System32 WSL stub.
  const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase();
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (dir.toLowerCase().startsWith(sys32)) continue;
    const c = path.join(dir, "bash.exe");
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  return "bash";
}

export function requireYq(): void {
  if (!findInPath("yq")) {
    console.error("ERROR: yq not found in PATH (required to parse anthropic_instances.yaml)");
    process.exit(1);
  }
}

// ── yq wrapper (strenv()-based bracket lookup - see secret.sh precedent) ─
// yq(file, expr, env): runs `yq -r <expr> <file>` with extra env vars set,
// so untrusted keys (instance/provider names) are passed via strenv(NAME)
// instead of spliced into the expression string.
export function yq(file: string, expr: string, extraEnv: Record<string, string> = {}): string {
  try {
    const out = execFileSync("yq", ["-r", expr, file], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      // execFileSync leaves stderr on the parent's by default, so a yq
      // diagnostic prints itself even though we swallow the failure and return
      // "" - that's how `Error: cannot get keys of !!null` used to surface,
      // bare and unattributed, in the middle of cld's own output. Capture it
      // so the caller decides what (if anything) the user should see.
      stdio: ["ignore", "pipe", "pipe"],
    });
    const trimmed = out.trim();
    return trimmed === "null" ? "" : trimmed;
  } catch {
    return "";
  }
}

// yqGet(file, key, subpath): safe `.[strenv(K)]<subpath>` lookup, e.g.
// yqGet(instancesYaml, instance, ".provider_name // \"\"")
export function yqGet(file: string, key: string, subpath = ""): string {
  const expr = `.[strenv(K)]${subpath}`;
  return yq(file, expr, { K: key });
}

// yqGetNested(file, key1, key2, subpath): `.[strenv(K1)][strenv(K2)]<subpath>`
export function yqGetNested(file: string, key1: string, key2: string, subpath = ""): string {
  const expr = `.[strenv(K1)][strenv(K2)]${subpath}`;
  return yq(file, expr, { K1: key1, K2: key2 });
}

export function yqKeys(file: string): string[] {
  const out = yq(file, "keys | .[]");
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

// ── secret.sh (same contract on every platform - cld.ps1 already shells
// out to `bash ~/.ssh/secret.sh` on Windows today, so no separate path
// needed here) ────────────────────────────────────────────────────────────
export type SecretResult =
  | { ok: true; value: string }
  // `reason` is a short, self-contained sentence naming what to do about it;
  // `missing` marks the specific case of secret.sh's "ERROR: id not found",
  // which is a routine "you haven't added this one yet" rather than a fault.
  | { ok: false; reason: string; missing: boolean };

export function getSecret(id: string): SecretResult {
  if (!id) {
    return { ok: false, missing: true, reason: "no secret_key_name set for this instance in anthropic_instances.yaml" };
  }
  // Forward slashes, not path.join: bash treats the backslashes of a native
  // Windows path as escape sequences, so C:\Users\lrobo\.ssh\secret.sh
  // arrives as "C:Userslrobo.sshsecret.sh". Git Bash accepts C:/... fine.
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? "").replace(/\\/g, "/");
  const secretScript = `${home}/.ssh/secret.sh`;
  if (!existsSync(secretScript)) {
    return { ok: false, missing: false, reason: `secret store script not found at ${secretScript}` };
  }
  try {
    // Capture stderr rather than letting it through: secret.sh prints a bare
    // "ERROR: id not found" with no mention of which id or which tool, which
    // read as if cld itself had failed. We reword it below with the context.
    const out = execFileSync(resolveBash(), [secretScript, "getsecret", id], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const value = out.trim();
    if (!value) {
      return { ok: false, missing: false, reason: `secret '${id}' exists but its value is empty` };
    }
    return { ok: true, value };
  } catch (e: any) {
    const stderr = String(e?.stderr ?? "").trim();
    if (/id not found/i.test(stderr)) {
      return { ok: false, missing: true, reason: `no secret named '${id}' in the store` };
    }
    return {
      ok: false,
      missing: false,
      reason: stderr || `\`bash ~/.ssh/secret.sh getsecret ${id}\` failed with no output`,
    };
  }
}

// How to fix a missing/broken secret - shown alongside whatever `reason`
// getSecret returned, so the message says what went wrong AND what to do.
export function secretHint(id: string): string {
  return id
    ? `  fix: bash ~/.ssh/secret.sh add ${id}    (list existing: bash ~/.ssh/secret.sh list)`
    : `  fix: set secret_key_name for this instance in anthropic_instances.yaml`;
}

// ── CLD_BIN copy-trick ────────────────────────────────────────────────────
// Proxifier forces a SOCKS proxy on any process whose binary is named
// `claude`. Copying that binary to `cld` in the same directory and
// launching that instead lets the CLI reach the network directly. Fatal on
// mac/Linux (proven, load-bearing today); non-fatal on Windows (unverified
// whether Clash Verge keys on process name the same way).
//
// Finding the binary to copy is NOT a plain PATH scan: mise's shims dir
// (~/AppData/Local/mise/shims on Windows) holds a generic dispatcher stub
// per bin name, byte-identical regardless of name, which decides what to
// run by reading its OWN filename. A raw findInPath("claude") lands on that
// stub whenever the shims dir precedes the versioned install dir on PATH
// (any shell without mise's install-dir PATH prepending, i.e. no
// `mise activate`) - copying it to `cldbin` just yields another dispatcher
// stub for a name mise never registered, which fails with "No version is
// set for shim: cldbin" no matter how it's invoked. `mise which claude`
// resolves straight to the real installed binary regardless of PATH order,
// so prefer it and only fall back to the PATH scan if mise itself isn't
// on PATH.
function findRealClaudeBinary(): string | null {
  try {
    const out = execFileSync("mise", ["which", "claude"], { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return findInPath("claude");
}

export function resolveClaudeBinary(): string {
  const claudeBin = findRealClaudeBinary();
  if (!claudeBin) {
    console.error("ERROR: claude binary not found in PATH");
    process.exit(1);
  }
  const dir = path.dirname(claudeBin);
  const ext = path.extname(claudeBin);
  // Named "cldbin", not "cld": that install dir sits earlier in PATH than
  // ~/.dotc/bin, and the launcher itself is now named "cld" there - reusing
  // the same name here would shadow the launcher for anyone typing bare `cld`.
  const cldBin = path.join(dir, "cldbin" + ext);

  try {
    const srcStat = statSync(claudeBin);
    let needsCopy = true;
    try {
      needsCopy = srcStat.mtimeMs > statSync(cldBin).mtimeMs;
    } catch {}
    if (needsCopy) {
      copyFileSync(claudeBin, cldBin);
      if (!IS_WIN) chmodSync(cldBin, srcStat.mode);
    }
    return cldBin;
  } catch (e) {
    const msg = `failed to mirror ${claudeBin} -> ${cldBin}: ${e}`;
    if (IS_WIN) {
      console.error(`WARNING: ${msg} (non-fatal on Windows, continuing with original claude binary)`);
      return claudeBin;
    }
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }
}

// ── live model-list probe (ported from cld_lib.sh cld_fetch_live_models) ──
const ANTHROPIC_VERSION = "2023-06-01";

function modelsUrlFromBase(baseUrl: string): string {
  let url = baseUrl.replace(/\/$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  return url + "/models";
}

function curlGet(url: string, headers: string[], timeoutSec = 10): { status: string; body: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "cld-"));
  const tmp = path.join(dir, "body");
  let status = "000";
  try {
    const args = ["-sS", "-o", tmp, "-w", "%{http_code}", "--max-time", String(timeoutSec)];
    // Windows curl builds use Schannel, which does an online CRL/OCSP check
    // during the TLS handshake; when that check's own server is unreachable
    // (seen against openrouter.ai: curl exit 35, CRYPT_E_REVOCATION_OFFLINE),
    // Schannel hard-fails the connection rather than just skipping the check.
    // --ssl-revoke-best-effort tells it to proceed anyway when the check
    // itself can't complete (not a downgrade of cert validation). Unsupported
    // on the OpenSSL/LibreSSL backends mac/Linux curl normally ships with, so
    // Windows-only.
    if (IS_WIN) args.push("--ssl-revoke-best-effort");
    for (const h of headers) args.push("-H", h);
    args.push(url);
    status = execFileSync("curl", args, { encoding: "utf8" }).trim();
  } catch {}
  let body = "";
  try {
    body = readFileSync(tmp, "utf8");
  } catch {}
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  return { status, body };
}

function isAnthropicModelsShape(body: string): boolean {
  try {
    const j = JSON.parse(body);
    return j?.data?.[0]?.type === "model";
  } catch {
    return false;
  }
}

function isOpenAIModelsShape(body: string): boolean {
  try {
    const j = JSON.parse(body);
    if (j?.object === "list") return true;
    if (j?.data?.[0]?.object === "model") return true;
    return Array.isArray(j?.data) && j.data.length > 0 && !!j.data[0]?.id;
  } catch {
    return false;
  }
}

// Per-model context/output-token limits, when the provider's /models
// response happens to include them (OpenRouter, Kimi/moonshot,
// cliproxyapi's Anthropic-shaped listing all do; most OpenAI-compatible
// listings only return {id, object, created, owned_by} and expose neither -
// those models fall back to the caller's own placeholder defaults).
export interface LiveModel {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  // Most providers' /models listings don't say anything about capabilities -
  // undefined here means "unknown", not "unsupported"; the caller decides
  // the fallback (see index.ts's toModelConfigs).
  reasoning?: boolean;
  images?: boolean;
}

function toNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Every provider spells the same three facts differently, so accept all the
// spellings seen in the wild - a provider that DOES publish its limits must
// not get silently downgraded to the caller's placeholder defaults (that's
// what made DeepSeek's 1M models show up as 128K):
//   context window: context_length (Kimi) | max_input_tokens (cliproxyapi)
//                   | context_window (DeepSeek)
//                   | token_limits.context_window (Volcengine)
//   output cap:     top_provider.max_completion_tokens (OpenRouter)
//                   | max_tokens | max_output_tokens (DeepSeek)
//                   | token_limits.max_output_token_length (Volcengine)
//   reasoning:      supports_reasoning (Kimi) | supported_parameters
//                   (OpenRouter) | effort.supported_levels (DeepSeek)
//                   | token_limits.max_reasoning_token_length (Volcengine)
//   image input:    supports_image_in (Kimi) | architecture.input_modalities
//                   (OpenRouter) | input_modalities (DeepSeek)
//                   | modalities.input_modalities (Volcengine)
// The Anthropic- and OpenAI-shaped listings both put the models in a `data`
// array, so one parser covers both probes - only the `source` label differs.
function contextWindowOf(m: any): number | undefined {
  return (
    toNumber(m.context_length) ??
    toNumber(m.max_input_tokens) ??
    toNumber(m.context_window) ??
    toNumber(m.token_limits?.context_window) ??
    toNumber(m.token_limits?.max_input_token_length)
  );
}

function maxTokensOf(m: any): number | undefined {
  return (
    toNumber(m.top_provider?.max_completion_tokens) ??
    toNumber(m.max_tokens) ??
    toNumber(m.max_output_tokens) ??
    toNumber(m.token_limits?.max_output_token_length)
  );
}

function reasoningOf(m: any): boolean | undefined {
  if (typeof m.supports_reasoning === "boolean") return m.supports_reasoning;
  if (Array.isArray(m.supported_parameters)) return m.supported_parameters.includes("reasoning");
  if (Array.isArray(m.effort?.supported_levels)) return m.effort.supported_levels.length > 0;
  // Volcengine publishes max_reasoning_token_length only for models that
  // actually reason, so its presence is the signal - but only for entries
  // that fill token_limits at all (a retired model's `{}` says nothing).
  if (toNumber(m.token_limits?.context_window) !== undefined) {
    return toNumber(m.token_limits?.max_reasoning_token_length) !== undefined;
  }
  return undefined;
}

function imagesOf(m: any): boolean | undefined {
  if (typeof m.supports_image_in === "boolean") return m.supports_image_in;
  const modalities =
    m.architecture?.input_modalities ?? m.modalities?.input_modalities ?? m.input_modalities;
  return Array.isArray(modalities) ? modalities.includes("image") : undefined;
}

// Volcengine and Tencent list models that are no longer callable alongside
// the live ones (69 of Volcengine's 135 entries are "Shutdown"). Registering
// those puts dead ids in the model picker that only fail at request time.
// Drop the terminal states only: a model merely SCHEDULED for retirement
// (Volcengine "Retiring", Tencent "pre-offline") still serves requests today,
// and an unrecognised status is never a reason to hide a model.
const RETIRED_STATUSES = new Set(["shutdown", "offline", "deprecated", "removed", "unavailable"]);

function isRetired(m: any): boolean {
  if (typeof m.status !== "string") return false;
  return RETIRED_STATUSES.has(m.status.toLowerCase().replace(/[\s_-]/g, ""));
}

export function parseModelList(body: string): LiveModel[] {
  const data = JSON.parse(body).data ?? [];
  return data.filter((m: any) => !isRetired(m)).map((m: any) => ({
    id: String(m.id),
    contextWindow: contextWindowOf(m),
    maxTokens: maxTokensOf(m),
    reasoning: reasoningOf(m),
    images: imagesOf(m),
  }));
}

export type LiveModelsResult =
  | { ok: true; ids: string[]; models: LiveModel[]; source: "anthropic" | "openai"; url: string }
  | { ok: false; error: string; url: string };

export function fetchLiveModels(baseUrl: string, apiKey: string, modelsUrlOverride: string): LiveModelsResult {
  const url = modelsUrlOverride || modelsUrlFromBase(baseUrl);
  // Be explicit that no request was made - "no api key available" alone read as
  // if the query had run and come back empty.
  if (!apiKey) return { ok: false, error: `skipped, no API key to authenticate with (would have queried ${url})`, url };

  const a = curlGet(url, [`x-api-key: ${apiKey}`, `anthropic-version: ${ANTHROPIC_VERSION}`]);
  if (a.status === "200" && isAnthropicModelsShape(a.body)) {
    const models = parseModelList(a.body);
    return { ok: true, ids: models.map((m) => m.id), models, source: "anthropic", url };
  }

  const o = curlGet(url, [`Authorization: Bearer ${apiKey}`]);
  if (o.status === "200" && isOpenAIModelsShape(o.body)) {
    const models = parseModelList(o.body);
    return { ok: true, ids: models.map((m) => m.id), models, source: "openai", url };
  }

  return { ok: false, error: `anthropic-probe HTTP ${a.status}; openai-probe HTTP ${o.status}`, url };
}

// ── max_context_ref: models.dev-shaped catalog for correcting placeholder
// context/output limits ─────────────────────────────────────────────────
// Providers whose own /models listing doesn't publish context/output limits
// at all (most OpenAI-compatible ones - see contextWindowOf/maxTokensOf
// above) can set `max_context_ref: <url>` in anthropic_providers.yaml,
// pointing at a models.dev-shaped catalog:
//   { [vendor]: { models: { [modelId]: { limit: { context, output } } } } }
// The same model id is often listed under many resold vendors with
// slightly different numbers (typos, a reseller's own smaller cap, stale
// entries) - lookupContextRef() takes the MODE across all matches rather
// than min/max/first, so a couple of outliers don't skew the result. Ties
// break toward the SMALLER value: this feeds a coding agent's context-window
// budget, and overestimating it risks a real context-length-exceeded error
// mid-task through whatever channel a request happens to route to (observed
// first-hand while probing globalai.vip's deepseek-v4-flash) - underestimating
// only wastes headroom / triggers compaction a bit early, the safer failure
// mode. Matching is exact-id only, deliberately no fuzzy aliasing: a wrong
// correction is worse than no correction.
export interface ContextRefEntry {
  context?: number;
  output?: number;
}

export type ContextRefCatalog = Map<string, ContextRefEntry[]>;

export function parseContextRefCatalog(body: string): ContextRefCatalog {
  const data = JSON.parse(body) ?? {};
  const byModel: ContextRefCatalog = new Map();
  for (const vendor of Object.values(data) as any[]) {
    const models = vendor?.models ?? {};
    for (const [modelId, m] of Object.entries(models as Record<string, any>)) {
      const context = toNumber(m?.limit?.context);
      const output = toNumber(m?.limit?.output);
      if (context === undefined && output === undefined) continue;
      const list = byModel.get(modelId) ?? [];
      list.push({ context, output });
      byModel.set(modelId, list);
    }
  }
  return byModel;
}

function mode(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = -1;
  for (const [v, c] of counts) {
    const better = c > bestCount || (c === bestCount && best !== undefined && v < best);
    if (better) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

export function lookupContextRef(catalog: ContextRefCatalog, modelId: string): ContextRefEntry {
  const entries = catalog.get(modelId);
  if (!entries) return { context: undefined, output: undefined };
  return {
    context: mode(entries.map((e) => e.context).filter((v): v is number => v !== undefined)),
    output: mode(entries.map((e) => e.output).filter((v): v is number => v !== undefined)),
  };
}

export type ContextRefFetchResult =
  | { ok: true; catalog: ContextRefCatalog; url: string }
  | { ok: false; error: string; url: string };

export function fetchContextRefCatalog(url: string): ContextRefFetchResult {
  // models.dev's catalog is ~5MB - well past a small /models listing's 10s
  // budget, hence the longer timeout here.
  const { status, body } = curlGet(url, [], 30);
  if (status !== "200") return { ok: false, error: `HTTP ${status}`, url };
  try {
    return { ok: true, catalog: parseContextRefCatalog(body), url };
  } catch (e: any) {
    return { ok: false, error: `parse error: ${e?.message ?? String(e)}`, url };
  }
}

// ── context-ref disk cache + sync fetch (for cld-ts's CJS/no-await world) ─
// Shares cache dir AND file format with pi-exts/pi-yaml-providers/cache.ts
// (`_context_ref_<sanitized-url>.json` holding { fetchedAt, catalog }), so a
// catalog the pi extension already downloaded is reused here and vice versa.
// The pi-exts wrapper (contextRef.ts getContextRef) is async only for Promise
// in-flight de-dup - irrelevant to a single-shot CLI, hence this sync variant.
export const CONTEXT_REF_CACHE_DIR = path.join(homedir(), ".cache", "yaml-providers");

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
    return {
      fetchedAt: parsed.fetchedAt,
      catalog: new Map(Object.entries(parsed.catalog as Record<string, ContextRefEntry[]>)),
    };
  } catch {
    return null;
  }
}

export function writeContextRefCache(cacheDir: string, url: string, catalog: ContextRefCatalog): void {
  mkdirSync(cacheDir, { recursive: true });
  const file = contextRefCacheFile(cacheDir, url);
  writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), catalog: Object.fromEntries(catalog) }, null, 2));
}

export interface GetContextRefSyncOptions {
  cacheDir?: string;
  ttlMs?: number;
  now?: number;
  force?: boolean;
  fetchFn?: (url: string) => ContextRefFetchResult;
}

export interface GetContextRefSyncResult {
  catalog: ContextRefCatalog;
  warning?: string;
}

export function getContextRefSync(url: string, options: GetContextRefSyncOptions = {}): GetContextRefSyncResult {
  const cacheDir = options.cacheDir ?? CONTEXT_REF_CACHE_DIR;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? Date.now();
  const fetchFn = options.fetchFn ?? fetchContextRefCatalog;

  const cached = readContextRefCache(cacheDir, url);
  if (!options.force && cached && now - cached.fetchedAt < ttlMs) {
    return { catalog: cached.catalog };
  }

  const result = fetchFn(url);
  if (result.ok) {
    writeContextRefCache(cacheDir, url, result.catalog);
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

// ── Claude Code context-window hand-off ─────────────────────────────────
// How cld tells the claude child the real window of a gateway/custom model
// (see https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id):
//  - window >= 1M: append "[1m]" to the model ID. The suffix is a client-side
//    selector - claude strips it before serializing the request body and
//    expresses the opt-in via the `context-1m-2025-08-07` anthropic-beta
//    header instead, so the gateway sees the bare ID (anthropics/claude-code
//    #60913, maintainer-verified on v2.1.233).
//  - window < 1M on an unrecognized custom spelling (doesn't start with
//    "claude-" and contains no known claude-* model name): export
//    CLAUDE_CODE_MAX_CONTEXT_TOKENS=<window> at launch; it drives both the
//    status-line window and the auto-compact threshold (#68522).
//  - IDs claude resolves to a known model (e.g. "anthropic/claude-sonnet-5",
//    bare "claude-..." names): no override - claude uses its built-in
//    catalog, and MAX_CONTEXT_TOKENS would only apply with DISABLE_COMPACT.
export interface ClaudeContextResolution {
  modelId: string;
  maxContextTokens?: number;
  appended1m: boolean;
}

const CLAUDE_KNOWN_MODEL_NAME = /claude-(opus|sonnet|haiku|fable)-/i;
const ONE_M = 1_000_000;

export function resolveClaudeContextWindow(modelId: string, contextWindow: number | undefined): ClaudeContextResolution {
  const had1m = /(\[1m\])+$/i.test(modelId);
  const bare = modelId.replace(/(\[1m\])+$/i, "").trim();

  if (contextWindow === undefined) {
    return { modelId: had1m ? `${bare}[1m]` : bare, appended1m: false };
  }

  if (contextWindow >= ONE_M) {
    return { modelId: `${bare}[1m]`, appended1m: !had1m };
  }

  if (had1m) {
    // User already tagged the ID for 1M; MAX_CONTEXT_TOKENS doesn't apply to
    // [1m]-carrying IDs on its own (would need CLAUDE_CODE_DISABLE_1M_CONTEXT).
    return { modelId: `${bare}[1m]`, appended1m: false };
  }

  if (CLAUDE_KNOWN_MODEL_NAME.test(bare) || /^claude-/i.test(bare)) {
    return { modelId: bare, appended1m: false };
  }

  return { modelId: bare, maxContextTokens: contextWindow, appended1m: false };
}

// ── synchronous line prompt (no readline dependency - see design doc's
// flagged-for-smoke-test note on interactive stdio from a compiled binary) ─
export function promptSync(query: string): string {
  process.stdout.write(query);
  const buf = Buffer.alloc(1);
  let result = "";
  for (;;) {
    let n: number;
    try {
      n = require("fs").readSync(0, buf, 0, 1, null);
    } catch (e: any) {
      if (e?.code === "EAGAIN") continue;
      break;
    }
    if (n === 0) break;
    const ch = buf.toString("utf8");
    if (ch === "\n") break;
    if (ch === "\r") continue;
    result += ch;
  }
  return result;
}

// ── fzf-based picker (spawns fzf with candidates piped to its stdin,
// exactly like bash's `printf '%s\n' ... | fzf` - fzf opens the controlling
// tty itself for its UI, so this works even with stdin redirected) ────────
export function fzfPick(candidates: string[], opts: { prompt: string; header: string; query: string }): string | null {
  const fzfBin = findInPath("fzf");
  if (!fzfBin) return null;
  const res = spawnSync(
    fzfBin,
    [
      "--height=60%",
      "--layout=reverse",
      "--border",
      `--prompt=${opts.prompt}`,
      `--header=${opts.header}`,
      `--query=${opts.query}`,
    ],
    { input: candidates.join("\n") + "\n", stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
  );
  const pick = (res.stdout ?? "").trim();
  return pick || null;
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
