import { describe, expect, test } from "bun:test";
import {
  createPaseoRepairAdapter,
  RepairService,
} from "../src/repair.ts";
import type {
  DispatchRepairInput,
  RepairDispatchAdapter,
  RepairEffectResult,
  RepairHandoff,
  RepairPapercuts,
  RepairVerifier,
} from "../src/repair.ts";
import type { ProcessInvocation, ProcessResult } from "../src/exec.ts";
import type { ScopeRef } from "../src/paths.ts";
import type {
  DurableNapkinProposalInput,
  PapercutArchiveResult,
  PapercutTransitionResult,
} from "../src/papercut-service.ts";
import type { PapercutRecord, RepairState } from "../src/schema.ts";
import { opaque } from "./support/store-fixture.ts";

const REPOSITORY = {
  type: "repository",
  id: opaque("repo", 1),
} as const satisfies ScopeRef;
const CUT_ID = opaque("cut", 1);
const NOW = "2026-08-09T12:00:00.000Z";

class FakePapercuts implements RepairPapercuts {
  record: PapercutRecord;
  readonly calls: string[] = [];
  resolveOptions: { durableNapkinProposal?: DurableNapkinProposalInput } | undefined;

  constructor(repairState: RepairState = "none", summary = "A repeatable workflow failed.") {
    this.record = {
      id: CUT_ID,
      fingerprint: "repeatable-friction",
      summary,
      severity: "minor",
      prevention: "Use the validated workflow.",
      acceptanceCondition: "The workflow completes.",
      sourceClassification: "explicit-user-input",
      lifecycle: "open",
      repairState,
      publicationState: "none",
      publicationIssueNumber: null,
      recurrence: 1,
      relatedIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  async get() {
    this.calls.push("read");
    return {
      status: "ok" as const,
      location: this.record.lifecycle === "open" ? "open" as const : "archive" as const,
      record: this.record,
    };
  }

  async queueRepair(): Promise<PapercutTransitionResult> {
    this.calls.push("queue");
    return this.#transition(
      this.record.repairState === "none" || this.record.repairState === "failed",
      "queued",
    );
  }

  async reportRepair(
    _scope: ScopeRef,
    _id: string,
    outcome: "dispatched" | "running" | "awaiting_verification" | "failed" | "indeterminate",
  ): Promise<PapercutTransitionResult> {
    this.calls.push(`report:${outcome}`);
    const allowed: Partial<Record<RepairState, readonly string[]>> = {
      queued: ["dispatched", "failed", "indeterminate"],
      dispatched: ["running", "failed", "indeterminate"],
      running: ["awaiting_verification", "failed", "indeterminate"],
      awaiting_verification: ["indeterminate"],
    };
    return this.#transition(allowed[this.record.repairState]?.includes(outcome) === true, outcome);
  }

  async verifyRepair(
    _scope: ScopeRef,
    _id: string,
    accepted: boolean,
  ): Promise<PapercutTransitionResult> {
    this.calls.push(`verify:${accepted}`);
    return this.#transition(
      this.record.repairState === "awaiting_verification",
      accepted ? "verified" : "failed",
    );
  }

  async reconcileRepair(
    _scope: ScopeRef,
    _id: string,
    outcome: "queued" | "dispatched" | "running" | "awaiting_verification" | "failed",
  ): Promise<PapercutTransitionResult> {
    this.calls.push(`reconcile:${outcome}`);
    return this.#transition(this.record.repairState === "indeterminate", outcome);
  }

  async resubmitRepair(): Promise<PapercutTransitionResult> {
    this.calls.push("resubmit");
    return this.#transition(this.record.repairState === "indeterminate", "queued");
  }

