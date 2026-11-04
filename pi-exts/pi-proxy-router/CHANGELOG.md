# Changelog

## Unreleased

### Fixed

- Route built-in OAuth token requests through Pi's actual global `fetch`. Pi's bundled Undici and the extension's npm Undici copy have independent global dispatchers, so dispatcher-only auth routing could silently fall back to a direct connection. Covers both `openai` and `openai-codex` and preserves the native Bun HTTP proxy path.

## 1.3.0 - 2026-10-06

### Added

- Extension bridge on `globalThis.__piProxyRouter`: `fetchForOrigin`, `fetchForProvider`, `resolveForOrigin`, and `status`, so sibling extensions (e.g. `pi-usage` quota checks) can route their own HTTP calls through the same `models`/`auth` rules, `/allproxy`, and `/noproxy` state as model traffic. `undefined` means "no rule" and callers fall back to their default pipeline. See README "Extension bridge".

### Fixed

- Extension activation under plain Node ESM: bare `require` crashed with `ReferenceError: require is not defined in ES module scope`; npm undici is now loaded via `createRequire(import.meta.url)` (also fixed `node test.mjs` on a clean checkout).

## 1.2.4 - 2026-10-06

### Fixed

- Route non-chat requests for Pi 1.0 model APIs through the configured model proxy.

## 1.2.3 - 2026-09-23

### Fixed

- Prevent process-wide endpoint fallback from applying a proxy rule to models sharing a `baseUrl` when their model-level routing decisions differ.

## 1.2.2 - 2026-09-10

### Fixed

- Route all model API types through the current model registry instead of only `openai-responses` and `openai-codex-responses`.
- Keep model proxy rules effective for foreground subagents through process-wide endpoint routing, including Codex WebSocket-to-SSE fallback.
- Add built-in OAuth endpoint mappings for Anthropic, GitHub Copilot, Kimi Coding, OpenRouter, and xAI.
- Fail instead of silently connecting directly when a configured proxy URL uses an unsupported protocol.

## 1.2.1 - 2026-09-07

### Fixed

- Support both the legacy Undici 7 Dispatcher handler callbacks and the Undici 8 callbacks used by Pi 0.85.x.
- Prevent `handler.onHeaders is not a function` from escaping a Node response event and terminating Pi.
- Bridge response-stream pause/resume and raw response headers for the Undici 8 handler.

### Verification

- TypeScript check passed for `socks-dispatcher.ts`.
- Local SOCKS5 integration passed for Undici 7 and 8, including GET and POST requests.

## 1.2.0 - 2026-08-27

- Route in-session auth requests by provider.
- Add dedicated `proxy-router.json` configuration with legacy `settings.json` fallback.
