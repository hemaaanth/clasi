import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeConflictRecord } from "./conflicts.ts";
import type { ConflictKind } from "./conflicts.ts";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { acquireDocumentLock, LockError, readProcessIdentity } from "./lock.ts";
import type { DocumentLock, LockOwner } from "./lock.ts";
import { decodeMarkdown, encodeMarkdown } from "./markdown-codec.ts";
import type { ClasiPaths } from "./paths.ts";
import {
  RevisionError,
  digestValidatedMarkdown,
  findRevisionHeads,
  readRevision,
  writeImmutableRevision,
} from "./revisions.ts";
import type { RevisionFileSystem } from "./revisions.ts";
import {
  assertRootUnchanged,
  assertSafeContainedPath,
  hasErrorCode as hasCode,
} from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";
import { CLASI_SCHEMA_VERSION, MAX_DOCUMENT_BYTES } from "./schema.ts";
import type {
  AnyClasiDocument,
  ClasiDocument,
  TransactionRecord,
} from "./schema.ts";

export type StoreReasonCode =
  | "lineage-mismatch"
  | "canonical-missing"
  | "invalid-transaction-state";

export class StoreError extends Error {
  constructor(readonly code: StoreReasonCode) {
    super(code);
    this.name = "StoreError";
  }
}

export interface StoreFileSystem extends RevisionFileSystem {
  createExclusiveDirectory(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDirectory(path: string): Promise<string[]>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const NODE_STORE_FILE_SYSTEM: StoreFileSystem = {
  mkdirParent: async path => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  },
  createExclusiveDirectory: async path => {
    await mkdir(path, { mode: 0o700 });
  },
  exists: async path => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  },
  link,
  listDirectory: readdir,
  readBytes: readFile,
  rename,
  unlink,
  writeExclusive: async (path, content) => {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  },
};

export type ExpectedCanonical =
  | { kind: "absent" }
  | { kind: "revision"; revisionId: string; digest: string };

export interface StoreWriteInput {
  canonicalPath: string;
  documentKey: string;
  expected: ExpectedCanonical;
  candidate: AnyClasiDocument;
}
export interface StoreMutateInput {
  canonicalPath: string;
  documentKey: string;
  mutate(
    current: StoreReadResult | null,
  ): AnyClasiDocument | null | Promise<AnyClasiDocument | null>;
}
export interface StoreMoveCanonicalInput {
  sourceCanonicalPath: string;
  targetCanonicalPath: string;
  sourceDocumentKey: string;
  targetDocumentKey: string;
}


export interface RecoverTransactionInput {
  transactionId: string;
  canonicalPath: string;
  documentKey: string;
}

export interface StoreReadResult {
  document: AnyClasiDocument;
  bytes: Uint8Array;
  digest: string;
}

export type StoreWriteResult =
  | {
      status: "committed";
      revisionId: string;
      transactionId: string;
      retainedQuarantine: boolean;
    }
  | {
      status: "conflict";
      kind: ConflictKind;
      reasonCode: string;
      conflictId: string;
      transactionId: string;
      candidateRevisionId: string;
      alternateRevisionId: string | null;
      canonicalOccupied: boolean;
    };
export type StoreMutateResult =
  | StoreWriteResult
  | { status: "unchanged"; revisionId: string | null };
export type StoreMoveCanonicalResult =
  | { status: "moved" }
  | { status: "missing"; reasonCode: "canonical-missing" }
  | { status: "conflict"; reasonCode: "canonical-occupied" };


export type RecoveryResult =
  | StoreWriteResult
  | { status: "already-terminal"; state: "promoted" | "conflicted" }
  | { status: "degraded"; code: "invalid-transaction-state" };

export type RevalidateConflictResult =
  | {
      status: "validated";
      alternateRevisionId: string;
      conflictRevisionId: string;
      transactionId: string;
    }
  | {
      status: "opaque";
      code:
        | "canonical-occupied"
        | "invalid-conflict"
        | "revalidation-unsafe"
        | "revalidation-changing"
        | "revalidation-mismatch"
        | "conflict-update-raced";
    };

export type RevisionReconciliationResult =
  | { status: "clean"; headRevisionId: string | null }
  | { status: "activated"; headRevisionId: string; transactionId: string }
  | { status: "conflicts"; heads: string[]; conflictIds: string[] };

export interface MarkdownStoreOptions {
  controlPin: RootPin;
  dataPin: RootPin;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
  fileSystem?: StoreFileSystem;
}

export class MarkdownStore {
  readonly #controlPin: RootPin;
  readonly #dataPin: RootPin;
  readonly #paths: ClasiPaths;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;
  readonly #fileSystem: StoreFileSystem;

