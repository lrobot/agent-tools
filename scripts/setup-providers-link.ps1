# Windows half of the `setup-providers-link` task; setup-providers-link.sh
# beside this file is the POSIX half. Creates the per-machine link that lets
# the cld binary and the yaml-providers pi extension find providers.yaml
# without any machine-specific absolute path in the code:
#
#   %USERPROFILE%\.local\bin\providers.yaml -> <this repo>\pi-exts\pi-yaml-providers\providers.yaml
#
# Uses a directory-style junction target equivalent for a single file: on
# Windows a file symlink is created (developer mode or admin allows this);
# when symlinks are unavailable, fall back to copying the file (stale-copy
# caveat: re-run this task after editing providers.yaml). Override with the
# AGENT_PROVIDERS_YAML env var (read by ts-lib/lib.ts resolveProvidersYaml).
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repoRoot 'pi-exts\pi-yaml-providers\providers.yaml'
$destDir = Join-Path $HOME '.local\bin'
$dest = Join-Path $destDir 'providers.yaml'

New-Item -ItemType Directory -Force $destDir | Out-Null

if (Test-Path $dest) {
    $item = Get-Item $dest -Force
    if ($item.LinkType -eq 'SymbolicLink' -and $item.Target -eq $src) {
        Write-Output "$dest already linked"
        exit 0
    }
    Write-Error "$dest exists and is not the expected symlink to $src. Remove it or set AGENT_PROVIDERS_YAML to override."
}

try {
    New-Item -ItemType SymbolicLink -Path $dest -Target $src | Out-Null
    Write-Output "linked $dest -> $src"
} catch {
    Copy-Item $src $dest
    Write-Warning "symlinks unavailable (enable Developer Mode for symlink privileges); copied instead. Re-run after editing providers.yaml."
}
