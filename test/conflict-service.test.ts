import { describe, expect, test } from "bun:test";
import { ConflictService, MAX_CONFLICT_PREVIEW_RECORDS } from "../src/conflict-service.ts";
import type { ConflictMetadata, ConflictStore } from "../src/conflict-service.ts";
import { createClasiPaths } from "../src/paths.ts";
import { StoreError } from "../src/markdown-store.ts";
import type { RevalidateConflictResult, StoreReadResult, StoreWriteInput, StoreWriteResult } from "../src/markdown-store.ts";
import type {
  AnyClasiDocument,
  ClasiDocument,
  ConflictRecord,
  ContextRecord,
  ProposalRecord,
} from "../src/schema.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const LATER = "2026-08-09T13:00:00.000Z";
const PATHS = createClasiPaths({ controlRoot: "/control", dataRoot: "/private/data" });

class FakeConflictStore implements ConflictStore {
  readonly canonical = new Map<string, StoreReadResult>();
  readonly revisions = new Map<string, StoreReadResult>();
  readonly revisionReads: Array<{ documentKey: string; revisionId: string }> = [];
  readonly writes: StoreWriteInput[] = [];
  readonly revalidations: Array<{ conflictId: string; transactionId: string; canonicalPath: string; documentKey: string }> = [];
  ids: string[] = [];
  writeResult: StoreWriteResult | undefined;
  revalidationResult: RevalidateConflictResult = { status: "opaque", code: "revalidation-unsafe" };

  async listDocumentIds(): Promise<string[]> { return [...this.ids]; }
  async read(path: string): Promise<StoreReadResult> {
    const read = this.canonical.get(path);
    if (!read) throw new StoreError("canonical-missing");
    return read;
  }
  async readRevision(documentKey: string, revisionId: string): Promise<StoreReadResult> {
    this.revisionReads.push({ documentKey, revisionId });
    const read = this.revisions.get(`${documentKey}:${revisionId}`);
    if (!read) throw new Error("revision-unavailable");
    return read;
  }
  async revalidateConflict(input: { conflictId: string; transactionId: string; canonicalPath: string; documentKey: string }): Promise<RevalidateConflictResult> {
    this.revalidations.push(input);
    return this.revalidationResult;
  }
  async write(input: StoreWriteInput): Promise<StoreWriteResult> {
    this.writes.push(input);
    return this.writeResult ?? {
      status: "committed",
      revisionId: input.candidate.revisionId,
      transactionId: opaque("tx", 90),
      retainedQuarantine: false,
    };
  }
}

