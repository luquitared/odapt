// Email through Resend (odapt.ai is a verified sending domain). Without RESEND_API_KEY a message is
// printed to the log instead, as in local development.

import { RESEND_API_KEY } from "./config";

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  // Resend sends a message with the same key only once (within 24 hours), so a retry can't double it.
  idempotencyKey?: string;
}

export async function sendMail(m: Mail) {
  if (!RESEND_API_KEY) {
    console.log(`[mail] from=${m.from} to=${m.to} subject="${m.subject}"\n${m.text}`);
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
      ...(m.idempotencyKey ? { "idempotency-key": m.idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, text: m.text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
}
