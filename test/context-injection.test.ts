import { describe, expect, test } from "bun:test";
import { injectClasiContext, isClasiContextMessage } from "../src/context-injection.ts";
import {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "../src/runtime-types.ts";

const STALE = {
  role: "custom",
  customType: CLASI_CONTEXT_MESSAGE_TYPE,
  content: "stale",
  display: false,
  timestamp: 0,
};
const USER = { role: "user", content: "keep", timestamp: 0 };

describe("context injection", () => {
  test("retries replace every stale clasi message with exactly one current message and count it once", async () => {
    const counts: number[] = [];
    let content = "current guidance";
    const runtime = createClasiRuntime({
      readContext: () => content,
      recordInjection: characters => {
        counts.push(characters);
      },
    });

    const first = await injectClasiContext([STALE, USER, STALE], runtime);
    content = "refreshed guidance";
    const second = await injectClasiContext(first, runtime);

    expect(first.filter(isClasiContextMessage)).toHaveLength(1);
    expect(second.filter(isClasiContextMessage)).toHaveLength(1);
    expect(second[0]).toEqual(expect.objectContaining({
      role: "custom",
      customType: CLASI_CONTEXT_MESSAGE_TYPE,
      content: "refreshed guidance",
      display: false,
    }));
    expect(second[1]).toEqual(USER);
    expect(counts).toEqual(["current guidance".length, "refreshed guidance".length]);
  });

  test("empty, malformed, oversized, and throwing context removes stale messages without injection", async () => {
    const cases: Array<() => unknown> = [
      () => undefined,
      () => "",
      () => "x".repeat(CLASI_CONTEXT_MAX_CHARACTERS + 1),
      () => ({ arbitrary: "body" }),
      () => {
        throw new Error("read failed");
      },
    ];

    for (const readContext of cases) {
      let countCalls = 0;
      const result = await injectClasiContext([STALE, USER], {
        readContext: readContext as () => string | undefined,
        recordInjection: () => {
          countCalls += 1;
        },
      });
      expect(result).toEqual([USER]);
      expect(countCalls).toBe(0);
    }
  });

  test("the hard-cap boundary is accepted whole and measurement failure never blocks guidance", async () => {
    const content = "x".repeat(CLASI_CONTEXT_MAX_CHARACTERS);
    let calls = 0;
    const result = await injectClasiContext([USER], {
      readContext: () => content,
      recordInjection: () => {
        calls += 1;
        throw new Error("metrics unavailable");
      },
    });

    expect(result[0]).toEqual(expect.objectContaining({ content }));
    expect((result[0] as { content: string }).content).toHaveLength(CLASI_CONTEXT_MAX_CHARACTERS);
    expect(calls).toBe(1);
  });
});
