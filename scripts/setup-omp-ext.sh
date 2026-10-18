#!/usr/bin/env bash
# Link the yaml-providers pi extension into oh-my-pi's own plugin system
# (~/.omp/plugins/node_modules) via `omp plugin link` and install its npm
# deps. oh-my-pi discovers extensions differently from pi (no
# ~/.pi/agent/extensions convention), so it gets its own setup task - same
# split as the old setup-pi-ext vs setup-omp-ext pair in ~/.dotc.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../pi-exts/yaml-providers" && pwd)"

cd "$SRC"
bun install
omp plugin link .
