import { readdirSync } from "node:fs";
import { join } from "node:path";
import { app, hasAppKey } from "./apps";
import { auth, authenticate, googleEnabled, normalizeEmail } from "./auth";
import { PORT, PUBLIC_URL, ROOT } from "./config";
import { connect, migrate } from "./db";
import { balance, grantOnce, moneyError, pricing, recordMoney, type Money } from "./ledger";
import { checkoutError, createCheckout, emailBuyer, orderEmailError, paymentStatus, publicPayment, refund, sweep } from "./orders";
import { appProxy } from "./providers";
import { liveSocket, ownsCall } from "./live";
import { proxy } from "./proxy";
import { checkout, handleWebhook } from "./stripe";

const sql = connect();
await migrate(sql);

const json = (b: unknown, status = 200) => Response.json(b, { status });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Apps that sell wallet credit (agent apps with a pricing.json): sign-in grants and credit packs.
const isApp = (a: unknown): a is string => typeof a === "string" && !!pricing(a);
const billedApps = () => readdirSync(join(ROOT, "templates")).filter((a) => pricing(a));
const appName = (id: string) => app(id)?.name ?? id;
// Where to land after signing in: a path on this site, never another origin.
const safeNext = (n: unknown, fallback: string) => {
  const s = String(n ?? "");
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
};
// A redirect that keeps the cookies Better Auth set on its response (session, OAuth state).
function redirect(to: string, from?: Response) {
  const h = new Headers({ location: to });
  for (const c of from?.headers.getSetCookie() ?? []) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
}

