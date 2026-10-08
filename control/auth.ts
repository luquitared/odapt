// Sign-in, on Better Auth. Passwordless: Google, or an emailed link (printed to the log until
// RESEND_API_KEY is set). A desktop app signs in with a device code (RFC 8628): it shows a short
// code and opens /device; the person signs in there and approves; the app, polling
// /api/auth/device/token, gets a session token it sends as `Authorization: Bearer`.
//
// Better Auth's user is our `users` table (uuid ids, so credit_ledger's foreign key holds); its
// other tables are auth_*. Every column is snake_case, mapped below. Schema: control/schema.sql.

import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, magicLink } from "better-auth/plugins";
import { Pool } from "pg";
import { AUTH_SECRET, DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MAIL_FROM, PUBLIC_URL } from "./config";
import { sendMail } from "./mail";
import { pricing } from "./ledger";

const snake = (...fields: string[]) => Object.fromEntries(fields.map((f) => [f, f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]));

// Cloud SQL's server certificate is signed by its own CA, so node-postgres can't verify it against the
// system roots; the connection is still encrypted. (sslmode in the URL would override this, so drop it.)
function pool(url: string) {
  const u = new URL(url);
  const ssl = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  return new Pool({ connectionString: u.toString(), ssl: ssl && ssl !== "disable" ? { rejectUnauthorized: false } : undefined, max: 5 });
}

export const googleEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

export const auth = betterAuth({
  appName: "Odapt",
  baseURL: PUBLIC_URL,
  secret: AUTH_SECRET,
  database: pool(DATABASE_URL),
  trustedOrigins: [PUBLIC_URL],
  advanced: { database: { generateId: "uuid" }, cookiePrefix: "odapt" },
  user: { modelName: "users", fields: snake("emailVerified", "createdAt", "updatedAt") },
  session: {
    modelName: "auth_sessions",
    fields: snake("userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"),
    expiresIn: 60 * 60 * 24 * 90, // desktop apps hold one for months; it slides forward with use
    updateAge: 60 * 60 * 24,
  },
  account: {
    modelName: "auth_accounts",
    fields: snake("userId", "accountId", "providerId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "createdAt", "updatedAt"),
    // Google verifies the address, so signing in with it joins the account made by an email link.
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  verification: { modelName: "auth_verifications", fields: snake("expiresAt", "createdAt", "updatedAt") },
  socialProviders: googleEnabled ? { google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, prompt: "select_account" } } : {},
  plugins: [
    bearer(),
    magicLink({
      expiresIn: 15 * 60,
      sendMagicLink: async ({ email, url }) => sendMail({ from: MAIL_FROM, to: email, subject: "Your Odapt sign-in link", text: `Sign in to Odapt: ${url}\n\nThe link works once, for 15 minutes.` }),
    }),
    deviceAuthorization({
      verificationUri: `${PUBLIC_URL}/device`,
      expiresIn: "15m",
      interval: "3s",
      // The client id is the app asking; only billable apps can sign people in.
      validateClient: (clientId) => !!pricing(clientId),
      schema: {
        deviceCode: {
          modelName: "auth_device_codes",
          fields: snake("deviceCode", "userCode", "userId", "expiresAt", "status", "lastPolledAt", "pollingInterval", "clientId", "scope"),
        },
      },
    }),
  ],
});

export type SignedIn = { id: string; email: string };

/** The signed-in user, from the session cookie or `Authorization: Bearer <session token>`. */
export async function authenticate(req: Request): Promise<SignedIn | null> {
  const s = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  return s ? { id: s.user.id, email: s.user.email } : null;
}

export const normalizeEmail = (e: unknown) => {
  const s = String(e ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

