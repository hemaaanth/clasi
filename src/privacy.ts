import type { AnyClasiDocument } from "./schema.ts";

export const SAFE_SOURCE_CLASSIFICATIONS = [
  "safe-machine-fact",
  "explicit-user-input",
  "generalized-derived",
  "aggregate-observation",
  "validated-system-state",
] as const;

export const UNSAFE_SOURCE_CLASSIFICATIONS = [
  "unclassified",
  "prompt",
  "terminal-output",
  "source-code",
  "environment-dump",
  "customer-data",
  "pii",
  "secret",
] as const;

export type SafeSourceClassification = (typeof SAFE_SOURCE_CLASSIFICATIONS)[number];
export type UnsafeSourceClassification = (typeof UNSAFE_SOURCE_CLASSIFICATIONS)[number];
export type SourceClassification = SafeSourceClassification | UnsafeSourceClassification;

export type PrivateFieldValue = string | number | boolean | readonly string[];
export interface PrivateCandidate {
  classification: SourceClassification;
  fields: Record<string, unknown>;
}

export type PrivacyReasonCode =
  | "unsafe-source"
  | "invalid-field"
  | "oversized-field"
  | "secret-pattern"
  | "pii-pattern"
  | "path-bearing"
  | "terminal-shaped"
  | "raw-environment"
  | "code-fenced";

export type PrivacyValidation = { ok: true } | { ok: false; code: PrivacyReasonCode };
export type PrivacyDerivation<T> = { ok: true; value: T } | { ok: false; code: PrivacyReasonCode };

const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_CLASSIFICATION_BY_NAME: Record<SafeSourceClassification, true> = {
  "safe-machine-fact": true,
  "explicit-user-input": true,
  "generalized-derived": true,
  "aggregate-observation": true,
  "validated-system-state": true,
};
const MAX_TEXT_CHARACTERS = 240;
const MAX_ARRAY_ITEMS = 16;
const MAX_ARRAY_ITEM_CHARACTERS = 80;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
] as const;

const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|\D)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?:\D|$)/,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\bhttps?:\/\/\S+/i,
  /(?:^|\s)@[A-Za-z0-9_]{2,}\b/,
] as const;

const PATH_PATTERNS = [
  /(?:^|[\s('"`])\/(?:home|Users|private|var|tmp|opt|etc|mnt)\/[\w.@+~/-]+/,
  /\b[A-Za-z]:\\(?:[^\\\s]+\\?)+/,
  /\\\\[^\\\s]+\\[^\\\s]+/,
  /\bfile:\/\/\S+/i,
] as const;

const TERMINAL_PATTERNS = [
  /(?:^|\n)\s*[$#>]\s+\S+/,
  /(?:^|\n)\s*PS\s+[^\n>]*>\s*\S+/i,
  /(?:^|\n)(?:FAIL|PASS)\s+\S+/,
  /(?:^|\n)\s*at\s+\S+\s+\([^\n]+:\d+:\d+\)/,
] as const;

const ENVIRONMENT_PATTERN = /(?:^|\n)[A-Z][A-Z0-9_]{2,}\s*=\s*\S+/;
export function validatePrivateFields(candidate: PrivateCandidate): PrivacyValidation {
  if (!Object.hasOwn(SAFE_CLASSIFICATION_BY_NAME, candidate.classification)) {
    return { ok: false, code: "unsafe-source" };
  }

  for (const [name, value] of Object.entries(candidate.fields)) {
    if (!FIELD_NAME_PATTERN.test(name)) return { ok: false, code: "invalid-field" };
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { ok: false, code: "invalid-field" };
      continue;
    }
    if (typeof value === "boolean") continue;
    if (typeof value === "string") {
      const validation = validateText(value, MAX_TEXT_CHARACTERS);
      if (!validation.ok) return validation;
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS || value.some(item => typeof item !== "string")) {
        return { ok: false, code: "invalid-field" };
      }
      for (const item of value) {
        const validation = validateText(item, MAX_ARRAY_ITEM_CHARACTERS);
        if (!validation.ok) return validation;
      }
      continue;
    }
    return { ok: false, code: "invalid-field" };
  }
  return { ok: true };
}

export function validateAndDerive<T>(
  candidate: PrivateCandidate,
  derive: () => T,
): PrivacyDerivation<T> {
  const validation = validatePrivateFields(candidate);
  return validation.ok ? { ok: true, value: derive() } : validation;
}

export function validateDocumentPrivacy(document: AnyClasiDocument): PrivacyValidation {
  switch (document.documentType) {
    case "context":
      for (const record of document.records) {
        const result = validatePrivateFields({
          classification: record.sourceClassification,
          fields: {
            logical_key: record.logicalKey,
            value: record.value,
          },
        });
        if (!result.ok) return result;
      }
      break;
    case "napkin":
      for (const record of document.records) {
        const result = validatePrivateFields({
          classification: record.sourceClassification,
          fields: {
            logical_key: record.logicalKey,
            category: record.category,
            situation: record.situation,
            action: record.action,
          },
        });
        if (!result.ok) return result;
      }
      break;
    case "papercut":
      for (const record of document.records) {
        const result = validatePrivateFields({
          classification: record.sourceClassification,
          fields: {
            fingerprint: record.fingerprint,
            summary: record.summary,
            prevention: record.prevention,
            acceptance_condition: record.acceptanceCondition,
          },
        });
        if (!result.ok) return result;
      }
      break;
    case "proposal":
      for (const record of document.records) {
        const result = validatePrivateFields({
          classification: record.sourceClassification,
          fields: {
            logical_key: record.logicalKey,
            summary: record.summary,
          },
        });
        if (!result.ok) return result;
      }
      break;
  }
  return { ok: true };
}

export function scanExcludedData(value: string): PrivacyValidation {
  if (!value) return { ok: false, code: "invalid-field" };
  if (/\p{C}/u.test(value.replaceAll("\n", ""))) return { ok: false, code: "invalid-field" };
  if (value.includes("```")) return { ok: false, code: "code-fenced" };
  if (ENVIRONMENT_PATTERN.test(value)) return { ok: false, code: "raw-environment" };
  if (TERMINAL_PATTERNS.some(pattern => pattern.test(value))) {
    return { ok: false, code: "terminal-shaped" };
  }
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) {
    return { ok: false, code: "secret-pattern" };
  }
  if (PII_PATTERNS.some(pattern => pattern.test(value))) {
    return { ok: false, code: "pii-pattern" };
  }
  if (PATH_PATTERNS.some(pattern => pattern.test(value))) {
    return { ok: false, code: "path-bearing" };
  }
  return { ok: true };
}

function validateText(value: string, maximumCharacters: number): PrivacyValidation {
  if (!value || value.length > maximumCharacters) {
    return { ok: false, code: value.length > maximumCharacters ? "oversized-field" : "invalid-field" };
  }
  return scanExcludedData(value);
}
