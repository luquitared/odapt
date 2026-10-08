// The one thing this app does, for one paid order. Write the result into `dir` and return what the order
// page should show. Throwing fails the order and refunds it.
//
// A paid provider goes through the platform (its key and cost tracking stay in the control plane): list it
// in app.json "providers", then
//   const p = odapt.provider("muapi");  fetch(p.url("/api/v1/..."), { headers: p.headers })

import type { Order } from "./orders";

export async function work(order: Order, dir: string): Promise<{ text?: string; file?: string }> {
  await Bun.write(`${dir}/result.txt`, `You asked for: ${order.input.prompt}\n`);
  return { text: `Done: ${order.input.prompt}`, file: "result.txt" };
}
