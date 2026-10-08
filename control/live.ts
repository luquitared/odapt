// Voice calls (GPT-Live) on a user's credit. The engine's voice mode (src/voice.ts) makes the same
// two calls it would make to OpenAI, here instead:
//
//   POST /proxy/<app>/openai/v1/live/sessions                 create a WebRTC session (browser's SDP in, answer out)
//   WS   /proxy/<app>/openai/v1/live/sessions/<id>/attach      the session's sideband, relayed
//
// Live is billed by the second, and the only place the seconds are reported is the session's own
// events, so this side attaches the sideband to OpenAI itself, as soon as the session exists, and
// keeps it until the session closes: a call is metered whether or not the engine ever connects or
// stays. The engine gets a relay of it, without the audio, and may only send the commands a voice
// bridge needs. Charged as it goes; a call that runs the wallet dry is ended.

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { OPENAI_API_KEY } from "./config";
import type { Db } from "./db";
import { balance, record } from "./ledger";

export const LIVE_MODEL = "gpt-live-1";
// https://developers.openai.com/api/docs/models/gpt-live-1. Creating a WebRTC session bills 15
// seconds up front, credited against the running time.
export const LIVE_USD_PER_MIN = 0.05;
export const LIVE_MIN_SECONDS = 15;
const CHARGE_EVERY_S = 30;
const MIN_BALANCE_USD = 0.01;
// What the engine may send on the sideband: context for the voice, and hanging up.
const RELAYED_COMMANDS = new Set(["session.instructions.append", "session.thinking.append", "session.commentary.append", "session.close"]);
// Reflected audio is most of the sideband's traffic and the engine has no use for it.
const DROPPED_EVENTS = new Set(["session.input_audio.append", "session.output_audio.delta"]);

const json = (b: unknown, status = 200) => Response.json(b, { status });
const base = () => (process.env.OPENAI_LIVE_BASE ?? "https://api.openai.com/v1").replace(/\/$/, "");

interface Call {
  id: string;
  userId: string;
  app: string;
  markup: number;
  seconds: number; // reported so far
  charged: number; // seconds already in the ledger
  upstream: WebSocket;
  client: ServerWebSocket<{ id: string }> | null;
  backlog: string[]; // events from before the engine attached
}
const calls = new Map<string, Call>();

/** The seconds to bill now, or 0: in chunks while the call runs, everything once it's over. */
export function dueSeconds(seconds: number, charged: number, final: boolean): number {
  const billable = Math.max(seconds, LIVE_MIN_SECONDS);
  const due = billable - charged;
  return due > 0 && (final || due >= CHARGE_EVERY_S) ? due : 0;
}

async function charge(sql: Db, c: Call, final: boolean) {
  const due = dueSeconds(c.seconds, c.charged, final);
  if (!due) return;
  const upTo = c.charged + due;
  const cost = (due / 60) * LIVE_USD_PER_MIN;
  c.charged = upTo;
  // The ref is the running total, so a repeated report can't charge twice.
  await record(sql, { userId: c.userId, app: c.app, deltaUsd: -cost * c.markup, costUsd: cost, reason: "openai-live", ref: `openai-live:${c.id}:${upTo.toFixed(1)}` });
  if (!final && (await balance(sql, c.userId)) < MIN_BALANCE_USD) {
    console.log(`[live] ${c.id}: out of credit, ending the call`);
    c.upstream.send(JSON.stringify({ type: "session.instructions.append", delegation_id: null, content: "Tell the person, in one sentence, that they're out of credit and the call is ending." }));
    setTimeout(() => c.upstream.send(JSON.stringify({ type: "session.close" })), 6000);
  }
}

/** POST live/sessions, after proxy() has checked the app, the wallet and the daily cap. */
export async function createLive(sql: Db, req: Request, ctx: { user: { id: string }; app: string; markup: number; balance: number }, rest: string): Promise<Response> {
  if (req.method !== "POST" || rest !== "live/sessions") return json({ error: `not available through the proxy: ${req.method} /${rest}` }, 403);
  if (!OPENAI_API_KEY) return json({ error: "voice isn't configured on the control plane (OPENAI_API_KEY)" }, 503);
  const raw = await req.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "body must be JSON" }, 400); }
  if (body?.session?.model !== LIVE_MODEL) return json({ error: `only ${LIVE_MODEL} is priced` }, 403);
  if (body?.transport?.type !== "webrtc") return json({ error: "only WebRTC sessions" }, 403);
  const minimum = (LIVE_MIN_SECONDS / 60) * LIVE_USD_PER_MIN * ctx.markup;
  if (ctx.balance < minimum) return json({ error: "out of credits", balance: ctx.balance, needs: minimum }, 402);

  const up = await fetch(`${base()}/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json", "openai-safety-identifier": await safetyId(ctx.user.id) },
    body: raw,
  });
  const text = await up.text();
  if (!up.ok) return new Response(text, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/json" } });
  const id = String(JSON.parse(text)?.session?.id ?? "");
  if (!id) return json({ error: "OpenAI returned no session id" }, 502);

  const upstream = new WebSocket(`${base().replace(/^http/, "ws")}/live/sessions/${encodeURIComponent(id)}/attach`, {
    headers: { authorization: `Bearer ${OPENAI_API_KEY}` },
  } as any);
  const c: Call = { id, userId: ctx.user.id, app: ctx.app, markup: ctx.markup, seconds: 0, charged: 0, upstream, client: null, backlog: [] };
  calls.set(id, c);
  await charge(sql, c, true); // the 15 seconds WebRTC creation bills
  upstream.addEventListener("message", (m) => {
    const data = String(m.data);
    let ev: any;
    try { ev = JSON.parse(data); } catch { return; }
    if (DROPPED_EVENTS.has(ev.type)) return;
    if (ev.type === "session.usage.updated" || ev.type === "session.closed") {
      c.seconds = Math.max(c.seconds, Number(ev.usage?.seconds ?? 0));
      charge(sql, c, ev.type === "session.closed").catch((e) => console.error("[live] charge failed", e));
    }
    if (c.client) c.client.send(data);
    else if (c.backlog.length < 500) c.backlog.push(data);
  });
  upstream.addEventListener("close", () => {
    charge(sql, c, true).catch((e) => console.error("[live] charge failed", e));
    c.client?.close();
    calls.delete(id);
  });
  return new Response(text, { status: up.status, headers: { "content-type": "application/json" } });
}

/** Whether `userId` may attach to Live session `id` (it's theirs and still running). */
export const ownsCall = (id: string, userId: string) => calls.get(id)?.userId === userId;

export const liveSocket: WebSocketHandler<{ id: string }> = {
  open(ws) {
    const c = calls.get(ws.data.id);
    if (!c) return ws.close(1011, "call ended");
    c.client?.close(1000, "replaced");
    c.client = ws;
    for (const d of c.backlog.splice(0)) ws.send(d);
  },
  message(ws, msg) {
    const c = calls.get(ws.data.id);
    let ev: any;
    try { ev = JSON.parse(String(msg)); } catch { return; }
    if (c && RELAYED_COMMANDS.has(ev?.type)) c.upstream.send(JSON.stringify(ev));
  },
  close(ws) {
    const c = calls.get(ws.data.id);
    if (c?.client === ws) c.client = null; // the call goes on; it's still metered
  },
};

// OpenAI asks for a stable, privacy-preserving id per end user on voice sessions.
async function safetyId(userId: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`odapt:${userId}`));
  return Buffer.from(d).toString("hex").slice(0, 32);
}
