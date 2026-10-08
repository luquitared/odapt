#!/usr/bin/env bash
# Deploy one standalone app on the VM, from its app.json "deploy" block:
#   {"port": 7792, "path": "/duo", "apt": ["ffmpeg"], "env": {"DUO_PUBLIC_URL": "https://api.odapt.ai/duo"}}
# Builds apps/Dockerfile, runs it as app-<id> on 127.0.0.1:<port> with /data at ~/apps-data/<id>, and
# serves it at https://api.odapt.ai<path> (a Caddy snippet the api.odapt.ai site imports).
#
# The container gets: deploy.env, ODAPT_URL, its ODAPT_APP_KEY (asked of the running control plane, so
# nobody copies it), and apps-env/<id>.env in this clone if that exists (operator overrides, e.g. mock
# mode while testing). Run from the clone: bash scripts/deploy-app.sh <id>
set -euo pipefail
ID="$1"; J="apps/$ID/app.json"
[ -f "$J" ] || { echo "no $J"; exit 1; }
PORT=$(jq -r '.deploy.port // empty' "$J"); PREFIX=$(jq -r '.deploy.path // empty' "$J")
[ -n "$PORT" ] && [ -n "$PREFIX" ] || { echo "$J needs deploy.port and deploy.path"; exit 1; }
APT=$(jq -r '(.deploy.apt // []) | join(" ")' "$J")
NAME="app-$ID"; DATA="$HOME/apps-data/$ID"

echo "==> $ID: build"
docker build -q -f apps/Dockerfile --build-arg APP="$ID" --build-arg APT="$APT" -t "$NAME" . >/dev/null

ENVF=$(mktemp); trap 'rm -f "$ENVF"' EXIT
jq -r '(.deploy.env // {}) | to_entries[] | "\(.key)=\(.value)"' "$J" > "$ENVF"
echo "ODAPT_URL=https://api.odapt.ai" >> "$ENVF"
echo "ODAPT_APP_KEY=$(docker exec snappy-control bun control/apps.ts key "$ID")" >> "$ENVF"
[ -f "apps-env/$ID.env" ] && cat "apps-env/$ID.env" >> "$ENVF"

echo "==> $ID: run on 127.0.0.1:$PORT, data in $DATA"
mkdir -p "$DATA"; sudo chown 1000:1000 "$DATA"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --env-file "$ENVF" -v "$DATA:/data" -p "127.0.0.1:$PORT:$PORT" "$NAME" >/dev/null
for i in $(seq 1 30); do curl -sf -m 2 "http://localhost:$PORT/health" >/dev/null && break; sleep 2; done
docker logs "$NAME" --tail 3
curl -sf -m 5 "http://localhost:$PORT/health" >/dev/null || { echo "==> $ID: health check failed"; exit 1; }

SNIP="/etc/caddy/odapt-apps/$ID.caddy"
WANT=$(printf '# %s (snappy-studio apps/%s), written by scripts/deploy-app.sh\nhandle_path %s/* {\n    reverse_proxy localhost:%s\n}\n' "$ID" "$ID" "$PREFIX" "$PORT")
if [ "$(sudo cat "$SNIP" 2>/dev/null)" != "$WANT" ]; then
  echo "==> $ID: route https://api.odapt.ai$PREFIX"
  sudo mkdir -p /etc/caddy/odapt-apps; printf '%s\n' "$WANT" | sudo tee "$SNIP" >/dev/null
  sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null && sudo systemctl reload caddy
fi
echo "==> $ID deployed: https://api.odapt.ai$PREFIX"