  async resolve(
    _scope: ScopeRef,
    _id: string,
    options?: { durableNapkinProposal?: DurableNapkinProposalInput },
  ): Promise<PapercutArchiveResult> {
    this.calls.push("resolve");
    this.resolveOptions = options;
    if (this.record.repairState !== "verified") {
      return { status: "rejected", code: "repair-not-verified" };
    }
    this.record = { ...this.record, lifecycle: "resolved" };
    return {
      status: "archived",
      record: this.record,
      ...(options?.durableNapkinProposal === undefined
        ? {}
        : {
            napkinProposalSuggestion: {
              targetType: "napkin" as const,
              ...options.durableNapkinProposal,
            },
          }),
    };
  }

  #transition(allowed: boolean, repairState: RepairState): PapercutTransitionResult {
    if (!allowed) return { status: "rejected", code: "illegal-transition" };
    this.record = { ...this.record, repairState };
    return { status: "updated", record: this.record };
  }
}

function dispatchInput(confirmed = true): DispatchRepairInput {
  return {
    repositoryScope: REPOSITORY,
    repositoryKey: REPOSITORY.id,
    cutId: CUT_ID,
    cwd: "/repo",
    confirmed,
  };
}

const resolveRepositoryKey = async (_cwd: string): Promise<string> => REPOSITORY.id;

function verifier(status: "passed" | "failed" | "ambiguous" = "passed"): RepairVerifier {
  return { verify: async () => ({ status }) };
}

function adapter(
  availability: "available" | "unavailable" | "unauthenticated",
  effect: RepairEffectResult = { status: "acknowledged" },
  calls: string[] = [],
): RepairDispatchAdapter {
  return {
    availability: async () => availability,
    dispatch: async () => {
      calls.push("effect");
      return effect;
    },
  };
}

const adapterSelectionCases = [
  ["available", "paseo"],
  ["unavailable", "follow-up"],
  ["unauthenticated", "follow-up"],
] as const;

const effectCases = [
  [
    { status: "definitive-failure", code: "creation-failed" },
    { status: "failed", code: "creation-failed" },
    "failed",
  ],
  [
    { status: "ambiguous", code: "ack-timeout" },
    { status: "indeterminate", code: "ack-timeout" },
    "indeterminate",
  ],
] as const;

