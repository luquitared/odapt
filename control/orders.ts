// One-off orders for standalone apps, on the platform's Stripe account. The app never holds a Stripe
// key: with its app key it asks for a Checkout session for one of the products in its app.json, and
// hears back through a signed callback once the payment is confirmed.
//
//   POST /apps/<id>/checkout {order_id, product, email?, success_url, cancel_url, notify_url?} → {id, url}
//        with ui: "elements" → {id, url: null, client_secret, publishable_key}: the app's page shows
//        Stripe's Express Checkout Element (Apple Pay, Google Pay, Link) in place, then Stripe sends the
//        buyer to success_url. No cancel_url. The payment is confirmed the same way as a redirect one.
//   GET  /apps/<id>/payments/<session>   status, checked with Stripe while still open (the success
//                                        redirect can arrive before the webhook)
//   POST /apps/<id>/refund {session_id}  refunds in full, once
//   POST /apps/<id>/email {order_id, subject, text, key?}  emails the buyer of a paid (or refunded)
//                                        order, at the address Stripe has; the app never needs it.
//                                        One message per (order, key), however often it's asked.
//
// When a session is paid (webhook or status check, whichever is first) the sale goes in app_money,
// Stripe's fee follows once Stripe attaches it, and notify_url gets
//   POST {type: "order.paid", app, order_id, session_id, email, usd}
//   Odapt-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>" keyed by the app key>
// Fees and callbacks that don't go through are retried by sweep(), every minute.
//
// A paid order also belongs to an Odapt account: the buyer's, found or made from the email Stripe has
// (live payments only). Paying never signs anyone in: a new account gets one email saying it exists,
// and the buyer signs in with an email link like anyone else (attachBuyer).

import { app, appKey, type App } from "./apps";
import { MAIL_FROM, ORDERS_MAIL, PUBLIC_URL, STRIPE_PUBLISHABLE_KEY } from "./config";
import type { Db } from "./db";
import { recordMoney } from "./ledger";
import { sendMail } from "./mail";
import { countsAsMoney, stripeApi } from "./stripe";

export interface CheckoutRequest {
  order_id: string;
  product: string;
  email?: string;
  success_url: string; // may contain {CHECKOUT_SESSION_ID}
  cancel_url?: string; // not with ui: "elements"
  notify_url?: string;
  ui?: "elements";
}

const httpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\/[^\s]+$/.test(u) && u.length < 1000;

export function checkoutError(a: App, b: any): string | null {
  if (typeof b?.order_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(b.order_id)) return "order_id is required (letters, digits, _ and -)";
  if (!a.products[b.product]) return `unknown product; ${a.id} sells: ${Object.keys(a.products).join(", ") || "nothing (add products to app.json)"}`;
  if (b.ui != null && b.ui !== "elements") return `ui must be "elements" (in-page) or left out (Stripe's page)`;
  if (b.ui === "elements") {
    if (!httpUrl(b.success_url)) return "success_url must be an http(s) URL";
    if (b.cancel_url != null) return "cancel_url isn't used in-page; leave it out";
  } else if (!httpUrl(b.success_url) || !httpUrl(b.cancel_url)) return "success_url and cancel_url must be http(s) URLs";
  if (b.notify_url != null && !httpUrl(b.notify_url)) return "notify_url must be an http(s) URL";
  if (b.email != null && typeof b.email !== "string") return "email must be a string";
  return null;
}

export async function createCheckout(sql: Db, a: App, b: CheckoutRequest) {
  const product = a.products[b.product];
  const inPage = b.ui === "elements";
  if (inPage && !STRIPE_PUBLISHABLE_KEY) throw new Error("in-page checkout isn't set up here (STRIPE_PUBLISHABLE_KEY)");
  const s = await stripeApi("POST", "checkout/sessions", {
    mode: "payment",
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(product.usd * 100), product_data: { name: product.name } } } },
    ...(b.email ? { customer_email: b.email } : {}),
    client_reference_id: b.order_id,
    metadata: { kind: "app-order", app: a.id, order: b.order_id, product: b.product },
    integration_identifier: "odapt-app-orders-t4wqmzkc", // groups these sessions in the Dashboard
    // The account defaults to Managed Payments (Stripe as merchant of record, +3.5% a sale, a tax code on
    // every line item). We're the merchant; the default itself can only be changed in the Dashboard.
    managed_payments: { enabled: false },
    ...(inPage ? { ui_mode: "elements", return_url: b.success_url } : { success_url: b.success_url, cancel_url: b.cancel_url }),
  });
  await sql`
    INSERT INTO app_payments (session_id, app_id, order_id, product, usd, notify_url, livemode)
    VALUES (${s.id}, ${a.id}, ${b.order_id}, ${b.product}, ${product.usd}, ${b.notify_url ?? null}, ${!!s.livemode})`;
  if (inPage) return { id: s.id as string, url: null, client_secret: s.client_secret as string, publishable_key: STRIPE_PUBLISHABLE_KEY };
  return { id: s.id as string, url: s.url as string };
}

