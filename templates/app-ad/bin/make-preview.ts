#!/usr/bin/env bun
// make-preview <ad.json> [--redo <scene-id>]...
//
// Everything between an approved script and the preview on the user's screen, in one command,
// because each separate step costs the agent a full re-read of its conversation:
//   1. generates the picture for any `still` scene that has a `prompt` and no `image`
//   2. voices every scene's `narration` (same voice throughout)
//   3. cuts the preview with `animatic`
//   4. writes build/check.jpg — one frame per scene, side by side, for the agent to look at
//   5. inside a session: fills the `stills` gallery, puts up the `preview` panel with the honest
//      price of animating on its button, and records what was spent
//
// ad.json:
//   { "voice_id": "English_Deep-VoicedGentleman", "speed": 1.05, "emotion": "calm",
//     "scenes": [
//       { "id": "s1", "kind": "still", "prompt": "<style bible + the picture>", "narration": "…" },
//       { "id": "s2", "kind": "screenshot", "image": "assets/shot-02.jpg", "narration": "…" },
//       { "id": "end", "kind": "endcard", "image": "assets/icon.jpg", "narration": "…", "title": "App", "subtitle": "4.8 ★ · Free on the App Store" } ] }
//
// Pictures and voices are kept per scene under a hash of what made them, so a re-run only pays
// for what changed. `--redo s1` makes a new take of that scene's picture from the same prompt.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { contactSheet, IN_SESSION, MOCK, run, SNAP, snap } from "../lib";

const IMAGE_USD = 0.01, VOICE_USD = 0.005, VIDEO_USD_PER_S = 0.08, VIDEO_MIN_S = 4;

const args = process.argv.slice(2);
const redo: string[] = [];
for (let i; (i = args.indexOf("--redo")) >= 0;) redo.push(args.splice(i, 2)[1]);
const specFile = args[0];
if (!specFile) { console.error("usage: make-preview <ad.json> [--redo <scene-id>]..."); process.exit(2); }