describe("ConflictService", () => {
  test("list validates every binding, sorts deterministically, and truncates only after validation", async () => {
    const store = new FakeConflictStore();
    const older = conflictFixture(1, "opaque-quarantine", null, NOW);
    const newer = conflictFixture(2, "opaque-quarantine", null, LATER);
    installMetadata(store, newer);
    installMetadata(store, older);
    const service = makeService(store);
    expect(await service.list(1)).toEqual({ status: "ok", conflicts: [metadata(newer)], truncated: true });
    expect(await service.list(101)).toEqual({ status: "rejected", code: "invalid-limit" });

    const malformed = conflictFixture(3, "opaque-quarantine", null, NOW);
    const malformedDocument = {
      ...malformed.conflictDocument,
      records: [{ ...malformed.conflictRecord, id: opaque("conflict", 99) }],
    } as ClasiDocument<"conflict">;
    store.ids.push(malformed.conflictId);
    store.canonical.set(PATHS.conflict(malformed.conflictId), readResult(malformedDocument));
    expect(await service.list()).toEqual({ status: "rejected", code: "invalid-conflict" });
  });

  test("opaque show returns metadata without reading transaction, candidate, or quarantine artifacts", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "opaque-quarantine", null, NOW);
    installMetadata(store, fixture);
    const shown = await makeService(store).show(fixture.conflictId);
    expect(shown).toEqual({ status: "opaque", conflict: metadata(fixture) });
    expect(store.revisionReads).toHaveLength(0);
    expect(JSON.stringify(shown)).not.toContain("/private/data");
    expect(JSON.stringify(shown)).not.toContain("digest");
    expect(JSON.stringify(shown)).not.toContain("error");
  });

  test("validated show loads only bound A and B revisions and rejects malformed transactions", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    installValidated(store, fixture);
    const alternate = fixture.alternate;
    if (!alternate) throw new Error("expected alternate fixture");
    const shown = await makeService(store).show(fixture.conflictId);
    expect(shown.status).toBe("validated");
    if (shown.status !== "validated") throw new Error("expected validated conflict");
    expect(shown.candidate.label).toBe("A");
    expect(shown.candidate.revisionId).toBe(fixture.candidate.revisionId);
    expect(shown.candidate.documentType).toBe("context");
    expect(shown.candidate.scope).toEqual({ type: "global", id: "global" });
    expect(shown.candidate.recordsTruncated).toBeFalse();
    expect(shown.alternate.label).toBe("B");
    expect(shown.alternate.revisionId).toBe(alternate.revisionId);
    expect(shown.candidate.records[0]).toEqual({ documentType: "context", id: opaque("ctx", 1), logicalKey: "package-manager", kind: "preference", value: "bun", approved: true, priority: 80 });
    expect(store.revisionReads).toEqual([
      { documentKey: fixture.documentKey, revisionId: fixture.candidate.revisionId },
      { documentKey: fixture.documentKey, revisionId: alternate.revisionId },
    ]);

    const transactionPath = PATHS.transaction(fixture.transactionId);
    const transaction = store.canonical.get(transactionPath)?.document;
    if (!transaction || transaction.documentType !== "transaction") throw new Error("missing transaction");
    store.canonical.set(transactionPath, readResult({
      ...transaction,
      records: [{ ...transaction.records[0]!, candidateRevisionId: opaque("rev", 77) }],
    }));
    expect(await makeService(store).show(fixture.conflictId)).toEqual({ status: "rejected", code: "invalid-conflict" });
  });

  test("validated previews are bounded to one hundred structured records", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    fixture.candidate = contextDocument(fixture.candidate.revisionId, Array.from({ length: MAX_CONFLICT_PREVIEW_RECORDS + 1 }, (_, index) => contextRecord(index + 1)));
    installValidated(store, fixture);
    const shown = await makeService(store).show(fixture.conflictId);
    expect(shown.status).toBe("validated");
    if (shown.status !== "validated") throw new Error("expected validated conflict");
    expect(shown.candidate.records).toHaveLength(MAX_CONFLICT_PREVIEW_RECORDS);
    expect(shown.candidate.recordsTruncated).toBeTrue();
  });

  test("revalidate derives the canonical path from the validated candidate", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "opaque-quarantine", null, NOW);
    installValidated(store, fixture);
    store.revalidationResult = { status: "validated", alternateRevisionId: opaque("rev", 3), conflictRevisionId: opaque("rev", 4), transactionId: fixture.transactionId };
    expect(await makeService(store).revalidate(fixture.conflictId)).toEqual({
      status: "validated",
      conflictId: fixture.conflictId,
      alternateRevisionId: opaque("rev", 3),
      conflictRevisionId: opaque("rev", 4),
      transactionId: fixture.transactionId,
    });
    expect(store.revalidations).toEqual([{
      conflictId: fixture.conflictId,
      transactionId: fixture.transactionId,
      canonicalPath: PATHS.context({ type: "global", id: "global" }),
      documentKey: fixture.documentKey,
    }]);
  });

  test("activate requires confirmation and an exact A or B selection", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    installValidated(store, fixture);
    const service = makeService(store);
    expect(await service.activate(fixture.conflictId, fixture.candidate.revisionId, false)).toEqual({ status: "choice-required", code: "confirmation-required" });
    expect(await service.activate(fixture.conflictId, opaque("rev", 99), true)).toEqual({ status: "rejected", code: "invalid-selection" });
    expect(store.writes).toHaveLength(0);
  });

  test("activate clones either selected revision onto current head without deleting history", async () => {
    for (const selection of ["candidate", "alternate"] as const) {
      const store = new FakeConflictStore();
      const fixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
      installValidated(store, fixture);
      const current = contextDocument(opaque("rev", 9), [contextRecord(9, "current")]);
      const canonicalPath = PATHS.context({ type: "global", id: "global" });
      store.canonical.set(canonicalPath, readResult(current, "a".repeat(64)));
      const selected = selection === "candidate" ? fixture.candidate : fixture.alternate!;
      const result = await makeService(store).activate(fixture.conflictId, selected.revisionId, true);
      expect(result.status).toBe("activated");
      if (result.status !== "activated") throw new Error("expected activation");
      expect(result.conflictId).toBe(fixture.conflictId);
      expect(result.selectedRevisionId).toBe(selected.revisionId);
      expect(result.revisionId).toBe(opaque("rev", 50));
      expect(store.writes).toHaveLength(1);
      const write = store.writes[0];
      if (!write) throw new Error("expected one write");
      expect(write.canonicalPath).toBe(canonicalPath);
      expect(write.documentKey).toBe(fixture.documentKey);
      expect(write.expected).toEqual({
        kind: "revision",
        revisionId: current.revisionId,
        digest: "a".repeat(64),
      });
      expect(write.candidate.revisionId).toBe(opaque("rev", 50));
      expect(write.candidate.parentRevisionId).toBe(current.revisionId);
      expect(write.candidate.updatedAt).toBe(LATER);
      expect(write.candidate.records).toEqual(selected.records);
      expect(store.canonical.has(PATHS.conflict(fixture.conflictId))).toBeTrue();
      expect(store.revisions.size).toBe(2);
    }
  });

  test("per-record canonicals reject alternate and current documents bound to another record", async () => {
    const alternateStore = new FakeConflictStore();
    const alternateFixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    alternateFixture.candidate = proposalDocument(opaque("rev", 1), 1);
    alternateFixture.alternate = proposalDocument(opaque("rev", 2), 2);
    installValidated(alternateStore, alternateFixture);
    expect(await makeService(alternateStore).show(alternateFixture.conflictId)).toEqual({
      status: "rejected",
      code: "invalid-conflict",
    });

    const currentStore = new FakeConflictStore();
    const currentFixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    currentFixture.candidate = proposalDocument(opaque("rev", 1), 1);
    currentFixture.alternate = proposalDocument(opaque("rev", 2), 1);
    installValidated(currentStore, currentFixture);
    currentStore.canonical.set(
      PATHS.proposal({ type: "global", id: "global" }, opaque("proposal", 1)),
      readResult(proposalDocument(opaque("rev", 9), 2)),
    );
    expect(await makeService(currentStore).activate(
      currentFixture.conflictId,
      currentFixture.candidate.revisionId,
      true,
    )).toEqual({ status: "rejected", code: "invalid-conflict" });
    expect(currentStore.writes).toHaveLength(0);
  });

  test("a concurrent canonical update returns conflict and never claims activation", async () => {
    const store = new FakeConflictStore();
    const fixture = conflictFixture(1, "validated-revisions", opaque("rev", 2), NOW);
    installValidated(store, fixture);
    store.canonical.set(PATHS.context({ type: "global", id: "global" }), readResult(contextDocument(opaque("rev", 9), [contextRecord(9)])));
    store.writeResult = {
      status: "conflict",
      kind: "validated-revisions",
      reasonCode: "canonical-changed",
      conflictId: opaque("conflict", 7),
      transactionId: opaque("tx", 7),
      candidateRevisionId: opaque("rev", 50),
      alternateRevisionId: opaque("rev", 9),
      canonicalOccupied: true,
    };
    expect(await makeService(store).activate(fixture.conflictId, fixture.candidate.revisionId, true)).toEqual({ status: "conflict", code: "write-conflict", conflictId: opaque("conflict", 7) });
  });
});

