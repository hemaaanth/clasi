import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ConflictMetadata, ConflictRevisionPreview } from "../src/conflict-service.ts";
import { headlessOk } from "../src/headless-response.ts";
import type { ImpactReport } from "../src/impact-service.ts";
import type { ScopeRef } from "../src/paths.ts";
import {
  recoveryBlocker,
  shouldShowCoordinationRecovery,
  showConfigReview,
  showConflictReview,
  showCoordinationReview,
  showImpactReview,
  showRecoveryReview,
} from "../src/review-views.ts";
import type {
  CoordinationReviewService,
  ConflictReviewService,
  ImpactReviewService,
  RecoveryHandler,
} from "../src/review-views.ts";

const GLOBAL: ScopeRef = { type: "global", id: "global" };
const MACHINE_ID = opaque("machine", 1);

class FakeUi {
  readonly selectCalls: Array<{ title: string; options: string[]; initialIndex: number }> = [];
  readonly inputCalls: Array<{ title: string; placeholder?: string }> = [];
  readonly confirmCalls: Array<{ title: string; message: string }> = [];
  readonly notifications: Array<{ message: string; level: string }> = [];
  readonly #selections: Array<number | undefined>;
  readonly #inputs: Array<string | undefined>;
  readonly #confirms: boolean[];

  constructor(
    selections: Array<number | undefined> = [],
    confirms: boolean[] = [],
    inputs: Array<string | undefined> = [],
  ) {
    this.#selections = selections;
    this.#confirms = confirms;
    this.#inputs = inputs;
  }

  async select(title: string, options: string[], config: { initialIndex?: number } = {}): Promise<string | undefined> {
    this.selectCalls.push({ title, options, initialIndex: config.initialIndex ?? 0 });
    const selected = this.#selections.shift();
    return selected === undefined ? undefined : options[selected];
  }

  async input(title: string, placeholder?: string): Promise<string | undefined> {
    this.inputCalls.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
    return this.#inputs.shift();
  }

  async confirm(title: string, message: string): Promise<boolean> {
    this.confirmCalls.push({ title, message });
    return this.#confirms.shift() ?? false;
  }

  notify(message: string, level: string): void {
    this.notifications.push({ message, level });
  }
}

