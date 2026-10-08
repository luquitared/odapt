import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listTemplates } from "../src/templates";
import { listTools, loadTool, providerEnv, requiredTools } from "../src/tools";

// What a template's own scripts may run without declaring it: the OS, the runtime, and each other.
const BASE = new Set(["rm", "mkdir", "cp", "mv", "sh", "unzip", "bun"]);

function scripts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "landing" ? [] : scripts(join(dir, e.name))) : /\.(ts|js|sh)$/.test(e.name) ? [join(dir, e.name)] : []);
}

/** Commands a script starts by literal name: run(["x", …]), Bun.spawn(["x", …]), spawnSync(["x", …]). */
function commandsIn(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/\b(?:run|spawn|spawnSync)\(\s*\[\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("every catalog tool is installable somewhere and pins what it downloads", () => {
  for (const t of listTools()) {
    expect(t.commands.length, t.name).toBeGreaterThan(0);
    expect(!!(t.platforms || t.build), `${t.name} has no platforms and no build`).toBe(true);
    for (const [platform, artifacts] of Object.entries(t.platforms ?? {})) {
      expect(artifacts.map((a) => a.command).sort(), `${t.name} on ${platform} must provide every command`).toEqual([...t.commands].sort());
      for (const a of artifacts) expect(a.sha256, `${t.name} ${a.url}`).toMatch(/^[0-9a-f]{64}$/);
    }
    if (t.build) expect(t.build.ref, `${t.name} must build from a commit, not a branch`).toMatch(/^[0-9a-f]{40}$/);
  }
});

test("templates only name tools that are in the catalog", () => {
  for (const t of listTemplates()) expect(() => requiredTools(t), t.id).not.toThrow();
});

test("every command a template's scripts run is declared", () => {
  for (const t of listTemplates()) {
    const provided = new Set([...BASE, ...requiredTools(t).flatMap((tool) => tool.commands)]);
    const own = new Set(scripts(join(t.dir, "bin")).map((f) => f.split("/").at(-1)!.replace(/\.ts$/, "")));
    for (const f of scripts(t.dir)) for (const c of commandsIn(f)) {
      expect(provided.has(c) || own.has(c), `${t.id}: ${f.slice(t.dir.length + 1)} runs "${c}" — add it to "requires" in template.json`).toBe(true);
    }
  }
});

test("on the control plane, paid tools get the proxy and the user's token, and no provider key survives", () => {
  const rep = loadTool("rep")!, vidwatch = loadTool("vidwatch")!;
  expect(providerEnv([rep], "app-ad", undefined, "tok")).toEqual({}); // local dev: the developer's own keys

  const env = providerEnv([rep, vidwatch], "app-ad", "https://control.example/", "tok");
  expect(env.REPLICATE_API_BASE).toBe("https://control.example/proxy/app-ad/replicate/v1");
  expect(env.REPLICATE_API_TOKEN).toBe("tok");
  // Not proxied yet, so removed rather than handed the real key.
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"]) {
    expect(k in env && env[k] === undefined, k).toBe(true);
  }
  // A key is removed even when this app doesn't use the tool that reads it.
  expect("REPLICATE_API_TOKEN" in providerEnv([], "name-lab", "https://c", "tok")).toBe(true);
});
