import { createHash } from "node:crypto";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { MarkdownCodecError, encodeMarkdown } from "./markdown-codec.ts";
import { MarkdownStore, StoreError } from "./markdown-store.ts";
import type { StoreWriteResult } from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { validatePrivateFields } from "./privacy.ts";
import type {
  PrivacyReasonCode,
  SafeSourceClassification,
  SourceClassification,
} from "./privacy.ts";
import {
  CLASI_SCHEMA_VERSION,
  NAPKIN_CATEGORIES,
} from "./schema.ts";
import type {
  AnyClasiDocument,
  ClasiDocument,
  NapkinCategory,
  NapkinRecord,
} from "./schema.ts";

export const DEFAULT_NAPKIN_CATEGORY_CAP = 5;
export const MAX_NAPKIN_CATEGORY_CAP = 50;
export const MAX_NAPKIN_SIMILARITY_CANDIDATES = 5;
export const DEFAULT_NAPKIN_HISTORY_LIMIT = 20;
export const MAX_NAPKIN_HISTORY_LIMIT = 50;
export const MAX_DEMOTED_RECORDS_PER_REVISION = 100;

const VALIDATION_ID = "0".repeat(32);
const VALIDATION_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const SAFE_VALIDATION_CODES = new Set<PrivacyReasonCode>([
  "unsafe-source",
  "invalid-field",
  "oversized-field",
  "secret-pattern",
  "pii-pattern",
  "path-bearing",
  "terminal-shaped",
  "raw-environment",
  "code-fenced",
]);
const SIMILARITY_STOP_WORDS = new Set([
  "and",
  "for",
  "from",
  "into",
  "must",
  "prefer",
  "should",
  "that",
  "the",
  "this",
  "use",
  "when",
  "with",
]);

export type NapkinReasonCode =
  | PrivacyReasonCode
  | "invalid-candidate"
  | "invalid-document"
  | "invalid-history"
  | "invalid-limit"
  | "invalid-scope"
  | "invalid-target"
  | "scope-mismatch"
  | "target-key-conflict"
  | "read-failed"
  | "write-conflict"
  | "write-failed";

export interface CurateNapkinInput {
  scope: ScopeRef;
  logicalKey: string;
  category: NapkinCategory;
  priority: number;
  situation: string;
  action: string;
  sourceClassification: SafeSourceClassification;
  targetId?: string;
}

export interface MarkNapkinHitInput {
  scope: ScopeRef;
  id: string;
}

export interface NapkinHistoryRevision {
  revisionId: string;
  parentRevisionId: string | null;
  updatedAt: string;
  activeRecords: NapkinRecord[];
  demotedRecords: NapkinRecord[];
  demotedRecordsTruncated: boolean;
}

export type NapkinListResult =
  | { status: "ok"; categoryCap: number; records: NapkinRecord[] }
  | { status: "rejected"; code: NapkinReasonCode };

export type NapkinHistoryResult =
  | {
      status: "ok";
      categoryCap: number;
      revisions: NapkinHistoryRevision[];
      revisionsTruncated: boolean;
      completeLineage: boolean;
    }
  | { status: "rejected"; code: NapkinReasonCode };

export type NapkinCurateResult =
  | { status: "created"; id: string; active: boolean; revisionId: string }
  | {
      status: "reinforced";
      id: string;
      recurrence: number;
      active: boolean;
      revisionId: string;
    }
  | { status: "candidates"; candidateIds: string[] }
  | { status: "conflict"; code: "write-conflict"; conflictId: string }
  | { status: "rejected"; code: NapkinReasonCode };

export type NapkinHitResult =
  | { status: "recorded"; id: string; hitCount: number; active: boolean; revisionId: string }
  | { status: "conflict"; code: "write-conflict"; conflictId: string }
  | { status: "rejected"; code: NapkinReasonCode };

