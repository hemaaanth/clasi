import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import type { MarkdownStore, StoreReadResult } from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { validatePrivateFields } from "./privacy.ts";
import type { PrivacyReasonCode, SafeSourceClassification } from "./privacy.ts";
import { CLASI_SCHEMA_VERSION, NAPKIN_CATEGORIES } from "./schema.ts";
import type {
  ClasiDocument,
  NapkinCategory,
  PapercutRecord,
  PublicationState,
  RepairState,
} from "./schema.ts";

const MAX_INBOX_RECORDS = 100;
const MAX_MATCH_CANDIDATES = 5;
const DIRECTORY_SENTINEL_ID = "cut_00000000000000000000000000000000";
const FINGERPRINT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export type PapercutReasonCode =
  | PrivacyReasonCode
  | "invalid-scope"
  | "invalid-field"
  | "invalid-target"
  | "invalid-document"
  | "not-found"
  | "archived"
  | "illegal-transition"
  | "confirmation-required"
  | "repair-not-verified"
  | "publication-unsettled"
  | "write-conflict"
  | "storage-unavailable";

export interface CapturePapercutInput {
  scope: ScopeRef;
  fingerprint: string;
  summary: string;
  severity: PapercutRecord["severity"];
  prevention: string;
  acceptanceCondition: string;
  sourceClassification: SafeSourceClassification;
  explicitMatchId?: string;
}

export type CapturePapercutResult =
  | { status: "created"; record: PapercutRecord }
  | { status: "reinforced"; record: PapercutRecord }
  | { status: "candidates"; candidateIds: string[] }
  | PapercutRejected;

export type PapercutListResult =
  | { status: "ok"; records: PapercutRecord[] }
  | PapercutRejected;

export type PapercutGetResult =
  | { status: "ok"; location: "open" | "archive"; record: PapercutRecord }
  | PapercutRejected;

export type PapercutTransitionResult =
  | { status: "updated"; record: PapercutRecord }
  | PapercutRejected;

export interface DurableNapkinProposalInput {
  durable: true;
  logicalKey: string;
  category: NapkinCategory;
  priority: number;
  situation: string;
  action: string;
  sourceClassification: SafeSourceClassification;
  targetId?: string;
}

export interface NapkinProposalSuggestion extends DurableNapkinProposalInput {
  targetType: "napkin";
}

export type PapercutArchiveResult =
  | {
      status: "archived";
      record: PapercutRecord;
      napkinProposalSuggestion?: NapkinProposalSuggestion;
    }
  | PapercutRejected;

export interface PapercutRejected {
  status: "rejected";
  code: PapercutReasonCode;
}

