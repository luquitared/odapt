import { afterEach, describe, expect, test } from "bun:test";
import { controlEnv, controlUrl, pricing } from "../src/account";

const saved = { url: process.env.SNAP_CONTROL_URL, token: process.env.SNAP_CONTROL_TOKEN };
afterEach(() => {
  for (const [k, v] of [["SNAP_CONTROL_URL", saved.url], ["SNAP_CONTROL_TOKEN", saved.token]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("account", () => {
  test("no control plane from the repo unless SNAP_CONTROL_URL is set; empty turns it off", () => {
    delete process.env.SNAP_CONTROL_URL;
    expect(controlUrl()).toBeNull();
    process.env.SNAP_CONTROL_URL = "";
    expect(controlUrl()).toBeNull();
    process.env.SNAP_CONTROL_URL = "https://api.example.com/";
    expect(controlUrl()).toBe("https://api.example.com");
  });

  test("runners get the control plane and a token only together", () => {
    process.env.SNAP_CONTROL_URL = "https://api.example.com";
    process.env.SNAP_CONTROL_TOKEN = "tok";
    expect(controlEnv()).toEqual({ SNAP_CONTROL_URL: "https://api.example.com", SNAP_CONTROL_TOKEN: "tok" });
    delete process.env.SNAP_CONTROL_URL;
    expect(controlEnv()).toEqual({});
  });

  test("packs come from the session's app when it's billable, else the first billable one", () => {
    expect(pricing("app-ad")?.app).toBe("app-ad");
    expect(pricing("name-lab")?.app).toBe("app-ad");
    expect(pricing()?.packs.length).toBeGreaterThan(0);
  });
});
