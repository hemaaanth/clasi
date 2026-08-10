import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { decodeMarkdown, encodeMarkdown } from "../src/markdown-codec.ts";
import { PapercutService } from "../src/papercut-service.ts";
import type { CapturePapercutInput, CapturePapercutResult } from "../src/papercut-service.ts";
import type { PublicationState, RepairState } from "../src/schema.ts";
import { opaque, withStoreFixture } from "./support/store-fixture.ts";
import type { StoreFixture } from "./support/store-fixture.ts";

const SCOPE = { type: "global", id: "global" } as const;
const REPAIR_STATES: readonly RepairState[] = [
  "none",
  "queued",
  "dispatched",
  "running",
  "awaiting_verification",
  "failed",
  "indeterminate",
  "verified",
];
const PUBLICATION_STATES: readonly PublicationState[] = [
  "none",
  "pending",
  "failed",
  "indeterminate",
  "published",
];

describe("PapercutService", () => {
  test("three exact scoped captures reinforce one canonical cut to recurrence three", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const first = await service.capture(captureInput("misleading-test-command"));
      const second = await service.capture(captureInput("misleading-test-command"));
      const third = await service.capture(captureInput("misleading-test-command"));

      expect(first.status).toBe("created");
      expect(second.status).toBe("reinforced");
      expect(third.status).toBe("reinforced");
      const inbox = await service.inbox(SCOPE);
      expect(inbox.status).toBe("ok");
      if (inbox.status !== "ok") throw new Error("expected inbox");
      expect(inbox.records).toHaveLength(1);
      expect(inbox.records[0]?.recurrence).toBe(3);
    });
  });

  test("gets one selected open or archived cut and fails closed on a binding mismatch", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const id = createdId(await service.capture(captureInput("selected-cut-lookup")));

      expect(await service.get(SCOPE, id)).toMatchObject({
        status: "ok",
        location: "open",
        record: { id, lifecycle: "open" },
      });
      expect(await service.dismiss(SCOPE, id)).toMatchObject({
        status: "archived",
        record: { id, lifecycle: "dismissed" },
      });
      expect(await service.get(SCOPE, id)).toMatchObject({
        status: "ok",
        location: "archive",
        record: { id, lifecycle: "dismissed" },
      });

      const path = fixture.paths.papercut(SCOPE, "archive", id);
      const document = decodeMarkdown(await readFile(path));
      if (document.documentType !== "papercut" || document.records[0] === undefined) {
        throw new Error("expected Papercut document");
      }
      await writeFile(path, encodeMarkdown({
        ...document,
        records: [{ ...document.records[0], id: opaque("cut", 999) }],
      }));

      expect(await service.get(SCOPE, id)).toEqual({
        status: "rejected",
        code: "invalid-document",
      });
    });
  });

  test("concurrent first captures create one cut and reinforce the rest", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const captures = await Promise.all(
        Array.from({ length: 8 }, () => service.capture(captureInput("first-capture-contention"))),
      );

      expect(captures.filter(result => result.status === "created")).toHaveLength(1);
      expect(captures.filter(result => result.status === "reinforced")).toHaveLength(7);
      const inbox = await service.inbox(SCOPE);
      if (inbox.status !== "ok") throw new Error("expected inbox");
      expect(inbox.records).toHaveLength(1);
      expect(inbox.records[0]?.recurrence).toBe(8);
    });
  });

  test("concurrent equivalent repeats lose no recurrence increments", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      await service.capture(captureInput("repeat-lock-contention"));

      const repeats = await Promise.all(
        Array.from({ length: 8 }, () => service.capture(captureInput("repeat-lock-contention"))),
      );

      expect(repeats.every(result => result.status === "reinforced")).toBe(true);
      const inbox = await service.inbox(SCOPE);
      if (inbox.status !== "ok") throw new Error("expected inbox");
      expect(inbox.records).toHaveLength(1);
      expect(inbox.records[0]?.recurrence).toBe(9);
    });
  });

  test("similar cuts return bounded candidates and merge only with an explicit target", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const created = await service.capture(captureInput("misleading-test-command"));
      const id = createdId(created);

      const possible = await service.capture(captureInput("test-command-misleading"));
      expect(possible).toEqual({ status: "candidates", candidateIds: [id] });
      const before = await service.inbox(SCOPE);
      if (before.status !== "ok") throw new Error("expected inbox");
      expect(before.records).toHaveLength(1);
      expect(before.records[0]?.recurrence).toBe(1);

      const reinforced = await service.capture(captureInput("test-command-misleading", id));
      expect(reinforced.status).toBe("reinforced");
      if (reinforced.status !== "reinforced") throw new Error("expected reinforcement");
      expect(reinforced.record.id).toBe(id);
      expect(reinforced.record.fingerprint).toBe("misleading-test-command");
      expect(reinforced.record.recurrence).toBe(2);
    });
  });

  test("a recurrence after archive creates a linked new canonical record", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const first = await service.capture(captureInput("archived-friction"));
      const archivedId = createdId(first);
      const dismissed = await service.dismiss(SCOPE, archivedId);
      expect(dismissed.status).toBe("archived");
      await expect(access(fixture.paths.papercut(SCOPE, "open", archivedId))).rejects.toThrow();
      await expect(access(fixture.paths.papercut(SCOPE, "archive", archivedId))).resolves.toBeNull();

      const repeated = await service.capture(captureInput("archived-friction"));
      expect(repeated.status).toBe("created");
      if (repeated.status !== "created") throw new Error("expected reopened cut");
      expect(repeated.record.id).not.toBe(archivedId);
      expect(repeated.record.relatedIds).toEqual([archivedId]);
      expect(repeated.record.recurrence).toBe(1);

      const inbox = await service.inbox(SCOPE);
      const archive = await service.archive(SCOPE);
      if (inbox.status !== "ok" || archive.status !== "ok") throw new Error("expected lists");
      expect(inbox.records.map(record => record.id)).toEqual([repeated.record.id]);
      expect(archive.records.map(record => record.id)).toEqual([archivedId]);
      expect(archive.records[0]?.lifecycle).toBe("dismissed");
    });
  });

  test("canonical archive movement refuses an occupied target without removing either file", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const id = createdId(await service.capture(captureInput("occupied-archive-target")));
      const sourceCanonicalPath = fixture.paths.papercut(SCOPE, "open", id);
      const targetCanonicalPath = fixture.paths.papercut(SCOPE, "archive", id);
      const source = await fixture.store.read(sourceCanonicalPath);
      const targetDocumentKey = fixture.nextId("doc");
      await fixture.store.write({
        canonicalPath: targetCanonicalPath,
        documentKey: targetDocumentKey,
        expected: { kind: "absent" },
        candidate: source.document,
      });

      const moved = await fixture.store.moveCanonical({
        sourceCanonicalPath,
        targetCanonicalPath,
        sourceDocumentKey: fixture.nextId("doc"),
        targetDocumentKey,
      });

      expect(moved).toEqual({ status: "conflict", reasonCode: "canonical-occupied" });
      expect((await fixture.store.read(sourceCanonicalPath)).digest).toBe(source.digest);
      expect((await fixture.store.read(targetCanonicalPath)).digest).toBe(source.digest);
    });
  });

  test("illegal transitions and indeterminate operations fail closed without retry", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const repairId = createdId(await service.capture(captureInput("repair-indeterminate")));

      expect(await service.reportRepair(SCOPE, repairId, "running"))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      expect(await service.verifyRepair(SCOPE, repairId, true))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      await service.queueRepair(SCOPE, repairId);
      await service.reportRepair(SCOPE, repairId, "indeterminate");
      expect(await service.queueRepair(SCOPE, repairId))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      expect(await service.resubmitRepair(SCOPE, repairId, false))
        .toEqual({ status: "rejected", code: "confirmation-required" });
      expect((await openRecord(service, repairId)).repairState).toBe("indeterminate");
      expect(await service.dismiss(SCOPE, repairId))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      const reconciledRepair = await service.reconcileRepair(SCOPE, repairId, "failed");
      expect(reconciledRepair.status).toBe("updated");
      expect(await service.queueRepair(SCOPE, repairId)).toMatchObject({ status: "updated" });

      const ambiguousVerificationId = createdId(
        await service.capture(captureInput("verification-ambiguous")),
      );
      await reachRepairState(service, ambiguousVerificationId, "awaiting_verification");
      expect(
        await service.reportRepair(SCOPE, ambiguousVerificationId, "indeterminate"),
      ).toMatchObject({
        status: "updated",
        record: { repairState: "indeterminate" },
      });

      const publicationId = createdId(await service.capture(captureInput("publication-indeterminate")));
      expect(await service.reportPublication(SCOPE, publicationId, "published", 42))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      await service.beginPublication(SCOPE, publicationId);
      expect(await service.reportPublication(SCOPE, publicationId, "published", null))
        .toEqual({ status: "rejected", code: "invalid-field" });
      expect(await service.reportPublication(SCOPE, publicationId, "failed", 42))
        .toEqual({ status: "rejected", code: "invalid-field" });
      await service.reportPublication(SCOPE, publicationId, "indeterminate", null);
      expect(await service.beginPublication(SCOPE, publicationId))
        .toEqual({ status: "rejected", code: "illegal-transition" });
      expect(await service.resubmitPublication(SCOPE, publicationId, false))
        .toEqual({ status: "rejected", code: "confirmation-required" });
      expect((await openRecord(service, publicationId)).publicationState).toBe("indeterminate");
      expect(await service.dismiss(SCOPE, publicationId))
        .toEqual({ status: "rejected", code: "illegal-transition" });
    });
  });

  test("resolution exhausts the repair and publication state cross-product", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      let sequence = 0;

      for (const repairState of REPAIR_STATES) {
        for (const publicationState of PUBLICATION_STATES) {
          const id = createdId(await service.capture(captureInput(`crossproduct${sequence++}`)));
          await reachRepairState(service, id, repairState);
          await reachPublicationState(service, id, publicationState);

          const result = await service.resolve(SCOPE, id);
          const shouldResolve = repairState === "verified" &&
            publicationState !== "pending" &&
            publicationState !== "indeterminate";
          expect(result.status).toBe(shouldResolve ? "archived" : "rejected");
          if (result.status === "rejected") {
            expect(result.code).toBe(
              repairState === "verified" ? "publication-unsettled" : "repair-not-verified",
            );
          }
        }
      }
    });
  }, 20_000);

  test("explicit reconciliation unblocks verified resolution without stranding state", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const id = createdId(await service.capture(captureInput("reconciliation-gate")));
      await reachRepairState(service, id, "verified");
      await reachPublicationState(service, id, "indeterminate");

      expect(await service.resolve(SCOPE, id))
        .toEqual({ status: "rejected", code: "publication-unsettled" });
      expect(await service.reconcilePublication(SCOPE, id, "published", 42))
        .toMatchObject({
          status: "updated",
          record: { publicationState: "published", publicationIssueNumber: 42 },
        });
      expect((await openRecord(service, id)).publicationIssueNumber).toBe(42);
      const resolved = await service.resolve(SCOPE, id, {
        durableNapkinProposal: {
          durable: true,
          logicalKey: "verify-generated-client",
          category: "Validation",
          priority: 70,
          situation: "Generated clients can drift after schema repairs.",
          action: "Verify the generated client after repairing its schema source.",
          sourceClassification: "generalized-derived",
        },
      });
      expect(resolved).toMatchObject({
        status: "archived",
        record: { lifecycle: "resolved" },
        napkinProposalSuggestion: {
          targetType: "napkin",
          logicalKey: "verify-generated-client",
          category: "Validation",
          priority: 70,
          situation: "Generated clients can drift after schema repairs.",
          action: "Verify the generated client after repairing its schema source.",
        },
      });
      const inbox = await service.inbox(SCOPE);
      const archive = await service.archive(SCOPE);
      if (inbox.status !== "ok" || archive.status !== "ok") throw new Error("expected lists");
      expect(inbox.records.some(record => record.id === id)).toBe(false);
      expect(archive.records.some(record => record.id === id)).toBe(true);
    });
  });

  test("an unsafe durable suggestion blocks resolution and is not returned or persisted", async () => {
    await withStoreFixture(async fixture => {
      const service = makeService(fixture);
      const id = createdId(await service.capture(captureInput("unsafe-durable-suggestion")));
      await reachRepairState(service, id, "verified");

      expect(await service.resolve(SCOPE, id, {
        durableNapkinProposal: {
          durable: true,
          logicalKey: "retain-secret",
          category: "Domain Guardrails",
          priority: 90,
          situation: "Credentials are needed later.",
          action: "Store api_key=super-secret-value-1234567890 for later.",
          sourceClassification: "generalized-derived",
        },
      })).toEqual({ status: "rejected", code: "secret-pattern" });
      expect((await openRecord(service, id)).lifecycle).toBe("open");
    });
  });
});