export interface PapercutServiceOptions {
  store: MarkdownStore;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

type PublicationReport = "failed" | "indeterminate" | "published";
type PublicationTransition = {
  publicationState: PublicationState;
  publicationIssueNumber: number | null;
};
type RepairReport = "dispatched" | "running" | "awaiting_verification" | "failed" | "indeterminate";
type RepairReconciliation = "queued" | "dispatched" | "running" | "awaiting_verification" | "failed";
type ChangeDecision =
  | { ok: true; record: PapercutRecord }
  | { ok: false; code: PapercutReasonCode };
type ScanResult = { ok: true; records: PapercutRecord[] } | { ok: false; code: PapercutReasonCode };

export class PapercutService {
  readonly #store: MarkdownStore;
  readonly #paths: ClasiPaths;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: PapercutServiceOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async capture(input: CapturePapercutInput): Promise<CapturePapercutResult> {
    const rejected = validateCapture(input);
    if (rejected) return rejected;
    try {
      return await this.#store.withDocumentLock(
        captureLockKey(input.scope, input.fingerprint),
        () => this.#captureLocked(input),
      );
    } catch {
      return reject("storage-unavailable");
    }
  }

  async #captureLocked(input: CapturePapercutInput): Promise<CapturePapercutResult> {
    const open = await this.#scan(input.scope, "open");
    if (!open.ok) return reject(open.code);
    const openRecords = open.records.filter(record => record.lifecycle === "open");

    if (input.explicitMatchId) return this.#reinforce(input.scope, input.explicitMatchId);

    const exact = newestFirst(openRecords.filter(record => record.fingerprint === input.fingerprint))[0];
    if (exact) return this.#reinforce(input.scope, exact.id);

    const candidates = possibleMatches(input.fingerprint, openRecords);
    if (candidates.length > 0) return { status: "candidates", candidateIds: candidates };

    const archived = await this.#archived(input.scope);
    if (!archived.ok) return reject(archived.code);
    const previous = newestFirst(
      archived.records.filter(record => record.fingerprint === input.fingerprint),
    )[0];
    return this.#create(input, previous?.id);
  }

  async inbox(scope: ScopeRef, options: { limit?: number } = {}): Promise<PapercutListResult> {
    const limit = boundedLimit(options.limit);
    if (!validScope(scope) || limit === null) {
      return reject(validScope(scope) ? "invalid-field" : "invalid-scope");
    }
    const scanned = await this.#scan(scope, "open");
    if (!scanned.ok) return reject(scanned.code);
    return {
      status: "ok",
      records: newestFirst(scanned.records.filter(record => record.lifecycle === "open")).slice(0, limit),
    };
  }

  async get(scope: ScopeRef, id: string): Promise<PapercutGetResult> {
    if (!validScope(scope)) return reject("invalid-scope");
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    for (const location of ["open", "archive"] as const) {
      try {
        const current = await this.#store.read(this.#paths.papercut(scope, location, id));
        const record = recordFrom(current, scope, id);
        if (record === null || (location === "archive" && record.lifecycle === "open")) {
          return reject("invalid-document");
        }
        return { status: "ok", location, record };
      } catch (error) {
        if (hasCode(error, "canonical-missing")) continue;
        return reject("storage-unavailable");
      }
    }
    return reject("not-found");
  }

  async archive(scope: ScopeRef, options: { limit?: number } = {}): Promise<PapercutListResult> {
    const limit = boundedLimit(options.limit);
    if (!validScope(scope) || limit === null) {
      return reject(validScope(scope) ? "invalid-field" : "invalid-scope");
    }
    const archived = await this.#archived(scope);
    if (!archived.ok) return reject(archived.code);
    return { status: "ok", records: newestFirst(archived.records).slice(0, limit) };
  }

  async dismiss(scope: ScopeRef, id: string): Promise<PapercutArchiveResult> {
    if (!validScope(scope)) return reject("invalid-scope");
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    const changed = await this.#change(scope, id, record => {
      if (!canDismiss(record)) return { ok: false, code: "illegal-transition" };
      return {
        ok: true,
        record: { ...record, lifecycle: "dismissed", updatedAt: this.#now() },
      };
    });
    if (changed.status === "rejected") return changed;
    return this.#moveToArchive(scope, changed.record);
  }

  async beginPublication(scope: ScopeRef, id: string): Promise<PapercutTransitionResult> {
    return this.#setPublication(scope, id, record =>
      record.publicationState === "none" || record.publicationState === "failed"
        ? { publicationState: "pending", publicationIssueNumber: null }
        : null);
  }

  async reportPublication(
    scope: ScopeRef,
    id: string,
    outcome: PublicationReport,
    issueNumber: number | null,
  ): Promise<PapercutTransitionResult> {
    if (!validPublicationReference(outcome, issueNumber)) return reject("invalid-field");
    return this.#setPublication(scope, id, record =>
      record.publicationState === "pending"
        ? { publicationState: outcome, publicationIssueNumber: issueNumber }
        : null);
  }

  async reconcilePublication(
    scope: ScopeRef,
    id: string,
    outcome: Exclude<PublicationReport, "indeterminate">,
    issueNumber: number | null,
  ): Promise<PapercutTransitionResult> {
    if (
      (outcome !== "failed" && outcome !== "published") ||
      !validPublicationReference(outcome, issueNumber)
    ) return reject("invalid-field");
    return this.#setPublication(scope, id, record =>
      record.publicationState === "indeterminate"
        ? { publicationState: outcome, publicationIssueNumber: issueNumber }
        : null);
  }

  async resubmitPublication(
    scope: ScopeRef,
    id: string,
    confirmed: boolean,
  ): Promise<PapercutTransitionResult> {
    if (!confirmed) return reject("confirmation-required");
    return this.#setPublication(scope, id, record =>
      record.publicationState === "indeterminate"
        ? { publicationState: "pending", publicationIssueNumber: null }
        : null);
  }

  async queueRepair(scope: ScopeRef, id: string): Promise<PapercutTransitionResult> {
    return this.#setRepair(scope, id, record =>
      record.repairState === "none" || record.repairState === "failed" ? "queued" : null);
  }

  async cancelQueuedRepair(scope: ScopeRef, id: string): Promise<PapercutTransitionResult> {
    return this.#setRepair(scope, id, record => record.repairState === "queued" ? "none" : null);
  }

  async reportRepair(
    scope: ScopeRef,
    id: string,
    outcome: RepairReport,
  ): Promise<PapercutTransitionResult> {
    const transitions: Partial<Record<RepairState, readonly RepairReport[]>> = {
      queued: ["dispatched", "failed", "indeterminate"],
      dispatched: ["running", "failed", "indeterminate"],
      running: ["awaiting_verification", "failed", "indeterminate"],
      awaiting_verification: ["indeterminate"],
    };
    if (!(["dispatched", "running", "awaiting_verification", "failed", "indeterminate"] as const).includes(outcome)) {
      return reject("invalid-field");
    }
    return this.#setRepair(scope, id, record =>
      transitions[record.repairState]?.includes(outcome) ? outcome : null);
  }

  async verifyRepair(
    scope: ScopeRef,
    id: string,
    accepted: boolean,
  ): Promise<PapercutTransitionResult> {
    if (typeof accepted !== "boolean") return reject("invalid-field");
    return this.#setRepair(scope, id, record =>
      record.repairState === "awaiting_verification" ? (accepted ? "verified" : "failed") : null);
  }

  async reconcileRepair(
    scope: ScopeRef,
    id: string,
    outcome: RepairReconciliation,
  ): Promise<PapercutTransitionResult> {
    if (!(["queued", "dispatched", "running", "awaiting_verification", "failed"] as const).includes(outcome)) {
      return reject("invalid-field");
    }
    return this.#setRepair(scope, id, record =>
      record.repairState === "indeterminate" ? outcome : null);
  }

  async resubmitRepair(
    scope: ScopeRef,
    id: string,
    confirmed: boolean,
  ): Promise<PapercutTransitionResult> {
    if (!confirmed) return reject("confirmation-required");
    return this.#setRepair(scope, id, record =>
      record.repairState === "indeterminate" ? "queued" : null);
  }

  async resolve(
    scope: ScopeRef,
    id: string,
    options: { durableNapkinProposal?: DurableNapkinProposalInput } = {},
  ): Promise<PapercutArchiveResult> {
    if (!validScope(scope)) return reject("invalid-scope");
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    const suggestion = options.durableNapkinProposal;
    if (suggestion) {
      const validation = validateDurableSuggestion(suggestion);
      if (validation) return validation;
    }

    const changed = await this.#change(scope, id, record => {
      if (record.repairState !== "verified") return { ok: false, code: "repair-not-verified" };
      if (record.publicationState === "pending" || record.publicationState === "indeterminate") {
        return { ok: false, code: "publication-unsettled" };
      }
      return {
        ok: true,
        record: { ...record, lifecycle: "resolved", updatedAt: this.#now() },
      };
    });
    if (changed.status === "rejected") return changed;
    const archived = await this.#moveToArchive(scope, changed.record);
    if (archived.status === "rejected" || !suggestion) return archived;
    return {
      ...archived,
      napkinProposalSuggestion: {
        targetType: "napkin",
        ...suggestion,
      },
    };
  }

  async #create(
    input: CapturePapercutInput,
    archivedId: string | undefined,
  ): Promise<CapturePapercutResult> {
    const id = this.#mint("cut");
    const now = this.#now();
    const record: PapercutRecord = {
      id,
      fingerprint: input.fingerprint,
      summary: input.summary,
      severity: input.severity,
      prevention: input.prevention,
      acceptanceCondition: input.acceptanceCondition,
      sourceClassification: input.sourceClassification,
      lifecycle: "open",
      repairState: "none",
      publicationState: "none",
      publicationIssueNumber: null,
      recurrence: 1,
      relatedIds: archivedId ? [archivedId] : [],
      createdAt: now,
      updatedAt: now,
    };
    let rejection: PapercutReasonCode | undefined;
    try {
      const result = await this.#store.mutate({
        canonicalPath: this.#paths.papercut(input.scope, "open", id),
        documentKey: documentKey(id),
        mutate: current => {
          if (current !== null) {
            rejection = "invalid-target";
            return null;
          }
          return this.#document(input.scope, null, now, record);
        },
      });
      if (result.status === "conflict") return reject("write-conflict");
      if (rejection) return reject(rejection);
      if (result.status !== "committed") return reject("storage-unavailable");
      return { status: "created", record };
    } catch {
      return reject("storage-unavailable");
    }
  }

  async #reinforce(scope: ScopeRef, id: string): Promise<CapturePapercutResult> {
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    const changed = await this.#change(scope, id, record => ({
      ok: true,
      record: { ...record, recurrence: record.recurrence + 1, updatedAt: this.#now() },
    }));
    return changed.status === "rejected"
      ? changed
      : { status: "reinforced", record: changed.record };
  }

  async #setPublication(
    scope: ScopeRef,
    id: string,
    transition: (record: PapercutRecord) => PublicationTransition | null,
  ): Promise<PapercutTransitionResult> {
    if (!validScope(scope)) return reject("invalid-scope");
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    return this.#change(scope, id, record => {
      const publication = transition(record);
      return publication === null
        ? { ok: false, code: "illegal-transition" }
        : {
            ok: true,
            record: { ...record, ...publication, updatedAt: this.#now() },
          };
    });
  }

  async #setRepair(
    scope: ScopeRef,
    id: string,
    transition: (record: PapercutRecord) => RepairState | null,
  ): Promise<PapercutTransitionResult> {
    if (!validScope(scope)) return reject("invalid-scope");
    if (!isOpaqueId(id, "cut")) return reject("invalid-target");
    return this.#change(scope, id, record => {
      const repairState = transition(record);
      return repairState === null
        ? { ok: false, code: "illegal-transition" }
        : {
            ok: true,
            record: { ...record, repairState, updatedAt: this.#now() },
          };
    });
  }

  async #change(
    scope: ScopeRef,
    id: string,
    change: (record: PapercutRecord) => ChangeDecision,
  ): Promise<PapercutTransitionResult> {
    const path = this.#paths.papercut(scope, "open", id);
    let updated: PapercutRecord | undefined;
    let rejection: PapercutReasonCode | undefined;
    try {
      const result = await this.#store.mutate({
        canonicalPath: path,
        documentKey: documentKey(id),
        mutate: current => {
          if (current === null) {
            rejection = "not-found";
            return null;
          }
          const record = recordFrom(current, scope, id);
          if (!record) {
            rejection = "invalid-document";
            return null;
          }
          if (record.lifecycle !== "open") {
            rejection = "archived";
            return null;
          }
          const decision = change(record);
          if (!decision.ok) {
            rejection = decision.code;
            return null;
          }
          updated = decision.record;
          return this.#document(
            scope,
            current.document.revisionId,
            decision.record.updatedAt,
            decision.record,
          );
        },
      });
      if (result.status === "conflict") return reject("write-conflict");
      if (rejection) return reject(rejection);
      if (!updated || result.status !== "committed") return reject("storage-unavailable");
      return { status: "updated", record: updated };
    } catch {
      return reject("storage-unavailable");
    }
  }

  #document(
    scope: ScopeRef,
    parentRevisionId: string | null,
    updatedAt: string,
    record: PapercutRecord,
  ): ClasiDocument<"papercut"> {
    return {
      schemaVersion: CLASI_SCHEMA_VERSION,
      documentType: "papercut",
      scopeType: scope.type,
      scopeId: scope.id,
      revisionId: this.#mint("rev"),
      parentRevisionId,
      updatedAt,
      records: [record],
    };
  }

  async #moveToArchive(scope: ScopeRef, record: PapercutRecord): Promise<PapercutArchiveResult> {
    const key = documentKey(record.id);
    try {
      const moved = await this.#store.moveCanonical({
        sourceCanonicalPath: this.#paths.papercut(scope, "open", record.id),
        targetCanonicalPath: this.#paths.papercut(scope, "archive", record.id),
        sourceDocumentKey: key,
        targetDocumentKey: key,
      });
      if (moved.status === "conflict") return reject("write-conflict");
      if (moved.status === "missing") return reject("storage-unavailable");
      return { status: "archived", record };
    } catch {
      return reject("storage-unavailable");
    }
  }

  async #archived(scope: ScopeRef): Promise<ScanResult> {
    const [archive, open] = await Promise.all([
      this.#scan(scope, "archive"),
      this.#scan(scope, "open"),
    ]);
    if (!archive.ok) return archive;
    if (!open.ok) return open;
    const records = new Map<string, PapercutRecord>();
    for (const record of [...archive.records, ...open.records]) {
      if (record.lifecycle !== "open" && !records.has(record.id)) records.set(record.id, record);
    }
    return { ok: true, records: [...records.values()] };
  }

  async #scan(scope: ScopeRef, location: "open" | "archive"): Promise<ScanResult> {
    if (!validScope(scope)) return { ok: false, code: "invalid-scope" };
    const directory = dirname(this.#paths.papercut(scope, location, DIRECTORY_SENTINEL_ID));
    let names: string[];
    try {
      names = await this.#store.listDocumentIds(directory, "cut");
    } catch {
      return { ok: false, code: "storage-unavailable" };
    }

    const records: PapercutRecord[] = [];
    for (const id of names) {
      try {
        const current = await this.#store.read(this.#paths.papercut(scope, location, id));
        const record = recordFrom(current, scope, id);
        if (!record) return { ok: false, code: "invalid-document" };
        records.push(record);
      } catch (error) {
        if (hasCode(error, "canonical-missing")) continue;
        return { ok: false, code: "storage-unavailable" };
      }
    }
    return { ok: true, records };
  }

  #mint(prefix: IdPrefix): string {
    const id = this.#createId(prefix);
    if (!isOpaqueId(id, prefix)) throw new Error(`invalid-id:${prefix}`);
    return id;
  }
}