  constructor(options: MarkdownStoreOptions) {
    this.#controlPin = options.controlPin;
    this.#dataPin = options.dataPin;
    this.#paths = options.paths;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#fileSystem = options.fileSystem ?? NODE_STORE_FILE_SYSTEM;
  }

  async read(canonicalPath: string): Promise<StoreReadResult> {
    await this.#assertDataPath(canonicalPath, true);
    let bytes: Uint8Array;
    try {
      bytes = await this.#fileSystem.readBytes(canonicalPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new StoreError("canonical-missing");
      throw error;
    }
    const document = decodeMarkdown(bytes);
    await assertRootUnchanged(this.#dataPin);
    return { document, bytes, digest: digestValidatedMarkdown(bytes) };
  }

  async readRevision(documentKey: string, revisionId: string): Promise<StoreReadResult> {
    const path = this.#paths.revision(documentKey, revisionId);
    await this.#assertDataPath(path, false);
    const revision = await readRevision(
      this.#fileSystem,
      this.#paths,
      documentKey,
      revisionId,
    );
    await assertRootUnchanged(this.#dataPin);
    return revision;
  }

  async readRevisionHistory(documentKey: string): Promise<AnyClasiDocument[]> {
    const directory = this.#paths.revisionDirectory(documentKey);
    if (!(await this.#fileSystem.exists(directory))) return [];
    await this.#assertDataPath(directory, false, "directory");
    const revisionIds = (await this.#fileSystem.listDirectory(directory))
      .filter(name => name.endsWith(".md"))
      .map(name => name.slice(0, -3))
      .filter(revisionId => isOpaqueId(revisionId, "rev"))
      .sort();
    await Promise.all(
      revisionIds.map(revisionId =>
        this.#assertDataPath(this.#paths.revision(documentKey, revisionId), false)
      ),
    );
    const revisions = await Promise.all(
      revisionIds.map(revisionId =>
        readRevision(this.#fileSystem, this.#paths, documentKey, revisionId)
      ),
    );
    await assertRootUnchanged(this.#dataPin);
    return revisions.map(revision => revision.document);
  }

  async listDocumentIds(directory: string, prefix: IdPrefix): Promise<string[]> {
    await this.#assertDataPath(directory, true, "directory");
    if (!(await this.#fileSystem.exists(directory))) {
      await assertRootUnchanged(this.#dataPin);
      return [];
    }
    await this.#assertDataPath(directory, false, "directory");
    const ids = (await this.#fileSystem.listDirectory(directory))
      .filter(name => name.endsWith(".md"))
      .map(name => name.slice(0, -3))
      .filter(id => isOpaqueId(id, prefix))
      .sort();
    await assertRootUnchanged(this.#dataPin);
    return ids;
  }

  async withDocumentLock<T>(documentKey: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.#paths.lock(documentKey);
    await this.#assertControlPath(lockPath, true, "directory");
    let lock: DocumentLock | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());
        break;
      } catch (error) {
        if (!(error instanceof LockError) || error.code !== "lock-held" || attempt >= 1_000) throw error;
        await delay(5);
      }
    }
    try {
      return await operation();
    } finally {
      await lock.release();
    }
  }

  async write(input: StoreWriteInput): Promise<StoreWriteResult> {
    const candidateMarkdown = encodeMarkdown(input.candidate);
    this.#assertLineage(input.expected, input.candidate);
    await this.#assertDataPath(input.canonicalPath, true);
    const lockPath = this.#paths.lock(input.documentKey);
    await this.#assertControlPath(lockPath, true, "directory");
    const lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());

    try {
      return await this.#writeLocked(input, candidateMarkdown);
    } finally {
      await lock.release();
    }
  }

  async mutate(input: StoreMutateInput): Promise<StoreMutateResult> {
    await this.#assertDataPath(input.canonicalPath, true);
    const lockPath = this.#paths.lock(input.documentKey);
    await this.#assertControlPath(lockPath, true, "directory");
    let lock: DocumentLock | undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());
        break;
      } catch (error) {
        if (!(error instanceof LockError) || error.code !== "lock-held" || attempt >= 1_000) throw error;
        await delay(5);
      }
    }
    try {
      let current: StoreReadResult | null;
      try {
        current = await this.read(input.canonicalPath);
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== "canonical-missing") throw error;
        current = null;
      }
      const candidate = await input.mutate(current);
      if (candidate === null) {
        return { status: "unchanged", revisionId: current?.document.revisionId ?? null };
      }
      const expected: ExpectedCanonical = current === null
        ? { kind: "absent" }
        : {
            kind: "revision",
            revisionId: current.document.revisionId,
            digest: current.digest,
          };
      this.#assertLineage(expected, candidate);
      return await this.#writeLocked(
        {
          canonicalPath: input.canonicalPath,
          documentKey: input.documentKey,
          expected,
          candidate,
        },
        encodeMarkdown(candidate),
      );
    } finally {
      await lock.release();
    }
  }

  async moveCanonical(input: StoreMoveCanonicalInput): Promise<StoreMoveCanonicalResult> {
    await this.#assertDataPath(input.sourceCanonicalPath, true);
    await this.#assertDataPath(input.targetCanonicalPath, true);
    const documentKeys = [...new Set([
      input.sourceDocumentKey,
      input.targetDocumentKey,
    ])].sort();
    const locks: DocumentLock[] = [];

    try {
      for (const documentKey of documentKeys) {
        const lockPath = this.#paths.lock(documentKey);
        await this.#assertControlPath(lockPath, true, "directory");
        let lock: DocumentLock | undefined;
        for (let attempt = 0; ; attempt += 1) {
          try {
            lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());
            break;
          } catch (error) {
            if (!(error instanceof LockError) || error.code !== "lock-held" || attempt >= 1_000) {
              throw error;
            }
            await delay(5);
          }
        }
        locks.push(lock);
      }

      await this.#fileSystem.mkdirParent(input.targetCanonicalPath);
      await this.#assertDataPath(input.sourceCanonicalPath, true);
      await this.#assertDataPath(input.targetCanonicalPath, true);
      let source: StoreReadResult;
      try {
        source = await this.read(input.sourceCanonicalPath);
      } catch (error) {
        if (error instanceof StoreError && error.code === "canonical-missing") {
          return { status: "missing", reasonCode: "canonical-missing" };
        }
        throw error;
      }
      if (await this.#fileSystem.exists(input.targetCanonicalPath)) {
        await this.#assertDataPath(input.targetCanonicalPath, false);
        return { status: "conflict", reasonCode: "canonical-occupied" };
      }

      try {
        await this.#fileSystem.link(input.sourceCanonicalPath, input.targetCanonicalPath);
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          return { status: "conflict", reasonCode: "canonical-occupied" };
        }
        throw error;
      }
      const installed = await this.read(input.targetCanonicalPath);
      if (installed.digest !== source.digest) {
        return { status: "conflict", reasonCode: "canonical-occupied" };
      }
      await this.#fileSystem.unlink(input.sourceCanonicalPath);
      return { status: "moved" };
    } finally {
      for (const lock of locks.reverse()) await lock.release();
    }
  }

