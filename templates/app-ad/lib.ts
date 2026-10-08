// Shared by the commands in bin/. Lives outside bin/ because every file in there becomes a command.

import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

export const IN_SESSION = !!process.env.SNAP_SESSION;
export const MOCK = process.env.SNAP_MOCK === "1";

// In a session, its own `snap` (a packaged app has no src/cli.ts); by hand, the CLI's source.
export const SNAP = IN_SESSION ? ["snap"] : [process.execPath, join(import.meta.dir, "../../src/cli.ts")];

export async function run(cmd: string[], opts: { quiet?: boolean } = {}) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    if (opts.quiet) throw new Error(e.slice(-600) || `${cmd[0]} exited ${code}`);
    console.error(`${cmd[0]} failed:\n${e.slice(-1800)}`);
    process.exit(1);
  }
  return o.trim();
}

// The commands do their own talking to the page, so the agent doesn't spend a step on each upload.
// Outside a session (run by hand) they just skip it.
export async function snap(...args: string[]): Promise<any> {
  if (!IN_SESSION) return {};
  return JSON.parse((await run([...SNAP, ...args])) || "{}");
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const dataUri = (f: string) => `data:image/${extname(f).slice(1).replace("jpg", "jpeg")};base64,${readFileSync(f).toString("base64")}`;

// One labelled picture of many: the agent looks at a single small image instead of a
// full-size one per file, and every image it has looked at is re-read on every later step.
export async function contactSheet(items: { file: string; label: string }[], out: string, o: { cols?: number; cellW?: number; cellH?: number } = {}) {
  const cols = Math.min(o.cols ?? 5, items.length), cw = o.cellW ?? 300, ch = o.cellH ?? 650, gap = 16, lab = 34;
  const rows = Math.ceil(items.length / cols);
  const W = cols * (cw + gap) + gap, H = rows * (ch + lab + gap) + gap;
  mkdirSync(dirname(out), { recursive: true });
  const cells: string[] = [];
  for (const [i, it] of items.entries()) {
    const thumb = `${out}.${i}.jpg`;
    await run(["ffmpeg", "-y", "-loglevel", "error", "-i", it.file, "-vf", `scale=${cw}:${ch}:force_original_aspect_ratio=decrease`, "-frames:v", "1", "-q:v", "4", thumb]);
    const x = gap + (i % cols) * (cw + gap), y = gap + Math.floor(i / cols) * (ch + lab + gap);
    cells.push(`<text x="${x}" y="${y + 24}" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="22" font-weight="700" fill="#fff">${esc(it.label)}</text>
      <image x="${x}" y="${y + lab}" width="${cw}" height="${ch}" preserveAspectRatio="xMidYMin meet" xlink:href="${dataUri(thumb)}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#1b1b1f"/>${cells.join("")}</svg>`;
  const png = `${out}.png`;
  await Bun.write(png, new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render().asPng());
  await run(["ffmpeg", "-y", "-loglevel", "error", "-i", png, "-q:v", "5", out]);
  await run(["rm", "-f", png, ...items.map((_, i) => `${out}.${i}.jpg`)]);
  return out;
}
