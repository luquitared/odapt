# Every standalone app, built from the repo root by scripts/deploy-app.sh:
#   docker build -f apps/Dockerfile --build-arg APP=<id> --build-arg APT="<debian packages>" .
# The app's data lives in /data (a volume, ~/apps-data/<id> on the VM).
FROM oven/bun:1.4-slim
ARG APT=""
RUN if [ -n "$APT" ]; then apt-get update && apt-get install -y --no-install-recommends $APT ca-certificates && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY apps/lib ./apps/lib
ARG APP
COPY apps/${APP} ./apps/${APP}
# Media too big or too private for git (gitignored public/media) never goes in the image.
RUN rm -rf apps/${APP}/public/media && mkdir -p /data && chown bun:bun /data
USER bun
ENV APP=${APP}
CMD ["sh", "-c", "exec bun apps/$APP/server.ts"]
