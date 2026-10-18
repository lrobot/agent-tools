// core.ts: cld launcher core logic, shared by mac/Linux (cld.sh) and Windows
// (cld.ps1) thin dispatchers. Compiled to a native binary via build.ts - see
// ~/.dotc/doc/design_cld_ts.md. Ported 1:1 from the bash reference (cld.sh).
//
// No top-level await anywhere in this file: `bun build --bytecode` compiles
// to CJS, which forbids it (see ~/.claude/statusline.ts for the same note).
// Everything here uses Node's synchronous APIs instead, so this constraint
// is a non-issue by construction.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import {
  MODEL_VARS,
  fetchLiveModels,
  findInPath,
  fzfPick,
  getSecret,
  promptSync,
  requireYq,
  resolveClaudeBinary,
  resolveInstancesYaml,
  resolveProvidersYaml,
  secretHint,
  yqGet,
  yqGetNested,
  yqKeys,
} from "../ts-lib/lib";

// ── argv parsing: `cld <instance> [claude args...]` ───────────────────────
// argv[2] is checked against live instance keys from the instances yaml
// (resolveInstancesYaml() - ~/.agent_instances.yaml by default);
// a match consumes it as the instance, everything else is a match miss and is
// treated as passthrough (default/official mode) - same as bare `cld` today.
function listInstances(instancesYaml: string): string[] {
  if (!existsSync(instancesYaml)) return [];
  return yqKeys(instancesYaml).filter((k) => !k.startsWith("_"));
}

function parseArgs(argv: string[], instancesYaml: string) {
  const first = argv[0] ?? "";
  if (listInstances(instancesYaml).includes(first)) {
    return { instance: first, rest: argv.slice(1) };
  }
  return { instance: "", rest: argv };
}

// An `undefined` override means "make sure the child does NOT see this var",
// not merely "don't set it" - the ambient environment may already carry it
// (a shell export, a parent cld session, ~/.claude/settings.json's "env").
// That matters most for the auth pair: claude warns "Both ANTHROPIC_AUTH_TOKEN
// and ANTHROPIC_API_KEY set" and picks unpredictably if both survive.
//
// Deleting by exact key is not enough on Windows, where env names are
// case-insensitive: `{...process.env}` is a plain object, so an inherited
// `Anthropic_Api_Key` would sail past `delete env.ANTHROPIC_API_KEY` and still
// reach the child as the same variable. Match case-insensitively there.
function buildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ci = process.platform === "win32";
  for (const [k, v] of Object.entries(overrides)) {
    // Drop any inherited spelling of this name first. On Windows that means a
    // case-insensitive sweep: `{...process.env}` is a plain (case-SENSITIVE)
    // object, so an ambient `Anthropic_Api_Key` would otherwise survive both
    // `delete env.ANTHROPIC_API_KEY` and `env.ANTHROPIC_API_KEY = ...`, then
    // reach the child as a duplicate of the same variable with an unpredictable
    // winner. Clearing before setting keeps exactly one spelling either way.
    delete env[k];
    if (ci) {
      const lower = k.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing.toLowerCase() === lower) delete env[existing];
      }
    }
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function launch(bin: string, args: string[], env: NodeJS.ProcessEnv): never {
  const res = spawnSync(bin, args, { stdio: "inherit", env });
  process.exit(res.status ?? 1);
}

// ── shell completion ───────────────────────────────────────────────────────
function completion(shell: string): void {
  if (shell === "bash") {
    console.log(`_cld_completion() {
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$(cld _instances 2>/dev/null) completion" -- "\${COMP_WORDS[1]}") )
  fi
}
complete -F _cld_completion cld`);
  } else if (shell === "zsh") {
    console.log(`#compdef cld
_cld() {
  local -a instances
  if (( CURRENT == 2 )); then
    instances=(\${(f)"$(cld _instances 2>/dev/null)"})
    _describe 'instance' instances
  fi
}
_cld`);
  } else if (shell === "pwsh" || shell === "powershell") {
    console.log(`Register-ArgumentCompleter -Native -CommandName cld -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  if ($commandAst.CommandElements.Count -le 2) {
    (& cld _instances) -split "\`n" | Where-Object { $_ -and $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}`);
  } else {
    console.error(`ERROR: unknown shell '${shell}' (expected: bash, zsh, pwsh)`);
    process.exit(1);
  }
}

