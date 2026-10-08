// Providers for standalone apps, as configuration (providers.json): the key lives here and nowhere
// else, and every response that says what it cost is written to app_money.
//
//   /apps/<id>/proxy/<provider>/<path>   Authorization: Bearer <app key>; anything else is passed through
//
// An app may only call the providers its app.json lists, and only while its provider spend today is
// under its `daily_provider_usd` (default 20).
//
// providers.json entry: base URL, the env var holding the key, the header it goes in (and a prefix
// such as "Bearer "), and where a JSON response says its cost and the id it's recorded under.

import type { App } from "./apps";
import type { Db } from "./db";
import { appSpentToday, recordMoney } from "./ledger";
import PROVIDERS from "./providers.json";

interface Provider { base: string; key_env: string; auth_header: string; auth_prefix: string; cost_usd?: string; cost_id?: string }

const json = (b: unknown, status: number) => Response.json(b, { status });
const at = (o: any, path: string) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

export async function appProxy(sql: Db, req: Request, a: App, name: string, rest: string, dailyCapUsd: number): Promise<Response> {
  const p = (PROVIDERS as Record<string, Provider>)[name];
  if (!p) return json({ error: `unknown provider "${name}"` }, 404);
  if (!a.providers.includes(name)) return json({ error: `${a.id} doesn't list "${name}" in app.json providers` }, 403);
  const key = process.env[p.key_env];
  if (!key) return json({ error: `${name} isn't configured on the control plane (${p.key_env})` }, 503);
  if ((await appSpentToday(sql, a.id)) >= dailyCapUsd) return json({ error: `${a.id} reached today's provider spend cap ($${dailyCapUsd})` }, 503);

  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set(p.auth_header, `${p.auth_prefix}${key}`);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  // ODAPT_PROVIDER_<NAME>_BASE points a provider elsewhere (a local fake, for testing).
  const base = process.env[`ODAPT_PROVIDER_${name.toUpperCase()}_BASE`] ?? p.base;
  const up = await fetch(`${base}/${rest}`, { method: req.method, headers, body });

  const type = up.headers.get("content-type") ?? "";
  if (!type.includes("json") || !p.cost_usd) return new Response(up.body, { status: up.status, headers: { "content-type": type } });
  const text = await up.text();
  try {
    const j = JSON.parse(text);
    const usd = at(j, p.cost_usd), id = at(j, p.cost_id ?? "id");
    if (up.ok && typeof usd === "number" && id != null) {
      await recordMoney(sql, a.id, { kind: "cost", usd, ref: `${name}:${id}`, provider: name, props: { path: rest.split("?")[0] } });
    }
  } catch {}
  return new Response(text, { status: up.status, headers: { "content-type": type } });
}
