import { createHash } from "node:crypto";
import type { ClasiPaths } from "./paths.ts";
import { decodeMarkdown } from "./markdown-codec.ts";
import type { AnyClasiDocument } from "./schema.ts";
import { hasErrorCode as hasCode } from "./root-safety.ts";

export class RevisionError extends Error {
  constructor(readonly code:
    | "revision-collision"
    | "revision-mismatch"
    | "duplicate-revision"
    | "missing-parent"
    | "revision-cycle"
    | "inconsistent-document"
  ) {
    super(code);
    this.name = "RevisionError";
  }
}

export interface RevisionFileSystem {
  mkdirParent(path: string): Promise<void>;
  readBytes(path: string): Promise<Uint8Array>;
  writeExclusive(path: string, content: string): Promise<void>;
}

export function digestValidatedMarkdown(markdown: string | Uint8Array): string {
  return createHash("sha256").update(markdown).digest("hex");
}

export async function writeImmutableRevision(
  fileSystem: RevisionFileSystem,
  paths: ClasiPaths,
  documentKey: string,
  document: AnyClasiDocument,
  markdown: string,
): Promise<void> {
  const path = paths.revision(documentKey, document.revisionId);
  await fileSystem.mkdirParent(path);
  try {
    await fileSystem.writeExclusive(path, markdown);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const existing = await fileSystem.readBytes(path);
    if (Buffer.compare(existing, Buffer.from(markdown, "utf8")) !== 0) {
      throw new RevisionError("revision-collision");
    }
  }
}

export async function readRevision(
  fileSystem: RevisionFileSystem,
  paths: ClasiPaths,
  documentKey: string,
  revisionId: string,
): Promise<{ document: AnyClasiDocument; bytes: Uint8Array; digest: string }> {
  const bytes = await fileSystem.readBytes(paths.revision(documentKey, revisionId));
  const document = decodeMarkdown(bytes);
  if (document.revisionId !== revisionId) throw new RevisionError("revision-mismatch");
  return { document, bytes, digest: digestValidatedMarkdown(bytes) };
}

export function findRevisionHeads(documents: readonly AnyClasiDocument[]): string[] {
  const byId = new Map<string, AnyClasiDocument>();
  const first = documents[0];
  for (const document of documents) {
    if (byId.has(document.revisionId)) throw new RevisionError("duplicate-revision");
    if (
      first &&
      (
        document.documentType !== first.documentType ||
        document.scopeType !== first.scopeType ||
        document.scopeId !== first.scopeId
      )
    ) {
      throw new RevisionError("inconsistent-document");
    }
    byId.set(document.revisionId, document);
  }

  const parentIds = new Set<string>();
  for (const document of documents) {
    if (document.parentRevisionId === null) continue;
    if (!byId.has(document.parentRevisionId)) throw new RevisionError("missing-parent");
    parentIds.add(document.parentRevisionId);
  }

  for (const document of documents) {
    const visited = new Set<string>();
    let current: AnyClasiDocument | undefined = document;
    while (current && current.parentRevisionId !== null) {
      if (!visited.add(current.revisionId)) throw new RevisionError("revision-cycle");
      current = byId.get(current.parentRevisionId);
    }
  }

  return documents
    .map(document => document.revisionId)
    .filter(revisionId => !parentIds.has(revisionId))
    .sort();
}

