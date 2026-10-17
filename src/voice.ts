// Voice mode: a person talks to a session through OpenAI's GPT-Live (`gpt-live-1`), a full-duplex
// voice model, while the session's harness keeps doing the work. GPT-Live is not a harness: it takes
// no typed turns and runs no tools. It talks, and when something needs the app it *delegates*
// (client delegation). Here a delegation becomes a user action, the same as a typed message, so the
// runner and whatever harness the session has handle it unchanged. What the agent then shows the
// user (`snap say`, `snap ask`, `snap done`) goes back to GPT-Live to be said aloud.
//
//   browser ══ WebRTC audio ══ GPT-Live ── sideband WebSocket ── VoiceBridge ── log ── runner ── harness
//
// The browser's SDP offer comes here and the session is created server-side, so the key never
// reaches the page; this server then attaches the sideband. On a control plane both go through its
// proxy (control/live.ts), which holds the OpenAI key and bills the minutes; otherwise
// OPENAI_API_KEY is used directly.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { controlUrl, token } from "./account";
import { ROOT } from "./config";
import type { LogEvent, Session } from "./protocol";
import { fill, readTemplateFile, type Template } from "./templates";

export const LIVE_MODEL = "gpt-live-1";
// https://developers.openai.com/api/docs/models/gpt-live-1 — billed per second. Creating a WebRTC
// session bills 15 seconds up front, credited against the running time, so 15s is the minimum.
export const LIVE_USD_PER_MIN = 0.05;
export const LIVE_MIN_SECONDS = 15;
const GREETING = "A new call has just started and the person can hear you; they already pressed Talk, so never tell them to. Speak first, right now, even if you spoke in an earlier call: greet them briefly. If your instructions say what to do when the call starts, do that. Otherwise, if the page is waiting on them, tell them what for. Then pause and listen.";
export const liveCost = (seconds: number) => (Math.max(seconds, LIVE_MIN_SECONDS) / 60) * LIVE_USD_PER_MIN;

// Context appends take at most 500 tokens each.
const APPEND_MAX = 1800;
// Startup history: at most 128 messages and 8,192 tokens in total.
const HISTORY_MESSAGES = 16, HISTORY_CHARS = 6000;
// The page may only end the call or mute itself; everything that steers the conversation comes
// from this server.
const BROWSER_EVENTS = ["session.close", "session.input_audio.mute", "session.input_audio.unmute"];

export type LiveCommand =
  | { type: "session.instructions.append" | "session.thinking.append" | "session.commentary.append"; delegation_id: string | null; content: string }
  | { type: "session.close" };

// ---------------------------------------------------------------- session config