describe("repair service", () => {
  test.each([...adapterSelectionCases])(
    "selects Paseo status %s with %s dispatch",
    async (availability, expected) => {
    const papercuts = new FakePapercuts();
    const paseoCalls: string[] = [];
    const followUpCalls: string[] = [];
    const service = new RepairService({
      papercuts,
      paseo: adapter(availability, { status: "acknowledged" }, paseoCalls),
      followUp: adapter("available", { status: "acknowledged" }, followUpCalls),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    expect(await service.dispatch(dispatchInput())).toEqual({
      status: "dispatched",
      adapter: expected,
    });
    expect(papercuts.calls.slice(0, 3)).toEqual(["read", "queue", "report:dispatched"]);
    expect(paseoCalls.length).toBe(expected === "paseo" ? 1 : 0);
    expect(followUpCalls.length).toBe(expected === "follow-up" ? 1 : 0);
    },
  );

  test("persists queued state before any adapter effect", async () => {
    const papercuts = new FakePapercuts();
    const order = papercuts.calls;
    const service = new RepairService({
      papercuts,
      paseo: adapter("available", { status: "acknowledged" }, order),
      followUp: adapter("available"),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    await service.dispatch(dispatchInput());
    expect(order).toEqual(["read", "queue", "effect", "report:dispatched"]);
  });

  test("binds dispatch to the repository currently resolved from cwd before queue or effect", async () => {
    for (const [resolvedKey, cwd, code] of [
      [opaque("repo", 2), "/repo", "repository-target-mismatch"],
      [REPOSITORY.id, "/wrong-repository", "repository-target-unavailable"],
    ] as const) {
      const papercuts = new FakePapercuts();
      const effects: string[] = [];
      const service = new RepairService({
        papercuts,
        paseo: adapter("available", { status: "acknowledged" }, effects),
        followUp: adapter("available"),
        verifier: verifier(),
        resolveRepositoryKey: async requestedCwd =>
          requestedCwd === "/repo" ? resolvedKey : null,
      });

      expect(await service.dispatch({ ...dispatchInput(), cwd })).toEqual({
        status: "rejected",
        code,
      });
      expect(papercuts.calls).toEqual([]);
      expect(effects).toEqual([]);
    }
  });

  test.each([...effectCases])(
    "classifies adapter result %# without guessing",
    async (effect, expected, state) => {
    const papercuts = new FakePapercuts();
    const service = new RepairService({
      papercuts,
      paseo: adapter("available", effect),
      followUp: adapter("available"),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    expect(await service.dispatch(dispatchInput())).toEqual(expected);
    expect(papercuts.record.repairState).toBe(state);
    },
  );

  test("classifies an adapter crash as indeterminate", async () => {
    const papercuts = new FakePapercuts();
    const service = new RepairService({
      papercuts,
      paseo: {
        availability: async () => "available",
        dispatch: async () => {
          throw new Error("agent process crashed");
        },
      },
      followUp: adapter("available"),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    expect(await service.dispatch(dispatchInput())).toEqual({
      status: "indeterminate",
      code: "adapter-crashed",
    });
    expect(papercuts.record.repairState).toBe("indeterminate");
  });

  test("cancels only before acknowledgment and records a definitive failed state", async () => {
    const papercuts = new FakePapercuts();
    let resolveEffect: ((effect: RepairEffectResult) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      signalStarted = resolve;
    });
    const pending = new Promise<RepairEffectResult>(resolve => {
      resolveEffect = resolve;
    });
    const service = new RepairService({
      papercuts,
      paseo: {
        availability: async () => "available",
        dispatch: async () => {
          signalStarted?.();
          return pending;
        },
        cancel: async () => ({ status: "canceled" }),
      },
      followUp: adapter("available"),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    const dispatch = service.dispatch(dispatchInput());
    const reachedAdapter = await Promise.race([
      started.then(() => true),
      dispatch.then(() => false),
    ]);
    if (!reachedAdapter) {
      resolveEffect?.({ status: "ambiguous", code: "test-release" });
      throw new Error("dispatch rejected before reaching the adapter");
    }
    const cancellation = await service.cancel({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      confirmed: true,
    });
    resolveEffect?.({ status: "acknowledged" });

    expect(cancellation).toEqual({ status: "canceled" });
    expect(await dispatch).toEqual({ status: "canceled" });
    expect(papercuts.record.repairState).toBe("failed");
  });

  test("fails closed on repeated dispatch and gates indeterminate reconcile and resubmit", async () => {
    const papercuts = new FakePapercuts();
    let externalEffects = 0;
    const acknowledged: RepairDispatchAdapter = {
      availability: async () => "available",
      dispatch: async () => {
        externalEffects += 1;
        return { status: "acknowledged" };
      },
    };
    const service = new RepairService({
      papercuts,
      paseo: acknowledged,
      followUp: acknowledged,
      verifier: verifier(),
      resolveRepositoryKey,
    });

    await service.dispatch(dispatchInput());
    expect(await service.dispatch(dispatchInput())).toEqual({
      status: "rejected",
      code: "repair-already-started",
    });
    expect(externalEffects).toBe(1);

    papercuts.record = { ...papercuts.record, repairState: "indeterminate" };
    expect(await service.reconcile({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      confirmed: false,
      observedState: "failed",
    })).toEqual({ status: "rejected", code: "confirmation-required" });
    expect(await service.reconcile({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      confirmed: true,
      observedState: "failed",
    })).toEqual({ status: "reconciled", repairState: "failed" });

    papercuts.record = { ...papercuts.record, repairState: "indeterminate" };
    expect(await service.resubmit(dispatchInput(false))).toEqual({
      status: "rejected",
      code: "confirmation-required",
    });
    expect(await service.resubmit(dispatchInput())).toEqual({
      status: "dispatched",
      adapter: "paseo",
    });
    expect(externalEffects).toBe(2);
  });

  test("accepts legal agent reports and verifies only observed acceptance success", async () => {
    const papercuts = new FakePapercuts("dispatched");
    const successful = new RepairService({
      papercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier("passed"),
      resolveRepositoryKey,
    });

    expect(await successful.report({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      repairState: "running",
    })).toEqual({ status: "reported", repairState: "running" });
    expect(await successful.report({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      repairState: "awaiting_verification",
    })).toEqual({ status: "reported", repairState: "awaiting_verification" });
    expect(await successful.verify(dispatchInput())).toEqual({ status: "verified" });
    expect(papercuts.record.repairState).toBe("verified");

    const failedPapercuts = new FakePapercuts("awaiting_verification");
    const failed = new RepairService({
      papercuts: failedPapercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier("failed"),
      resolveRepositoryKey,
    });
    expect(await failed.verify(dispatchInput())).toEqual({ status: "verification-failed" });
    expect(failedPapercuts.record.repairState).toBe("failed");

    const ambiguousPapercuts = new FakePapercuts("awaiting_verification");
    const ambiguous = new RepairService({
      papercuts: ambiguousPapercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier("ambiguous"),
      resolveRepositoryKey,
    });
    expect(await ambiguous.verify(dispatchInput())).toEqual({
      status: "indeterminate",
      code: "verification-ambiguous",
    });
    expect(ambiguousPapercuts.record.repairState).toBe("indeterminate");
  });

  test("resolves verified repairs and curates only an explicitly durable lesson", async () => {
    const identity = {
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
    };
    let curateCalls = 0;
    const plainPapercuts = new FakePapercuts("verified");
    const plain = new RepairService({
      papercuts: plainPapercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier(),
      napkin: {
        curate: async () => {
          curateCalls += 1;
          return {
            status: "created",
            id: opaque("napkin", 1),
            active: true,
            revisionId: opaque("rev", 1),
          };
        },
      },
      resolveRepositoryKey,
    });
    expect(await plain.resolve({ ...identity, confirmed: false })).toEqual({
      status: "rejected",
      code: "confirmation-required",
    });
    expect(await plain.resolve({ ...identity, confirmed: true })).toEqual({
      status: "resolved",
      napkinOutcome: "not-requested",
    });
    expect(curateCalls).toBe(0);

    const durableNapkinProposal = {
      durable: true,
      logicalKey: "verified-workflow",
      category: "Validation",
      priority: 70,
      situation: "A repaired workflow can regress.",
      action: "Use the verified workflow.",
      sourceClassification: "generalized-derived",
    } as const satisfies DurableNapkinProposalInput;
    const durablePapercuts = new FakePapercuts("verified");
    const curatedInputs: unknown[] = [];
    const durable = new RepairService({
      papercuts: durablePapercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier(),
      napkin: {
        curate: async input => {
          curatedInputs.push(input);
          return {
            status: "created",
            id: opaque("napkin", 2),
            active: true,
            revisionId: opaque("rev", 2),
          };
        },
      },
      resolveRepositoryKey,
    });
    expect(await durable.resolve({
      ...identity,
      confirmed: true,
      durableNapkinProposal,
    })).toEqual({ status: "resolved", napkinOutcome: "created" });
    expect(durablePapercuts.resolveOptions).toEqual({ durableNapkinProposal });
    expect(curatedInputs).toEqual([{
      scope: REPOSITORY,
      logicalKey: "verified-workflow",
      category: "Validation",
      priority: 70,
      situation: "A repaired workflow can regress.",
      action: "Use the verified workflow.",
      sourceClassification: "generalized-derived",
    }]);
  });

  test("reports partial resolution when durable Napkin curation needs an explicit target", async () => {
    const papercuts = new FakePapercuts("verified");
    const service = new RepairService({
      papercuts,
      paseo: adapter("available"),
      followUp: adapter("available"),
      verifier: verifier(),
      napkin: {
        curate: async () => ({
          status: "candidates",
          candidateIds: [opaque("napkin", 3)],
        }),
      },
      resolveRepositoryKey,
    });
    expect(await service.resolve({
      repositoryScope: REPOSITORY,
      repositoryKey: REPOSITORY.id,
      cutId: CUT_ID,
      confirmed: true,
      durableNapkinProposal: {
        durable: true,
        logicalKey: "verified-workflow",
        category: "Validation",
        priority: 70,
        situation: "A repaired workflow can regress.",
        action: "Use the verified workflow.",
        sourceClassification: "generalized-derived",
      },
    })).toEqual({
      status: "partially-resolved",
      code: "napkin-candidates",
      candidateIds: [opaque("napkin", 3)],
    });
    expect(papercuts.record.lifecycle).toBe("resolved");
  });

  test("rejects unsafe handoff text before external dispatch", async () => {
    const papercuts = new FakePapercuts("none", "$ npm test\nsecret terminal output");
    let dispatched = false;
    const service = new RepairService({
      papercuts,
      paseo: {
        availability: async () => "available",
        dispatch: async () => {
          dispatched = true;
          return { status: "acknowledged" };
        },
      },
      followUp: adapter("available"),
      verifier: verifier(),
      resolveRepositoryKey,
    });

    expect(await service.dispatch(dispatchInput())).toEqual({
      status: "rejected",
      code: "unsafe-handoff",
    });
    expect(dispatched).toBeFalse();
    expect(papercuts.record.repairState).toBe("failed");
  });

  test("Paseo adapter uses argument arrays and includes no excluded fields or cwd in args", async () => {
    const invocations: ProcessInvocation[] = [];
    const process = async (invocation: ProcessInvocation): Promise<ProcessResult> => {
      invocations.push(invocation);
      return {
        status: "exited",
        exitCode: 0,
        stdout: new TextEncoder().encode(JSON.stringify({ agentId: "agent-safe" })),
        stderr: new Uint8Array(),
      };
    };
    const paseo = createPaseoRepairAdapter({
      process,
      preferencesPath: "/missing/preferences.json",
    });
    const handoff: RepairHandoff = Object.freeze({
      schemaVersion: 1,
      repositoryKey: REPOSITORY.id,
      papercutId: CUT_ID,
      summary: "A generalized repair summary.",
      prevention: "Use the validated workflow.",
      acceptanceCondition: "The workflow completes.",
      repairState: "queued",
    });

    expect(await paseo.dispatch(handoff, "/private/repository/path")).toEqual({
      status: "acknowledged",
    });
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0];
    expect(invocation?.command).toBe("paseo");
    expect(invocation?.cwd).toBe("/private/repository/path");
    expect(invocation?.args).toContain("--new-workspace");
    expect(invocation?.args).toContain("worktree");
    expect(invocation?.args).toContain("codex/gpt-5.4");
    expect(invocation?.args).toContain("--mode");
    expect(invocation?.args).toContain("full-access");
    const argumentsText = JSON.stringify(invocation?.args);
    expect(argumentsText).not.toContain("/private/repository/path");
    expect(argumentsText).not.toContain("terminal output");
    expect(argumentsText).not.toContain("source text");
    expect(argumentsText).not.toContain("environment");
    expect(argumentsText).not.toContain("credential");
    expect(argumentsText).not.toContain("password");

    const failedPaseo = createPaseoRepairAdapter({
      preferencesPath: "/missing/preferences.json",
      process: async () => ({
        status: "exited",
        exitCode: 1,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("unknown outcome"),
      }),
    });
    expect(await failedPaseo.dispatch(handoff, "/private/repository/path")).toEqual({
      status: "ambiguous",
      code: "paseo-exit-uncertain",
    });
  });
});
