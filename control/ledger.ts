import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";
import type { Db } from "./db";

// templates/<app>/pricing.json. An app without one can't be billed through the proxy.
export interface Pricing {
  markup: number; // retail = provider cost × markup
  grant_usd: number; // free credit on a user's first sign-in to this app
  packs: { id: string; label: string; usd: number }[];
}

export function pricing(app: string): Pricing | null {
  if (!/^[a-z0-9-]+$/.test(app)) return null;
  const f = join(ROOT, "templates", app, "pricing.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export interface Entry {
  userId: string;
  app: string;
  deltaUsd: number;
  costUsd?: number;
  reason: string;
  ref?: string;
}

// false when `ref` was already recorded — a replayed webhook or a second grant.
export async function record(sql: Db, e: Entry): Promise<boolean> {
  const rows = await sql`
    INSERT INTO credit_ledger (user_id, app_id, delta_usd, cost_usd, reason, ref)
    VALUES (${e.userId}, ${e.app}, ${e.deltaUsd}, ${e.costUsd ?? null}, ${e.reason}, ${e.ref ?? null})
    ON CONFLICT (ref) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

// One wallet per user, spendable in every app.
export async function balance(sql: Db, userId: string): Promise<number> {
  const [r] = await sql`SELECT coalesce(sum(delta_usd), 0)::float8 AS b FROM credit_ledger WHERE user_id = ${userId}`;
  return r.b;
}

export async function spentToday(sql: Db): Promise<number> {
  const [r] = await sql`
    SELECT coalesce(sum(cost_usd), 0)::float8 AS c FROM credit_ledger
    WHERE cost_usd IS NOT NULL AND at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
  return r.c;
}

export async function grantOnce(sql: Db, userId: string, app: string) {
  const p = pricing(app);
  if (p?.grant_usd) await record(sql, { userId, app, deltaUsd: p.grant_usd, reason: "grant", ref: `grant:${app}:${userId}` });
}

// A standalone app's money (app_money). Amounts arrive positive; the kind gives the sign.
export interface Money {
  kind: "sale" | "refund" | "fee" | "cost";
  usd: number;
  ref: string;
  provider?: string;
  order_id?: string;
  props?: Record<string, unknown>;
}

export function moneyError(e: any): string | null {
  if (!e || typeof e !== "object") return "each entry must be an object";
  if (!["sale", "refund", "fee", "cost"].includes(e.kind)) return "kind must be sale, refund, fee or cost";
  if (typeof e.usd !== "number" || !Number.isFinite(e.usd) || e.usd < 0) return "usd must be a positive number";
  if (typeof e.ref !== "string" || !e.ref || e.ref.length > 200) return "ref is required (the Stripe or provider id)";
  return null;
}

// false when `ref` was already recorded.
export async function recordMoney(sql: Db, app: string, e: Money): Promise<boolean> {
  const usd = e.kind === "sale" ? e.usd : -e.usd;
  const rows = await sql`
    INSERT INTO app_money (app_id, kind, usd, provider, order_id, ref, props)
    VALUES (${app}, ${e.kind}, ${usd}, ${e.provider ?? null}, ${e.order_id ?? null}, ${e.ref}, ${e.props ?? {}})
    ON CONFLICT (ref) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

// A standalone app's provider spend since the start of the UTC day (its proxy cap).
export async function appSpentToday(sql: Db, app: string): Promise<number> {
  const [r] = await sql`
    SELECT coalesce(-sum(usd), 0)::float8 AS c FROM app_money
    WHERE app_id = ${app} AND kind = 'cost' AND at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
  return r.c;
}
