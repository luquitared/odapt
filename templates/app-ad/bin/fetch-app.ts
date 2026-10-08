#!/usr/bin/env bun
// fetch-app <store-url> [--country us] [--reviews 150]
//
// Pulls everything public about an app into the working directory:
//   app.json        name, developer, genre, description, rating, ratingCount, price, store, url
//   assets/icon.*   the icon
//   assets/shot-NN.* phone screenshots (up to 8)
//   assets/sheet.jpg icon + every screenshot, labelled, in one small picture — what the agent looks at
//   reviews.json    [{rating, title, text, helpful}] — most helpful first, then most recent
//   reviews.txt     the first 80 as one line each, long ones cut — what the agent reads
// Inside a session it also uploads the icon and screenshots and puts up the `app` panel.
// Prints a short JSON summary. Free: Apple's public lookup + reviews feed; Google Play via scraping.

import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { contactSheet, IN_SESSION, snap } from "../lib";

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : d; };
const wantReviews = Number(opt("reviews", "150"));
let country = opt("country", "");
const url = args[0];
if (!url) { console.error("usage: fetch-app <app-store-or-google-play-url> [--country us] [--reviews 150]"); process.exit(2); }

interface Review { rating: number; title: string; text: string; helpful?: number }
interface App {
  store: "apple" | "play"; id: string; url: string; name: string; developer: string; genre: string;
  description: string; rating: number | null; ratingCount: number | null; price: string;
  iconUrl: string; screenshotUrls: string[]; previewVideoUrls?: string[];
}

