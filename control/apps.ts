// Every app the platform knows. Three kinds, one ledger:
//   agent apps       templates/<id>/ with a pricing.json: wallet credit, the metered proxy
//   standalone apps  apps/<id>/app.json: their own server. With their app key they sell through the
//                    platform's Stripe (orders.ts), call providers through /apps/<id>/proxy
//                    (providers.ts), and report funnel events; the platform records the money
//   listed apps      apps/<id>/app.json with "kind": "listed": code and hosting live elsewhere (an
//                    open-source repo people run themselves). A landing page and funnel events only:
//                    no app key, no deploy
//
//   bun control/apps.ts                list them
//   bun control/apps.ts key <id>       a standalone app's ODAPT_APP_KEY (run where BETTER_AUTH_SECRET is prod's)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTH_SECRET, ROOT } from "./config";
import { pricing, type Pricing } from "./ledger";

export interface Product {
  name: string; // what the buyer sees in Checkout
  usd: number;
}

export interface App {
  id: string;
  name: string;
  kind: "agent" | "standalone" | "listed";
  pricing: Pricing | null; // agent apps only
  products: Record<string, Product>; // standalone apps: the only things they can charge for
  providers: string[]; // standalone apps: the providers they may call through the proxy
  dailyProviderUsd: number; // standalone apps: provider spend per UTC day before the proxy refuses
  repo: string | null; // listed apps: where the code is
}

const ID = /^[a-z0-9-]+$/;
const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);

export function app(id: unknown): App | null {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const standalone = readJson(join(ROOT, "apps", id, "app.json"));
  if (standalone?.kind === "listed") {
    return { id, name: standalone.name ?? id, kind: "listed", pricing: null, products: {}, providers: [], dailyProviderUsd: 0, repo: standalone.repo ?? null };
  }
  if (standalone) {
    return { id, name: standalone.name ?? id, kind: "standalone", pricing: null, products: standalone.products ?? {}, providers: standalone.providers ?? [], dailyProviderUsd: standalone.daily_provider_usd ?? 20, repo: null };
  }
  const p = pricing(id);
  if (!p) return null;
  return { id, name: readJson(join(ROOT, "templates", id, "template.json"))?.name ?? id, kind: "agent", pricing: p, products: {}, providers: [], dailyProviderUsd: 0, repo: null };
}

export function apps(): App[] {
  const ids = (dir: string) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : []);
  return [...new Set([...ids("apps"), ...ids("templates")])].sort().map(app).filter((a): a is App => !!a);
}

// Derived, not stored: the control plane can check a key without a table, and rotating
// BETTER_AUTH_SECRET rotates every app key with it.
export function appKey(id: string, secret = AUTH_SECRET): string {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return `odapt_app_${new Bun.CryptoHasher("sha256", secret).update(`app-key:${id}`).digest("base64url")}`;
}

export function hasAppKey(req: Request, id: string, secret = AUTH_SECRET): boolean {
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
  const want = appKey(id, secret);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

if (import.meta.main) {
  const [cmd, id] = process.argv.slice(2);
  if (cmd === "key") {
    const a = app(id);
    if (a?.kind !== "standalone") throw new Error(`"${id}" isn't a standalone app (apps/<id>/app.json)`);
    console.log(appKey(a.id));
  } else {
    for (const a of apps()) console.log(`${a.id.padEnd(20)} ${a.kind.padEnd(10)} ${a.name}`);
  }
}
