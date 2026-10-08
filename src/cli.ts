#!/usr/bin/env bun
// `snap` — the only way the agent reaches the user. Every command is one
// outbound HTTP call to the API; it never listens and never blocks on a human.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

const API = process.env.SNAP_API ?? "http://127.0.0.1:7788";
const TOKEN = process.env.SNAP_TOKEN ?? "dev";
const SESSION = process.env.SNAP_SESSION ?? "";

export const HELP = `snap — talk to the user. Output is always JSON on stdout.

  snap progress "<text>" [--kind progress|info|error]   one line in the live feed
  snap say "<text>"                                     a chat message (markdown ok)
  snap panel set <id> --kind <kind> --title "<t>" [--status working|ready|approved|failed]
                      [--data @file.json | --data '<json>'] [--action id:Label[:primary|danger]]...
  snap panel patch <id> --json '<json>' [--status <s>]  shallow-merge into the panel's data
  snap panel get <id>                                   read a panel back (includes user edits)
  snap panel remove <id>
  snap ask --id <key> --text "<question>" [--kind choice|text|confirm] [--option id:Label]...
  snap asset put <file> [--panel <id>] [--slot <name>]  upload a file; prints its url
  snap navigate <panel-id>                              bring a panel into view
  snap toast "<text>"
  snap voice "<instruction>"                            on a voice call: tell the voice what to say or do next
  snap title "<text>"                                   name this session
  snap cost add --source <name> --usd <n>
  snap done --summary "<text>" [--asset <url>]...       mark the session finished
  snap session get                                      full current state
  snap mock image --text "<label>" -o <file.png> [--size 1280x720]
  snap mock video --text "<label>" -o <file.mp4> [--seconds 5] [--size 1280x720]
  snap mock audio -o <file.mp3> [--seconds 5]

Panel kinds the UI knows how to draw (anything else renders as JSON):
  markdown  {"markdown": "..."}
  form      {"fields": [{"id","label","type":"text|textarea|select","value","options":[]}]}   users can edit values; read them back with panel get
  script    {"scenes": [{"id","narration","visual", ...}]}   narration/visual are editable
  gallery   {"items": [{"id","url","caption"}]}   or attach with: snap asset put f.png --panel <id> --slot <item-id>
  video     {"url": "...", "caption": "..."}       or: snap asset put out.mp4 --panel <id> --slot video
`;

function die(msg: string): never {
  console.error(`snap: ${msg}`);
  process.exit(2);
}

// --flag value, repeatable flags collect into arrays; everything else is positional.
function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") || a === "-o") {
      const k = a === "-o" ? "out" : a.slice(2);
      const v = argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? "true" : argv[++i];
      (flags[k] ??= []).push(v);
    } else pos.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  return { pos, flags, one };
}

function jsonArg(v: string | undefined, what: string): unknown {
  if (v === undefined) return undefined;
  const raw = v.startsWith("@") ? (existsSync(v.slice(1)) ? readFileSync(v.slice(1), "utf8") : die(`${what}: no such file ${v.slice(1)}`)) : v;
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${what} is not valid JSON: ${(e as Error).message}`);
  }
}

async function api(method: string, path: string, body?: unknown, raw?: BodyInit) {
  if (!SESSION) die("SNAP_SESSION is not set — this command only works inside a session");
  const res = await fetch(`${API}/api/sessions/${SESSION}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(raw ? {} : { "content-type": "application/json" }) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  }).catch((e) => die(`cannot reach ${API}: ${e.message}`));
  const out = await res.json().catch(() => ({}));
  if (!res.ok) die(`${method} ${path} → ${res.status} ${JSON.stringify(out)}`);
  return out as any;
}

const emit = (body: unknown) => api("POST", "/emit", body);
const print = (v: unknown) => console.log(JSON.stringify(v));

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown",
};

async function ffmpeg(args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-y", "-loglevel", "error", ...args], { stderr: "pipe" });
  if ((await p.exited) !== 0) die(`ffmpeg failed: ${await new Response(p.stderr).text()}`);
}

