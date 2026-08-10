import { isOpaqueId } from "./ids.ts";
import { SAFE_SOURCE_CLASSIFICATIONS } from "./privacy.ts";
import type { SafeSourceClassification } from "./privacy.ts";

export const CLASI_SCHEMA_VERSION = 1 as const;
export const MAX_DOCUMENT_BYTES = 262_144;
export const MAX_BODY_TEXT_CHARACTERS = 240;

export const DOCUMENT_TYPES = [
  "context",
  "napkin",
  "papercut",
  "proposal",
  "conflict",
  "migration",
  "transaction",
  "metrics",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type ScopeType = "global" | "machine" | "repository";

export interface ContextRecord {
  id: string;
  logicalKey: string;
  kind: "fact" | "preference";
  value: string;
  sourceClassification: SafeSourceClassification;
  approved: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export const NAPKIN_CATEGORIES = [
  "Execution",
  "Validation",
  "Tooling",
  "Repository Conventions",
  "Domain Guardrails",
] as const;
export type NapkinCategory = (typeof NAPKIN_CATEGORIES)[number];

export interface NapkinRecord {
  id: string;
  logicalKey: string;
  category: NapkinCategory;
  priority: number;
  recurrence: number;
  hitCount: number;
  situation: string;
  action: string;
  sourceClassification: SafeSourceClassification;
  createdAt: string;
  updatedAt: string;
}

export type RepairState =
  | "none"
  | "queued"
  | "dispatched"
  | "running"
  | "awaiting_verification"
  | "failed"
  | "indeterminate"
  | "verified";
export type PublicationState = "none" | "pending" | "failed" | "indeterminate" | "published";

export interface PapercutRecord {
  id: string;
  fingerprint: string;
  summary: string;
  severity: "minor" | "major" | "blocker";
  prevention: string;
  acceptanceCondition: string;
  sourceClassification: SafeSourceClassification;
  lifecycle: "open" | "resolved" | "dismissed";
  repairState: RepairState;
  publicationState: PublicationState;
  publicationIssueNumber: number | null;
  recurrence: number;
  relatedIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProposalRecord {
  id: string;
  targetType: "context" | "napkin";
  logicalKey: string;
  summary: string;
  sourceClassification: SafeSourceClassification;
  status: "open" | "approved" | "dismissed";
  createdAt: string;
  updatedAt: string;
}

export interface ConflictRecord {
  id: string;
  conflictKind: "validated-revisions" | "opaque-quarantine";
  reasonCode: string;
  transactionId: string;
  candidateRevisionId: string;
  alternateRevisionId: string | null;
  canonicalOccupied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationRecord {
  id: string;
  fromScopeId: string;
  toScopeId: string;
  sourceRevisionIds: string[];
  sourceDigests: string[];
  status: "pending" | "complete";
  createdAt: string;
  updatedAt: string;
}

export interface TransactionRecord {
  id: string;
  documentKey: string;
  state: "staged" | "displaced" | "promoted" | "conflicted";
  candidateRevisionId: string;
  expectedRevisionId: string | null;
  expectedDigest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricsRecord {
  id: string;
  injectedCharacters: number;
  papercutsOpened: number;
  papercutsClosed: number;
  napkinHits: number;
  observedAt: string;
}

export interface RecordByDocumentType {
  context: ContextRecord;
  napkin: NapkinRecord;
  papercut: PapercutRecord;
  proposal: ProposalRecord;
  conflict: ConflictRecord;
  migration: MigrationRecord;
  transaction: TransactionRecord;
  metrics: MetricsRecord;
}

export interface ClasiDocument<T extends DocumentType = DocumentType> {
  schemaVersion: typeof CLASI_SCHEMA_VERSION;
  documentType: T;
  scopeType: ScopeType;
  scopeId: string;
  revisionId: string;
  parentRevisionId: string | null;
  updatedAt: string;
  records: RecordByDocumentType[T][];
}

export type AnyClasiDocument = {
  [T in DocumentType]: ClasiDocument<T>;
}[DocumentType];

export const BODY_FIELDS_BY_DOCUMENT_TYPE: {
  readonly [T in DocumentType]: readonly (keyof RecordByDocumentType[T] & string)[];
} = {
  context: [
    "logicalKey",
    "kind",
    "value",
    "sourceClassification",
    "approved",
    "priority",
    "createdAt",
    "updatedAt",
  ],
  napkin: [
    "logicalKey",
    "category",
    "priority",
    "recurrence",
    "hitCount",
    "situation",
    "action",
    "sourceClassification",
    "createdAt",
    "updatedAt",
  ],
  papercut: [
    "fingerprint",
    "summary",
    "severity",
    "prevention",
    "acceptanceCondition",
    "sourceClassification",
    "lifecycle",
    "repairState",
    "publicationState",
    "publicationIssueNumber",
    "recurrence",
    "relatedIds",
    "createdAt",
    "updatedAt",
  ],
  proposal: [
    "targetType",
    "logicalKey",
    "summary",
    "sourceClassification",
    "status",
    "createdAt",
    "updatedAt",
  ],
  conflict: [
    "conflictKind",
    "reasonCode",
    "transactionId",
    "candidateRevisionId",
    "alternateRevisionId",
    "canonicalOccupied",
    "createdAt",
    "updatedAt",
  ],
  migration: [
    "fromScopeId",
    "toScopeId",
    "sourceRevisionIds",
    "sourceDigests",
    "status",
    "createdAt",
    "updatedAt",
  ],
  transaction: [
    "documentKey",
    "state",
    "candidateRevisionId",
    "expectedRevisionId",
    "expectedDigest",
    "createdAt",
    "updatedAt",
  ],
  metrics: ["injectedCharacters", "papercutsOpened", "papercutsClosed", "napkinHits", "observedAt"],
};

export class SchemaValidationError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

export function validateDocument(value: unknown): AnyClasiDocument {
  const document = expectRecord(value);
  expectExactKeys(document, [
    "schemaVersion",
    "documentType",
    "scopeType",
    "scopeId",
    "revisionId",
    "parentRevisionId",
    "updatedAt",
    "records",
  ]);
  if (document.schemaVersion !== CLASI_SCHEMA_VERSION) fail("unsupported-schema");
  const documentType = expectEnum(document.documentType, DOCUMENT_TYPES);
  const scopeType = expectEnum(document.scopeType, ["global", "machine", "repository"] as const);
  const scopeId = expectString(document.scopeId, 80);
  validateScope(scopeType, scopeId);
  const revisionId = expectOpaqueId(document.revisionId, "rev");
  const parentRevisionId = document.parentRevisionId === null
    ? null
    : expectOpaqueId(document.parentRevisionId, "rev");
  const updatedAt = expectTimestamp(document.updatedAt);
  if (!Array.isArray(document.records)) fail("invalid-field");

  const base = {
    schemaVersion: CLASI_SCHEMA_VERSION,
    scopeType,
    scopeId,
    revisionId,
    parentRevisionId,
    updatedAt,
  } as const;

  switch (documentType) {
    case "context":
      return { ...base, documentType, records: document.records.map(validateContextRecord) };
    case "napkin":
      return { ...base, documentType, records: document.records.map(validateNapkinRecord) };
    case "papercut":
      return { ...base, documentType, records: document.records.map(validatePapercutRecord) };
    case "proposal":
      return { ...base, documentType, records: document.records.map(validateProposalRecord) };
    case "conflict":
      return { ...base, documentType, records: document.records.map(validateConflictRecord) };
    case "migration":
      return { ...base, documentType, records: document.records.map(validateMigrationRecord) };
    case "transaction":
      return { ...base, documentType, records: document.records.map(validateTransactionRecord) };
    case "metrics":
      return { ...base, documentType, records: document.records.map(validateMetricsRecord) };
  }
}

function validateContextRecord(value: unknown): ContextRecord {
  const record = typedRecord(value, "context", "ctx");
  return {
    id: record.id,
    logicalKey: expectLogicalKey(record.logicalKey),
    kind: expectEnum(record.kind, ["fact", "preference"] as const),
    value: expectString(record.value),
    sourceClassification: expectEnum(record.sourceClassification, SAFE_SOURCE_CLASSIFICATIONS),
    approved: expectBoolean(record.approved),
    priority: expectInteger(record.priority, 0, 100),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateNapkinRecord(value: unknown): NapkinRecord {
  const record = typedRecord(value, "napkin", "napkin");
  return {
    id: record.id,
    logicalKey: expectLogicalKey(record.logicalKey),
    category: expectEnum(record.category, NAPKIN_CATEGORIES),
    priority: expectInteger(record.priority, 0, 100),
    recurrence: expectInteger(record.recurrence, 1, Number.MAX_SAFE_INTEGER),
    hitCount: expectInteger(record.hitCount, 0, Number.MAX_SAFE_INTEGER),
    situation: expectString(record.situation),
    action: expectString(record.action),
    sourceClassification: expectEnum(record.sourceClassification, SAFE_SOURCE_CLASSIFICATIONS),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validatePapercutRecord(value: unknown): PapercutRecord {
  const record = typedRecord(value, "papercut", "cut");
  const relatedIds = expectStringArray(record.relatedIds, 16).map(id => expectAnyOpaqueId(id));
  const publicationState = expectEnum(record.publicationState, [
    "none",
    "pending",
    "failed",
    "indeterminate",
    "published",
  ] as const);
  const publicationIssueNumber = record.publicationIssueNumber === null
    ? null
    : expectInteger(record.publicationIssueNumber, 1, Number.MAX_SAFE_INTEGER);
  if ((publicationState === "published") !== (publicationIssueNumber !== null)) {
    fail("invalid-field");
  }
  return {
    id: record.id,
    fingerprint: expectLogicalKey(record.fingerprint),
    summary: expectString(record.summary),
    severity: expectEnum(record.severity, ["minor", "major", "blocker"] as const),
    prevention: expectString(record.prevention),
    acceptanceCondition: expectString(record.acceptanceCondition),
    sourceClassification: expectEnum(record.sourceClassification, SAFE_SOURCE_CLASSIFICATIONS),
    lifecycle: expectEnum(record.lifecycle, ["open", "resolved", "dismissed"] as const),
    repairState: expectEnum(record.repairState, [
      "none",
      "queued",
      "dispatched",
      "running",
      "awaiting_verification",
      "failed",
      "indeterminate",
      "verified",
    ] as const),
    publicationState,
    publicationIssueNumber,
    recurrence: expectInteger(record.recurrence, 1, Number.MAX_SAFE_INTEGER),
    relatedIds,
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateProposalRecord(value: unknown): ProposalRecord {
  const record = typedRecord(value, "proposal", "proposal");
  return {
    id: record.id,
    targetType: expectEnum(record.targetType, ["context", "napkin"] as const),
    logicalKey: expectLogicalKey(record.logicalKey),
    summary: expectString(record.summary),
    sourceClassification: expectEnum(record.sourceClassification, SAFE_SOURCE_CLASSIFICATIONS),
    status: expectEnum(record.status, ["open", "approved", "dismissed"] as const),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateConflictRecord(value: unknown): ConflictRecord {
  const record = typedRecord(value, "conflict", "conflict");
  return {
    id: record.id,
    conflictKind: expectEnum(record.conflictKind, ["validated-revisions", "opaque-quarantine"] as const),
    reasonCode: expectLogicalKey(record.reasonCode),
    transactionId: expectOpaqueId(record.transactionId, "tx"),
    candidateRevisionId: expectOpaqueId(record.candidateRevisionId, "rev"),
    alternateRevisionId: record.alternateRevisionId === null
      ? null
      : expectOpaqueId(record.alternateRevisionId, "rev"),
    canonicalOccupied: expectBoolean(record.canonicalOccupied),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateMigrationRecord(value: unknown): MigrationRecord {
  const record = typedRecord(value, "migration", "migration");
  return {
    id: record.id,
    fromScopeId: expectScopeId(record.fromScopeId),
    toScopeId: expectScopeId(record.toScopeId),
    sourceRevisionIds: expectStringArray(record.sourceRevisionIds, 256)
      .map(id => expectOpaqueId(id, "rev")),
    sourceDigests: expectStringArray(record.sourceDigests, 256).map(expectDigest),
    status: expectEnum(record.status, ["pending", "complete"] as const),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateTransactionRecord(value: unknown): TransactionRecord {
  const record = typedRecord(value, "transaction", "tx");
  return {
    id: record.id,
    documentKey: expectOpaqueId(record.documentKey, "doc"),
    state: expectEnum(record.state, ["staged", "displaced", "promoted", "conflicted"] as const),
    candidateRevisionId: expectOpaqueId(record.candidateRevisionId, "rev"),
    expectedRevisionId: record.expectedRevisionId === null
      ? null
      : expectOpaqueId(record.expectedRevisionId, "rev"),
    expectedDigest: record.expectedDigest === null
      ? null
      : expectDigest(record.expectedDigest),
    createdAt: expectTimestamp(record.createdAt),
    updatedAt: expectTimestamp(record.updatedAt),
  };
}

function validateMetricsRecord(value: unknown): MetricsRecord {
  const record = typedRecord(value, "metrics", "metric");
  return {
    id: record.id,
    injectedCharacters: expectInteger(record.injectedCharacters, 0, Number.MAX_SAFE_INTEGER),
    papercutsOpened: expectInteger(record.papercutsOpened, 0, Number.MAX_SAFE_INTEGER),
    papercutsClosed: expectInteger(record.papercutsClosed, 0, Number.MAX_SAFE_INTEGER),
    napkinHits: expectInteger(record.napkinHits, 0, Number.MAX_SAFE_INTEGER),
    observedAt: expectTimestamp(record.observedAt),
  };
}

function typedRecord(
  value: unknown,
  type: DocumentType,
  idPrefix: Parameters<typeof isOpaqueId>[1],
): Record<string, unknown> & { id: string } {
  const record = expectRecord(value);
  expectExactKeys(record, ["id", ...BODY_FIELDS_BY_DOCUMENT_TYPE[type]]);
  return { ...record, id: expectOpaqueId(record.id, idPrefix) };
}

function validateScope(type: ScopeType, id: string): void {
  if (type === "global" && id === "global") return;
  if (type === "machine" && isOpaqueId(id, "machine")) return;
  if (type === "repository" && isOpaqueId(id, "repo")) return;
  fail("invalid-field");
}

function expectScopeId(value: unknown): string {
  if (value === "global" || isOpaqueId(value, "machine") || isOpaqueId(value, "repo")) return value;
  return fail("invalid-field");
}

function expectAnyOpaqueId(value: unknown): string {
  if (isOpaqueId(value)) return value;
  return fail("invalid-field");
}

function expectOpaqueId(value: unknown, prefix: Parameters<typeof isOpaqueId>[1]): string {
  if (isOpaqueId(value, prefix)) return value;
  return fail("invalid-field");
}

function expectDigest(value: unknown): string {
  if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
  return fail("invalid-field");
}

function expectLogicalKey(value: unknown): string {
  const text = expectString(value, 80);
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(text)) fail("invalid-field");
  return text;
}

function expectTimestamp(value: unknown): string {
  const text = expectString(value, 32);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) fail("invalid-field");
  return text;
}

function expectString(value: unknown, maximum = MAX_BODY_TEXT_CHARACTERS): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\r\n]/.test(value)) {
    return fail(value && typeof value === "string" && value.length > maximum ? "oversized-field" : "invalid-field");
  }
  return value;
}

function expectStringArray(value: unknown, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item => typeof item !== "string")) {
    return fail("invalid-field");
  }
  return value.map(item => expectString(item, 80));
}

function expectBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") return fail("invalid-field");
  return value;
}

function expectInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    return fail("invalid-field");
  }
  return value;
}

function expectEnum<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) return fail("invalid-field");
  return value as T[number];
}

function expectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("invalid-field");
  return value as Record<string, unknown>;
}

function expectExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("unknown-body-field");
  }
}

function fail(code: string): never {
  throw new SchemaValidationError(code);
}
