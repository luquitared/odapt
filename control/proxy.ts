// The metered proxy. Apps call  /proxy/<app>/openrouter/v1/…,  /proxy/<app>/replicate/v1/…  and
// /proxy/<app>/openai/v1/live/… (voice calls, control/live.ts)
// with a user token where the provider key would go; this adds the real key, checks the wallet and
// the daily cap, and writes what the call cost to the ledger.
//
// OpenRouter is charged after the fact from the usage it reports. Replicate reports no cost, so a
// prediction is charged up front from prices.json and refunded if it fails.

import { DAILY_CAP_USD, OPENROUTER_API_KEY, PUBLIC_URL, REPLICATE_API_TOKEN } from "./config";
import type { Db } from "./db";
import { balance, pricing, record, spentToday } from "./ledger";
import { createLive } from "./live";
import PRICES from "./prices.json";

const OPENROUTER = "https://openrouter.ai/api/v1";
const REPLICATE = "https://api.replicate.com/v1";
const MIN_BALANCE_USD = 0.01;

const json = (b: unknown, status = 200) => Response.json(b, { status });

export async function proxy(sql: Db, req: Request, user: { id: string }, app: string, upstream: string, rest: string): Promise<Response> {
  const p = pricing(app);
  if (!p) return json({ error: `app "${app}" has no pricing.json` }, 404);
  if ((await spentToday(sql)) >= DAILY_CAP_USD) return json({ error: "Odapt is at today's capacity. Try again tomorrow." }, 503);
  const bal = await balance(sql, user.id);
  if (bal < MIN_BALANCE_USD) return json({ error: "out of credits", balance: bal }, 402);
  const ctx = { sql, user, app, markup: p.markup, balance: bal, route: p.openrouter_provider };
  if (upstream === "openrouter") return openrouter(ctx, req, rest);
  if (upstream === "replicate") return replicate(ctx, req, rest);
  if (upstream === "openai") return createLive(sql, req, ctx, rest);
  return json({ error: `unknown upstream "${upstream}"` }, 404);
}

interface Ctx { sql: Db; user: { id: string }; app: string; markup: number; balance: number; route?: Record<string, unknown> }

function forwardHeaders(req: Request, key: string) {
  const h = new Headers();
  for (const k of ["content-type", "accept", "prefer"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("authorization", `Bearer ${key}`);
  return h;
}

// ---------------------------------------------------------------- OpenRouter

interface Price { in: number; cached: number; out: number }
let priceList: { at: number; byId: Map<string, Price> } | null = null;

async function modelPrice(model: string): Promise<Price | null> {
  if (!priceList || Date.now() - priceList.at > 3600_000) {
    const list = (await (await fetch(`${OPENROUTER}/models`)).json()) as { data: { id: string; pricing: Record<string, string> }[] };
    priceList = {
      at: Date.now(),
      byId: new Map(list.data.map((m) => [m.id, { in: Number(m.pricing.prompt), cached: Number(m.pricing.input_cache_read ?? m.pricing.prompt), out: Number(m.pricing.completion) }])),
    };
  }
  return priceList.byId.get(model) ?? null;
}

// Works for both the Responses API (what Codex speaks) and chat completions.
export async function usageCost(obj: any, fallbackModel: string | null): Promise<{ id: string | null; usd: number } | null> {
  const r = obj?.response ?? obj;
  const u = r?.usage;
  if (!u) return null;
  const id = r.id ?? null;
  if (typeof u.cost === "number") return { id, usd: u.cost };
  const price = await modelPrice(r.model ?? fallbackModel ?? "");
  if (!price) return null;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const cached = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  return { id, usd: (input - cached) * price.in + cached * price.cached + output * price.out };
}

// The app's routing (pricing.json `openrouter_provider`) wins over what the client asked for.
export function routed(body: string, route?: Record<string, unknown>): string {
  if (!route) return body;
  const b = JSON.parse(body);
  return JSON.stringify({ ...b, provider: { ...b.provider, ...route } });
}

async function openrouter(c: Ctx, req: Request, rest: string): Promise<Response> {
  let body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  let model: string | null = null;
  try { model = body ? JSON.parse(body).model ?? null : null; } catch {}
  if (body && c.route) {
    try { body = routed(body, c.route); } catch { return json({ error: "body must be JSON" }, 400); }
  }
  const up = await fetch(`${OPENROUTER}/${rest}`, { method: req.method, headers: forwardHeaders(req, OPENROUTER_API_KEY), body });
  const charge = async (obj: any) => {
    const u = await usageCost(obj, model).catch(() => null);
    if (!u || !u.usd) return;
    await record(c.sql, {
      userId: c.user.id, app: c.app, deltaUsd: -u.usd * c.markup, costUsd: u.usd, reason: "openrouter",
      ref: u.id ? `openrouter:${u.id}` : undefined,
    });
  };
  const type = up.headers.get("content-type") ?? "";
  const headers = { "content-type": type || "application/json" };
  if (!up.ok || !up.body) return new Response(up.body, { status: up.status, headers });

  if (!type.includes("text/event-stream")) {
    const text = await up.text();
    try { await charge(JSON.parse(text)); } catch {}
    return new Response(text, { status: up.status, headers });
  }

  // Stream through untouched; watch for the event that carries usage and charge when it passes.
  const [toClient, toMeter] = up.body.tee();
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of toMeter as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
        try { await charge(JSON.parse(line.slice(5))); } catch {}
      }
    }
  })().catch((e) => console.error("[proxy] metering failed", e));
  return new Response(toClient, { status: up.status, headers });
}

