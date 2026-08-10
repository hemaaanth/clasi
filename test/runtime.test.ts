import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  createConfiguredClasiRuntime,
} from "../src/runtime.ts";
import type {
  ConfiguredRuntimeServices,
} from "../src/runtime.ts";
import type { RuntimeEnvironmentReady, RuntimeEnvironmentResult } from "../src/runtime-environment.ts";
import type { ScopeRef } from "../src/paths.ts";
import type { ActiveViewResult } from "../src/active-view.ts";
import type { NapkinCurateResult } from "../src/napkin-service.ts";
import type { PapercutRecord } from "../src/schema.ts";
import { opaque } from "./support/store-fixture.ts";

const GLOBAL = { type: "global", id: "global" } as const satisfies ScopeRef;
const MACHINE = {
  type: "machine",
  id: opaque("machine", 1),
} as const satisfies ScopeRef;
const REPOSITORY_A = {
  type: "repository",
  id: opaque("repo", 1),
} as const satisfies ScopeRef;
const REPOSITORY_B = {
  type: "repository",
  id: opaque("repo", 2),
} as const satisfies ScopeRef;
const NOW = "2026-08-09T12:00:00.000Z";

interface ServiceHarness {
  services: ConfiguredRuntimeServices;
  calls: string[];
  injections: number[];
  viewBuilds: number;
}

function environment(scopes: ScopeRef[]): RuntimeEnvironmentReady {
  return {
    status: "ready",
    config: {
      dataRoot: "/tmp/clasi-data",
      napkinCategoryCap: 5,
      contextCharacterCap: 6_000,
    },
    roots: { controlRoot: "/tmp/clasi-control", dataRoot: "/tmp/clasi-data" },
    controlPin: {} as RuntimeEnvironmentReady["controlPin"],
    dataPin: {} as RuntimeEnvironmentReady["dataPin"],
    paths: {} as RuntimeEnvironmentReady["paths"],
    store: {} as RuntimeEnvironmentReady["store"],
    machineId: MACHINE.id,
    scopes,
    capabilities: { repositoryScope: "attached", requiresReattachOnMove: false },
    degradations: [],
  };
}