export interface Payment {
  session_id: string;
  app_id: string;
  order_id: string;
  product: string;
  usd: number;
  status: "open" | "paid" | "refunded";
  payment_intent: string | null;
  email: string | null;
  notify_url: string | null;
  livemode: boolean;
}

const getPayment = async (sql: Db, sessionId: string): Promise<Payment | null> =>
  ((await sql`SELECT *, usd::float8 AS usd FROM app_payments WHERE session_id = ${sessionId}`)[0] as Payment) ?? null;

export const publicPayment = (p: Payment) => ({
  session_id: p.session_id, order_id: p.order_id, product: p.product, usd: p.usd, status: p.status, email: p.email, livemode: p.livemode,
});

// A paid Checkout session (from the webhook or a status check). Idempotent: only the first call records it.
export async function orderPaid(sql: Db, s: any): Promise<string> {
  if (s.payment_status !== "paid") return "not paid yet";
  const [p] = (await sql`
    UPDATE app_payments SET status = 'paid', payment_intent = ${s.payment_intent ?? null},
      email = coalesce(email, ${s.customer_details?.email ?? null}), paid_at = now()
    WHERE session_id = ${s.id} AND status = 'open' RETURNING *, usd::float8 AS usd`) as Payment[];
  if (!p) return "order already recorded (or unknown session)";
  const charged = Number(s.amount_total) / 100;
  if (countsAsMoney(p.livemode)) {
    await recordMoney(sql, p.app_id, { kind: "sale", usd: charged, ref: `stripe:${p.session_id}`, provider: "stripe", order_id: p.order_id });
  }
  void notify(sql, p).catch(() => {});
  void expireOthers(sql, p).catch(() => {});
  if (countsAsMoney(p.livemode)) void attachBuyer(sql, p).catch((e) => console.error(`[orders] buyer ${p.app_id}/${p.order_id}: ${e.message}`));
  setTimeout(() => void recordFee(sql, p).catch(() => {}), 5_000); // Stripe attaches the fee a few seconds later
  return `order ${p.app_id}/${p.order_id} paid ${charged}`;
}

