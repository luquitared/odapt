// The API. Browsers read a session over SSE and write actions; runners and the
// agent CLI write events and long-poll for actions. Nothing the agent does
// happens inside one of these requests.

import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { account, buy, controlUrl, MIN_BALANCE_USD, signOut, startSignIn } from "./account";
import { DATA_DIR, HEARTBEAT_STALE_MS, PORT, ROOT, RUNNER_TOKEN } from "./config";
import { presets } from "./harness";
import { launchRunner } from "./launcher";
import { newSession, type ActionBody, type EmitBody, type LogEvent, type Session } from "./protocol";
import { SqliteStore } from "./store";
import { listApps, listTemplates, loadTemplate } from "./templates";
import { LiveError, liveSession, liveTarget, startCall, type Call } from "./voice";

const store = new SqliteStore(join(DATA_DIR, "snappy.db"));
const ASSETS = join(DATA_DIR, "assets");

// ---------------------------------------------------------------- fan-out

type Listener = (e: LogEvent, s: Session) => void;
const listeners = new Map<string, Set<Listener>>();

function publish(sessionId: string, origin: LogEvent["origin"], body: LogEvent["body"]) {
  const r = store.append(sessionId, origin, body);
  if (r) for (const l of listeners.get(sessionId) ?? []) l(r.event, r.session);
  return r;
}

function subscribe(sessionId: string, l: Listener) {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  listeners.get(sessionId)!.add(l);
  return () => listeners.get(sessionId)?.delete(l);
}

// ---------------------------------------------------------------- runners

const launching = new Map<string, number>();

function runnerAlive(s: Session) {
  const fresh = Date.now() - s.runner.heartbeatAt < HEARTBEAT_STALE_MS;
  return (s.runner.state === "running" || s.runner.state === "starting") && fresh;
}

async function ensureRunner(s: Session) {
  if (runnerAlive(s)) return;
  if (Date.now() - (launching.get(s.id) ?? 0) < HEARTBEAT_STALE_MS) return;
  launching.set(s.id, Date.now());
  publish(s.id, "system", { type: "runner", state: "starting" });
  try {
    await launchRunner(s.id);
  } catch (err) {
    launching.delete(s.id);
    publish(s.id, "system", { type: "progress", kind: "error", text: "Couldn't start a worker for this session." });
    publish(s.id, "system", { type: "status", status: "failed", reason: String(err) });
  }
}

// ---------------------------------------------------------------- voice calls (src/voice.ts)

const calls = new Map<string, Call>(); // engine session → its one voice call

async function startVoice(s: Session, sdp: string): Promise<Response> {
  const t = loadTemplate(s.templateId);
  if (!t?.voice) return json({ error: "This app can't be used by voice." }, 404);
  const target = liveTarget(t.id);
  if ("error" in target) return json({ error: target.error }, controlUrl() ? 401 : 503);
  calls.get(s.id)?.hangUp();
  const log = (...a: unknown[]) => console.log(new Date().toISOString(), `[${s.id} voice]`, ...a);
  try {
    const { answer, call } = await startCall(target, liveSession(s, t, store.eventsAfter(s.id, 0)), sdp, Object.values(s.panels), {
      publish: (origin, body) => publish(s.id, origin, body)?.event ?? null,
      subscribe: (l) => subscribe(s.id, (e) => l(e)),
      wake: () => void ensureRunner(store.getSession(s.id)!),
      log,
      onEnd: () => { if (calls.get(s.id) === call) calls.delete(s.id); },
    });
    calls.set(s.id, call);
    log("call", call.liveId);
    return json(answer, 201);
  } catch (e) {
    log("start failed:", (e as Error).message);
    return json({ error: (e as Error).message }, e instanceof LiveError ? e.status : 502);
  }
}

// ---------------------------------------------------------------- helpers