describe("review views", () => {
  test("conflicts show bounded empty and degraded states", async () => {
    const emptyUi = new FakeUi();
    await showConflictReview(context(emptyUi), conflictService({
      list: async () => ({ status: "ok", conflicts: [], truncated: false }),
    }));
    expect(emptyUi.notifications).toEqual([{ message: "No unresolved conflicts.", level: "info" }]);
    expect(emptyUi.selectCalls).toHaveLength(0);

    const degradedUi = new FakeUi();
    await showConflictReview(context(degradedUi), conflictService({
      list: async () => ({ status: "rejected", code: "read-failed" }),
    }));
    expect(degradedUi.notifications).toEqual([{ message: "Conflicts unavailable (read-failed).", level: "warning" }]);
  });

  test("opaque conflict detail renders metadata only and Back performs no action", async () => {
    const ui = new FakeUi([0, 2]);
    const conflict = metadata(1, "opaque-quarantine");
    let revalidations = 0;
    let activations = 0;
    await showConflictReview(context(ui), conflictService({
      list: async () => ({ status: "ok", conflicts: [conflict], truncated: false }),
      show: async () => ({ status: "opaque", conflict }),
      revalidate: async () => {
        revalidations += 1;
        return { status: "opaque", conflictId: conflict.id, code: "revalidation-mismatch" };
      },
      activate: async () => {
        activations += 1;
        return { status: "rejected", code: "invalid-conflict" };
      },
    }));

    expect(ui.selectCalls[1]?.title).toContain("Opaque conflict");
    expect(ui.selectCalls[1]?.title).toContain("Reason: opaque-mismatch");
    expect(ui.selectCalls[1]?.title).not.toContain("candidate bytes");
    expect(ui.selectCalls[1]?.options).toEqual(["1. Revalidate", "2. Keep unresolved", "3. Back"]);
    expect(revalidations).toBe(0);
    expect(activations).toBe(0);
  });

  test("opaque Revalidate reloads validated A and B summaries without previewing opaque bytes", async () => {
    const ui = new FakeUi([0, 0, 2, 1]);
    const conflict = metadata(2, "opaque-quarantine");
    const candidate = preview("A", 3);
    const alternate = preview("B", 4);
    let validated = false;
    await showConflictReview(context(ui), conflictService({
      list: async () => ({ status: "ok", conflicts: [conflict], truncated: false }),
      show: async () => validated
        ? { status: "validated", conflict, candidate, alternate }
        : { status: "opaque", conflict },
      revalidate: async () => {
        validated = true;
        return {
          status: "validated",
          conflictId: conflict.id,
          alternateRevisionId: alternate.revisionId,
          conflictRevisionId: opaque("rev", 8),
          transactionId: conflict.transactionId,
        };
      },
    }));

    expect(ui.selectCalls[1]?.title).toContain("Opaque conflict");
    expect(ui.selectCalls[2]?.title).toContain(`A: context · global · 1 records · ${candidate.revisionId}`);
    expect(ui.selectCalls[2]?.title).toContain(`B: context · global · 1 records · ${alternate.revisionId}`);
    expect(ui.selectCalls[2]?.options).toEqual(["1. Choose A", "2. Choose B", "3. Keep unresolved", "4. Back"]);
  });

  test("validated activation confirms exact target and effect and preserves list selection", async () => {
    const ui = new FakeUi([1, 1, 2], [true]);
    const first = metadata(4, "validated-revisions");
    const second = metadata(5, "validated-revisions");
    const candidate = preview("A", 6);
    const alternate = preview("B", 7);
    const activations: Array<{ conflictId: string; revisionId: string; confirmed: boolean }> = [];
    let lists = 0;
    await showConflictReview(context(ui), conflictService({
      list: async () => {
        lists += 1;
        return { status: "ok", conflicts: [first, second], truncated: false };
      },
      show: async conflictId => ({
        status: "validated",
        conflict: conflictId === second.id ? second : first,
        candidate,
        alternate,
      }),
      activate: async (conflictId, revisionId, confirmed) => {
        activations.push({ conflictId, revisionId, confirmed });
        return {
          status: "activated",
          conflictId,
          selectedRevisionId: revisionId,
          revisionId: opaque("rev", 20),
          transactionId: second.transactionId,
        };
      },
    }));

    expect(activations).toEqual([{ conflictId: second.id, revisionId: alternate.revisionId, confirmed: true }]);
    expect(ui.confirmCalls[0]?.title).toBe("Activate revision B");
    expect(ui.confirmCalls[0]?.message).toContain("Target: context global");
    expect(ui.confirmCalls[0]?.message).toContain(`Effect: create a new active revision from B (${alternate.revisionId})`);
    expect(ui.confirmCalls[0]?.message).toContain("keep the other revision and conflict history");
    expect(lists).toBe(2);
    expect(ui.selectCalls.at(-1)?.initialIndex).toBe(1);
  });

  test("configuration displays safe root, caps, and capabilities without an absolute fallback", async () => {
    const ui = new FakeUi([0]);
    await showConfigReview(context(ui), async () => configResult("/private/absolute/root", 5, 6_000));

    const title = ui.selectCalls[0]?.title ?? "";
    expect(title).toContain("Data root: configured");
    expect(title).not.toContain("/private/absolute/root");
    expect(title).toContain("Napkin category cap: 5");
    expect(title).toContain("Context character cap: 6000");
    expect(title).toContain("Repository scope: attached");
    expect(title).toContain("Reattach on move: required");
  });

  test("configuration updates a bounded cap only after old-to-new confirmation", async () => {
    const ui = new FakeUi([0, 2], [true], ["7"]);
    let cap = 5;
    const updates: Array<{ field: string; value: number }> = [];
    await showConfigReview(
      context(ui),
      async () => configResult("${HOME}/.clasi", cap, 6_000),
      async (field, value) => {
        updates.push({ field, value });
        cap = value;
        return { status: "updated" };
      },
    );

    expect(ui.inputCalls[0]).toEqual({
      title: "Change Napkin category cap",
      placeholder: "Integer from 1 to 20",
    });
    expect(ui.confirmCalls[0]?.message).toContain("Target: Napkin category cap");
    expect(ui.confirmCalls[0]?.message).toContain("Effect: replace 5 with 7");
    expect(updates).toEqual([{ field: "napkin-category-cap", value: 7 }]);
    expect(ui.selectCalls[1]?.title).toContain("Napkin category cap: 7");
  });

  test("configuration preserves the view on cancelled and failed updates", async () => {
    const cancelled = new FakeUi([1, 2], [], [undefined]);
    let cancelledUpdates = 0;
    await showConfigReview(
      context(cancelled),
      async () => configResult("configured", 5, 6_000),
      async () => {
        cancelledUpdates += 1;
        return { status: "updated" };
      },
    );
    expect(cancelledUpdates).toBe(0);
    expect(cancelled.selectCalls).toHaveLength(2);

    const failed = new FakeUi([1, 2], [true], ["500"]);
    await showConfigReview(
      context(failed),
      async () => configResult("configured", 5, 6_000),
      async () => ({ status: "rejected", code: "write-conflict" }),
    );
    expect(failed.notifications).toContainEqual({
      message: "Configuration unchanged (write-conflict).",
      level: "warning",
    });
    expect(failed.selectCalls).toHaveLength(2);
  });

  test("impact labels observations, estimates, and unavailable values without causal claims", async () => {
    const ui = new FakeUi([0]);
    const service: ImpactReviewService = { report: async () => ({ status: "ok", report: impactReport() }) };
    await showImpactReview(context(ui), service, { machineId: MACHINE_ID, scopes: [GLOBAL] });

    const title = ui.selectCalls[0]?.title ?? "";
    expect(title).toContain("Injected characters (directly observed): 120");
    expect(title).toContain("Estimated injected tokens (estimate; characters divided by four): 30");
    expect(title).toContain("Explicit Napkin hits (directly observed): 3");
    expect(title).toContain("Time to close: unavailable (no-closed-papercuts)");
    expect(title).not.toMatch(/avoided|saved|caused|faster/i);
  });
  test("coordination recovery appears for retained or unavailable state, not two empty lists", async () => {
    expect(await shouldShowCoordinationRecovery(coordinationService())).toBeFalse();
    expect(await shouldShowCoordinationRecovery(coordinationService({
      listLocks: async () => ({ status: "rejected", code: "storage-unavailable" }),
    }))).toBeTrue();
    expect(await shouldShowCoordinationRecovery(undefined)).toBeTrue();
  });

  test("lock recovery shows opaque IDs only and cancellation preserves selection with zero effects", async () => {
    const ui = new FakeUi([0, 0, 1, 2], [false]);
    const documentId = opaque("doc", 60);
    let recoveries = 0;
    const service = coordinationService({
      listLocks: async () => ({ status: "ok", documentIds: [documentId], truncated: false }),
      recoverLock: async id => {
        recoveries += 1;
        return { status: "recovered", documentId: id };
      },
    });
    await showCoordinationReview(context(ui), service);

    expect(ui.selectCalls[0]?.options).toEqual(["1. Locks", "2. Retained transactions", "3. Back"]);
    expect(ui.selectCalls[1]?.options).toEqual([`1. ${documentId}`, "2. Back"]);
    expect(ui.confirmCalls[0]?.message).toContain(`Target: ${documentId}`);
    expect(ui.confirmCalls[0]?.message).toContain("Effect: revalidate lock ownership and remove only the stale lock");
    expect(ui.selectCalls[2]?.initialIndex).toBe(0);
    expect(ui.selectCalls.map(call => call.title).join("\n")).not.toMatch(/owner|pid|path/i);
    expect(recoveries).toBe(0);
  });

  test("confirmed lock recovery calls the injected lister and recoverer once", async () => {
    const ui = new FakeUi([0, 0, 2], [true]);
    const documentId = opaque("doc", 61);
    let recovered = false;
    let lockLists = 0;
    let recoveries = 0;
    const service = coordinationService({
      listLocks: async () => {
        lockLists += 1;
        return recovered
          ? { status: "empty" }
          : { status: "ok", documentIds: [documentId], truncated: false };
      },
      recoverLock: async id => {
        recoveries += 1;
        recovered = true;
        return { status: "recovered", documentId: id };
      },
    });
    await showCoordinationReview(context(ui), service);

    expect(lockLists).toBeGreaterThanOrEqual(3);
    expect(recoveries).toBe(1);
    expect(ui.notifications).toContainEqual({ message: "Stale lock recovered.", level: "info" });
  });

  test("transaction cleanup shows state and timestamps plus the quiescence warning before one effect", async () => {
    const ui = new FakeUi([1, 0, 0, 1, 2], [true]);
    const transaction = {
      id: opaque("tx", 70),
      documentId: opaque("doc", 71),
      state: "conflicted" as const,
      createdAt: "2026-08-09T11:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
    };
    const cleaned: string[] = [];
    const service = coordinationService({
      listTransactions: async () => ({
        status: "ok",
        transactions: [transaction],
        truncated: false,
      }),
      cleanTransaction: async id => {
        cleaned.push(id);
        return { status: "cleaned", transactionId: id, quarantineRemoved: true, stateRemoved: true };
      },
    });
    await showCoordinationReview(context(ui), service);

    expect(ui.selectCalls[1]?.options[0]).toContain(`conflicted · ${transaction.updatedAt} · ${transaction.id}`);
    const detail = ui.selectCalls[2]?.title ?? "";
    expect(detail).toContain(`Transaction ID: ${transaction.id}`);
    expect(detail).toContain(`Document ID: ${transaction.documentId}`);
    expect(detail).toContain(`Created: ${transaction.createdAt}`);
    expect(detail).toContain("editors and sync clients must be quiescent; cleanup removes terminal transaction state");
    expect(ui.confirmCalls[0]?.message).toContain("Target:");
    expect(ui.confirmCalls[0]?.message).toContain("remove terminal transaction state");
    expect(ui.confirmCalls[0]?.message).toContain("preserve canonical documents, revisions, and other directories");
    expect(cleaned).toEqual([transaction.id]);
  });


  test("recovery exposes only the injected action matching a recognized blocker", async () => {
    const ui = new FakeUi([0], [true]);
    const runs: string[] = [];
    const handler: RecoveryHandler = {
      available: async () => ["lock-recovery", "transaction-recovery"],
      run: async action => {
        runs.push(action);
        return { status: "ok" };
      },
    };
    const blocker = recoveryBlocker("lock-recovery-required");
    if (!blocker) throw new Error("expected recognized blocker");
    await showRecoveryReview(context(ui), blocker, handler);

    expect(ui.selectCalls[0]?.options).toEqual(["1. Recover stale lock", "2. Back"]);
    expect(ui.confirmCalls[0]?.message).toContain("Target: stale lock");
    expect(ui.confirmCalls[0]?.message).toContain("Effect: run the injected stale-lock recovery");
    expect(runs).toEqual(["lock-recovery"]);
    expect(recoveryBlocker("runtime-unavailable")).toBeNull();
  });
});