function validateCapture(input: CapturePapercutInput): PapercutRejected | null {
  if (!hasOnlyKeys(input, [
    "scope",
    "fingerprint",
    "summary",
    "severity",
    "prevention",
    "acceptanceCondition",
    "sourceClassification",
    "explicitMatchId",
  ])) return reject("invalid-field");
  if (!validScope(input.scope)) return reject("invalid-scope");
  if (
    typeof input.fingerprint !== "string" ||
    input.fingerprint.length > 80 ||
    !FINGERPRINT_PATTERN.test(input.fingerprint) ||
    !(["minor", "major", "blocker"] as const).includes(input.severity)
  ) {
    return reject("invalid-field");
  }
  if (input.explicitMatchId !== undefined && !isOpaqueId(input.explicitMatchId, "cut")) {
    return reject("invalid-target");
  }
  const privacy = validatePrivateFields({
    classification: input.sourceClassification,
    fields: {
      fingerprint: input.fingerprint,
      summary: input.summary,
      prevention: input.prevention,
      acceptance_condition: input.acceptanceCondition,
    },
  });
  return privacy.ok ? null : reject(privacy.code);
}

function validateDurableSuggestion(input: DurableNapkinProposalInput): PapercutRejected | null {
  if (!hasOnlyKeys(input, [
    "durable",
    "logicalKey",
    "category",
    "priority",
    "situation",
    "action",
    "sourceClassification",
    "targetId",
  ])) {
    return reject("invalid-field");
  }
  if (
    input.durable !== true
    || typeof input.logicalKey !== "string"
    || input.logicalKey.length > 80
    || !FINGERPRINT_PATTERN.test(input.logicalKey)
    || !(NAPKIN_CATEGORIES as readonly string[]).includes(input.category)
    || !Number.isInteger(input.priority)
    || input.priority < 0
    || input.priority > 100
    || (input.targetId !== undefined && !isOpaqueId(input.targetId, "napkin"))
  ) {
    return reject("invalid-field");
  }
  const privacy = validatePrivateFields({
    classification: input.sourceClassification,
    fields: {
      logical_key: input.logicalKey,
      situation: input.situation,
      action: input.action,
    },
  });
  return privacy.ok ? null : reject(privacy.code);
}