/** Markdown is for the page; a voice reads words. */
export function speakable(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[`*_#>]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, APPEND_MAX);
}

/** What's on the page, for a voice that can't see it. */
export function pageSummary(s: Session): string {
  const lines = Object.values(s.panels).sort((a, b) => a.order - b.order).map((p) => {
    // An html panel can't be read, so it carries its own `summary`.
    const d = p.data as { markdown?: string; summary?: string } | null;
    const md = d?.summary ?? d?.markdown;
    return `- ${p.title}${p.status === "working" ? " (still working)" : ""}${typeof md === "string" && md.length < 600 ? `: ${speakable(md).replace(/\n/g, " / ")}` : ""}`;
  });
  const asks = Object.values(s.asks).filter((a) => a.answer === null).map((a) => `- The app is asking: ${a.text}${a.options.length ? ` (${a.options.map((o) => o.label).join(", ")})` : ""}`);
  return [...lines, ...asks].join("\n") || "- Nothing yet.";
}

/** The conversation so far, as GPT-Live's startup `input`. */
export function history(events: LogEvent[]): { type: "message"; role: "user" | "assistant"; content: { type: "input_text" | "output_text"; text: string }[] }[] {
  const said: { role: "user" | "assistant"; text: string }[] = [];
  for (const e of events) {
    const b = e.body as any;
    if (b.type === "message") said.push({ role: "assistant", text: speakable(b.text) });
    else if (b.type === "voice") said.push({ role: b.who === "user" ? "user" : "assistant", text: b.text });
    else if (b.type === "action" && b.action.type === "message" && typeof b.action.payload === "string") said.push({ role: "user", text: b.action.payload });
  }
  const out: typeof said = [];
  let chars = 0;
  for (const m of said.reverse()) {
    const text = m.text.slice(0, 500);
    if (!text || out.length >= HISTORY_MESSAGES || chars + text.length > HISTORY_CHARS) break;
    out.unshift({ ...m, text });
    chars += text.length;
  }
  return out.map((m) => ({ type: "message", role: m.role, content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }] }));
}

export function liveSession(s: Session, t: Template, events: LogEvent[]) {
  const vars = { input: s.input, mode: s.mode };
  const instructions = [
    fill(readFileSync(join(ROOT, "prompts/voice.md"), "utf8"), vars).replaceAll("{{app}}", t.name).replaceAll("{{description}}", t.description),
    fill(readTemplateFile(t, "voice.md"), vars),
    `## The page right now\n\n${pageSummary(s)}`,
  ].filter(Boolean).join("\n\n");
  return {
    model: LIVE_MODEL,
    instructions,
    // The opening line goes in at creation: an instruction appended once the call is running is
    // acknowledged but doesn't make GPT-Live speak first.
    input: [...history(events), { type: "message", role: "developer", content: [{ type: "input_text", text: GREETING }] }],
    audio: { output: { voice: t.voice?.voice ?? "marin" } },
    delegation: { type: "client" },
    client: { data_channel: { allowed_client_events: BROWSER_EVENTS, allowed_server_events: [{ type: "session.started" }, { type: "session.closed" }, { type: "error" }] } },
  };
}

// ---------------------------------------------------------------- the bridge

export interface BridgeHooks {
  send(cmd: LiveCommand): void;
  publish(origin: LogEvent["origin"], body: LogEvent["body"]): { seq: number } | null;
  wake(): void; // make sure a runner is there to take the action
  log(...a: unknown[]): void;
}

/**
 * The logic between one Live session and one engine session, with no sockets in it: feed it
 * GPT-Live events (`live`) and the session's log (`logged`); it publishes actions and captions and
 * sends commands through the hooks.
 */
export class VoiceBridge {
  seconds = 0;
  ended = false;
  private heard = ""; // what the person said since the last delegation
  private lastSaid = ""; // the voice's last line, so a bare "yes" has something to answer
  private captions = { user: "", assistant: "" };
  private captionTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: { id: string; seq: number }[] = []; // delegations the agent hasn't answered
  private consumed = 0; // the runner's action cursor
  private reply: string[] = [];
  private seen = new Set<string>();

  constructor(private h: BridgeHooks, private opts = { captionGapMs: 1200, settleMs: 700 }) {}

  /** Panels already on the page when the call started: the voice was told about them up front. */
  onPage(panels: { id: string; title: string }[]) {
    for (const p of panels) this.seen.add(`${p.id}:${p.title}`);
  }

  /** A GPT-Live server event from the sideband. */
  live(ev: any) {
    switch (ev?.type) {
      case "session.input_transcript.delta":
        this.heard += ev.delta;
        return this.caption("user", ev.delta);
      case "session.output_transcript.delta":
        return this.caption("assistant", ev.delta);
      case "session.delegation.created":
        if (ev.delegation?.target !== "client") return;
        // The delegation can land before the last words of the request are transcribed.
        return void setTimeout(() => this.delegate(ev.delegation.id), this.opts.settleMs);
      case "session.usage.updated":
        this.seconds = ev.usage?.seconds ?? this.seconds;
        return;
      case "session.closed":
        this.seconds = ev.usage?.seconds ?? this.seconds;
        return this.end(ev.reason ?? "closed");
      case "error":
        return this.h.log("live error:", JSON.stringify(ev.error ?? ev));
    }
  }