  async recover(input: RecoverTransactionInput): Promise<RecoveryResult> {
    const statePath = this.#paths.transaction(input.transactionId);
    let state: ClasiDocument<"transaction">;
    try {
      await this.#assertDataPath(statePath, false);
      const decoded = decodeMarkdown(await this.#fileSystem.readBytes(statePath));
      if (decoded.documentType !== "transaction") throw new StoreError("invalid-transaction-state");
      state = decoded;
    } catch {
      return { status: "degraded", code: "invalid-transaction-state" };
    }
    const record = state.records[0];
    if (!record || record.id !== input.transactionId || record.documentKey !== input.documentKey) {
      return { status: "degraded", code: "invalid-transaction-state" };
    }
    if (record.state === "promoted" || record.state === "conflicted") {
      return { status: "already-terminal", state: record.state };
    }

    const lockPath = this.#paths.lock(input.documentKey);
    await this.#assertControlPath(lockPath, true, "directory");
    const lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());
    try {
      return await this.#recoverLocked(input, state, record);
    } finally {
      await lock.release();
    }
  }

  async revalidateConflict(input: {
    conflictId: string;
    transactionId: string;
    canonicalPath: string;
    documentKey: string;
  }): Promise<RevalidateConflictResult> {
    await this.#assertDataPath(input.canonicalPath, true);

    let conflictRead: StoreReadResult;
    try {
      conflictRead = await this.read(this.#paths.conflict(input.conflictId));
    } catch {
      return { status: "opaque", code: "invalid-conflict" };
    }
    if (conflictRead.document.documentType !== "conflict") {
      return { status: "opaque", code: "invalid-conflict" };
    }
    const conflictRecord = conflictRead.document.records[0];
    if (
      !conflictRecord ||
      conflictRecord.id !== input.conflictId ||
      conflictRecord.transactionId !== input.transactionId
    ) {
      return { status: "opaque", code: "invalid-conflict" };
    }
    if (
      conflictRecord.conflictKind === "validated-revisions" &&
      conflictRecord.alternateRevisionId !== null
    ) {
      return {
        status: "validated",
        alternateRevisionId: conflictRecord.alternateRevisionId,
        conflictRevisionId: conflictRead.document.revisionId,
        transactionId: conflictRecord.transactionId,
      };
    }

    let candidate;
    try {
      candidate = await readRevision(
        this.#fileSystem,
        this.#paths,
        input.documentKey,
        conflictRecord.candidateRevisionId,
      );
    } catch {
      return { status: "opaque", code: "invalid-conflict" };
    }
    const readsOccupiedCanonical = conflictRecord.reasonCode === "canonical-occupied";
    if (!readsOccupiedCanonical && conflictRecord.reasonCode !== "displaced-content-unsafe") {
      return { status: "opaque", code: "invalid-conflict" };
    }
    if (!readsOccupiedCanonical && await this.#fileSystem.exists(input.canonicalPath)) {
      return { status: "opaque", code: "canonical-occupied" };
    }
    const artifactPath = readsOccupiedCanonical
      ? input.canonicalPath
      : this.#paths.quarantine(input.transactionId);
    await this.#assertDataPath(artifactPath, false);
    let firstBytes: Uint8Array;
    let firstDocument: AnyClasiDocument;
    let secondBytes: Uint8Array;
    try {
      firstBytes = await this.#fileSystem.readBytes(artifactPath);
      firstDocument = decodeMarkdown(firstBytes);
      secondBytes = await this.#fileSystem.readBytes(artifactPath);
      decodeMarkdown(secondBytes);
    } catch {
      return { status: "opaque", code: "revalidation-unsafe" };
    }
    if (Buffer.compare(firstBytes, secondBytes) !== 0) {
      return { status: "opaque", code: "revalidation-changing" };
    }
    if (
      firstDocument.documentType !== candidate.document.documentType ||
      firstDocument.scopeType !== candidate.document.scopeType ||
      firstDocument.scopeId !== candidate.document.scopeId
    ) {
      return { status: "opaque", code: "revalidation-mismatch" };
    }

    const alternateRevisionId = await this.#preserveAlternate(
      input.documentKey,
      firstDocument,
      candidate.document.parentRevisionId,
    );
    const conflictRevisionId = this.#createId("rev");
    const now = this.#now();
    const updatedConflict: ClasiDocument<"conflict"> = {
      ...conflictRead.document,
      revisionId: conflictRevisionId,
      parentRevisionId: conflictRead.document.revisionId,
      updatedAt: now,
      records: [{
        ...conflictRecord,
        conflictKind: "validated-revisions",
        alternateRevisionId,
        canonicalOccupied: readsOccupiedCanonical,
        updatedAt: now,
      }],
    };
    const update = await this.write({
      canonicalPath: this.#paths.conflict(input.conflictId),
      documentKey: conflictDocumentKey(input.conflictId),
      expected: {
        kind: "revision",
        revisionId: conflictRead.document.revisionId,
        digest: conflictRead.digest,
      },
      candidate: updatedConflict,
    });
    if (update.status !== "committed") {
      return { status: "opaque", code: "conflict-update-raced" };
    }
    return {
      status: "validated",
      alternateRevisionId,
      conflictRevisionId,
      transactionId: update.transactionId,
    };
  }

