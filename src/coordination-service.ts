import { constants } from "node:fs";
import type { Dir, Stats } from "node:fs";
import { lstat, open, opendir, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isOpaqueId } from "./ids.ts";
import {
  documentLockOwnerPath,
  LockError,
  MAX_LOCK_OWNER_BYTES,
  recoverDocumentLock,
  validateLockOwnerDocument,
} from "./lock.ts";
import type { MarkdownStore } from "./markdown-store.ts";
import type { ClasiPaths } from "./paths.ts";
import {
  assertRootUnchanged,
  assertSafeContainedPath,
  hasErrorCode,
} from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";
import { MAX_DOCUMENT_BYTES } from "./schema.ts";
import type { ClasiDocument, TransactionRecord } from "./schema.ts";

const DEFAULT_TRANSACTION_LIMIT = 100;
const MAX_TRANSACTION_LIMIT = 100;
const MAX_INSPECTED_TRANSACTIONS = 1_000;

export type CoordinationReasonCode =
  | "invalid-limit"
  | "invalid-document-id"
  | "invalid-transaction-id"
  | "unsafe-control-root"
  | "unsafe-data-root"
  | "storage-unavailable"
  | "invalid-transaction-state"
  | "transaction-scan-limit"
  | "transaction-not-terminal"
  | "transaction-changed"
  | "lock-owner-alive"
  | "lock-scan-limit"
  | "lock-state-invalid"
  | "lock-owner-changed"
  | "lock-owner-invalid"
  | "lock-recovery-unavailable"
  | "quarantine-unsafe"
  | "quarantine-changed"
  | "file-identity-unavailable"
  | "cleanup-incomplete";

const MAX_INSPECTED_LOCKS = 1_000;

export interface TransactionSummary {
  id: string;
  documentId: string;
  state: TransactionRecord["state"];
  createdAt: string;
  updatedAt: string;
}

export type TransactionListResult =
  | { status: "ok"; transactions: TransactionSummary[]; truncated: boolean }
  | { status: "empty" }
  | { status: "rejected"; code: CoordinationReasonCode };

interface LoadedTransaction {
  document: ClasiDocument<"transaction">;
  record: TransactionRecord;
}

export type LockListResult =
  | { status: "ok"; documentIds: string[]; truncated: boolean }
  | { status: "empty" }
  | { status: "rejected"; code: CoordinationReasonCode };

export interface CoordinationWarning {
  removes: ["transaction-state", "quarantine-displaced-copy-if-present"];
  preserves: ["revisions", "canonical-documents", "other-directories"];
}

export type RecoverLockResult =
  | { status: "recovered"; documentId: string }
  | { status: "choice-required"; code: "confirmation-required"; documentId: string }
  | { status: "rejected"; code: CoordinationReasonCode };

export type CleanTransactionResult =
  | {
      status: "cleaned";
      transactionId: string;
      quarantineRemoved: boolean;
      stateRemoved: true;
    }
  | {
      status: "choice-required";
      code: "confirmation-required";
      transactionId: string;
      warning: CoordinationWarning;
    }
  | { status: "rejected"; code: CoordinationReasonCode };

export interface CoordinationServiceOptions {
  controlPin: RootPin;
  dataPin: RootPin;
  paths: ClasiPaths;
  store: MarkdownStore;
  readProcessIdentity?: (pid: number) => Promise<string | null>;
  beforeQuarantineUnlink?: () => Promise<void>;
}

export class CoordinationService {
  readonly #controlPin: RootPin;
  readonly #dataPin: RootPin;
  readonly #paths: ClasiPaths;
  readonly #store: MarkdownStore;
  readonly #readProcessIdentity: ((pid: number) => Promise<string | null>) | undefined;
  readonly #beforeQuarantineUnlink: (() => Promise<void>) | undefined;

  constructor(options: CoordinationServiceOptions) {
    this.#controlPin = options.controlPin;
    this.#dataPin = options.dataPin;
    this.#paths = options.paths;
    this.#store = options.store;
    this.#readProcessIdentity = options.readProcessIdentity;
    this.#beforeQuarantineUnlink = options.beforeQuarantineUnlink;
  }

