// Stripe for the whole platform: credit packs for agent apps (the wallet) and one-off orders for
// standalone apps (orders.ts). One key, one webhook endpoint. No SDK: form-encoded calls and a
// signature check. The webhook is what confirms a payment.

import { PUBLIC_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "./config";
import type { Db } from "./db";
import { pricing, record } from "./ledger";
import { orderPaid } from "./orders";

// Stripe's form encoding: nested objects become a[b][c]=v.
export function form(o: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

// Only live payments are money: test-mode orders aren't written to app_money, unless
// CONTROL_RECORD_TEST_PAYMENTS=1 (local testing against a throwaway database).
export const countsAsMoney = (livemode: boolean) => livemode || process.env.CONTROL_RECORD_TEST_PAYMENTS === "1";

export async function stripeApi(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string) {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    // Pinned so a change to the account's default version can't change what these calls return.
    headers: {
      authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2026-08-26.dahlia",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: body ? form(body) : undefined,
  });
  const j = (await r.json()) as any;
  if (!r.ok) throw new Error(`stripe ${path}: ${j.error?.message ?? r.status}`);
  return j;
}

export async function checkout(sql: Db, user: { id: string; email: string }, app: string, packId: string, returnUrl?: string) {
  const pack = pricing(app)?.packs.find((p) => p.id === packId);
  if (!pack) throw new Error(`no pack "${packId}" for ${app}`);
  const [c] = await sql`SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ${user.id}`;
  const back = returnUrl ?? `${PUBLIC_URL}/account`;
  const s = await stripeApi("POST", "checkout/sessions", {
    mode: "payment",
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(pack.usd * 100), product_data: { name: `Odapt credits — ${pack.label}` } } } },
    ...(c ? { customer: c.stripe_customer_id } : { customer_email: user.email, customer_creation: "always" }),
    client_reference_id: user.id,
    metadata: { app, pack: pack.id, credit_usd: pack.usd },
    integration_identifier: "odapt-credits-syipgmaz", // groups these sessions in the Dashboard
    // Off for every session: see apps/lib/stripe.ts (Managed Payments is the account's default).
    managed_payments: { enabled: false },
    success_url: `${back}${back.includes("?") ? "&" : "?"}paid=1`,
    cancel_url: back,
  });
  return { url: s.url as string, id: s.id as string };
}

// https://docs.stripe.com/webhooks#verify-manually. `secret` may list several, comma-separated (the
// test-mode and live endpoints each have their own).
export async function verifySignature(payload: string, header: string | null, secret = STRIPE_WEBHOOK_SECRET, toleranceS = 300, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  const secrets = secret.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length > 1) {
    for (const s of secrets) if (await verifySignature(payload, header, s, toleranceS, now)) return true;
    return false;
  }
  const parts = Object.groupBy(header.split(",").map((kv) => kv.split("=", 2) as [string, string]), ([k]) => k);
  const t = parts.t?.[0]?.[1];
  const sigs = (parts.v1 ?? []).map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(now / 1000 - Number(t)) > toleranceS) return false;
  const expected = new Bun.CryptoHasher("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export async function handleWebhook(sql: Db, payload: string, signature: string | null): Promise<{ status: number; note: string }> {
  if (!(await verifySignature(payload, signature))) return { status: 400, note: "bad signature" };
  const ev = JSON.parse(payload);
  if (ev.type !== "checkout.session.completed" && ev.type !== "checkout.session.async_payment_succeeded") return { status: 200, note: `ignored ${ev.type}` };
  const s = ev.data.object;
  if (s.payment_status !== "paid") return { status: 200, note: "not paid yet" };
  if (s.metadata?.kind === "app-order") return { status: 200, note: await orderPaid(sql, s) };
  const userId = s.client_reference_id as string, app = s.metadata?.app as string;
  // What was actually charged, not what the pack said when the session was made.
  const usd = Number(s.amount_total) / 100;
  if (s.customer) {
    await sql`INSERT INTO stripe_customers (user_id, stripe_customer_id) VALUES (${userId}, ${s.customer}) ON CONFLICT DO NOTHING`;
  }
  // Keyed by the session, so the completed and async-succeeded events can't both credit it.
  const added = await record(sql, { userId, app, deltaUsd: usd, reason: "purchase", ref: `stripe:${s.id}` });
  return { status: 200, note: added ? `credited ${usd}` : "already credited" };
}