export interface NapkinServiceOptions {
  store: MarkdownStore;
  paths: ClasiPaths;
  categoryCap?: number;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

type CurateDecision =
  | { status: "created"; id: string; active: boolean }
  | { status: "reinforced"; id: string; recurrence: number; active: boolean }
  | { status: "candidates"; candidateIds: string[] }
  | { status: "rejected"; code: NapkinReasonCode };

type HitDecision =
  | { status: "recorded"; id: string; hitCount: number; active: boolean }
  | { status: "rejected"; code: NapkinReasonCode };

export class NapkinService {
  readonly #store: MarkdownStore;
  readonly #paths: ClasiPaths;
  readonly #categoryCap: number;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: NapkinServiceOptions) {
    if (
      !Number.isInteger(options.categoryCap ?? DEFAULT_NAPKIN_CATEGORY_CAP) ||
      (options.categoryCap ?? DEFAULT_NAPKIN_CATEGORY_CAP) < 1 ||
      (options.categoryCap ?? DEFAULT_NAPKIN_CATEGORY_CAP) > MAX_NAPKIN_CATEGORY_CAP
    ) {
      throw new Error("invalid-napkin-category-cap");
    }
    this.#store = options.store;
    this.#paths = options.paths;
    this.#categoryCap = options.categoryCap ?? DEFAULT_NAPKIN_CATEGORY_CAP;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async list(scope: ScopeRef): Promise<NapkinListResult> {
    const location = this.#location(scope);
    if ("code" in location) return { status: "rejected", code: location.code };
    const current = await this.#read(scope, location.canonicalPath);
    if ("code" in current) {
      return current.code === "canonical-missing"
        ? { status: "ok", categoryCap: this.#categoryCap, records: [] }
        : { status: "rejected", code: current.code };
    }
    return {
      status: "ok",
      categoryCap: this.#categoryCap,
      records: activeRecords(current.document.records, this.#categoryCap),
    };
  }

  async curate(input: CurateNapkinInput): Promise<NapkinCurateResult> {
    const validationCode = validateCurateInput(input);
    if (validationCode) return { status: "rejected", code: validationCode };
    const location = this.#location(input.scope);
    if ("code" in location) return { status: "rejected", code: location.code };

    let decision: CurateDecision = { status: "rejected", code: "invalid-document" };
    const mutation = await this.#store.mutate({
      ...location,
      mutate: current => {
        const recordsResult = recordsForMutation(current?.document ?? null, input.scope);
        if ("code" in recordsResult) {
          decision = { status: "rejected", code: recordsResult.code };
          return null;
        }
        const records = recordsResult.records;
        const exact = records.find(record => record.logicalKey === input.logicalKey);
        let target: NapkinRecord | undefined;
        if (input.targetId) {
          target = records.find(record => record.id === input.targetId);
          if (!target) {
            decision = { status: "rejected", code: "invalid-target" };
            return null;
          }
          if (exact && exact.id !== target.id) {
            decision = { status: "rejected", code: "target-key-conflict" };
            return null;
          }
        } else {
          target = exact;
        }

        if (!target) {
          const candidateIds = similarityCandidates(records, input);
          if (candidateIds.length > 0) {
            decision = { status: "candidates", candidateIds };
            return null;
          }
        }

        const now = this.#now();
        if (!isTimestamp(now)) {
          decision = { status: "rejected", code: "invalid-candidate" };
          return null;
        }
        const id = target?.id ?? this.#createId("napkin");
        const record: NapkinRecord = target
          ? {
              ...target,
              priority: Math.max(target.priority, input.priority),
              recurrence: target.recurrence + 1,
              situation: input.situation,
              action: input.action,
              updatedAt: now,
            }
          : {
              id,
              logicalKey: input.logicalKey,
              category: input.category,
              priority: input.priority,
              recurrence: 1,
              hitCount: 0,
              situation: input.situation,
              action: input.action,
              sourceClassification: input.sourceClassification,
              createdAt: now,
              updatedAt: now,
            };
        const nextRecords = target
          ? records.map(existing => existing.id === target.id ? record : existing)
          : [...records, record];
        const candidate = napkinDocument(
          input.scope,
          this.#createId("rev"),
          current?.document.revisionId ?? null,
          now,
          nextRecords,
        );
        const code = validateCandidateDocument(candidate);
        if (code) {
          decision = { status: "rejected", code };
          return null;
        }
        const active = activeRecords(nextRecords, this.#categoryCap)
          .some(existing => existing.id === id);
        decision = target
          ? { status: "reinforced", id, recurrence: record.recurrence, active }
          : { status: "created", id, active };
        return candidate;
      },
    }).catch(() => null);
    return mutation === null
      ? { status: "rejected", code: "write-failed" }
      : curateMutationResult(mutation, decision);
  }