  async listTransactions(limit = DEFAULT_TRANSACTION_LIMIT): Promise<TransactionListResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTION_LIMIT) {
      return rejected("invalid-limit");
    }

    try {
      await assertRootUnchanged(this.#dataPin);
      await assertSafeContainedPath(this.#dataPin, this.#paths.transactionDirectory, {
        kind: "directory",
        allowMissingLeaf: true,
      });
    } catch {
      return rejected("unsafe-data-root");
    }

    let directory;
    try {
      directory = await opendir(this.#paths.transactionDirectory);
    } catch (error) {
      return hasErrorCode(error, "ENOENT") ? { status: "empty" } : rejected("storage-unavailable");
    }

    const transactions: TransactionSummary[] = [];
    let inspected = 0;
    try {
      while (true) {
        let entry;
        try {
          entry = await directory.read();
        } catch (error) {
          if (hasErrorCode(error, "ENOENT") && inspected === 0) break;
          return rejected("storage-unavailable");
        }
        if (entry === null) break;
        if (!isOpaqueId(entry.name, "tx")) continue;
        if (!entry.isDirectory()) return rejected("invalid-transaction-state");
        if (inspected >= MAX_INSPECTED_TRANSACTIONS) return rejected("transaction-scan-limit");
        inspected += 1;

        const loaded = await this.#readTransaction(entry.name);
        if (loaded === null) return rejected("invalid-transaction-state");
        transactions.push(projectTransaction(loaded.record));
      }
    } finally {
      await closeDirectory(directory);
    }

    try {
      await assertRootUnchanged(this.#dataPin);
    } catch {
      return rejected("unsafe-data-root");
    }

    if (transactions.length === 0) return { status: "empty" };
    transactions.sort(compareTransactions);
    return {
      status: "ok",
      transactions: transactions.slice(0, limit),
      truncated: transactions.length > limit,
    };
  }

  async listLocks(limit = DEFAULT_TRANSACTION_LIMIT): Promise<LockListResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTION_LIMIT) {
      return rejected("invalid-limit");
    }

    try {
      await assertRootUnchanged(this.#controlPin);
      await assertSafeContainedPath(this.#controlPin, this.#paths.lockDirectory, {
        kind: "directory",
        allowMissingLeaf: true,
      });
    } catch {
      return rejected("unsafe-control-root");
    }

    let directory;
    try {
      directory = await opendir(this.#paths.lockDirectory);
    } catch (error) {
      return hasErrorCode(error, "ENOENT") ? { status: "empty" } : rejected("storage-unavailable");
    }

    const documentIds: string[] = [];
    try {
      while (true) {
        let entry;
        try {
          entry = await directory.read();
        } catch (error) {
          if (hasErrorCode(error, "ENOENT") && documentIds.length === 0) break;
          return rejected("storage-unavailable");
        }
        if (entry === null) break;
        if (!isOpaqueId(entry.name, "doc") || !entry.isDirectory()) {
          return rejected("lock-state-invalid");
        }
        if (documentIds.length >= MAX_INSPECTED_LOCKS) return rejected("lock-scan-limit");
        if (!(await this.#validateLock(entry.name))) return rejected("lock-state-invalid");
        documentIds.push(entry.name);
      }
    } finally {
      await closeDirectory(directory);
    }

    try {
      await assertRootUnchanged(this.#controlPin);
    } catch {
      return rejected("unsafe-control-root");
    }
    if (documentIds.length === 0) return { status: "empty" };
    documentIds.sort();
    return {
      status: "ok",
      documentIds: documentIds.slice(0, limit),
      truncated: documentIds.length > limit,
    };
  }

  async recoverLock(documentId: string, confirmed: boolean): Promise<RecoverLockResult> {
    if (!isOpaqueId(documentId, "doc")) return rejected("invalid-document-id");
    if (!confirmed) {
      return { status: "choice-required", code: "confirmation-required", documentId };
    }

    const lockPath = this.#paths.lock(documentId);
    try {
      await assertRootUnchanged(this.#controlPin);
      await assertSafeContainedPath(this.#controlPin, lockPath, {
        kind: "directory",
        allowMissingLeaf: true,
      });
    } catch {
      return rejected("unsafe-control-root");
    }

    let failure: CoordinationReasonCode | null = null;
    try {
      await recoverDocumentLock(lockPath, {
        confirm: true,
        ...(this.#readProcessIdentity ? { readProcessIdentity: this.#readProcessIdentity } : {}),
      });
    } catch (error) {
      failure = lockReason(error);
    }

    try {
      await assertRootUnchanged(this.#controlPin);
    } catch {
      return rejected("unsafe-control-root");
    }
    if (failure !== null) return rejected(failure);
    return { status: "recovered", documentId };
  }

  async cleanTransaction(transactionId: string, confirmed: boolean): Promise<CleanTransactionResult> {
    if (!isOpaqueId(transactionId, "tx")) return rejected("invalid-transaction-id");
    if (!confirmed) {
      return {
        status: "choice-required",
        code: "confirmation-required",
        transactionId,
        warning: cleanupWarning(),
      };
    }

    const loaded = await this.#readTransaction(transactionId);
    if (loaded === null) return rejected("invalid-transaction-state");
    if (loaded.record.state !== "promoted" && loaded.record.state !== "conflicted") {
      return rejected("transaction-not-terminal");
    }

    const statePath = this.#paths.transaction(transactionId);
    const transactionDirectory = dirname(statePath);
    const quarantinePath = this.#paths.quarantine(transactionId);
    try {
      await assertRootUnchanged(this.#dataPin);
      await assertSafeContainedPath(this.#dataPin, transactionDirectory, {
        kind: "directory",
        allowMissingLeaf: false,
      });
      await assertSafeContainedPath(this.#dataPin, statePath, {
        kind: "file",
        allowMissingLeaf: false,
        maximumBytes: MAX_DOCUMENT_BYTES,
      });
      await assertSafeContainedPath(this.#dataPin, quarantinePath, {
        kind: "file",
        allowMissingLeaf: true,
        maximumBytes: MAX_DOCUMENT_BYTES,
      });
    } catch {
      return rejected("quarantine-unsafe");
    }

    const expectedStateName = basename(statePath);
    let transactionDirectoryHandle;
    try {
      transactionDirectoryHandle = await opendir(transactionDirectory);
      const first = await transactionDirectoryHandle.read();
      const second = await transactionDirectoryHandle.read();
      if (
        first === null ||
        first.name !== expectedStateName ||
        !first.isFile() ||
        second !== null
      ) {
        return rejected("invalid-transaction-state");
      }
    } catch {
      return rejected("invalid-transaction-state");
    } finally {
      if (transactionDirectoryHandle !== undefined) {
        await closeDirectory(transactionDirectoryHandle);
      }
    }

    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return rejected("file-identity-unavailable");

    let stateHandle: FileHandle;
    try {
      stateHandle = await open(statePath, constants.O_RDONLY | noFollow);
    } catch {
      return rejected("invalid-transaction-state");
    }

    let quarantineHandle: FileHandle | undefined;
    let quarantineRemoved = false;
    try {
      const openedState = await stateHandle.stat();
      if (!openedState.isFile() || openedState.size > MAX_DOCUMENT_BYTES) {
        return rejected("invalid-transaction-state");
      }

      try {
        quarantineHandle = await open(quarantinePath, constants.O_RDONLY | noFollow);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) return rejected("quarantine-unsafe");
      }

      let openedQuarantine: Stats | undefined;
      if (quarantineHandle !== undefined) {
        openedQuarantine = await quarantineHandle.stat();
        if (!openedQuarantine.isFile() || openedQuarantine.size > MAX_DOCUMENT_BYTES) {
          return rejected("quarantine-unsafe");
        }
      }

      if (this.#beforeQuarantineUnlink) await this.#beforeQuarantineUnlink();

      const reloaded = await this.#readTransaction(transactionId);
      if (
        reloaded === null ||
        (reloaded.record.state !== "promoted" && reloaded.record.state !== "conflicted") ||
        !sameTransaction(loaded, reloaded)
      ) {
        return rejected("transaction-changed");
      }

      let linkedState: Stats;
      try {
        linkedState = await lstat(statePath);
      } catch {
        return rejected("transaction-changed");
      }
      if (
        !linkedState.isFile() ||
        linkedState.size > MAX_DOCUMENT_BYTES ||
        !sameFileIdentity(openedState, linkedState)
      ) {
        return rejected("transaction-changed");
      }

      if (quarantineHandle !== undefined && openedQuarantine !== undefined) {
        let linkedQuarantine: Stats;
        try {
          linkedQuarantine = await lstat(quarantinePath);
        } catch {
          return rejected("quarantine-changed");
        }
        if (
          !linkedQuarantine.isFile() ||
          linkedQuarantine.size > MAX_DOCUMENT_BYTES ||
          !sameFileIdentity(openedQuarantine, linkedQuarantine)
        ) {
          return rejected("quarantine-changed");
        }
        try {
          await unlink(quarantinePath);
          quarantineRemoved = true;
        } catch {
          return rejected("quarantine-changed");
        }
      }

      try {
        await unlink(statePath);
        await rmdir(transactionDirectory);
      } catch {
        return rejected("cleanup-incomplete");
      }
    } catch {
      return rejected("quarantine-unsafe");
    } finally {
      try {
        await quarantineHandle?.close();
      } catch {
        // Cleanup outcome is based on verified path operations, never close diagnostics.
      }
      try {
        await stateHandle.close();
      } catch {
        // Cleanup outcome is based on verified path operations, never close diagnostics.
      }
    }

    try {
      await assertRootUnchanged(this.#dataPin);
    } catch {
      return rejected("unsafe-data-root");
    }
    return {
      status: "cleaned",
      transactionId,
      quarantineRemoved,
      stateRemoved: true,
    };
  }

  async #validateLock(documentId: string): Promise<boolean> {
    const lockPath = this.#paths.lock(documentId);
    const ownerPath = documentLockOwnerPath(lockPath);
    try {
      await assertSafeContainedPath(this.#controlPin, lockPath, {
        kind: "directory",
        allowMissingLeaf: false,
      });
      await assertSafeContainedPath(this.#controlPin, ownerPath, {
        kind: "file",
        allowMissingLeaf: false,
        maximumBytes: MAX_LOCK_OWNER_BYTES,
      });
    } catch {
      return false;
    }

    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return false;
    let handle;
    try {
      handle = await open(ownerPath, constants.O_RDONLY | noFollow);
    } catch {
      return false;
    }

    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_LOCK_OWNER_BYTES) return false;
      const content = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(content, "utf8") > MAX_LOCK_OWNER_BYTES) return false;
      const linked = await lstat(ownerPath);
      if (
        !linked.isFile() ||
        linked.size > MAX_LOCK_OWNER_BYTES ||
        !sameFileIdentity(opened, linked)
      ) {
        return false;
      }
      validateLockOwnerDocument(content);
      return true;
    } catch {
      return false;
    } finally {
      try {
        await handle.close();
      } catch {
        // Lock inspection never reports descriptor details.
      }
    }
  }

  async #readTransaction(transactionId: string): Promise<LoadedTransaction | null> {
    try {
      const read = await this.#store.read(this.#paths.transaction(transactionId));
      if (read.document.documentType !== "transaction" || read.document.records.length !== 1) {
        return null;
      }
      const document = read.document as ClasiDocument<"transaction">;
      const record = document.records[0];
      if (
        record === undefined ||
        record.id !== transactionId ||
        !validScope(document.scopeType, document.scopeId)
      ) {
        return null;
      }
      return { document, record };
    } catch {
      return null;
    }
  }
}

