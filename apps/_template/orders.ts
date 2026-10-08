// Orders: unpaid ─pay─▶ paid ─▶ working ─▶ done, or failed (refunded). Payment, the sale, Stripe's fee
// and refunds go through the platform (apps/lib/odapt.ts); this file only keeps the app's own state.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { platform } from "../lib/odapt";
import { DATA } from "./config";
import { work } from "./work";

export interface Order {
  id: string;
  status: "unpaid" | "paid" | "working" | "done" | "failed";
  input: Record<string, string>;
  checkout_id: string | null;
  result: { text?: string; file?: string } | null;
  error: string | null;
}

export const odapt = platform("{{ID}}", DATA);
mkdirSync(`${DATA}/orders`, { recursive: true });
const db = new Database(`${DATA}/orders.db`, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, input TEXT NOT NULL, checkout_id TEXT, result TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

const row = (r: any): Order | null => r && { ...r, input: JSON.parse(r.input), result: r.result && JSON.parse(r.result) };
export const dir = (id: string) => `${DATA}/orders/${id}`;
export const get = (id: string) => row(db.query("SELECT * FROM orders WHERE id = ?").get(id));

export function create(input: Record<string, string>): Order {
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
  mkdirSync(dir(id), { recursive: true });
  db.query("INSERT INTO orders (id, status, input) VALUES (?, 'unpaid', ?)").run(id, JSON.stringify(input));
  return get(id)!;
}

export const setCheckout = (id: string, cs: string) => db.query("UPDATE orders SET checkout_id = ? WHERE id = ?").run(cs, id);

// From the success redirect or the platform's callback, any number of times.
export function markPaid(id: string) {
  if (!db.query("UPDATE orders SET status = 'paid' WHERE id = ? AND status = 'unpaid'").run(id).changes) return;
  odapt.event("paid", { order_id: id });
  void run(id);
}

async function run(id: string) {
  db.query("UPDATE orders SET status = 'working' WHERE id = ?").run(id);
  try {
    const result = await work(get(id)!, dir(id));
    db.query("UPDATE orders SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result), id);
    odapt.event("done", { order_id: id });
  } catch (e) {
    const o = get(id)!;
    let refunded = false;
    if (o.checkout_id && !o.checkout_id.startsWith("fake_")) refunded = !!(await odapt.refund(o.checkout_id).catch(() => null));
    db.query("UPDATE orders SET status = 'failed', error = ? WHERE id = ?").run((e as Error).message, id);
    odapt.event("failed", { order_id: id, refunded });
  }
}

// Paid orders a restart interrupted.
export function resume() {
  for (const r of db.query("SELECT id FROM orders WHERE status IN ('paid', 'working')").all() as { id: string }[]) void run(r.id);
}