export async function paymentStatus(sql: Db, a: App, sessionId: string): Promise<Payment | null> {
  let p = await getPayment(sql, sessionId);
  if (!p || p.app_id !== a.id) return null;
  if (p.status === "open") {
    const s = await stripeApi("GET", `checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (s.payment_status === "paid") {
      await orderPaid(sql, s);
      p = await getPayment(sql, sessionId);
    }
  }
  return p;
}

export async function refund(sql: Db, a: App, sessionId: string): Promise<Payment | null> {
  const p = await getPayment(sql, sessionId);
  if (!p || p.app_id !== a.id) return null;
  if (p.status === "refunded") return p;
  if (p.status !== "paid" || !p.payment_intent) throw new Error("only a paid order can be refunded");
  // One refund per payment, however many times the app asks.
  await stripeApi("POST", "refunds", { payment_intent: p.payment_intent, metadata: { app: a.id, order: p.order_id } }, `refund-${p.payment_intent}`);
  await sql`UPDATE app_payments SET status = 'refunded', refunded_at = now() WHERE session_id = ${sessionId}`;
  if (countsAsMoney(p.livemode)) {
    await recordMoney(sql, a.id, { kind: "refund", usd: p.usd, ref: `stripe-refund:${p.payment_intent}`, provider: "stripe", order_id: p.order_id });
  }
  return { ...p, status: "refunded" };
}

// An order can have had two sessions (in-page, then Stripe's page for a card): once one is paid, the
// rest can't be, so a buyer can't pay twice.
async function expireOthers(sql: Db, p: Payment) {
  const open = await sql`SELECT session_id FROM app_payments WHERE app_id = ${p.app_id} AND order_id = ${p.order_id} AND status = 'open' AND session_id != ${p.session_id}`;
  for (const o of open) {
    await stripeApi("POST", `checkout/sessions/${encodeURIComponent(o.session_id)}/expire`).catch((e) => console.error(`[orders] expire ${o.session_id}: ${e.message}`));
  }
}

// The order goes on the buyer's Odapt account, made from their email if there's none. Made here, it's
// unverified (anyone can type an address into Checkout), so it signs nobody in: the one email says it
// exists and points at the sign-in page, whose link proves the address.
export async function attachBuyer(sql: Db, p: Payment): Promise<"attached" | "created" | "no-email"> {
  const email = normalizeEmail(p.email);
  if (!email) return "no-email";
  const [made] = await sql`INSERT INTO users (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING RETURNING id`;
  const [u] = made ? [made] : await sql`SELECT id FROM users WHERE email = ${email}`;
  await sql`UPDATE app_payments SET user_id = ${u.id} WHERE session_id = ${p.session_id}`;
  if (!made) return "attached";
  const name = app(p.app_id)?.name ?? p.app_id;
  await sendMail({
    from: MAIL_FROM,
    to: email,
    subject: `Your ${name} order is saved to an Odapt account`,
    text: `You paid for ${name}, which runs on Odapt, so the order is saved to an Odapt account under this address.\n\n` +
      `Sign in to see it, and use the same account in any other Odapt app:\n${PUBLIC_URL}/login?email=${encodeURIComponent(email)}\n\n` +
      `Nothing to do if you'd rather not: the account stays unused.`,
    idempotencyKey: `buyer-account/${u.id}`,
  });
  return "created";
}

// Lowercased, as users.email is stored (the same as auth.ts, which this can't import: it opens the pool).
const normalizeEmail = (e: unknown) => {
  const s = String(e ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

async function recordFee(sql: Db, p: Payment) {
  if (!p.payment_intent) return;
  const pi = await stripeApi("GET", `payment_intents/${encodeURIComponent(p.payment_intent)}?expand[]=latest_charge.balance_transaction`);
  const fee = pi.latest_charge?.balance_transaction?.fee;
  if (typeof fee !== "number") return; // not attached yet; sweep() asks again
  await sql`UPDATE app_payments SET fee_usd = ${fee / 100} WHERE session_id = ${p.session_id}`;
  if (countsAsMoney(p.livemode)) {
    await recordMoney(sql, p.app_id, { kind: "fee", usd: fee / 100, ref: `stripe-fee:${p.payment_intent}`, provider: "stripe", order_id: p.order_id });
  }
}

export function signNotify(body: string, key: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${new Bun.CryptoHasher("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

async function notify(sql: Db, p: Payment) {
  if (!p.notify_url) return;
  const body = JSON.stringify({ type: "order.paid", app: p.app_id, order_id: p.order_id, session_id: p.session_id, email: p.email, usd: p.usd, livemode: p.livemode });
  const r = await fetch(p.notify_url, {
    method: "POST",
    headers: { "content-type": "application/json", "odapt-signature": signNotify(body, appKey(p.app_id)) },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (r?.ok) await sql`UPDATE app_payments SET notified_at = now() WHERE session_id = ${p.session_id}`;
  else console.error(`[orders] notify ${p.app_id}/${p.order_id} failed (${r?.status ?? "no response"}); will retry`);
}

// Every minute: callbacks that didn't land (for a day), fees Stripe hadn't attached yet (for a month).
export async function sweep(sql: Db) {
  const unnotified = (await sql`
    SELECT *, usd::float8 AS usd FROM app_payments
    WHERE status = 'paid' AND notify_url IS NOT NULL AND notified_at IS NULL AND paid_at > now() - interval '1 day'`) as Payment[];
  for (const p of unnotified) await notify(sql, p).catch(() => {});
  const noFee = (await sql`
    SELECT *, usd::float8 AS usd FROM app_payments
    WHERE status != 'open' AND fee_usd IS NULL AND payment_intent IS NOT NULL
      AND paid_at < now() - interval '5 seconds' AND paid_at > now() - interval '30 days'`) as Payment[];
  for (const p of noFee) await recordFee(sql, p).catch(() => {});
}

export function orderEmailError(b: any): string | null {
  if (typeof b?.order_id !== "string" || !b.order_id) return "order_id is required";
  if (typeof b.subject !== "string" || !b.subject.trim() || b.subject.length > 200) return "subject is required (up to 200 characters)";
  if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 5000) return "text is required (up to 5000 characters)";
  if (b.key != null && (typeof b.key !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(b.key))) return "key must be letters, digits, _ and -";
  return null;
}

// Only to whoever paid for this app's order: an app key can't be used to email anyone else.
export async function emailBuyer(sql: Db, a: App, b: { order_id: string; subject: string; text: string; key?: string }): Promise<"sent" | "no-email" | null> {
  const [p] = await sql`
    SELECT email FROM app_payments
    WHERE app_id = ${a.id} AND order_id = ${b.order_id} AND status IN ('paid', 'refunded')
    ORDER BY created_at DESC LIMIT 1`;
  if (!p) return null;
  if (!p.email) return "no-email";
  await sendMail({
    from: `${a.name.replace(/[<>"]/g, "")} <${ORDERS_MAIL}>`,
    to: p.email,
    subject: b.subject.trim(),
    text: b.text,
    idempotencyKey: `${a.id}/${b.order_id}/${b.key ?? "default"}`,
  });
  return "sent";
}