function projectTransaction(record: TransactionRecord): TransactionSummary {
  return {
    id: record.id,
    documentId: record.documentKey,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function compareTransactions(left: TransactionSummary, right: TransactionSummary): number {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updated !== 0) return updated;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validScope(type: string, id: string): boolean {
  return (type === "global" && id === "global") ||
    (type === "machine" && isOpaqueId(id, "machine")) ||
    (type === "repository" && isOpaqueId(id, "repo"));
}

function cleanupWarning(): CoordinationWarning {
  return {
    removes: ["transaction-state", "quarantine-displaced-copy-if-present"],
    preserves: ["revisions", "canonical-documents", "other-directories"],
  };
}

function sameFileIdentity(opened: Stats, linked: Stats): boolean {
  return usableIdentity(opened.dev) &&
    usableIdentity(opened.ino) &&
    usableIdentity(linked.dev) &&
    usableIdentity(linked.ino) &&
    opened.dev === linked.dev &&
    opened.ino === linked.ino;
}

function sameTransaction(left: LoadedTransaction, right: LoadedTransaction): boolean {
  return left.document.revisionId === right.document.revisionId &&
    left.document.scopeType === right.document.scopeType &&
    left.document.scopeId === right.document.scopeId &&
    left.record.id === right.record.id &&
    left.record.documentKey === right.record.documentKey &&
    left.record.state === right.record.state &&
    left.record.candidateRevisionId === right.record.candidateRevisionId &&
    left.record.expectedRevisionId === right.record.expectedRevisionId &&
    left.record.expectedDigest === right.record.expectedDigest &&
    left.record.createdAt === right.record.createdAt &&
    left.record.updatedAt === right.record.updatedAt;
}

function usableIdentity(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function lockReason(error: unknown): CoordinationReasonCode {
  if (!(error instanceof LockError)) return "lock-recovery-unavailable";
  if (error.code === "lock-owner-alive") return "lock-owner-alive";
  if (error.code === "lock-owner-changed") return "lock-owner-changed";
  if (error.code === "lock-owner-invalid") return "lock-owner-invalid";
  return "lock-recovery-unavailable";
}

function rejected(code: CoordinationReasonCode): { status: "rejected"; code: CoordinationReasonCode } {
  return { status: "rejected", code };
}

async function closeDirectory(directory: Dir): Promise<void> {
  try {
    await directory.close();
  } catch {
    // Directory-close diagnostics are never exposed.
  }
}
