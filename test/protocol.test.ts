import { expect, test } from "bun:test";
import { apply, newSession, type LogEvent } from "../src/protocol";

let seq = 0;
const ev = (body: LogEvent["body"], origin: LogEvent["origin"] = "agent"): LogEvent => ({ seq: ++seq, sessionId: "s", at: seq, origin, body });
const fresh = () => newSession({ id: "s", templateId: "t", mode: "editor", mock: true, input: {}, title: "T" });

test("panel.set creates, then updates in place keeping order", () => {
  const s = fresh();
  apply(s, ev({ type: "panel.set", panel: { id: "a", kind: "markdown", title: "A", data: { markdown: "hi" } } }));
  apply(s, ev({ type: "panel.set", panel: { id: "b" } }));
  apply(s, ev({ type: "panel.set", panel: { id: "a", status: "approved" } }));
  expect(s.panels.a).toMatchObject({ kind: "markdown", title: "A", status: "approved", order: 0, data: { markdown: "hi" } });
  expect(s.panels.b.order).toBe(1);
  expect(s.focus).toBe("a");
});

test("assets land in their slot; patches merge shallowly", () => {
  const s = fresh();
  apply(s, ev({ type: "panel.set", panel: { id: "g", kind: "gallery", data: { items: [{ id: "s1" }] } } }));
  apply(s, ev({ type: "asset", url: "/assets/s/x.png", name: "x.png", panel: "g", slot: "s1" }));
  apply(s, ev({ type: "panel.patch", id: "g", data: { note: "n" }, status: "ready" }));
  expect(s.panels.g.data).toMatchObject({ items: [{ id: "s1" }], note: "n", assets: { s1: { url: "/assets/s/x.png" } } });
});

test("answers, approvals, cost and done fold into the snapshot", () => {
  const s = fresh();
  apply(s, ev({ type: "panel.set", panel: { id: "p" } }));
  apply(s, ev({ type: "ask", ask: { id: "q", text: "?", kind: "choice", options: [{ id: "y", label: "Y" }] } }));
  apply(s, ev({ type: "action", action: { type: "answer", ask: "q", payload: "y" } }, "user"));
  apply(s, ev({ type: "action", action: { type: "approve", panel: "p" } }, "user"));
  apply(s, ev({ type: "cost", source: "claude", usd: 0.25 }));
  apply(s, ev({ type: "cost", source: "claude", usd: 0.5 }));
  apply(s, ev({ type: "done", summary: "ok" }));
  expect(s.asks.q.answer).toBe("y");
  expect(s.panels.p.status).toBe("approved");
  expect(s.cost).toEqual({ totalUsd: 0.75, bySource: { claude: 0.75 } });
  expect(s.status).toBe("done");
});

test("runner events carry the resume handle and only ever advance the cursor", () => {
  const s = fresh();
  apply(s, ev({ type: "runner", state: "running", claudeSessionId: "c1", actionCursor: 9 }));
  apply(s, ev({ type: "runner", state: "parked", actionCursor: 4 }));
  expect(s).toMatchObject({ claudeSessionId: "c1", actionCursor: 9, runner: { state: "parked" } });
});
