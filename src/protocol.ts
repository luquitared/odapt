// The wire protocol. Everything the UI shows is a fold over an append-only
// event log; the session row is just that fold, materialized.

export type SessionStatus =
  | "created" // row exists, no runner yet
  | "working" // agent is mid-turn
  | "waiting" // agent ended its turn; it's the user's move
  | "idle" // runner parked; any action wakes it
  | "done"
  | "failed";

export type Mode = "job" | "editor";

export type PanelStatus = "working" | "ready" | "approved" | "failed";

// A panel is one thing the agent has put in front of the user. `kind` picks the
// renderer in the UI; unknown kinds fall back to a JSON view, so a new app can
// ship before its renderer does.
export interface Panel {
  id: string;
  kind: string; // markdown | form | script | gallery | video | json | …
  title: string;
  status: PanelStatus;
  data: unknown;
  actions: PanelAction[]; // buttons the user may press
  order: number;
  updatedAt: number;
}

export interface PanelAction {
  id: string; // comes back as action.type
  label: string;
  style?: "primary" | "default" | "danger";
}

export interface Ask {
  id: string;
  text: string;
  kind: "choice" | "text" | "confirm";
  options: { id: string; label: string }[];
  answer: unknown | null;
  askedAt: number;
}

export interface Session {
  id: string;
  templateId: string;
  mode: Mode;
  mock: boolean;
  status: SessionStatus;
  input: Record<string, unknown>;
  title: string;
  panels: Record<string, Panel>;
  asks: Record<string, Ask>;
  focus: string | null; // panel the agent last navigated the user to
  result: { summary: string; assets: string[] } | null;
  cost: { totalUsd: number; bySource: Record<string, number> };
  runner: { state: "none" | "starting" | "running" | "parked"; heartbeatAt: number; pid?: number };
  harness?: string; // preset from harnesses.json chosen for this session; absent = the template's
  claudeSessionId: string | null; // the harness's conversation id (bare = Claude's, else "<type>:<id>")
  actionCursor: number; // seq of the last action the runner consumed
  createdAt: number;
  updatedAt: number;
}

// Agent/runner → log
export type EmitBody =
  | { type: "progress"; text: string; kind?: "progress" | "info" | "error" }
  | { type: "message"; text: string } // agent prose, shown in the chat feed
  | { type: "panel.set"; panel: Partial<Panel> & { id: string } }
  | { type: "panel.patch"; id: string; data: Record<string, unknown>; status?: PanelStatus }
  | { type: "panel.remove"; id: string }
  | { type: "ask"; ask: Pick<Ask, "id" | "text" | "kind" | "options"> }
  | { type: "asset"; url: string; name: string; panel?: string; slot?: string; mime?: string }
  | { type: "navigate"; panel: string }
  | { type: "toast"; text: string }
  | { type: "voice"; who: "user" | "assistant"; text: string } // a caption from a voice call (src/voice.ts)
  | { type: "voice.instruct"; text: string } // the agent steering the voice on a call (`snap voice`)
  | { type: "cost"; source: string; usd: number }
  | { type: "title"; title: string }
  | { type: "done"; summary: string; assets?: string[] }
  | { type: "status"; status: SessionStatus; reason?: string }
  | { type: "runner"; state: Session["runner"]["state"]; pid?: number; claudeSessionId?: string; actionCursor?: number };

// User → log. `type` is a panel action id, or one of the built-ins:
// "message" (free text), "answer" (reply to an ask), "edit" (changed panel data),
// "voice" (something said on a voice call that the voice handed to the app: payload {said, before}).
export interface ActionBody {
  type: string;
  panel?: string;
  ask?: string;
  payload?: unknown;
}

export interface LogEvent {
  seq: number;
  sessionId: string;
  at: number;
  origin: "agent" | "user" | "system";
  body: EmitBody | ({ type: "action" } & { action: ActionBody });
}

export function newSession(p: Pick<Session, "id" | "templateId" | "mode" | "mock" | "input" | "title" | "harness">): Session {
  const now = Date.now();
  return {
    ...p,
    status: "created",
    panels: {},
    asks: {},
    focus: null,
    result: null,
    cost: { totalUsd: 0, bySource: {} },
    runner: { state: "none", heartbeatAt: 0 },
    claudeSessionId: null,
    actionCursor: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// The fold. Pure, so the UI could run it too.
export function apply(s: Session, e: LogEvent): Session {
  const b = e.body;
  s.updatedAt = e.at;
  switch (b.type) {
    case "panel.set": {
      const base: Panel = s.panels[b.panel.id] ?? {
        id: b.panel.id, kind: "json", title: b.panel.id, status: "ready", data: null, actions: [],
        order: Object.keys(s.panels).length, updatedAt: e.at,
      };
      s.panels[b.panel.id] = { ...base, ...b.panel, updatedAt: e.at };
      s.focus = b.panel.id;
      break;
    }
    case "panel.patch": {
      const p = s.panels[b.id];
      if (!p) break;
      p.data = { ...((p.data as object) ?? {}), ...b.data };
      if (b.status) p.status = b.status;
      p.updatedAt = e.at;
      break;
    }
    case "panel.remove":
      delete s.panels[b.id];
      break;
    case "ask":
      s.asks[b.ask.id] = { ...b.ask, answer: null, askedAt: e.at };
      break;
    case "asset": {
      if (!b.panel) break;
      const p = s.panels[b.panel];
      if (!p) break;
      const data = ((p.data as Record<string, unknown>) ??= {});
      const assets = ((data.assets as Record<string, unknown>) ??= {});
      assets[b.slot ?? b.name] = { url: b.url, name: b.name, mime: b.mime };
      p.data = data;
      p.updatedAt = e.at;
      break;
    }
    case "navigate":
      s.focus = b.panel;
      break;
    case "cost":
      s.cost.totalUsd += b.usd;
      s.cost.bySource[b.source] = (s.cost.bySource[b.source] ?? 0) + b.usd;
      break;
    case "title":
      s.title = b.title;
      break;
    case "done":
      s.status = "done";
      s.result = { summary: b.summary, assets: b.assets ?? [] };
      break;
    case "status":
      s.status = b.status;
      break;
    case "runner":
      s.runner = { ...s.runner, state: b.state, pid: b.pid ?? s.runner.pid, heartbeatAt: e.at };
      if (b.claudeSessionId) s.claudeSessionId = b.claudeSessionId;
      if (b.actionCursor) s.actionCursor = Math.max(s.actionCursor, b.actionCursor);
      break;
    case "action": {
      const a = b.action;
      if (a.type === "answer" && a.ask && s.asks[a.ask]) s.asks[a.ask].answer = a.payload ?? null;
      if (a.type === "approve" && a.panel && s.panels[a.panel]) s.panels[a.panel].status = "approved";
      if (a.type === "edit" && a.panel && s.panels[a.panel] && a.payload && typeof a.payload === "object") {
        const p = s.panels[a.panel];
        p.data = { ...((p.data as object) ?? {}), ...(a.payload as object) };
      }
      break;
    }
  }
  return s;
}
