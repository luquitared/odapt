// {{NAME}}: a form, a payment through the platform, then work.ts does the job.
//
//   APP_FAKE_PAY=1 bun apps/{{ID}}/server.ts     http://127.0.0.1:{{PORT}}, no Stripe
//   bun apps/{{ID}}/server.ts                     needs ODAPT_APP_KEY (bun control/apps.ts key {{ID}})
//
// Deployed by scripts/deploy-app.sh at https://api.odapt.ai{{PATH}} (app.json "deploy").

import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { BASE_PATH, BEHIND_PROXY, FAKE_PAY, PORT, PRICE_USD, PUBLIC_DIR, PUBLIC_URL } from "./config";
import * as orders from "./orders";

const CORS = { "access-control-allow-origin": "*" };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: CORS });
const html = async (name: string) =>
  new Response((await Bun.file(join(PUBLIC_DIR, name)).text()).replaceAll("{{BASE}}", BASE_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });

// A few orders per address per hour; the platform caps provider spend per day (app.json).
const recent = new Map<string, number[]>();
function tooMany(ip: string | null, perHour = 10) {
  if (!ip) return false;
  const now = Date.now(), list = (recent.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.set(ip, [...list, now]);
  return list.length >= perHour;
}

const view = (o: orders.Order) => ({
  id: o.id, status: o.status, error: o.error, price_usd: PRICE_USD,
  text: o.result?.text ?? null, file: o.status === "done" && o.result?.file ? `${BASE_PATH}/files/${o.id}/${o.result.file}` : null,
});

// Stripe's own checkout page for an order: the page redirects to checkout_url.
async function hosted(o: orders.Order) {
  const s = await orders.odapt.checkout({
    order_id: o.id, product: "main",
    success_url: `${PUBLIC_URL}/j/${o.id}?cs={CHECKOUT_SESSION_ID}`, cancel_url: `${PUBLIC_URL}/`,
    notify_url: `${PUBLIC_URL}/odapt/notify`,
  });
  orders.setCheckout(o.id, s.id);
  orders.odapt.event("checkout_started", { order_id: o.id, ui: "hosted" });
  return json({ id: o.id, checkout_url: s.url });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (path === "/" || path === "/index.html") return html("index.html");
    if (path === "/health") return json({ ok: true });
    if (path === "/api/config") return json({ price_usd: PRICE_USD });

    if (path === "/api/orders" && req.method === "POST") {
      const ip = BEHIND_PROXY ? req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() ?? null : server.requestIP(req)?.address ?? null;
      if (tooMany(ip)) return json({ error: "Too many orders from here. Try again in an hour." }, 429);
      const form = await req.formData().catch(() => null);
      const input = Object.fromEntries([...(form?.entries() ?? [])].filter(([, v]) => typeof v === "string")) as Record<string, string>;
      if (!input.prompt?.trim()) return json({ error: "tell us what you want" }, 400);
      const o = orders.create(input);
      // In-page first (Apple Pay, Google Pay, Link on this page); the page falls back to Stripe's own
      // checkout page (/api/orders/<id>/card) when the browser has none of those or the buyer asks.
      try {
        if (FAKE_PAY) {
          orders.setCheckout(o.id, `fake_${o.id}`);
          return json({ id: o.id, checkout_url: `${PUBLIC_URL}/dev/pay/${o.id}` });
        }
        const s = await orders.odapt
          .checkout({
            order_id: o.id, product: "main", ui: "elements",
            success_url: `${PUBLIC_URL}/j/${o.id}?cs={CHECKOUT_SESSION_ID}`, notify_url: `${PUBLIC_URL}/odapt/notify`,
          })
          .catch(() => null); // the control plane has no publishable key: Stripe's page only
        if (!s) return hosted(o);
        orders.setCheckout(o.id, s.id);
        orders.odapt.event("checkout_started", { order_id: o.id, ui: "elements" });
        return json({ id: o.id, client_secret: s.client_secret, publishable_key: s.publishable_key });
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }

    if ((m = path.match(/^\/api\/orders\/([A-Za-z0-9_-]+)\/card$/)) && req.method === "POST") {
      const o = orders.get(m[1]);
      if (!o || o.status !== "unpaid" || FAKE_PAY) return json({ error: "no unpaid order" }, 404);
      try {
        return await hosted(o);
      } catch (e) {
        return json({ error: (e as Error).message }, 502);
      }
    }

    if ((m = path.match(/^\/api\/orders\/([A-Za-z0-9_-]+)$/))) {
      const o = orders.get(m[1]);
      return o ? json(view(o)) : json({ error: "no such order" }, 404);
    }

    // Back from Checkout: ask the platform whether it's paid (its callback may still be on the way).
    if ((m = path.match(/^\/j\/([A-Za-z0-9_-]+)$/))) {
      const o = orders.get(m[1]);
      if (!o) return new Response("No such order", { status: 404 });
      const cs = url.searchParams.get("cs");
      if (cs && cs === o.checkout_id && o.status === "unpaid" && !FAKE_PAY) {
        const p = await orders.odapt.payment(cs).catch(() => null);
        if (p?.status === "paid" && p.order_id === o.id) orders.markPaid(o.id);
      }
      return html("order.html");
    }

    if (path === "/odapt/notify" && req.method === "POST") {
      const paid = await orders.odapt.verifyNotify(req);
      if (!paid) return json({ error: "bad signature" }, 400);
      if (paid.type === "order.paid") orders.markPaid(paid.order_id);
      return json({ ok: true });
    }

    if (FAKE_PAY && (m = path.match(/^\/dev\/pay\/([A-Za-z0-9_-]+)$/))) {
      orders.markPaid(m[1]);
      return Response.redirect(`${PUBLIC_URL}/j/${m[1]}`, 303);
    }

    if ((m = path.match(/^\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)$/))) {
      const o = orders.get(m[1]);
      const f = Bun.file(`${orders.dir(m[1])}/${m[2]}`);
      return o?.status === "done" && o.result?.file === m[2] && (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    }

    const p = normalize(join(PUBLIC_DIR, path));
    return p.startsWith(PUBLIC_DIR) && existsSync(p) && Bun.file(p).size ? new Response(Bun.file(p)) : new Response("not found", { status: 404 });
  },
});

orders.resume();
console.log(`{{ID}} on ${PUBLIC_URL} (port ${server.port})${FAKE_PAY ? " · fake payments" : orders.odapt.hasKey ? "" : " · NO ODAPT_APP_KEY: checkout will fail"}`);
