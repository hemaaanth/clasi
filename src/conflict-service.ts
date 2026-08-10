import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { StoreError } from "./markdown-store.ts";
import type {
  ExpectedCanonical,
  MarkdownStore,
  RevalidateConflictResult,
  StoreReadResult,
  StoreWriteResult,
} from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import type {
  AnyClasiDocument,
  ConflictRecord,
  ContextRecord,
  NapkinRecord,
  PapercutRecord,
  ProposalRecord,
} from "./schema.ts";

export const DEFAULT_CONFLICT_LIST_LIMIT = 50;
export const MAX_CONFLICT_LIST_LIMIT = 100;
export const MAX_CONFLICT_PREVIEW_RECORDS = 100;

export type ConflictServiceReasonCode =
  | "confirmation-required"
  | "invalid-conflict"
  | "invalid-id"
  | "invalid-limit"
  | "invalid-selection"
  | "not-found"
  | "read-failed"
  | "unsupported-document"
  | "write-conflict"
  | "write-failed";

export interface ConflictMetadata {
  id: string;
  conflictKind: ConflictRecord["conflictKind"];
  reasonCode: string;
  transactionId: string;
  candidateRevisionId: string;
  alternateRevisionId: string | null;
  canonicalOccupied: boolean;
  scope: ScopeRef;
  createdAt: string;
  updatedAt: string;
}

export type ConflictRecordSummary =
  | {
      documentType: "context";
      id: string;
      logicalKey: string;
      kind: ContextRecord["kind"];
      value: string;
      approved: boolean;
      priority: number;
    }
  | {
      documentType: "napkin";
      id: string;
      logicalKey: string;
      category: NapkinRecord["category"];
      priority: number;
      recurrence: number;
      hitCount: number;
      situation: string;
      action: string;
    }
  | {
      documentType: "papercut";
      id: string;
      summary: string;
      severity: PapercutRecord["severity"];
      lifecycle: PapercutRecord["lifecycle"];
      repairState: PapercutRecord["repairState"];
      publicationState: PapercutRecord["publicationState"];
      publicationIssueNumber: number | null;
      recurrence: number;
      prevention: string;
      acceptanceCondition: string;
    }
  | {
      documentType: "proposal";
      id: string;
      targetType: ProposalRecord["targetType"];
      logicalKey: string;
      summary: string;
      status: ProposalRecord["status"];
    }
  | {
      documentType: "metrics";
      id: string;
      injectedCharacters: number;
      papercutsOpened: number;
      papercutsClosed: number;
      napkinHits: number;
      observedAt: string;
    };

export interface ConflictRevisionPreview {
  label: "A" | "B";
  revisionId: string;
  parentRevisionId: string | null;
  documentType: ConflictRecordSummary["documentType"];
  scope: ScopeRef;
  updatedAt: string;
  records: ConflictRecordSummary[];
  recordsTruncated: boolean;
}

export type ConflictListResult =
  | { status: "ok"; conflicts: ConflictMetadata[]; truncated: boolean }
  | { status: "rejected"; code: ConflictServiceReasonCode };

export type ConflictShowResult =
  | { status: "opaque"; conflict: ConflictMetadata }
  | {
      status: "validated";
      conflict: ConflictMetadata;
      candidate: ConflictRevisionPreview;
      alternate: ConflictRevisionPreview;
    }
  | { status: "rejected"; code: ConflictServiceReasonCode };

export type ConflictRevalidateResult =
  | {
      status: "validated";
      conflictId: string;
      alternateRevisionId: string;
      conflictRevisionId: string;
      transactionId: string;
    }
  | {
      status: "opaque";
      conflictId: string;
      code: Extract<RevalidateConflictResult, { status: "opaque" }>["code"];
    }
  | { status: "rejected"; code: ConflictServiceReasonCode };

export type ConflictActivationResult =
  | {
      status: "activated";
      conflictId: string;
      selectedRevisionId: string;
      revisionId: string;
      transactionId: string;
    }
  | { status: "choice-required"; code: "confirmation-required" }
  | { status: "conflict"; code: "write-conflict"; conflictId: string }
  | { status: "rejected"; code: ConflictServiceReasonCode };

export interface ConflictStore {
  listDocumentIds(directory: string, prefix: IdPrefix): Promise<string[]>;
  read(canonicalPath: string): Promise<StoreReadResult>;
  readRevision(documentKey: string, revisionId: string): Promise<StoreReadResult>;
  revalidateConflict(input: {
    conflictId: string;
    transactionId: string;
    canonicalPath: string;
    documentKey: string;
  }): Promise<RevalidateConflictResult>;
  write(input: {
    canonicalPath: string;
    documentKey: string;
    expected: ExpectedCanonical;
    candidate: AnyClasiDocument;
  }): Promise<StoreWriteResult>;
}

