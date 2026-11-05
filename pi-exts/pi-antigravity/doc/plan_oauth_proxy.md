# OAuth Explicit Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route all three Undici OAuth requests through the configured Antigravity `ProxyAgent` without using proxy environment variables.

**Architecture:** A single OAuth fetch wrapper owns proxy configuration and a cached local `ProxyAgent`. Every existing OAuth request passes through that wrapper; no global dispatcher or process environment mutation is used.

**Tech Stack:** TypeScript, Node.js 22+, Undici 8.11.2, Node assert-based test scripts.

**Spec:** `doc/design_oauth_proxy.md`

## Global Constraints

- Read the proxy only from `~/.pi/agent/proxy-router.json` at `auth.antigravity`.
- Never set `HTTP_PROXY`, `HTTPS_PROXY`, or other proxy environment variables.
- Never call `setGlobalDispatcher` for OAuth.
- Use two-space indentation and preserve the existing module style.
- Do not log credentials, proxy userinfo, OAuth tokens, or request bodies.
- Do not change `src/utils/http.ts` or unrelated provider behavior.

## Review Focus

- A configured proxy containing credentials must not expose them in activation logs; cover this in Task 1's login/refresh dispatcher test.
- Switching or removing proxy configuration must not leave stale agents selected; cover reconfiguration in Task 1's wrapper tests.
- A missing or unreadable proxy configuration must preserve direct fetch behavior; retain this in Task 2's isolated gzip tests.
- Concurrent OAuth calls must share configuration without mutating process-wide state; cover parallel login userinfo/project discovery and refresh call paths in Task 1.
- HTTPS OAuth endpoints must receive the local dispatcher on every call, not only refresh; enumerate all three observed request origins in Task 1.

---

### Task 1: Explicit OAuth proxy regression coverage

**Files:**

- Create: `scripts/test-oauth-proxy.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `loginAntigravity(callbacks)`, `refreshAntigravityToken(credentials)`, Undici `ProxyAgent.dispatch`, and `MockAgent`.
- Produces: Executable proof that login token exchange, userinfo, and refresh all select the configured local proxy dispatcher.

- [ ] **Step 1: Write the failing proxy test**

Create an isolated temporary `HOME` containing `auth.antigravity`. Use a real `ProxyAgent` with its dispatch boundary forwarded to a `MockAgent`, so no external network is used while the test observes request origins. Drive the local OAuth callback with Node HTTP, return controlled token/userinfo/project responses, then assert the observed OAuth paths are `/token` and `/oauth2/v1/userinfo?alt=json`. Call refresh separately and assert another `/token` dispatch. Capture activation logs and assert proxy username/password are absent. Assert the original proxy environment values remain untouched.

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/run-ts.mjs scripts/test-oauth-proxy.ts`
Expected: FAIL because no `ProxyAgent` dispatches occur; the existing implementation uses the global mock directly and refresh only mutates environment variables.

- [ ] **Step 3: Add the test to the package suite**

Add the focused script immediately before the existing OAuth fetch test in `package.json`'s `test` command so proxy behavior is checked before gzip compatibility.

### Task 2: Cached local ProxyAgent implementation

**Files:**

- Modify: `src/auth/oauth.ts`
- Modify: `scripts/test-oauth-fetch.ts`

**Interfaces:**

- Consumes: Undici `fetch`, `ProxyAgent`, and `RequestInit`.
- Produces: One internal OAuth fetch wrapper returning `Promise<Response>`; all three existing call sites use it.

- [ ] **Step 1: Implement the minimal wrapper**

Import `ProxyAgent` and its fetch request types from Undici. Cache one agent per exact configured proxy URL. On change, close the previous agent without blocking the request. Log only `new URL(proxyUrl).origin` once per distinct URL. Pass the agent through request-local `dispatcher`; omit it when no proxy is configured. Remove all environment-variable saving, mutation, and restoration.

- [ ] **Step 2: Route every OAuth call through the wrapper**

Replace the direct calls in `getUserEmail`, `loginAntigravity`, and `refreshAntigravityToken`. Keep the imported low-level Undici fetch only inside the wrapper so future direct call sites are easy to audit.

- [ ] **Step 3: Isolate the existing gzip test from user configuration**

Point `HOME` at a temporary directory with no proxy-router file for the duration of `scripts/test-oauth-fetch.ts`, restoring it afterward. This keeps its shared-dispatcher gzip assertions direct and deterministic.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node scripts/run-ts.mjs scripts/test-oauth-proxy.ts && node scripts/run-ts.mjs scripts/test-oauth-fetch.ts`
Expected: PASS; all OAuth operations select `ProxyAgent` when configured, direct gzip behavior remains intact, and logs contain no proxy credentials.

### Task 3: Full verification and audit

**Files:**

- Review: `src/auth/oauth.ts`, `scripts/test-oauth-proxy.ts`, `scripts/test-oauth-fetch.ts`, `package.json`

**Interfaces:**

- Consumes: Tasks 1 and 2.
- Produces: Fresh verification evidence and an audited final diff.

- [ ] **Step 1: Run project quality checks**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all commands exit 0. If formatting fails, run Prettier only on changed files and rerun the checks.

- [ ] **Step 2: Run the complete test suite**

Run: `pnpm test`
Expected: all existing and new test scripts pass with no failures.

- [ ] **Step 3: Audit proxy coverage and secret safety**

Run `rg` for `oauthFetch`, `ProxyAgent`, `HTTP_PROXY`, and `HTTPS_PROXY` in `src/auth/oauth.ts`. Confirm the low-level fetch occurs only in the wrapper, all three public flows use it, no proxy environment mutation remains, and logs contain only a sanitized origin. Review `git diff --check` and the final diff without committing or changing unrelated files.
