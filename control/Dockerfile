# The control plane only: accounts (Better Auth), wallet, Stripe, metered proxy.
# Built from the repo root: docker build -f control/Dockerfile .
FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY control ./control
# From templates only pricing.json (which apps bill, markup, packs) and template.json (the name) are read.
COPY templates ./templates
RUN find templates -type f ! -name pricing.json ! -name template.json -delete && find templates -type d -empty -delete
# From standalone apps only app.json (which apps may report money and events).
COPY apps ./apps
RUN find apps -type f ! -name app.json -delete && find apps -type d -empty -delete
USER bun
ENV CONTROL_PORT=7790
EXPOSE 7790
CMD ["bun", "control/server.ts"]
