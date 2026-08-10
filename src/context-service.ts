import { createHash } from "node:crypto";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { MarkdownStore, StoreError } from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import {
  SAFE_SOURCE_CLASSIFICATIONS,
  validatePrivateFields,
} from "./privacy.ts";
import type {
  PrivacyReasonCode,
  SafeSourceClassification,
  SourceClassification,
} from "./privacy.ts";
import { CLASI_SCHEMA_VERSION } from "./schema.ts";
import type { ClasiDocument, ContextRecord, ProposalRecord } from "./schema.ts";

export interface ContextCandidate {
  scope: ScopeRef;
  logicalKey: string;
  kind: "fact" | "preference";
  value: string;
  sourceClassification: SourceClassification;
  priority: number;
}

export type ContextReasonCode =
  | PrivacyReasonCode
  | "approval-required"
  | "document-mismatch"
  | "duplicate-scope"
  | "invalid-field"
  | "invalid-machine-fact"
  | "proposal-dismissed"
  | "proposal-not-found"
  | "read-failed"
  | "write-conflict"
  | "write-failed";

export type ContextWriteOutcome =
  | {
      status: "activated";
      recordId: string;
      revisionId: string;
      changed: boolean;
    }
  | { status: "rejected"; code: ContextReasonCode };

export type ContextScopeRead =
  | { status: "ok"; scope: ScopeRef; records: readonly ContextRecord[] }
  | { status: "empty"; scope: ScopeRef }
  | { status: "degraded"; scope: ScopeRef; code: ContextReasonCode };

export interface ScopedContextRecord {
  scope: ScopeRef;
  record: ContextRecord;
}

export type ContextResolution =
  | {
      status: "ok";
      active: readonly ScopedContextRecord[];
      shadowed: readonly ScopedContextRecord[];
      unapproved: readonly ScopedContextRecord[];
    }
  | { status: "degraded"; code: ContextReasonCode };

export interface ContextServiceOptions {
  store: MarkdownStore;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

export class ContextService {
  readonly #store: MarkdownStore;
  readonly #paths: ClasiPaths;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: ContextServiceOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async readScope(scope: ScopeRef): Promise<ContextScopeRead> {
    if (!isValidScope(scope)) return { status: "degraded", scope, code: "invalid-field" };
    try {
      const read = await this.#store.read(this.#paths.context(scope));
      if (
        read.document.documentType !== "context" ||
        read.document.scopeType !== scope.type ||
        read.document.scopeId !== scope.id
      ) {
        return { status: "degraded", scope, code: "document-mismatch" };
      }
      return { status: "ok", scope, records: read.document.records };
    } catch (error) {
      if (error instanceof StoreError && error.code === "canonical-missing") {
        return { status: "empty", scope };
      }
      return { status: "degraded", scope, code: "read-failed" };
    }
  }

  async resolve(scopes: readonly ScopeRef[]): Promise<ContextResolution> {
    const types = new Set(scopes.map(scope => scope.type));
    if (types.size !== scopes.length) return { status: "degraded", code: "duplicate-scope" };

    const reads = await Promise.all(scopes.map(scope => this.readScope(scope)));
    const degraded = reads.find(read => read.status === "degraded");
    if (degraded?.status === "degraded") return { status: "degraded", code: degraded.code };

    const approved: ScopedContextRecord[] = [];
    const unapproved: ScopedContextRecord[] = [];
    for (const read of reads) {
      if (read.status !== "ok") continue;
      for (const record of read.records) {
        const scoped = { scope: read.scope, record };
        (record.approved ? approved : unapproved).push(scoped);
      }
    }

    approved.sort(compareForPrecedence);
    const active: ScopedContextRecord[] = [];
    const shadowed: ScopedContextRecord[] = [];
    const winningKeys = new Set<string>();
    for (const entry of approved) {
      if (winningKeys.has(entry.record.logicalKey)) {
        shadowed.push(entry);
      } else {
        winningKeys.add(entry.record.logicalKey);
        active.push(entry);
      }
    }
    active.sort(compareForInjection);
    shadowed.sort(compareForReview);
    unapproved.sort(compareForReview);
    return { status: "ok", active, shadowed, unapproved };
  }

