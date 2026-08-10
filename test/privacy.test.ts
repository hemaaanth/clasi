import { describe, expect, test } from "bun:test";
import {
  validateAndDerive,
  validatePrivateFields,
} from "../src/privacy.ts";
import { PRIVACY_SENTINELS } from "./fixtures/privacy-sentinels.ts";

describe("privacy gate", () => {
  test.each([...PRIVACY_SENTINELS])("rejects $name without deriving artifacts", sentinel => {
    let derivations = 0;

    const result = validateAndDerive(
      {
        classification: sentinel.classification ?? "generalized-derived",
        fields: { lesson: sentinel.value },
      },
      () => {
        derivations += 1;
        return {
          id: "candidate-derived-id",
          hash: "candidate-derived-hash",
          filename: "candidate-derived.md",
        };
      },
    );

    expect(result).toEqual({ ok: false, code: sentinel.reason });
    expect(derivations).toBe(0);
    expect(JSON.stringify(result)).not.toContain(sentinel.value);
    expect(JSON.stringify(result)).not.toContain("candidate-derived");
  });

  test("accepts bounded generalized fields and derives only after validation", () => {
    let derivations = 0;

    const result = validateAndDerive(
      {
        classification: "generalized-derived",
        fields: {
          situation: "The package-local binary is not exported by plugin installation.",
          action: "Run the package binary directly or install the package globally.",
          priority: 80,
          tags: ["packaging", "tooling"],
        },
      },
      () => {
        derivations += 1;
        return { id: "napkin_0123456789abcdef0123456789abcdef" };
      },
    );

    expect(result).toEqual({
      ok: true,
      value: { id: "napkin_0123456789abcdef0123456789abcdef" },
    });
    expect(derivations).toBe(1);
  });

  test("rejects unknown fields, nested objects, oversized text, and non-finite counters", () => {
    expect(
      validatePrivateFields({
        classification: "generalized-derived",
        fields: { "unsafe field": "value" },
      }),
    ).toEqual({ ok: false, code: "invalid-field" });
    expect(
      validatePrivateFields({
        classification: "generalized-derived",
        fields: { nested: { raw: "value" } },
      }),
    ).toEqual({ ok: false, code: "invalid-field" });
    expect(
      validatePrivateFields({
        classification: "generalized-derived",
        fields: { lesson: "x".repeat(241) },
      }),
    ).toEqual({ ok: false, code: "oversized-field" });
    expect(
      validatePrivateFields({
        classification: "aggregate-observation",
        fields: { count: Number.NaN },
      }),
    ).toEqual({ ok: false, code: "invalid-field" });
  });

  test("documents semantic detection as a best-effort boundary", () => {
    const result = validatePrivateFields({
      classification: "explicit-user-input",
      fields: { preference: "Prefer concise code review findings." },
    });

    expect(result).toEqual({ ok: true });
  });
});