function context(ui: FakeUi): ExtensionContext {
  return { cwd: "/workspace", hasUI: true, ui } as unknown as ExtensionContext;
}

function conflictService(overrides: Partial<ConflictReviewService>): ConflictReviewService {
  return {
    list: async () => ({ status: "ok", conflicts: [], truncated: false }),
    show: async () => ({ status: "rejected", code: "not-found" }),
    revalidate: async () => ({ status: "rejected", code: "not-found" }),
    activate: async () => ({ status: "rejected", code: "not-found" }),
    ...overrides,
  };
}

function coordinationService(
  overrides: Partial<CoordinationReviewService> = {},
): CoordinationReviewService {
  return {
    listLocks: async () => ({ status: "empty" }),
    listTransactions: async () => ({ status: "empty" }),
    recoverLock: async () => ({ status: "rejected", code: "lock-recovery-unavailable" }),
    cleanTransaction: async () => ({ status: "rejected", code: "transaction-not-terminal" }),
    ...overrides,
  };
}

function metadata(index: number, kind: ConflictMetadata["conflictKind"]): ConflictMetadata {
  return {
    id: opaque("conflict", index),
    conflictKind: kind,
    reasonCode: kind === "opaque-quarantine" ? "opaque-mismatch" : "validated-revisions",
    transactionId: opaque("tx", index),
    candidateRevisionId: opaque("rev", index),
    alternateRevisionId: kind === "validated-revisions" ? opaque("rev", index + 20) : null,
    canonicalOccupied: true,
    scope: GLOBAL,
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
  };
}