function validScope(scope: ScopeRef): boolean {
  if (!scope || typeof scope !== "object") return false;
  if (scope.type === "global") return scope.id === "global";
  if (scope.type === "machine") return isOpaqueId(scope.id, "machine");
  return scope.type === "repository" && isOpaqueId(scope.id, "repo");
}

function boundedLimit(limit: number | undefined): number | null {
  if (limit === undefined) return MAX_INBOX_RECORDS;
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_INBOX_RECORDS ? limit : null;
}

function recordFrom(current: StoreReadResult, scope: ScopeRef, id: string): PapercutRecord | null {
  const { document } = current;
  if (
    document.documentType !== "papercut" ||
    document.scopeType !== scope.type ||
    document.scopeId !== scope.id ||
    document.records.length !== 1
  ) {
    return null;
  }
  const record = document.records[0];
  return record?.id === id ? record : null;
}

function newestFirst(records: readonly PapercutRecord[]): PapercutRecord[] {
  return [...records].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

function possibleMatches(fingerprint: string, records: readonly PapercutRecord[]): string[] {
  const target = tokens(fingerprint);
  return records
    .map(record => ({
      id: record.id,
      score: similarity(target, tokens(record.fingerprint)),
      updatedAt: record.updatedAt,
    }))
    .filter(candidate => candidate.score >= 0.6)
    .sort((left, right) =>
      right.score - left.score ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id))
    .slice(0, MAX_MATCH_CANDIDATES)
    .map(candidate => candidate.id);
}

