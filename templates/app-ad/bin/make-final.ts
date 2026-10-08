#!/usr/bin/env bun
// make-final <ad.json> [--only <scene-id>]...
//
// The paid step, in one command: animates every scene except the end card from its caption-free
// preview frame (build/<id>.clean.jpg, so screenshot scenes keep their card layout), waits for
// the clips, lays the sharp caption and the scene's own audio over each, and cuts final.mp4.
// A scene whose clip fails — the video model's content filter refuses some screenshots — keeps
// its preview version, and the output says which. Nothing is retried; failed clips cost nothing.
//
// Needs `make-preview` to have run on the same ad.json. Each scene's `motion` is its prompt.
// Clips are kept per scene under a hash of what made them; `--only s2` limits which scenes may
// generate (the rest reuse what exists, or fall back to the preview).
// Inside a session it sends progress lines, puts up the `final` panel and records the cost.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { contactSheet, IN_SESSION, MOCK, run, snap } from "../lib";

const VIDEO_USD_PER_S = 0.08, VIDEO_MIN_S = 4, W = 1080, H = 1920;
const SCREEN_MOTION = "the phone screen content scrolls gently, soft light sweeps across, camera drifts in slowly; layout, text and colours stay exactly as in the image";

const args = process.argv.slice(2);
const only: string[] = [];
for (let i; (i = args.indexOf("--only")) >= 0;) only.push(args.splice(i, 2)[1]);
const specFile = args[0];
if (!specFile) { console.error("usage: make-final <ad.json> [--only <scene-id>]..."); process.exit(2); }
const fail = (msg: string): never => { console.error(`make-final: ${msg}`); process.exit(1); };
if (MOCK) fail("mock mode never animates — stop at the preview");

interface Scene { id: string; kind: "still" | "screenshot" | "endcard" | "clip"; motion?: string }
const spec = JSON.parse(readFileSync(specFile, "utf8")) as { scenes: Scene[] };
const hash = (v: unknown) => new Bun.CryptoHasher("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 10);
const duration = async (f: string) => Number(await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));

const spent: { source: string; usd: number }[] = [];
const kept: { id: string; why: string }[] = [];
let pending = 0;
const ticker = setInterval(() => pending && snap("progress", pending > 1 ? `Still animating — ${pending} shots to go…` : "Still animating — the last shot is nearly there…").catch(() => {}), 30_000);
await snap("progress", "Bringing the shots to life — this takes a few minutes…");

const parts = await Promise.all(spec.scenes.map(async (sc) => {
  const preview = join("build", `${sc.id}.mp4`);
  if (!existsSync(preview)) fail(`no ${preview} — run make-preview first`);
  if (sc.kind === "endcard" || sc.kind === "clip") return preview; // already real motion
  const D = await duration(preview), seconds = Math.max(VIDEO_MIN_S, Math.ceil(D));
  const frame = join("build", `${sc.id}.clean.jpg`);
  const prompt = sc.kind === "screenshot" ? `${sc.motion ? `${sc.motion}. ` : ""}${SCREEN_MOTION}` : sc.motion ?? "the scene comes alive with natural movement, camera pushes in slowly";
  const clip = join("clips", sc.id, `${hash([prompt, seconds, readFileSync(frame).length])}.mp4`);
  if (!existsSync(clip)) {
    if (only.length && !only.includes(sc.id)) { kept.push({ id: sc.id, why: "not asked for" }); return preview; }
    mkdirSync(join("clips", sc.id), { recursive: true });
    pending++;
    try {
      const out = JSON.parse(await run(["rep", "run", "minimax/h3", "--no-validate", "--timeout", "900", "-o", `${clip}.part`, "--json",
        "-i", `first_frame_image=@${frame}`, "--input-json", JSON.stringify({ prompt, duration: seconds, resolution: "768P" })], { quiet: true }));
      renameSync(out.files?.[0] ?? fail(`minimax/h3 returned no file for ${sc.id}`), clip);
      await run(["rm", "-rf", `${clip}.part`]);
      spent.push({ source: `animation (${sc.id}, ${seconds}s)`, usd: +(seconds * VIDEO_USD_PER_S).toFixed(2) });
    } catch (e) {
      kept.push({ id: sc.id, why: /sensitive|filter|flag|moderat|safety/i.test(String(e)) ? "refused by the video model's content filter" : `generation failed: ${String(e).slice(-200)}` });
      return preview;
    } finally { pending--; }
  }
  const cap = join("build", `${sc.id}.cap.png`), part = join("build", `${sc.id}.final.mp4`), hasCap = existsSync(cap);
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", clip, "-i", preview, ...(hasCap ? ["-i", cap] : []), "-filter_complex",
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,trim=duration=${D.toFixed(3)},setpts=PTS-STARTPTS${hasCap ? "[bg];[bg][2:v]overlay=0:0" : ""},format=yuv420p[v]`,
    "-map", "[v]", "-map", "1:a", "-t", D.toFixed(3), "-r", "30", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "44100", part]);
  return part;
}));
clearInterval(ticker);

await snap("progress", "Cutting the final version…");
await Bun.write(join("build", "final.txt"), parts.map((p) => `file '${p.replace(/^build\//, "")}'`).join("\n"));
await run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join("build", "final.txt"),
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "final.mp4"]);

// Two frames per animated scene, early and late, so movement (or a mangled screenshot) shows.
const frames: { file: string; label: string }[] = [];
for (const [i, sc] of spec.scenes.entries()) {
  if (!parts[i].endsWith(".final.mp4")) continue;
  const D = await duration(parts[i]);
  for (const [tag, t] of [["start", 0.3], ["late", D - 0.3]] as const) {
    const file = join("build", `${sc.id}.${tag}.jpg`);
    await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", parts[i], "-frames:v", "1", "-q:v", "3", file]);
    frames.push({ file, label: `${sc.id} ${tag}` });
  }
}
const check = frames.length ? await contactSheet(frames, join("build", "check-final.jpg"), { cols: 6, cellW: 300, cellH: 533 }) : undefined;

let url: string | undefined;
if (IN_SESSION) {
  await snap("panel", "set", "final", "--kind", "video", "--title", "Your ad", "--status", "ready", "--action", "approve:I'm happy:primary", "--action", "tweak:Change something");
  url = (await snap("asset", "put", "final.mp4", "--panel", "final", "--slot", "video")).url;
  for (const s of spent) await snap("cost", "add", "--source", s.source, "--usd", String(s.usd));
}

console.log(JSON.stringify({
  final: "final.mp4", url, duration: +(await duration("final.mp4")).toFixed(2), check,
  animated: spec.scenes.filter((_, i) => parts[i].endsWith(".final.mp4")).map((s) => s.id),
  keptPreviewVersion: kept, spentUsd: +spent.reduce((n, s) => n + s.usd, 0).toFixed(2),
  onPage: IN_SESSION ? "the `final` panel is up with the video, and costs are recorded" : undefined,
}));