  async history(
    scope: ScopeRef,
    limit = DEFAULT_NAPKIN_HISTORY_LIMIT,
  ): Promise<NapkinHistoryResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NAPKIN_HISTORY_LIMIT) {
      return { status: "rejected", code: "invalid-limit" };
    }
    const location = this.#location(scope);
    if ("code" in location) return { status: "rejected", code: location.code };
    const current = await this.#read(scope, location.canonicalPath);
    if ("code" in current) {
      return current.code === "canonical-missing"
        ? {
            status: "ok",
            categoryCap: this.#categoryCap,
            revisions: [],
            revisionsTruncated: false,
            completeLineage: true,
          }
        : { status: "rejected", code: current.code };
    }

    let documents: ClasiDocument<"napkin">[];
    try {
      const revisions = await this.#store.readRevisionHistory(location.documentKey);
      if (revisions.some(document => !isScopeNapkin(document, scope))) {
        return { status: "rejected", code: "invalid-history" };
      }
      documents = revisions as ClasiDocument<"napkin">[];
    } catch {
      return { status: "rejected", code: "invalid-history" };
    }
    if (!documents.some(document => document.revisionId === current.document.revisionId)) {
      documents.push(current.document);
    }

    const byId = new Map(documents.map(document => [document.revisionId, document]));
    const lineage: ClasiDocument<"napkin">[] = [];
    const seen = new Set<string>();
    let next: ClasiDocument<"napkin"> | undefined = current.document;
    let completeLineage = true;
    while (next) {
      if (seen.has(next.revisionId)) {
        completeLineage = false;
        break;
      }
      seen.add(next.revisionId);
      lineage.push(next);
      if (next.parentRevisionId === null) break;
      next = byId.get(next.parentRevisionId);
      if (!next) completeLineage = false;
    }

    const selected = lineage.slice(0, limit);
    return {
      status: "ok",
      categoryCap: this.#categoryCap,
      revisions: selected.map(document => historyRevision(document, this.#categoryCap)),
      revisionsTruncated: lineage.length > selected.length,
      completeLineage,
    };
  }

  async markHit(input: MarkNapkinHitInput): Promise<NapkinHitResult> {
    if (!hasExactKeys(input, ["scope", "id"]) || !isOpaqueId(input.id, "napkin")) {
      return { status: "rejected", code: "invalid-target" };
    }
    const location = this.#location(input.scope);
    if ("code" in location) return { status: "rejected", code: location.code };

    let decision: HitDecision = { status: "rejected", code: "invalid-document" };
    const mutation = await this.#store.mutate({
      ...location,
      mutate: current => {
        const recordsResult = recordsForMutation(current?.document ?? null, input.scope);
        if ("code" in recordsResult) {
          decision = { status: "rejected", code: recordsResult.code };
          return null;
        }
        const target = recordsResult.records.find(record => record.id === input.id);
        if (!target) {
          decision = { status: "rejected", code: "invalid-target" };
          return null;
        }
        const now = this.#now();
        if (!isTimestamp(now)) {
          decision = { status: "rejected", code: "invalid-candidate" };
          return null;
        }
        const updated = { ...target, hitCount: target.hitCount + 1, updatedAt: now };
        const records = recordsResult.records.map(record => record.id === target.id ? updated : record);
        const candidate = napkinDocument(
          input.scope,
          this.#createId("rev"),
          current?.document.revisionId ?? null,
          now,
          records,
        );
        const code = validateCandidateDocument(candidate);
        if (code) {
          decision = { status: "rejected", code };
          return null;
        }
        decision = {
          status: "recorded",
          id: target.id,
          hitCount: updated.hitCount,
          active: activeRecords(records, this.#categoryCap).some(record => record.id === target.id),
        };
        return candidate;
      },
    }).catch(() => null);
    return mutation === null
      ? { status: "rejected", code: "write-failed" }
      : hitMutationResult(mutation, decision);
  }

