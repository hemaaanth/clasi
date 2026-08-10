import { encodeMarkdown } from "./markdown-codec.ts";
import type { ClasiPaths } from "./paths.ts";
import { CLASI_SCHEMA_VERSION } from "./schema.ts";
import type { AnyClasiDocument, ClasiDocument, ConflictRecord } from "./schema.ts";
import type { RevisionFileSystem } from "./revisions.ts";

export type ConflictKind = ConflictRecord["conflictKind"];

export interface ConflictInput {
  conflictId: string;
  revisionId: string;
  transactionId: string;
  candidate: AnyClasiDocument;
  kind: ConflictKind;
  reasonCode: string;
  alternateRevisionId: string | null;
  canonicalOccupied: boolean;
  now: string;
}

export async function writeConflictRecord(
  fileSystem: RevisionFileSystem,
  paths: ClasiPaths,
  input: ConflictInput,
): Promise<void> {
  const document: ClasiDocument<"conflict"> = {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "conflict",
    scopeType: input.candidate.scopeType,
    scopeId: input.candidate.scopeId,
    revisionId: input.revisionId,
    parentRevisionId: null,
    updatedAt: input.now,
    records: [
      {
        id: input.conflictId,
        conflictKind: input.kind,
        reasonCode: input.reasonCode,
        transactionId: input.transactionId,
        candidateRevisionId: input.candidate.revisionId,
        alternateRevisionId: input.alternateRevisionId,
        canonicalOccupied: input.canonicalOccupied,
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
  };
  const path = paths.conflict(input.conflictId);
  await fileSystem.mkdirParent(path);
  await fileSystem.writeExclusive(path, encodeMarkdown(document));
}
