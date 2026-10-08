#!/usr/bin/env bun
// Cut the final video. The voice sets the length of every scene: each clip is
// trimmed to its narration plus a short breath, so there is never dead air
// waiting for a clip to run out. If a narration outlasts its clip, the clip is
// slowed to fit — the voice is never cut.
//
//   bun assemble.ts [--out final.mp4] [--lead 0.15] [--air 0.35] s1 s2 s3
//
// Expects clips/<id>/*.mp4 and voice/<id>/*.(mp3|wav|m4a). Prints JSON.

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, d: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const out = opt("out", "final.mp4");
const lead = Number(opt("lead", "0.15")); // silence before the voice starts
const air = Number(opt("air", "0.35")); // breath after the voice ends
const ids = args;
if (!ids.length) { console.error("usage: bun assemble.ts [--out f] [--lead s] [--air s] <scene-id>..."); process.exit(2); }

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) { console.error(`${cmd[0]} failed:\n${e.slice(-1500)}`); process.exit(1); }
  return o.trim();
}
const probe = (f: string, entries: string) => run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "csv=p=0", f]);
const duration = async (f: string) => Number(await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
function only(dir: string, exts: string[]) {
  const hits = readdirSync(dir).filter((f) => exts.some((x) => f.toLowerCase().endsWith(x))).sort();
  if (!hits.length) { console.error(`nothing usable in ${dir}`); process.exit(1); }
  return join(dir, hits.at(-1)!); // newest by name if a scene was redone into the same folder
}

mkdirSync("build", { recursive: true });
const first = only(join("clips", ids[0]), [".mp4", ".mov", ".webm"]);
const [w, h] = (await probe(first, "stream=width,height")).split(",").map(Number);
const scenes = [];
const parts: string[] = [];

for (const id of ids) {
  const clip = only(join("clips", id), [".mp4", ".mov", ".webm"]);
  const voice = only(join("voice", id), [".mp3", ".wav", ".m4a"]);
  const [clipLen, voiceLen] = [await duration(clip), await duration(voice)];
  const target = lead + voiceLen + air;
  const slow = target > clipLen ? clipLen / target : 1; // <1 stretches the clip to cover the voice
  const vf = [
    ...(slow < 1 ? [`setpts=PTS/${slow.toFixed(4)}`] : []),
    `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=24,format=yuv420p`,
  ].join(",");
  const part = join("build", `${id}.mp4`);
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", clip, "-i", voice,
    "-filter_complex", `[0:v]${vf}[v];[1:a]adelay=${Math.round(lead * 1000)}:all=1,apad,aresample=44100[a]`,
    "-map", "[v]", "-map", "[a]", "-t", target.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "aac", "-b:a", "160k", "-ac", "2", part]);
  parts.push(part);
  scenes.push({ id, voice: +voiceLen.toFixed(2), clip: +clipLen.toFixed(2), scene: +target.toFixed(2), slowed: slow < 1 });
}

await Bun.write(join("build", "list.txt"), parts.map((p) => `file '${p.replace(/^build\//, "")}'`).join("\n"));
await run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join("build", "list.txt"), "-c", "copy", "-movflags", "+faststart", out]);
console.log(JSON.stringify({ out, duration: +(await duration(out)).toFixed(2), size: `${w}x${h}`, scenes }, null, 2));