const fail = (msg: string): never => { console.error(`fetch-app: ${msg}`); process.exit(1); };
const getJson = async (u: string) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${r.status} for ${u}`);
  return r.json() as Promise<any>;
};

async function apple(id: string): Promise<{ app: App; reviews: Review[] }> {
  const cc = country || url.match(/apps\.apple\.com\/([a-z]{2})\//)?.[1] || "us";
  const r = (await getJson(`https://itunes.apple.com/lookup?id=${id}&country=${cc}`)).results?.[0] ?? fail(`no App Store app with id ${id} in "${cc}"`);
  const app: App = {
    store: "apple", id, url: r.trackViewUrl, name: r.trackName, developer: r.artistName, genre: r.primaryGenreName,
    description: r.description, rating: r.averageUserRating ?? null, ratingCount: r.userRatingCount ?? null,
    price: r.formattedPrice ?? "", iconUrl: r.artworkUrl512, screenshotUrls: r.screenshotUrls?.length ? r.screenshotUrls : r.ipadScreenshotUrls ?? [],
  };
  // The lookup API has no preview videos; the store page does (HLS trailers). Real footage of the
  // app, from the app's own publisher — the first place to look when a scene has to be real.
  app.previewVideoUrls = await fetch(r.trackViewUrl, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) })
    .then((x) => x.text()).then((html) => [...new Set(html.match(/https:\/\/[^"\\]+\.m3u8/g) ?? [])].slice(0, 4)).catch(() => []);
  const seen = new Set<string>();
  const reviews: Review[] = [];
  for (const sort of ["mosthelpful", "mostrecent"]) {
    for (let page = 1; page <= 10 && reviews.length < wantReviews; page++) {
      const feed = await getJson(`https://itunes.apple.com/${cc}/rss/customerreviews/page=${page}/id=${id}/sortby=${sort}/json`).catch(() => null);
      const entries = [feed?.feed?.entry ?? []].flat().filter((e: any) => e?.["im:rating"]);
      if (!entries.length) break;
      for (const e of entries) {
        if (seen.has(e.id.label)) continue;
        seen.add(e.id.label);
        reviews.push({ rating: Number(e["im:rating"].label), title: e.title.label, text: e.content.label, helpful: Number(e["im:voteSum"]?.label ?? 0) });
      }
    }
  }
  return { app, reviews: reviews.slice(0, wantReviews) };
}

async function play(id: string): Promise<{ app: App; reviews: Review[] }> {
  const gplay = (await import("google-play-scraper")).default;
  const cc = country || "us";
  const r = await gplay.app({ appId: id, country: cc }).catch((e: Error) => fail(`Google Play lookup failed: ${e.message}`));
  const app: App = {
    store: "play", id, url: r.url, name: r.title, developer: r.developer, genre: r.genre, description: r.description,
    rating: r.score ?? null, ratingCount: r.ratings ?? null, price: r.free ? "Free" : r.priceText ?? "",
    iconUrl: r.icon, screenshotUrls: r.screenshots ?? [], previewVideoUrls: r.video ? [r.video] : [],
  };
  const got = await gplay.reviews({ appId: id, country: cc, sort: gplay.sort.HELPFULNESS, num: wantReviews }).catch(() => ({ data: [] as any[] }));
  return { app, reviews: got.data.map((x: any) => ({ rating: x.score, title: x.title ?? "", text: x.text ?? "", helpful: x.thumbsUp ?? 0 })) };
}

async function download(u: string, base: string) {
  const r = await fetch(u, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status} for ${u}`);
  const type = r.headers.get("content-type") ?? "";
  const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : extname(new URL(u).pathname) || ".jpg";
  const file = `${base}${ext === ".jpeg" ? ".jpg" : ext}`;
  await Bun.write(file, await r.arrayBuffer());
  return file;
}

const appleId = url.match(/apps\.apple\.com\/.*?\/id(\d+)/)?.[1] ?? url.match(/^id?(\d{6,})$/)?.[1];
const playId = url.match(/play\.google\.com\/store\/apps\/details\?.*?\bid=([\w.]+)/)?.[1];
if (!appleId && !playId) fail("that doesn't look like an App Store or Google Play app link");

const { app, reviews } = appleId ? await apple(appleId) : await play(playId!);
mkdirSync("assets", { recursive: true });
const icon = await download(app.iconUrl, join("assets", "icon"));
const shots: string[] = [];
for (const [i, s] of app.screenshotUrls.slice(0, 8).entries()) {
  // Both stores hand out thumbnails (Apple's are ~220px wide) unless asked for a size.
  const big = app.store === "play" ? `${s}=w1080` : s.replace(/\/\d+x\d+bb\./, "/1290x2796bb.");
  shots.push(await download(big, join("assets", `shot-${String(i + 1).padStart(2, "0")}`)).catch(() => ""));
}
const screenshots = shots.filter(Boolean);

await Bun.write("app.json", JSON.stringify({ ...app, icon, screenshots }, null, 2));
await Bun.write("reviews.json", JSON.stringify(reviews, null, 2));

// What the agent reads. The JSON above is the record; read whole it cost ~24k tokens for 50
// reviews, carried through every later step. One line per review, long ones cut, is a quarter of that.
const clip = (t: string, n: number) => { const c = t.replace(/\s+/g, " ").trim(); return c.length > n ? `${c.slice(0, n)}…` : c; };
const shown = reviews.slice(0, 80);
await Bun.write("reviews.txt", shown.map((r, i) => `${i + 1}. ${r.rating}★ ${clip(r.title, 60)} — ${clip(r.text, 320)}`).join("\n") + "\n");

const sheet = await contactSheet(
  [{ file: icon, label: "icon" }, ...screenshots.map((f) => ({ file: f, label: f.replace(/^assets\//, "") }))],
  join("assets", "sheet.jpg"),
);

// Put the app on the page here, so the agent doesn't spend steps uploading files one by one.
let panel: string | undefined;
if (IN_SESSION) {
  const iconUrl = (await snap("asset", "put", icon)).url;
  const shotUrls: string[] = [];
  for (const f of screenshots) shotUrls.push((await snap("asset", "put", f)).url);
  await Bun.write("app.panel.json", JSON.stringify({
    name: app.name, developer: app.developer, genre: app.genre, rating: app.rating, ratingCount: app.ratingCount,
    price: app.price, icon: iconUrl, screenshots: shotUrls,
  }));
  await snap("title", app.name);
  await snap("panel", "set", "app", "--kind", "appcard", "--title", app.name, "--status", "approved", "--data", "@app.panel.json");
  panel = "app (already on the page, with the session title)";
}

const stars = [1, 2, 3, 4, 5].map((n) => reviews.filter((r) => r.rating === n).length);
console.log(JSON.stringify({
  name: app.name, developer: app.developer, genre: app.genre, store: app.store,
  rating: app.rating, ratingCount: app.ratingCount, price: app.price,
  description: clip(app.description ?? "", 1500),
  icon, screenshots, sheet, panel,
  previewVideos: app.previewVideoUrls?.length ? { urls: app.previewVideoUrls, note: "the publisher's own footage of the app — `grab-media <url>` pulls one and shows you its frames" } : undefined,
  reviews: { file: "reviews.txt", inFile: shown.length, fetched: reviews.length, byStar: { 1: stars[0], 2: stars[1], 3: stars[2], 4: stars[3], 5: stars[4] } },
  note: reviews.length < 15 ? "Very few reviews — lean on the description and screenshots, and tell the user that's what you did." : undefined,
}));