const json = (data: unknown, status = 200) => Response.json(data, { status });
const isRunner = (req: Request) => req.headers.get("authorization") === `Bearer ${RUNNER_TOKEN}`;
const safeName = (n: string) => basename(n).replace(/[^a-zA-Z0-9._-]/g, "_");

function sse(req: Request, s: Session) {
  const after = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("after") ?? 0);
  let unsubscribe = () => {};
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(ctrl) {
      const enc = new TextEncoder();
      const send = (event: string, data: unknown, id?: number) =>
        ctrl.enqueue(enc.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      // Subscribe before replaying so nothing falls in the gap; dedupe by seq.
      let sent = after;
      const buffered: [LogEvent, Session][] = [];
      let live = false;
      unsubscribe = subscribe(s.id, (e, snap) => {
        if (!live) return void buffered.push([e, snap]);
        if (e.seq > sent) { sent = e.seq; send("log", { event: e, session: snap }, e.seq); }
      });
      const missed = store.eventsAfter(s.id, after);
      send("snapshot", { session: store.getSession(s.id), events: missed });
      for (const e of missed) sent = Math.max(sent, e.seq);
      live = true;
      for (const [e, snap] of buffered) if (e.seq > sent) { sent = e.seq; send("log", { event: e, session: snap }, e.seq); }
      ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 15_000);
    },
    cancel() {
      unsubscribe();
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

function waitForActions(sessionId: string, after: number, waitMs: number): Promise<LogEvent[]> {
  const ready = store.actionsAfter(sessionId, after);
  if (ready.length || waitMs <= 0) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); off(); resolve(store.actionsAfter(sessionId, after)); };
    const off = subscribe(sessionId, (e) => { if (e.body.type === "action") finish(); });
    const timer = setTimeout(finish, waitMs);
  });
}

// ---------------------------------------------------------------- routes

