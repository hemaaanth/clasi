import {
  access,
  mkdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CoordinationService,
} from "../src/coordination-service.ts";
import type { CoordinationServiceOptions } from "../src/coordination-service.ts";
import { acquireDocumentLock, documentLockOwnerPath } from "../src/lock.ts";
import { encodeMarkdown } from "../src/markdown-codec.ts";
import { CLASI_SCHEMA_VERSION, MAX_DOCUMENT_BYTES } from "../src/schema.ts";
import type { ClasiDocument, TransactionRecord } from "../src/schema.ts";
import {
  opaque,
  withStoreFixture,
} from "./support/store-fixture.ts";
import type { StoreFixture } from "./support/store-fixture.ts";

const CREATED_AT = "2026-08-09T10:00:00.000Z";

function service(
  fixture: StoreFixture,
  options: Partial<Pick<
    CoordinationServiceOptions,
    "readProcessIdentity" | "beforeQuarantineUnlink"
  >> = {},
): CoordinationService {
  return new CoordinationService({
    controlPin: fixture.controlPin,
    dataPin: fixture.dataPin,
    paths: fixture.paths,
    store: fixture.store,
    ...options,
  });
}

async function writeTransaction(
  fixture: StoreFixture,
  sequence: number,
  state: TransactionRecord["state"],
  updatedAt: string,
): Promise<{ id: string; documentId: string; statePath: string }> {
  const id = opaque("tx", sequence);
  const documentId = opaque("doc", sequence);
  const statePath = fixture.paths.transaction(id);
  const record: TransactionRecord = {
    id,
    documentKey: documentId,
    state,
    candidateRevisionId: opaque("rev", sequence),
    expectedRevisionId: null,
    expectedDigest: null,
    createdAt: CREATED_AT,
    updatedAt,
  };
  const document: ClasiDocument<"transaction"> = {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "transaction",
    scopeType: "global",
    scopeId: "global",
    revisionId: opaque("rev", sequence + 100),
    parentRevisionId: null,
    updatedAt,
    records: [record],
  };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, encodeMarkdown(document), { mode: 0o600 });
  return { id, documentId, statePath };
}

