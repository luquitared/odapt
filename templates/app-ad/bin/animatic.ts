#!/usr/bin/env bun
// animatic <ad.json> [--out preview.mp4]
//
// The free preview: pictures and voice cut to length, no generated motion. Every
// scene lasts as long as its line (+0.15s lead, +0.35s breath), so the pacing is
// already the pacing of the finished ad.
//
// ad.json:
//   { "size": "1080x1920",
//     "scenes": [
//       { "id": "s1", "kind": "still",      "image": "stills/s1/a.jpg",    "voice": "voice/s1/a.mp3", "caption": "…" },
//       { "id": "s2", "kind": "screenshot", "image": "assets/shot-02.jpg", "voice": "voice/s2/a.mp3", "caption": "…" },
//       { "id": "end", "kind": "endcard",   "image": "assets/icon.jpg",    "voice": "voice/end/a.mp3",
//         "title": "App name", "subtitle": "4.8 ★ · Free on the App Store" } ] }
//
// clip       real footage ("video", optional "start" seconds), cropped to fill the frame, its own sound dropped
// still      full-frame picture with a slow push-in
// screenshot the real screenshot as a rounded card over a blurred copy of itself, drifting up
// endcard    icon, name and one line of proof
// Captions and all text are drawn here — never ask an image model to write words.

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const out = opt("out", "preview.mp4");
const specFile = args[0];
if (!specFile) { console.error("usage: animatic <ad.json> [--out preview.mp4]"); process.exit(2); }

interface Scene { id: string; kind: "still" | "screenshot" | "endcard" | "clip"; image: string; video?: string; start?: number; voice?: string; caption?: string; title?: string; subtitle?: string }
const spec = JSON.parse(readFileSync(specFile, "utf8")) as { size?: string; scenes: Scene[] };
const [W, H] = (spec.size ?? "1080x1920").split("x").map(Number);
const FPS = 30, LEAD = 0.15, AIR = 0.35;
const FONT = "Helvetica Neue, Helvetica, Arial, DejaVu Sans, Liberation Sans, sans-serif";

async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) { console.error(`${cmd[0]} failed:\n${e.slice(-1800)}`); process.exit(1); }
  return o.trim();
}
const duration = async (f: string) => Number(await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]));
const dims = async (f: string) => (await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f])).split(",").map(Number);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dataUri = (f: string) => `data:image/${extname(f).slice(1).replace("jpg", "jpeg")};base64,${readFileSync(f).toString("base64")}`;

function png(svg: string, file: string) {
  const r = new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Arial" }, fitTo: { mode: "original" } });
  return Bun.write(file, r.render().asPng());
}

function wrap(text: string, maxChars: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > maxChars && line) { lines.push(line); line = word; } else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

// A full-frame transparent layer holding the caption, so one overlay does it.
function captionSvg(text: string) {
  const size = Math.round(W * 0.058), lines = wrap(text, 24), lh = size * 1.22;
  const boxW = W * 0.86, boxH = lines.length * lh + size * 0.9, x = (W - boxW) / 2, y = H * 0.875 - boxH / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${size * 0.55}" fill="#000" fill-opacity="0.62"/>
    ${lines.map((l, i) => `<text x="${W / 2}" y="${y + size * 0.45 + lh * (i + 0.78)}" font-family="${FONT}" font-size="${size}" font-weight="700" fill="#fff" text-anchor="middle">${esc(l)}</text>`).join("")}
  </svg>`;
}

// The screenshot as a rounded card with a soft shadow, at its final on-screen size.
function cardSvg(image: string, iw: number, ih: number) {
  const h = Math.round(H * 0.68), w = Math.round((iw / ih) * h), pad = 60, r = Math.round(w * 0.085);
  return { w: w + pad * 2, h: h + pad * 2, svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w + pad * 2}" height="${h + pad * 2}">
    <defs><clipPath id="c"><rect x="${pad}" y="${pad}" width="${w}" height="${h}" rx="${r}"/></clipPath>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter></defs>
    <rect x="${pad}" y="${pad + 18}" width="${w}" height="${h}" rx="${r}" fill="#000" fill-opacity="0.55" filter="url(#s)"/>
    <image x="${pad}" y="${pad}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)" xlink:href="${dataUri(image)}"/>
    <rect x="${pad}" y="${pad}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="3"/>
  </svg>` };
}

