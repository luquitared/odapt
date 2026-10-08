// The tool catalog: the external commands an app may use, pinned and installable.
//
//   tools/<name>/tool.json   what it is, which commands it provides, where to get it per platform
//   tools/<name>/doc.md      optional; spliced into the agent's prompt when a template lists it in `tools`
//
// A template declares what it needs: `tools` (documented to the agent) + `requires` (just installed).
// Installed tools live in one store shared by every app, `$SNAP_TOOLS_DIR/<name>/<version>/<command>`,
// so ffmpeg is downloaded once however many apps use it. The runner links a session's tools from
// the store into its `.bin`. With SNAP_TOOLS_STRICT=1 nothing else is on PATH but the OS's own
// directories, which is how a packaged build runs and how to prove a template declares everything.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, shim, TOOLS_DIR } from "./config";
import type { Template } from "./templates";

export const CATALOG_DIR = join(ROOT, "tools");
export const PLATFORM = `${process.platform}-${process.arch}`; // darwin-arm64, linux-x64, …
export const STRICT = process.env.SNAP_TOOLS_STRICT === "1";
// What a strict session may use besides its own .bin: the OS, never Homebrew or a user's installs.
export const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface Artifact {
  url: string;
  sha256: string;
  command: string; // the file is installed under this name
  unzip?: string; // the url is a zip; take this path out of it
}

/**
 * A paid API a tool calls. With the control plane configured, the runner points `base_url_env` at
 * `<control>/proxy/<app>/<id><base_path>` and puts the user's token in `token_env`, so the call is
 * billed to the user and no provider key is on their machine. A tool without `base_url_env` can't be
 * proxied yet: it gets no key at all in that mode.
 */
export interface Provider {
  id: string; // the proxy's upstream name: control/proxy.ts
  token_env: string;
  other_key_envs?: string[]; // anything else the tool would read a key from; always removed
  base_url_env?: string;
  base_path?: string; // appended to the proxy URL, e.g. "/v1"
}

export interface Tool {
  name: string;
  about: string;
  version: string;
  commands: string[];
  hosted?: boolean; // false: never available on a server (default true)
  provider?: Provider; // a paid API the tool calls
  check?: string[]; // run after install; must exit 0
  platforms?: Record<string, Artifact[]>; // prebuilt downloads
  build?: { git: string; ref: string; entry: string; command: string }; // or a bun script, bundled to one file run by the runtime's bun
  dir: string;
}

export function loadTool(name: string): Tool | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const f = join(CATALOG_DIR, name, "tool.json");
  if (!existsSync(f)) return null;
  return { hosted: true, ...JSON.parse(readFileSync(f, "utf8")), name, dir: join(CATALOG_DIR, name) };
}

export function listTools(): Tool[] {
  return readdirSync(CATALOG_DIR).map(loadTool).filter((t): t is Tool => !!t);
}

// What the runtime itself shells out to, so every session has it: `snap mock` makes stand-ins with ffmpeg.
export const RUNTIME_TOOLS = ["ffmpeg"];

/** Every tool a template needs, documented or not. Unknown names throw: a typo shouldn't surface mid-run. */
export function requiredTools(t: Pick<Template, "id" | "tools" | "requires">): Tool[] {
  const names = [...new Set([...RUNTIME_TOOLS, ...t.tools, ...(t.requires ?? [])])];
  return names.map((n) => loadTool(n) ?? (() => { throw new Error(`template ${t.id}: no tool "${n}" in tools/ (add tools/${n}/tool.json)`); })());
}

const storeDir = (t: Tool) => join(TOOLS_DIR, t.name, t.version);
export const isInstalled = (t: Tool) => existsSync(join(storeDir(t), ".installed.json"));
export const installable = (t: Tool) => !!(t.platforms?.[PLATFORM] || t.build);

export type Resolved = { tool: Tool; command: string; path: string; from: "store" | "path" };

/** Where each command of these tools comes from: the store, else (outside strict mode) the user's PATH. */
export function resolve(tools: Tool[]): { found: Resolved[]; missing: { tool: Tool; command: string }[] } {
  const found: Resolved[] = [], missing: { tool: Tool; command: string }[] = [];
  for (const tool of tools) for (const command of tool.commands) {
    const stored = join(storeDir(tool), command);
    if (isInstalled(tool) && existsSync(stored)) found.push({ tool, command, path: stored, from: "store" });
    else if (!STRICT && Bun.which(command)) found.push({ tool, command, path: Bun.which(command)!, from: "path" });
    else missing.push({ tool, command });
  }
  return { found, missing };
}

/** Link a template's commands into a session's .bin. Strict mode refuses to start with any missing. */
export function linkTools(template: Template, binDir: string, log: (...a: unknown[]) => void) {
  // bun is the runtime, not a catalog tool: template scripts and bundled tools run on it.
  // Packaged, that's the app's own binary, which is bun only with BUN_BE_BUN=1.
  rmSync(join(binDir, "bun"), { force: true });
  writeFileSync(join(binDir, "bun"), shim([process.execPath], true));
  chmodSync(join(binDir, "bun"), 0o755);
  const { found, missing } = resolve(requiredTools(template));
  for (const r of found) {
    const link = join(binDir, r.command);
    rmSync(link, { force: true });
    symlinkSync(r.path, link);
    if (r.from === "path") log(`tool ${r.command}: not in the store, using ${r.path}`);
  }
  if (missing.length) {
    const names = [...new Set(missing.map((m) => m.tool.name))].join(" ");
    const msg = `missing tools: ${missing.map((m) => m.command).join(", ")} — run \`bun run tools install ${names}\``;
    if (STRICT) throw new Error(msg);
    log(`WARNING: ${msg}`);
  }
}

