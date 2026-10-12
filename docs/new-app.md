# New app checklist

For a standalone app (`apps/<id>/`: a fixed job at a fixed price, paid up front). How the pieces
work is in the README ("Standalone apps"); this is what to do, in order, and what bit us last time.

## 1. Make it

- [ ] `bun run new-app <id> --name "Name" --price 5`. It picks a free port and the path
      (`https://api.odapt.ai/<id>`, or `--path`), and writes `app.json`, a server, two pages and
      `work.ts`.
- [ ] **Price it from the cost.** Price ≥ provider cost + Stripe's 2.9% + $0.30, with room for
      failures: a refund returns the customer's money but Stripe keeps its fee, and the provider
      usually still bills the failed job. Managed Payments (Stripe as merchant of record, +3.5%) is off
      on every session; keep it that way unless we decide to hand Stripe the sales tax.
- [ ] Write the job in `work.ts`. Throwing fails the order and refunds it.
- [ ] **A paid provider goes through the platform.** Add it to `control/providers.json` (base URL, key
      env, auth header, where the response says its cost), put its key in the control plane's `control.env` (see 5),
      list it in the app's `app.json` `providers`, and set `daily_provider_usd`. Call it with
      `odapt.provider("<name>")`. A provider that doesn't report cost isn't tracked yet: check before
      relying on it.
- [ ] System packages the job needs (ffmpeg, ImageMagick, `libheif-examples` for iPhone photos) go in
      `deploy.apt`.

## 2. URLs and pages

- [ ] **Every URL in a page must work under the app's path.** The app is served at
      `https://api.odapt.ai/<path>/`; `/api/…` from the page goes to the control plane instead (that was
      Duo Swap's "$NaN" bug). The template injects `{{BASE}}`: use it for every fetch and link.
- [ ] **Large or private media isn't in git or the image.** Gitignore `public/media`, upload what the
      public page needs to R2 (`odapt-media` bucket, served at `https://media.odapt.ai/<id>/…`) and pass
      that URL in through `deploy.env`.
- [ ] Decide the front door. The app's own page at `https://api.odapt.ai/<path>/` works with no extra
      setup. A separate marketing page on Cloudflare Pages (`<project>.pages.dev`) is optional: it's
      static, posts orders to the app's API (the template answers CORS), and its funnel events go to
      `https://api.odapt.ai/events`. A custom domain (`<id>.odapt.ai`, or the app's own) is a DNS record
      plus a Pages domain.
- [ ] Funnel events: `view` on the page, then the order's steps (`checkout_started`, `paid`, `done`,
      `failed` come from the template). Add the app's own steps between.
- [ ] The front door's look: see "Front door" below.

## Front door (every app, listed or standalone)

A listed app (README, "Listed apps") skips the rest of this checklist but does all of this.

- [ ] **A logo.** One SVG (works at 16px: no thin strokes, no small text) plus a 512px PNG of it.
      Headless Chrome renders the PNGs (`--screenshot`, transparent background) and `sips -z` scales
      them; its window can't go below ~500px, so render big and scale down.
- [ ] **Favicons.** `favicon.svg`, `favicon.ico` (16/32/48, PNG payloads are fine) and a 180px
      `apple-touch-icon.png`, linked from every page.
- [ ] **A link preview.** A 1200×630 `og.png` (name, one line of what it does, a picture of it), with
      `og:title`, `og:description`, `og:image` (absolute URL), `og:image:width/height`, `og:url` and
      `twitter:card` `summary_large_image`. Check the image URL returns 200 after deploy: previews
      cache the first answer they get.
- [ ] **Analytics.** An `events.js` posting `view` (with the referrer) and the page's own steps (copy,
      outbound clicks, `scroll_deep`) to `https://api.odapt.ai/events`, an anonymous per-browser
      `session_id`, a no-op on localhost. Copy Lingo Tune's or ccx's.
- [ ] **A public repo is checked first.** Grep for keys, home paths, customer and project names
      (examples in a README or `--help` count), then `gh repo create --public`. Add a LICENSE.
- [ ] Works at phone width: the page is screenshotted at ~375px before it ships.

## 3. Limits (before strangers can reach it)

- [ ] A daily order cap (each paid order is real provider spend) and the platform's
      `daily_provider_usd` above it.
- [ ] A per-address limit on new orders. The template's is in memory; Duo Swap's is in SQLite and
      survives restarts.
- [ ] Delete unpaid orders' uploads after a day, and decide how long paid orders' inputs are kept (they
      sit in `/data` until something deletes them).
- [ ] Uploads: a size limit, the formats phones actually make (HEIC), and expect browsers not to
      preview HEIC.

## 4. Test, in three steps

- [ ] **Locally:** `APP_FAKE_PAY=1` (no Stripe) and a mock of the provider. Against a throwaway Postgres
      with the control plane running locally, `CONTROL_RECORD_TEST_PAYMENTS=1` makes test payments show in
      `bun run report`.
- [ ] **Production in test mode:** push to main (it deploys), and put mock switches in
      `apps-env/<id>.env` on the server while the control plane is on a test key. Anyone
      who finds the page can pay with a test card, so nothing that costs money may run in this mode.
- [ ] **The hosted Checkout page needs a person.** Agents can't drive `checkout.stripe.com`: click
      through once with the test card `4242 4242 4242 4242`. The in-page wallet buttons need one too,
      on a phone or a browser with a wallet; elsewhere the page goes straight to the card fallback.
      Wallet buttons only show on domains registered with Stripe (payment method domains, per mode):
      `api.odapt.ai` is; a Pages front door isn't until it's registered too.
- [ ] Stripe CLI gotcha: after `stripe login` the profile can sit in live mode and stop holding a test
      key. Pass the key explicitly (`stripe listen --api-key …`) and check which account a key belongs to
      (`GET /v1/account`) before using it.

## 5. Keys (rarely: only for a new provider or a new Stripe key)

- [ ] Apps never hold a provider or Stripe key; the deploy hands each app its own app key.
- [ ] New keys go straight from the clipboard into the control plane's `control.env`, never through
      chat or git, then restart the control plane.

## 6. Before taking money

- [ ] The Stripe account's public business name and website are set (Checkout shows the legal name
      until then).
- [ ] Terms, privacy and a refund contact are on the page.
- [ ] Rights: whatever the app sells or builds on (footage, music, likenesses, brands) is ours to use,
      and the provider's content filters won't refuse the common case.

## 7. Go live

- [ ] Remove the app's mock switches from `apps-env/<id>.env`, redeploy (`gh workflow run deploy-apps.yml -f app=<id>`).
- [ ] One real order with a real card, end to end.
- [ ] `bun run report --app <id> --days 1`: a sale, Stripe's fee and the provider cost, and the funnel.
- [ ] Refund it through the platform if it was only a test.
- [ ] Publish the front door (open the Pages form, or link the app's page).
- [ ] Issues for the app go in `issues.md` with the app's name in the title.
