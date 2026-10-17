// A template is a directory. Adding an app is adding a folder:
//
//   templates/<id>/
//     template.json   what the picker shows + the input form + which tools it needs (src/tools.ts)
//     system.md       appended to the agent's system prompt
//     kickoff.md      the first user message; {{input}} / {{input.<field>}} / {{mode}} are filled in
//     workspace/      copied into the session's working directory (CLAUDE.md, examples, …)
//     voice.md        with `voice` in template.json: the voice's own prompt on a call (src/voice.ts)
//
// `"ui": {"html": true}` lets the agent draw its own panels as sandboxed HTML (prompts/html-panels.md):
// for apps whose page is the product (a game, a board, a live view) or whose design should change on request.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, TEMPLATES_DIR } from "./config";
import type { HarnessConfig } from "./harness";

export interface TemplateInput {
  id: string;
  label: string;
  type: "text" | "textarea" | "url" | "select" | "number";
  options?: string[];
  required?: boolean;
  default?: string | number;
  placeholder?: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  icon?: string;
  modes: ("job" | "editor")[];
  inputs: TemplateInput[];
  tools: string[]; // catalog tools the agent uses itself; their doc.md goes into its prompt
  requires?: string[]; // catalog tools that must be installed but aren't documented to the agent (its scripts use them)
  agentTools?: string[]; // Claude's built-in tools for this app; default Bash, Read, Write, Edit
  harness?: string | HarnessConfig; // preset name from harnesses.json, or inline; default "claude"
  model?: string; // Claude's model for this app; SNAP_MODEL overrides
  voice?: { voice?: string }; // people can talk to it (src/voice.ts); `voice` is GPT-Live's voice, default marin
  ui?: { html?: boolean }; // html: the agent may draw `html` panels (prompts/html-panels.md)
  dir: string;
}

export function listTemplates(): Template[] {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(TEMPLATES_DIR, d.name, "template.json")))
    .map((d) => loadTemplate(d.name)!)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function loadTemplate(id: string): Template | null {
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  const dir = join(TEMPLATES_DIR, id);
  const file = join(dir, "template.json");
  if (!existsSync(file)) return null;
  const t = JSON.parse(readFileSync(file, "utf8"));
  return { modes: ["job", "editor"], inputs: [], tools: [], ...t, id, dir };
}

export function readTemplateFile(t: Template, name: string): string {
  const f = join(t.dir, name);
  return existsSync(f) ? readFileSync(f, "utf8") : "";
}

export function fill(text: string, vars: { input: Record<string, unknown>; mode: string }): string {
  return text
    .replace(/\{\{input\.([a-zA-Z0-9_]+)\}\}/g, (_, k) => String(vars.input[k] ?? ""))
    .replace(/\{\{input\}\}/g, JSON.stringify(vars.input, null, 2))
    .replace(/\{\{mode\}\}/g, vars.mode);
}

// Apps the engine doesn't run (apps/<id>/app.json: standalone and listed), for the home page to link
// out to. A listed app has its `landing`; a standalone one is served at api.odapt.ai/<deploy.path>.
export interface OtherApp { id: string; name: string; description: string; kind: "standalone" | "listed"; url: string | null }

export function listApps(): OtherApp[] {
  const dir = join(ROOT, "apps");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((id) => /^[a-z0-9-]+$/.test(id) && existsSync(join(dir, id, "app.json")))
    .map((id) => {
      const a = JSON.parse(readFileSync(join(dir, id, "app.json"), "utf8"));
      const kind = a.kind === "listed" ? "listed" : "standalone";
      const url = a.landing ?? (a.deploy?.path ? `https://api.odapt.ai${a.deploy.path}/` : null);
      return { id, name: a.name ?? id, description: a.description ?? "", kind, url } as OtherApp;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
