import { describe, expect, test } from "bun:test";
import {
  createPiFollowUpAdapter,
  legalPapercutActions,
} from "../src/interactive-actions.ts";
import type { PapercutAction } from "../src/interactive-actions.ts";
import type { RepairState, PapercutRecord, PublicationState } from "../src/schema.ts";

const REPOSITORY_SCOPE = { type: "repository", id: opaque("repo", 1) } as const;
const MACHINE_SCOPE = { type: "machine", id: opaque("machine", 1) } as const;

const repairCases: Array<[RepairState, readonly PapercutAction[]]> = [
  ["none", ["repair-dispatch"]],
  ["failed", ["repair-dispatch"]],
  ["queued", ["repair-cancel"]],
  ["dispatched", []],
  ["running", []],
  ["awaiting_verification", ["repair-verify"]],
  ["indeterminate", ["repair-reconcile", "repair-resubmit"]],
  ["verified", []],
];

const publicationCases: Array<[PublicationState, readonly PapercutAction[]]> = [
  ["none", ["publication-publish"]],
  ["failed", ["publication-publish"]],
  ["pending", []],
  ["indeterminate", ["publication-reconcile", "publication-resubmit"]],
  ["published", []],
];

describe("interactive Papercut actions", () => {
  test("derives every repair action strictly from lifecycle, scope, and repair state", () => {
    for (const [repairState, expected] of repairCases) {
      expect(legalPapercutActions(
        REPOSITORY_SCOPE,
        record(repairState, "pending"),
      )).toEqual(expected);
    }
  });

  test("derives every publication action independently and gates verified resolution", () => {
    for (const [publicationState, expected] of publicationCases) {
      expect(legalPapercutActions(
        REPOSITORY_SCOPE,
        record("running", publicationState),
      )).toEqual(expected);
    }
    expect(legalPapercutActions(REPOSITORY_SCOPE, record("verified", "none"))).toEqual([
      "resolve",
      "publication-publish",
      "dismiss",
    ]);
    expect(legalPapercutActions(REPOSITORY_SCOPE, record("verified", "failed"))).toEqual([
      "resolve",
      "publication-publish",
      "dismiss",
    ]);
    expect(legalPapercutActions(REPOSITORY_SCOPE, record("verified", "published"))).toEqual([
      "resolve",
      "dismiss",
    ]);
    expect(legalPapercutActions(REPOSITORY_SCOPE, record("verified", "pending"))).toEqual([]);
    expect(legalPapercutActions(REPOSITORY_SCOPE, record("verified", "indeterminate"))).toEqual([
      "publication-reconcile",
      "publication-resubmit",
    ]);
  });

  test("hides remote and repair actions outside repository scope and archives are read-only", () => {
    expect(legalPapercutActions(MACHINE_SCOPE, record("none", "none"))).toEqual(["dismiss"]);
    expect(legalPapercutActions(MACHINE_SCOPE, record("queued", "none"))).toEqual([]);
    expect(legalPapercutActions(
      REPOSITORY_SCOPE,
      { ...record("none", "none"), lifecycle: "resolved" },
    )).toEqual([]);
    expect(legalPapercutActions(
      REPOSITORY_SCOPE,
      { ...record("none", "none"), lifecycle: "dismissed" },
    )).toEqual([]);
  });

  test("Pi fallback sends one bounded generalized follow-up and no excluded payload", async () => {
    const calls: Array<{ message: string; options: unknown }> = [];
    const adapter = createPiFollowUpAdapter((message, options) => {
      calls.push({ message, options });
    });
    const result = await adapter.dispatch({
      schemaVersion: 1,
      repositoryKey: REPOSITORY_SCOPE.id,
      papercutId: opaque("cut", 1),
      summary: "A repeatable workflow failed.",
      prevention: "Use the guarded workflow.",
      acceptanceCondition: "The focused check passes.",
      repairState: "queued",
    }, "/private/worktree/path");

    expect(result).toEqual({ status: "acknowledged" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(calls[0]?.message.length).toBeLessThanOrEqual(1_400);
    for (const excluded of [
      "/private/worktree/path",
      "terminal output",
      "source text",
      "conversation",
      "credential",
      "environment",
      "napkin",
    ]) {
      expect(calls[0]?.message.toLowerCase()).not.toContain(excluded);
    }
  });
});

function record(repairState: RepairState, publicationState: PublicationState): PapercutRecord {
  return {
    id: opaque("cut", 1),
    fingerprint: "repeatable-friction",
    summary: "A repeatable workflow failed.",
    severity: "major",
    prevention: "Use the guarded workflow.",
    acceptanceCondition: "The focused check passes.",
    sourceClassification: "generalized-derived",
    lifecycle: "open",
    repairState,
    publicationState,
    publicationIssueNumber: publicationState === "published" ? 42 : null,
    recurrence: 1,
    relatedIds: [],
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
  };
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