interface ConflictFixture {
  conflictId: string;
  transactionId: string;
  documentKey: string;
  conflictRecord: ConflictRecord;
  conflictDocument: ClasiDocument<"conflict">;
  candidate: AnyClasiDocument;
  alternate?: AnyClasiDocument;
  updatedAt: string;
}

function conflictFixture(index: number, kind: ConflictRecord["conflictKind"], alternateRevisionId: string | null, updatedAt: string): ConflictFixture {
  const conflictId = opaque("conflict", index);
  const transactionId = opaque("tx", index);
  const documentKey = opaque("doc", index);
  const candidate = contextDocument(opaque("rev", 1), [contextRecord(1)]);
  const alternate = alternateRevisionId ? contextDocument(alternateRevisionId, [contextRecord(2, "npm")]) : undefined;
  const conflictRecord: ConflictRecord = {
    id: conflictId,
    conflictKind: kind,
    reasonCode: "canonical-changed",
    transactionId,
    candidateRevisionId: candidate.revisionId,
    alternateRevisionId,
    canonicalOccupied: true,
    createdAt: NOW,
    updatedAt,
  };
  return {
    conflictId,
    transactionId,
    documentKey,
    conflictRecord,
    updatedAt,
    candidate,
    ...(alternate ? { alternate } : {}),
    conflictDocument: {
      schemaVersion: 1,
      documentType: "conflict",
      scopeType: "global",
      scopeId: "global",
      revisionId: opaque("rev", index + 10),
      parentRevisionId: null,
      updatedAt,
      records: [conflictRecord],
    },
  };
}

