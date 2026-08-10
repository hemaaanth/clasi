import { describe, expect, test } from "bun:test";
import {
  createHeadlessResponse,
  exitCodeForStatus,
  headlessChoiceRequired,
  headlessDegraded,
  headlessError,
  headlessOk,
  headlessPartial,
  headlessSetupNeeded,
} from "../src/headless-response.ts";
import type { HeadlessStatus } from "../src/headless-response.ts";

describe("headless responses", () => {
  test("every response has the exact versioned envelope", () => {
    const response = headlessOk("ready", "clasi is ready.", { count: 0 });

    expect(response).toEqual({
      exitCode: 0,
      envelope: {
        schema_version: 1,
        status: "ok",
        code: "ready",
        message: "clasi is ready.",
        data: { count: 0 },
        next_actions: [],
      },
    });
    expect(Object.keys(response.envelope)).toEqual([
      "schema_version",
      "status",
      "code",
      "message",
      "data",
      "next_actions",
    ]);
    expect(JSON.parse(JSON.stringify(response.envelope))).toEqual(response.envelope);
  });

  test.each([
    ["ok", 0],
    ["partial", 0],
    ["choice-required", 2],
    ["setup-needed", 2],
    ["degraded", 1],
    ["error", 1],
  ] as Array<[HeadlessStatus, 0 | 1 | 2]>)
  ("maps %s to exit code %i", (status, exitCode) => {
    expect(exitCodeForStatus(status)).toBe(exitCode);
    expect(createHeadlessResponse({ status, code: "fixture", message: "Fixture.", data: {} }).exitCode)
      .toBe(exitCode);
  });

  test("status helpers preserve the deterministic exit mapping", () => {
    expect(headlessChoiceRequired("confirm", "Confirmation is required.", {}, ["Confirm the action."]).exitCode)
      .toBe(2);
    expect(headlessSetupNeeded("setup", "Setup is required.", {}, ["Run clasi setup."]).exitCode)
      .toBe(2);
    expect(headlessDegraded("unsafe-root", "The root is unavailable.", {}, ["Run clasi doctor."]).exitCode)
      .toBe(1);
    expect(headlessError("failed", "The operation failed.", {}, ["Retry the operation."]).exitCode)
      .toBe(1);
    expect(headlessPartial("partial", "Some data is unavailable.", {}).exitCode).toBe(0);
  });
});