function papercut(): PapercutRecord {
  return {
    id: opaque("cut", 1),
    fingerprint: "repeatable-friction",
    summary: "A repeatable workflow failed.",
    severity: "minor",
    prevention: "Use the validated workflow.",
    acceptanceCondition: "The workflow completes.",
    sourceClassification: "explicit-user-input",
    lifecycle: "open",
    repairState: "running",
    publicationState: "none",
    publicationIssueNumber: null,
    recurrence: 1,
    relatedIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function serviceHarness(options: {
  views?: ActiveViewResult[];
  curateResult?: NapkinCurateResult;
  throwOnInjection?: number;
} = {}): ServiceHarness {
  const calls: string[] = [];
  const injections: number[] = [];
  const views = options.views ?? [];
  const cut = papercut();
  const harness: ServiceHarness = {
    calls,
    injections,
    viewBuilds: 0,
    services: undefined as unknown as ConfiguredRuntimeServices,
  };
  harness.services = {
    context: {
      readScope: async scope => {
        calls.push("get-context");
        return { status: "empty", scope };
      },
    },
    proposals: {
      submitContext: async () => {
        calls.push("propose-context");
        return {
          status: "proposed",
          proposalId: opaque("proposal", 1),
          revisionId: opaque("rev", 1),
        };
      },
    },
    napkin: {
      list: async () => {
        calls.push("get-napkin");
        return { status: "ok", categoryCap: 5, records: [] };
      },
      curate: async () => {
        calls.push("curate-napkin");
        return options.curateResult ?? {
          status: "created",
          id: opaque("napkin", 1),
          active: true,
          revisionId: opaque("rev", 2),
        };
      },
      markHit: async () => {
        calls.push("mark-hit");
        return {
          status: "recorded",
          id: opaque("napkin", 1),
          hitCount: 1,
          active: true,
          revisionId: opaque("rev", 3),
        };
      },
    },
    papercuts: {
      inbox: async () => {
        calls.push("get-papercuts");
        return { status: "ok", records: [cut] };
      },
      capture: async () => {
        calls.push("capture-papercut");
        return { status: "created", record: cut };
      },
      reportRepair: async (_scope, _id, outcome) => {
        calls.push(`repair:${outcome}`);
        return { status: "updated", record: { ...cut, repairState: outcome } };
      },
    },
    activeView: {
      build: async () => {
        const index = harness.viewBuilds++;
        return views[index] ?? {
          status: "ok",
          content: `view-${index + 1}`,
          serializedCharacters: 6,
          omittedItems: 0,
          openPapercuts: { minor: 0, major: 0, blocker: 0 },
        };
      },
    },
    impact: {
      recordInjectedCharacters: async (_machineId, characters) => {
        injections.push(characters);
        if (characters === options.throwOnInjection) throw new Error("metrics unavailable");
        return { status: "recorded" };
      },
    },
  };
  return harness;
}

function extensionContext(notifications: string[] = []): ExtensionContext {
  return {
    cwd: "/repo",
    hasUI: false,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;
}

describe("configured clasi runtime", () => {
  test("binds cache to normalized scopes, preserves same-scope last-good, and clears on identity changes", async () => {
    const outcomes: RuntimeEnvironmentResult[] = [
      environment([REPOSITORY_A, GLOBAL, MACHINE]),
      environment([GLOBAL, MACHINE, REPOSITORY_A]),
      environment([GLOBAL, MACHINE, REPOSITORY_B]),
      { status: "setup-needed", code: "setup-needed" },
    ];
    const harness = serviceHarness({
      views: [
        {
          status: "ok",
          content: "repository-a",
          serializedCharacters: 12,
          omittedItems: 0,
          openPapercuts: { minor: 0, major: 0, blocker: 0 },
        },
        { status: "unavailable", code: "napkin-unavailable" },
        { status: "unavailable", code: "context-unavailable" },
      ],
    });
    const runtime = createConfiguredClasiRuntime({
      resolveEnvironment: async () => outcomes.shift() ?? { status: "degraded", code: "invalid-config" },
      createServices: () => harness.services,
    });

    expect(await runtime.refresh("/repo-a")).toEqual({ status: "ready" });
    expect(await runtime.readContext()).toBe("repository-a");
    expect(await runtime.refresh("/repo-a-again")).toEqual({
      status: "degraded",
      code: "active-view-unavailable",
      notify: true,
    });
    expect(await runtime.readContext()).toBe("repository-a");
    expect(await runtime.refresh("/repo-b")).toEqual({
      status: "degraded",
      code: "active-view-unavailable",
      notify: true,
    });
    expect(await runtime.readContext()).toBeUndefined();
    expect(await runtime.refresh("/unconfigured")).toEqual({
      status: "setup-needed",
      code: "setup-needed",
      notify: true,
    });
    expect(await runtime.readContext()).toBeUndefined();
  });

  test("gates scopes and dispatches exactly the eight safe tool operations", async () => {
    const harness = serviceHarness();
    const runtime = createConfiguredClasiRuntime({
      resolveEnvironment: async () => environment([GLOBAL, MACHINE, REPOSITORY_A]),
      createServices: () => harness.services,
    });
    const context = extensionContext();
    await runtime.refresh("/repo");

    expect(await runtime.handleTool("clasi_get_context", { scope: "global" }, context))
      .toMatchObject({ status: "ok", changed: false });
    expect(await runtime.handleTool("clasi_propose_context", {
      scope: "global",
      logicalKey: "package-manager",
      kind: "preference",
      value: "Use Bun.",
      sourceClassification: "explicit-user-input",
      priority: 90,
    }, context)).toMatchObject({ status: "ok", changed: true });
    expect(await runtime.handleTool("clasi_get_napkin", {
      scope: "machine",
      scopeId: MACHINE.id,
    }, context)).toMatchObject({ status: "ok", changed: false });
    expect(await runtime.handleTool("clasi_curate_napkin", {
      scope: "repository",
      scopeId: REPOSITORY_A.id,
      logicalKey: "validate-first",
      category: "Validation",
      priority: 80,
      situation: "before a durable write",
      action: "validate the candidate",
      sourceClassification: "generalized-derived",
    }, context)).toMatchObject({ status: "ok", changed: true });
    expect(await runtime.handleTool("clasi_mark_hit", {
      scope: "global",
      id: opaque("napkin", 1),
    }, context)).toMatchObject({ status: "ok", changed: true });
    expect(await runtime.handleTool("clasi_get_papercuts", { scope: "global" }, context))
      .toMatchObject({ status: "ok", changed: false });
    expect(await runtime.handleTool("clasi_capture_papercut", {
      scope: "global",
      fingerprint: "repeatable-friction",
      summary: "A repeatable workflow failed.",
      severity: "minor",
      prevention: "Use the validated workflow.",
      acceptanceCondition: "The workflow completes.",
      sourceClassification: "generalized-derived",
    }, context)).toMatchObject({ status: "ok", changed: true });
    expect(await runtime.handleTool("clasi_update_repair", {
      scope: "global",
      id: opaque("cut", 1),
      repairState: "running",
    }, context)).toMatchObject({ status: "ok", changed: true });

    expect(harness.calls).toEqual([
      "get-context",
      "propose-context",
      "get-napkin",
      "curate-napkin",
      "mark-hit",
      "get-papercuts",
      "capture-papercut",
      "repair:running",
    ]);
    expect(harness.viewBuilds).toBe(6);
    expect(await runtime.readContext()).toBe("view-6");

    expect(await runtime.handleTool("clasi_get_context", {
      scope: "repository",
      scopeId: REPOSITORY_B.id,
    }, context)).toEqual({ status: "rejected", code: "scope-not-applicable", changed: false });
    expect(await runtime.handleTool("clasi_update_repair", {
      scope: "global",
      id: opaque("cut", 1),
      repairState: "dispatched",
    }, context)).toEqual({
      status: "rejected",
      code: "repair-transition-not-reportable",
      changed: false,
    });
    expect(harness.viewBuilds).toBe(6);
  });

  test("does not refresh after candidates or rejected writes", async () => {
    const harness = serviceHarness({
      curateResult: { status: "candidates", candidateIds: [opaque("napkin", 2)] },
    });
    harness.services.proposals.submitContext = async () => ({
      status: "rejected",
      code: "approval-required",
    });
    const runtime = createConfiguredClasiRuntime({
      resolveEnvironment: async () => environment([GLOBAL]),
      createServices: () => harness.services,
    });
    const context = extensionContext();
    await runtime.refresh("/repo");

    expect(await runtime.handleTool("clasi_propose_context", {
      scope: "global",
      logicalKey: "preference",
      kind: "preference",
      value: "Use the local tool.",
      sourceClassification: "explicit-user-input",
      priority: 50,
    }, context)).toEqual({
      status: "rejected",
      code: "approval-required",
      changed: false,
    });
    expect(await runtime.handleTool("clasi_curate_napkin", {
      scope: "global",
      logicalKey: "candidate",
      category: "Execution",
      priority: 50,
      situation: "when execution repeats",
      action: "use the existing candidate",
      sourceClassification: "generalized-derived",
    }, context)).toEqual({
      status: "candidates",
      changed: false,
      candidateIds: [opaque("napkin", 2)],
    });
    expect(harness.viewBuilds).toBe(1);
  });

  test("records exact injected characters and dispatches the default command without eager I/O", async () => {
    let environmentReads = 0;
    const notifications: string[] = [];
    const harness = serviceHarness({ throwOnInjection: 23 });
    const runtime = createConfiguredClasiRuntime({
      resolveEnvironment: async () => {
        environmentReads += 1;
        return environment([GLOBAL]);
      },
      createServices: () => harness.services,
    });

    expect(environmentReads).toBe(0);
    await runtime.refresh("/repo");
    await runtime.recordInjection(17);
    await runtime.recordInjection(23);
    await runtime.recordInjection(-1);
    expect(harness.injections).toEqual([17, 23]);
    expect(environmentReads).toBe(1);

    await runtime.handleCommand("", extensionContext(notifications));
    expect(notifications).toEqual([
      "Interactive clasi requires a TUI. Use the headless clasi CLI instead.",
    ]);
    expect(environmentReads).toBe(1);
  });
});
