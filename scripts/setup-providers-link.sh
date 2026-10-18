#!/usr/bin/env bash
# POSIX (mac/Linux) half of the `setup-providers-link` task. Creates the
# per-machine symlink that lets the cld binary and the yaml-providers pi
# extension find providers.yaml without any machine-specific absolute path
# in the code:
#
#   ~/.local/bin/providers.yaml -> <this repo>/pi-exts/yaml-providers/providers.yaml
#
# The repo may be cloned anywhere on each machine; ~/.local/bin (i.e.
# %USERPROFILE%\.local\bin on Windows) is the one stable location every
# machine already has on PATH. Override with the AGENT_PROVIDERS_YAML env
# var (read by ts-lib/lib.ts resolveProvidersYaml) instead of/in addition to
# this link.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/pi-exts/yaml-providers/providers.yaml"
DEST="$HOME/.local/bin/providers.yaml"

mkdir -p "$HOME/.local/bin"
if [ ! -e "$DEST" ]; then
  ln -s "$SRC" "$DEST"
  echo "linked $DEST -> $SRC"
elif [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC" ]; then
  echo "$DEST already linked"
else
  echo "ERROR: $DEST exists and is not the expected symlink to $SRC" >&2
  echo "Remove it or set AGENT_PROVIDERS_YAML to override." >&2
  exit 1
fi
