# Odapt

An open-source app builder for agentic apps, and a hosted platform that signs people in, bills them
and pays the providers. MIT licensed.

Pick a template; a Claude Code session does the work and drives the page through a CLI.
Submit it as a **job** and come back later, or open it in the **editor** and steer it live.
Video is the first app, but nothing in `src/` knows about video — an app is a folder in `templates/`.

```
browser ──SSE──▶ ┌────────┐ ◀──POST /emit── snap (CLI) ◀── claude -p (stream-json, one long conversation)
        ──POST─▶ │ server │ ──long-poll actions──▶ runner ──stdin──▶ ┘
  actions        └───┬────┘
                 event log (SQLite) → session snapshot
```

- **Everything is an event.** The agent's `snap` calls and the user's actions append to one log; the
  session snapshot is a fold over it (`src/protocol.ts`). The UI is a function of the snapshot, so a
  job nobody watched looks exactly the same when someone opens it a day later.
- **The agent never waits.** It ends its turn; the runner blocks for the user and delivers their
  action as the next message. After `SNAP_IDLE_TIMEOUT` (540s) the runner parks: Claude exits, the
  process exits. The next action starts a new runner that `--resume`s the same conversation.
- **Nothing the agent does happens inside an HTTP request**, so the same design fits Cloud Run Jobs.

## Run it

```
bun install
bun start            # http://127.0.0.1:7788
```

Needs `claude` (logged in, or `ANTHROPIC_API_KEY`), `ffmpeg`, and for real generation `rep` +
`vidwatch` on PATH with `REPLICATE_API_TOKEN` / `GEMINI_API_KEY` in `.env` (Bun loads it). Mock
mode (the default checkbox) needs none of the keys.

| env | default | |
|---|---|---|
| `SNAP_PORT` | 7788 | not `$PORT`, on purpose |
| `SNAP_DATA_DIR` | `./data` | db, assets, workspaces, logs |
| `SNAP_TOKEN` | `dev` | shared secret for runner + CLI |
| `SNAP_PUBLIC_URL` | `http://127.0.0.1:$SNAP_PORT` | how runners reach the API |
| `SNAP_LAUNCHER` | `local` | `cloudrun` is written but **untested** |
| `SNAP_HARNESS` | template's `harness`, else `claude` | a preset from `harnesses.json`: `claude`, `codex`, `deepseek-flash` |
| `SNAP_MODEL` | the preset's, else the template's `model` | the model the harness runs |
| `OPENROUTER_API_KEY` | — | needed by presets with `"provider": "openrouter"` |
| `OPENAI_API_KEY` | — | voice calls without a control plane (see Voice) |
| `SNAP_IDLE_TIMEOUT` / `SNAP_TURN_TIMEOUT` | 540 / 1800 | seconds |

Logs: `data/logs/<session>.runner.log` and `<session>.claude.jsonl` (the raw stream).

## Harnesses

The agent behind a session is swappable (`src/harness.ts`, adapters in `src/harnesses/`). Pick one per
app (`"harness": "deepseek-flash"` in `template.json`), per session (the Engine select, or `harness`
in `POST /api/sessions`), or for everything (`SNAP_HARNESS`). Add a preset in `harnesses.json`; add
a harness type by implementing `Harness` — `start`, `send(text) → {text, isError}`, `stop`.

## Voice

An app with `"voice": {"voice": "<name>"}` in `template.json` gets a **Talk** button: the person talks
to the session through OpenAI's GPT-Live (`gpt-live-1`, $0.05/min) while the session's harness keeps
doing the work (`src/voice.ts`). GPT-Live isn't a harness: it takes no typed turns and runs no tools.
It talks, and hands anything that needs the app to us (client delegation). Each hand-off becomes a
`voice` action carrying what the person said, so the runner and any harness take it like a typed
message. What the agent then shows the user (`snap say`, `snap ask`, `snap done`) goes back to be
spoken, and `snap voice "<instruction>"` steers the voice directly.

```
browser ══ WebRTC audio ══ GPT-Live ── sideband WS ── server (VoiceBridge) ── log ── runner ── harness
```