// ---------------------------------------------------------------- Replicate

type ModelPrice = { per: string; usd: number; usd_2k?: number; count_input?: string; seconds_input?: string; default_seconds?: number; text_input?: string; min_usd?: number };

export function estimate(model: string, input: Record<string, any>): number | null {
  const m = (PRICES as Record<string, ModelPrice | string>)[model];
  if (!m || typeof m === "string") return null;
  if (m.per === "image") return m.usd * Number(input[m.count_input!] ?? 1);
  if (m.per === "second") {
    const s = Number(input[m.seconds_input!] ?? m.default_seconds);
    return (String(input.resolution ?? "").toUpperCase() === "2K" ? m.usd_2k ?? m.usd : m.usd) * s;
  }
  if (m.per === "1k_chars") return Math.max(m.min_usd ?? 0, (String(input[m.text_input!] ?? "").length / 1000) * m.usd);
  return null;
}

// Which model a create call runs, or null when this isn't a create call.
export function createTarget(method: string, rest: string, body: any): { model: string | null } | null {
  if (method !== "POST") return null;
  const m = rest.match(/^models\/([^/]+)\/([^/]+)\/predictions$/);
  if (m) return { model: `${m[1]}/${m[2]}` };
  if (rest === "predictions") {
    const v = String(body?.version ?? "");
    return { model: v.includes("/") ? v.split(":")[0] : null };
  }
  if (/^deployments\/.+\/predictions$/.test(rest)) return { model: null };
  return null;
}

async function replicate(c: Ctx, req: Request, rest: string): Promise<Response> {
  const base = `${PUBLIC_URL}/proxy/${c.app}/replicate/v1`;
  const send = async (method: string, body?: BodyInit, contentType?: string) => {
    const h = forwardHeaders(req, REPLICATE_API_TOKEN);
    if (contentType) h.set("content-type", contentType);
    return fetch(`${REPLICATE}/${rest}`, { method, headers: h, body });
  };
  // Poll URLs in responses point back here, so clients never need the real key.
  const relay = async (up: Response) =>
    new Response((await up.text()).replaceAll(REPLICATE, base), { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json" } });

  // Uploads cost nothing; let them through as-is.
  if (req.method === "POST" && rest === "files") return relay(await send("POST", await req.arrayBuffer(), req.headers.get("content-type") ?? undefined));
  // Public model metadata (rep reads schemas).
  if (req.method === "GET" && rest.startsWith("models/")) return relay(await send("GET"));

  const pred = rest.match(/^predictions\/([a-z0-9]+)(\/cancel)?$/);
  if (pred) {
    // Only the user who paid for a prediction can see or cancel it.
    const [own] = await c.sql`SELECT user_id, app_id, delta_usd::float8 AS delta, cost_usd::float8 AS cost FROM credit_ledger WHERE ref = ${`replicate:${pred[1]}`}`;
    if (!own || own.user_id !== c.user.id) return json({ error: "not found" }, 404);
    const up = await send(req.method);
    const r = await relay(up);
    const status = up.ok ? ((await r.clone().json()) as any).status : null;
    if (status === "failed" || status === "canceled") {
      await record(c.sql, { userId: c.user.id, app: own.app_id, deltaUsd: -own.delta, costUsd: -own.cost, reason: "refund", ref: `replicate-refund:${pred[1]}` });
    }
    return r;
  }

  if (req.method !== "POST") return json({ error: `not available through the proxy: ${req.method} /${rest}` }, 403);
  const raw = await req.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch { return json({ error: "body must be JSON" }, 400); }
  const target = createTarget(req.method, rest, body);
  if (!target) return json({ error: `not available through the proxy: ${req.method} /${rest}` }, 403);
  const cost = target.model ? estimate(target.model, body.input ?? {}) : null;
  if (cost === null) return json({ error: `no price for ${target.model ?? "this model"}; add it to control/prices.json` }, 403);
  const retail = cost * c.markup;
  if (retail > c.balance) return json({ error: "out of credits", balance: c.balance, needs: retail }, 402);

  // An uploaded file's URL came back pointing here (relay rewrites it); Replicate fetches inputs
  // itself and can't reach the proxy, so hand it its own URL.
  const up = await send("POST", raw.replaceAll(base, REPLICATE), "application/json");
  const r = await relay(up);
  if (up.ok) {
    const { id, status } = (await r.clone().json()) as any;
    await record(c.sql, { userId: c.user.id, app: c.app, deltaUsd: -retail, costUsd: cost, reason: "replicate", ref: `replicate:${id}` });
    // `Prefer: wait` can return a prediction that has already failed.
    if (status === "failed" || status === "canceled") {
      await record(c.sql, { userId: c.user.id, app: c.app, deltaUsd: retail, costUsd: -cost, reason: "refund", ref: `replicate-refund:${id}` });
    }
  }
  return r;
}
