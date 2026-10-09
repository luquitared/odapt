# Issues

Open work, newest first within each status. One heading per issue; close it by moving it to
**Closed** with the commit that fixed it.

## Open

### #18 In-page checkout: not yet tried with a real wallet
*Opened 2026-10-09*

Standalone apps can take payment on their own page (`ui: "elements"` on `/apps/<id>/checkout`, the
Express Checkout Element), and a paid order now goes on the buyer's Odapt account (`attachBuyer`).
Stripe accepts the session; the order flow, the account email and `/account`'s order list are
tested against a local database. Left:
- `STRIPE_PUBLISHABLE_KEY` set on the control plane (unset, in-page checkout is refused and the
  template goes to Stripe's page, as before).
- A paid run on a phone with Apple Pay, then one with Google Pay, on `api.odapt.ai`.
- Test mode: `api.odapt.ai` is registered as a payment method domain in live mode only.
- Apps made before this (Duo Swap) still redirect; move them over by hand.

### #17 No public example of a paid standalone app
*Opened 2026-10-08 · the only live one (Duo Swap) is a private app*

The repo has the scaffold (`bun run new-app` from `apps/_template`) and the checklist
(`docs/new-app.md`), but nothing finished to read or run: a fixed-price app that takes an order,
pays through the platform's Checkout and delivers. Someone building their first paid app has to
trust the template. It also leaves the control plane's standalone path covered only by
hand-built objects in `test/apps.test.ts`.

Make a small one in `apps/<id>/` with `new-app`:
- Cheap to run, and no third-party footage, brands or likenesses, so it's safe to feature.
- One product, one provider call through `odapt.provider`, so the proxy and ledger show up in
  `bun run report`.
- Runs end to end with `APP_FAKE_PAY=1` and a mock of the provider, so a fresh clone can try the
  whole flow for $0.
- Linked from the README ("Standalone apps") and from odapt.ai's Get started.
- Once it exists, point `test/apps.test.ts` back at a real `app.json`.

### #16 HTML panels: what the first Lingo canvas run left open
*Opened 2026-10-07 · first game with `"ui": {"html": true}` (local session `ba6f1465b016`)*

- Lingo: in the agent's 8-bit redesign the "Right!" badge is green text on a green box. The page
  isn't checked after a redesign; the agent should screenshot it before saying it's done (no
  browser in the runner yet).
- Phone: the chat rail takes 46vh under the game, so the game gets half the screen. A game-first
  layout per template (`"ui": {"layout": …}`) is the next step.
- The first turn writes the page from scratch with nothing on screen: 36s on Haiku, 72s on
  DeepSeek ("Warming up…" the whole time). Ship a starter `ui/game.html` in
  `templates/lingo/workspace/` and send a progress line before any rewrite.
- Claude in Chrome can't click or type inside the canvas: our CSP `script-src` blocks what the
  extension injects. Real input works (checked with Playwright on Chrome). Drive canvases with
  Playwright, not the extension.

### #15 Lingo: the voice misreports a round's score; the review list can name a right answer
*Opened 2026-10-06 · from the first real voice game (session `63de5df7915f`)*

- After "Dónde está el estación de tren" the agent scored 1 point, but the voice said "Dos puntos
  más. Casi, es «la estación»". The score panel's total was right (18/20). Each turn sends the
  result twice, in the exact `snap voice` instruction and again as the `snap say` message, and the
  voice merged the two loosely. Fix in `templates/lingo/system.md`: give the score only in the
  `snap voice` instruction and keep `snap say` to the correction.
- The final summary listed "¿cómo estás?" to review, though it was answered right. The review list
  should come from rounds that scored below 2.

### #14 Voice: the agent is told the wrong "just before" line, and stray captions
*Opened 2026-10-06 · from the first real voice game (session `63de5df7915f`)*

Bugs in `VoiceBridge` (`src/voice.ts`), seen on the real API:

- Every `voice` action's `before` was "Un momento…", the voice's filler after the answer, instead of
  the challenge it had just asked. Record the voice's last line when the user *starts* talking, not
  when the delegation fires.
- The first answer arrived as "Yes Buenos días": `heard` keeps everything said since the last
  delegation, including a "yes" to the greeting. Keep only speech after the voice's last line, or
  label the earlier part.
- Captions that are only punctuation ("…") are published. Skip them.
- 2026-10-07, session `82991c32d8b0`: a 33s call with no captions either way, not even the greeting.
  A fake-mic call from Playwright on the same session greeted fine, so it looks like the browser's
  WebRTC audio never connected. Unconfirmed; rerun with `SNAP_VOICE_DEBUG=1`.

### #13 Voice: not yet run on the control plane with a real key
*Opened 2026-10-06 · updated 2026-10-06*

**Done:** the first real call, locally with `OPENAI_API_KEY` in `.env`. It was a full ten-round Lingo game on `deepseek-flash` in 3m 2s
(session `63de5df7915f`). WebRTC connected and the `client.data_channel` permissions were accepted.
GPT-Live delegated every answer and never judged one itself. Agent turns took 1–5s, and answer to
next challenge was about 5–8s. Voice was billed $0.15 for 182s, at the listed rate. Bugs found are
#14 and #15.

**Still to do:**
- Make a call through the hosted control plane (its `OPENAI_API_KEY` set). Only the stand-in
  has been through the relay so far.
- Compare metered seconds with OpenAI's usage page.
- Try Lingo on its default model (Haiku; the run above used `deepseek-flash`).
- Lingo's `pricing.json` (2× markup, $0.50 grant) is a placeholder.

### #9 YouTube downloads fail intermittently with 403
*Opened 2026-09-30 · minor*

`grab-media "search:clash royale gameplay"` failed with `HTTP Error 403` on the video data, then
the same search succeeded on retry, with both the catalog's `yt-dlp` (bun as the JS runtime) and the
old pip install (node). Fix: retry once in `grab-media` before failing.

### #8 Runtime and `snap build`: unsigned Mac app spike
*Opened 2026-09-30 · distribution, step 4*

Prove packaging before building around it. `bun build --compile` for the server, runner and `snap`;
data in `~/Library/Application Support/Snappy` (`SNAP_DATA_DIR`, `SNAP_TOOLS_DIR`); the tool store
filled from copies bundled in the app; Codex bundled as the harness (`SNAP_CODEX_BIN`). Pass: a real
Flighty free run and a YouTube `grab-media` on a Mac with nothing installed but the app, under
`SNAP_TOOLS_STRICT=1`. Open questions: the window (default browser vs. a thin webview), and how
signing treats the store's binaries, which are downloaded after install, not shipped inside it.

2026-10-01, spike built (`bun run build-mac`, README "Mac app"): one compiled binary is server,
runner, `snap` and (with `BUN_BE_BUN=1`) bun; the store is seeded from copies in the app, so its
binaries are signed with the app and never quarantined. Run from the bundle with `env -i`,
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, an empty data dir and strict tools: a mock Flighty job, then a
real one (13.6 s 1080×1920 preview, $0.038: $0.03 Replicate, $0.008 agent), and `grab-media
"search:clash royale gameplay"` (90 s of 720p in 26 s, yt-dlp's JS runtime = the app's binary).
`open Odapt.app` also starts and serves. 521 MB unpacked: Codex 330, ffmpeg 126, odapt 60, yt-dlp 35.

Left before this is done:
- A truly clean Mac (a fresh user or a VM): this one has Xcode CLT, and the agent ran `python3`
  in both runs. Without CLT `/usr/bin/python3` is a stub that opens an install dialog. Tell the agent
  python isn't there (system prompt), or ship one.
- ~~Keys~~ done 2026-10-06: the app signs in to the control plane with a device code and runs on the
  user's credit (README "Sign-in and credit"). Verified against a local control plane: sign-in,
  a mock app-ad job billed through the proxy, out of credit mid-run, a signed webhook crediting a
  pack. Not yet: one real live credit-pack purchase on api.odapt.ai (the credit path has never taken
  live money; standalone apps' orders are a different path), and a sign-in from the packaged app.
- The window: browser tab, no Dock icon (`LSUIElement`), and no way to quit but `pkill`. Needs at
  least a menu-bar item with Open / Quit, or a thin webview.
- Codex is copied from this Mac's install; pin a release download with a checksum like the tools.
- Signing (step 5): every Mach-O in the bundle needs our Developer ID and the hardened runtime,
  including Codex's, ffmpeg and yt-dlp (PyInstaller, which unpacks into /tmp at run time).

### #7 One proxy contract for every paid tool
*Opened 2026-09-30 · Replicate done; Gemini left*

Built: a catalog tool's `provider` (`tools/<name>/tool.json`) names its token and base-URL env vars.
With `SNAP_CONTROL_URL` set the runner points them at `<control>/proxy/<app>/<provider>…` with the
user's token and removes every provider key from the session (`providerEnv` in `src/tools.ts`).
`rep` reads `REPLICATE_API_BASE` (replicate-cli `6af1cd5`). Verified against the local control plane
with the store's `rep` and nothing else in its environment: a prompt-only and a file-input
`minimax/image-01` call, each charged $0.035 to the test user ($0.01 × 3.5).

Left: a Gemini upstream in `control/proxy.ts` for `vidwatch` (pricing from `usageMetadata`; video
uploads go through the Files API, so the proxy carries the upload too), then `base_url_env` in its
manifest — `@google/genai` takes a base URL in `httpOptions`, so vidwatch needs an env override like
rep's. Until then vidwatch gets no key on the control plane. Not done: making providers config
instead of code in the proxy. OpenRouter (reported cost) and Replicate (priced up front, refunded on
failure) bill differently, so with two providers the code stays.

### #1 Engine under-reports agent cost on OpenRouter (~4×)
*Opened 2026-09-30 · billing unaffected · affects cost numbers in the UI and docs*

The Codex harness (`src/harnesses/codex.ts`, `lookupPrice`) prices tokens with the model's listed
price on OpenRouter, which is the **cheapest** provider. OpenRouter routes each request to whichever
provider it picks, so the real price can be much higher.

Measured on app-ad session `fd54a77821ba` (Flighty, mock, job mode, through the control plane):

| | input $/M | output $/M | session cost |
|---|---|---|---|
| Engine's estimate (OpenInference prices) | 0.016 | 0.40 | $0.0044 |
| Actually billed (routed to **Together**) | 0.30 | 1.20 | **$0.0184** |

Tokens: 302,801 input (279,680 cached), 8,116 output. Together's prices reproduce the billed
amount exactly. The control-plane ledger is correct because it uses the `usage.cost` OpenRouter
returns; only the engine's own figure is wrong. Earlier agent costs recorded on `deepseek-flash`
(e.g. $0.021 in earlier planning notes) came from the same estimate, so treat them as too low.

Fix:
1. Real cost per session: put the session in the proxy path
   (`/proxy/<app>/s/<session>/openrouter/v1`), add `session_id` to `credit_ledger`, and read cost per
   run, app and variant from the ledger.
2. Label the engine's figure as an estimate when it isn't coming from the control plane (local dev;
   Codex doesn't expose OpenRouter's cost).
3. Decide routing deliberately: `deepseek/deepseek-v4.1-flash:floor` always takes the cheapest
   provider (~4× cheaper agent). Run one Flighty comparison for speed, tool-call reliability and
   output before making it the default.

### #5 Failed Replicate predictions are only refunded when polled
*Opened 2026-09-30 · minor*

The proxy refunds a failed or canceled prediction the next time its status is read through the
proxy. One that is never read again keeps its charge. Fix: a periodic sweep of recent
`replicate:*` charges with no refund row, or a Replicate webhook.

## Closed

### #3 Stripe checkout not tested against a real account
The first live order (a standalone app, 2026-10-02) ran the whole chain with real money: live Checkout →
webhook → control plane ledger → `order.paid` callback → render → done, and `bun run report` shows
the sale, Stripe's fee, the provider cost and the net.

### #6 Auth is hand-rolled, but Better Auth was decided
Moved to Better Auth 1.7 (`control/auth.ts`): Google, magic links, and its device-authorization
plugin for desktop sign-in, on our `users` table so the ledger's foreign key holds. Email-link and
device sign-in verified locally end to end, and the device token works as a Bearer token on the
proxy. Google sign-in is configured but not yet tried end to end.

### #4 Control plane not deployed
Deployed behind Caddy at https://api.odapt.ai; a
push to `main` touching `control/` redeploys it. Health, the login page and a device sign-in verified
from outside. Stripe keys (#3) and email (#10) aren't set there yet.

### #2 Generation calls bypass the proxy
`rep` reads `REPLICATE_API_BASE` and the runner sets it with the user's token on the control plane
(see #7). The proxy now hands Replicate its own URL for uploaded files instead of the proxy's, which
it couldn't fetch — that would have broken `make-final`'s first frames.