The browser's offer goes to `POST /api/sessions/<id>/voice`; the server creates the Live session and
attaches the sideband, so no key reaches the page, and the page may only hang up or mute. The voice
gets `prompts/voice.md`, the app's `voice.md`, a summary of the page and the recent chat; the agent
gets `prompts/voice-agent.md`. Captions land in the log as `voice` events. With a control plane, calls
go through its proxy (below) on the user's credit; without one, `OPENAI_API_KEY` is used directly.
`OPENAI_LIVE_BASE` points either side at a stand-in. `SNAP_VOICE_DEBUG=1` logs every sideband event
but the transcript fragments to the server's output. `templates/lingo` (a spoken language game) is
the example app.

## HTML panels

By default the agent fills built-in panel kinds (`markdown`, `form`, `gallery`, `video`, …) and the
studio draws them. An app with `"ui": {"html": true}` in `template.json` also lets the agent write
`html` panels: its own page, in a sandboxed iframe (scripts only, no same-origin, a CSP with no
network), driven by a `state` value it patches each turn. The page talks back through `window.snap`
(`action`, `send`, `edit`, `onState`), which becomes ordinary actions in the log. Turn it on when the
page is the product (a game, a board, a live view) or when people should be able to ask for a
different look mid-session: the agent patches new HTML and the state carries over. The agent's
instructions are `prompts/html-panels.md`; `templates/lingo` is the example.

## Control plane (`control/`)

One service for every app: accounts, a credit wallet, Stripe, and a metered proxy. Apps never hold
a provider key — they call the proxy with a user token, and each call is debited from that user's
wallet at provider cost × the app's markup. Postgres.

```
bun run control      # http://127.0.0.1:7790
```

The hosted one is https://api.odapt.ai. To run your own, build `control/Dockerfile` and run it with
the env below (`--env-file control.env`) behind something that terminates HTTPS. The workflows in
`.github/workflows/` deploy the hosted one and only run in `luquitared/odapt`.

