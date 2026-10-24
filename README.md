# agent-tools

Cross-machine home for the `cld` launcher sources, shared ts-lib helpers, and
pi extensions. Designed to be cloned anywhere on any machine (mac/Linux today,
Windows later): all runtime paths resolve via `os.homedir()` conventions, never
via machine-specific absolute paths. See `mise.toml` for the layout rationale
and the task list.

## Layout

```text
agent-tools/
├── mise.toml             tasks: build-cld, setup-providers-link, setup-omp-ext
├── scripts/              task scripts (.sh POSIX half + .ps1 Windows half)
├── cld-ts/               cld launcher sources (core.ts compiled to a native binary)
├── ts-lib/               shared helpers (lib.ts) + cross-machine yaml path resolvers
├── cfg/                  (reserved; providers.yaml lives in pi-exts/yaml-providers)
└── pi-exts/
    ├── include-rule.ts   loaded via settings.json "extensions" (file path)
    ├── yaml-providers/   pi extension: yaml-defined providers (plain files, this repo)
    ├── pi-antigravity/   GIT SUBTREE of github.com:Rahularya01/pi-antigravity (main)
    ├── pi-multi-account/ GIT SUBTREE of github.com:Sarrius/pi-multi-account (main)
    ├── pi-proxy-router/  GIT SUBTREE of github.com:leench/pi-proxy-router (master)
    └── pi-usage/         GIT SUBTREE of github.com:mtrojnar/pi-usage (main)
```

## Runtime paths (all via os.homedir(), portable to Windows)

| Path | What |
|---|---|
| `~/.local/bin/cld(.exe)` | built launcher binary (build.ts output) |
| `~/.local/bin/cld.*.yaml` | per-instance configs (cld resolves them relative to the binary) |
| `~/.local/bin/providers.yaml` | symlink -> `pi-exts/yaml-providers/providers.yaml` (setup-providers-link) |
| `~/.agent_instances.yaml` | instance definitions, synced between machines via dotfiles |

Env overrides: `AGENT_PROVIDERS_YAML`, `AGENT_INSTANCES_YAML`
(read by `resolveProvidersYaml()` / `resolveInstancesYaml()` in `ts-lib/lib.ts`).

## cld context-window detection

`_modelselect` detects each model's real context window (live `/models` listing,
falling back to the provider's `max_context_ref` catalog) and persists it:
>=1M windows become a `[1m]` suffix on the model ID in `cld.<instance>.yaml`
(client-side selector; claude strips it before the wire), sub-1M windows land in
an optional `context:` section and are exported as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
at launch. Without this, claude assumes 200K for every unrecognized gateway ID and
auto-compacts there. Full design + wire-capture evidence: `docs/design_cld_context_window.md`.

## Git subtrees

The four pi extensions are embedded with full upstream history via
`git subtree add` (no `--squash`), so this repo is self-contained AND can
exchange commits with upstreams:

- Upstream histories appear as ordinary commits in `git log`; each subtree
  arrived in its own merge commit (see `git log --oneline --graph`).
- Each upstream has a named remote in this repo (see `git remote -v`).
- **Local modifications** to a subtree are committed on top, in this repo
  (currently: pi-antigravity per-provider proxy patch, pi-multi-account
  custom-family-registry, pi-proxy-router antigravity OAuth endpoints +
  npm-undici-by-path load so ProxyAgent survives Bun's `undici` builtin
  aliasing — see anti-network-blocking.md in /opt/ops — plus the
  globalThis `__piProxyRouter` bridge (v1.3.0), pi-usage routing its usage
  checks through that bridge — both committed in this repo, see
  docs/design_pi_usage_proxy_router.md in /opt/ops for the design).
  Keep them as separate commits from subtree pulls so both directions stay
  clean.

### Update a subtree from upstream

```bash
git subtree pull --prefix=pi-exts/pi-antigravity pi-antigravity main
git subtree pull --prefix=pi-exts/pi-multi-account pi-multi-account main
git subtree pull --prefix=pi-exts/pi-proxy-router pi-proxy-router master
git subtree pull --prefix=pi-exts/pi-usage pi-usage main
```

### Push local subtree changes upstream (needs a fork + write access)

The upstreams belong to other GitHub accounts, so push to your own fork's
branch first, then open a PR:

```bash
git remote add my-fork git@github.com:<you>/pi-proxy-router.git
git subtree push --prefix=pi-exts/pi-proxy-router my-fork my-feature-branch
```

`git subtree push` replays only the commits touching that prefix, so the
fork branch contains just the extension's own history + your changes.

### Gotchas learned

- `git subtree add` refuses a prefix that exists on disk, even as an
  untracked dir with identical content (git 2.54). Move the dir aside,
  add the subtree, then re-apply local changes.
- Never `--squash` a subtree you intend to `subtree push` later.
- `node_modules/` is gitignored everywhere; after a fresh clone run
  `bun install` in `pi-exts/yaml-providers` (and the subtree dirs that
  need it) before `pi` loads them.

## Machine setup (fresh clone, any OS)

```bash
mise install          # tools + postinstall-all hook:
                      # builds cld into ~/.local/bin, links providers.yaml,
                      # links the extension into oh-my-pi
# pi: register the extensions (settings.json is per-machine)
pi install <clone-path>/pi-exts/pi-antigravity
pi install <clone-path>/pi-exts/pi-multi-account
pi install <clone-path>/pi-exts/pi-proxy-router
pi install <clone-path>/pi-exts/pi-usage
pi install <clone-path>/pi-exts/yaml-providers
# plus: add "<clone-path>/pi-exts/include-rule.ts" to settings.json "extensions"
```

Legacy note: this content lived in `~/.dotc/` (cld sources) and
`~/.pi-extensions/` (pi extensions) before 2026-10-18; `~/.dotc/` now keeps
only the compiled binary's historical docs.
