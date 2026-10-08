#!/usr/bin/env bun
// grab-media <source> [--out media/<name>] [--max 90]
//
// Pulls a real video or picture off the web and shows the agent what it got, so a scene that has to
// look like the real thing (gameplay, a real UI in motion) is cut from real footage, not a model's
// guess. Nothing here costs money.
//
//   source   a page or file URL (YouTube, the store's preview trailer, a direct .mp4/.m3u8/.jpg),
//            or `search:<words>` for the top YouTube result
//   --max    cap a video at this many seconds from the start (default 90)
//
// Writes <out>.mp4 (or the picture's own extension) and <out>.sheet.jpg — 12 frames with
// timestamps — and prints {file, duration, width, height, sheet, title, source}. Look at the sheet
// before using the file; it's how you know the footage is what the user expects.

import { mkdirSync, existsSync, renameSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { contactSheet, run } from "../lib";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const max = Number(opt("max", "90"));
const source = args[0];
if (!source) { console.error("usage: grab-media <url | search:words> [--out media/<name>] [--max 90]"); process.exit(2); }
const fail = (m: string): never => { console.error(`grab-media: ${m}`); process.exit(1); };
const out = opt("out", join("media", source.replace(/^search:/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40).toLowerCase() || "clip"));
mkdirSync(dirname(out), { recursive: true });

const probe = async (f: string) => {
  const [w, h, d] = (await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0", f])).replace(/\n/g, ",").split(",").map(Number);
  return { width: w, height: h, duration: +d.toFixed(2) };
};

let file: string, title: string | undefined;
const isSearch = source.startsWith("search:");
const isImage = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(source);
const isDirectVideo = /\.(mp4|mov|m3u8|webm)(\?|$)/i.test(source);

if (isImage) {
  file = `${out}${extname(new URL(source).pathname).replace(/jpeg/i, "jpg").toLowerCase()}`;
  const r = await fetch(source, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) fail(`${r.status} for ${source}`);
  await Bun.write(file, await r.arrayBuffer());
  const info = await probe(file);
  await contactSheet([{ file, label: basename(file) }], `${out}.sheet.jpg`, { cols: 1, cellW: 600, cellH: 900 });
  console.log(JSON.stringify({ file, ...info, sheet: `${out}.sheet.jpg`, source }));
  process.exit(0);
}

if (isDirectVideo) {
  file = `${out}.mp4`;
  // -t caps the download too, which matters for a long HLS trailer.
  await run(["ffmpeg", "-y", "-loglevel", "error", "-user_agent", "Mozilla/5.0", "-i", source, "-t", String(max), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-an", "-movflags", "+faststart", file]);
} else {
  // A search takes the first hit under 40 minutes — "<game> gameplay" is mostly long streams and
  // the sub-10-minute ones are rare. Sections can't be cut on download for YouTube's formats, so the
  // whole (≤720p) file comes down and is trimmed here. YouTube needs the EJS solver (bundled in the
  // catalog's standalone yt-dlp) and a JS runtime to run it: the bun this script runs on.
  const target = isSearch ? `ytsearch6:${source.slice(7)}` : source;
  const tmp = `${out}.dl`;
  mkdirSync(tmp, { recursive: true });
  const meta = await run(["yt-dlp", "--js-runtimes", process.env.YTDLP_JS_RUNTIME ?? `bun:${process.execPath}`, "--no-playlist", "--print", "%(title)s", "--no-simulate",
    "-f", "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720]/b",
    ...(isSearch ? ["--match-filter", "duration<=2400", "--max-downloads", "1"] : []),
    "-o", join(tmp, "v.%(ext)s"), "--no-warnings", "--no-progress", target], { quiet: true })
    .catch((e: Error) => { if (!readdirSync(tmp).some((f) => !f.endsWith(".part"))) fail(`download failed: ${e.message.split("\n").filter((l) => l.startsWith("ERROR")).join("; ") || e.message}`); return ""; }); // --max-downloads exits non-zero once it has its one
  title = meta.split("\n").filter(Boolean).at(-1);
  const got = readdirSync(tmp).find((f) => /\.(mp4|webm|mkv|mov)$/.test(f)) ?? fail("yt-dlp produced no video");
  file = `${out}.mp4`;
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", join(tmp, got), "-t", String(max), "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-an", "-movflags", "+faststart", file]);
  await run(["rm", "-rf", tmp]);
}

const info = await probe(file);
const n = 12, frames: { file: string; label: string }[] = [];
for (let i = 0; i < n; i++) {
  const t = (info.duration * (i + 0.5)) / n;
  const f = `${out}.f${i}.jpg`;
  await run(["ffmpeg", "-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", file, "-frames:v", "1", "-q:v", "4", f]);
  frames.push({ file: f, label: `${t.toFixed(1)}s` });
}
const landscape = info.width >= info.height;
await contactSheet(frames, `${out}.sheet.jpg`, { cols: landscape ? 4 : 6, cellW: landscape ? 400 : 240, cellH: landscape ? 225 : 427 });
await run(["rm", "-f", ...frames.map((f) => f.file)]);
const notes = [
  landscape ? "landscape: a 9:16 scene crops to the middle third; pick a `start` where the action is centred" : "",
  info.height < 1000 ? `only ${info.width}x${info.height} — fine for the preview, soft when blown up to 1080x1920; say so if it ends up in the final` : "",
].filter(Boolean);
console.log(JSON.stringify({ file, ...info, sheet: `${out}.sheet.jpg`, title, source, note: notes.join("; ") || undefined }));
