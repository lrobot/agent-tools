#!/usr/bin/env bash
# POSIX (mac/Linux) half of the `build-cld` task; build-cld.ps1 beside this
# file is the Windows half. Neither is a mise file task - the agent-tools
# mise.toml declares [tasks.build-cld] and dispatches to one or the other via
# run/run_windows, so task metadata lives there, not in #MISE headers here.
#
# Run via `mise run build-cld`, or automatically by the postinstall hook in
# the agent-tools mise.toml. See ~/.dotc/doc/design_cld_ts.md.
set -euo pipefail

cd "$MISE_PROJECT_ROOT"

bun run cld-ts/build.ts

# The binary now lands in the per-machine user bin dir (~/.local/bin), not
# beside the sources - build.ts decides the output path.
CLD_BIN="$HOME/.local/bin/cld"

# Completion registration is best-effort: a missing shell or an unwritable
# system directory must never fail the build above.
if command -v bash >/dev/null 2>&1; then
  mkdir -p ~/.local/share/bash-completion/completions
  "$CLD_BIN" completion bash > ~/.local/share/bash-completion/completions/cld || true
fi

if command -v zsh >/dev/null 2>&1; then
  for d in /usr/local/share/zsh/site-functions ~/.local/share/zsh/site-functions; do
    if mkdir -p "$d" 2>/dev/null && "$CLD_BIN" completion zsh > "$d/_cld" 2>/dev/null; then
      break
    fi
  done
fi

echo "cld: built $CLD_BIN"