export interface ConflictServiceOptions {
  store: ConflictStore | Pick<MarkdownStore,
    "listDocumentIds" | "read" | "readRevision" | "revalidateConflict" | "write">;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

interface BoundConflict {
  metadata: ConflictMetadata;
  record: ConflictRecord;
  documentKey: string;
  candidate: AnyClasiDocument;
  alternate?: AnyClasiDocument;
  canonicalPath: string;
}

export class ConflictService {
  readonly #store: ConflictStore;
  readonly #paths: ClasiPaths;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: ConflictServiceOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async list(limit = DEFAULT_CONFLICT_LIST_LIMIT): Promise<ConflictListResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONFLICT_LIST_LIMIT) {
      return { status: "rejected", code: "invalid-limit" };
    }
    try {
      const ids = await this.#store.listDocumentIds(this.#paths.conflictDirectory, "conflict");
      const conflicts: ConflictMetadata[] = [];
      for (const id of ids) {
        const loaded = await this.#readMetadata(id);
        if ("code" in loaded) return { status: "rejected", code: loaded.code };
        conflicts.push(loaded.metadata);
      }
      conflicts.sort(compareConflicts);
      return {
        status: "ok",
        conflicts: conflicts.slice(0, limit),
        truncated: conflicts.length > limit,
      };
    } catch {
      return { status: "rejected", code: "read-failed" };
    }
  }

  async show(conflictId: string): Promise<ConflictShowResult> {
    const loaded = await this.#readMetadata(conflictId);
    if ("code" in loaded) return { status: "rejected", code: loaded.code };
    if (loaded.record.conflictKind === "opaque-quarantine") {
      return { status: "opaque", conflict: loaded.metadata };
    }
    const bound = await this.#bindValidated(loaded.metadata, loaded.record, true);
    if ("code" in bound) return { status: "rejected", code: bound.code };
    if (!bound.alternate) return { status: "rejected", code: "invalid-conflict" };
    const candidate = revisionPreview("A", bound.candidate);
    const alternate = revisionPreview("B", bound.alternate);
    if (!candidate || !alternate) return { status: "rejected", code: "invalid-conflict" };
    return {
      status: "validated",
      conflict: bound.metadata,
      candidate,
      alternate,
    };
  }

  async revalidate(conflictId: string): Promise<ConflictRevalidateResult> {
    const loaded = await this.#readMetadata(conflictId);
    if ("code" in loaded) return { status: "rejected", code: loaded.code };
    const bound = await this.#bindValidated(loaded.metadata, loaded.record, false);
    if ("code" in bound) return { status: "rejected", code: bound.code };
    try {
      const result = await this.#store.revalidateConflict({
        conflictId,
        transactionId: bound.record.transactionId,
        canonicalPath: bound.canonicalPath,
        documentKey: bound.documentKey,
      });
      return result.status === "validated"
        ? {
            status: "validated",
            conflictId,
            alternateRevisionId: result.alternateRevisionId,
            conflictRevisionId: result.conflictRevisionId,
            transactionId: result.transactionId,
          }
        : { status: "opaque", conflictId, code: result.code };
    } catch {
      return { status: "rejected", code: "write-failed" };
    }
  }

  async activate(
    conflictId: string,
    selectedRevisionId: string,
    confirmed: boolean,
  ): Promise<ConflictActivationResult> {
    if (!confirmed) return { status: "choice-required", code: "confirmation-required" };
    if (!isOpaqueId(selectedRevisionId, "rev")) {
      return { status: "rejected", code: "invalid-selection" };
    }
    const loaded = await this.#readMetadata(conflictId);
    if ("code" in loaded) return { status: "rejected", code: loaded.code };
    if (
      loaded.record.conflictKind !== "validated-revisions" ||
      loaded.record.alternateRevisionId === null ||
      (selectedRevisionId !== loaded.record.candidateRevisionId &&
        selectedRevisionId !== loaded.record.alternateRevisionId)
    ) {
      return { status: "rejected", code: "invalid-selection" };
    }
    const bound = await this.#bindValidated(loaded.metadata, loaded.record, true);
    if ("code" in bound) return { status: "rejected", code: bound.code };
    if (!bound.alternate) return { status: "rejected", code: "invalid-conflict" };
    const selected = selectedRevisionId === bound.candidate.revisionId
      ? bound.candidate
      : bound.alternate;

    let current: StoreReadResult | null;
    try {
      current = await this.#store.read(bound.canonicalPath);
    } catch (error) {
      if (error instanceof StoreError && error.code === "canonical-missing") current = null;
      else return { status: "rejected", code: "read-failed" };
    }
    if (
      current &&
      (
        !isActivatableDocument(current.document) ||
        !sameDocumentIdentity(current.document, selected) ||
        canonicalPathFor(this.#paths, current.document) !== bound.canonicalPath
      )
    ) {
      return { status: "rejected", code: "invalid-conflict" };
    }
    const expected: ExpectedCanonical = current === null
      ? { kind: "absent" }
      : {
          kind: "revision",
          revisionId: current.document.revisionId,
          digest: current.digest,
        };
    const revisionId = this.#createId("rev");
    const candidate: AnyClasiDocument = {
      ...selected,
      revisionId,
      parentRevisionId: current?.document.revisionId ?? null,
      updatedAt: this.#now(),
    };
    try {
      const result = await this.#store.write({
        canonicalPath: bound.canonicalPath,
        documentKey: bound.documentKey,
        expected,
        candidate,
      });
      return result.status === "committed"
        ? {
            status: "activated",
            conflictId,
            selectedRevisionId,
            revisionId: result.revisionId,
            transactionId: result.transactionId,
          }
        : { status: "conflict", code: "write-conflict", conflictId: result.conflictId };
    } catch {
      return { status: "rejected", code: "write-failed" };
    }
  }

  async #readMetadata(
    conflictId: string,
  ): Promise<{ metadata: ConflictMetadata; record: ConflictRecord } | { code: ConflictServiceReasonCode }> {
    if (!isOpaqueId(conflictId, "conflict")) return { code: "invalid-id" };
    let read: StoreReadResult;
    try {
      read = await this.#store.read(this.#paths.conflict(conflictId));
    } catch (error) {
      return {
        code: error instanceof StoreError && error.code === "canonical-missing"
          ? "not-found"
          : "read-failed",
      };
    }
    const document = read.document;
    if (document.documentType !== "conflict") return { code: "invalid-conflict" };
    const record = document.records[0];
    const scope = scopeFrom(document);
    if (
      document.records.length !== 1 ||
      !record ||
      record.id !== conflictId ||
      !scope
    ) {
      return { code: "invalid-conflict" };
    }
    return {
      record,
      metadata: {
        id: record.id,
        conflictKind: record.conflictKind,
        reasonCode: record.reasonCode,
        transactionId: record.transactionId,
        candidateRevisionId: record.candidateRevisionId,
        alternateRevisionId: record.alternateRevisionId,
        canonicalOccupied: record.canonicalOccupied,
        scope,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    };
  }

  async #bindValidated(
    metadata: ConflictMetadata,
    record: ConflictRecord,
    requireAlternate: boolean,
  ): Promise<BoundConflict | { code: ConflictServiceReasonCode }> {
    let transactionRead: StoreReadResult;
    try {
      transactionRead = await this.#store.read(this.#paths.transaction(record.transactionId));
    } catch {
      return { code: "invalid-conflict" };
    }
    const transactionDocument = transactionRead.document;
    if (transactionDocument.documentType !== "transaction") {
      return { code: "invalid-conflict" };
    }
    const transaction = transactionDocument.records[0];
    if (
      transactionDocument.records.length !== 1 ||
      !transaction ||
      transaction.id !== record.transactionId ||
      transaction.state !== "conflicted" ||
      transaction.candidateRevisionId !== record.candidateRevisionId ||
      transactionDocument.scopeType !== metadata.scope.type ||
      transactionDocument.scopeId !== metadata.scope.id
    ) {
      return { code: "invalid-conflict" };
    }
    const typedTransaction = transaction;
    let candidate: AnyClasiDocument;
    try {
      candidate = (await this.#store.readRevision(
        typedTransaction.documentKey,
        record.candidateRevisionId,
      )).document;
    } catch {
      return { code: "invalid-conflict" };
    }
    if (
      candidate.revisionId !== record.candidateRevisionId ||
      candidate.scopeType !== metadata.scope.type ||
      candidate.scopeId !== metadata.scope.id ||
      !isActivatableDocument(candidate)
    ) {
      return { code: "invalid-conflict" };
    }
    const canonicalPath = canonicalPathFor(this.#paths, candidate);
    if (!canonicalPath) return { code: "unsupported-document" };

    let alternate: AnyClasiDocument | undefined;
    if (record.alternateRevisionId !== null) {
      try {
        alternate = (await this.#store.readRevision(
          typedTransaction.documentKey,
          record.alternateRevisionId,
        )).document;
      } catch {
        return { code: "invalid-conflict" };
      }
      if (
        alternate.revisionId !== record.alternateRevisionId ||
        !sameDocumentIdentity(candidate, alternate) ||
        !isActivatableDocument(alternate) ||
        canonicalPathFor(this.#paths, alternate) !== canonicalPath
      ) {
        return { code: "invalid-conflict" };
      }
    }
    if (requireAlternate && (!alternate || record.conflictKind !== "validated-revisions")) {
      return { code: "invalid-conflict" };
    }
    return {
      metadata,
      record,
      documentKey: typedTransaction.documentKey,
      candidate,
      ...(alternate ? { alternate } : {}),
      canonicalPath,
    };
  }
}

