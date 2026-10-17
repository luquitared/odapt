#!/usr/bin/env bun
// The session runner. One process drives one session and holds ONE conversation
// with an agent harness (src/harness.ts — Claude Code, Codex, …), so the agent keeps
// everything it has learned without any of it being re-passed.
//
// The runner owns waiting for the human. The agent never blocks: it ends its
// turn, and the user's next action arrives as the next user message. That is
// what lets a session survive idle-out, a restart, or an hour-long gap.
//
// Exit 0 = finished or parked cleanly (resumable). Exit 1 = failed.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_BALANCE_USD } from "./account";
import { HELP } from "./cli";
import { DATA_DIR, ROOT, selfCommand, shim } from "./config";
import { createHarness, resolveHarness, resumeId, storeId, type Harness, type Turn } from "./harness";
import type { ActionBody, EmitBody, LogEvent, Session } from "./protocol";
import { fill, loadTemplate, readTemplateFile, type Template } from "./templates";
import { linkTools, providerEnv, requiredTools, STRICT, SYSTEM_PATH } from "./tools";

const API = process.env.SNAP_API ?? "http://127.0.0.1:7788";
const TOKEN = process.env.SNAP_TOKEN ?? "dev";
const SID = process.argv[2] ?? process.env.SNAP_SESSION ?? "";
const IDLE_S = Number(process.env.SNAP_IDLE_TIMEOUT ?? 540);
const TURN_S = Number(process.env.SNAP_TURN_TIMEOUT ?? 1800);

if (!SID) { console.error("usage: runner <session-id>"); process.exit(1); }
const log = (...a: unknown[]) => console.log(new Date().toISOString(), `[${SID}]`, ...a);

// ---------------------------------------------------------------- api

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/api/sessions/${SID}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
// On a user's credit, whether they've run out (the proxy then refuses every paid call).
async function outOfCredit(): Promise<boolean> {
  const url = process.env.SNAP_CONTROL_URL, t = process.env.SNAP_CONTROL_TOKEN;
  if (!url || !t) return false;
  const me = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json(), () => null) as { balance_usd?: number } | null;
  return typeof me?.balance_usd === "number" && me.balance_usd < MIN_BALANCE_USD;
}
const OUT_OF_CREDIT = "You're out of credit. Add some at the top of the page, then send a message to pick up where this stopped.";

const emit = (b: EmitBody) => api("POST", "/emit", b).catch((e) => log("emit failed:", e.message));
const getSession = () => api<Session>("GET", "");

// ---------------------------------------------------------------- workspace

function prepareWorkspace(session: Session, template: Template) {
  const templateDir = template.dir;
  const work = join(DATA_DIR, "workspaces", SID);
  const fresh = !existsSync(work);
  mkdirSync(join(work, ".bin"), { recursive: true });
  if (fresh && existsSync(join(templateDir, "workspace"))) cpSync(join(templateDir, "workspace"), work, { recursive: true });
  // Rewritten every start: the repo may have moved since the session was parked.
  const snap = join(work, ".bin", "snap");
  writeFileSync(snap, shim(selfCommand("cli"), false));
  chmodSync(snap, 0o755);
  // Every script in the template's bin/ becomes a command. They run from the repo, not
  // from a copy, so a fix reaches sessions that already exist and imports resolve here.
  const bin = join(templateDir, "bin");
  if (existsSync(bin)) for (const f of readdirSync(bin).filter((f) => f.endsWith(".ts"))) {
    const cmd = join(work, ".bin", f.replace(/\.ts$/, ""));
    writeFileSync(cmd, shim([process.execPath, join(bin, f)], true));
    chmodSync(cmd, 0o755);
  }
  linkTools(template, join(work, ".bin"), log);
  writeFileSync(join(work, "input.json"), JSON.stringify(session.input, null, 2));
  return work;
}

