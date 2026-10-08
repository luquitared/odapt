// The control plane: accounts, credits, Stripe, and the metered proxy every app's model and media
// calls go through. One service for all apps; everything it stores carries an app id.

import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const PORT = Number(process.env.CONTROL_PORT ?? 7790);
export const PUBLIC_URL = process.env.CONTROL_PUBLIC_URL ?? `http://127.0.0.1:${PORT}`;

// Postgres, e.g. postgres://control:…@<host>:5432/odapt?sslmode=require
export const DATABASE_URL = process.env.CONTROL_DATABASE_URL ?? "";

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";

// Unset → login links are printed to the log instead of emailed.
export const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
export const MAIL_FROM = process.env.CONTROL_MAIL_FROM ?? "Odapt <login@odapt.ai>";
// The address standalone apps' order emails come from, under the app's name.
export const ORDERS_MAIL = process.env.CONTROL_ORDERS_MAIL ?? "orders@odapt.ai";

// Upstream keys live here and nowhere else; apps hold only a user token.
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN ?? "";
// Voice calls (GPT-Live, control/live.ts).
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Raw provider spend across all users, per UTC day. Past it, the proxy refuses until tomorrow.
export const DAILY_CAP_USD = Number(process.env.CONTROL_DAILY_CAP_USD ?? 20);

// Signs Better Auth's cookies and tokens. Required; `openssl rand -base64 32`.
export const AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "";
// Google sign-in, from a Google Cloud OAuth client (Web). Unset → only email links.
// Redirect URI to register: <CONTROL_PUBLIC_URL>/api/auth/callback/google
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
