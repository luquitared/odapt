// Claude Code, held open as ONE stream-json conversation for the life of the runner, so the
// agent keeps everything it has learned without any of it being re-passed.

import type { Harness, HarnessContext, Turn } from "../harness";

// Every tool definition is re-read on every model call, so a session gets only what it uses.
const DEFAULT_TOOLS = ["Bash", "Read", "Write", "Edit"];

export class ClaudeHarness implements Harness {
  private proc!: ReturnType<typeof Bun.spawn>;
  private pending: { resolve: (t: Turn) => void; reject: (e: Error) => void } | null = null;
  private lastCost = 0; // total_cost_usd is cumulative per process — only ever report the delta
  sessionId: string | null = null;
  exited = false;
  selfTurn = false; // the agent woke itself (a background task finished) and is working unprompted
  onSelfTurn: ((phase: "start" | "end", turn?: Turn) => void) | null = null;

  constructor(private ctx: HarnessContext) {}

  start() {
    const { ctx } = this;
    const tools = process.env.SNAP_ALLOWED_TOOLS?.split(",") ?? ctx.config.tools ?? DEFAULT_TOOLS;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-mode", process.env.SNAP_PERMISSION_MODE ?? "acceptEdits",
      "--tools", tools.join(","),
      "--allowedTools", ...tools,
      // Nothing personal belongs in a session: no MCP servers, and no user settings, skills,
      // plugins or CLAUDE.md. Together with replacing the stock system prompt (rather than
      // appending to it) this took the starting context from ~40k tokens to ~12k — and every
      // model call in a session pays for the starting context again.
      "--strict-mcp-config",
      "--setting-sources", "",
      process.env.SNAP_FULL_PROMPT === "1" ? "--append-system-prompt" : "--system-prompt", ctx.system,
      ...(ctx.config.model ? ["--model", ctx.config.model] : []),
      ...(ctx.resume ? ["--resume", ctx.resume] : []),
    ];
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...env } = ctx.env;
    // .env carries an API key for the cloud spikes. Locally the logged-in CLI should be
    // used, not metered API billing, unless that is asked for explicitly.
    if (process.env.SNAP_USE_API_KEY !== "1") delete env.ANTHROPIC_API_KEY;
    this.proc = Bun.spawn([process.env.SNAP_CLAUDE_BIN ?? "claude", ...args], { cwd: ctx.work, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    this.read();
    this.proc.exited.then(async (code) => {
      this.exited = true;
      const err = await new Response(this.proc.stderr as ReadableStream).text();
      ctx.log(`claude exited ${code}`, err.trim().slice(-500));
      this.pending?.reject(new Error(`claude exited ${code} mid-turn`));
      this.pending = null;
    });
  }

  private async read() {
    const dec = new TextDecoder();
    let buf = "";
    const transcript = Bun.file(this.ctx.transcript).writer();
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        transcript.write(line + "\n");
        transcript.flush();
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "system" && msg.subtype === "init") this.sessionId = msg.session_id;
        if (msg.type === "assistant" && !this.pending && !this.selfTurn) {
          this.selfTurn = true;
          this.onSelfTurn?.("start");
        }
        if (msg.type === "result") {
          const total = Number(msg.total_cost_usd ?? 0);
          const delta = Math.max(0, total - this.lastCost);
          this.lastCost = total;
          if (delta > 0) this.ctx.onCost(delta);
          const turn = { text: String(msg.result ?? ""), isError: !!msg.is_error };
          if (this.pending) this.pending.resolve(turn);
          else if (this.selfTurn) { this.selfTurn = false; this.onSelfTurn?.("end", turn); }
          this.pending = null;
        }
      }
    }
  }

  send(text: string): Promise<Turn> {
    if (this.exited) return Promise.reject(new Error("claude is not running"));
    const turn = new Promise<Turn>((resolve, reject) => (this.pending = { resolve, reject }));
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
    stdin.flush();
    const timeout = new Promise<Turn>((_, reject) => setTimeout(() => reject(new Error(`turn exceeded ${this.ctx.turnTimeoutS}s`)), this.ctx.turnTimeoutS * 1000));
    return Promise.race([turn, timeout]);
  }

  stop() {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    setTimeout(() => this.proc.kill(), 2000);
  }
}