  /** An event appended to the session's log. */
  logged(e: LogEvent) {
    if (this.ended) return;
    const b = e.body as any;
    const answering = this.pending.at(-1)?.id ?? null;
    switch (b.type) {
      case "voice.instruct":
        return this.h.send({ type: "session.instructions.append", delegation_id: null, content: String(b.text).slice(0, APPEND_MAX) });
      case "message":
      case "ask":
      case "done": {
        const text = b.type === "message" ? speakable(b.text)
          : b.type === "done" ? `Finished: ${speakable(b.summary)}`
          : `The app asks: ${b.ask.text}${b.ask.options?.length ? ` Options: ${b.ask.options.map((o: { label: string }) => o.label).join(", ")}.` : ""}`;
        // Held while the agent is answering a delegation, so the answer arrives as one piece.
        if (this.pending.length) { if (!this.reply.includes(text)) this.reply.push(text); }
        else this.h.send({ type: "session.commentary.append", delegation_id: null, content: text });
        return;
      }
      case "progress":
        if (answering && b.kind !== "error") this.h.send({ type: "session.thinking.append", delegation_id: answering, content: `Progress: ${b.text}`.slice(0, APPEND_MAX) });
        return;
      case "panel.set": {
        const key = `${b.panel.id}:${b.panel.title ?? ""}`;
        if (this.seen.has(key) || !b.panel.title) return;
        this.seen.add(key);
        return this.h.send({ type: "session.thinking.append", delegation_id: answering, content: `The page now shows "${b.panel.title}".` });
      }
      case "runner":
        if (b.actionCursor) this.consumed = Math.max(this.consumed, b.actionCursor);
        return;
      case "status":
        if (["waiting", "done", "idle", "failed"].includes(b.status)) this.turnEnded(b.status === "failed");
        return;
    }
  }

  private delegate(id: string) {
    if (this.ended) return;
    this.flushCaptions();
    const said = this.heard.trim();
    this.heard = "";
    const r = this.h.publish("user", { type: "action", action: { type: "voice", payload: { said, before: this.lastSaid } } });
    if (!r) return;
    this.pending.push({ id, seq: r.seq });
    this.h.wake();
  }

  // A turn ended. It answered every delegation whose action the runner had taken by then.
  private turnEnded(failed: boolean) {
    const answered = this.pending.filter((p) => p.seq <= this.consumed);
    this.pending = this.pending.filter((p) => p.seq > this.consumed);
    const text = this.reply.join("\n").slice(0, APPEND_MAX);
    this.reply = [];
    const last = answered.at(-1);
    for (const p of answered.slice(0, -1)) this.h.send({ type: "session.thinking.append", delegation_id: p.id, content: "Handled together with the next request." });
    if (last) {
      const content = failed ? "The app ran into a problem and couldn't finish that. Ask the person to try again."
        : text || "Done. The page is up to date.";
      this.h.send({ type: "session.commentary.append", delegation_id: last.id, content });
    } else if (text) {
      this.h.send({ type: "session.commentary.append", delegation_id: null, content: text });
    }
  }

  // Transcripts come in fragments with no turn boundaries: a line is done when the other side
  // starts talking or after a pause.
  private caption(who: "user" | "assistant", delta: string) {
    const other = who === "user" ? "assistant" : "user";
    if (this.captions[other]) this.flushCaptions(other);
    this.captions[who] += delta;
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => this.flushCaptions(), this.opts.captionGapMs);
  }

  flushCaptions(only?: "user" | "assistant") {
    for (const who of only ? [only] : (["user", "assistant"] as const)) {
      const text = this.captions[who].trim();
      this.captions[who] = "";
      if (!text) continue;
      if (who === "assistant") this.lastSaid = text.slice(-400);
      this.h.publish("system", { type: "voice", who, text });
    }
  }

  /** The call is over: confirmed by `session.closed`, or the sideband dropped. */
  end(reason: string) {
    if (this.ended) return;
    this.flushCaptions();
    this.ended = true;
    if (this.captionTimer) clearTimeout(this.captionTimer);
    this.h.publish("system", { type: "cost", source: `gpt-live (${LIVE_MODEL})`, usd: liveCost(this.seconds) });
    const m = Math.floor(this.seconds / 60), s = Math.round(this.seconds % 60);
    this.h.publish("system", { type: "progress", kind: "info", text: `Voice call ended (${m ? `${m}m ` : ""}${s}s${reason === "close_requested" ? "" : `, ${reason.replace(/_/g, " ")}`}).` });
  }
}