function page(title: string, body: string) {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
input,button,.btn{font:inherit;padding:.5rem .75rem;border:1px solid #ccc;border-radius:6px}button,.btn{background:#1a1a1a;color:#fff;border:0;cursor:pointer;text-decoration:none;display:inline-block}
button.quiet{background:none;color:inherit;border:1px solid #ccc}form.inline{display:inline}
code{font-size:1.4rem;letter-spacing:.1em}.muted{color:#666}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>
<h1>${esc(title)}</h1>${body}`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const signInOptions = (next: string) => `${googleEnabled ? `<p><a class=btn href="/auth/google?next=${encodeURIComponent(next)}">Continue with Google</a></p><p class=muted>Or get a sign-in link by email:</p>` : ""}
<form method=post action=/auth/email><input type=hidden name=next value="${esc(next)}">
<p><input type=email name=email required placeholder="you@example.com"> <button>Email me a link</button></p></form>`;

async function body(req: Request): Promise<Record<string, any>> {
  const t = req.headers.get("content-type") ?? "";
  // text/plain too: a browser can send JSON that way cross-origin without a preflight.
  if (t.includes("application/json") || t.includes("text/plain")) return (await req.json()) as Record<string, any>;
  return Object.fromEntries(await req.formData());
}

const server = Bun.serve<{ id: string }>({
  port: PORT,
  idleTimeout: 0, // streamed model responses outlive the default
  websocket: liveSocket,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname;
    let m: RegExpMatchArray | null;

    if (path === "/health") return json({ ok: true });

    // ------------------------------------------------------------ sign-in
    if (path.startsWith("/api/auth/")) return auth.handler(req); // Better Auth: OAuth callbacks, magic links, device codes

    if (path === "/login") {
      const app = url.searchParams.get("app");
      const next = safeNext(url.searchParams.get("next"), isApp(app) ? `/welcome?app=${app}` : "/account");
      const err = url.searchParams.get("error") ? `<p>That sign-in didn't go through. Try again.</p>` : "";
      return page("Sign in to Odapt", err + signInOptions(next));
    }

    if (path === "/auth/google") {
      if (!googleEnabled) return new Response(null, { status: 303, headers: { location: "/login" } });
      const r = await auth.api.signInSocial({
        body: { provider: "google", callbackURL: safeNext(url.searchParams.get("next"), "/account"), errorCallbackURL: "/login?error=google" },
        headers: req.headers, asResponse: true,
      });
      return redirect(((await r.clone().json()) as { url: string }).url, r);
    }

    if (path === "/auth/email" && req.method === "POST") {
      const b = await body(req);
      const email = normalizeEmail(b.email);
      if (!email) return json({ error: "a valid email is required" }, 400);
      await auth.api.signInMagicLink({ body: { email, callbackURL: safeNext(b.next, "/account") }, headers: req.headers });
      if (req.headers.get("accept")?.includes("application/json")) return json({ ok: true });
      return page("Check your email", `<p>We sent a sign-in link to <b>${esc(email)}</b>. It works once, for 15 minutes.</p>`);
    }

    if (path === "/auth/sign-out" && req.method === "POST") {
      return redirect("/login", await auth.api.signOut({ headers: req.headers, asResponse: true }));
    }

    // First sign-in from an app's page: its free credit, once.
    if (path === "/welcome") {
      const user = await authenticate(req);
      if (!user) return redirect("/login");
      const app = url.searchParams.get("app");
      if (isApp(app)) await grantOnce(sql, user.id, app);
      return redirect("/account");
    }

    // Desktop sign-in. The app POSTs /api/auth/device/code {client_id: <app>}, shows the user code,
    // opens this page and polls /api/auth/device/token. Here the person signs in and approves.
    if (path === "/device") {
      const code = (url.searchParams.get("user_code") ?? "").trim();
      if (!code) return page("Sign in an app", `<form method=get action=/device><p>Enter the code the app shows:</p><p><input name=user_code required autofocus> <button>Continue</button></p></form>`);
      const user = await authenticate(req);
      if (!user) return page("Sign in to the app", `<p>Check that the app shows <code>${esc(code)}</code>, then sign in.</p>${signInOptions(`/device?user_code=${encodeURIComponent(code)}`)}`);
      // Claims the code for this person, so only they can approve it.
      const v = await auth.api.deviceVerify({ query: { user_code: code }, headers: req.headers }).catch(() => null);
      if (!v || v.status !== "pending" || !v.client_id) return page("That code has expired", `<p>Start the sign-in again from the app.</p>`);
      const hidden = `<input type=hidden name=user_code value="${esc(code)}">`;
      return page(`Sign in to ${appName(v.client_id)}`, `<p class=muted>Signed in as ${esc(user.email)}</p>
<p>Does the app show <code>${esc(code)}</code>?</p>
<p><form class=inline method=post action=/device/approve>${hidden}<button>Yes, sign it in</button></form>
<form class=inline method=post action=/device/deny>${hidden}<button class=quiet>No</button></form></p>`);
    }

    if ((path === "/device/approve" || path === "/device/deny") && req.method === "POST") {
      const user = await authenticate(req);
      if (!user) return redirect("/login");
      const code = String((await body(req)).user_code ?? "");
      if (path === "/device/deny") {
        await auth.api.deviceDeny({ body: { userCode: code }, headers: req.headers }).catch(() => null);
        return page("Sign-in cancelled", `<p>The app wasn't signed in. You can close this page.</p>`);
      }
      const v = await auth.api.deviceVerify({ query: { user_code: code }, headers: req.headers }).catch(() => null);
      const ok = v?.client_id && (await auth.api.deviceApprove({ body: { userCode: code }, headers: req.headers }).catch(() => null));
      if (!ok) return page("That code has expired", `<p>Start the sign-in again from the app.</p>`);
      if (isApp(v.client_id)) await grantOnce(sql, user.id, v.client_id);
      return page("You're signed in", `<p>Go back to ${esc(appName(v.client_id))} — it picks this up in a few seconds.</p>`);
    }

    // ------------------------------------------------------------ signed in
    // A voice call's sideband, relayed (control/live.ts).
    if ((m = path.match(/^\/proxy\/[a-z0-9-]+\/openai\/v1\/live\/sessions\/([A-Za-z0-9_-]+)\/attach$/))) {
      const user = await authenticate(req);
      if (!user) return json({ error: "sign in required" }, 401);
      if (!ownsCall(m[1], user.id)) return json({ error: "no such call" }, 404);
      return server.upgrade(req, { data: { id: m[1] } }) ? undefined : json({ error: "expected a WebSocket" }, 400);
    }
    if ((m = path.match(/^\/proxy\/([a-z0-9-]+)\/(openrouter|replicate|openai)\/v1\/(.+)$/))) {
      const user = await authenticate(req);
      if (!user) return json({ error: "sign in required" }, 401);
      return proxy(sql, req, user, m[1], m[2], m[3] + url.search);
    }

    if (path === "/stripe/webhook" && req.method === "POST") {
      const r = await handleWebhook(sql, await req.text(), req.headers.get("stripe-signature"));
      console.log(`[stripe] ${r.status} ${r.note}`);
      return json({ note: r.note }, r.status);
    }

    // ------------------------------------------------------------ standalone apps (app key)
    if ((m = path.match(/^\/apps\/([a-z0-9-]+)\/(.+)$/))) {
      const a = app(m[1]);
      if (a?.kind !== "standalone" || !hasAppKey(req, a.id)) return json({ error: "unknown app or wrong app key" }, 401);
      const rest = m[2];
      let p: RegExpMatchArray | null;

      if ((p = rest.match(/^proxy\/([a-z0-9-]+)\/(.+)$/))) return appProxy(sql, req, a, p[1], p[2] + url.search, a.dailyProviderUsd);

      if (rest === "checkout" && req.method === "POST") {
        const b = await body(req);
        const err = checkoutError(a, b);
        if (err) return json({ error: err }, 400);
        try {
          return json(await createCheckout(sql, a, b as any), 201);
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }

      if ((p = rest.match(/^payments\/([A-Za-z0-9_]+)$/)) && req.method === "GET") {
        const pay = await paymentStatus(sql, a, p[1]).catch((e) => (console.error(`[orders] status ${p![1]}: ${e.message}`), undefined));
        if (pay === undefined) return json({ error: "couldn't reach Stripe" }, 502);
        return pay ? json(publicPayment(pay)) : json({ error: "no such payment" }, 404);
      }

      if (rest === "refund" && req.method === "POST") {
        const b = await body(req);
        try {
          const pay = await refund(sql, a, String(b.session_id ?? ""));
          return pay ? json(publicPayment(pay)) : json({ error: "no such payment" }, 404);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
      }

      if (rest === "email" && req.method === "POST") {
        const b = await body(req);
        const err = orderEmailError(b);
        if (err) return json({ error: err }, 400);
        try {
          const r = await emailBuyer(sql, a, b as any);
          if (!r) return json({ error: "no paid order with that id" }, 404);
          return json({ status: r });
        } catch (e) {
          console.error(`[orders] email ${a.id}/${b.order_id}: ${(e as Error).message}`);
          return json({ error: "couldn't send the email" }, 502);
        }
      }

      if (rest !== "money" || req.method !== "POST") return json({ error: "not found" }, 404);
      // Money the platform doesn't see (a provider called directly): one entry, or {entries: [...]}.
      // Retries are safe (by `ref`).
      const b = await body(req);
      const entries: Money[] = Array.isArray(b.entries) ? b.entries : [b];
      for (const e of entries) {
        const err = moneyError(e);
        if (err) return json({ error: err }, 400);
      }
      let recorded = 0;
      for (const e of entries) if (await recordMoney(sql, a.id, e)) recorded++;
      return json({ recorded, duplicates: entries.length - recorded }, 201);
    }

    // Landing pages post here from other origins (Pages sites), so it answers CORS.
    if (path === "/events" && req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const user = await authenticate(req);

    if (path === "/me") {
      if (!user) return json({ error: "sign in required" }, 401);
      return json({ ...user, balance_usd: await balance(sql, user.id) });
    }

    if (path === "/billing/checkout" && req.method === "POST") {
      if (!user) return json({ error: "sign in required" }, 401);
      const b = await body(req);
      if (!isApp(b.app)) return json({ error: "unknown app" }, 400);
      try {
        // A desktop app asks for JSON and opens the URL in the browser; Stripe sends the person back
        // to /billing/done, which tells them to return to the app.
        const fromApp = req.headers.get("accept")?.includes("application/json");
        const s = await checkout(sql, user, b.app, String(b.pack ?? ""), fromApp ? `${PUBLIC_URL}/billing/done` : undefined);
        if (fromApp) return json(s);
        return new Response(null, { status: 303, headers: { location: s.url } });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }

    if (path === "/billing/done") {
      return url.searchParams.has("paid")
        ? page("Payment received", `<p>Your credit shows in the app within a few seconds. You can close this page.</p>`)
        : page("No payment made", `<p>Nothing was charged. You can close this page and go back to the app.</p>`);
    }

    if (path === "/events" && req.method === "POST") {
      const b = await body(req);
      if (!app(b.app) || typeof b.type !== "string") return Response.json({ error: "a known app and a type are required" }, { status: 400, headers: CORS });
      await sql`
        INSERT INTO events (user_id, app_id, variant, session_id, type, props)
        VALUES (${user?.id ?? null}, ${b.app}, ${b.variant ?? null}, ${b.session_id ?? null}, ${b.type}, ${b.props ?? {}})`;
      return Response.json({ ok: true }, { status: 201, headers: CORS });
    }

    if (path === "/account") {
      if (!user) return new Response(null, { status: 303, headers: { location: "/login" } });
      const bal = await balance(sql, user.id);
      const packs = billedApps().flatMap((app) => pricing(app)!.packs.map((p) =>
        `<form method=post action=/billing/checkout style="display:inline"><input type=hidden name=app value="${esc(app)}"><input type=hidden name=pack value="${esc(p.id)}"><button>${esc(app)}: ${esc(p.label)}</button></form> `));
      const paid = url.searchParams.has("paid") ? `<p>Thanks — your credit appears here once Stripe confirms the payment.</p>` : "";
      return page("Your account", `${paid}<p class=muted>${esc(user.email)} · <form class=inline method=post action=/auth/sign-out><button class=quiet>Sign out</button></form></p><p>Credit: <b>$${bal.toFixed(2)}</b></p><p>${packs.join("")}</p>`);
    }

    return json({ error: "not found" }, 404);
  },
});

// Callbacks and Stripe fees for standalone apps' orders that didn't go through the first time.
setInterval(() => void sweep(sql).catch((e) => console.error(`[orders] sweep: ${e.message}`)), 60_000);

console.log(`odapt control plane on ${PUBLIC_URL} (port ${server.port})`);
