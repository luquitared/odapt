#!/usr/bin/env bun
// Money and funnel for every app, from the control plane's Postgres (the app_daily view and events).
//
//   bun run report                   last 7 days, every app
//   bun run report --days 30 --app duo-swap
//   bun run report --json            the same numbers as JSON, plus per-day rows (for agents)
//
// env: CONTROL_DATABASE_URL (in .env)

import { apps } from "../control/apps";
import { connect } from "../control/db";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const days = Number(arg("days") ?? 7);
const only = arg("app") ?? null;
const asJson = process.argv.includes("--json");

const sql = connect();
const since = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);

const daily = await sql`
  SELECT app_id, day::text, orders::int, sales_usd::float8 AS sales, refunds_usd::float8 AS refunds,
         fees_usd::float8 AS fees, provider_usd::float8 AS provider, net_usd::float8 AS net
  FROM app_daily WHERE day >= ${since}::date AND (${only}::text IS NULL OR app_id = ${only})
  ORDER BY app_id, day`;

const funnel = await sql`
  SELECT app_id, coalesce(variant, '') AS variant, type, count(*)::int AS n, min(at) AS first
  FROM events WHERE at >= ${since}::date AND (${only}::text IS NULL OR app_id = ${only})
  GROUP BY 1, 2, 3 ORDER BY 1, 2, first`;

await sql.close();

const kinds = new Map(apps().map((a) => [a.id, a.kind]));
const ids = [...new Set([...daily.map((r: any) => r.app_id), ...funnel.map((r: any) => r.app_id)])].sort();
const totals = ids.map((id) => {
  const rows = daily.filter((r: any) => r.app_id === id);
  const sum = (k: string) => rows.reduce((s: number, r: any) => s + r[k], 0);
  return { app: id, kind: kinds.get(id) ?? "unknown", orders: sum("orders"), sales: sum("sales"), refunds: sum("refunds"), fees: sum("fees"), provider: sum("provider"), net: sum("net") };
});

if (asJson) {
  console.log(JSON.stringify({ since, days, totals, daily, funnel: funnel.map(({ first, ...r }: any) => r) }, null, 2));
  process.exit(0);
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
console.log(`Since ${since} (${days} days, UTC)\n`);
const head = ["app", "kind", "orders", "sales", "refunds", "fees", "provider", "net", "margin"];
const body = totals.map((t) => [t.app, t.kind, String(t.orders), usd(t.sales), usd(t.refunds), usd(t.fees), usd(t.provider), usd(t.net),
  t.sales ? `${Math.round((t.net / t.sales) * 100)}%` : "—"]);
const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
for (const r of [head, ...body]) console.log(r.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  "));
if (!body.length) console.log("(no money recorded)");

console.log("\nFunnel (events, in the order each type first appeared)");
for (const id of ids) {
  const rows = funnel.filter((r: any) => r.app_id === id);
  for (const v of [...new Set(rows.map((r: any) => r.variant))]) {
    const steps = rows.filter((r: any) => r.variant === v).map((r: any) => `${r.type} ${r.n}`);
    console.log(`  ${id}${v ? ` [${v}]` : ""}: ${steps.join(" → ")}`);
  }
}
if (!funnel.length) console.log("  (no events)");
