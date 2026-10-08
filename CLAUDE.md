# Odapt

An app builder for agentic apps, and the platform that hosts and bills them. `README.md` explains how
it works; `issues.md` is open work.

- **Agent apps** are templates in `templates/<id>/`, run by the engine (`src/`).
- **Listed apps** (code and hosting elsewhere, e.g. lofiwave) are an `apps/<id>/app.json` with
  `"kind": "listed"` and a landing page: funnel events only (README, "Listed apps").
- **Standalone apps** (a fixed job at a fixed price) are in `apps/<id>/`. To make one, follow
  `docs/new-app.md` from `bun run new-app`.
- **The control plane** (`control/`, hosted at https://api.odapt.ai) holds accounts, the wallet, the
  only Stripe key, the provider keys, the ledger and funnel events for every app. `bun run report
  [--json]` shows money and funnel per app.

## Working here

- Keys never go in the repo, in an app, or in chat. `.env` and `control.env` are gitignored.
- The repo is public. Account IDs, server names, customer details and anything else about how the
  hosted platform is operated stay out of it, `issues.md` included: name the env var, not the value.
- Pages served under a path (`api.odapt.ai/<app>`) must not use root-relative URLs.
- Use `SNAP_PORT`, never `$PORT`.
- `bun test` and `bun run typecheck` before pushing. New issues go in `issues.md`, with the app's name
  in the title when they belong to one app.

@ops/CLAUDE.md
