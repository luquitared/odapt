#!/usr/bin/env bash
# Private apps: code in ops/apps/<id>/ (the private ops repo, gitignored here) that the platform treats
# like any apps/<id>/, and agent templates in ops/templates/<id>/ treated like any templates/<id>/. `link` (default, on a dev machine) symlinks each into apps/ so edits land in ops;
# `copy` (the deploy) copies them in, since a docker build doesn't follow links. Either way they're added
# to .git/info/exclude, so this repo never sees them.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d ops ] || exit 0
MODE="${1:-link}"
[ -d ops/apps ] && ln -sfn ../../apps/lib ops/apps/lib   # a private app's ../lib resolves from either place
for kind in apps templates; do
  for d in ops/$kind/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d"); [ "$id" = lib ] && continue
    [ -f "$d/app.json" ] || [ -f "$d/template.json" ] || continue
    grep -qxF "/$kind/$id" .git/info/exclude 2>/dev/null || echo "/$kind/$id" >> .git/info/exclude
    if [ "$MODE" = copy ]; then rm -rf "$kind/$id"; cp -R "${d%/}" "$kind/$id"
    else [ -L "$kind/$id" ] || { [ -e "$kind/$id" ] && { echo "$kind/$id exists and isn't a link"; exit 1; }; ln -s "../ops/$kind/$id" "$kind/$id"; }
    fi
    echo "$MODE: $kind/$id"
  done
done