function systemPrompt(session: Session, tools: string[], templateSystem: string, work: string, voice: boolean, html: boolean) {
  const parts = [readFileSync(join(ROOT, "prompts/system.md"), "utf8"), "## `snap` reference\n\n```\n" + HELP + "```"];
  for (const t of tools) {
    const ref = join(ROOT, "tools", t, "doc.md");
    if (existsSync(ref)) parts.push(readFileSync(ref, "utf8"));
    else log(`no reference doc for tool "${t}"`);
  }
  parts.push(
    `## This session\n\n- Mode: **${session.mode}** — ${session.mode === "job"
      ? "nobody may be watching. Make reasonable decisions yourself instead of asking; still report progress, because someone may tune in and everything you emit is stored."
      : "the user is here, working with you live. Show your work early, ask when a choice is really theirs, and keep each turn short."}\n` +
    `- Working directory: \`${work}\` — it persists for the life of the session. Every Bash call starts here; use absolute paths or \`cd\` inside the same command.\n` +
    (process.env.SNAP_CONTROL_URL ? "- Paid calls are billed to the user's credit. If a command fails with \"out of credits\", stop: tell the user with `snap say` that they need to add credit, and end your turn.\n" : "") +
    (session.mock ? "- **MOCK MODE: do not spend money.** No paid generation (no `rep run`, no `vidwatch watch`). Make stand-ins with `snap mock image|video|audio` and carry on as if they were real.\n" : ""),
  );
  if (voice) parts.push(readFileSync(join(ROOT, "prompts/voice-agent.md"), "utf8"));
  if (html) parts.push(readFileSync(join(ROOT, "prompts/html-panels.md"), "utf8"));
  if (templateSystem) parts.push(templateSystem);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- actions

function describe(a: ActionBody): string {
  const payload = a.payload === undefined ? "" : ` ${typeof a.payload === "string" ? JSON.stringify(a.payload) : JSON.stringify(a.payload)}`;
  switch (a.type) {
    // A typed message invites a typed reply; without the nudge the agent answers in
    // its closing text, which only reaches the user through the fallback.
    case "message": return `The user says: ${typeof a.payload === "string" ? a.payload : JSON.stringify(a.payload)}\n(Answer with \`snap say\` — they can't see anything else you write.)`;
    case "voice": {
      const v = (a.payload ?? {}) as { said?: string; before?: string; checkpoint?: boolean };
      // A checkpoint (src/voice.ts) isn't a request: the conversation goes on without waiting for you.
      if (v.checkpoint) return `Checkpoint: on the call, the user has said this since you last heard from them (they didn't ask you anything): "${v.said}"` +
        (v.before ? `\n(The voice's last line: "${v.before}")` : "") +
        "\n(Do what this app does at a checkpoint. Use `snap say` only if it says to: the voice reads it out over the conversation.)";
      return `The user said, by voice: "${v.said || "(nothing was transcribed)"}"` +
        (v.before ? `\n(Just before, the voice had said: "${v.before}")` : "") +
        "\n(Answer with `snap say`, short and speakable: the voice reads it out to them.)";
    }
    case "answer": return `The user answered your question "${a.ask}":${payload}`;
    case "edit": return `The user edited panel "${a.panel}" (already merged into its data — read it with \`snap panel get ${a.panel}\`):${payload}`;
    case "approve": return `The user approved panel "${a.panel}".${payload ? ` Payload:${payload}` : ""}`;
    default: return `The user pressed "${a.type}"${a.panel ? ` on panel "${a.panel}"` : ""}.${payload ? ` Payload:${payload}` : ""}`;
  }
}

let lastActivity = Date.now();
let agentBusy = () => false;

async function nextActions(cursor: number): Promise<LogEvent[]> {
  lastActivity = Date.now();
  while (agentBusy() || Date.now() < lastActivity + IDLE_S * 1000) {
    const wait = Math.max(1, Math.min(25, Math.ceil((lastActivity + IDLE_S * 1000 - Date.now()) / 1000)));
    const got = await api<LogEvent[]>("GET", `/actions?after=${cursor}&wait=${wait}`).catch(() => []);
    if (got.length) return got;
  }
  return [];
}

// ---------------------------------------------------------------- main

async function main() {
  mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
  let session = await getSession();
  const template = loadTemplate(session.templateId);
  if (!template) throw new Error(`unknown template ${session.templateId}`);

  const work = prepareWorkspace(session, template);
  const system = systemPrompt(session, template.tools, readTemplateFile(template, "system.md"), work, !!template.voice, !!template.ui?.html);
  let cursor = session.actionCursor;
  const resuming = !!session.claudeSessionId;
  let wakePrefix = resuming;

  const beat = setInterval(() => api("POST", "/heartbeat").catch(() => {}), 15_000);
  if (session.mock) process.env.SNAP_MOCK = "1"; // template commands read it; the agent's env inherits ours
  const { name: harnessName, config } = resolveHarness(process.env.SNAP_HARNESS, session.harness, template.harness);
  // The template's model and tool list are Claude's; another harness brings its own model.
  const model = process.env.SNAP_MODEL ?? config.model ?? (config.type === "claude" ? template.model : undefined);
  const costSource = config.type === "claude" ? "claude" : `${harnessName}${model ? ` (${model})` : ""}`;
  log(`harness: ${harnessName}${model ? `, model ${model}` : ""}`);
  // The harness itself is the runtime's, not a template tool: find it before strict mode hides PATH.
  if (STRICT) {
    process.env.SNAP_CODEX_BIN ??= Bun.which("codex") ?? undefined;
    process.env.SNAP_CLAUDE_BIN ??= Bun.which("claude") ?? undefined;
  }
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${join(work, ".bin")}:${STRICT ? SYSTEM_PATH : process.env.PATH}`, SNAP_API: API, SNAP_TOKEN: TOKEN, SNAP_SESSION: SID };
  // On a user's credit (SNAP_CONTROL_URL), paid tools go through the metered proxy and no provider key stays in reach.
  for (const [k, v] of Object.entries(providerEnv(requiredTools(template), template.id, process.env.SNAP_CONTROL_URL, process.env.SNAP_CONTROL_TOKEN, log))) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
  const open = (resume: string | null) => createHarness({
    sid: SID, app: template.id, work, system, resume,
    config: { ...config, model, tools: config.tools ?? template.agentTools },
    env,
    transcript: join(DATA_DIR, "logs", `${SID}.${config.type}.jsonl`),
    turnTimeoutS: TURN_S, log,
    onCost: (usd) => void emit({ type: "cost", source: costSource, usd }),
  });
  const resumeFrom = resumeId(config.type, session.claudeSessionId);
  // Switched harness mid-session: the new one has never seen this conversation.
  let lost = resuming && !resumeFrom;
  let conv = await open(resumeFrom);
  conv.start();
  await emit({ type: "runner", state: "running", pid: process.pid });

  const park = async (why: string) => {
    log("parking:", why);
    clearInterval(beat);
    conv.stop();
    await emit({ type: "runner", state: "parked", claudeSessionId: storeId(config.type, conv.sessionId), actionCursor: cursor });
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => { await park(sig); process.exit(0); });

  // A finished background task wakes the agent without any message from us. Without this
  // the session read "your move" while it was busy, and the idle timer could park it mid-work.
  const watchSelfTurns = (c: Harness) => {
    agentBusy = () => c.selfTurn;
    c.onSelfTurn = async (phase) => {
      lastActivity = Date.now();
      if (phase === "start") return void emit({ type: "status", status: "working" });
      session = await getSession();
      if (session.status !== "done") await emit({ type: "status", status: "waiting" });
    };
  };
  watchSelfTurns(conv);

  const runTurn = async (text: string) => {
    const turnStart = ((await api<{ seq: number }>("POST", "/emit", { type: "status", status: "working" }).catch(() => null))?.seq) ?? 0;
    let turn: Turn;
    const RESTORE = "(Your earlier conversation could not be restored. Read the current state with `snap session get` and continue from it.)\n\n";
    try {
      turn = await conv.send((lost ? RESTORE : "") + text);
      lost = false;
    } catch (err) {
      // A stale transcript shouldn't be fatal — start the conversation over once.
      if (!conv.exited || !resuming || conv.sessionId) throw err;
      log("resume failed, starting fresh");
      conv = await open(null);
      watchSelfTurns(conv);
      conv.start();
      turn = await conv.send(RESTORE + text);
    }
    await emit({ type: "runner", state: "running", claudeSessionId: storeId(config.type, conv.sessionId), actionCursor: cursor });
    if (turn.isError) throw new Error(`agent turn failed: ${turn.text.slice(0, 300)}`);
    // `snap` is the one channel to the user; the agent is told its closing text goes
    // unread. It used to be posted as well, and the agent — reasonably — said things
    // once with `snap say` and again as it signed off. Now it is only a fallback for
    // a turn that showed the user nothing at all.
    const VISIBLE = ["message", "ask", "done", "panel.set", "panel.patch", "asset"];
    const shown = (await api<LogEvent[]>("GET", `/log?after=${turnStart}`).catch(() => []))
      .some((e) => e.origin === "agent" && VISIBLE.includes(e.body.type));
    if (turn.text.trim() && !shown) {
      log("turn ended with nothing shown to the user; posting closing text as fallback");
      await emit({ type: "message", text: turn.text.trim() });
    }
    if (await outOfCredit()) await emit({ type: "progress", kind: "error", text: OUT_OF_CREDIT });
    session = await getSession();
    if (session.status !== "done") await emit({ type: "status", status: "waiting" });
  };

  try {
    if (!resuming) {
      const kickoff = readTemplateFile(template, "kickoff.md") || "Begin. The user's input:\n\n{{input}}";
      await runTurn(fill(kickoff, { input: session.input, mode: session.mode }));
    }
    for (;;) {
      if (session.status === "done" && session.mode === "job") break;
      const actions = await nextActions(cursor);
      if (!actions.length) {
        if (session.status !== "done") {
          await emit({ type: "progress", kind: "info", text: "Paused while you're away — this picks up right where it left off." });
          await emit({ type: "status", status: "idle" });
        }
        break;
      }
      cursor = actions.at(-1)!.seq; // advance before the turn: an action is delivered at most once
      // Hand the agent the panel as the user left it. Telling it to "read the panel back"
      // wasn't enough: it kept building from its own stale copy of the script.
      const now = await getSession();
      const lines = actions.map((e) => {
        const a = (e.body as { action: ActionBody }).action;
        const panel = a.panel && a.type !== "answer" ? now.panels[a.panel] : null;
        if (!panel) return describe(a);
        const { assets, ...data } = (panel.data ?? {}) as Record<string, unknown>;
        return `${describe(a)}\nThat panel as the user left it (their edits included — this replaces any copy you hold):\n${JSON.stringify(data)}`;
      });
      await runTurn((wakePrefix ? "(You were paused while the user was away. They're back.)\n\n" : "") + lines.join("\n"));
      wakePrefix = false;
    }
    await park(session.status === "done" ? "done" : "idle");
    process.exit(0);
  } catch (err) {
    log("fatal:", err);
    await emit({ type: "progress", kind: "error", text: (await outOfCredit()) ? OUT_OF_CREDIT : "Something went wrong on our side. Send a message to try again." });
    await emit({ type: "status", status: "failed", reason: String(err) });
    await park("failed");
    process.exit(1);
  }
}

main().catch(async (err) => {
  log("startup failed:", err);
  await emit({ type: "status", status: "failed", reason: String(err) });
  process.exit(1);
});