  #location(scope: ScopeRef):
    | { canonicalPath: string; documentKey: string }
    | { code: "invalid-scope" } {
    try {
      const canonicalPath = this.#paths.napkin(scope);
      return { canonicalPath, documentKey: stableDocumentKey(canonicalPath) };
    } catch {
      return { code: "invalid-scope" };
    }
  }

  async #read(
    scope: ScopeRef,
    canonicalPath: string,
  ): Promise<{ document: ClasiDocument<"napkin"> } | { code: NapkinReasonCode | "canonical-missing" }> {
    try {
      const current = await this.#store.read(canonicalPath);
      if (current.document.documentType !== "napkin") return { code: "invalid-document" };
      if (current.document.scopeType !== scope.type || current.document.scopeId !== scope.id) {
        return { code: "scope-mismatch" };
      }
      return { document: current.document };
    } catch (error) {
      if (error instanceof StoreError && error.code === "canonical-missing") {
        return { code: "canonical-missing" };
      }
      return { code: "read-failed" };
    }
  }
}

function validateCurateInput(input: CurateNapkinInput): NapkinReasonCode | null {
  const allowed = [
    "scope",
    "logicalKey",
    "category",
    "priority",
    "situation",
    "action",
    "sourceClassification",
    "targetId",
  ];
  if (!hasOnlyKeys(input, allowed)) return "invalid-candidate";
  if (input.targetId !== undefined && !isOpaqueId(input.targetId, "napkin")) return "invalid-target";
  const privacy = validatePrivateFields({
    classification: input.sourceClassification as SourceClassification,
    fields: {
      logical_key: input.logicalKey,
      category: input.category,
      priority: input.priority,
      situation: input.situation,
      action: input.action,
    },
  });
  if (!privacy.ok) return privacy.code;
  const document = napkinDocument(
    input.scope,
    `rev_${VALIDATION_ID}`,
    null,
    VALIDATION_TIMESTAMP,
    [{
      id: `napkin_${VALIDATION_ID}`,
      logicalKey: input.logicalKey,
      category: input.category,
      priority: input.priority,
      recurrence: 1,
      hitCount: 0,
      situation: input.situation,
      action: input.action,
      sourceClassification: input.sourceClassification,
      createdAt: VALIDATION_TIMESTAMP,
      updatedAt: VALIDATION_TIMESTAMP,
    }],
  );
  return validateCandidateDocument(document);
}

function validateCandidateDocument(document: ClasiDocument<"napkin">): NapkinReasonCode | null {
  try {
    encodeMarkdown(document);
    return null;
  } catch (error) {
    if (error instanceof MarkdownCodecError && SAFE_VALIDATION_CODES.has(error.code as PrivacyReasonCode)) {
      return error.code as PrivacyReasonCode;
    }
    return "invalid-candidate";
  }
}

function recordsForMutation(
  document: AnyClasiDocument | null,
  scope: ScopeRef,
): { records: NapkinRecord[] } | { code: "invalid-document" | "scope-mismatch" } {
  if (document === null) return { records: [] };
  if (document.documentType !== "napkin") return { code: "invalid-document" };
  if (document.scopeType !== scope.type || document.scopeId !== scope.id) {
    return { code: "scope-mismatch" };
  }
  return { records: document.records };
}

