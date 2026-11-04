# Design Document: Pi Agent Multi-Environment Isolation & Evaluation Setup

## 1. Overview
The goal is to provide three parallel, fully isolated environments for the Pi coding agent on the same workstation:
1. `pi`: Vanilla Pi agent using the standard configuration (`~/.pi/agent`) with all default extensions intact.
2. `pi-ecc`: Full ECC profile using an isolated agent directory (`~/.pi/agent-ecc`), mounting the full ECC package (skills, commands, rules, hooks, `/ecc-doctor`) alongside all default extensions.
3. `pi-core`: Lightweight curated ECC profile using an isolated agent directory (`~/.pi/agent-core`), mounting the `pi/core` package (132 skills + 24 prompt commands, zero hooks, pure offline profile) alongside all default extensions.

This setup enables seamless side-by-side evaluation, A/B testing of prompt responses and token usage, and guarantees zero configuration pollution to the primary `pi` environment.

## 2. Directory Architecture & Symlink Strategy

```
~/.pi/
├── agent/                             <-- Default (vanilla pi)
│   ├── settings.json                  <-- Default packages & settings (UNTOUCHED)
│   ├── auth.json                      <-- Credentials (source of truth)
│   ├── antigravity-accounts.json      <-- Antigravity OAuth tokens
│   ├── models.json                    <-- Model overrides
│   ├── models-store.json              <-- Cached model metadata
│   ├── provider-failover.json         <-- Provider failover config
│   ├── npm/                           <-- Node packages (pi-subagents, ask-user-question, etc.)
│   └── sessions/                      <-- Vanilla session logs
│
├── agent-ecc/                         <-- Isolated ECC environment
│   ├── settings.json                  <-- Default packages + ~/.local/share/ecc
│   ├── auth.json                      <-- symlink -> ~/.pi/agent/auth.json
│   ├── antigravity-accounts.json      <-- symlink -> ~/.pi/agent/antigravity-accounts.json
│   ├── models.json                    <-- symlink -> ~/.pi/agent/models.json
│   ├── models-store.json              <-- symlink -> ~/.pi/agent/models-store.json
│   ├── provider-failover.json         <-- symlink -> ~/.pi/agent/provider-failover.json
│   ├── npm                            <-- symlink -> ~/.pi/agent/npm
│   └── sessions/                      <-- Isolated session logs
│
└── agent-core/                        <-- Isolated pi/core environment
    ├── settings.json                  <-- Default packages + ~/.local/share/ecc/pi/core
    ├── auth.json                      <-- symlink -> ~/.pi/agent/auth.json
    ├── antigravity-accounts.json      <-- symlink -> ~/.pi/agent/antigravity-accounts.json
    ├── models.json                    <-- symlink -> ~/.pi/agent/models.json
    ├── models-store.json              <-- symlink -> ~/.pi/agent/models-store.json
    ├── provider-failover.json         <-- symlink -> ~/.pi/agent/provider-failover.json
    ├── npm                            <-- symlink -> ~/.pi/agent/npm
    └── sessions/                      <-- Isolated session logs
```

### Shared vs Isolated Components
- **Credentials & Models (Shared via symlinks)**: `auth.json`, `antigravity-accounts.json`, `models.json`, `models-store.json`, `provider-failover.json`. Updating an API key or logging in once keeps all three environments functional without repeated authentications.
- **Node Modules (Shared via symlink)**: Symlinking `<agent-dir>/npm` to `~/.pi/agent/npm` avoids duplicating npm packages (~270 node_modules) and saves disk space and download time while making all 8 default packages instantly available.
- **Settings & Package Registration (Isolated)**: Each directory has its own `settings.json`.
- **Session Histories (Isolated)**: Conversations and session files remain segregated under each directory's own `sessions/`.

## 3. Package Configuration

### Default Extensions (Retained in all 3 environments)
1. `npm:pi-subagents`
2. `npm:pi-web-access`
3. `npm:@juicesharp/rpiv-ask-user-question`
4. `npm:@juicesharp/rpiv-todo`
5. `npm:pi-mcp-adapter`
6. `/opt/ops/agent-tools/pi-exts/pi-antigravity`
7. `/opt/ops/agent-tools/pi-exts/pi-proxy-router`
8. `/opt/ops/agent-tools/pi-exts/yaml-providers`
9. `npm:pi-chrome`
10. `npm:billion-context`
11. `npm:pi-schedule-prompt`
12. Extensions: `"-builtin:mcp"`, `"/opt/ops/agent-tools/pi-exts/include-rule.ts"`

### Environment-Specific Packages
- **`pi`**: Default packages only.
- **`pi-ecc`**: Default packages + `/Users/mac/.local/share/ecc`.
- **`pi-core`**: Default packages + `/Users/mac/.local/share/ecc/pi/core`.

## 4. CLI Execution Wrappers

Executable scripts in `~/.local/bin/` (which is already in user `$PATH`):

### `~/.local/bin/pi-ecc`
```bash
#!/usr/bin/env bash
export PI_CODING_AGENT_DIR="${HOME}/.pi/agent-ecc"
exec pi "$@"
```

### `~/.local/bin/pi-core`
```bash
#!/usr/bin/env bash
export PI_CODING_AGENT_DIR="${HOME}/.pi/agent-core"
exec pi "$@"
```

Both wrappers transparently forward all flags and subcommands (`pi-ecc list`, `pi-ecc -p "..."`, etc.).

## 5. Verification Plan
1. Check package discovery:
   - Run `pi list` -> verifies vanilla setup unchanged.
   - Run `pi-ecc list` -> verifies all 11 default packages + full ECC package loaded.
   - Run `pi-core list` -> verifies all 11 default packages + `ecc-pi-core` package loaded.
2. In-session verification:
   - In `pi-ecc`, run `/ecc-doctor` to ensure rules, skills, and command counts resolve properly.
3. Clean rollback test:
   - Deleting `~/.pi/agent-ecc`, `~/.pi/agent-core`, `~/.local/share/ecc`, and the two wrapper binaries cleanly restores the workstation with zero artifacts.
