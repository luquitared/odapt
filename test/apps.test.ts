import { describe, expect, test } from "bun:test";
import { app, appKey, apps, hasAppKey, type App } from "../control/apps";
import { moneyError } from "../control/ledger";

describe("app registry", () => {
  test("knows agent, standalone and listed apps", () => {
    expect(app("lofiwave")?.kind).toBe("listed");
    expect(app("lofiwave")?.products).toEqual({});
    expect(app("app-ad")?.kind).toBe("agent");
    expect(app("app-ad")?.pricing?.markup).toBeGreaterThan(1);
    expect(app("nope")).toBeNull();
    expect(app("../templates")).toBeNull();
    expect(apps().map((a) => a.id)).toContain("lofiwave");
  });

  test("app keys are per app and checked exactly", () => {
    const secret = "test-secret";
    const key = appKey("example", secret);
    expect(key).not.toBe(appKey("app-ad", secret));
    expect(key).not.toBe(appKey("example", "another-secret"));
    const req = (k: string) => new Request("http://x", { headers: { authorization: `Bearer ${k}` } });
    expect(hasAppKey(req(key), "example", secret)).toBe(true);
    expect(hasAppKey(req(key), "app-ad", secret)).toBe(false);
    expect(hasAppKey(req(key.slice(0, -1)), "example", secret)).toBe(false);
    expect(hasAppKey(new Request("http://x"), "example", secret)).toBe(false);
  });
});

describe("money entries", () => {
  test("validation", () => {
    expect(moneyError({ kind: "sale", usd: 7, ref: "stripe:cs_1" })).toBeNull();
    expect(moneyError({ kind: "cost", usd: 0, ref: "muapi:1" })).toBeNull();
    expect(moneyError({ kind: "tip", usd: 1, ref: "x" })).toMatch(/kind/);
    expect(moneyError({ kind: "sale", usd: -7, ref: "x" })).toMatch(/positive/);
    expect(moneyError({ kind: "sale", usd: Number.NaN, ref: "x" })).toMatch(/positive/);
    expect(moneyError({ kind: "sale", usd: 7 })).toMatch(/ref/);
    expect(moneyError(null)).toMatch(/object/);
  });
});

describe("platform orders", () => {
  test("checkout requests are checked against the app's products", async () => {
    const { checkoutError } = await import("../control/orders");
    const a: App = {
      id: "example", name: "Example", kind: "standalone", pricing: null, repo: null,
      products: { video: { name: "One video", usd: 7 } }, providers: [], dailyProviderUsd: 20,
    };
    const ok = { order_id: "abc_123", product: "video", success_url: "https://x/j/1?cs={CHECKOUT_SESSION_ID}", cancel_url: "https://x/j/1" };
    expect(checkoutError(a, ok)).toBeNull();
    expect(checkoutError(a, { ...ok, product: "free" })).toMatch(/sells: video/);
    expect(checkoutError(a, { ...ok, order_id: "../x" })).toMatch(/order_id/);
    expect(checkoutError(a, { ...ok, success_url: "javascript:alert(1)" })).toMatch(/http/);
    expect(checkoutError(a, { ...ok, notify_url: "ftp://x" })).toMatch(/notify_url/);
  });

  test("the app can verify the platform's callback signature", async () => {
    const { signNotify } = await import("../control/orders");
    const { platform } = await import("../apps/lib/odapt");
    process.env.ODAPT_APP_KEY = "odapt_app_test";
    const odapt = platform("example", "/tmp");
    const body = JSON.stringify({ type: "order.paid", order_id: "o1" });
    const req = (sig: string) => new Request("http://x/odapt/notify", { method: "POST", headers: { "odapt-signature": sig }, body });
    expect((await odapt.verifyNotify(req(signNotify(body, "odapt_app_test"))))?.order_id).toBe("o1");
    expect(await odapt.verifyNotify(req(signNotify(body, "another_key")))).toBeNull();
    expect(await odapt.verifyNotify(req(signNotify(body, "odapt_app_test", 1_000)))).toBeNull(); // stale
    delete process.env.ODAPT_APP_KEY;
  });
});