describe("coordination service", () => {
  test("lists bounded transaction summaries in newest and ID order", async () => {
    await withStoreFixture(async fixture => {
      const coordination = service(fixture);
      expect(await coordination.listTransactions()).toEqual({ status: "empty" });

      const first = await writeTransaction(fixture, 1, "promoted", "2026-08-09T11:00:00.000Z");
      const second = await writeTransaction(fixture, 2, "conflicted", "2026-08-09T12:00:00.000Z");
      const third = await writeTransaction(fixture, 3, "staged", "2026-08-09T12:00:00.000Z");
      const result = await coordination.listTransactions(2);

      expect(result).toEqual({
        status: "ok",
        transactions: [
          {
            id: second.id,
            documentId: second.documentId,
            state: "conflicted",
            createdAt: CREATED_AT,
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
          {
            id: third.id,
            documentId: third.documentId,
            state: "staged",
            createdAt: CREATED_AT,
            updatedAt: "2026-08-09T12:00:00.000Z",
          },
        ],
        truncated: true,
      });
      expect(await coordination.listTransactions(0)).toEqual({
        status: "rejected",
        code: "invalid-limit",
      });
      expect(await coordination.listTransactions(101)).toEqual({
        status: "rejected",
        code: "invalid-limit",
      });
      expect(JSON.stringify(result)).not.toContain(first.statePath);
    });
  });

  test("one inspected malformed transaction fails the whole list without leaking content", async () => {
    await withStoreFixture(async fixture => {
      await writeTransaction(fixture, 1, "promoted", "2026-08-09T11:00:00.000Z");
      const malformedId = opaque("tx", 2);
      const malformedPath = fixture.paths.transaction(malformedId);
      await mkdir(dirname(malformedPath), { recursive: true });
      await writeFile(malformedPath, "private-path=/customer/repository terminal-output", { mode: 0o600 });

      const result = await service(fixture).listTransactions();
      expect(result).toEqual({ status: "rejected", code: "invalid-transaction-state" });
      expect(JSON.stringify(result)).not.toContain("customer/repository");
      expect(JSON.stringify(result)).not.toContain("terminal-output");
    });
  });

  test("lock recovery rejects live, changed, and invalid owners but removes a dead lock", async () => {
    await withStoreFixture(async fixture => {
      const liveId = opaque("doc", 11);
      const livePath = fixture.paths.lock(liveId);
      await acquireDocumentLock(livePath, {
        ownerToken: "live-owner",
        pid: 101,
        processIdentity: "process-a",
        startedAt: CREATED_AT,
      });
      const live = await service(fixture, {
        readProcessIdentity: async () => "process-a",
      }).recoverLock(liveId, true);
      expect(live).toEqual({ status: "rejected", code: "lock-owner-alive" });
      await access(livePath);

      const changedId = opaque("doc", 12);
      const changedPath = fixture.paths.lock(changedId);
      await acquireDocumentLock(changedPath, {
        ownerToken: "first-owner",
        pid: 102,
        processIdentity: "process-b",
        startedAt: CREATED_AT,
      });
      const changed = await service(fixture, {
        readProcessIdentity: async () => {
          await writeFile(join(changedPath, "owner.json"), JSON.stringify({
            ownerToken: "replacement-owner",
            pid: 103,
            processIdentity: "process-c",
            startedAt: CREATED_AT,
          }));
          return null;
        },
      }).recoverLock(changedId, true);
      expect(changed).toEqual({ status: "rejected", code: "lock-owner-changed" });
      await access(changedPath);

      const invalidId = opaque("doc", 13);
      const invalidPath = fixture.paths.lock(invalidId);
      await mkdir(invalidPath, { recursive: true });
      await writeFile(join(invalidPath, "owner.json"), "private owner /secret/path");
      const invalid = await service(fixture, {
        readProcessIdentity: async () => null,
      }).recoverLock(invalidId, true);
      expect(invalid).toEqual({ status: "rejected", code: "lock-owner-invalid" });
      expect(JSON.stringify(invalid)).not.toContain("secret/path");

      const deadId = opaque("doc", 14);
      const deadPath = fixture.paths.lock(deadId);
      await acquireDocumentLock(deadPath, {
        ownerToken: "dead-owner",
        pid: 104,
        processIdentity: "process-d",
        startedAt: CREATED_AT,
      });
      const recovered = await service(fixture, {
        readProcessIdentity: async () => null,
      }).recoverLock(deadId, true);
      expect(recovered).toEqual({ status: "recovered", documentId: deadId });
      await expect(access(deadPath)).rejects.toThrow();
    });
  });

  test("wrong IDs and unconfirmed actions make no changes", async () => {
    await withStoreFixture(async fixture => {
      const documentId = opaque("doc", 20);
      const lockPath = fixture.paths.lock(documentId);
      await acquireDocumentLock(lockPath, {
        ownerToken: "cancel-owner",
        pid: 201,
        processIdentity: "process-cancel",
        startedAt: CREATED_AT,
      });
      const coordination = service(fixture, { readProcessIdentity: async () => null });

      expect(await coordination.recoverLock(documentId, false)).toEqual({
        status: "choice-required",
        code: "confirmation-required",
        documentId,
      });
      expect(await coordination.recoverLock("doc_wrong", true)).toEqual({
        status: "rejected",
        code: "invalid-document-id",
      });
      await access(lockPath);

      const transaction = await writeTransaction(
        fixture,
        21,
        "promoted",
        "2026-08-09T12:00:00.000Z",
      );
      const quarantinePath = fixture.paths.quarantine(transaction.id);
      await mkdir(dirname(quarantinePath), { recursive: true });
      await writeFile(quarantinePath, "safe displaced bytes", { mode: 0o600 });
      expect(await coordination.cleanTransaction(transaction.id, false)).toEqual({
        status: "choice-required",
        code: "confirmation-required",
        transactionId: transaction.id,
        warning: {
          removes: ["transaction-state", "quarantine-displaced-copy-if-present"],
          preserves: ["revisions", "canonical-documents", "other-directories"],
        },
      });
      expect(await coordination.cleanTransaction("tx_wrong", true)).toEqual({
        status: "rejected",
        code: "invalid-transaction-id",
      });
      await access(quarantinePath);
    });
  });

  test("cleanup requires terminal state and removes confirmed state plus optional quarantine", async () => {
    await withStoreFixture(async fixture => {
      const coordination = service(fixture);
      const nonterminal = await writeTransaction(
        fixture,
        30,
        "displaced",
        "2026-08-09T12:00:00.000Z",
      );
      const nonterminalQuarantine = fixture.paths.quarantine(nonterminal.id);
      await mkdir(dirname(nonterminalQuarantine), { recursive: true });
      await writeFile(nonterminalQuarantine, "keep", { mode: 0o600 });
      expect(await coordination.cleanTransaction(nonterminal.id, true)).toEqual({
        status: "rejected",
        code: "transaction-not-terminal",
      });
      await access(nonterminalQuarantine);

      const absent = await writeTransaction(
        fixture,
        31,
        "promoted",
        "2026-08-09T12:01:00.000Z",
      );
      expect(await coordination.cleanTransaction(absent.id, true)).toEqual({
        status: "cleaned",
        transactionId: absent.id,
        quarantineRemoved: false,
        stateRemoved: true,
      });
      await expect(access(absent.statePath)).rejects.toThrow();

      const terminal = await writeTransaction(
        fixture,
        32,
        "conflicted",
        "2026-08-09T12:02:00.000Z",
      );
      const quarantinePath = fixture.paths.quarantine(terminal.id);
      const quarantineDirectory = dirname(quarantinePath);
      await mkdir(quarantineDirectory, { recursive: true });
      await writeFile(quarantinePath, "remove only these bytes", { mode: 0o600 });
      const revisionPath = fixture.paths.revision(terminal.documentId, opaque("rev", 32));
      await mkdir(dirname(revisionPath), { recursive: true });
      await writeFile(revisionPath, "preserved revision", { mode: 0o600 });

      expect(await coordination.cleanTransaction(terminal.id, true)).toEqual({
        status: "cleaned",
        transactionId: terminal.id,
        quarantineRemoved: true,
        stateRemoved: true,
      });
      await expect(access(quarantinePath)).rejects.toThrow();
      await expect(access(terminal.statePath)).rejects.toThrow();
      await access(revisionPath);
      await access(quarantineDirectory);
    });
  });

  test("cleanup fails closed for symlink, special, and oversized artifacts", async () => {
    await withStoreFixture(async fixture => {
      const coordination = service(fixture);

      const linked = await writeTransaction(fixture, 40, "promoted", "2026-08-09T12:00:00.000Z");
      const linkedPath = fixture.paths.quarantine(linked.id);
      const outside = join(fixture.roots.dataRoot, "outside-safe-file");
      await mkdir(dirname(linkedPath), { recursive: true });
      await writeFile(outside, "outside", { mode: 0o600 });
      await symlink(outside, linkedPath);
      expect(await coordination.cleanTransaction(linked.id, true)).toEqual({
        status: "rejected",
        code: "quarantine-unsafe",
      });
      await access(outside);

      const special = await writeTransaction(fixture, 41, "promoted", "2026-08-09T12:01:00.000Z");
      const specialPath = fixture.paths.quarantine(special.id);
      await mkdir(specialPath, { recursive: true });
      expect(await coordination.cleanTransaction(special.id, true)).toEqual({
        status: "rejected",
        code: "quarantine-unsafe",
      });
      await access(specialPath);

      const oversized = await writeTransaction(fixture, 42, "promoted", "2026-08-09T12:02:00.000Z");
      const oversizedPath = fixture.paths.quarantine(oversized.id);
      await mkdir(dirname(oversizedPath), { recursive: true });
      await writeFile(oversizedPath, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 65), { mode: 0o600 });
      expect(await coordination.cleanTransaction(oversized.id, true)).toEqual({
        status: "rejected",
        code: "quarantine-unsafe",
      });
      await access(oversizedPath);
    });
  });

  test("a late path replacement is detected and never unlinked", async () => {
    await withStoreFixture(async fixture => {
      const transaction = await writeTransaction(
        fixture,
        50,
        "promoted",
        "2026-08-09T12:00:00.000Z",
      );
      const quarantinePath = fixture.paths.quarantine(transaction.id);
      const movedPath = `${quarantinePath}.original`;
      await mkdir(dirname(quarantinePath), { recursive: true });
      await writeFile(quarantinePath, "original", { mode: 0o600 });
      const coordination = service(fixture, {
        beforeQuarantineUnlink: async () => {
          await rename(quarantinePath, movedPath);
          await writeFile(quarantinePath, "replacement", { mode: 0o600 });
        },
      });

      expect(await coordination.cleanTransaction(transaction.id, true)).toEqual({
        status: "rejected",
        code: "quarantine-changed",
      });
      await access(quarantinePath);
      await access(movedPath);
      await access(transaction.statePath);
    });
  });

  test("lists lock document IDs in deterministic bounded order without owner data", async () => {
    await withStoreFixture(async fixture => {
      const coordination = service(fixture);
      expect(await coordination.listLocks()).toEqual({ status: "empty" });

      for (const sequence of [3, 1, 2]) {
        await acquireDocumentLock(fixture.paths.lock(opaque("doc", sequence)), {
          ownerToken: `private-owner-${sequence}`,
          pid: 300 + sequence,
          processIdentity: `private-process-${sequence}`,
          startedAt: CREATED_AT,
        });
      }

      const result = await coordination.listLocks(2);
      expect(result).toEqual({
        status: "ok",
        documentIds: [opaque("doc", 1), opaque("doc", 2)],
        truncated: true,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("private-owner");
      expect(serialized).not.toContain("private-process");
      expect(serialized).not.toContain(fixture.paths.lockDirectory);
      expect(await coordination.listLocks(101)).toEqual({
        status: "rejected",
        code: "invalid-limit",
      });
    });
  });

  test("malformed lock children fail the whole list without path or owner leakage", async () => {
    await withStoreFixture(async fixture => {
      await mkdir(join(fixture.paths.lockDirectory, "not-a-document-id"), { recursive: true });
      const result = await service(fixture).listLocks();
      expect(result).toEqual({ status: "rejected", code: "lock-state-invalid" });
      expect(JSON.stringify(result)).not.toContain("not-a-document-id");
      expect(JSON.stringify(result)).not.toContain(fixture.paths.lockDirectory);
    });

    await withStoreFixture(async fixture => {
      const documentId = opaque("doc", 60);
      const lockPath = fixture.paths.lock(documentId);
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        documentLockOwnerPath(lockPath),
        "private-owner=/customer/path pid=999",
        { mode: 0o600 },
      );
      const result = await service(fixture).listLocks();
      expect(result).toEqual({ status: "rejected", code: "lock-state-invalid" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("private-owner");
      expect(serialized).not.toContain("customer/path");
      expect(serialized).not.toContain("999");
    });
  });

  test("a symlinked lock directory fails closed and reveals no target", async () => {
    await withStoreFixture(async fixture => {
      const documentId = opaque("doc", 61);
      const target = join(fixture.roots.controlRoot, "private-owner-target");
      await mkdir(target, { recursive: true });
      await writeFile(documentLockOwnerPath(target), JSON.stringify({
        ownerToken: "private-owner",
        pid: 401,
        processIdentity: "private-process",
        startedAt: CREATED_AT,
      }));
      await mkdir(fixture.paths.lockDirectory, { recursive: true });
      await symlink(target, fixture.paths.lock(documentId));

      const result = await service(fixture).listLocks();
      expect(result).toEqual({ status: "rejected", code: "lock-state-invalid" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("private-owner-target");
      expect(serialized).not.toContain("private-owner");
      expect(serialized).not.toContain(target);
    });
  });
});
