# Design: Multi-Backend Failover + TOML Config for pi-tier-router

Status: confirmed (pro-exhausted policy: hard error, no degrade to flash)
Scope: modify the local clone at `/opt/ops/agent-tools/pi-exts/pi-tier-router`

## Goals (confirmed)

1. Each tier (`flash` / `pro`) backs onto a **list of real models** instead of a single model.
2. **Failover**: only on request failure (`request.reason === "retry"`, with `request.failed`),
   advance to the next model **within the same tier**. No active health checks, no round-robin.
3. **Keep the existing two-tier difficulty routing logic untouched**:
   local signal router -> decision store (k-NN) -> flash self-rating -> optional Jev -> keep.
   The chain still outputs a binary `flash | pro` decision; only the tier -> physical model
   resolution changes.
4. Config format: **TOML instead of JSON**, parsed with the `smol-toml` npm dependency.

## Config

### New file: `auto-router.toml` (next to the extension file, replacing `auto-router.json`)

```toml
# auto-router config: two tiers, each an ordered failover list.
# First entry with valid credentials is the primary; later entries are
# failover candidates used only when a request on an earlier one fails.

[tier.flash]
models = [
  "deepseek/deepseek-v4-flash",
  "openai/gpt-4o-mini",
]

[tier.pro]
models = [
  "deepseek/deepseek-v4-pro",
  "anthropic/claude-sonnet-4-5",
]
```

- Values keep the existing `provider/model-id` format (split on first slash, `parseRole` reused).
- Empty / missing list for a tier falls back to the existing MiMo default for that tier
  (current behavior for malformed keys, preserved).
- Malformed TOML -> treated as missing config (router inactive), same fail-safe posture as
  today's malformed JSON.

### Migration from JSON

On extension load (before roles are read, same place `migrateLegacyConfig()` runs today):

1. If `auto-router.toml` exists -> use it. Done.
2. Else if `auto-router.json` exists -> convert: each of `flash-model` / `pro-model`
   becomes a single-element `models` list in the TOML, write `auto-router.toml`,
   delete the JSON file. Debug-log the migration.
3. Else -> no config; `/auto-router` wizard creates the TOML.

`writeOwnConfig` is replaced by `writeOwnConfigToml(flashModels: string[], proModels: string[])`.
The legacy-config cleanup logic (`legacyConfigFile`, `samePath`) is kept but pointed at
both `auto-router.toml` and `auto-router.json`.

## Data model changes (extensions/index.ts)

```ts
// today
let ROLES: { flash: Role; pro: Role }

// after
let ROLES: { flash: Role[]; pro: Role[] }   // ordered failover lists
```

- `readRoles()` parses the TOML into two `Role[]` lists (filtering malformed entries;
  a tier with zero valid entries falls back to `[DEFAULT_FLASH]` / `[DEFAULT_PRO]`).
- `refreshRoles()` compares lists by joined `provider/id` strings.
- `isRole(model, tierList)` -> `tierList.some(r => match)`.

### State: track which list entry is active

```ts
interface AutoState {
  rated: Difficulty;
  source?: RatingSource;
  offset?: number;   // index into ROLES[rated]; 0/undefined = primary
}
```

`offset` is stored per session branch (Pi persists `route()` state), so after a failover
the tool-loop continuations and later turns keep using the failed-over model
(prompt cache stays warm) instead of snapping back to the primary.

## Routing changes

### resolvePair -> tier-level availability

```
resolveTiers(registry):
  flash tier OK  = any model in ROLES.flash with registry entry + configured auth
  pro tier OK    = same for ROLES.pro, and the two tiers are not identical lists
  (a single shared list means there is nothing to switch between -> disabled, as today)
```

The router stays enabled as long as **each tier has at least one usable model**.

### routeTo: pick primary by default

```ts
function routeTo(request, ctx, rated, state?):
  const list = ROLES[rated]
  const idx  = state?.offset ?? 0
  const role = firstUsableFrom(list, idx, ctx.modelRegistry)   // auth-checked
  ...
```

