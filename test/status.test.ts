import { describe, expect, test } from "bun:test";
import { sep } from "node:path";
import { getHeadlessConfig, getHeadlessStatus } from "../src/status.ts";
import type { RuntimeEnvironmentReady, RuntimeEnvironmentResult } from "../src/runtime-environment.ts";

const HOME = "/home/alice";
const MACHINE_ID = "machine_11111111111111111111111111111111";
const REPOSITORY_KEY = "repo_22222222222222222222222222222222";

function ready(overrides: Partial<RuntimeEnvironmentReady> = {}): RuntimeEnvironmentReady {
  return {
    status: "ready",
    config: {
      dataRoot: `${HOME}/sync/clasi`,
      napkinCategoryCap: 5,
      contextCharacterCap: 6_000,
    },
    roots: { controlRoot: `${HOME}/.pi/clasi`, dataRoot: `${HOME}/sync/clasi` },
    controlPin: undefined as never,
    dataPin: undefined as never,
    paths: undefined as never,
    store: undefined as never,
    machineId: MACHINE_ID,
    scopes: [
      { type: "global", id: "global" },
      { type: "machine", id: MACHINE_ID },
      { type: "repository", id: REPOSITORY_KEY },
    ],
    repositoryKey: REPOSITORY_KEY,
    capabilities: { repositoryScope: "attached", requiresReattachOnMove: false },
    degradations: [],
    ...overrides,
  };
}

function runtime(result: RuntimeEnvironmentResult) {
  return async () => result;
}

describe("headless status and config", () => {
  test("status exposes only safe opaque runtime identity and HOME-collapsed configuration", async () => {
    const result = await getHeadlessStatus("/workspace/customer/acme", {
      runtime: runtime(ready()),
      runtimeOptions: { env: { HOME, USER: "alice", HOSTNAME: "private-host" } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.status).toBe("ok");
    expect(result.envelope.data).toEqual({
      machine_id: MACHINE_ID,
      repository_key: REPOSITORY_KEY,
      scopes: [
        { type: "global", id: "global" },
        { type: "machine", id: MACHINE_ID },
        { type: "repository", id: REPOSITORY_KEY },
      ],
      data_root: ["${HOME}", "sync", "clasi"].join(sep),
      caps: { napkin_category: 5, context_characters: 6_000 },
      capabilities: { repository_scope: "attached", requires_reattach_on_move: false },
      degradations: [],
    });

    const serialized = JSON.stringify(result.envelope);
    expect(serialized).not.toContain("/workspace/customer/acme");
    expect(serialized).not.toContain("private-host");
    expect(serialized).not.toContain("/home/alice");
  });

  test("a usable capability degradation is partial and keeps exit code zero", async () => {
    const environment = ready({
      scopes: [
        { type: "global", id: "global" },
        { type: "machine", id: MACHINE_ID },
      ],
      capabilities: { repositoryScope: "unavailable", requiresReattachOnMove: false },
      degradations: ["git-unavailable"],
    });
    delete environment.repositoryKey;
    const result = await getHeadlessStatus("/work", {
      runtime: runtime(environment),
      runtimeOptions: { env: { HOME } },
    });

    expect(result.exitCode).toBe(0);
    expect(result.envelope.status).toBe("partial");
    expect(result.envelope.code).toBe("repository-capability-limited");
    expect(result.envelope.data).not.toHaveProperty("repository_key");
  });

  test("setup-needed is action-required while runtime degradation fails closed", async () => {
    const setup = await getHeadlessStatus("/work", {
      runtime: runtime({ status: "setup-needed", code: "setup-needed" }),
    });
    expect(setup).toEqual({
      exitCode: 2,
      envelope: {
        schema_version: 1,
        status: "setup-needed",
        code: "setup-needed",
        message: "clasi setup is required.",
        data: {},
        next_actions: ["Run clasi setup."],
      },
    });

    const degraded = await getHeadlessStatus("/secret/worktree", {
      runtime: runtime({ status: "degraded", code: "unsafe-data-root" }),
    });
    expect(degraded.exitCode).toBe(1);
    expect(degraded.envelope.status).toBe("degraded");
    expect(degraded.envelope.data).toEqual({
      reason_code: "unsafe-data-root",
      affected_scope: "runtime",
      document_type: null,
      disabled_reads: ["memory"],
      disabled_writes: ["memory"],
      last_good_active: false,
      unaffected_operations: ["help", "version", "doctor"],
      recovery_command: "clasi doctor",
    });
    expect(JSON.stringify(degraded.envelope)).not.toContain("/secret/worktree");
  });

  test("config omits machine and repository identities", async () => {
    const result = await getHeadlessConfig("/work", {
      runtime: runtime(ready()),
      runtimeOptions: { env: { HOME } },
    });

    expect(result.envelope.status).toBe("ok");
    expect(Object.keys(result.envelope.data).sort()).toEqual([
      "capabilities",
      "caps",
      "data_root",
      "degradations",
    ]);
    expect(JSON.stringify(result.envelope.data)).not.toContain(MACHINE_ID);
    expect(JSON.stringify(result.envelope.data)).not.toContain(REPOSITORY_KEY);
  });
});
