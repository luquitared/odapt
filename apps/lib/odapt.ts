// A standalone app's line to the control plane, which holds the Stripe account and the provider keys:
// the app holds only its app key.
//
//   const odapt = platform("duo-swap", DATA_DIR);
//   const s = await odapt.checkout({ order_id, product: "video", success_url, cancel_url, notify_url });
//   const s = await odapt.checkout({ order_id, product: "video", success_url, notify_url, ui: "elements" });
//     // in-page: s.client_secret and s.publishable_key for Stripe's Express Checkout Element; no cancel_url
//   const paid = await odapt.verifyNotify(req);      // in the notify_url handler: the signed "order.paid"
//   await odapt.payment(sessionId); await odapt.refund(sessionId);
//   await odapt.email({ order_id, subject, text, key: "done" }); // to the buyer, once per key
//   fetch(odapt.provider("muapi").url("/api/v1/…"), { headers: odapt.provider("muapi").headers })
//   odapt.event("paid", { order_id });
//
// Sales, Stripe fees, refunds and provider costs are recorded by the control plane itself. Events (and
// money() for anything it can't see) go out in the background and never fail an order: an undelivered
// one waits in <dataDir>/odapt-outbox.jsonl and is sent again on the next report or restart.
//
// env: ODAPT_URL      default https://api.odapt.ai
//      ODAPT_APP_KEY  from `bun control/apps.ts key <id>` on the control plane; unset → reports are
//                     logged and dropped (local development)

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";

export interface Money {
  kind: "sale" | "refund" | "fee" | "cost"; // positive amounts; the kind gives the sign
  usd: number;
  ref: string; // the Stripe or provider id, so a retry counts once
  provider?: string;
  order_id?: string;
  props?: Record<string, unknown>;
}

type Report = { path: string; body: Record<string, unknown> };

export interface Payment {
  session_id: string;
  order_id: string;
  product: string;
  usd: number;
  status: "open" | "paid" | "refunded";
  email: string | null;
  livemode: boolean;
}

export interface CheckoutOptions {
  order_id: string;
  product: string;
  email?: string;
  success_url: string;
  cancel_url?: string;
  notify_url?: string;
  ui?: "elements";
}

export interface Paid {
  type: "order.paid";
  app: string;
  order_id: string;
  session_id: string;
  email: string | null;
  usd: number;
  livemode: boolean;
}

export function platform(app: string, dataDir: string) {
  const base = (process.env.ODAPT_URL ?? "https://api.odapt.ai").replace(/\/$/, "");
  const key = process.env.ODAPT_APP_KEY ?? "";
  const outbox = `${dataDir}/odapt-outbox.jsonl`;
  let flushing = false;

  async function send(r: Report): Promise<boolean> {
    try {
      const res = await fetch(base + r.path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(r.body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      // A 4xx won't get better by retrying (bad key, bad entry): log it loudly and drop it.
      if (res.status < 500) {
        console.error(`[odapt] ${r.path} refused ${res.status}: ${await res.text()}`, r.body);
        return true;
      }
    } catch {}
    return false;
  }

  // Resend what's waiting, oldest first. Whatever still fails goes back in the outbox.
  async function flush() {
    if (flushing || !key || !existsSync(outbox)) return;
    flushing = true;
    const sending = `${outbox}.sending`;
    try {
      renameSync(outbox, sending);
      const left: Report[] = [];
      for (const line of readFileSync(sending, "utf8").split("\n").filter(Boolean)) {
        const r = JSON.parse(line) as Report;
        if (left.length || !(await send(r))) left.push(r);
      }
      rmSync(sending);
      for (const r of left) appendFileSync(outbox, JSON.stringify(r) + "\n");
    } finally {
      flushing = false;
    }
  }

  function report(r: Report) {
    if (!key) {
      console.log(`[odapt] (no ODAPT_APP_KEY, not sent) ${r.path} ${JSON.stringify(r.body)}`);
      return;
    }
    void send(r).then((ok) => {
      if (!ok) appendFileSync(outbox, JSON.stringify(r) + "\n");
      else void flush();
    });
  }

  void flush();

  // Calls an order can't go on without: they throw.
  async function call(method: "GET" | "POST", path: string, body?: unknown) {
    if (!key) throw new Error("ODAPT_APP_KEY is not set");
    const r = await fetch(`${base}/apps/${app}/${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(j.error ?? `odapt ${path}: ${r.status}`);
    return j;
  }

  return {
    checkout: ((o: CheckoutOptions) => call("POST", "checkout", o)) as {
      (o: CheckoutOptions & { cancel_url: string; ui?: undefined }): Promise<{ id: string; url: string }>;
      (o: CheckoutOptions & { ui: "elements" }): Promise<{ id: string; url: null; client_secret: string; publishable_key: string }>;
    },
    payment: (sessionId: string) => call("GET", `payments/${encodeURIComponent(sessionId)}`) as Promise<Payment>,
    refund: (sessionId: string) => call("POST", "refund", { session_id: sessionId }) as Promise<Payment>,
    // To whoever paid for the order (the control plane has their address). "no-email": Stripe has none.
    email: (o: { order_id: string; subject: string; text: string; key?: string }) =>
      call("POST", "email", o) as Promise<{ status: "sent" | "no-email" }>,

    // The control plane's "order.paid" callback, if its signature is good (HMAC-SHA256 with the app key).
    async verifyNotify(req: Request): Promise<Paid | null> {
      const raw = await req.text();
      const h = Object.fromEntries((req.headers.get("odapt-signature") ?? "").split(",").map((kv) => kv.split("=", 2)));
      if (!key || !h.t || !h.v1 || Math.abs(Date.now() / 1000 - Number(h.t)) > 300) return null;
      const want = new Bun.CryptoHasher("sha256", key).update(`${h.t}.${raw}`).digest("hex");
      if (h.v1.length !== want.length || !crypto.timingSafeEqual(Buffer.from(h.v1), Buffer.from(want))) return null;
      return JSON.parse(raw) as Paid;
    },

    // A provider through the control plane's proxy (its key and cost tracking stay there).
    provider: (name: string) => ({
      url: (path: string) => `${base}/apps/${app}/proxy/${name}${path.startsWith("/") ? "" : "/"}${path}`,
      headers: { authorization: `Bearer ${key}` } as Record<string, string>,
    }),
    hasKey: !!key,

    money: (m: Money) => report({ path: `/apps/${app}/money`, body: { ...m } }),
    event: (type: string, props: Record<string, unknown> = {}, o: { variant?: string; session_id?: string } = {}) =>
      report({ path: "/events", body: { app, type, props, ...o } }),
    flush,
  };
}
