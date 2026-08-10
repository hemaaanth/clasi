import {
  BODY_FIELDS_BY_DOCUMENT_TYPE,
  CLASI_SCHEMA_VERSION,
  DOCUMENT_TYPES,
  MAX_DOCUMENT_BYTES,
  SchemaValidationError,
  validateDocument,
} from "./schema.ts";
import type { ClasiDocument, DocumentType } from "./schema.ts";
import { validateDocumentPrivacy } from "./privacy.ts";

const FRONTMATTER_FIELDS = [
  "schema_version",
  "document_type",
  "scope_type",
  "scope_id",
  "revision_id",
  "parent_revision_id",
  "updated_at",
] as const;

export class MarkdownCodecError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MarkdownCodecError";
  }
}

export function encodeMarkdown(input: ClasiDocument): string {
  const document = validateDocument(input);
  const privacy = validateDocumentPrivacy(document);
  if (!privacy.ok) throw new MarkdownCodecError(privacy.code);
  const lines = [
    "---",
    `schema_version: ${document.schemaVersion}`,
    `document_type: ${document.documentType}`,
    `scope_type: ${document.scopeType}`,
    `scope_id: ${document.scopeId}`,
    `revision_id: ${document.revisionId}`,
    `parent_revision_id: ${document.parentRevisionId ?? "none"}`,
    `updated_at: ${document.updatedAt}`,
    "---",
    "",
    `# clasi ${document.documentType}`,
  ];
  const fields = BODY_FIELDS_BY_DOCUMENT_TYPE[document.documentType];
  for (const record of document.records) {
    lines.push("", `## ${record.id}`);
    for (const field of fields) {
      lines.push(`${toSnakeCase(field)}: ${JSON.stringify(Reflect.get(record, field))}`);
    }
  }
  lines.push("");
  const encoded = lines.join("\n");
  if (Buffer.byteLength(encoded, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new MarkdownCodecError("document-too-large");
  }
  return encoded;
}

export function decodeMarkdown(bytes: Uint8Array): ClasiDocument {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new MarkdownCodecError("document-too-large");

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MarkdownCodecError("invalid-utf8");
  }
  if (source.startsWith("\uFEFF")) source = source.slice(1);
  source = source.replaceAll("\r\n", "\n");
  if (source.includes("\r")) throw new MarkdownCodecError("malformed-newline");
  if (source.includes("```")) throw new MarkdownCodecError("code-fenced");

  const lines = source.split("\n");
  if (lines[0] !== "---") throw new MarkdownCodecError("malformed-frontmatter");
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) throw new MarkdownCodecError("malformed-frontmatter");

  const frontmatter = parseFrontmatter(lines.slice(1, closingIndex));
  const documentType = frontmatter.document_type;
  if (!DOCUMENT_TYPES.includes(documentType as DocumentType)) {
    throw new MarkdownCodecError("invalid-field");
  }
  const bodyLines = lines.slice(closingIndex + 1);
  if (bodyLines.shift() !== "") throw new MarkdownCodecError("malformed-body");
  const expectedHeading = `# clasi ${documentType}`;
  if (bodyLines.shift() !== expectedHeading) throw new MarkdownCodecError("malformed-body");

  const records = parseRecords(documentType as DocumentType, bodyLines);
  const candidate = {
    schemaVersion: parseSchemaVersion(frontmatter.schema_version),
    documentType,
    scopeType: frontmatter.scope_type,
    scopeId: frontmatter.scope_id,
    revisionId: frontmatter.revision_id,
    parentRevisionId:
      frontmatter.parent_revision_id === "none" ? null : frontmatter.parent_revision_id,
    updatedAt: frontmatter.updated_at,
    records,
  };

  try {
    const document = validateDocument(candidate);
    const privacy = validateDocumentPrivacy(document);
    if (!privacy.ok) throw new MarkdownCodecError(privacy.code);
    return document;
  } catch (error) {
    if (error instanceof SchemaValidationError) throw new MarkdownCodecError(error.code);
    throw error;
  }
}

function parseFrontmatter(lines: readonly string[]): Record<(typeof FRONTMATTER_FIELDS)[number], string> {
  const parsed: Partial<Record<(typeof FRONTMATTER_FIELDS)[number], string>> = {};
  for (const line of lines) {
    if (/^\s/.test(line) || !line.includes(": ")) {
      throw new MarkdownCodecError("multiline-frontmatter");
    }
    const separator = line.indexOf(": ");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (!FRONTMATTER_FIELDS.includes(key as (typeof FRONTMATTER_FIELDS)[number])) {
      throw new MarkdownCodecError("unknown-frontmatter-key");
    }
    const typedKey = key as (typeof FRONTMATTER_FIELDS)[number];
    if (typedKey in parsed) throw new MarkdownCodecError("duplicate-frontmatter-key");
    if (!value || /[\r\n]/.test(value)) throw new MarkdownCodecError("malformed-frontmatter");
    parsed[typedKey] = value;
  }
  if (FRONTMATTER_FIELDS.some(field => !(field in parsed))) {
    throw new MarkdownCodecError("malformed-frontmatter");
  }
  return parsed as Record<(typeof FRONTMATTER_FIELDS)[number], string>;
}

function parseRecords(documentType: DocumentType, lines: readonly string[]): unknown[] {
  const records: unknown[] = [];
  const expectedFields: readonly string[] = BODY_FIELDS_BY_DOCUMENT_TYPE[documentType];
  let index = 0;

  while (index < lines.length) {
    if (lines[index] === "") {
      index += 1;
      continue;
    }
    const heading = lines[index];
    if (!heading?.startsWith("## ") || heading.length === 3) {
      throw new MarkdownCodecError("malformed-body");
    }
    const record: Record<string, unknown> = { id: heading.slice(3) };
    const seen = new Set<string>();
    index += 1;

    while (index < lines.length && lines[index] !== "") {
      const line = lines[index];
      if (!line || /^\s/.test(line) || !line.includes(": ")) {
        throw new MarkdownCodecError("malformed-body");
      }
      const separator = line.indexOf(": ");
      const serializedKey = line.slice(0, separator);
      const field = toCamelCase(serializedKey);
      if (!expectedFields.includes(field)) throw new MarkdownCodecError("unknown-body-field");
      if (seen.has(field)) throw new MarkdownCodecError("duplicate-body-field");
      seen.add(field);
      try {
        record[field] = JSON.parse(line.slice(separator + 2)) as unknown;
      } catch {
        throw new MarkdownCodecError("malformed-body");
      }
      index += 1;
    }
    records.push(record);
  }
  return records;
}

function parseSchemaVersion(value: string): number {
  if (!/^\d+$/.test(value)) throw new MarkdownCodecError("unsupported-schema");
  const version = Number(value);
  if (version !== CLASI_SCHEMA_VERSION) throw new MarkdownCodecError("unsupported-schema");
  return version;
}

function toSnakeCase(value: string): string {
  return value.replaceAll(/[A-Z]/g, character => `_${character.toLowerCase()}`);
}

function toCamelCase(value: string): string {
  return value.replaceAll(/_([a-z])/g, (_match, character: string) => character.toUpperCase());
}
