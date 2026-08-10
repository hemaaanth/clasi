import { describe, expect, test } from "bun:test";
import type { ClasiDocument, DocumentType } from "../src/schema.ts";
import {
  MarkdownCodecError,
  decodeMarkdown,
  encodeMarkdown,
} from "../src/markdown-codec.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const REVISION_ID = opaque("rev", 1);

const DOCUMENTS: readonly ClasiDocument[] = [
  document("context", "global", "global", [
    {
      id: opaque("ctx", 1),
      logicalKey: "package-manager",
      kind: "preference",
      value: "Prefer Bun for package operations.",
      sourceClassification: "explicit-user-input",
      approved: true,
      priority: 80,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("napkin", "repository", opaque("repo", 1), [
    {
      id: opaque("napkin", 1),
      logicalKey: "package-bin-path",
      category: "Tooling",
      priority: 70,
      recurrence: 2,
      hitCount: 1,
      situation: "Plugin installation does not export package binaries.",
      action: "Use the package-local binary or install the package globally.",
      sourceClassification: "generalized-derived",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("papercut", "repository", opaque("repo", 1), [
    {
      id: opaque("cut", 1),
      fingerprint: "plugin-bin-export-assumption",
      summary: "Plugin installation can be mistaken for global binary installation.",
      severity: "minor",
      prevention: "Document and verify the two installation paths separately.",
      acceptanceCondition: "Both installation paths pass isolated smoke checks.",
      sourceClassification: "generalized-derived",
      lifecycle: "open",
      repairState: "none",
      publicationState: "none",
      recurrence: 1,
      relatedIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("proposal", "global", "global", [
    {
      id: opaque("proposal", 1),
      targetType: "context",
      logicalKey: "review-style",
      summary: "Prefer concise code review findings.",
      sourceClassification: "explicit-user-input",
      status: "open",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("conflict", "repository", opaque("repo", 1), [
    {
      id: opaque("conflict", 1),
      conflictKind: "validated-revisions",
      reasonCode: "revision-diverged",
      transactionId: opaque("tx", 1),
      candidateRevisionId: opaque("rev", 2),
      alternateRevisionId: opaque("rev", 3),
      canonicalOccupied: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("migration", "repository", opaque("repo", 1), [
    {
      id: opaque("migration", 1),
      fromScopeId: opaque("repo", 1),
      toScopeId: opaque("repo", 2),
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("transaction", "repository", opaque("repo", 1), [
    {
      id: opaque("tx", 1),
      documentKey: opaque("doc", 1),
      state: "staged",
      candidateRevisionId: opaque("rev", 2),
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]),
  document("metrics", "machine", opaque("machine", 1), [
    {
      id: opaque("metric", 1),
      injectedCharacters: 1200,
      papercutsOpened: 2,
      papercutsClosed: 1,
      napkinHits: 3,
      observedAt: NOW,
    },
  ]),
];

describe("strict Markdown codec", () => {
  test.each([...DOCUMENTS])("round-trips $documentType with canonical LF", (source: ClasiDocument) => {
    const encoded = encodeMarkdown(source);

    expect(encoded.startsWith("\uFEFF")).toBeFalse();
    expect(encoded).not.toContain("\r");
    expect(decodeMarkdown(new TextEncoder().encode(encoded))).toEqual(source);
  });

  test.each([...DOCUMENTS])("accepts BOM and CRLF for $documentType", (source: ClasiDocument) => {
    const windowsBytes = new TextEncoder().encode(`\uFEFF${encodeMarkdown(source).replaceAll("\n", "\r\n")}`);

    expect(decodeMarkdown(windowsBytes)).toEqual(source);
  });

  test("rejects unknown, duplicate, multiline, unsupported, and malformed frontmatter", () => {
    const valid = encodeMarkdown(DOCUMENTS[0] as ClasiDocument);

    expectCodecFailure(valid.replace("updated_at:", "unknown_key:"), "unknown-frontmatter-key");
    expectCodecFailure(valid.replace("schema_version: 1", "schema_version: 1\nschema_version: 1"), "duplicate-frontmatter-key");
    expectCodecFailure(valid.replace("scope_id: global", "scope_id: global\n  continued"), "multiline-frontmatter");
    expectCodecFailure(valid.replace("schema_version: 1", "schema_version: 2"), "unsupported-schema");
    expectCodecFailure(valid.replace(REVISION_ID, "rev_invalid"), "invalid-field");
    expectCodecFailure(valid.replace("kind: \"preference\"", "unknown: \"preference\""), "unknown-body-field");
  });

  test("applies privacy validation when loading manually edited Markdown", () => {
    const valid = encodeMarkdown(DOCUMENTS[0] as ClasiDocument);
    const unsafe = valid.replace(
      "Prefer Bun for package operations.",
      "Retain ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    );

    expectCodecFailure(unsafe, "secret-pattern");
  });

  test("rejects code fences, invalid UTF-8, and oversized documents", () => {
    const valid = encodeMarkdown(DOCUMENTS[0] as ClasiDocument);

    expectCodecFailure(`${valid}\n\`\`\`text\nraw\n\`\`\`\n`, "code-fenced");
    expect(() => decodeMarkdown(new Uint8Array([0xff, 0xfe]))).toThrow(
      new MarkdownCodecError("invalid-utf8"),
    );
    expectCodecFailure(`${valid}${"x".repeat(262_144)}`, "document-too-large");
  });
});

function document<T extends DocumentType>(
  documentType: T,
  scopeType: "global" | "machine" | "repository",
  scopeId: string,
  records: ClasiDocument<T>["records"],
): ClasiDocument<T> {
  return {
    schemaVersion: 1,
    documentType,
    scopeType,
    scopeId,
    revisionId: REVISION_ID,
    parentRevisionId: null,
    updatedAt: NOW,
    records,
  } as ClasiDocument<T>;
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}

function expectCodecFailure(source: string, code: string): void {
  try {
    decodeMarkdown(new TextEncoder().encode(source));
    throw new Error(`Expected codec failure: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MarkdownCodecError);
    expect((error as MarkdownCodecError).code).toBe(code);
  }
}
