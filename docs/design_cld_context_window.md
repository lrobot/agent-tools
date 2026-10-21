# cld context-window detection (design)

How `cld` stops Claude Code from assuming 200K for gateway/custom model IDs.

## Problem

Every cld instance routes Claude Code at a gateway via `ANTHROPIC_BASE_URL` with
custom model IDs (`deepseek-v4.1-flash`, `glm-5.2`, `kimi-for-coding`, ...).
Claude Code doesn't recognize those IDs, so it assumes a 200K context window and
auto-compacts there
(<https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id>).
Most of these models actually have 256K-1M windows, so sessions compacted far too
early.

## How Claude Code learns the real window (v2.1.x, verified)

For sessions behind `ANTHROPIC_BASE_URL`:

1. A model ID carrying the `[1m]` suffix is assumed to have a 1M window. The
   suffix is a **client-side selector**: claude strips it before serializing the
   request body and expresses the opt-in via the `context-1m-2025-08-07`
   `anthropic-beta` header, so the gateway sees the bare ID
   (anthropics/claude-code#60913, maintainer-verified on v2.1.233; confirmed
   again by wire capture on v2.1.302 during this change's smoke test).
2. `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<n>` overrides the assumed window for an
   **unrecognized custom spelling** (doesn't start with `claude-` and contains
   no known claude model name). It drives both the status-line window and the
   auto-compact threshold (#68522). For IDs that resolve to a known Claude
   model it only applies together with `DISABLE_COMPACT`, so we never set it
   for those.
3. Recognized Claude IDs behind a gateway get the same window they have on the
   Anthropic API - no override needed.

## What cld does

### `_modelselect` (detection + persistence)

1. `fetchLiveModels` already returns per-model `contextWindow`/`maxTokens`
   parsed from the provider's `/models` listing; core.ts now keeps them
   (`liveById`) instead of discarding everything but `ids`.
2. If the provider sets `max_context_ref` in providers.yaml, the catalog is
   loaded through `getContextRefSync` (new in ts-lib) as a fallback for models
   whose live listing carries no limits. Precedence: **live > max_context_ref**,
   same as pi-exts/yaml-providers. The disk cache (`~/.cache/yaml-providers`,
   `_context_ref_<url>.json`) is shared with the pi extension, so the catalog
   is usually warm and the (30s-timeout) fetch rarely blocks.
3. For each chosen model var, `resolveClaudeContextWindow(id, window)` decides:
   - `window >= 1M` -> write the model ID to the yaml **with `[1m]` appended**
     (no env needed at launch; claude strips the suffix before the wire).
   - known window < 1M -> record it under a new optional `context:` section.
   - unknown window -> write the ID as-is (previous behavior).
   The picks, suffixes, and detected windows are printed after saving.

Resulting `cld.<instance>.yaml` (backward compatible - the section is optional
and old files simply have no context data):

```yaml
instance: globalaijc
provider: globalai
models:
  ANTHROPIC_MODEL: "deepseek-v4.1-flash[1m]"
  ...
context:                      # only present when a sub-1M window was detected
  ANTHROPIC_MODEL: 262144
```

### launch (injection)

- If the primary `ANTHROPIC_MODEL` has a `context:` entry,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<window>` is exported to the child.
  `resolveClaudeContextWindow` re-applies the guards, so nothing is exported
  for `[1m]`-tagged or claude-recognized IDs. When no window applies, the var
  is explicitly **deleted** from the child env (buildEnv `undefined`
  semantics), so a stale value from a parent cld session can't leak across
  instances. The effective setting is printed before launch (`context: ...`).
- A single global var can only carry one value; it follows the **primary**
  model's window. Other slots' windows still matter: any of their IDs with a
  >=1M window got its own `[1m]` suffix at modelselect time, which claude
  honors per-ID.
- Official/default mode (no instance) also clears
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` and `ANTHROPIC_DEFAULT_FABLE_MODEL`
  alongside the other ANTHROPIC_* vars.

### Backward-compatibility fix bundled in

`MODEL_VARS` gained `ANTHROPIC_DEFAULT_FABLE_MODEL` after existing
`cld.*.yaml` files were written, and the old strict check made launching them
fatal. Missing optional vars are now skipped; only `ANTHROPIC_MODEL` remains
mandatory.

## Files

- `ts-lib/lib.ts` - `getContextRefSync` (+ shared cache read/write),
  `resolveClaudeContextWindow`.
- `ts-lib/lib.test.ts` - unit tests for both (23 tests total).
- `cld-ts/core.ts` - modelselect persistence + launch injection.

## Smoke-test evidence (v2.1.302, local mock gateway)

- `test-model-pro` (live `context_window: 262144`): yaml got
  `context: 262144`; launch printed `CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144`;
  mock received `{"model":"test-model-pro"}` with no 1m beta flag.
- `test-model-1m` (`context_window: 1048576`): yaml got
  `"test-model-1m[1m]"`; mock received `{"model":"test-model-1m"}` (suffix
  stripped) **with** `anthropic-beta: ...,context-1m-2025-08-07,...`.
- `test-model-nolimit` (no live limits, provider has `max_context_ref`):
  ref catalog's 131072 was used.
- Legacy yaml without `context:`/FABLE launches unchanged.
