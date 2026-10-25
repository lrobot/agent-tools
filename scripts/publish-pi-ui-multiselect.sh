#!/usr/bin/env bash
set -euo pipefail

remote="${PI_UI_MULTISELECT_REMOTE:-pi-tui-multiselect-list}"
prefix="pi-exts/pi-ui-multiselect"

if [ -n "$(git status --porcelain -- "$prefix")" ]; then
  echo "$prefix has uncommitted changes; commit first" >&2
  exit 1
fi

sha=$(git subtree split --prefix="$prefix")
echo "==> push $sha -> $remote main"
git push "$remote" "$sha:refs/heads/main"

ver=$(node -p "require('./$prefix/package.json').version")
if git ls-remote --tags "$remote" "refs/tags/v$ver" | grep -q .; then
  echo "==> tag v$ver already on remote"
else
  git push "$remote" "$sha:refs/tags/v$ver"
  echo "==> tagged v$ver on remote"
fi
