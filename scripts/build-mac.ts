// Build an unsigned Odapt.app (issue #8): the runtime and the apps it carries, nothing else needed.
//
//   bun run build-mac [--apps app-ad,name-lab] [--out dist/mac]
//   bun run build-mac --apps my-app --name "My App" --port 7795
//
// --name builds a branded app for one customer: <name>.app, its own bundle id, its own data folder
// (~/Library/Application Support/<name>) and port, and it opens on the first app's new-session page.
// The branding is Contents/Resources/brand.json, which src/main.ts reads.
//
//   Contents/MacOS/odapt        src/main.ts compiled: server, runner, `snap`, and bun (BUN_BE_BUN=1)
//   Contents/Resources/
//     ui/ prompts/ tools/ harnesses.json    what src/ reads from ROOT
//     templates/<app>/                      the apps, without their landing pages
//     node_modules/                         the packages template scripts import, nothing else
//     store/<tool>/<version>/               copied into the user's store on first start
//     codex/                                the harness: Codex's standalone package, from this Mac
//
// Codex comes from the local install (`codex` on PATH, or SNAP_CODEX_PACKAGE: the directory with
// codex-package.json). Signing, notarization and a DMG come next.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, TOOLS_DIR } from "../src/config";
import { loadTemplate } from "../src/templates";
import { install, isInstalled, PLATFORM, requiredTools } from "../src/tools";

const arg = (flag: string, dflt: string) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : dflt; };
const fail = (m: string): never => { console.error(m); process.exit(1); };
if (process.platform !== "darwin") fail("build-mac builds on a Mac (it ships this machine's platform binaries)");

const apps = arg("--apps", "app-ad").split(",").map((id) => loadTemplate(id) ?? fail(`no template "${id}"`));
const name = arg("--name", "Odapt");
const brand = name === "Odapt" ? null : { name, port: Number(arg("--port", "7792")), open: `#/new/${apps[0].id}` };
if (!/^[A-Za-z0-9 ]+$/.test(name)) fail(`--name "${name}": letters, digits and spaces only`);
const bundleId = brand ? `ai.odapt.${name.toLowerCase().replace(/ /g, "-")}` : "ai.odapt.app";
const app = join(ROOT, arg("--out", "dist/mac"), `${name}.app`);
const res = join(app, "Contents/Resources");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

async function sh(cmd: string[], cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) fail(`${cmd.join(" ")} failed`);
}

rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
mkdirSync(res, { recursive: true });

console.log("compiling src/main.ts");
await sh(["bun", "build", "--compile", "src/main.ts", "--outfile", join(app, "Contents/MacOS/odapt")]);

for (const p of ["ui", "prompts", "tools", "harnesses.json"]) cpSync(join(ROOT, p), join(res, p), { recursive: true });
if (brand) writeFileSync(join(res, "brand.json"), JSON.stringify(brand, null, 2) + "\n");
// realpath: a private template (scripts/private-apps.sh) is a symlink into ops/, and the app needs the files.
for (const t of apps) { const dir = realpathSync(t.dir); cpSync(dir, join(res, "templates", t.id), { recursive: true, filter: (src) => !src.startsWith(join(dir, "landing")) }); }

// Packages the templates import by name, at the versions the repo pins: a node_modules of just those.
const deps: Record<string, string> = {};
const pinned = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies as Record<string, string>;
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === "landing" ? [] : sources(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
for (const t of apps) for (const f of sources(t.dir)) {
  for (const [, spec] of readFileSync(f, "utf8").matchAll(/(?:from\s+|import\(\s*)"([^".][^"]*)"/g)) {
    if (spec.startsWith("node:") || spec.startsWith("bun")) continue;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    deps[name] = pinned[name] ?? fail(`${f} imports "${name}", which isn't in package.json`);
  }
}
if (Object.keys(deps).length) {
  console.log(`node_modules: ${Object.keys(deps).join(", ")}`);
  writeFileSync(join(res, "package.json"), JSON.stringify({ private: true, dependencies: deps }, null, 2) + "\n");
  await sh(["bun", "install", "--production"], res);
}

// Each tool from this Mac's store (installed first if need be) into the app.
const tools = new Map(apps.flatMap((t) => requiredTools(t)).map((t) => [t.name, t]));
for (const t of tools.values()) {
  if (!isInstalled(t)) await install(t).catch((e: Error) => fail(`${t.name}: ${e.message}`));
  const dir = join(TOOLS_DIR, t.name, t.version);
  const { platform } = JSON.parse(readFileSync(join(dir, ".installed.json"), "utf8"));
  if (platform !== PLATFORM) fail(`${t.name} in the store is for ${platform}`);
  cpSync(dir, join(res, "store", t.name, t.version), { recursive: true });
  console.log(`store: ${t.name} ${t.version}`);
}

const which = Bun.which("codex");
const codex = process.env.SNAP_CODEX_PACKAGE ?? (which ? dirname(dirname(realpathSync(which))) : fail("no codex on PATH; set SNAP_CODEX_PACKAGE"));
if (!existsSync(join(codex, "codex-package.json"))) fail(`${codex} is not Codex's standalone package (no codex-package.json)`);
cpSync(codex, join(res, "codex"), { recursive: true, verbatimSymlinks: true });
console.log(`codex: ${JSON.parse(readFileSync(join(codex, "codex-package.json"), "utf8")).version}`);

// LSUIElement: no Dock icon, since the window is the browser (an open question in #8).
writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleExecutable</key><string>odapt</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);

const size = (await new Response(Bun.spawn(["du", "-sh", app]).stdout).text()).split("\t")[0];
console.log(`\n${app} (${size})`);
