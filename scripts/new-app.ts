#!/usr/bin/env bun
// A new standalone app from apps/_template: a form, a payment through the platform, then work.ts.
//
//   bun run new-app <id> --name "Name" --price 5 [--description "…"] [--path /x]
//
// Picks the next free port, writes apps/<id>/ with its app.json (product, deploy block), and prints
// what's left: write work.ts, try it with APP_FAKE_PAY=1, push. A push to main deploys it to
// https://api.odapt.ai<path>; its app key, payments and money tracking need no setup.

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const [id] = process.argv.slice(2);
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (!id || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) throw new Error("usage: bun run new-app <id: lowercase, digits, -> --name \"Name\" --price 5");
const dir = join(ROOT, "apps", id);
if (existsSync(dir) || existsSync(join(ROOT, "templates", id))) throw new Error(`${id} already exists`);
const name = arg("name") ?? id;
const price = Number(arg("price") ?? NaN);
if (!(price >= 1)) throw new Error("--price is required (whole dollars or cents, at least 1)");
const path = arg("path") ?? `/${id}`;
if (!/^\/[a-z0-9-]+$/.test(path)) throw new Error("--path must look like /name");

// Ports and paths already taken by other apps' deploy blocks.
const others = readdirSync(join(ROOT, "apps"))
  .map((a) => join(ROOT, "apps", a, "app.json"))
  .filter(existsSync)
  .map((f) => JSON.parse(readFileSync(f, "utf8")).deploy)
  .filter(Boolean);
if (others.some((d) => d.path === path)) throw new Error(`${path} is taken; pass --path`);
const port = Math.max(7799, ...others.map((d) => d.port)) + 1;

const fill = (s: string) =>
  s.replaceAll("{{ID}}", id).replaceAll("{{NAME}}", name).replaceAll("{{PRICE}}", String(price))
    .replaceAll("{{DESCRIPTION}}", arg("description") ?? `${name}, made for you for $${price}.`)
    .replaceAll("{{PORT}}", String(port)).replaceAll("{{PATH}}", path);

cpSync(join(ROOT, "apps/_template"), dir, { recursive: true });
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk(dir)) writeFileSync(f, fill(readFileSync(f, "utf8")));
renameSync(join(dir, "app.json.tmpl"), join(dir, "app.json"));

console.log(`apps/${id}/ — ${name}, $${price}, port ${port}, https://api.odapt.ai${path}

  1. Write the job in apps/${id}/work.ts (providers: list them in app.json, call them via odapt.provider).
  2. Try it:  APP_FAKE_PAY=1 bun apps/${id}/server.ts   → http://127.0.0.1:${port}
  3. Push to main: the control plane learns the app, then it deploys. Payments, its app key and the
     ledger need no setup; \`bun run report --app ${id}\` shows its money and funnel.`);
