import { expect, test } from "bun:test";
import { resolveHarness, resumeId, storeId } from "../src/harness";

test("first choice that is set wins; nothing set means claude", () => {
  expect(resolveHarness(undefined, "codex", "claude").name).toBe("codex");
  expect(resolveHarness(undefined, undefined, { type: "codex", model: "x" }).config.model).toBe("x");
  expect(resolveHarness().config.type).toBe("claude");
  expect(() => resolveHarness("nope")).toThrow();
});

test("a conversation id is only resumed by the harness that made it", () => {
  expect(resumeId("claude", "abc")).toBe("abc");
  expect(resumeId("codex", "abc")).toBeNull();
  expect(resumeId("codex", storeId("codex", "t1")!)).toBe("t1");
  expect(resumeId("claude", "codex:t1")).toBeNull();
  expect(storeId("claude", null)).toBeUndefined();
});
