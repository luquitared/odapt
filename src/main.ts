#!/usr/bin/env bun
// The packaged app's one program (scripts/build-mac.ts compiles it into Odapt.app):
//
//   odapt              the app: start the server if it isn't running, open it in the browser
//   odapt runner <id>  a session's runner (src/launcher.ts starts these)
//   odapt cli …        `snap` (each session's .bin/snap calls this)
//
// With BUN_BE_BUN=1 the same binary is plain bun, which runs template scripts and bun-built tools.
// Everything is imported lazily so the env is settled before src/config.ts reads it.

const [cmd] = process.argv.slice(2);

if (cmd === "runner") {
  process.argv.splice(2, 1); // the runner reads its session id from argv[2]
  await import("./runner");
} else if (cmd === "cli") {
  process.argv.splice(2, 1);
  await (await import("./cli")).main();
} else {
  await app();
}

async function app() {
  const { existsSync, mkdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  // Not 7788, so the app and a dev server from the repo can run side by side.
  process.env.SNAP_PORT ??= "7789";
  // Nothing but the app and the OS: every tool comes from the store (src/tools.ts).
  process.env.SNAP_TOOLS_STRICT ??= "1";
  const { DATA_DIR, PORT, ROOT } = await import("./config");
  mkdirSync(DATA_DIR, { recursive: true });

  // Settings that would otherwise come from a shell, which an app opened from Finder doesn't have.
  // Not needed to run: paid calls go through https://api.odapt.ai once the user signs in (src/account.ts).
  // For development, SNAP_CONTROL_URL= (empty) here turns the control plane off and provider keys
  // set here are used directly.
  const envFile = join(DATA_DIR, "odapt.env");
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  const codex = join(ROOT, "codex/bin/codex");
  if (existsSync(codex)) process.env.SNAP_CODEX_BIN ??= codex;

  const url = `http://127.0.0.1:${PORT}`;
  const open = () => { if (process.env.SNAP_NO_OPEN !== "1") Bun.spawn(["/usr/bin/open", url]); };
  // Opened again while running: just show it.
  if (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false)) return open();

  (await import("./tools")).seedStore(join(ROOT, "store"));
  await import("./server");
  open();
}

export {}; // a module, for top-level await
