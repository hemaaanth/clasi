import { createHash } from "node:crypto";
import {
  ContextService,
  isSafeSourceClassification,
  validateContextCandidate,
} from "./context-service.ts";
import type {
  ContextCandidate,
  ContextReasonCode,
  ContextServiceOptions,
} from "./context-service.ts";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { MarkdownStore } from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { CLASI_SCHEMA_VERSION } from "./schema.ts";
import type { ClasiDocument, ProposalRecord } from "./schema.ts";

export type ProposalReasonCode =
  | ContextReasonCode
  | "duplicate-scope"
  | "invalid-filter"
  | "invalid-limit"
  | "invalid-transition"
  | "proposal-id-collision"
  | "proposal-not-found";

export type ContextSubmissionOutcome =
  | {
      status: "activated";
      recordId: string;
      revisionId: string;
      changed: boolean;
    }
  | { status: "proposed"; proposalId: string; revisionId: string }
  | { status: "rejected"; code: ProposalReasonCode };

export type ProposalApprovalOutcome =
  | {
      status: "approved";
      proposalId: string;
      contextRecordId: string;
      contextRevisionId: string;
    }
  | { status: "activation-pending"; proposalId: string; code: ContextReasonCode }
  | { status: "rejected"; code: ProposalReasonCode };

export type ProposalDismissalOutcome =
  | { status: "dismissed"; proposalId: string; revisionId: string; changed: boolean }
  | { status: "rejected"; code: ProposalReasonCode };

export const DEFAULT_PROPOSAL_LIST_LIMIT = 50;
export const MAX_PROPOSAL_LIST_LIMIT = 100;

export type ProposalListStatus = ProposalRecord["status"] | "all";

export interface ProposalListOptions {
  status?: ProposalListStatus;
  limit?: number;
}

export interface ScopedProposalRecord {
  scope: ScopeRef;
  record: ProposalRecord;
}

export type ProposalListOutcome =
  | {
      status: "ok";
      records: readonly ScopedProposalRecord[];
      truncated: boolean;
    }
  | { status: "rejected"; code: ProposalReasonCode };

export interface ProposalServiceOptions extends ContextServiceOptions {
  store: MarkdownStore;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

export class ProposalService {
  readonly #store: MarkdownStore;
  readonly #paths: ClasiPaths;
  readonly #context: ContextService;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: ProposalServiceOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#context = new ContextService(options);
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async list(
    scopes: readonly ScopeRef[],
    options: ProposalListOptions = {},
  ): Promise<ProposalListOutcome> {
    if (scopes.length > 3 || scopes.some(scope => !isValidScope(scope))) {
      return { status: "rejected", code: "invalid-field" };
    }
    if (new Set(scopes.map(scope => scope.type)).size !== scopes.length) {
      return { status: "rejected", code: "duplicate-scope" };
    }
    const status = options.status ?? "open";
    if (!isProposalListStatus(status)) return { status: "rejected", code: "invalid-filter" };
    const limit = options.limit ?? DEFAULT_PROPOSAL_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROPOSAL_LIST_LIMIT) {
      return { status: "rejected", code: "invalid-limit" };
    }

    const records: ScopedProposalRecord[] = [];
    try {
      for (const scope of scopes) {
        const ids = await this.#store.listDocumentIds(
          this.#paths.proposalDirectory(scope),
          "proposal",
        );
        for (const id of ids) {
          const read = await this.#store.read(this.#paths.proposal(scope, id));
          const document = read.document;
          if (
            document.documentType !== "proposal" ||
            document.scopeType !== scope.type ||
            document.scopeId !== scope.id
          ) {
            return { status: "rejected", code: "document-mismatch" };
          }
          const record = document.records[0];
          if (document.records.length !== 1 || !record || record.id !== id) {
            return { status: "rejected", code: "document-mismatch" };
          }
          records.push({ scope, record });
        }
      }
    } catch {
      return { status: "rejected", code: "read-failed" };
    }

