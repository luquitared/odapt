import { describe, expect, test } from "bun:test";
import { dueSeconds } from "../control/live";
import { newSession, type LogEvent } from "../src/protocol";
import { loadTemplate } from "../src/templates";
import { history, liveCost, liveSession, pageSummary, speakable, VoiceBridge, type LiveCommand } from "../src/voice";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A bridge wired to an in-memory log, the way src/server.ts wires it to the real one.
function rig() {
  const sent: LiveCommand[] = [];
  const log: LogEvent[] = [];
  let seq = 0, woken = 0;
  const bridge = new VoiceBridge({
    send: (c) => sent.push(c),
    publish: (origin, body) => { const e = { seq: ++seq, sessionId: "s", at: Date.now(), origin, body } as LogEvent; log.push(e); return e; },
    wake: () => void woken++,
    log: () => {},
  }, { captionGapMs: 5, settleMs: 5 });
  // The agent side: what a runner would append while it takes the user's action and answers.
  const agent = (...bodies: any[]) => { for (const body of bodies) { const e = { seq: ++seq, sessionId: "s", at: Date.now(), origin: "agent", body } as LogEvent; log.push(e); bridge.logged(e); } };
  const actions = () => log.filter((e) => e.body.type === "action").map((e) => ({ seq: e.seq, ...(e.body as any).action }));
  return { bridge, sent, log, agent, actions, woken: () => woken };
}

describe("voice bridge", () => {
  test("a delegation becomes a voice action carrying what was said; the agent's reply goes back to it", async () => {
    const { bridge, sent, agent, actions, woken } = rig();
    bridge.live({ type: "session.output_transcript.delta", delta: "¿Cómo se dice apple?" });
    bridge.live({ type: "session.input_transcript.delta", delta: "Manzana" });
    bridge.live({ type: "session.input_transcript.delta", delta: ", creo." });
    bridge.live({ type: "session.delegation.created", offset_ms: 1000, delegation: { id: "del_1", type: "delegation", target: "client" } });
    await sleep(20);

    const [a] = actions();
    expect(a.type).toBe("voice");
    expect(a.payload).toEqual({ said: "Manzana, creo.", before: "¿Cómo se dice apple?" });
    expect(woken()).toBe(1);

    agent({ type: "status", status: "working" }, { type: "progress", text: "checking" }, { type: "message", text: "**Right!** _Manzana_ is apple." }, { type: "message", text: "Right! Manzana is apple." });
    expect(sent.at(-1)).toEqual({ type: "session.thinking.append", delegation_id: "del_1", content: "Progress: checking" });
    expect(sent.some((c) => c.type === "session.commentary.append")).toBe(false); // held until the turn ends
    agent({ type: "runner", state: "running", actionCursor: a.seq }, { type: "status", status: "waiting" });
    expect(sent.at(-1)).toEqual({ type: "session.commentary.append", delegation_id: "del_1", content: "Right! Manzana is apple." });
  });

  test("a turn that hasn't taken the action yet doesn't answer it", async () => {
    const { bridge, sent, agent, actions } = rig();
    agent({ type: "status", status: "working" }); // a turn already running
    bridge.live({ type: "session.input_transcript.delta", delta: "next round" });
    bridge.live({ type: "session.delegation.created", delegation: { id: "del_1", target: "client" } });
    await sleep(20);
    agent({ type: "message", text: "Earlier news." }, { type: "status", status: "waiting" });
    expect(sent.at(-1)).toEqual({ type: "session.commentary.append", delegation_id: null, content: "Earlier news." });
    agent({ type: "status", status: "working" }, { type: "message", text: "Round 2." }, { type: "runner", state: "running", actionCursor: actions()[0].seq }, { type: "status", status: "waiting" });
    expect(sent.at(-1)).toEqual({ type: "session.commentary.append", delegation_id: "del_1", content: "Round 2." });
  });

  test("two delegations answered by one turn: the last gets the answer", async () => {
    const { bridge, sent, agent, actions } = rig();
    bridge.live({ type: "session.delegation.created", delegation: { id: "del_1", target: "client" } });
    bridge.live({ type: "session.delegation.created", delegation: { id: "del_2", target: "client" } });
    await sleep(20);
    agent({ type: "status", status: "working" }, { type: "message", text: "Both done." }, { type: "runner", state: "running", actionCursor: actions()[1].seq }, { type: "status", status: "waiting" });
    expect(sent.slice(-2)).toEqual([
      { type: "session.thinking.append", delegation_id: "del_1", content: "Handled together with the next request." },
      { type: "session.commentary.append", delegation_id: "del_2", content: "Both done." },
    ]);
  });

  test("a failed turn is reported; a silent one still closes the delegation", async () => {
    const { bridge, sent, agent, actions } = rig();
    bridge.live({ type: "session.delegation.created", delegation: { id: "d", target: "client" } });
    await sleep(20);
    agent({ type: "status", status: "working" }, { type: "runner", state: "running", actionCursor: actions()[0].seq }, { type: "status", status: "failed" });
    expect((sent.at(-1) as any).content).toContain("problem");
    bridge.live({ type: "session.delegation.created", delegation: { id: "e", target: "client" } });
    await sleep(20);
    agent({ type: "status", status: "working" }, { type: "runner", state: "running", actionCursor: actions()[1].seq }, { type: "status", status: "waiting" });
    expect(sent.at(-1)).toEqual({ type: "session.commentary.append", delegation_id: "e", content: "Done. The page is up to date." });
  });

  test("the agent can steer the voice, and the voice hears about new panels once", () => {
    const { bridge, sent, agent } = rig();
    agent({ type: "voice.instruct", text: "Say «hola» exactly." });
    expect(sent.at(-1)).toEqual({ type: "session.instructions.append", delegation_id: null, content: "Say «hola» exactly." });
    bridge.onPage([{ id: "board", title: "Score" }]);
    agent({ type: "panel.set", panel: { id: "board", title: "Score" } }, { type: "panel.set", panel: { id: "round", title: "Round 1" } }, { type: "panel.set", panel: { id: "round", title: "Round 1" } });
    expect(sent.filter((c) => c.type === "session.thinking.append")).toEqual([{ type: "session.thinking.append", delegation_id: null, content: 'The page now shows "Round 1".' }]);
  });

  test("captions are lines, split at a change of speaker or a pause; the call ends with its cost", async () => {
    const { bridge, log } = rig();
    bridge.live({ type: "session.output_transcript.delta", delta: "Hola, " });
    bridge.live({ type: "session.output_transcript.delta", delta: "¿qué tal?" });
    bridge.live({ type: "session.input_transcript.delta", delta: "Bien" });
    await sleep(20);
    expect(log.map((e) => e.body)).toEqual([
      { type: "voice", who: "assistant", text: "Hola, ¿qué tal?" },
      { type: "voice", who: "user", text: "Bien" },
    ]);
    bridge.live({ type: "session.usage.updated", usage: { seconds: 30 } });
    bridge.live({ type: "session.closed", reason: "close_requested", usage: { seconds: 120 } });
    bridge.end("connection_lost"); // the socket closing afterwards changes nothing
    expect(log.filter((e) => e.body.type === "cost").map((e) => (e.body as any).usd)).toEqual([0.1]);
    expect(log.at(-1)!.body).toEqual({ type: "progress", kind: "info", text: "Voice call ended (2m 0s)." });
  });
});

