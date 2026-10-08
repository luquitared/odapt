// Signing this Mac in to the control plane (control/), whose wallet pays for every paid call a
// session makes. Device sign-in (RFC 8628): we ask for a code, the person approves it on the control
// plane's /device page in their browser, and a poll here gets a session token. The token lives in
// DATA_DIR/account.json and reaches runners as SNAP_CONTROL_TOKEN (src/launcher.ts); the runner and
// the Codex harness point every provider at the metered proxy with it.
//
// Packaged, the control plane is https://api.odapt.ai. From the repo it's SNAP_CONTROL_URL, and
// without it sessions use the developer's own provider keys, as before. SNAP_CONTROL_TOKEN in the
// environment overrides the stored sign-in.

import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, PACKAGED, TEMPLATES_DIR } from "./config";

// The control plane refuses calls below this balance (control/proxy.ts).
export const MIN_BALANCE_USD = 0.01;

// Read when needed, not at import: the app loads odapt.env after config.ts (src/main.ts).
export function controlUrl(): string | null {
  const u = process.env.SNAP_CONTROL_URL ?? (PACKAGED ? "https://api.odapt.ai" : "");
  return u ? u.replace(/\/$/, "") : null;
}

const FILE = () => join(DATA_DIR, "account.json");

function stored(): { token: string; email?: string } | null {
  try { return JSON.parse(readFileSync(FILE(), "utf8")); } catch { return null; }
}

function save(a: { token: string; email?: string }) {
  writeFileSync(FILE(), JSON.stringify(a, null, 2));
  chmodSync(FILE(), 0o600);
}

export const token = () => process.env.SNAP_CONTROL_TOKEN || stored()?.token || null;

/** What a runner needs to bill the signed-in user; empty when there's no control plane. */
export function controlEnv(): Record<string, string> {
  const url = controlUrl(), t = token();
  return url && t ? { SNAP_CONTROL_URL: url, SNAP_CONTROL_TOKEN: t } : {};
}

/** The app whose packs we sell and whose name signs the device in: the given one if it's billable. */
export function pricing(app?: string): { app: string; packs: { id: string; label: string; usd: number }[] } | null {
  const ids = existsSync(TEMPLATES_DIR) ? readdirSync(TEMPLATES_DIR).sort() : [];
  for (const id of app ? [app, ...ids] : ids) {
    const f = join(TEMPLATES_DIR, id, "pricing.json");
    if (/^[a-z0-9-]+$/.test(id) && existsSync(f)) return { app: id, packs: JSON.parse(readFileSync(f, "utf8")).packs ?? [] };
  }
  return null;
}

async function control(method: string, path: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const t = token();
  if (auth && t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(`${controlUrl()}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

// ---------------------------------------------------------------- sign-in

interface Pending { userCode: string; url: string; expiresAt: number; error?: string }
let pending: Pending | null = null;
let polling: ReturnType<typeof setTimeout> | null = null;

export async function startSignIn(app?: string): Promise<Pending> {
  if (!controlUrl()) throw new Error("no control plane (SNAP_CONTROL_URL)");
  const clientId = pricing(app)?.app;
  if (!clientId) throw new Error("no billable app (templates/<id>/pricing.json)");
  const r = await control("POST", "/api/auth/device/code", { client_id: clientId }, false);
  if (r.status !== 200) throw new Error(r.body.error_description ?? r.body.error ?? `device code: ${r.status}`);
  const d = r.body as { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number };
  pending = { userCode: d.user_code, url: d.verification_uri_complete, expiresAt: Date.now() + d.expires_in * 1000 };
  if (polling) clearTimeout(polling);
  const mine = pending;
  let interval = Math.max(1, d.interval) * 1000;
  const poll = async () => {
    if (pending !== mine) return;
    if (Date.now() > mine.expiresAt) return void (mine.error = "The code expired. Start again.");
    const t = await control("POST", "/api/auth/device/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: d.device_code, client_id: clientId }, false).catch(() => null);
    if (t?.status === 200 && t.body.access_token) {
      save({ token: t.body.access_token });
      pending = null;
      const me = await control("GET", "/me").catch(() => null);
      if (me?.status === 200) save({ token: t.body.access_token, email: me.body.email });
      return;
    }
    const err = t?.body?.error;
    if (err === "access_denied") return void (mine.error = "Sign-in was cancelled.");
    if (err === "expired_token") return void (mine.error = "The code expired. Start again.");
    if (err === "slow_down") interval += 5000;
    polling = setTimeout(poll, interval);
  };
  polling = setTimeout(poll, interval);
  return pending;
}

export async function signOut() {
  if (pending) pending = null;
  if (stored()) {
    await control("POST", "/api/auth/sign-out", {}).catch(() => null);
    rmSync(FILE(), { force: true });
  }
}

export interface Account {
  control: string | null; // null: no control plane, sessions use local provider keys
  signedIn: boolean;
  email?: string;
  balanceUsd?: number;
  minBalanceUsd: number;
  app?: string;
  packs: { id: string; label: string; usd: number }[];
  signIn?: Pending; // a device sign-in waiting for approval
  error?: string; // couldn't reach the control plane
}

export async function account(app?: string): Promise<Account> {
  const p = pricing(app);
  const base: Account = { control: controlUrl(), signedIn: false, minBalanceUsd: MIN_BALANCE_USD, app: p?.app, packs: p?.packs ?? [] };
  if (!base.control) return base;
  if (pending) base.signIn = pending;
  if (!token()) return base;
  const me = await control("GET", "/me").catch((e) => ({ status: 0, body: { error: String(e.message ?? e) } }));
  if (me.status === 401 && !process.env.SNAP_CONTROL_TOKEN) {
    rmSync(FILE(), { force: true }); // expired or revoked
    return base;
  }
  if (me.status !== 200) return { ...base, signedIn: true, email: stored()?.email, error: me.body.error ?? `control plane: ${me.status}` };
  return { ...base, signedIn: true, email: me.body.email, balanceUsd: me.body.balance_usd };
}

/** A Stripe Checkout URL for one of the app's credit packs. */
export async function buy(app: string | undefined, pack: string): Promise<string> {
  const p = pricing(app);
  if (!p) throw new Error("no billable app");
  const r = await control("POST", "/billing/checkout", { app: p.app, pack });
  if (r.status !== 200 || !r.body.url) throw new Error(r.body.error ?? `checkout: ${r.status}`);
  return r.body.url;
}