function napkinDocument(
  scope: ScopeRef,
  revisionId: string,
  parentRevisionId: string | null,
  updatedAt: string,
  records: NapkinRecord[],
): ClasiDocument<"napkin"> {
  return {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "napkin",
    scopeType: scope.type,
    scopeId: scope.id,
    revisionId,
    parentRevisionId,
    updatedAt,
    records,
  };
}

function activeRecords(records: readonly NapkinRecord[], cap: number): NapkinRecord[] {
  return NAPKIN_CATEGORIES.flatMap(category =>
    records
      .filter(record => record.category === category)
      .sort(compareNapkinRecords)
      .slice(0, cap)
  );
}

function compareNapkinRecords(left: NapkinRecord, right: NapkinRecord): number {
  return right.priority - left.priority ||
    right.recurrence - left.recurrence ||
    right.hitCount - left.hitCount ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id);
}

function similarityCandidates(
  records: readonly NapkinRecord[],
  input: CurateNapkinInput,
): string[] {
  const inputTokens = lessonTokens(input.logicalKey, input.situation, input.action);
  return records
    .filter(record => record.category === input.category)
    .filter(record => tokenSimilarity(inputTokens, lessonTokens(
      record.logicalKey,
      record.situation,
      record.action,
    )) >= 0.75)
    .sort(compareNapkinRecords)
    .slice(0, MAX_NAPKIN_SIMILARITY_CANDIDATES)
    .map(record => record.id);
}

function lessonTokens(...values: string[]): Set<string> {
  const tokens = values.join(" ").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter(token => token.length >= 3 && !SIMILARITY_STOP_WORDS.has(token)));
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  if (overlap < 2) return 0;
  return overlap / (left.size + right.size - overlap);
}

function historyRevision(
  document: ClasiDocument<"napkin">,
  categoryCap: number,
): NapkinHistoryRevision {
  const active = activeRecords(document.records, categoryCap);
  const activeIds = new Set(active.map(record => record.id));
  const demoted = [...document.records]
    .filter(record => !activeIds.has(record.id))
    .sort(compareNapkinRecords);
  return {
    revisionId: document.revisionId,
    parentRevisionId: document.parentRevisionId,
    updatedAt: document.updatedAt,
    activeRecords: active,
    demotedRecords: demoted.slice(0, MAX_DEMOTED_RECORDS_PER_REVISION),
    demotedRecordsTruncated: demoted.length > MAX_DEMOTED_RECORDS_PER_REVISION,
  };
}

function curateMutationResult(
  mutation: Awaited<ReturnType<MarkdownStore["mutate"]>>,
  decision: CurateDecision,
): NapkinCurateResult {
  if (mutation.status === "conflict") return writeConflict(mutation);
  if (decision.status === "created" || decision.status === "reinforced") {
    if (mutation.status !== "committed") return { status: "rejected", code: "invalid-document" };
    return { ...decision, revisionId: mutation.revisionId };
  }
  return decision;
}

function hitMutationResult(
  mutation: Awaited<ReturnType<MarkdownStore["mutate"]>>,
  decision: HitDecision,
): NapkinHitResult {
  if (mutation.status === "conflict") return writeConflict(mutation);
  if (decision.status === "recorded") {
    if (mutation.status !== "committed") return { status: "rejected", code: "invalid-document" };
    return { ...decision, revisionId: mutation.revisionId };
  }
  return decision;
}

function writeConflict(
  mutation: Extract<StoreWriteResult, { status: "conflict" }>,
): { status: "conflict"; code: "write-conflict"; conflictId: string } {
  return { status: "conflict", code: "write-conflict", conflictId: mutation.conflictId };
}

function stableDocumentKey(path: string): string {
  return `doc_${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

function isScopeNapkin(
  document: AnyClasiDocument,
  scope: ScopeRef,
): document is ClasiDocument<"napkin"> {
  return document.documentType === "napkin" &&
    document.scopeType === scope.type &&
    document.scopeId === scope.id;
}

function isTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}
