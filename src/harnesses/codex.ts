// Codex CLI. Unlike Claude there is no long-lived process: each turn is one `codex exec`, and
// every turn after the first resumes the thread the first one started. The thread lives in
// CODEX_HOME/sessions, which is therefore what a cloud runtime has to keep between wake-ups.
//
// With a `provider`, Codex is only the loop and the tools — the model comes from somewhere else
// (OpenRouter today), which is how a session runs on a model that costs a twentieth of Sonnet.
// Codex speaks only the Responses API to providers, so the provider has to offer one.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config";
import type { Harness, HarnessContext, Turn } from "../harness";

const PROVIDERS = {
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", env_key: "OPENROUTER_API_KEY", models: "https://openrouter.ai/api/v1/models" },
} as const;

// With SNAP_CONTROL_URL set, provider calls go through the control plane's metered proxy, paid
// from the signed-in user's credit: the session holds their token, never the provider key.
function endpoint(provider: keyof typeof PROVIDERS, app: string) {
  const p = PROVIDERS[provider], control = process.env.SNAP_CONTROL_URL;
  return control ? { ...p, base_url: `${control}/proxy/${app}/${provider}/v1`, env_key: "SNAP_CONTROL_TOKEN" } : p;
}

interface Price { in: number; cached: number; out: number } // USD per token

export class CodexHarness implements Harness {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private price: Promise<Price | null>;
  private turns = 0;
  sessionId: string | null;
  exited = false;
  selfTurn = false; // codex never starts a turn by itself
  onSelfTurn = null;

  constructor(private ctx: HarnessContext) {
    this.sessionId = ctx.resume;
    this.price = this.lookupPrice();
  }

  start() {
    const p = this.ctx.config.provider;
    const key = p && endpoint(p, this.ctx.app).env_key;
    if (key && !process.env[key]) throw new Error(`${key} is not set — put it in .env`);
  }

  // Codex reports tokens, not money. A provider's public model list has the prices.
  private async lookupPrice(): Promise<Price | null> {
    const { provider, model } = this.ctx.config;
    if (!provider || !model) return null;
    try {
      const list = (await (await fetch(PROVIDERS[provider].models, { signal: AbortSignal.timeout(10_000) })).json()) as { data: { id: string; pricing: Record<string, string> }[] };
      const m = list.data.find((x) => x.id === model);
      if (!m) throw new Error(`${model} is not in the provider's model list`);
      const input = Number(m.pricing.prompt);
      return { in: input, cached: Number(m.pricing.input_cache_read ?? input), out: Number(m.pricing.completion) };
    } catch (e) {
      this.ctx.log("no price for this model; its cost will not be recorded:", (e as Error).message);
      return null;
    }
  }

  private args(): { args: string[]; env: Record<string, string | undefined> } {
    const { ctx } = this, { provider, model } = ctx.config;
    const env = { ...ctx.env };
    const instructions = join(ctx.work, ".system.md");
    writeFileSync(instructions, ctx.system);
    const toml = (v: unknown) => JSON.stringify(v);
    const c = [
      // Ours replaces the stock instructions, as with Claude: the agent's job here is not coding.
      `model_instructions_file=${toml(instructions)}`,
      // `snap` and the generation CLIs are network calls, so the sandbox has to allow the network.
      `sandbox_mode=${toml(process.env.SNAP_CODEX_SANDBOX ?? "workspace-write")}`,
      "sandbox_workspace_write.network_access=true",
      `sandbox_workspace_write.writable_roots=${toml([join(DATA_DIR, "assets")])}`,
      "shell_environment_policy.inherit=\"all\"",
      "shell_environment_policy.ignore_default_excludes=true", // the default drops *KEY*/*TOKEN* vars, and `snap` and `rep` need theirs
    ];
    if (provider) {
      const p = endpoint(provider, ctx.app);
      // A home of its own: no personal config, hooks or login, and the threads stay with the project.
      env.CODEX_HOME = join(DATA_DIR, "codex-home");
      mkdirSync(env.CODEX_HOME, { recursive: true });
      c.push(`model_provider=${toml(provider)}`, `model_providers.${provider}={name=${toml(p.name)},base_url=${toml(p.base_url)},env_key=${toml(p.env_key)},wire_api="responses"}`);
    }
    const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", ...(model ? ["-m", model] : []), ...c.flatMap((kv) => ["-c", kv])];
    return { args: this.sessionId ? ["exec", "resume", this.sessionId, ...common, "-"] : ["exec", ...common, "-"], env };
  }

  async send(text: string): Promise<Turn> {
    const { ctx } = this;
    const { args, env } = this.args();
    const proc = (this.proc = Bun.spawn([process.env.SNAP_CODEX_BIN ?? "codex", ...args], { cwd: ctx.work, stdin: "pipe", stdout: "pipe", stderr: "pipe", env }));
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(text);
    stdin.end();
    const timer = setTimeout(() => proc.kill(), ctx.turnTimeoutS * 1000);

    if (!this.turns++) writeFileSync(ctx.transcript, ""); // one file per runner start, like Claude's
    const dec = new TextDecoder();
    let buf = "", last = "", failed: string | null = null;
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        appendFileSync(ctx.transcript, line + "\n");
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started") this.sessionId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") last = String(ev.item.text ?? "");
        if (ev.type === "turn.failed" || ev.type === "error") failed = String(ev.error?.message ?? ev.message ?? "turn failed");
        if (ev.type === "turn.completed" && ev.usage) {
          const price = await this.price, u = ev.usage;
          const cached = Number(u.cached_input_tokens ?? 0);
          if (price) ctx.onCost((Number(u.input_tokens ?? 0) - cached) * price.in + cached * price.cached + Number(u.output_tokens ?? 0) * price.out);
        }
      }
    }
    const code = await proc.exited;
    clearTimeout(timer);
    this.proc = null;
    if (code !== 0 && !failed) {
      const err = (await new Response(proc.stderr as ReadableStream).text()).trim().slice(-500);
      ctx.log(`codex exited ${code}`, err);
      // Nothing to resume into: let the runner start the conversation over.
      if (!this.sessionId || /no (rollout|session|thread)|not found/i.test(err)) { this.exited = true; this.sessionId = null; }
      throw new Error(`codex exited ${code}: ${err.slice(-200)}`);
    }
    return { text: failed ?? last, isError: !!failed };
  }

  stop() {
    this.proc?.kill();
  }
}
