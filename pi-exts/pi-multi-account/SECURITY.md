# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[security advisories](https://github.com/Sarrius/pi-multi-account/security/advisories/new)
rather than opening a public issue.

## Handling of credentials

pi-multi-account reads authenticated accounts from `~/.pi/agent/auth.json`. Raw
credentials are never copied into rotation state or logs. A `0600` private
recovery sidecar can temporarily retain OAuth credentials while the public
account store contains loopback proxy placeholders. Credentials are transmitted
over HTTPS to provider endpoints needed for authentication, account usage, and
model-catalog operations. The only non-HTTPS exception is Ollama's tightly
scoped `http://127.0.0.1:11434/api/me` loopback fallback. The endpoints currently
called by the extension are documented under
[Privacy & security](./README.md#privacy--security); OAuth refresh delegates to
the provider authentication implementation shipped by Pi.

- Only SHA-256 fingerprints (first 12 hex chars) of tokens/keys are kept in
  extension state, to detect re-login and dedupe accounts.
- Its config and state files are written with `0600` permissions.

When reporting an issue, never include tokens, API keys, or the contents of
`auth.json`.