    const selected = records
      .filter(entry => status === "all" || entry.record.status === status)
      .sort(compareProposals);
    return {
      status: "ok",
      records: selected.slice(0, limit),
      truncated: selected.length > limit,
    };
  }

  async submitContext(candidate: ContextCandidate): Promise<ContextSubmissionOutcome> {
    const validation = validateContextCandidate(candidate);
    if (!validation.ok) return { status: "rejected", code: validation.code };

    if (candidate.sourceClassification === "safe-machine-fact") {
      if (candidate.scope.type !== "machine" || candidate.kind !== "fact") {
        return { status: "rejected", code: "invalid-machine-fact" };
      }
      return this.#context.activateSafeMachineFact(candidate);
    }
    if (!isSafeSourceClassification(candidate.sourceClassification)) {
      return { status: "rejected", code: "unsafe-source" };
    }
    const sourceClassification = candidate.sourceClassification;

    const proposalId = this.#createId("proposal");
    const canonicalPath = this.#paths.proposal(candidate.scope, proposalId);
    let callbackCode: ProposalReasonCode | undefined;
    let revisionId = "";
    try {
      const result = await this.#store.mutate({
        canonicalPath,
        documentKey: stableDocumentKey(canonicalPath),
        mutate: current => {
          if (current !== null) {
            callbackCode = "proposal-id-collision";
            return null;
          }
          const now = this.#now();
          revisionId = this.#createId("rev");
          const record: ProposalRecord = {
            id: proposalId,
            targetType: "context",
            logicalKey: candidate.logicalKey,
            summary: candidate.value,
            sourceClassification,
            status: "open",
            createdAt: now,
            updatedAt: now,
          };
          const document: ClasiDocument<"proposal"> = {
            schemaVersion: CLASI_SCHEMA_VERSION,
            documentType: "proposal",
            scopeType: candidate.scope.type,
            scopeId: candidate.scope.id,
            revisionId,
            parentRevisionId: null,
            updatedAt: now,
            records: [record],
          };
          return document;
        },
      });
      if (result.status === "conflict") return { status: "rejected", code: "write-conflict" };
      if (callbackCode) return { status: "rejected", code: callbackCode };
      if (result.status !== "committed") return { status: "rejected", code: "write-failed" };
      return { status: "proposed", proposalId, revisionId };
    } catch {
      return { status: "rejected", code: "write-failed" };
    }
  }

  async approveContext(input: {
    scope: ScopeRef;
    proposalId: string;
    kind: "fact" | "preference";
    priority: number;
  }): Promise<ProposalApprovalOutcome> {
    if (
      !isValidScope(input.scope) ||
      !isOpaqueId(input.proposalId, "proposal") ||
      (input.kind !== "fact" && input.kind !== "preference") ||
      !Number.isInteger(input.priority) ||
      input.priority < 0 ||
      input.priority > 100
    ) {
      return { status: "rejected", code: "invalid-field" };
    }
    const transitioned = await this.#transition(input.scope, input.proposalId, "approved");
    if (transitioned.status === "rejected") return transitioned;

    const activation = await this.#context.activateApprovedProposal(input);
    if (activation.status === "rejected") {
      return { status: "activation-pending", proposalId: input.proposalId, code: activation.code };
    }
    return {
      status: "approved",
      proposalId: input.proposalId,
      contextRecordId: activation.recordId,
      contextRevisionId: activation.revisionId,
    };
  }

  async dismiss(scope: ScopeRef, proposalId: string): Promise<ProposalDismissalOutcome> {
    if (!isValidScope(scope) || !isOpaqueId(proposalId, "proposal")) {
      return { status: "rejected", code: "invalid-field" };
    }
    const transitioned = await this.#transition(scope, proposalId, "dismissed");
    if (transitioned.status === "rejected") return transitioned;
    return {
      status: "dismissed",
      proposalId,
      revisionId: transitioned.revisionId,
      changed: transitioned.changed,
    };
  }

  async #transition(
    scope: ScopeRef,
    proposalId: string,
    target: "approved" | "dismissed",
  ): Promise<
    | { status: "transitioned"; revisionId: string; changed: boolean }
    | { status: "rejected"; code: ProposalReasonCode }
  > {
    const canonicalPath = this.#paths.proposal(scope, proposalId);
    let callbackOutcome:
      | { status: "transitioned"; revisionId: string; changed: boolean }
      | { status: "rejected"; code: ProposalReasonCode }
      | undefined;

    try {
      const result = await this.#store.mutate({
        canonicalPath,
        documentKey: stableDocumentKey(canonicalPath),
        mutate: current => {
          if (current === null) {
            callbackOutcome = { status: "rejected", code: "proposal-not-found" };
            return null;
          }
          const document = current.document;
          if (
            document.documentType !== "proposal" ||
            document.scopeType !== scope.type ||
            document.scopeId !== scope.id
          ) {
            callbackOutcome = { status: "rejected", code: "document-mismatch" };
            return null;
          }
          const existing = document.records[0];
          if (
            document.records.length !== 1 ||
            !existing ||
            existing.id !== proposalId ||
            existing.targetType !== "context"
          ) {
            callbackOutcome = { status: "rejected", code: "document-mismatch" };
            return null;
          }
          if (existing.status === target) {
            callbackOutcome = {
              status: "transitioned",
              revisionId: current.document.revisionId,
              changed: false,
            };
            return null;
          }
          if (existing.status !== "open") {
            callbackOutcome = { status: "rejected", code: "invalid-transition" };
            return null;
          }

          const now = this.#now();
          const revisionId = this.#createId("rev");
          const candidate: ClasiDocument<"proposal"> = {
            ...document,
            revisionId,
            parentRevisionId: document.revisionId,
            updatedAt: now,
            records: [{ ...existing, status: target, updatedAt: now }],
          };
          callbackOutcome = { status: "transitioned", revisionId, changed: true };
          return candidate;
        },
      });
      if (result.status === "conflict") return { status: "rejected", code: "write-conflict" };
      return callbackOutcome ?? { status: "rejected", code: "write-failed" };
    } catch {
      return { status: "rejected", code: "write-failed" };
    }
  }
}

function stableDocumentKey(canonicalPath: string): string {
  return `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`;
}

function isValidScope(scope: ScopeRef): boolean {
  return (scope.type === "global" && scope.id === "global") ||
    (scope.type === "machine" && isOpaqueId(scope.id, "machine")) ||
    (scope.type === "repository" && isOpaqueId(scope.id, "repo"));
}

const PROPOSAL_STATUS_ORDER: Record<ProposalRecord["status"], number> = {
  open: 0,
  approved: 1,
  dismissed: 2,
};

function isProposalListStatus(value: string): value is ProposalListStatus {
  return value === "all" || Object.hasOwn(PROPOSAL_STATUS_ORDER, value);
}

function compareProposals(left: ScopedProposalRecord, right: ScopedProposalRecord): number {
  return PROPOSAL_STATUS_ORDER[left.record.status] - PROPOSAL_STATUS_ORDER[right.record.status] ||
    compareText(right.record.updatedAt, left.record.updatedAt) ||
    scopePrecedence(right.scope) - scopePrecedence(left.scope) ||
    compareText(left.record.id, right.record.id);
}

function scopePrecedence(scope: ScopeRef): number {
  return scope.type === "repository" ? 2 : scope.type === "machine" ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