function revisionPreview(
  label: "A" | "B",
  document: AnyClasiDocument,
): ConflictRevisionPreview | null {
  if (!isActivatableDocument(document)) return null;
  const records = summarizeRecords(document);
  const scope = scopeFrom(document);
  if (!scope) return null;
  return {
    label,
    revisionId: document.revisionId,
    parentRevisionId: document.parentRevisionId,
    documentType: document.documentType,
    scope,
    updatedAt: document.updatedAt,
    records: records.slice(0, MAX_CONFLICT_PREVIEW_RECORDS),
    recordsTruncated: records.length > MAX_CONFLICT_PREVIEW_RECORDS,
  };
}

function summarizeRecords(document: ActivatableDocument): ConflictRecordSummary[] {
  switch (document.documentType) {
    case "context":
      return document.records.map(record => ({
        documentType: "context",
        id: record.id,
        logicalKey: record.logicalKey,
        kind: record.kind,
        value: record.value,
        approved: record.approved,
        priority: record.priority,
      }));
    case "napkin":
      return document.records.map(record => ({
        documentType: "napkin",
        id: record.id,
        logicalKey: record.logicalKey,
        category: record.category,
        priority: record.priority,
        recurrence: record.recurrence,
        hitCount: record.hitCount,
        situation: record.situation,
        action: record.action,
      }));
    case "papercut":
      return document.records.map(record => ({
        documentType: "papercut",
        id: record.id,
        summary: record.summary,
        severity: record.severity,
        lifecycle: record.lifecycle,
        repairState: record.repairState,
        publicationState: record.publicationState,
        publicationIssueNumber: record.publicationIssueNumber,
        recurrence: record.recurrence,
        prevention: record.prevention,
        acceptanceCondition: record.acceptanceCondition,
      }));
    case "proposal":
      return document.records.map(record => ({
        documentType: "proposal",
        id: record.id,
        targetType: record.targetType,
        logicalKey: record.logicalKey,
        summary: record.summary,
        status: record.status,
      }));
    case "metrics":
      return document.records.map(record => ({
        documentType: "metrics",
        id: record.id,
        injectedCharacters: record.injectedCharacters,
        papercutsOpened: record.papercutsOpened,
        papercutsClosed: record.papercutsClosed,
        napkinHits: record.napkinHits,
        observedAt: record.observedAt,
      }));
  }
}