async function mock(kind: string, a: ReturnType<typeof parse>) {
  const out = a.one("out") ?? die("mock: -o <file> required");
  const size = a.one("size") ?? "1280x720";
  const secs = a.one("seconds") ?? "5";
  const label = (a.one("text") ?? "mock").replace(/[':\\%]/g, " ").slice(0, 60);
  const hue = [...label].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const color = `0x${[0, 120, 240].map((o) => Math.round(90 + 60 * Math.sin(((hue + o) * Math.PI) / 180)).toString(16).padStart(2, "0")).join("")}`;
  // Not every ffmpeg build ships drawtext (Homebrew's doesn't); a plain card is fine then.
  const filters = await new Response(Bun.spawn(["ffmpeg", "-hide_banner", "-filters"], { stderr: "ignore" }).stdout).text();
  const text = /\bdrawtext\b/.test(filters) ? `drawtext=text='${label}':fontcolor=white:fontsize=h/14:x=(w-text_w)/2:y=(h-text_h)/2` : "null";
  const src = (d?: string) => ["-f", "lavfi", "-i", `color=c=${color}:s=${size}${d ? `:d=${d}` : ""}`];
  if (kind === "image") await ffmpeg([...src(), "-vf", text, "-frames:v", "1", out]);
  else if (kind === "video") await ffmpeg([...src(secs), "-vf", text, "-pix_fmt", "yuv420p", "-r", "24", out]);
  else if (kind === "audio") await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=220:duration=${secs}`, "-af", "volume=0.1", out]);
  else die(`mock: unknown kind ${kind}`);
  print({ ok: true, file: out, mock: true });
}

// html panels (prompts/html-panels.md): --html takes a file (or literal markup), --state JSON, --summary text.
function htmlFlags(a: ReturnType<typeof parse>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const h = a.one("html");
  if (h !== undefined) out.html = h.trimStart().startsWith("<") ? h : existsSync(h) ? readFileSync(h, "utf8") : die(`--html: no such file ${h}`);
  if (a.one("state") !== undefined) out.state = jsonArg(a.one("state"), "--state");
  if (a.one("summary") !== undefined) out.summary = a.one("summary");
  return out;
}

export async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parse(rest);
  switch (cmd) {
    case undefined: case "help": case "--help": case "-h":
      return console.log(HELP);
    case "progress":
      return print(await emit({ type: "progress", text: a.pos[0] ?? die("text required"), kind: a.one("kind") ?? "progress" }));
    case "say":
      return print(await emit({ type: "message", text: a.pos[0] ?? die("text required") }));
    case "toast":
      return print(await emit({ type: "toast", text: a.pos[0] ?? die("text required") }));
    case "voice":
      return print(await emit({ type: "voice.instruct", text: a.pos[0] ?? die("text required") }));
    case "title":
      return print(await emit({ type: "title", title: a.pos[0] ?? die("text required") }));
    case "navigate":
      return print(await emit({ type: "navigate", panel: a.pos[0] ?? die("panel id required") }));
    case "panel": {
      const [sub, id] = a.pos;
      if (!id) die("panel id required");
      if (sub === "set") {
        const actions = (a.flags.action ?? []).map((s) => {
          const [aid, label, style] = s.split(":");
          return { id: aid, label: label ?? aid, style: style ?? "default" };
        });
        const panel: Record<string, unknown> = { id };
        for (const k of ["kind", "title", "status"]) if (a.one(k)) panel[k] = a.one(k);
        if (a.one("data") !== undefined) panel.data = jsonArg(a.one("data"), "--data");
        const html = htmlFlags(a);
        if (Object.keys(html).length) panel.data = { ...((panel.data as object) ?? {}), ...html };
        if (a.flags.action) panel.actions = actions;
        return print(await emit({ type: "panel.set", panel }));
      }
      if (sub === "patch") {
        const data = { ...((jsonArg(a.one("json"), "--json") as object) ?? {}), ...htmlFlags(a) };
        if (!Object.keys(data).length && !a.one("status")) die("--json, --html, --state or --summary required");
        return print(await emit({ type: "panel.patch", id, data, status: a.one("status") }));
      }
      if (sub === "remove") return print(await emit({ type: "panel.remove", id }));
      if (sub === "get") return print((await api("GET", "")).panels[id] ?? die(`no panel ${id}`));
      return die(`panel: unknown subcommand ${sub}`);
    }
    case "ask": {
      const options = (a.flags.option ?? []).map((s) => ({ id: s.split(":")[0], label: s.split(":").slice(1).join(":") || s }));
      const kind = a.one("kind") ?? (options.length ? "choice" : "text");
      return print(await emit({ type: "ask", ask: { id: a.one("id") ?? die("--id required"), text: a.one("text") ?? die("--text required"), kind, options } }));
    }
    case "asset": {
      if (a.pos[0] !== "put") die("usage: snap asset put <file>");
      const file = a.pos[1] ?? die("file required");
      if (!existsSync(file) || !statSync(file).isFile()) die(`no such file: ${file}`);
      const name = `${Date.now().toString(36)}-${basename(file)}`;
      const up = await api("PUT", `/assets/${encodeURIComponent(name)}`, undefined, Bun.file(file));
      const mime = MIME[extname(file).toLowerCase()];
      await emit({ type: "asset", url: up.url, name: basename(file), panel: a.one("panel"), slot: a.one("slot"), mime });
      return print({ url: up.url, mime });
    }
    case "cost":
      return print(await emit({ type: "cost", source: a.one("source") ?? die("--source required"), usd: Number(a.one("usd") ?? die("--usd required")) }));
    case "done":
      return print(await emit({ type: "done", summary: a.one("summary") ?? a.pos[0] ?? "Done.", assets: a.flags.asset ?? [] }));
    case "session":
      return print(await api("GET", ""));
    case "mock":
      return mock(a.pos[0], a);
    default:
      die(`unknown command "${cmd}". Run: snap help`);
  }
}

if (import.meta.main) main();