describe("voice session config", () => {
  test("costs: per second, 15 seconds at least", () => {
    expect(liveCost(120)).toBeCloseTo(0.1);
    expect(liveCost(3)).toBeCloseTo(liveCost(15));
  });

  test("speakable strips markdown", () => {
    expect(speakable("# Round 2\n\n- **hola** — hi\n- [link](http://x)\n`code`")).toBe("Round 2\nhola — hi\nlink\ncode");
  });

  test("the voice gets the app, the page, the conversation, and can only hang up from the browser", () => {
    const t = loadTemplate("lingo")!;
    const s = newSession({ id: "s", templateId: "lingo", mode: "editor", mock: false, input: { language: "French", level: "beginner" }, title: "Lingo", harness: undefined });
    s.panels.round = { id: "round", kind: "markdown", title: "Round 1", status: "ready", data: { markdown: "**Bonjour**" }, actions: [], order: 0, updatedAt: 0 };
    const ev = (seq: number, origin: LogEvent["origin"], body: any) => ({ seq, sessionId: "s", at: 0, origin, body }) as LogEvent;
    const cfg = liveSession(s, t, [ev(1, "agent", { type: "message", text: "Welcome!" }), ev(2, "user", { type: "action", action: { type: "message", payload: "salut" } }), ev(3, "agent", { type: "progress", text: "x" })]);
    expect(cfg.model).toBe("gpt-live-1");
    expect(cfg.delegation).toEqual({ type: "client" });
    expect(cfg.instructions).toContain("You are the voice of Lingo");
    expect(cfg.instructions).toContain("a language game in French");
    expect(cfg.instructions).toContain("- Round 1: Bonjour");
    expect(cfg.input.slice(0, -1).map((m) => [m.role, m.content[0].text])).toEqual([["assistant", "Welcome!"], ["user", "salut"]]);
    // The greeting is a developer message at creation; one appended after the start is ignored.
    expect(cfg.input.at(-1)).toMatchObject({ role: "developer", content: [{ type: "input_text", text: expect.stringContaining("Greet the person now") }] });
    expect(cfg.client.data_channel.allowed_client_events).toEqual(["session.close", "session.input_audio.mute", "session.input_audio.unmute"]);
    expect(pageSummary({ ...s, panels: {} })).toBe("- Nothing yet.");
  });

  test("an html panel is described by its summary, not its markup", () => {
    const s = newSession({ id: "s", templateId: "lingo", mode: "editor", mock: false, input: {}, title: "Lingo", harness: undefined });
    s.panels.game = { id: "game", kind: "html", title: "Lingo", status: "ready", data: { html: "<div>…</div>", state: {}, summary: "Round 2 of 10, 3 points" }, actions: [], order: 0, updatedAt: 0 };
    expect(pageSummary(s)).toBe("- Lingo: Round 2 of 10, 3 points");
  });

  test("history keeps the latest messages within the limits", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ seq: i, sessionId: "s", at: 0, origin: "agent", body: { type: "message", text: `m${i}` } }) as LogEvent);
    const h = history(many);
    expect(h).toHaveLength(16);
    expect(h.at(-1)!.content[0].text).toBe("m39");
  });
});

describe("control plane voice billing", () => {
  test("bills 15 seconds up front, then in 30-second steps, and the rest at the end", () => {
    expect(dueSeconds(0, 0, true)).toBe(15);
    expect(dueSeconds(20, 15, false)).toBe(0);
    expect(dueSeconds(50, 15, false)).toBe(35);
    expect(dueSeconds(61.5, 50, true)).toBe(11.5);
    expect(dueSeconds(10, 15, true)).toBe(0);
  });
});
