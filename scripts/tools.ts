// The tool store from the command line (src/tools.ts has the model).
//
//   bun run tools                        list the catalog: version, installed, which apps need it
//   bun run tools install <name…>        install into $SNAP_TOOLS_DIR (default data/tools)
//   bun run tools install --for <app>    everything that app needs
//   bun run tools install --all
//   bun run tools check <app>            exit 1 unless every command the app needs resolves
//                                        (SNAP_TOOLS_STRICT=1: from the store only)
import { TOOLS_DIR } from "../src/config";
import { listTemplates, loadTemplate } from "../src/templates";
import { PLATFORM, STRICT, install, installable, isInstalled, listTools, loadTool, requiredTools, resolve, type Tool } from "../src/tools";

const [cmd = "list", ...args] = process.argv.slice(2);
const fail = (m: string): never => { console.error(m); process.exit(1); };
const appArg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? fail(`${flag} needs an app id`) : null; };
const app = (id: string) => loadTemplate(id) ?? fail(`no template "${id}"`);

if (cmd === "list") {
  const users = new Map<string, string[]>();
  for (const t of listTemplates()) for (const tool of requiredTools(t)) users.set(tool.name, [...(users.get(tool.name) ?? []), t.id]);
  console.log(`store: ${TOOLS_DIR} · platform: ${PLATFORM}\n`);
  for (const t of listTools()) {
    const state = isInstalled(t) ? "installed" : installable(t) ? "not installed" : `no build for ${PLATFORM}`;
    const flags = [t.hosted ? "" : "local only", t.provider ? `bills ${t.provider.id}` : ""].filter(Boolean).join(", ");
    console.log(`${t.name.padEnd(10)} ${t.version.padEnd(16)} ${state.padEnd(14)} ${(users.get(t.name) ?? []).join(", ") || "—"}${flags ? `   (${flags})` : ""}`);
  }
} else if (cmd === "install") {
  const forApp = appArg("--for");
  const tools: Tool[] = args.includes("--all") ? listTools()
    : forApp ? requiredTools(app(forApp))
    : args.filter((a) => !a.startsWith("--")).map((n) => loadTool(n) ?? fail(`no tool "${n}" in tools/`));
  if (!tools.length) fail("usage: bun run tools install <name…> | --for <app> | --all");
  const force = args.includes("--force");
  for (const t of tools) {
    if (isInstalled(t) && !force) { console.log(`  ${t.name} ${t.version} already installed`); continue; }
    await install(t, console.log).catch((e: Error) => fail(`${t.name}: ${e.message}`));
  }
} else if (cmd === "check") {
  const t = app(args[0] ?? fail("usage: bun run tools check <app>"));
  const { found, missing } = resolve(requiredTools(t));
  for (const r of found) console.log(`  ${r.command.padEnd(10)} ${r.from === "store" ? "store" : "PATH "} ${r.path}`);
  for (const m of missing) console.log(`  ${m.command.padEnd(10)} MISSING (${m.tool.name})`);
  if (missing.length) fail(`\n${t.id}: ${missing.length} missing${STRICT ? " (strict: store only)" : ""} — bun run tools install --for ${t.id}`);
  console.log(`\n${t.id}: all ${found.length} commands resolve${STRICT ? " from the store" : ""}`);
} else {
  fail(`unknown command "${cmd}" — list | install | check`);
}