// ── model select ──────────────────────────────────────────────────────────
// secretHelp is non-null when the API key couldn't be resolved; model-select
// still runs (the static yaml list needs no key), but if that fallback is also
// empty the missing secret is the actual thing to fix, so carry the diagnosis
// down here rather than reporting a bare "no models".
function runModelSelect(binDir: string, instance: string, provider: string, providersYaml: string, cfgYaml: string, baseUrl: string, apiKey: string, modelsUrl: string, secretHelp: { reason: string; hint: string } | null): void {
  console.log(`=== Model select for instance: ${instance} (provider: ${provider}) ===`);

  let ids: string[] = [];
  let names: string[] = [];
  let sourceLabel: string;

  const live = fetchLiveModels(baseUrl, apiKey, modelsUrl);
  if (live.ok) {
    ids = live.ids;
    names = live.ids;
    sourceLabel = `live ${live.source}-compatible API (${live.url})`;
  } else {
    // `.models // {}` matters: a provider with no models: block yields null,
    // and `null | keys` makes yq bail with "cannot get keys of !!null" - which
    // used to reach the terminal as a bare, unattributed line.
    names = yqGet(providersYaml, provider, ".models // {} | keys | .[]")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    ids = names.map((n) => yqGetNested(providersYaml, provider, n, "") || yqGet(providersYaml, provider, `.models["${n}"]`));
    sourceLabel = "static list in providers.yaml";
    // Report the reason unconditionally. This was previously gated on
    // `if (apiKey)`, so the one case where the user most needs to be told -
    // no key, hence no live query at all - was the one case that stayed silent.
    console.log(`(couldn't fetch a live model list: ${live.error} - falling back to ${sourceLabel})`);
  }

  if (ids.length === 0) {
    // Say which of the two sources failed and why, rather than asserting both
    // failed generically: with no API key the live query never even ran.
    console.error(`ERROR: no models available for instance '${instance}' (provider '${provider}').`);
    console.error(`  live query: ${live.error}`);
    console.error(`  static list: provider '${provider}' has no models: block in ${providersYaml}`);
    if (secretHelp) {
      console.error(secretHelp.reason);
      console.error(secretHelp.hint);
    }
    process.exit(1);
  }

  const display = ids.map((id, i) => (names[i] === id ? id : `${names[i]} -> ${id}`));
  const customSentinel = "* enter a custom model id manually";
  const useFzf = !!findInPath("fzf");

  console.log(`Available models for ${instance} (provider ${provider}, source: ${sourceLabel}, ${ids.length} total):`);
  if (!useFzf) {
    names.forEach((n, i) => {
      console.log(`  ${String(i + 1).padStart(2)}) ${n.padEnd(30)} -> ${ids[i]}`);
    });
    console.log("   0) enter a custom model id manually");
  }
  console.log("");

  const current: Record<string, string> = {};
  if (existsSync(cfgYaml)) {
    for (const v of MODEL_VARS) {
      const val = yqGetNested(cfgYaml, "models", v, "");
      if (val) current[v] = val;
    }
    console.log(`Loaded existing config: ${cfgYaml} (press Enter/Esc to keep current value)`);
  }

  const chosen: Record<string, string> = {};
  for (const v of MODEL_VARS) {
    const currentVal = current[v] ?? "";
    const defaultVal = currentVal || ids[0];

    if (useFzf) {
      const pick = fzfPick([...display, customSentinel], {
        prompt: `${v} > `,
        header: `current: ${currentVal || "none"} | type to filter, Enter to pick, Esc to keep current`,
        query: currentVal,
      });
      if (!pick) chosen[v] = defaultVal;
      else if (pick === customSentinel) chosen[v] = promptSync(`  enter custom model id for ${v}: `);
      else chosen[v] = pick.includes(" -> ") ? pick.split(" -> ").slice(-1)[0] : pick;
    } else {
      const sel = promptSync(`Select model for ${v} [current: ${currentVal || "none"}] (number, or blank for '${defaultVal}'): `);
      if (!sel) chosen[v] = defaultVal;
      else if (sel === "0") chosen[v] = promptSync(`  enter custom model id for ${v}: `);
      else if (/^[0-9]+$/.test(sel) && Number(sel) >= 1 && Number(sel) <= ids.length) chosen[v] = ids[Number(sel) - 1];
      else chosen[v] = sel;
    }
  }

  const lines = [`instance: ${instance}`, `provider: ${provider}`, "models:"];
  for (const v of MODEL_VARS) lines.push(`  ${v}: "${chosen[v]}"`);
  writeFileSync(cfgYaml, lines.join("\n") + "\n", "utf8");

  console.log("");
  console.log(`Saved: ${cfgYaml}`);
}

