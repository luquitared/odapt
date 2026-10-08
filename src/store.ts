// Only the server touches the store; the agent CLI and the runner go through
// HTTP. That keeps the backend swappable (SQLite here, Postgres in the cloud)
// without the container ever needing DB credentials.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { apply, type LogEvent, type Session } from "./protocol";

export interface Store {
  createSession(s: Session): void;
  getSession(id: string): Session | null;
  listSessions(limit?: number): Session[];
  // Appends the event and folds it into the session snapshot, atomically.
  append(sessionId: string, origin: LogEvent["origin"], body: LogEvent["body"]): { event: LogEvent; session: Session } | null;
  eventsAfter(sessionId: string, seq: number, limit?: number): LogEvent[];
  actionsAfter(sessionId: string, seq: number): LogEvent[];
  touchHeartbeat(sessionId: string): void;
}

export class SqliteStore implements Store {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at INTEGER NOT NULL,
        origin TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events (session_id, seq);
    `);
  }

  createSession(s: Session) {
    this.db.run("INSERT INTO sessions (id, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      s.id, JSON.stringify(s), s.createdAt, s.updatedAt,
    ]);
  }

  getSession(id: string): Session | null {
    const row = this.db.query("SELECT snapshot FROM sessions WHERE id = ?").get(id) as { snapshot: string } | null;
    return row ? JSON.parse(row.snapshot) : null;
  }

  listSessions(limit = 50): Session[] {
    const rows = this.db.query("SELECT snapshot FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit) as { snapshot: string }[];
    return rows.map((r) => JSON.parse(r.snapshot));
  }

  append(sessionId: string, origin: LogEvent["origin"], body: LogEvent["body"]) {
    return this.db.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) return null;
      const at = Date.now();
      const { lastInsertRowid } = this.db.run(
        "INSERT INTO events (session_id, at, origin, type, body) VALUES (?, ?, ?, ?, ?)",
        [sessionId, at, origin, body.type, JSON.stringify(body)],
      );
      const event: LogEvent = { seq: Number(lastInsertRowid), sessionId, at, origin, body };
      apply(session, event);
      this.db.run("UPDATE sessions SET snapshot = ?, updated_at = ? WHERE id = ?", [JSON.stringify(session), at, sessionId]);
      return { event, session };
    })();
  }

  eventsAfter(sessionId: string, seq: number, limit = 1000): LogEvent[] {
    const rows = this.db
      .query("SELECT seq, at, origin, body FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(sessionId, seq, limit) as { seq: number; at: number; origin: LogEvent["origin"]; body: string }[];
    return rows.map((r) => ({ seq: r.seq, sessionId, at: r.at, origin: r.origin, body: JSON.parse(r.body) }));
  }

  actionsAfter(sessionId: string, seq: number): LogEvent[] {
    const rows = this.db
      .query("SELECT seq, at, origin, body FROM events WHERE session_id = ? AND seq > ? AND type = 'action' ORDER BY seq")
      .all(sessionId, seq) as { seq: number; at: number; origin: LogEvent["origin"]; body: string }[];
    return rows.map((r) => ({ seq: r.seq, sessionId, at: r.at, origin: r.origin, body: JSON.parse(r.body) }));
  }

  // Heartbeats would drown the log, so they update the snapshot in place.
  touchHeartbeat(sessionId: string) {
    const s = this.getSession(sessionId);
    if (!s) return;
    s.runner.heartbeatAt = Date.now();
    this.db.run("UPDATE sessions SET snapshot = ? WHERE id = ?", [JSON.stringify(s), sessionId]);
  }
}