const server = Bun.serve({
  port: PORT,
  reusePort: false,
  idleTimeout: 0, // SSE and long-polls outlive Bun's default
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = (re: RegExp) => path.match(re);
    let p: RegExpMatchArray | null;

    if (path === "/" || path === "/index.html") return new Response(Bun.file(join(ROOT, "ui/index.html")));
    if (path === "/api/health") return json({ ok: true });
    if (path === "/api/harnesses") return json(presets());
    if (path === "/api/templates") return json(listTemplates().map(({ dir, ...t }) => t));
    if (path === "/api/apps") return json(listApps());

    // -- the signed-in account (src/account.ts)
    if (path === "/api/account" && req.method === "GET") return json(await account(url.searchParams.get("app") ?? undefined));
    if (path === "/api/account/sign-in" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { app?: string };
      try { return json(await startSignIn(b.app)); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }
    if (path === "/api/account/sign-out" && req.method === "POST") { await signOut(); return json({ ok: true }); }
    if (path === "/api/account/buy" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { app?: string; pack?: string };
      try { return json({ url: await buy(b.app, String(b.pack ?? "")) }); } catch (e) { return json({ error: (e as Error).message }, 502); }
    }

    if (path === "/api/sessions" && req.method === "GET") {
      return json(store.listSessions().map(({ panels, asks, ...s }) => s));
    }

    if (path === "/api/sessions" && req.method === "POST") {
      const body = (await req.json()) as { templateId: string; mode?: "job" | "editor"; input?: Record<string, unknown>; mock?: boolean; harness?: string };
      const t = loadTemplate(body.templateId);
      if (!t) return json({ error: "unknown template" }, 404);
      const input = body.input ?? {};
      const missing = t.inputs.filter((i) => i.required && !String(input[i.id] ?? "").trim()).map((i) => i.id);
      if (missing.length) return json({ error: "missing inputs", missing }, 400);
      if (body.harness && !presets()[body.harness]) return json({ error: `unknown harness "${body.harness}"` }, 400);
      // On a control plane every session runs on the user's credit, so it needs a sign-in and some credit.
      if (controlUrl()) {
        const a = await account(t.id);
        if (!a.signedIn) return json({ error: "Sign in to start a run.", account: "sign-in" }, 401);
        if (a.balanceUsd !== undefined && a.balanceUsd < MIN_BALANCE_USD) return json({ error: "You're out of credit. Buy more to start a run.", account: "buy" }, 402);
      }
      const mode = body.mode ?? t.modes[0];
      if (!t.modes.includes(mode)) return json({ error: `template does not support ${mode} mode` }, 400);
      const s = newSession({
        id: crypto.randomUUID().slice(0, 13).replace("-", ""),
        templateId: t.id, mode, mock: !!body.mock, input, title: t.name, harness: body.harness || undefined,
      });
      store.createSession(s);
      await ensureRunner(s);
      return json(store.getSession(s.id), 201);
    }

    if ((p = m(/^\/assets\/([a-z0-9]+)\/([^/]+)$/)) && req.method === "GET") {
      const f = Bun.file(join(ASSETS, p[1], safeName(p[2])));
      return (await f.exists()) ? new Response(f) : json({ error: "not found" }, 404);
    }

    if (!(p = m(/^\/api\/sessions\/([a-z0-9]+)(\/.*)?$/))) return json({ error: "not found" }, 404);
    const session = store.getSession(p[1]);
    if (!session) return json({ error: "unknown session" }, 404);
    const sub = p[2] ?? "";

    // -- browser
    if (sub === "" && req.method === "GET") return json(session);
    if (sub === "/events" && req.method === "GET") return sse(req, session);
    if (sub === "/actions" && req.method === "POST") {
      const action = (await req.json()) as ActionBody;
      if (!action?.type) return json({ error: "action.type required" }, 400);
      // Edits are saved without waking the agent — it reads the panel back when
      // the user next presses something. A turn per keystroke-blur would be absurd.
      if (action.type === "edit" && action.panel && action.payload && typeof action.payload === "object") {
        const r = publish(session.id, "user", { type: "panel.patch", id: action.panel, data: action.payload as Record<string, unknown> });
        return json({ seq: r!.event.seq });
      }
      const r = publish(session.id, "user", { type: "action", action });
      await ensureRunner(store.getSession(session.id)!);
      return json({ seq: r!.event.seq });
    }
    // Voice: the browser's WebRTC offer in, GPT-Live's answer out; the call itself runs here.
    if (sub === "/voice" && req.method === "POST") {
      const { sdp } = (await req.json().catch(() => ({}))) as { sdp?: string };
      if (typeof sdp !== "string" || !sdp.trim()) return json({ error: "sdp required" }, 400);
      return startVoice(session, sdp);
    }

    // -- runner / agent CLI
    if (!isRunner(req)) return json({ error: "unauthorized" }, 401);

    if (sub === "/emit" && req.method === "POST") {
      const body = (await req.json()) as EmitBody;
      if (!body?.type) return json({ error: "type required" }, 400);
      // The launch guard only covers the gap before a runner first reports in.
      if (body.type === "runner") launching.delete(session.id);
      const r = publish(session.id, "agent", body);
      return json({ seq: r!.event.seq });
    }
    if (sub === "/actions" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const wait = Math.min(Number(url.searchParams.get("wait") ?? 0), 55) * 1000;
      return json(await waitForActions(session.id, after, wait));
    }
    if (sub === "/log" && req.method === "GET") {
      return json(store.eventsAfter(session.id, Number(url.searchParams.get("after") ?? 0)));
    }
    if (sub === "/heartbeat" && req.method === "POST") {
      store.touchHeartbeat(session.id);
      return json({ ok: true });
    }
    if ((p = sub.match(/^\/assets\/([^/]+)$/)) && req.method === "PUT") {
      const dir = join(ASSETS, session.id);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const name = safeName(decodeURIComponent(p[1]));
      await Bun.write(join(dir, name), await req.arrayBuffer());
      return json({ url: `/assets/${session.id}/${name}`, name });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`snappy-studio on http://127.0.0.1:${server.port}  (data: ${DATA_DIR})`);