  async activateSafeMachineFact(candidate: ContextCandidate): Promise<ContextWriteOutcome> {
    const validation = validateContextCandidate(candidate);
    if (!validation.ok) return { status: "rejected", code: validation.code };
    if (candidate.sourceClassification !== "safe-machine-fact") {
      return { status: "rejected", code: "approval-required" };
    }
    if (candidate.scope.type !== "machine" || candidate.kind !== "fact") {
      return { status: "rejected", code: "invalid-machine-fact" };
    }
    return this.#upsertApproved(candidate as ApprovedContextCandidate);
  }

  async activateApprovedProposal(input: {
    scope: ScopeRef;
    proposalId: string;
    kind: "fact" | "preference";
    priority: number;
  }): Promise<ContextWriteOutcome> {
    if (!isValidScope(input.scope) || !isOpaqueId(input.proposalId, "proposal")) {
      return { status: "rejected", code: "invalid-field" };
    }
    if (!isContextKind(input.kind) || !isPriority(input.priority)) {
      return { status: "rejected", code: "invalid-field" };
    }

    let proposal: ProposalRecord;
    try {
      const read = await this.#store.read(this.#paths.proposal(input.scope, input.proposalId));
      const document = read.document;
      if (
        document.documentType !== "proposal" ||
        document.scopeType !== input.scope.type ||
        document.scopeId !== input.scope.id
      ) {
        return { status: "rejected", code: "document-mismatch" };
      }
      const record = document.records[0];
      if (
        document.records.length !== 1 ||
        !record ||
        record.id !== input.proposalId ||
        record.targetType !== "context"
      ) {
        return { status: "rejected", code: "document-mismatch" };
      }
      proposal = record;
    } catch (error) {
      return {
        status: "rejected",
        code: error instanceof StoreError && error.code === "canonical-missing"
          ? "proposal-not-found"
          : "read-failed",
      };
    }

    if (proposal.status === "dismissed") return { status: "rejected", code: "proposal-dismissed" };
    if (proposal.status !== "approved") return { status: "rejected", code: "approval-required" };
    return this.#upsertApproved({
      scope: input.scope,
      logicalKey: proposal.logicalKey,
      kind: input.kind,
      value: proposal.summary,
      sourceClassification: proposal.sourceClassification,
      priority: input.priority,
    });
  }

  async #upsertApproved(candidate: ApprovedContextCandidate): Promise<ContextWriteOutcome> {
    const validation = validateContextCandidate(candidate);
    if (!validation.ok) return { status: "rejected", code: validation.code };
    const canonicalPath = this.#paths.context(candidate.scope);
    let callbackOutcome: ContextWriteOutcome | undefined;

    try {
      const result = await this.#store.mutate({
        canonicalPath,
        documentKey: stableDocumentKey(canonicalPath),
        mutate: current => {
          let records: ContextRecord[] = [];
          if (current) {
            if (
              current.document.documentType !== "context" ||
              current.document.scopeType !== candidate.scope.type ||
              current.document.scopeId !== candidate.scope.id
            ) {
              callbackOutcome = { status: "rejected", code: "document-mismatch" };
              return null;
            }
            records = current.document.records;
          }

          const matches = records.filter(record => record.logicalKey === candidate.logicalKey);
          const existing = matches[0];
          if (
            matches.length === 1 &&
            existing &&
            existing.kind === candidate.kind &&
            existing.value === candidate.value &&
            existing.sourceClassification === candidate.sourceClassification &&
            existing.approved &&
            existing.priority === candidate.priority
          ) {
            callbackOutcome = {
              status: "activated",
              recordId: existing.id,
              revisionId: current!.document.revisionId,
              changed: false,
            };
            return null;
          }

          const now = this.#now();
          const record: ContextRecord = {
            id: existing?.id ?? this.#createId("ctx"),
            logicalKey: candidate.logicalKey,
            kind: candidate.kind,
            value: candidate.value,
            sourceClassification: candidate.sourceClassification,
            approved: true,
            priority: candidate.priority,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          const document: ClasiDocument<"context"> = {
            schemaVersion: CLASI_SCHEMA_VERSION,
            documentType: "context",
            scopeType: candidate.scope.type,
            scopeId: candidate.scope.id,
            revisionId: this.#createId("rev"),
            parentRevisionId: current?.document.revisionId ?? null,
            updatedAt: now,
            records: [...records.filter(item => item.logicalKey !== candidate.logicalKey), record],
          };
          callbackOutcome = {
            status: "activated",
            recordId: record.id,
            revisionId: document.revisionId,
            changed: true,
          };
          return document;
        },
      });
      if (result.status === "conflict") return { status: "rejected", code: "write-conflict" };
      return callbackOutcome ?? { status: "rejected", code: "write-failed" };
    } catch {
      return { status: "rejected", code: "write-failed" };
    }
  }
}

