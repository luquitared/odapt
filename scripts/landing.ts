// Builds every templates/<id>/landing/ into dist/landing/<id>/ and optionally deploys or serves it.
//
//   bun run landing            build
//   bun run landing --serve    build, then serve dist/landing on :7791
//   bun run landing --deploy   build, then `wrangler pages deploy` to the Pages project
//
// env: LANDING_APP_URL     where "Make my ad" sends people (the studio's public URL); unset → "not open yet"
//      CF_BEACON_TOKEN     Cloudflare Web Analytics token; unset → no beacon
//      LANDING_PROJECT     Pages project name (default "snappy")
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "dist/landing");
const PROJECT = process.env.LANDING_PROJECT ?? "snappy";
const APP_URL = (process.env.LANDING_APP_URL ?? "").replace(/\/$/, "");
const BEACON = process.env.CF_BEACON_TOKEN
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token: process.env.CF_BEACON_TOKEN })}'></script>`
  : "";

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const apps = readdirSync(join(ROOT, "templates")).filter((id) => existsSync(join(ROOT, "templates", id, "landing/index.html")));
for (const id of apps) {
  const dir = join(OUT, id);
  cpSync(join(ROOT, "templates", id, "landing"), dir, { recursive: true });
  const page = join(dir, "index.html");
  writeFileSync(page, readFileSync(page, "utf8").replaceAll("{{APP_URL}}", APP_URL).replaceAll("{{BEACON}}", BEACON));
}
// One app for now, so the root goes straight to it.
writeFileSync(join(OUT, "_redirects"), `/ /${apps[0]}/ 302\n`);

console.log(`built ${apps.join(", ")} → dist/landing`);
if (!APP_URL) console.warn("LANDING_APP_URL is unset: the link form will say runs aren't open yet");
if (!BEACON) console.warn("CF_BEACON_TOKEN is unset: no Web Analytics");

if (process.argv.includes("--deploy")) {
  const run = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] }).exitCode;
  const has = Bun.spawnSync(["wrangler", "pages", "project", "list"], { cwd: ROOT }).stdout.toString().includes(` ${PROJECT} `);
  if (!has && run(["wrangler", "pages", "project", "create", PROJECT, "--production-branch", "main"]) !== 0) process.exit(1);
  process.exit(run(["wrangler", "pages", "deploy", OUT, "--project-name", PROJECT, "--branch", "main", "--commit-dirty=true"]));
}

if (process.argv.includes("--serve")) {
  const server = Bun.serve({
    port: 7791,
    fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") return Response.redirect(`/${apps[0]}/`, 302);
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(OUT, path));
      return file.size ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  console.log(`http://127.0.0.1:${server.port}/`);
}