| route | |
|---|---|
| `GET /login[?app=]`, `/auth/google`, `POST /auth/email` | sign in with Google, or an emailed link ([Better Auth](https://www.better-auth.com), `control/auth.ts`); a first sign-in from an app gets its `grant_usd` |
| `POST /api/auth/device/code {client_id: <app>}` → `/device?user_code=` → `POST /api/auth/device/token` | desktop sign-in (RFC 8628): show the code, open the page, poll; the `access_token` is a session token sent as `Authorization: Bearer` |
| `/api/auth/*` | Better Auth's own routes (OAuth callback `/api/auth/callback/google`, magic links) |
| `GET /me` | user + `balance_usd` |
| `POST /billing/checkout {app, pack}` | Stripe Checkout for a credit pack; `POST /stripe/webhook` adds the credit |
| `/proxy/<app>/openrouter/v1/*` | charged from reported usage, after the response |
| `/proxy/<app>/replicate/v1/*` | charged up front from `control/prices.json`; refunded if it fails; unpriced models refused |
| `POST /proxy/<app>/openai/v1/live/sessions` · `WS …/live/sessions/<id>/attach` | a voice call (`control/live.ts`): GPT-Live only, WebRTC only. The control plane holds the session's sideband itself and meters it (15s up front, then every 30s, the rest at the close; ends a call that empties the wallet); the engine gets a relay without audio and may only send context and hang up |
| `POST /events {app, type, variant?, session_id?, props?}` | funnel events; open to any origin, and takes `text/plain` JSON so a static landing page can post without a preflight |
| `POST /apps/<id>/checkout {order_id, product, email?, success_url, cancel_url, notify_url?, ui?}` | a standalone app's order: a Checkout session for one of its `app.json` products. `ui: "elements"` (no `cancel_url`) returns `client_secret` and `publishable_key` for Stripe's Express Checkout Element on the app's own page instead of a URL. `Authorization: Bearer <app key>` on every `/apps/<id>/…` route |
| `GET /apps/<id>/payments/<session>` · `POST /apps/<id>/refund {session_id}` | an order's status (checked with Stripe while open) · a full refund, once |
| `/apps/<id>/proxy/<provider>/<path>` | a provider from `control/providers.json` (muapi today), with the platform's key; the cost each response reports goes in the ledger |
| `POST /apps/<id>/money {kind, usd, ref, …}` or `{entries: [...]}` | money the platform can't see (a provider called directly); a repeated `ref` is ignored |
| `GET /account` | balance, buy buttons, and standalone apps' orders paid with the account's email |
| `GET /me` · `POST /billing/checkout {app, pack}` | with a Bearer token: email and balance · a credit pack's Checkout URL (JSON when asked for; Stripe returns to `/billing/done`) |

An app is billable once `templates/<id>/pricing.json` exists: `markup`, `grant_usd` (free credit on
first sign-in), `packs`. The wallet is one per user, shared across apps; the ledger
(`credit_ledger`) is append-only, and `ref` makes webhooks, grants and charges idempotent.
`CONTROL_DAILY_CAP_USD` (default 20) caps raw provider spend per UTC day across all users.

To run an engine session on a user's credit: `SNAP_CONTROL_URL=<control> SNAP_CONTROL_TOKEN=<token>`.
Codex harnesses with a `provider` then go through the proxy, and so does every catalog tool whose
manifest names a proxied `provider` (`rep` today): the runner sets its base URL and the user's token
and removes every provider key from the session. `vidwatch` has no Gemini route yet, so in that mode
it gets no key.

| env | |
|---|---|
| `CONTROL_DATABASE_URL` | `postgres://…/snappy?sslmode=require` |
| `CONTROL_PUBLIC_URL` / `CONTROL_PORT` | default `http://127.0.0.1:7790` / 7790 |
| `STRIPE_SECRET_KEY` | the platform's only Stripe key (a restricted key: write Checkout Sessions, Refunds, Customers; read PaymentIntents, Charges, Balance transactions) |
| `STRIPE_WEBHOOK_SECRET` | the signing secret of the endpoint at `<CONTROL_PUBLIC_URL>/stripe/webhook`; comma-separate several (test-mode and live endpoints) |
| `OPENROUTER_API_KEY`, `REPLICATE_API_TOKEN`, `MUAPI_API_KEY`, `OPENAI_API_KEY` | the only copies of the provider keys (OpenAI: voice calls) |
| `CONTROL_RECORD_TEST_PAYMENTS=1` | count test-mode orders as money (local testing on a throwaway database only) |
| `BETTER_AUTH_SECRET` | required; signs sessions. `openssl rand -base64 32` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | a Google Cloud OAuth client (Web), redirect URI `<CONTROL_PUBLIC_URL>/api/auth/callback/google`; unset → email links only |
| `RESEND_API_KEY`, `CONTROL_MAIL_FROM` | unset → sign-in links are printed to the log |

## Landing pages

An app with `templates/<id>/landing/index.html` gets a public page at `/<id>/` on Cloudflare Pages
(project `snappy`, https://snappy-aon.pages.dev). Plain HTML plus a `media/` folder of real outputs;
the form sends the store link to the studio at `#/new/<id>?url=…`, which prefills the new-session form.

```
bun run landing --serve    # build to dist/landing, preview on :7791
CLOUDFLARE_ACCOUNT_ID=<yours> bun run landing --deploy
```

| env | |
|---|---|
| `LANDING_APP_URL` | the studio's public URL; unset → the form says runs aren't open yet |
| `CF_BEACON_TOKEN` | Cloudflare Web Analytics token; unset → no beacon |
| `LANDING_PROJECT` | Pages project, default `snappy` |

The platform page at https://odapt.ai is `site/` (plain HTML), its own Pages project `odapt`:

```
CLOUDFLARE_ACCOUNT_ID=<yours> wrangler pages deploy site --project-name odapt --branch main
```

### Listed apps

An app whose code and hosting live elsewhere (lofiwave: an open-source repo people run on their own
machines) is `apps/<id>/app.json` with `"kind": "listed"`, a `repo` and a `landing` URL, and no
`deploy` block. The platform only knows its name, so its landing page can post funnel events
(`view`, then its own steps) and `bun run report` shows them. It has no app key: it can't sell or call
providers until it becomes a standalone app. Its landing page is `apps/<id>/landing/`, its own Pages
project:

```
CLOUDFLARE_ACCOUNT_ID=<yours> bunx wrangler pages deploy apps/lofiwave/landing --project-name lofiwave --branch main
```

Lingo Tune (a static browser game) keeps its game and landing page in its own folder, deployed as a
Worker with static assets (`wrangler deploy`, custom domain in its `wrangler.jsonc`); only its
`app.json` is here. Its pages post `view`, `play_click`, `play_view`, `game_start`, `game_end` and a
few more, with an anonymous per-browser `session_id` for counting uniques.

### Standalone apps

To make one, follow **`docs/new-app.md`** (the checklist, with what went wrong last time).

**Private apps.** An app whose code you don't want in this repo lives in `ops/apps/<id>/` (a separate,
private repo cloned at `./ops`, which this repo ignores). `bash scripts/private-apps.sh` links each one
into `apps/` for local work; the deploy runs it with `copy`. The platform can't tell the difference.

An app that doesn't need an agent or the wallet (a fixed price for a fixed job) lives in `apps/<id>/`
with its own server and an `app.json`. The platform holds everything with a key in it; the app holds
only its app key, which the control plane derives and the deploy hands it:

- **Payments.** It asks for a Checkout session for one of its `products` (`odapt.checkout`), the
  control plane's webhook confirms it, records the sale and Stripe's fee in `app_money`, and calls the
  app's `notify_url` (signed with the app key; retried every minute for a day). Refunds go back through
  the platform (`odapt.refund`). No per-app Stripe key or webhook. The template takes payment in place
  first (Apple Pay, Google Pay, Link through the Express Checkout Element, on a domain registered with
  Stripe and with `STRIPE_PUBLISHABLE_KEY` set) and falls back to Stripe's page for a card. A paid
  order goes on the buyer's Odapt account, made from Stripe's email if there's none; that signs no one
  in, it emails once to say the account exists, and the buyer signs in with an email link.
- **Providers.** It calls them through `/apps/<id>/proxy/<provider>` (`odapt.provider`), for the ones
  its `app.json` lists, up to `daily_provider_usd` a day; each call's cost goes in the ledger.
- **Funnel.** `odapt.event(type, props)` from the server, and `POST /events` from landing pages
  (any origin, `text/plain` JSON).
- **Deploy.** `deploy` in `app.json` (`port`, `path`, `apt` packages, `env`): a push to main touching
  `apps/` runs `scripts/deploy-app.sh` for each app (`.github/workflows/deploy-apps.yml`): one shared
  `apps/Dockerfile`, a container `app-<id>` with `/data` at `~/apps-data/<id>`, and a Caddy route at
  `https://api.odapt.ai<path>`. Operator overrides go in `apps-env/<id>.env` in the deploying clone.

```
bun run new-app <id> --name "Name" --price 5     # apps/<id>/ from apps/_template: form → pay → work.ts
APP_FAKE_PAY=1 bun apps/<id>/server.ts           # try it without Stripe
bun run report [--days 30] [--app <id>] [--json] # money and funnel per app, both kinds
```

Only live payments count as money (`app_daily`: sales, refunds, fees, provider cost, net per app per
day). A Stripe account defaults to Managed Payments (Stripe as merchant of record: +3.5% a
sale, a tax code on every line item); every Checkout session sends `managed_payments[enabled]=false`,
and the default itself can only be changed in the Dashboard.

## Make a new app

```
templates/<id>/
  template.json   name, description, modes, inputs (the form), tools, optional model, optional harness
  system.md       appended to the agent's system prompt: panels, flow, rules
  kickoff.md      first message; {{input}}, {{input.<field>}}, {{mode}}
  workspace/      copied into the session's working directory
```

`tools: ["rep", "ffmpeg"]` splices `tools/<name>/doc.md` into the prompt, so the agent has the CLI
reference up front instead of spending turns on `--help`. `requires: [...]` lists tools the app's
scripts use that the agent doesn't need documented. Both must name tools in the catalog.

## Tools

`tools/<name>/tool.json` pins each external command: a download per platform with its sha256, or a
bun script built from a commit. Installed tools go in one store shared by every app
(`$SNAP_TOOLS_DIR`, default `data/tools`); the runner links a session's tools into its `.bin`.

```
bun run tools                       # catalog, what's installed, which apps use each
bun run tools install --for app-ad  # or <name…>, or --all
SNAP_TOOLS_STRICT=1 bun run tools check app-ad
```

With `SNAP_TOOLS_STRICT=1` a session's PATH is its `.bin` plus the OS directories only — how a
packaged build runs, and the way to prove an app declares everything. Without it, a tool missing
from the store falls back to PATH with a warning. `bun test` fails if a template's script runs a
command it hasn't declared. To add a tool: `tools/<name>/tool.json` (+ `doc.md` if the agent calls
it), then `bun run tools install <name>`. `hosted: false` marks a tool that only runs on a user's
machine (yt-dlp); `provider` marks one that calls a paid API (issue #7).

Panel kinds the UI draws: `markdown`, `form`, `script`, `gallery`, `video`; anything else shows as
JSON. Add a renderer in `RENDERERS` in `ui/index.html`. `snap help` is the full agent-side reference.

## Mac app (`bun run build-mac`)

`scripts/build-mac.ts` builds an unsigned `dist/mac/Odapt.app` (`--apps app-ad,…`, default app-ad).
`src/main.ts` compiled with `bun build --compile` is the whole runtime: `odapt` starts the server
and opens it in the browser, `odapt runner <id>` and `odapt cli …` (`snap`) are what the server and
sessions start, and with `BUN_BE_BUN=1` the same binary is bun for template scripts and bun-built
tools (`shim` in `src/config.ts`). `Contents/Resources` holds what `ROOT` points at (ui, prompts,
the tool catalog, the apps), a `node_modules` with only the packages the apps' scripts import, the
store's tools (copied into the user's store on first start, `seedStore`), and Codex's standalone
package as the harness (from this Mac's `codex`).

Packaged, data is in `~/Library/Application Support/Odapt`, the port is 7789, strict tools are on,
and optional settings come from `odapt.env` in the data directory (an app opened from Finder has no
shell env). Signing, notarization and a DMG come next.

**Sign-in and credit** (`src/account.ts`). Packaged, the control plane is https://api.odapt.ai; from
the repo, set `SNAP_CONTROL_URL` (unset: sessions use your own provider keys, as before). With one,
the page shows **Sign in**: the engine asks the control plane for a device code, opens its `/device`
page, and polls until the person approves; the token goes in `account.json` in the data directory
(mode 600) and reaches each runner as `SNAP_CONTROL_TOKEN` when it starts. The page then shows the
balance and an **Add credit** menu (Stripe Checkout in the browser, back to `/billing/done`). A new
session needs a sign-in and at least $0.01; a run that hits zero stops with "You're out of credit",
and a message after topping up continues it. `SNAP_CONTROL_TOKEN` in the env overrides the stored
sign-in; `SNAP_CONTROL_URL=` (empty) in `odapt.env` turns the control plane off in a packaged build.

## Verified so far (2026-09-18, local)

- `name-lab` in editor mode: panels, button press, ask/answer, SIGTERM mid-session → next action
  relaunched the runner and resumed the same conversation, queued answer delivered once.
- `narrated-explainer` as a mock job: script → stills → clips → voice → ffmpeg assembly → 16s 720×1280
  mp4 served back to the page. Real generation (`rep`, `vidwatch`) has **not** been run yet.
- `bun test` covers the fold.

## Not built yet

- **Auth.** Browser routes are open and knowing a session id is access. Fine on localhost only.
- **Cloud.** `launchCloudRun` is a sketch. Still needed: Dockerfile (non-root, claude + bun + ffmpeg +
  rep + vidwatch), a Postgres `Store`, assets to a bucket instead of `data/assets`, and saving
  `~/.claude/projects` + the workspace at park time so a fresh container can resume.
- Credits/billing; only cost *recording* exists. Claude cost is reported as per-turn deltas because
  `total_cost_usd` is cumulative per process.
- Agent turns run ~$0.30–0.60 each at API prices on the default model, mostly the base context.
  Set a cheaper `model` per template where it's good enough.