// ---------------------------------------------------------------- transport

export interface LiveTarget { base: string; auth: string }

/** Where Live calls go: the control plane's proxy on a user's credit, else OpenAI with our own key. */
export function liveTarget(app: string): LiveTarget | { error: string } {
  const url = controlUrl();
  if (url) {
    const t = token();
    return t ? { base: `${url}/proxy/${app}/openai/v1`, auth: t } : { error: "Sign in to talk." };
  }
  const key = process.env.OPENAI_API_KEY;
  // OPENAI_LIVE_BASE points at a stand-in, for testing.
  return key ? { base: (process.env.OPENAI_LIVE_BASE ?? "https://api.openai.com/v1").replace(/\/$/, ""), auth: key } : { error: "Voice needs OPENAI_API_KEY (or a control plane)." };
}

export class LiveError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export interface Call { liveId: string; bridge: VoiceBridge; hangUp(): void }

/**
 * Starts a call: creates the Live session for the browser's SDP offer, attaches the sideband and
 * wires it to a bridge. Resolves with what the browser needs (the SDP answer) and the call.
 */
export async function startCall(
  target: LiveTarget, session: object, sdp: string, page: { id: string; title: string }[],
  hooks: Omit<BridgeHooks, "send"> & { subscribe(l: (e: LogEvent) => void): () => void; onEnd(): void },
): Promise<{ answer: { session: { id: string }; transport: { type: string; sdp: string } }; call: Call }> {
  const res = await fetch(`${target.base}/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.auth}`, "content-type": "application/json" },
    body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new LiveError(body?.error?.message ?? body?.error ?? `Live session failed (${res.status})`, res.status);
  const liveId: string = body.session.id;

  const ws = new WebSocket(`${target.base.replace(/^http/, "ws")}/live/sessions/${encodeURIComponent(liveId)}/attach`, {
    headers: { authorization: `Bearer ${target.auth}` },
  } as any);
  const queue: string[] = [];
  const send = (cmd: LiveCommand) => {
    const s = JSON.stringify({ ...cmd, event_id: `snap_${crypto.randomUUID().slice(0, 12)}` });
    if (ws.readyState === WebSocket.OPEN) ws.send(s); else queue.push(s);
  };
  const bridge = new VoiceBridge({ ...hooks, send });
  bridge.onPage(page);
  const off = hooks.subscribe((e) => bridge.logged(e));
  ws.addEventListener("open", () => {
    for (const s of queue.splice(0)) ws.send(s);
  });
  ws.addEventListener("message", (m) => {
    try {
      const ev = JSON.parse(String(m.data));
      // SNAP_VOICE_DEBUG=1: every sideband event but the transcript fragments, in the server log.
      if (process.env.SNAP_VOICE_DEBUG && !String(ev?.type).endsWith(".delta")) hooks.log("live event:", JSON.stringify(ev).slice(0, 400));
      bridge.live(ev);
    } catch (e) { hooks.log("bad live event:", e); }
  });
  ws.addEventListener("close", () => { off(); bridge.end("connection_lost"); hooks.onEnd(); });
  ws.addEventListener("error", () => hooks.log("live sideband error"));
  return { answer: body, call: { liveId, bridge, hangUp: () => send({ type: "session.close" }) } };
}