### Failover path (the only new decision logic)

At the top of `routeVirtual`, before the PENDING/rating chain:

```
if (request.reason === "retry" && request.failed):
  failedModel = request.failed.model
  tier = tierOf(failedModel)            // flash | pro | undefined
  if tier:
    next = nextUsableAfter(ROLES[tier], failedModel, registry)
    if next:
      stats.failover++
      return { model: next.model, thinkingLevel, state: { rated: tier, offset: next.idx } }
    // tier exhausted -> stop, per confirmed policy:
    // pro list exhausted: NO degrade to flash. The retry proceeds with the last
    // pro model (its own retry), and when Pi's retry budget is spent the turn
    // ends with the provider's error. flash list exhausted falls through to the
    // normal path as well.
  // failed model is not one of ours (or no tier left): keep existing behavior
```

Notes:
- Failover triggers **only** on `reason === "retry"` with a `failed` record, per the confirmed
  strategy. First requests and continuations never skip a model that merely looks slow.
- **Exhausted tier = stop** (confirmed): when the failing model is the last entry of its tier
  list, the router does not substitute another tier. Pro failure never silently degrades to
  flash; the request fails and Pi surfaces the error.
- Failover skips models without configured auth (`hasConfiguredAuth`), consistent with
  `resolvePair` today.

### What deliberately does NOT change

- Local signal router (`LOCAL_SIGNALS`, `analyzePrompt`), decision store (ring + journal +
  k-NN), self-rating prompt/thresholds, Jev step, `PENDING` lifecycle, `agent_end` reset:
  all untouched. The chain output is still binary `flash | pro`.
- Self-rating (`rateWithSelf`) uses the **first usable flash model** (`ROLES.flash[0]`
  with auth) — unchanged semantics, just indexed.
- Compaction / `reason === "direct"` -> flash primary.
- `disabledRoute` fallback when tiers are unavailable.
- The decision store never records which physical model served — failover is invisible to it.

## Commands

| command | change |
|---|---|
| `/auto-router status` | prints both lists, one line per entry, with `ok` / `no-auth` / `missing` marks; pair check becomes tier check |
| `/auto-router set` | new syntax: `flash=a,b,c pro=x,y` (comma-separated lists); writes TOML; single value still valid |
| `/auto-router` (wizard) | keeps the two single-select prompts (flash primary, pro primary) and writes single-element TOML lists. Adding failover entries is done by editing the TOML or `/auto-router set`. (Pi's `ctx.ui.select` has no multi-select; a multi-pick wizard loop is possible but out of scope for v1.) |
| `/auto-router memory [reset]` | unchanged |

## Dependency: smol-toml

- Add `"smol-toml": "^1.x"` to `package.json` dependencies; `pnpm install` in the repo.
- Import: `import { parse } from "smol-toml"` (ESM, works with Node >= 23 native TS).
- npm-installed copies of the extension get the dependency automatically; for the
  git-clone install path the extension dir must contain `node_modules` (documented in README).
- Only `parse` is used (read path). Writing config is done with a small template string —
  the config shape is fixed, so no serializer dependency is needed.

## Tests (extensions/auto-router.test.ts)

Update/add:
- TOML parsing: valid lists, malformed TOML, empty list -> default fallback, JSON -> TOML migration.
- `resolveTiers`: partial availability (one tier's models all missing -> disabled).
- Failover: retry advances within tier; auth-less entries skipped; pro exhausted -> flash;
  offset persisted via returned `state`; continuations reuse `state.offset`.
- Existing chain tests (local/memory/self/jev/keep) should pass unchanged except config helpers.

## Out of scope

- N arbitrary tiers (confirmed: two tiers only).
- Active health checks / round-robin / per-session sticky failover beyond `state.offset`.
- Multi-select wizard.

## Confirmed decisions

1. ~~pro tier exhausted -> degrade to flash~~ **No**: pro failure stops (fails the turn),
   never degrades to flash. Implemented in the failover path.