// ── main ──────────────────────────────────────────────────────────────────
function main(): void {
  const binDir = path.dirname(process.execPath);
  const providersYaml = resolveProvidersYaml();
  const instancesYaml = resolveInstancesYaml();

  const argv = process.argv.slice(2);
  if (argv[0] === "completion") {
    completion(argv[1] ?? "");
    return;
  }
  if (argv[0] === "_instances") {
    for (const inst of listInstances(instancesYaml)) console.log(inst);
    return;
  }

  const parsed = parseArgs(argv, instancesYaml);
  const instance = parsed.instance;

  // --- default/official mode: no instance ---
  if (!instance) {
    const claudeBin = resolveClaudeBinary();
    const env = buildEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_BASE_URL: undefined,
      ANTHROPIC_MODEL: undefined,
      ANTHROPIC_SMALL_FAST_MODEL: undefined,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined,
      ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
      ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
      CLAUDE_CODE_SUBAGENT_MODEL: undefined,
    });
    launch(claudeBin, parsed.rest, env);
    return;
  }

  requireYq();

  if (!yqGet(instancesYaml, instance)) {
    console.error(`ERROR: instance '${instance}' not found in ${instancesYaml}`);
    process.exit(1);
  }

  const provider = yqGet(instancesYaml, instance, ".provider_name // \"\"");
  if (!yqGet(providersYaml, provider, ".base_url // \"\"")) {
    console.error(`ERROR: provider '${provider}' (referenced by instance '${instance}') not found in ${providersYaml}`);
    process.exit(1);
  }
  const baseUrl = yqGet(providersYaml, provider, ".base_url");
  const modelsUrl = yqGet(providersYaml, provider, ".models_url // \"\"");
  const secretId = yqGet(instancesYaml, instance, ".secret_key_name // \"\"");
  // Soft fetch: don't fail here if the secret doesn't exist yet - modelselect
  // can still run (falling back to the static yaml list); only launch requires a key.
  const secret = getSecret(secretId);
  const apiKey = secret.ok ? secret.value : "";
  const secretHelp = secret.ok
    ? null
    : { reason: `  api key: ${secret.reason}`, hint: secretHint(secretId) };

  const cfgYaml = path.join(binDir, `cld.${instance}.yaml`);

  if (parsed.rest[0] === "_modelselect") {
    runModelSelect(binDir, instance, provider, providersYaml, cfgYaml, baseUrl, apiKey, modelsUrl, secretHelp);
    return;
  }

  if (!existsSync(cfgYaml)) {
    console.log(`No model config found for provider '${provider}', running first-time setup...`);
    runModelSelect(binDir, instance, provider, providersYaml, cfgYaml, baseUrl, apiKey, modelsUrl, secretHelp);
  }

  if (!secret.ok) {
    console.error(`ERROR: no API key for instance '${instance}': ${secret.reason}`);
    console.error(secretHint(secretId));
    process.exit(1);
  }

  // Some providers authenticate via Bearer (Authorization) rather than
  // x-api-key. secret_use_as_auth_token=true -> ANTHROPIC_AUTH_TOKEN (Bearer);
  // otherwise -> ANTHROPIC_API_KEY (x-api-key). Exactly one is set and the
  // other is explicitly cleared - claude warns "Both ANTHROPIC_AUTH_TOKEN and
  // ANTHROPIC_API_KEY set - auth may not work as expected" if it inherits the
  // other one from the ambient environment (e.g. ~/.claude/settings.json's
  // "env" block, a parent cld session, or a shell export).
  const useAuthToken = yqGet(providersYaml, provider, ".secret_use_as_auth_token // false") === "true";

  const modelEnv: Record<string, string | undefined> = {};
  for (const v of MODEL_VARS) {
    const val = yqGetNested(cfgYaml, "models", v, "");
    if (!val) {
      console.error(`ERROR: ${v} not set in ${cfgYaml}, run: cld ${instance} _modelselect`);
      process.exit(1);
    }
    modelEnv[v] = val;
  }

  const claudeConfigDir = path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude");
  mkdirSync(claudeConfigDir, { recursive: true });

  const claudeBin = resolveClaudeBinary();
  const env = buildEnv({
    ANTHROPIC_BASE_URL: baseUrl,
    // Exactly one of the pair is set; the other is `undefined`, which buildEnv
    // treats as "delete it from the child env" rather than "leave it alone".
    ANTHROPIC_AUTH_TOKEN: useAuthToken ? apiKey : undefined,
    ANTHROPIC_API_KEY: useAuthToken ? undefined : apiKey,
    ...modelEnv,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CLAUDE_CODE_AUTO_MODE_SERVER: "0",
  });

  console.log(`instance: ${instance}  provider: ${provider}`);
  console.log(`base_url: ${baseUrl}`);
  console.log(
    useAuthToken
      ? "auth: ANTHROPIC_AUTH_TOKEN (Bearer), ANTHROPIC_API_KEY cleared"
      : "auth: ANTHROPIC_API_KEY (x-api-key), ANTHROPIC_AUTH_TOKEN cleared",
  );
  console.log(`models (from ${cfgYaml}):`);
  for (const v of MODEL_VARS) console.log(`  ${v}=${modelEnv[v]}`);

  launch(claudeBin, ["--dangerously-skip-permissions", ...parsed.rest], env);
}

main();