type ApprovedContextCandidate = Omit<ContextCandidate, "sourceClassification"> & {
  sourceClassification: SafeSourceClassification;
};

export function validateContextCandidate(
  candidate: ContextCandidate,
): { ok: true } | { ok: false; code: ContextReasonCode } {
  if (
    !isValidScope(candidate.scope) ||
    !isLogicalKey(candidate.logicalKey) ||
    !isContextKind(candidate.kind) ||
    !isPriority(candidate.priority) ||
    /[\r\n]/.test(candidate.value)
  ) {
    return { ok: false, code: "invalid-field" };
  }
  const privacy = validatePrivateFields({
    classification: candidate.sourceClassification,
    fields: {
      logical_key: candidate.logicalKey,
      value: candidate.value,
    },
  });
  return privacy.ok ? { ok: true } : privacy;
}

export function isSafeSourceClassification(
  value: SourceClassification,
): value is SafeSourceClassification {
  return (SAFE_SOURCE_CLASSIFICATIONS as readonly string[]).includes(value);
}

function stableDocumentKey(canonicalPath: string): string {
  return `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`;
}

function isValidScope(scope: ScopeRef): boolean {
  return (scope.type === "global" && scope.id === "global") ||
    (scope.type === "machine" && isOpaqueId(scope.id, "machine")) ||
    (scope.type === "repository" && isOpaqueId(scope.id, "repo"));
}

function isLogicalKey(value: string): boolean {
  return value.length <= 80 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
}

function isContextKind(value: string): value is ContextRecord["kind"] {
  return value === "fact" || value === "preference";
}

function isPriority(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function scopePrecedence(scope: ScopeRef): number {
  return scope.type === "repository" ? 2 : scope.type === "machine" ? 1 : 0;
}

function compareForPrecedence(left: ScopedContextRecord, right: ScopedContextRecord): number {
  return compareText(left.record.logicalKey, right.record.logicalKey) ||
    scopePrecedence(right.scope) - scopePrecedence(left.scope) ||
    right.record.priority - left.record.priority ||
    compareText(right.record.updatedAt, left.record.updatedAt) ||
    compareText(left.record.id, right.record.id);
}

function compareForInjection(left: ScopedContextRecord, right: ScopedContextRecord): number {
  return right.record.priority - left.record.priority ||
    compareText(right.record.updatedAt, left.record.updatedAt) ||
    compareText(left.record.id, right.record.id);
}

function compareForReview(left: ScopedContextRecord, right: ScopedContextRecord): number {
  return compareText(left.record.logicalKey, right.record.logicalKey) ||
    scopePrecedence(right.scope) - scopePrecedence(left.scope) ||
    compareText(left.record.id, right.record.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