  async reconcileRevisionHeads(input: {
    documentKey: string;
    canonicalPath: string;
  }): Promise<RevisionReconciliationResult> {
    const { documentKey } = input;
    await this.#assertDataPath(input.canonicalPath, true);
    const lockPath = this.#paths.lock(documentKey);
    await this.#assertControlPath(lockPath, true, "directory");
    const lock = await acquireDocumentLock(lockPath, await this.#currentLockOwner());
    try {
      const revisionDirectory = this.#paths.revisionDirectory(documentKey);
      if (!(await this.#fileSystem.exists(revisionDirectory))) {
        return { status: "clean", headRevisionId: null };
      }
      await this.#assertDataPath(revisionDirectory, false, "directory");
      const revisionIds = (await this.#fileSystem.listDirectory(revisionDirectory))
        .filter(name => name.endsWith(".md"))
        .map(name => name.slice(0, -3))
        .filter(revisionId => isOpaqueId(revisionId, "rev"))
        .sort();
      await Promise.all(
        revisionIds.map(revisionId =>
          this.#assertDataPath(this.#paths.revision(documentKey, revisionId), false)
        ),
      );
      const revisions = await Promise.all(
        revisionIds.map(revisionId =>
          readRevision(this.#fileSystem, this.#paths, documentKey, revisionId)
        ),
      );
      const heads = findRevisionHeads(revisions.map(revision => revision.document));
      const primaryHead = heads[0];
      if (!primaryHead) return { status: "clean", headRevisionId: null };
      const alternateHeads = heads.slice(1);
      const candidate = revisions.find(revision => revision.document.revisionId === primaryHead);
      if (!candidate) throw new RevisionError("revision-mismatch");
      if (heads.length === 1) {
        const active = await this.#tryValidatedRead(input.canonicalPath);
        if (
          active?.document.revisionId === candidate.document.revisionId &&
          active.digest === candidate.digest
        ) {
          return { status: "clean", headRevisionId: candidate.document.revisionId };
        }
        const activation = await this.#writeLocked(
          {
            canonicalPath: input.canonicalPath,
            documentKey,
            expected: { kind: "absent" },
            candidate: candidate.document,
          },
          Buffer.from(candidate.bytes).toString("utf8"),
        );
        return activation.status === "committed"
          ? {
              status: "activated",
              headRevisionId: candidate.document.revisionId,
              transactionId: activation.transactionId,
            }
          : {
              status: "conflicts",
              heads,
              conflictIds: [activation.conflictId],
            };
      }
      const conflictIds: string[] = [];
      for (const alternateRevisionId of alternateHeads) {
        const existing = await this.#findHeadConflict(primaryHead, alternateRevisionId);
        if (existing) {
          conflictIds.push(existing);
          continue;
        }
        const transactionId = this.#createId("tx");
        const now = this.#now();
        const transactionRecord: TransactionRecord = {
          id: transactionId,
          documentKey,
          state: "conflicted",
          candidateRevisionId: primaryHead,
          expectedRevisionId: null,
          expectedDigest: null,
          createdAt: now,
          updatedAt: now,
        };
        const transaction = this.#transactionDocument(
          candidate.document,
          this.#createId("rev"),
          transactionRecord,
        );
        const statePath = this.#paths.transaction(transactionId);
        await this.#createExclusiveParentDirectory(statePath);
        await this.#fileSystem.writeExclusive(statePath, encodeMarkdown(transaction));
        const conflictId = this.#createId("conflict");
        await writeConflictRecord(this.#fileSystem, this.#paths, {
          conflictId,
          revisionId: this.#createId("rev"),
          transactionId,
          candidate: candidate.document,
          kind: "validated-revisions",
          reasonCode: "multiple-revision-heads",
          alternateRevisionId,
          canonicalOccupied: false,
          now,
        });
        conflictIds.push(conflictId);
      }
      return { status: "conflicts", heads, conflictIds };
    } finally {
      await lock.release();
    }
  }

  async #writeLocked(input: StoreWriteInput, candidateMarkdown: string): Promise<StoreWriteResult> {
    const transactionId = this.#createId("tx");
    const transactionRevisionId = this.#createId("rev");
    const stagingPath = this.#paths.staging(input.canonicalPath, input.candidate.revisionId);
    const statePath = this.#paths.transaction(transactionId);
    const now = this.#now();
    const record: TransactionRecord = {
      id: transactionId,
      documentKey: input.documentKey,
      state: "staged",
      candidateRevisionId: input.candidate.revisionId,
      expectedRevisionId: input.expected.kind === "revision" ? input.expected.revisionId : null,
      expectedDigest: input.expected.kind === "revision" ? input.expected.digest : null,
      createdAt: now,
      updatedAt: now,
    };
    const transaction = this.#transactionDocument(input.candidate, transactionRevisionId, record);

    await this.#prepareCandidate(input, candidateMarkdown, stagingPath);
    await this.#createExclusiveParentDirectory(statePath);
    await this.#fileSystem.writeExclusive(statePath, encodeMarkdown(transaction));

    let retainedQuarantine = false;
    if (input.expected.kind === "revision") {
      const quarantinePath = this.#paths.quarantine(transactionId);
      await this.#createExclusiveParentDirectory(quarantinePath);
      try {
        await this.#fileSystem.rename(input.canonicalPath, quarantinePath);
      } catch (error) {
        if (hasCode(error, "ENOENT")) {
          return await this.#conflict({
            input,
            transaction,
            stagingPath,
            kind: "opaque-quarantine",
            reasonCode: "expected-canonical-missing",
            alternateRevisionId: null,
            canonicalOccupied: false,
          });
        }
        throw error;
      }
      retainedQuarantine = true;
      const displaced = await this.#validateDisplaced(quarantinePath, input.expected);
      if (!displaced.matches) {
        const alternateRevisionId = displaced.document
          ? await this.#preserveAlternate(input.documentKey, displaced.document, input.expected.revisionId)
          : null;
        return await this.#conflict({
          input,
          transaction,
          stagingPath,
          kind: displaced.document ? "validated-revisions" : "opaque-quarantine",
          reasonCode: displaced.document ? "displaced-version-mismatch" : "displaced-content-unsafe",
          alternateRevisionId,
          canonicalOccupied: false,
        });
      }
      await this.#updateTransaction(statePath, transaction, "displaced");
    }

    try {
      await this.#fileSystem.link(stagingPath, input.canonicalPath);
    } catch (error) {
      if (isNoReplaceOrUnsupported(error)) {
        const canonicalOccupied =
          hasCode(error, "EEXIST") || await this.#fileSystem.exists(input.canonicalPath);
        const kind: ConflictKind =
          !canonicalOccupied && input.expected.kind === "revision"
            ? "validated-revisions"
            : "opaque-quarantine";
        return await this.#conflict({
          input,
          transaction,
          stagingPath,
          kind,
          reasonCode: canonicalOccupied ? "canonical-occupied" : "hard-link-unsupported",
          alternateRevisionId:
            kind === "validated-revisions" && input.expected.kind === "revision"
              ? input.expected.revisionId
              : null,
          canonicalOccupied,
        });
      }
      throw error;
    }

    await this.#fileSystem.unlink(stagingPath);
    await this.#writeLastGood(input.documentKey, candidateMarkdown);
    await this.#updateTransaction(statePath, transaction, "promoted");
    return {
      status: "committed",
      revisionId: input.candidate.revisionId,
      transactionId,
      retainedQuarantine,
    };
  }

  async #recoverLocked(
    input: { transactionId: string; canonicalPath: string; documentKey: string },
    transaction: ClasiDocument<"transaction">,
    record: TransactionRecord,
  ): Promise<RecoveryResult> {
    const candidate = await readRevision(
      this.#fileSystem,
      this.#paths,
      input.documentKey,
      record.candidateRevisionId,
    );
    const candidateMarkdown = Buffer.from(candidate.bytes).toString("utf8");
    const stagingPath = this.#paths.staging(input.canonicalPath, record.candidateRevisionId);
    const statePath = this.#paths.transaction(input.transactionId);
    const quarantinePath = this.#paths.quarantine(input.transactionId);
    const canonicalExists = await this.#fileSystem.exists(input.canonicalPath);
    const quarantineExists = await this.#fileSystem.exists(quarantinePath);

    if (canonicalExists) {
      const active = await this.#tryValidatedRead(input.canonicalPath);
      if (active?.document.revisionId === record.candidateRevisionId && active.digest === candidate.digest) {
        await this.#unlinkIfPresent(stagingPath);
        await this.#writeLastGood(input.documentKey, candidateMarkdown);
        await this.#updateTransaction(statePath, transaction, "promoted");
        return {
          status: "committed",
          revisionId: record.candidateRevisionId,
          transactionId: input.transactionId,
          retainedQuarantine: quarantineExists,
        };
      }
      return await this.#conflict({
        input: {
          ...input,
          expected: this.#expectedFromRecord(record),
          candidate: candidate.document,
        },
        transaction,
        stagingPath,
        kind: "opaque-quarantine",
        reasonCode: "canonical-occupied",
        alternateRevisionId: null,
        canonicalOccupied: true,
      });
    }

    if (record.expectedRevisionId !== null) {
      if (!quarantineExists || record.expectedDigest === null) {
        return await this.#conflict({
          input: {
            ...input,
            expected: this.#expectedFromRecord(record),
            candidate: candidate.document,
          },
          transaction,
          stagingPath,
          kind: "opaque-quarantine",
          reasonCode: "expected-canonical-missing",
          alternateRevisionId: null,
          canonicalOccupied: false,
        });
      }
      const expected = {
        kind: "revision" as const,
        revisionId: record.expectedRevisionId,
        digest: record.expectedDigest,
      };
      const displaced = await this.#validateDisplaced(quarantinePath, expected);
      if (!displaced.matches) {
        const alternateRevisionId = displaced.document
          ? await this.#preserveAlternate(input.documentKey, displaced.document, expected.revisionId)
          : null;
        return await this.#conflict({
          input: { ...input, expected, candidate: candidate.document },
          transaction,
          stagingPath,
          kind: displaced.document ? "validated-revisions" : "opaque-quarantine",
          reasonCode: displaced.document ? "displaced-version-mismatch" : "displaced-content-unsafe",
          alternateRevisionId,
          canonicalOccupied: false,
        });
      }
      if (record.state !== "displaced") {
        await this.#updateTransaction(statePath, transaction, "displaced");
      }
    }

    await this.#fileSystem.mkdirParent(stagingPath);
    try {
      await this.#fileSystem.writeExclusive(stagingPath, candidateMarkdown);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = await this.#fileSystem.readBytes(stagingPath);
      if (Buffer.compare(existing, Buffer.from(candidateMarkdown, "utf8")) !== 0) {
        return await this.#conflict({
          input: {
            ...input,
            expected: this.#expectedFromRecord(record),
            candidate: candidate.document,
          },
          transaction,
          stagingPath,
          kind: "opaque-quarantine",
          reasonCode: "staging-mismatch",
          alternateRevisionId: null,
          canonicalOccupied: false,
        });
      }
    }
    try {
      await this.#fileSystem.link(stagingPath, input.canonicalPath);
    } catch (error) {
      if (!isNoReplaceOrUnsupported(error)) throw error;
      return await this.#conflict({
        input: {
          ...input,
          expected: this.#expectedFromRecord(record),
          candidate: candidate.document,
        },
        transaction,
        stagingPath,
        kind: "opaque-quarantine",
        reasonCode: hasCode(error, "EEXIST") ? "canonical-occupied" : "hard-link-unsupported",
        alternateRevisionId: null,
        canonicalOccupied: await this.#fileSystem.exists(input.canonicalPath),
      });
    }
    await this.#fileSystem.unlink(stagingPath);
    await this.#writeLastGood(input.documentKey, candidateMarkdown);
    await this.#updateTransaction(statePath, transaction, "promoted");
    return {
      status: "committed",
      revisionId: candidate.document.revisionId,
      transactionId: input.transactionId,
      retainedQuarantine: quarantineExists,
    };
  }

  async #prepareCandidate(
    input: StoreWriteInput,
    candidateMarkdown: string,
    stagingPath: string,
  ): Promise<void> {
    const revisionPath = this.#paths.revision(input.documentKey, input.candidate.revisionId);
    await this.#assertDataPath(revisionPath, true);
    await writeImmutableRevision(
      this.#fileSystem,
      this.#paths,
      input.documentKey,
      input.candidate,
      candidateMarkdown,
    );
    await this.#fileSystem.mkdirParent(stagingPath);
    await this.#assertDataPath(stagingPath, true);
    await this.#fileSystem.writeExclusive(stagingPath, candidateMarkdown);
  }

  async #validateDisplaced(
    path: string,
    expected: Extract<ExpectedCanonical, { kind: "revision" }>,
  ): Promise<{ matches: boolean; document: AnyClasiDocument | null }> {
    let document: AnyClasiDocument;
    let bytes: Uint8Array;
    try {
      bytes = await this.#fileSystem.readBytes(path);
      document = decodeMarkdown(bytes);
    } catch {
      return { matches: false, document: null };
    }
    return {
      matches:
        document.revisionId === expected.revisionId &&
        digestValidatedMarkdown(bytes) === expected.digest,
      document,
    };
  }

  async #findHeadConflict(leftRevisionId: string, rightRevisionId: string): Promise<string | null> {
    const conflictDirectory = this.#paths.conflictDirectory;
    await this.#assertDataPath(conflictDirectory, true, "directory");
    if (!(await this.#fileSystem.exists(conflictDirectory))) return null;
    await this.#assertDataPath(conflictDirectory, false, "directory");
    for (const name of await this.#fileSystem.listDirectory(conflictDirectory)) {
      if (!name.endsWith(".md")) continue;
      const conflictId = name.slice(0, -3);
      if (!isOpaqueId(conflictId, "conflict")) continue;
      const conflictPath = this.#paths.conflict(conflictId);
      await this.#assertDataPath(conflictPath, false);
      try {
        const document = decodeMarkdown(
          await this.#fileSystem.readBytes(conflictPath),
        );
        if (document.documentType !== "conflict") continue;
        const record = document.records[0];
        if (
          record?.conflictKind !== "validated-revisions" ||
          record.reasonCode !== "multiple-revision-heads" ||
          record.alternateRevisionId === null
        ) {
          continue;
        }
        const samePair =
          (
            record.candidateRevisionId === leftRevisionId &&
            record.alternateRevisionId === rightRevisionId
          ) ||
          (
            record.candidateRevisionId === rightRevisionId &&
            record.alternateRevisionId === leftRevisionId
          );
        if (samePair) return record.id;
      } catch {
        continue;
      }
    }
    return null;
  }


  async #preserveAlternate(
    documentKey: string,
    displaced: AnyClasiDocument,
    expectedRevisionId: string | null,
  ): Promise<string> {
    const revisionId = this.#createId("rev");
    const alternate = {
      ...displaced,
      revisionId,
      parentRevisionId: expectedRevisionId,
      updatedAt: this.#now(),
    } as AnyClasiDocument;
    const markdown = encodeMarkdown(alternate);
    await writeImmutableRevision(this.#fileSystem, this.#paths, documentKey, alternate, markdown);
    return revisionId;
  }

  async #conflict(options: {
    input: StoreWriteInput;
    transaction: ClasiDocument<"transaction">;
    stagingPath: string;
    kind: ConflictKind;
    reasonCode: string;
    alternateRevisionId: string | null;
    canonicalOccupied: boolean;
  }): Promise<StoreWriteResult> {
    const conflictId = this.#createId("conflict");
    await writeConflictRecord(this.#fileSystem, this.#paths, {
      conflictId,
      revisionId: this.#createId("rev"),
      transactionId: options.transaction.records[0]!.id,
      candidate: options.input.candidate,
      kind: options.kind,
      reasonCode: options.reasonCode,
      alternateRevisionId: options.alternateRevisionId,
      canonicalOccupied: options.canonicalOccupied,
      now: this.#now(),
    });
    await this.#updateTransaction(
      this.#paths.transaction(options.transaction.records[0]!.id),
      options.transaction,
      "conflicted",
    );
    await this.#unlinkIfPresent(options.stagingPath);
    return {
      status: "conflict",
      kind: options.kind,
      reasonCode: options.reasonCode,
      conflictId,
      transactionId: options.transaction.records[0]!.id,
      candidateRevisionId: options.input.candidate.revisionId,
      alternateRevisionId: options.alternateRevisionId,
      canonicalOccupied: options.canonicalOccupied,
    };
  }

  async #createExclusiveParentDirectory(path: string): Promise<void> {
    await this.#fileSystem.mkdirParent(dirname(path));
    await this.#assertDataPath(dirname(path), true, "directory");
    await this.#fileSystem.createExclusiveDirectory(dirname(path));
  }

  async #updateTransaction(
    statePath: string,
    transaction: ClasiDocument<"transaction">,
    state: TransactionRecord["state"],
  ): Promise<void> {
    const record = transaction.records[0];
    if (!record) throw new StoreError("invalid-transaction-state");
    const updated: ClasiDocument<"transaction"> = {
      ...transaction,
      updatedAt: this.#now(),
      records: [{ ...record, state, updatedAt: this.#now() }],
    };
    await this.#replaceAtomically(statePath, encodeMarkdown(updated));
    transaction.updatedAt = updated.updatedAt;
    transaction.records = updated.records;
  }

  #transactionDocument(
    candidate: AnyClasiDocument,
    revisionId: string,
    record: TransactionRecord,
  ): ClasiDocument<"transaction"> {
    return {
      schemaVersion: CLASI_SCHEMA_VERSION,
      documentType: "transaction",
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      revisionId,
      parentRevisionId: null,
      updatedAt: record.updatedAt,
      records: [record],
    };
  }

  #expectedFromRecord(record: TransactionRecord): ExpectedCanonical {
    if (record.expectedRevisionId === null || record.expectedDigest === null) {
      return { kind: "absent" };
    }
    return {
      kind: "revision",
      revisionId: record.expectedRevisionId,
      digest: record.expectedDigest,
    };
  }

  async #writeLastGood(documentKey: string, markdown: string): Promise<void> {
    const path = this.#paths.lastGood(documentKey);
    await this.#fileSystem.mkdirParent(path);
    await this.#assertControlPath(path, true);
    await this.#replaceAtomically(path, markdown);
  }

  async #replaceAtomically(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await this.#fileSystem.writeExclusive(temporary, content);
    try {
      await this.#fileSystem.rename(temporary, path);
    } catch (error) {
      await this.#unlinkIfPresent(temporary).catch(() => undefined);
      throw error;
    }
  }

  async #tryValidatedRead(path: string): Promise<StoreReadResult | null> {
    try {
      const bytes = await this.#fileSystem.readBytes(path);
      const document = decodeMarkdown(bytes);
      return { document, bytes, digest: digestValidatedMarkdown(bytes) };
    } catch {
      return null;
    }
  }

  async #unlinkIfPresent(path: string): Promise<void> {
    try {
      await this.#fileSystem.unlink(path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }

  async #currentLockOwner(): Promise<LockOwner> {
    return {
      ownerToken: randomUUID(),
      pid: process.pid,
      processIdentity: await readProcessIdentity(process.pid) ?? `pid:${process.pid}`,
      startedAt: this.#now(),
    };
  }


  #assertLineage(expected: ExpectedCanonical, candidate: AnyClasiDocument): void {
    const parent = expected.kind === "revision" ? expected.revisionId : null;
    if (candidate.parentRevisionId !== parent) throw new StoreError("lineage-mismatch");
  }

  async #assertDataPath(
    path: string,
    allowMissingLeaf: boolean,
    kind: "file" | "directory" = "file",
  ): Promise<void> {
    await assertSafeContainedPath(this.#dataPin, path, {
      kind,
      allowMissingLeaf,
      ...(kind === "file" ? { maximumBytes: MAX_DOCUMENT_BYTES } : {}),
    });
  }

  async #assertControlPath(
    path: string,
    allowMissingLeaf: boolean,
    kind: "file" | "directory" = "file",
  ): Promise<void> {
    await assertSafeContainedPath(this.#controlPin, path, {
      kind,
      allowMissingLeaf,
      ...(kind === "file" ? { maximumBytes: MAX_DOCUMENT_BYTES } : {}),
    });
  }
}

function conflictDocumentKey(conflictId: string): string {
  return `doc_${createHash("sha256").update(conflictId).digest("hex").slice(0, 32)}`;
}

function isNoReplaceOrUnsupported(error: unknown): boolean {
  return ["EEXIST", "EPERM", "EXDEV", "ENOTSUP", "EOPNOTSUPP"].some(code => hasCode(error, code));
}