function makeService(fixture: StoreFixture): PapercutService {
  let timestamp = Date.parse("2026-08-09T13:00:00.000Z");
  return new PapercutService({
    store: fixture.store,
    paths: fixture.paths,
    createId: fixture.nextId,
    now: () => new Date(timestamp++).toISOString(),
  });
}

function captureInput(fingerprint: string, explicitMatchId?: string): CapturePapercutInput {
  return {
    scope: SCOPE,
    fingerprint,
    summary: "The documented test command did not exercise the expected target.",
    severity: "major",
    prevention: "Keep the verified test command beside the affected package.",
    acceptanceCondition: "The documented command exercises the expected target successfully.",
    sourceClassification: "generalized-derived",
    ...(explicitMatchId ? { explicitMatchId } : {}),
  };
}

function createdId(result: CapturePapercutResult): string {
  if (result.status !== "created") throw new Error(`expected created, received ${result.status}`);
  return result.record.id;
}

async function openRecord(service: PapercutService, id: string) {
  const inbox = await service.inbox(SCOPE);
  if (inbox.status !== "ok") throw new Error("expected inbox");
  const record = inbox.records.find(candidate => candidate.id === id);
  if (!record) throw new Error("expected open record");
  return record;
}

async function reachRepairState(
  service: PapercutService,
  id: string,
  target: RepairState,
): Promise<void> {
  if (target === "none") return;
  await service.queueRepair(SCOPE, id);
  if (target === "queued") return;
  if (target === "failed" || target === "indeterminate") {
    await service.reportRepair(SCOPE, id, target);
    return;
  }
  await service.reportRepair(SCOPE, id, "dispatched");
  if (target === "dispatched") return;
  await service.reportRepair(SCOPE, id, "running");
  if (target === "running") return;
  await service.reportRepair(SCOPE, id, "awaiting_verification");
  if (target === "awaiting_verification") return;
  await service.verifyRepair(SCOPE, id, true);
}

async function reachPublicationState(
  service: PapercutService,
  id: string,
  target: PublicationState,
): Promise<void> {
  if (target === "none") return;
  await service.beginPublication(SCOPE, id);
  if (target === "pending") return;
  await service.reportPublication(SCOPE, id, target, target === "published" ? 42 : null);
}
