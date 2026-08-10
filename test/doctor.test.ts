import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getHeadlessDoctor } from "../src/doctor.ts";
import type { RuntimeEnvironmentReady, RuntimeEnvironmentResult } from "../src/runtime-environment.ts";
import type { StoreFixture } from "./support/store-fixture.ts";
import { withStoreFixture } from "./support/store-fixture.ts";

const MACHINE_ID = "machine_11111111111111111111111111111111";

function ready(
  fixture: StoreFixture,
  overrides: Partial<RuntimeEnvironmentReady> = {},
): RuntimeEnvironmentReady {
  return {
    status: "ready",
    config: {
      dataRoot: fixture.roots.dataRoot,
      napkinCategoryCap: 5,
      contextCharacterCap: 6_000,
    },
    roots: fixture.roots,
    controlPin: fixture.controlPin,
    dataPin: fixture.dataPin,
    paths: fixture.paths,
    store: fixture.store,
    machineId: MACHINE_ID,
    scopes: [{ type: "global", id: "global" }],
    capabilities: { repositoryScope: "not-repository", requiresReattachOnMove: false },
    degradations: [],
    ...overrides,
  };
}

function runtime(result: RuntimeEnvironmentResult) {
  return async () => result;
}

describe("headless doctor", () => {
  test("the default ready path checks roots, schema reads, locks, and transactions", async () => {
    await withStoreFixture(async fixture => {
      const result = await getHeadlessDoctor("/unused", { runtime: runtime(ready(fixture)) });

      expect(result.exitCode).toBe(0);
      expect(result.envelope.status).toBe("ok");
      expect(result.envelope.code).toBe("doctor-clean");
      expect(result.envelope.data.checks).toEqual({
        control_root: "ok",
        data_root: "ok",
        schema_reads: "ok",
        repository_identity: "not-applicable",
        locks: "ok",
        transactions: "ok",
      });
      expect(JSON.stringify(result.envelope.data)).not.toContain("not-inspected");
      expect(result.envelope.data.checks).not.toHaveProperty("built_in_memory");
    });
  });

  test("setup is action-required and runtime degradation exposes no raw error context", async () => {
    const setup = await getHeadlessDoctor("/secret/worktree", {
      runtime: runtime({ status: "setup-needed", code: "setup-needed" }),
    });
    expect(setup.exitCode).toBe(2);
    expect(setup.envelope.status).toBe("setup-needed");

    const degraded = await getHeadlessDoctor("/secret/worktree", {
      runtime: runtime({ status: "degraded", code: "unsafe-control-root" }),
      lastGoodActive: true,
    });
    expect(degraded.exitCode).toBe(1);
    expect(degraded.envelope.status).toBe("degraded");
    expect(degraded.envelope.data).toEqual({
      reason_codes: ["unsafe-control-root"],
      affected_scope: "runtime",
      document_type: null,
      checks: {
        control_root: "unavailable",
        data_root: "unavailable",
        schema_reads: "disabled",
        repository_identity: "unavailable",
        locks: "not-inspected",
        transactions: "not-inspected",
      },
      disabled_reads: ["all"],
      disabled_writes: ["all"],
      last_good_active: true,
      unaffected_operations: ["help", "version", "doctor"],
      recovery_command: "clasi doctor",
    });
    expect(JSON.stringify(degraded.envelope)).not.toContain("/secret/worktree");
  });

  test("a schema-read failure disables memory without leaking the thrown error", async () => {
    await withStoreFixture(async fixture => {
      const result = await getHeadlessDoctor("/unused", {
        runtime: runtime(ready(fixture)),
        schemaRead: async () => {
          throw new Error("/private/customer/path terminal output");
        },
        lastGoodActive: true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.envelope.status).toBe("degraded");
      expect(result.envelope.code).toBe("schema-read-disabled");
      expect(result.envelope.data.disabled_reads).toEqual(["memory"]);
      expect(result.envelope.data.disabled_writes).toEqual(["memory"]);
      expect(result.envelope.data.last_good_active).toBe(true);
      expect(JSON.stringify(result.envelope)).not.toContain("private/customer");
      expect(JSON.stringify(result.envelope)).not.toContain("terminal output");
    });
  });

  test("repository identity and injected built-in memory metadata produce usable partial state", async () => {
    await withStoreFixture(async fixture => {
      const environment = ready(fixture, {
        capabilities: { repositoryScope: "unavailable", requiresReattachOnMove: false },
        degradations: ["git-unavailable"],
      });
      const result = await getHeadlessDoctor("/unused", {
        runtime: runtime(environment),
        hostMetadata: { builtInMemoryEnabled: true },
      });

      expect(result.exitCode).toBe(0);
      expect(result.envelope.status).toBe("partial");
      expect(result.envelope.data.reason_codes).toEqual([
        "repository-identity-unavailable",
        "built-in-memory-coexistence",
      ]);
      expect(result.envelope.data.disabled_reads).toEqual(["repository"]);
      expect(result.envelope.data.disabled_writes).toEqual(["repository"]);
      expect(result.envelope.data.checks.built_in_memory).toBe("enabled");
    });
  });

  test("default coordination scanning reports retained state without names or paths", async () => {
    await withStoreFixture(async fixture => {
      await mkdir(join(fixture.paths.lockDirectory, "opaque-lock"), { recursive: true });
      await mkdir(join(fixture.paths.transactionDirectory, "opaque-transaction"), { recursive: true });

      const result = await getHeadlessDoctor("/unused", { runtime: runtime(ready(fixture)) });

      expect(result.exitCode).toBe(0);
      expect(result.envelope.status).toBe("partial");
      expect(result.envelope.data.checks.locks).toBe("present");
      expect(result.envelope.data.checks.transactions).toBe("present");
      expect(result.envelope.data.disabled_writes).toEqual([]);
      expect(result.envelope.data.unaffected_operations).toContain("review");
      const serialized = JSON.stringify(result.envelope);
      expect(serialized).not.toContain("opaque-lock");
      expect(serialized).not.toContain("opaque-transaction");
      expect(serialized).not.toContain(fixture.roots.controlRoot);
      expect(serialized).not.toContain(fixture.roots.dataRoot);
    });
  });
});