// Keys a session must not see once it bills through the control plane, beyond the catalog's own:
// the Codex harness reaches OpenRouter through the proxy with SNAP_CONTROL_TOKEN instead.
const HARNESS_KEYS = ["OPENROUTER_API_KEY"];

/**
 * Env changes for a session's agent and tools: undefined means remove. Without a control plane this
 * is empty and tools use whatever keys the developer has. With one, every paid tool goes through
 * the proxy on the user's token and no provider key is left in the environment.
 */
export function providerEnv(tools: Tool[], app: string, control: string | undefined, token: string | undefined, log: (...a: unknown[]) => void = () => {}): Record<string, string | undefined> {
  if (!control) return {};
  const env: Record<string, string | undefined> = {};
  for (const k of HARNESS_KEYS) env[k] = undefined;
  for (const t of listTools()) if (t.provider) for (const k of [t.provider.token_env, ...(t.provider.other_key_envs ?? [])]) env[k] = undefined;
  for (const t of tools) {
    const p = t.provider;
    if (!p) continue;
    if (!p.base_url_env) { log(`tool ${t.name}: ${p.id} isn't proxied yet, so it has no key in this session`); continue; }
    env[p.base_url_env] = `${control.replace(/\/$/, "")}/proxy/${app}/${p.id}${p.base_path ?? ""}`;
    env[p.token_env] = token;
  }
  return env;
}

// ---------------------------------------------------------------- install

/**
 * Fill the store from the copies a packaged app ships (`Resources/store/<name>/<version>`), so a
 * fresh Mac runs without downloading anything. A version already in the store is left alone.
 */
export function seedStore(from: string, log: (s: string) => void = console.log) {
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) for (const version of readdirSync(join(from, name))) {
    const dest = join(TOOLS_DIR, name, version);
    if (existsSync(join(dest, ".installed.json"))) continue;
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(join(from, name, version), dest, { recursive: true });
    log(`  ${name} ${version} → ${dest} (from the app)`);
  }
}

async function sha256(file: string) {
  const h = new Bun.CryptoHasher("sha256");
  h.update(await Bun.file(file).arrayBuffer());
  return h.digest("hex");
}

async function sh(cmd: string[], cwd?: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}: ${(err || out).trim().slice(-800)}`);
  return out;
}

/** Download (checksum-verified) or build a tool into the store. Staged, then moved into place. */
export async function install(tool: Tool, log: (s: string) => void = console.log): Promise<void> {
  const dest = storeDir(tool);
  const stage = join(TOOLS_DIR, `.stage-${tool.name}-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const files: Record<string, string> = {};
  try {
    const artifacts = tool.platforms?.[PLATFORM];
    if (artifacts) {
      for (const a of artifacts) {
        log(`  ${tool.name}: downloading ${a.url}`);
        const res = await fetch(a.url, { redirect: "follow" });
        if (!res.ok) throw new Error(`${res.status} for ${a.url}`);
        const dl = join(stage, `.dl-${a.command}`);
        await Bun.write(dl, res);
        const got = await sha256(dl);
        if (got !== a.sha256) throw new Error(`checksum mismatch for ${a.url}: expected ${a.sha256}, got ${got}`);
        if (a.unzip) {
          await sh(["unzip", "-o", "-j", "-q", dl, a.unzip, "-d", stage]);
          if (a.unzip.split("/").at(-1) !== a.command) renameSync(join(stage, a.unzip.split("/").at(-1)!), join(stage, a.command));
          rmSync(dl);
        } else renameSync(dl, join(stage, a.command));
        chmodSync(join(stage, a.command), 0o755);
        files[a.command] = a.sha256;
      }
    } else if (tool.build) {
      const b = tool.build, src = join(tmpdir(), `snap-build-${tool.name}-${process.pid}`);
      rmSync(src, { recursive: true, force: true });
      log(`  ${tool.name}: building ${b.git}@${b.ref.slice(0, 7)}`);
      await sh(["git", "init", "-q", src]);
      await sh(["git", "fetch", "-q", "--depth", "1", b.git, b.ref], src);
      await sh(["git", "checkout", "-q", "FETCH_HEAD"], src);
      await sh([process.execPath, "install", "--frozen-lockfile"], src).catch(() => sh([process.execPath, "install"], src));
      // One self-contained file run by the runtime's bun (on every session's PATH), not `--compile`:
      // that would embed another 60 MB copy of bun in each tool. Platform-independent, too.
      const out = join(stage, b.command);
      await sh([process.execPath, "build", "--target=bun", b.entry, "--outfile", out], src);
      const js = readFileSync(out, "utf8");
      writeFileSync(out, js.startsWith("#!") ? js.replace(/^#![^\n]*/, "#!/usr/bin/env bun") : `#!/usr/bin/env bun\n${js}`);
      chmodSync(out, 0o755);
      rmSync(src, { recursive: true, force: true });
      files[b.command] = await sha256(join(stage, b.command));
    } else {
      throw new Error(`${tool.name} has no download for ${PLATFORM} and no build`);
    }
    for (const c of tool.commands) if (!existsSync(join(stage, c))) throw new Error(`${tool.name} should provide "${c}" but the install didn't produce it`);
    if (tool.check) {
      const [cmd, ...args] = tool.check;
      await sh([join(stage, cmd), ...args]);
    }
    writeFileSync(join(stage, ".installed.json"), JSON.stringify({ name: tool.name, version: tool.version, platform: PLATFORM, files, at: new Date().toISOString() }, null, 2) + "\n");
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(dest, ".."), { recursive: true });
    renameSync(stage, dest);
    log(`  ${tool.name} ${tool.version} → ${dest}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
