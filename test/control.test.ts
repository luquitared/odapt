import { describe, expect, test } from "bun:test";
import { createTarget, estimate, usageCost } from "../control/proxy";
import { form, verifySignature } from "../control/stripe";

const sign = (payload: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${new Bun.CryptoHasher("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("stripe", () => {
  test("form encodes nested objects the way Stripe expects", () => {
    expect(form({ a: 1, line_items: { 0: { price_data: { currency: "usd" } } }, skip: undefined }).toString())
      .toBe("a=1&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd");
  });

  test("webhook signatures", async () => {
    const body = '{"id":"evt_1"}';
    expect(await verifySignature(body, sign(body, "whsec_x"), "whsec_x")).toBe(true);
    expect(await verifySignature(body + " ", sign(body, "whsec_x"), "whsec_x")).toBe(false);
    expect(await verifySignature(body, sign(body, "whsec_other"), "whsec_x")).toBe(false);
    expect(await verifySignature(body, sign(body, "whsec_x", 1_000), "whsec_x")).toBe(false); // replayed
    expect(await verifySignature(body, null, "whsec_x")).toBe(false);
  });
});

describe("replicate pricing", () => {
  test("estimates from the request's own inputs", () => {
    expect(estimate("minimax/image-01", { number_of_images: 2 })).toBeCloseTo(0.02);
    expect(estimate("minimax/h3", { duration: 5, resolution: "768P" })).toBeCloseTo(0.4);
    expect(estimate("minimax/h3", { duration: 5, resolution: "2K" })).toBeCloseTo(0.65);
    expect(estimate("minimax/speech-2.8-turbo", { text: "hi" })).toBe(0.005);
    expect(estimate("someone/unpriced", {})).toBeNull();
  });

  test("knows which calls create predictions", () => {
    expect(createTarget("POST", "models/minimax/h3/predictions", {})).toEqual({ model: "minimax/h3" });
    expect(createTarget("POST", "predictions", { version: "minimax/h3:abc" })).toEqual({ model: "minimax/h3" });
    expect(createTarget("POST", "predictions", { version: "abc123" })).toEqual({ model: null });
    expect(createTarget("GET", "predictions/abc", {})).toBeNull();
  });
});

describe("openrouter usage", () => {
  test("prefers the cost the provider reports", async () => {
    expect(await usageCost({ type: "response.completed", response: { id: "gen-1", usage: { cost: 0.0012 } } }, null))
      .toEqual({ id: "gen-1", usd: 0.0012 });
    expect(await usageCost({ id: "gen-2", usage: { cost: 0.5, prompt_tokens: 9 } }, null)).toEqual({ id: "gen-2", usd: 0.5 });
    expect(await usageCost({ type: "response.output_text.delta" }, null)).toBeNull();
  });
});
