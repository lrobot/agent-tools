# OAuth explicit proxy design

## Intent

Ensure every OAuth request made with Undici uses the Antigravity proxy configured in `~/.pi/agent/proxy-router.json`. Do not use proxy environment variables and do not change the host process's global dispatcher.

## Current problem

`src/auth/oauth.ts` has three Undici fetch call sites:

1. Login token exchange.
2. Login userinfo lookup.
3. Token refresh.

Only token refresh attempts proxy handling, and it does so by temporarily setting `HTTP_PROXY` and `HTTPS_PROXY`. A local controlled experiment against the installed `undici@8.11.2` confirmed that this environment mutation does not route its directly imported `fetch` through the proxy. Passing `new ProxyAgent(proxyUrl)` as the request `dispatcher` did route the same request through the proxy.

## Approaches

- Temporary environment variables: rejected because the installed Undici fetch does not consume them reliably, and process-wide mutation can race with unrelated requests.
- Global `setGlobalDispatcher`: rejected because it changes networking for the whole Pi process and other extensions.
- Per-request local `ProxyAgent` dispatcher: selected because Undici explicitly supports it, it satisfies the no-environment-variable requirement, and its scope is limited to OAuth requests.

## Design

- Keep reading `auth.antigravity` from the existing proxy-router configuration.
- Add one OAuth fetch wrapper in `src/auth/oauth.ts`.
- Cache the `ProxyAgent` by normalized configuration value so requests reuse proxy connections. If the configured proxy changes, close the previous agent without awaiting it in the request path.
- When a proxy is configured, call Undici fetch with `{ ...init, dispatcher: proxyAgent }`. Without a proxy, preserve direct Undici fetch behavior.
- Route login token exchange, userinfo, and token refresh through the wrapper.
- Log proxy activation once per distinct proxy URL. Log only the proxy URL origin with credentials, path, query, and fragment removed; never log OAuth tokens or request bodies.
- Do not modify `src/utils/http.ts` or unrelated provider API behavior in this change.

## Verification

- Add regression coverage that fails with the current environment-variable implementation.
- Exercise login token exchange and userinfo, plus token refresh, while observing the dispatcher boundary.
- Verify direct behavior remains intact when no auth proxy is configured.
- Retain the existing gzip success/error coverage by isolating its home configuration.
- Run focused tests, the complete test suite, typecheck, lint, and formatting checks.
- Inspect runtime logs and the final diff for secret leakage or missed direct `oauthFetch` call sites.
