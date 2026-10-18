#!/usr/bin/env pwsh
# Windows half of the `build-cld` task; build-cld.sh beside this file is the
# POSIX half. Neither is a mise file task - the agent-tools mise.toml declares
# [tasks.build-cld] and dispatches to one or the other via run/run_windows,
# so task metadata lives there, not in #MISE headers here.
#
# Run via `mise run build-cld`, or automatically by the postinstall hook in
# the agent-tools mise.toml. See ~/.dotc/doc/design_cld_ts.md.
$ErrorActionPreference = 'Stop'

Set-Location $env:MISE_PROJECT_ROOT

bun run cld-ts/build.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The binary now lands in the per-machine user bin dir
# (%USERPROFILE%\.local\bin), not beside the sources - build.ts decides the
# output path.
$cldBin = Join-Path $HOME '.local\bin\cld.exe'

# Windows has no system-wide completion directory, so this writes a script for
# the user to dot-source from $PROFILE (mise must not edit $PROFILE itself -
# see doc/design_cld_ts.md). Best-effort: never fail the build above.
$completion = Join-Path $HOME '.local\bin\cld-completion.ps1'
try {
    & $cldBin completion pwsh | Set-Content -Encoding utf8 $completion
} catch {
    Write-Warning "cld: completion registration skipped: $_"
    # Don't leave a half-written file behind for $PROFILE to dot-source.
    Remove-Item $completion -ErrorAction SilentlyContinue
}

Write-Output "cld: built $cldBin"
