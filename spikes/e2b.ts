#!/usr/bin/env bun
// E2B spike — does pause/resume hold up well enough to carry editor sessions?
// E2B spike. Needs E2B_API_KEY in .env.
//
//   bun spikes/e2b.ts cycles [--n 20] [--gb 1] [--gap 0]   pause/resume correctness on the base image
//   bun spikes/e2b.ts build                                 build our template (bun, ffmpeg, claude, rep)
//   bun spikes/e2b.ts claude                                one Claude conversation across a pause (needs ANTHROPIC_API_KEY)
//   bun spikes/e2b.ts resume <sandboxId>                    re-check a sandbox left paused by `cycles --keep` (the overnight gap)
//
// `cycles` answers three questions per cycle:
//   1. Did every file survive, byte for byte?            (E2B issue #884: changes lost after a second resume)
//   2. Did a process that was running keep running?      (memory snapshot, i.e. no `claude --resume` needed)
//   3. Does an outbound long-poll loop recover by itself? (sockets are dead after resume)

import { Sandbox, Template } from "e2b";

const TEMPLATE = "snappy-runner";
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string, d: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? "true" : d; };
const ms = (t: number) => `${(performance.now() - t).toFixed(0)}ms`;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set. Create a key at https://e2b.dev/dashboard and add it to .env");
  process.exit(2);
}

// A stand-in for the runner: counts in memory, appends to a file, and makes an
// outbound HTTPS call every 2s. If memory survives a pause the counter keeps
// climbing from where it was; if only disk survives it restarts from 0.
const HEARTBEAT = `
let n = 0, ok = 0, fail = 0;
const fs = require("fs");
setInterval(async () => {
  n++;
  try { const r = await fetch("https://api.anthropic.com/", { signal: AbortSignal.timeout(4000) }); ok++; void r.status; }
  catch { fail++; }
  fs.writeFileSync("/home/user/beat.json", JSON.stringify({ pid: process.pid, n, ok, fail, at: Date.now() }));
}, 2000);
`;

async function sh(sbx: Sandbox, command: string, timeoutMs = 600_000) {
  const r = await sbx.commands.run(command, { timeoutMs });
  if (r.exitCode !== 0) throw new Error(`${command}\n${r.stderr}`);
  return r.stdout.trim();
}
const beat = async (sbx: Sandbox) => JSON.parse(await sh(sbx, "cat /home/user/beat.json")) as { pid: number; n: number; ok: number; fail: number; at: number };

async function checkFiles(sbx: Sandbox, expected: string) {
  const now = await sh(sbx, "cd /home/user/data && sha256sum * | sha256sum | cut -d' ' -f1");
  return { same: now === expected, now };
}

async function cycles() {
  const n = Number(flag("n", "20")), gb = Number(flag("gb", "1")), gap = Number(flag("gap", "0")), keep = rest.includes("--keep");
  let t = performance.now();
  const sbx = await Sandbox.create({ timeoutMs: 30 * 60_000, lifecycle: { onTimeout: "pause" } });
  console.log(`created ${sbx.sandboxId} in ${ms(t)}`);

  // ~gb GiB of incompressible files, in the sizes a video session actually has.
  t = performance.now();
  await sh(sbx, `mkdir -p /home/user/data && cd /home/user/data && for i in $(seq 1 ${Math.max(1, Math.round(gb * 8))}); do head -c 128M /dev/urandom > blob$i.bin; done`);
  let sum = (await checkFiles(sbx, "")).now;
  console.log(`wrote ${gb} GiB in ${ms(t)}; checksum ${sum.slice(0, 12)}`);

  await sbx.files.write("/home/user/heartbeat.js", HEARTBEAT);
  await sbx.commands.run("node /home/user/heartbeat.js", { background: true, timeoutMs: 0 });
  await Bun.sleep(5000);
  let last = await beat(sbx);
  console.log(`heartbeat pid ${last.pid}, n=${last.n}`);

  const pauseMs: number[] = [], resumeMs: number[] = [];
  let filesLost = 0, memoryLost = 0, pollStuck = 0;

  for (let i = 1; i <= n; i++) {
    // Change a file every cycle — #884 is about changes made *between* resumes.
    await sh(sbx, `echo "cycle ${i} $(date +%s%N)" >> /home/user/data/journal.txt`);
    sum = (await checkFiles(sbx, "")).now;

    t = performance.now();
    await Sandbox.pause(sbx.sandboxId);
    pauseMs.push(performance.now() - t);
    if (gap) await Bun.sleep(gap * 1000);

    t = performance.now();
    await sbx.connect({ timeoutMs: 30 * 60_000 });
    resumeMs.push(performance.now() - t);

    const files = await checkFiles(sbx, sum);
    await Bun.sleep(6500); // three heartbeat ticks
    const now = await beat(sbx);
    const sameProcess = now.pid === last.pid && now.n > last.n;
    const polling = now.ok > last.ok;
    if (!files.same) filesLost++;
    if (!sameProcess) memoryLost++;
    if (!polling) pollStuck++;
    console.log(`cycle ${String(i).padStart(2)}: pause ${pauseMs.at(-1)!.toFixed(0)}ms resume ${resumeMs.at(-1)!.toFixed(0)}ms | files ${files.same ? "ok" : "CHANGED"} | process ${sameProcess ? `alive n=${now.n}` : "RESTARTED/DEAD"} | outbound ${polling ? "ok" : "STUCK"} (fails ${now.fail})`);
    last = now;
  }

  console.log(JSON.stringify({
    cycles: n, gib: gb,
    pause: { p50: Math.round(pct(pauseMs, 50)), p95: Math.round(pct(pauseMs, 95)) },
    resume: { p50: Math.round(pct(resumeMs, 50)), p95: Math.round(pct(resumeMs, 95)) },
    filesLost, memoryLost, pollStuck,
    verdict: filesLost + memoryLost + pollStuck === 0 ? "PASS" : "FAIL",
  }, null, 2));

  if (keep) {
    await Sandbox.pause(sbx.sandboxId);
    console.log(`left paused for the overnight check:\n  bun spikes/e2b.ts resume ${sbx.sandboxId} --sum ${sum} --pid ${last.pid} --n ${last.n}`);
  } else await sbx.kill();
}