function preview(label: "A" | "B", index: number): ConflictRevisionPreview {
  return {
    label,
    revisionId: opaque("rev", index),
    parentRevisionId: null,
    documentType: "context",
    scope: GLOBAL,
    updatedAt: "2026-08-09T12:00:00.000Z",
    records: [{
      documentType: "context",
      id: opaque("ctx", index),
      logicalKey: "package-manager",
      kind: "preference",
      value: "bun",
      approved: true,
      priority: 80,
    }],
    recordsTruncated: false,
  };
}

function configResult(dataRoot: string, napkinCap: number, contextCap: number) {
  return headlessOk("config-ready", "ready", {
    data_root: dataRoot,
    caps: { napkin_category: napkinCap, context_characters: contextCap },
    capabilities: { repository_scope: "attached" as const, requires_reattach_on_move: true },
    degradations: [],
  });
}

function impactReport(): ImpactReport {
  return {
    injectedCharacters: { label: "direct-observation", value: 120 },
    estimatedInjectedTokens: { label: "estimate", value: 30, method: "characters-divided-by-four" },
    explicitNapkinHits: { label: "direct-observation", value: 3 },
    papercutsOpened: { label: "direct-observation", value: 4 },
    papercutsClosed: { label: "direct-observation", value: 2 },
    papercutsOpen: { label: "direct-observation", value: 1 },
    papercutsDismissed: { label: "direct-observation", value: 1 },
    repeatedFriction: { label: "direct-observation", value: 2 },
    timeToClose: { label: "unavailable", reason: "no-closed-papercuts" },
  };
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