interface Scene { id: string; kind: "still" | "screenshot" | "endcard" | "clip"; image?: string; video?: string; prompt?: string; narration?: string; voice?: string; caption?: string; title?: string; subtitle?: string }
const spec = JSON.parse(readFileSync(specFile, "utf8")) as { size?: string; voice_id?: string; speed?: number; emotion?: string; scenes: Scene[] };
const hash = (v: unknown) => new Bun.CryptoHasher("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 10);
const fail = (msg: string): never => { console.error(`make-preview: ${msg}`); process.exit(1); };

// One paid generation → one file at `dest`. rep names its own downloads, so collect and move.
async function generate(model: string, input: unknown, dest: string) {
  const tmp = `${dest}.part`;
  const out = await run(["rep", "run", model, "--input-json", JSON.stringify(input), "-o", tmp, "--json", "--timeout", "300"], { quiet: true })
    .catch((e: Error) => fail(`${model} failed: ${e.message}`));
  const file = (JSON.parse(out).files ?? [])[0] ?? fail(`${model} returned no file`);
  renameSync(file, dest);
  await run(["rm", "-rf", tmp]);
}

const spent: { source: string; usd: number }[] = [];
await snap("progress", "Making the opening picture and recording the voice…");

await Promise.all(spec.scenes.map(async (sc) => {
  if (sc.kind === "still" && !sc.image) {
    if (!sc.prompt) fail(`scene ${sc.id}: a still needs "image" or "prompt"`);
    const dir = join("stills", sc.id), base = hash(sc.prompt);
    mkdirSync(dir, { recursive: true });
    const takes = readdirSync(dir).filter((f) => f.startsWith(base) && !f.endsWith(".part")).sort();
    if (!takes.length || redo.includes(sc.id)) {
      const file = join(dir, `${base}-${takes.length + 1}.${MOCK ? "png" : "jpg"}`);
      if (MOCK) await run([...SNAP, "mock", "image", "--text", sc.id, "-o", file, "--size", "1080x1920"]);
      else { await generate("minimax/image-01", { prompt: sc.prompt, aspect_ratio: "9:16", number_of_images: 1 }, file); spent.push({ source: `picture (${sc.id})`, usd: IMAGE_USD }); }
      takes.push(file.slice(dir.length + 1));
    }
    sc.image = join(dir, takes.at(-1)!);
  }
  if (sc.kind === "clip") { if (!sc.video || !existsSync(sc.video)) fail(`scene ${sc.id}: no such video ${sc.video}`); }
  else if (!sc.image || !existsSync(sc.image)) fail(`scene ${sc.id}: no such image ${sc.image}`);
  if (!sc.voice && sc.narration) {
    const input = { text: sc.narration, voice_id: spec.voice_id ?? "English_Deep-VoicedGentleman", speed: spec.speed ?? 1.05, emotion: spec.emotion ?? "auto" };
    const file = join("voice", sc.id, `${hash(input)}.mp3`);
    mkdirSync(join("voice", sc.id), { recursive: true });
    if (!existsSync(file)) {
      if (MOCK) await run([...SNAP, "mock", "audio", "-o", file, "--seconds", String(Math.max(1.5, sc.narration.split(/\s+/).length / 2.7).toFixed(1))]);
      else { await generate("minimax/speech-2.8-turbo", input, file); spent.push({ source: `voice (${sc.id})`, usd: VOICE_USD }); }
    }
    sc.voice = file;
  }
  if (sc.kind !== "endcard") sc.caption ??= sc.narration;
}));

await snap("progress", "Cutting the preview together…");
mkdirSync("build", { recursive: true });
await Bun.write(join("build", "animatic.json"), JSON.stringify(spec, null, 2));
const cut = JSON.parse(await run([process.execPath, join(import.meta.dir, "animatic.ts"), join("build", "animatic.json"), "--out", "preview.mp4"])) as
  { duration: number; scenes: { id: string; kind: string; scene: number }[] };

const frames: { file: string; label: string }[] = [];
for (const s of cut.scenes) {
  const file = join("build", `${s.id}.frame.jpg`);
  await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", (s.scene / 2).toFixed(2), "-i", join("build", `${s.id}.mp4`), "-frames:v", "1", "-q:v", "3", file]);
  frames.push({ file, label: `${s.id} · ${s.scene}s` });
}
const check = await contactSheet(frames, join("build", "check.jpg"), { cols: 6, cellW: 300, cellH: 533 });

// The paid step, priced from what it will actually generate: every scene except the end card and real footage.
const clips = cut.scenes.filter((s) => s.kind !== "endcard" && s.kind !== "clip").map((s) => ({ id: s.id, seconds: Math.max(VIDEO_MIN_S, Math.ceil(s.scene)) }));
const animateUsd = Math.ceil(clips.reduce((n, c) => n + c.seconds * VIDEO_USD_PER_S, 0) * 10 - 1e-9) / 10;

if (IN_SESSION) {
  const label: Record<string, string> = { still: "generated", screenshot: "real screenshot", endcard: "end card", clip: "real footage" };
  await Bun.write(join("build", "stills.panel.json"), JSON.stringify({ items: spec.scenes.map((sc) => ({ id: sc.id, caption: `${sc.id} — ${label[sc.kind]}` })) }));
  await snap("panel", "set", "stills", "--kind", "gallery", "--title", "Pictures", "--status", "approved", "--data", "@build/stills.panel.json");
  for (const sc of spec.scenes) await snap("asset", "put", sc.kind === "endcard" || sc.kind === "clip" ? join("build", `${sc.id}.frame.jpg`) : sc.image!, "--panel", "stills", "--slot", sc.id);
  await snap("panel", "set", "preview", "--kind", "video", "--title", "Preview", "--status", "ready",
    "--action", `animate:Animate it — about $${animateUsd.toFixed(2)}:primary`, "--action", "tweak:Change something");
  await snap("asset", "put", "preview.mp4", "--panel", "preview", "--slot", "video");
  for (const s of spent) await snap("cost", "add", "--source", s.source, "--usd", String(s.usd));
}

console.log(JSON.stringify({
  preview: "preview.mp4", duration: cut.duration, check,
  scenes: spec.scenes.map((sc) => ({ id: sc.id, image: sc.image, voice: sc.voice, seconds: cut.scenes.find((s) => s.id === sc.id)?.scene })),
  animate: { usd: animateUsd, clips },
  spentUsd: +spent.reduce((n, s) => n + s.usd, 0).toFixed(3),
  onPage: IN_SESSION ? "stills gallery, preview panel (with the animate button and its price) and costs are already up" : undefined,
}));
