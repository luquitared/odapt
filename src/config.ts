import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// A `bun build --compile` binary (scripts/build-mac.ts): its modules live in Bun's embedded
// filesystem, so the repo's files come from the app bundle instead — Odapt.app/Contents/Resources,
// next to Contents/MacOS/odapt. One binary is the server, the runner and `snap` (src/main.ts).
export const PACKAGED = import.meta.dir.startsWith("/$bunfs");
export const ROOT = resolve(process.env.SNAP_ROOT ?? (PACKAGED ? join(dirname(process.execPath), "../Resources") : join(import.meta.dir, "..")));
export const DATA_DIR = resolve(process.env.SNAP_DATA_DIR ?? (PACKAGED ? join(homedir(), "Library/Application Support/Odapt") : `${ROOT}/data`));
// Deliberately not $PORT: a stray PORT in the shell once bound this on top of another app.
// On Cloud Run set SNAP_PORT=8080.
export const PORT = Number(process.env.SNAP_PORT ?? 7788);
export const TEMPLATES_DIR = resolve(process.env.SNAP_TEMPLATES_DIR ?? `${ROOT}/templates`);
// The tool store (src/tools.ts), shared by every app. A packaged build points it at Application Support.
export const TOOLS_DIR = resolve(process.env.SNAP_TOOLS_DIR ?? `${DATA_DIR}/tools`);

// Shared secret between the server and its runners / the agent CLI. Browser
// routes are unauthenticated for now — see README "Not built yet".
export const RUNNER_TOKEN = process.env.SNAP_TOKEN ?? "dev";

// How the server reaches itself from a runner. In the cloud this is the public
// URL of the API service.
export const PUBLIC_URL = process.env.SNAP_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

export const LAUNCHER = (process.env.SNAP_LAUNCHER ?? "local") as "local" | "cloudrun";

// A runner whose heartbeat is older than this is presumed dead and may be replaced.
export const HEARTBEAT_STALE_MS = 45_000;

/** How to start one of the runtime's own programs: `bun src/<name>.ts`, or the packaged binary's subcommand. */
export const selfCommand = (name: "runner" | "cli") => PACKAGED ? [process.execPath, name] : [process.execPath, join(ROOT, `src/${name}.ts`)];

/**
 * A shell script that runs `cmd`. Packaged, the binary is only bun when BUN_BE_BUN=1 says so — set
 * for scripts, which pass it on to anything they start with process.execPath, and cleared for the
 * runtime's own commands, so `snap` run from a script is `snap` again.
 */
export function shim(cmd: string[], asBun: boolean) {
  const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
  const env = !PACKAGED ? "" : asBun ? "BUN_BE_BUN=1 " : "unset BUN_BE_BUN; ";
  return `#!/bin/sh\n${env}exec ${cmd.map(q).join(" ")} "$@"\n`;
}