type ActivatableDocument = Extract<AnyClasiDocument, {
  documentType: "context" | "napkin" | "papercut" | "proposal" | "metrics";
}>;

function isActivatableDocument(document: AnyClasiDocument): document is ActivatableDocument {
  return ["context", "napkin", "papercut", "proposal", "metrics"].includes(document.documentType);
}

function canonicalPathFor(paths: ClasiPaths, document: ActivatableDocument): string | null {
  const scope = scopeFrom(document);
  if (!scope) return null;
  try {
    switch (document.documentType) {
      case "context":
        return paths.context(scope);
      case "napkin":
        return paths.napkin(scope);
      case "proposal": {
        const record = onlyRecord(document.records);
        return record ? paths.proposal(scope, record.id) : null;
      }
      case "papercut": {
        const record = onlyRecord(document.records);
        if (!record) return null;
        return paths.papercut(scope, record.lifecycle === "open" ? "open" : "archive", record.id);
      }
      case "metrics":
        return scope.type === "machine" ? paths.metrics(scope.id) : null;
    }
  } catch {
    return null;
  }
}

function onlyRecord<T>(records: readonly T[]): T | undefined {
  return records.length === 1 ? records[0] : undefined;
}

function scopeFrom(document: AnyClasiDocument): ScopeRef | null {
  if (document.scopeType === "global" && document.scopeId === "global") return { type: "global", id: "global" };
  if (document.scopeType === "machine" && isOpaqueId(document.scopeId, "machine")) {
    return { type: "machine", id: document.scopeId };
  }
  if (document.scopeType === "repository" && isOpaqueId(document.scopeId, "repo")) {
    return { type: "repository", id: document.scopeId };
  }
  return null;
}

function sameDocumentIdentity(left: AnyClasiDocument, right: AnyClasiDocument): boolean {
  return left.documentType === right.documentType &&
    left.scopeType === right.scopeType &&
    left.scopeId === right.scopeId;
}

function compareConflicts(left: ConflictMetadata, right: ConflictMetadata): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}