function endcardSvg(icon: string, title: string, subtitle: string) {
  const s = Math.round(W * 0.34), x = (W - s) / 2, y = H * 0.30, t = Math.round(W * 0.085), u = Math.round(W * 0.042);
  const titleLines = wrap(title, 18);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
    <defs><clipPath id="i"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * 0.225}"/></clipPath>
    <filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="28"/></filter></defs>
    <rect x="${x}" y="${y + 24}" width="${s}" height="${s}" rx="${s * 0.225}" fill="#000" fill-opacity="0.5" filter="url(#s)"/>
    <image x="${x}" y="${y}" width="${s}" height="${s}" clip-path="url(#i)" xlink:href="${dataUri(icon)}"/>
    ${titleLines.map((l, i) => `<text x="${W / 2}" y="${y + s + t * 1.5 + i * t * 1.15}" font-family="${FONT}" font-size="${t}" font-weight="800" fill="#fff" text-anchor="middle">${esc(l)}</text>`).join("")}
    <text x="${W / 2}" y="${y + s + t * 1.5 + titleLines.length * t * 1.15 + u * 0.6}" font-family="${FONT}" font-size="${u}" font-weight="500" fill="#fff" fill-opacity="0.82" text-anchor="middle">${esc(subtitle)}</text>
  </svg>`;
}

mkdirSync("build", { recursive: true });
const parts: string[] = [], report = [];

for (const sc of spec.scenes) {
  const voiceLen = sc.voice ? await duration(sc.voice) : 0;
  const D = Math.max(LEAD + voiceLen + AIR, sc.kind === "endcard" ? 2.6 : 1.8);
  const frames = Math.ceil(D * FPS);
  const inputs = sc.kind === "clip"
    ? ["-ss", String(sc.start ?? 0), "-t", D.toFixed(3), "-i", sc.video ?? sc.image]
    : ["-loop", "1", "-t", D.toFixed(3), "-i", sc.image];
  // Blurred, darkened copy of the picture filling the frame — the backdrop for cards.
  const backdrop = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:4,eq=brightness=-0.22:saturation=1.25,fps=${FPS}[bg]`;
  let graph: string, last: string;

  if (sc.kind === "clip") {
    graph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setpts=PTS-STARTPTS[v0]`;
    last = "v0";
  } else if (sc.kind === "still") {
    // Upscale before zoompan or the push-in shimmers.
    graph = `[0:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.10*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}[v0]`;
    last = "v0";
  } else if (sc.kind === "screenshot") {
    const [iw, ih] = await dims(sc.image);
    const card = cardSvg(sc.image, iw, ih);
    const file = join("build", `${sc.id}.card.png`);
    await png(card.svg, file);
    inputs.push("-loop", "1", "-t", D.toFixed(3), "-i", file);
    graph = `${backdrop};[bg][1:v]overlay=x=(W-w)/2:y='(H-h)/2-${Math.round(H * 0.085)}+${Math.round(H * 0.03)}*(1-t/${D.toFixed(3)})':shortest=1[v0]`;
    last = "v0";
  } else {
    const file = join("build", `${sc.id}.end.png`);
    await png(endcardSvg(sc.image, sc.title ?? "", sc.subtitle ?? ""), file);
    inputs.push("-loop", "1", "-t", D.toFixed(3), "-i", file);
    graph = `${backdrop};[bg][1:v]overlay=0:0:shortest=1[v0]`;
    last = "v0";
  }

  // The scene without its caption: the first frame for image-to-video in the paid step, so the
  // card layout carries into the animated clip and the caption can be laid over it sharp.
  if (sc.kind !== "endcard") await run(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", `[${last}]`,
    "-ss", "0.5", "-frames:v", "1", "-q:v", "2", join("build", `${sc.id}.clean.jpg`)]);

  if (sc.caption && sc.kind !== "endcard") {
    const file = join("build", `${sc.id}.cap.png`);
    await png(captionSvg(sc.caption), file);
    const idx = inputs.filter((a) => a === "-i").length;
    inputs.push("-loop", "1", "-t", D.toFixed(3), "-i", file);
    graph += `;[${last}][${idx}:v]overlay=0:0:shortest=1[v1]`;
    last = "v1";
  }

  const audioIdx = inputs.filter((a) => a === "-i").length;
  if (sc.voice) inputs.push("-i", sc.voice);
  else inputs.push("-f", "lavfi", "-t", D.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
  graph += `;[${audioIdx}:a]adelay=${Math.round(LEAD * 1000)}:all=1,apad,aresample=44100[a];[${last}]format=yuv420p[v]`;

  const part = join("build", `${sc.id}.mp4`);
  await run(["ffmpeg", "-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", D.toFixed(3),
    "-r", String(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-ac", "2", part]);
  parts.push(part);
  report.push({ id: sc.id, kind: sc.kind, voice: +voiceLen.toFixed(2), scene: +D.toFixed(2) });
}

await Bun.write(join("build", "list.txt"), parts.map((p) => `file '${p.replace(/^build\//, "")}'`).join("\n"));
await run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join("build", "list.txt"), "-c", "copy", "-movflags", "+faststart", out]);
console.log(JSON.stringify({ out, duration: +(await duration(out)).toFixed(2), size: `${W}x${H}`, scenes: report }, null, 2));