function tokens(value: string): Set<string> {
  return new Set(value.split(/[._-]/).filter(token => token.length > 1));
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size < 2 || right.size < 2) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (shared < 2) return 0;
  return shared / (left.size + right.size - shared);
}

function validPublicationReference(
  outcome: PublicationReport,
  issueNumber: number | null,
): boolean {
  return outcome === "published"
    ? typeof issueNumber === "number" &&
        Number.isSafeInteger(issueNumber) &&
        issueNumber > 0
    : issueNumber === null;
}

function canDismiss(record: PapercutRecord): boolean {
  const blockedRepair: readonly RepairState[] = [
    "queued",
    "dispatched",
    "running",
    "awaiting_verification",
    "indeterminate",
  ];
  return !blockedRepair.includes(record.repairState) &&
    record.publicationState !== "pending" &&
    record.publicationState !== "indeterminate";
}

function documentKey(id: string): string {
  return `doc_${createHash("sha256").update(`papercut:${id}`).digest("hex").slice(0, 32)}`;
}

function captureLockKey(scope: ScopeRef, fingerprint: string): string {
  const value = `papercut-capture:${scope.type}:${scope.id}:${fingerprint}`;
  return `doc_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function reject(code: PapercutReasonCode): PapercutRejected {
  return { status: "rejected", code };
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code;
}