async function resume() {
  const id = rest[0];
  const t = performance.now();
  const sbx = await Sandbox.connect(id, { timeoutMs: 10 * 60_000 });
  console.log(`resumed in ${ms(t)}`);
  const files = await checkFiles(sbx, flag("sum", ""));
  await Bun.sleep(6500);
  const now = await beat(sbx);
  console.log({ files: files.same ? "ok" : "CHANGED", sameProcess: String(now.pid) === flag("pid", ""), counter: `${flag("n", "?")} → ${now.n}`, outboundOk: now.ok, outboundFail: now.fail });
  await sbx.kill();
}

async function build() {
  const t = performance.now();
  const template = Template()
    .fromImage("node:22-bookworm-slim")
    .runCmd("apt-get update && apt-get install -y --no-install-recommends ffmpeg git curl ca-certificates unzip jq && rm -rf /var/lib/apt/lists/*", { user: "root" })
    .runCmd("npm install -g @anthropic-ai/claude-code bun", { user: "root" })
    // dist/rep.js is committed in the repo, so a clone + symlink is all an install is.
    .runCmd("git clone --depth 1 https://github.com/luquitared/replicate-cli /opt/rep && chmod +x /opt/rep/dist/rep.js && ln -s /opt/rep/dist/rep.js /usr/local/bin/rep", { user: "root" });
  const info = await Template.build(template, TEMPLATE, { cpuCount: 2, memoryMB: 2048, onBuildLogs: (l: { message: string }) => console.log("  ", l.message) } as never);
  console.log(`built ${TEMPLATE} in ${ms(t)}`, info);
}

// One stream-json conversation, a pause in the middle of it, and a second turn
// afterwards that can only be answered from the first. No --resume anywhere.
async function claude() {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is not set (a subscription login can't be used inside a sandbox)"); process.exit(2); }
  let t = performance.now();
  const sbx = await Sandbox.create(TEMPLATE, {
    timeoutMs: 20 * 60_000, lifecycle: { onTimeout: "pause" },
    envs: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    network: { allowOut: ["api.anthropic.com", "api.replicate.com", "replicate.delivery"], denyOut: ["0.0.0.0/0"] } as never,
  });
  console.log(`created ${sbx.sandboxId} in ${ms(t)}`);

  const say = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  await sh(sbx, "mkdir -p /home/user/w && mkfifo /home/user/w/in && touch /home/user/w/out.jsonl");
  // Hold the fifo open read-write so claude never sees EOF between turns.
  await sbx.commands.run(
    `cd /home/user/w && exec 3<>in && claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --allowedTools Bash,Read,Write <&3 >out.jsonl 2>err.log`,
    { background: true, timeoutMs: 0 },
  );
  const results = async () => Number(await sh(sbx, `grep -c '"type":"result"' /home/user/w/out.jsonl || true`));
  const turn = async (text: string) => {
    const before = await results();
    const t0 = performance.now();
    await sbx.files.write("/home/user/w/msg.json", say(text) + "\n");
    await sh(sbx, "cat /home/user/w/msg.json > /home/user/w/in");
    while ((await results()) <= before) {
      if (performance.now() - t0 > 180_000) throw new Error(`turn timed out\n${await sh(sbx, "tail -c 800 /home/user/w/err.log /home/user/w/out.jsonl")}`);
      await Bun.sleep(1500);
    }
    const last = await sh(sbx, `grep '"type":"result"' /home/user/w/out.jsonl | tail -1 | jq -r .result`);
    console.log(`  turn took ${ms(t0)}: ${last.slice(0, 160)}`);
    return last;
  };

  t = performance.now();
  await turn("Pick a random 4-digit number, write it to secret.txt in the current directory, and tell me only that you have done it — do not reveal the number.");
  console.log(`create → first result: ${ms(t)}`);
  const secret = await sh(sbx, "cat /home/user/w/secret.txt");

  t = performance.now();
  await Sandbox.pause(sbx.sandboxId);
  console.log(`paused in ${ms(t)}; waiting 60s`);
  await Bun.sleep(60_000);
  t = performance.now();
  await sbx.connect({ timeoutMs: 20 * 60_000 });
  console.log(`resumed in ${ms(t)}`);

  const answer = await turn("Without reading any file: what number did you pick earlier?");
  const blocked = await sbx.commands.run("curl -sS -m 6 -o /dev/null -w '%{http_code}' https://example.com", { timeoutMs: 15_000 }).then((r) => r.stdout, (e) => `blocked (${String(e).slice(0, 60)})`);
  console.log(JSON.stringify({
    rememberedAcrossPause: answer.includes(secret.trim()), secret: secret.trim(),
    egressToExampleCom: blocked, verdict: answer.includes(secret.trim()) ? "PASS" : "FAIL",
  }, null, 2));
  await sbx.kill();
}

const run = { cycles, build, claude, resume }[cmd as "cycles"];
if (!run) { console.error("usage: bun spikes/e2b.ts cycles|build|claude|resume"); process.exit(2); }
await run();
