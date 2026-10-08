#!/usr/bin/env bash
# Private apps: code in ops/apps/<id>/ (the private ops repo, gitignored here) that the platform treats
# like any apps/<id>/. `link` (default, on a dev machine) symlinks each into apps/ so edits land in ops;
# `copy` (the deploy) copies them in, since a docker build doesn't follow links. Either way they're added
# to .git/info/exclude, so this repo never sees them.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d ops/apps ] || exit 0
MODE="${1:-link}"
ln -sfn ../../apps/lib ops/apps/lib   # a private app's ../lib resolves from either place
for d in ops/apps/*/; do
  id=$(basename "$d"); [ "$id" = lib ] && continue
  [ -f "$d/app.json" ] || continue
  grep -qxF "/apps/$id" .git/info/exclude 2>/dev/null || echo "/apps/$id" >> .git/info/exclude
  if [ "$MODE" = copy ]; then rm -rf "apps/$id"; cp -R "${d%/}" "apps/$id"
  else [ -L "apps/$id" ] || { [ -e "apps/$id" ] && { echo "apps/$id exists and isn't a link"; exit 1; }; ln -s "../ops/apps/$id" "apps/$id"; }
  fi
  echo "$MODE: apps/$id"
done
