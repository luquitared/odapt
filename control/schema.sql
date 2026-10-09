-- Applied in order by db.ts; each statement must be safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE, -- stored lowercased
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Better Auth (control/auth.ts) owns sign-in: these columns on users, and the auth_* tables.
-- Generated with `bunx auth generate --config control/auth.ts`, made re-runnable. `name` defaults to ''
-- because users from before Better Auth have none (an email link doesn't give one; Google does).
ALTER TABLE users ADD COLUMN IF NOT EXISTS name           text        NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS image          text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE, -- the cookie, and the Bearer token apps send
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions (user_id);

-- One row per way a user signs in: google, or magic-link users have none until they use Google.
CREATE TABLE IF NOT EXISTS auth_accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_accounts_user_id_idx ON auth_accounts (user_id);

-- Magic links and OAuth state.
CREATE TABLE IF NOT EXISTS auth_verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  value      text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_verifications_identifier_idx ON auth_verifications (identifier);

-- Desktop sign-in (RFC 8628). client_id is the app.
CREATE TABLE IF NOT EXISTS auth_device_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code      text NOT NULL,
  user_code        text NOT NULL,
  user_id          text,
  expires_at       timestamptz NOT NULL,
  status           text NOT NULL, -- pending | approved | denied
  last_polled_at   timestamptz,
  polling_interval integer,
  client_id        text,
  scope            text
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_device_codes_device_code_uidx ON auth_device_codes (device_code);
CREATE UNIQUE INDEX IF NOT EXISTS auth_device_codes_user_code_uidx ON auth_device_codes (user_code);

-- UNUSED since Better Auth (2026-09-30): tokens, login_links, device_codes. Kept until dropped on purpose.
-- Bearer tokens for browsers (cookie) and desktop apps (device flow). Only the hash is kept.
CREATE TABLE IF NOT EXISTS tokens (
  hash         text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL, -- web | device
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE IF NOT EXISTS login_links (
  hash        text PRIMARY KEY,
  email       text NOT NULL,
  app_id      text,
  device_code text, -- set when the login was started by a desktop app
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

CREATE TABLE IF NOT EXISTS device_codes (
  code       text PRIMARY KEY,  -- the app polls with this
  user_code  text NOT NULL UNIQUE, -- the person sees this
  app_id     text NOT NULL,
  user_id    uuid REFERENCES users(id),
  claimed_at timestamptz,       -- the app has collected its token
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS stripe_customers (
  user_id            uuid PRIMARY KEY REFERENCES users(id),
  stripe_customer_id text NOT NULL UNIQUE
);

-- The wallet. Balance is the sum; nothing is ever updated in place. Retail dollars: a purchase
-- adds what was paid, usage subtracts provider cost × the app's markup (cost_usd keeps the raw cost).
-- `ref` makes Stripe webhooks, grants and proxy charges idempotent.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id),
  app_id    text NOT NULL,
  delta_usd numeric(14, 6) NOT NULL,
  cost_usd  numeric(14, 6),
  reason    text NOT NULL, -- grant | purchase | openrouter | replicate | openai-live | refund | adjust
  ref       text UNIQUE,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_user ON credit_ledger (user_id);
CREATE INDEX IF NOT EXISTS credit_ledger_at ON credit_ledger (at);

-- Product analytics from every app: the funnel is a query over this.
CREATE TABLE IF NOT EXISTS events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id),
  app_id     text NOT NULL,
  variant    text,
  session_id text,
  type       text NOT NULL,
  props      jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_app_type ON events (app_id, type, at);

-- Money for standalone apps (apps/<id>/), which take payment with their own Stripe Checkout and call
-- providers directly. Signed: a sale is +, its refund, Stripe's fee and the provider's cost are −.
-- `ref` (the Stripe or provider id) makes a retried report count once.
CREATE TABLE IF NOT EXISTS app_money (
  id       bigserial PRIMARY KEY,
  app_id   text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('sale', 'refund', 'fee', 'cost')),
  usd      numeric(14, 6) NOT NULL,
  provider text,           -- stripe | muapi | …
  order_id text,           -- the app's own order or session id
  ref      text NOT NULL UNIQUE,
  props    jsonb NOT NULL DEFAULT '{}',
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_money_app_at ON app_money (app_id, at);

-- Cash in and out per app per UTC day, for both kinds of app. Agent apps: credit packs bought are
-- sales, the proxy's raw provider cost is cost (wallet grants and spending aren't cash, so they're out).
-- Stripe fees are only known for standalone apps so far.
CREATE OR REPLACE VIEW app_daily AS
SELECT app_id, day,
  count(*) FILTER (WHERE kind = 'sale')                    AS orders,
  coalesce(sum(usd) FILTER (WHERE kind = 'sale'), 0)       AS sales_usd,
  coalesce(-sum(usd) FILTER (WHERE kind = 'refund'), 0)    AS refunds_usd,
  coalesce(-sum(usd) FILTER (WHERE kind = 'fee'), 0)       AS fees_usd,
  coalesce(-sum(usd) FILTER (WHERE kind = 'cost'), 0)      AS provider_usd,
  coalesce(sum(usd), 0)                                    AS net_usd
FROM (
  SELECT app_id, (at AT TIME ZONE 'utc')::date AS day, kind, usd FROM app_money
  UNION ALL
  SELECT app_id, (at AT TIME ZONE 'utc')::date, 'sale', delta_usd FROM credit_ledger WHERE reason = 'purchase'
  UNION ALL
  SELECT app_id, (at AT TIME ZONE 'utc')::date, 'cost', -cost_usd FROM credit_ledger WHERE cost_usd IS NOT NULL
) m
GROUP BY app_id, day;

-- Standalone apps' orders on the platform's Stripe account (orders.ts): one row per Checkout session.
CREATE TABLE IF NOT EXISTS app_payments (
  session_id     text PRIMARY KEY,
  app_id         text NOT NULL,
  order_id       text NOT NULL,
  product        text NOT NULL,
  usd            numeric(14, 6) NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'refunded')),
  livemode       boolean NOT NULL DEFAULT false,
  payment_intent text,
  email          text,
  notify_url     text,
  notified_at    timestamptz,
  fee_usd        numeric(14, 6),
  created_at     timestamptz NOT NULL DEFAULT now(),
  paid_at        timestamptz,
  refunded_at    timestamptz
);
CREATE INDEX IF NOT EXISTS app_payments_app_order ON app_payments (app_id, order_id);

-- The Odapt account a paid order belongs to, made from Stripe's email if there wasn't one (orders.ts,
-- attachBuyer). Paying doesn't sign anyone in: the buyer claims the account with an email link.
ALTER TABLE app_payments ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS app_payments_user ON app_payments (user_id);
