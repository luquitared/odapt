// A harness is the agent program a session talks to. The engine only needs three things from
// one: take a message, run a turn with a shell in the working directory, say when the turn is
// over. `snap` is a shell command, so anything that can run a shell can drive the page.
//
// Which harness a session gets, first match wins:
//   SNAP_HARNESS env → the session's own choice → the template's `harness` → "claude"
// Each is a preset name from harnesses.json, or (in a template) an inline object.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";

export interface HarnessConfig {
  type: "claude" | "codex";
  model?: string;
  provider?: "openrouter"; // codex only: where the model is served from; absent = the CLI's own login
  tools?: string[]; // claude only: built-in tools
}

export interface Turn { text: string; isError: boolean }

export interface HarnessContext {
  sid: string;
  app: string; // template id; the control plane bills model calls to it
  work: string;
  system: string;
  resume: string | null; // this harness's own conversation id from an earlier run
  config: HarnessConfig;
  env: Record<string, string | undefined>; // PATH with the session's .bin, SNAP_* — everything `snap` needs
  transcript: string; // raw event stream, for debugging and cost analysis
  turnTimeoutS: number;
  log: (...a: unknown[]) => void;
  onCost: (usd: number) => void;
}

export interface Harness {
  sessionId: string | null;
  exited: boolean; // the conversation is gone and a send will fail
  selfTurn: boolean; // working without having been sent anything (Claude's background-task wakeups)
  onSelfTurn: ((phase: "start" | "end", turn?: Turn) => void) | null;
  start(): void;
  send(text: string): Promise<Turn>;
  stop(): void;
}

export function presets(): Record<string, HarnessConfig> {
  return JSON.parse(readFileSync(join(ROOT, "harnesses.json"), "utf8"));
}

export function resolveHarness(...choices: (string | HarnessConfig | null | undefined)[]): { name: string; config: HarnessConfig } {
  const all = presets();
  for (const c of choices) {
    if (!c) continue;
    if (typeof c !== "string") return { name: c.type, config: c };
    if (all[c]) return { name: c, config: all[c] };
    throw new Error(`unknown harness "${c}" — harnesses.json has: ${Object.keys(all).join(", ")}`);
  }
  return { name: "claude", config: all.claude ?? { type: "claude" } };
}

// A conversation id only means something to the harness that made it. Claude's are stored bare
// (they predate this file); the rest carry their type, so a session switched to another harness
// starts a fresh conversation instead of failing to resume someone else's.
export const storeId = (type: string, id: string | null) => (!id ? undefined : type === "claude" ? id : `${type}:${id}`);
export function resumeId(type: string, stored: string | null): string | null {
  if (!stored) return null;
  const m = stored.match(/^([a-z]+):(.+)$/);
  return m ? (m[1] === type ? m[2] : null) : type === "claude" ? stored : null;
}

export async function createHarness(ctx: HarnessContext): Promise<Harness> {
  if (ctx.config.type === "codex") return new (await import("./harnesses/codex")).CodexHarness(ctx);
  return new (await import("./harnesses/claude")).ClaudeHarness(ctx);
}