function installMetadata(store: FakeConflictStore, fixture: ConflictFixture): void {
  store.ids.push(fixture.conflictId);
  store.canonical.set(PATHS.conflict(fixture.conflictId), readResult(fixture.conflictDocument));
}

function installValidated(store: FakeConflictStore, fixture: ConflictFixture): void {
  installMetadata(store, fixture);
  const transaction: ClasiDocument<"transaction"> = {
    schemaVersion: 1,
    documentType: "transaction",
    scopeType: "global",
    scopeId: "global",
    revisionId: opaque("rev", 30),
    parentRevisionId: null,
    updatedAt: NOW,
    records: [{
      id: fixture.transactionId,
      documentKey: fixture.documentKey,
      state: "conflicted",
      candidateRevisionId: fixture.candidate.revisionId,
      expectedRevisionId: null,
      expectedDigest: null,
      createdAt: NOW,
      updatedAt: NOW,
    }],
  };
  store.canonical.set(PATHS.transaction(fixture.transactionId), readResult(transaction));
  store.revisions.set(`${fixture.documentKey}:${fixture.candidate.revisionId}`, readResult(fixture.candidate));
  if (fixture.alternate) store.revisions.set(`${fixture.documentKey}:${fixture.alternate.revisionId}`, readResult(fixture.alternate));
}

function metadata(fixture: ConflictFixture): ConflictMetadata {
  return {
    id: fixture.conflictId,
    conflictKind: fixture.conflictRecord.conflictKind,
    reasonCode: fixture.conflictRecord.reasonCode,
    transactionId: fixture.transactionId,
    candidateRevisionId: fixture.candidate.revisionId,
    alternateRevisionId: fixture.conflictRecord.alternateRevisionId,
    canonicalOccupied: true,
    scope: { type: "global", id: "global" },
    createdAt: NOW,
    updatedAt: fixture.updatedAt,
  };
}

function readResult(document: AnyClasiDocument, digest = "0".repeat(64)): StoreReadResult {
  return { document, bytes: new Uint8Array(), digest };
}

function contextDocument(revisionId: string, records: ContextRecord[]): ClasiDocument<"context"> {
  return {
    schemaVersion: 1,
    documentType: "context",
    scopeType: "global",
    scopeId: "global",
    revisionId,
    parentRevisionId: null,
    updatedAt: NOW,
    records,
  };
}

function contextRecord(index: number, value = "bun"): ContextRecord {
  return {
    id: opaque("ctx", index),
    logicalKey: `package-manager${index === 1 ? "" : `-${index}`}`,
    kind: "preference",
    value,
    sourceClassification: "generalized-derived",
    approved: true,
    priority: 80,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function proposalDocument(
  revisionId: string,
  index: number,
): ClasiDocument<"proposal"> {
  const record: ProposalRecord = {
    id: opaque("proposal", index),
    targetType: "context",
    logicalKey: `proposal-${index}`,
    summary: `Review proposal ${index}`,
    sourceClassification: "generalized-derived",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    schemaVersion: 1,
    documentType: "proposal",
    scopeType: "global",
    scopeId: "global",
    revisionId,
    parentRevisionId: null,
    updatedAt: NOW,
    records: [record],
  };
}

function makeService(store: FakeConflictStore): ConflictService {
  let nextRevision = 50;
  return new ConflictService({
    store,
    paths: PATHS,
    createId: prefix => prefix === "rev" ? opaque("rev", nextRevision++) : opaque(prefix, 80),
    now: () => LATER,
  });
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
