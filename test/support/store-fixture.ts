import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClasiPaths } from "../../src/paths.ts";
import type { ClasiPaths } from "../../src/paths.ts";
import { createPrivateRoot, pinRoot } from "../../src/root-safety.ts";
import type { RootPin } from "../../src/root-safety.ts";
import { CLASI_SCHEMA_VERSION } from "../../src/schema.ts";
import type { ClasiDocument } from "../../src/schema.ts";
import { MarkdownStore } from "../../src/markdown-store.ts";
import type { StoreFileSystem } from "../../src/markdown-store.ts";

const NOW = "2026-08-09T12:00:00.000Z";

export interface StoreFixture {
  paths: ClasiPaths;
  roots: { controlRoot: string; dataRoot: string };
  controlPin: RootPin;
  dataPin: RootPin;
  canonical: string;
  documentKey: string;
  store: MarkdownStore;
  createdIds: string[];
  nextId(prefix: string): string;
}

export async function withStoreFixture(
  run: (fixture: StoreFixture) => Promise<void>,
  fileSystem?: StoreFileSystem,
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "clasi-store-test-"));
  try {
    const controlRoot = join(temporary, "control");
    const dataRoot = join(temporary, "data");
    await createPrivateRoot(controlRoot);
    await createPrivateRoot(dataRoot);
    const controlPin = await pinRoot(controlRoot);
    const dataPin = await pinRoot(dataRoot);
    const paths = createClasiPaths({ controlRoot, dataRoot });
    let sequence = 100;
    const createdIds: string[] = [];
    const nextId = (prefix: string): string => {
      const id = opaque(prefix, sequence++);
      createdIds.push(id);
      return id;
    };
    const store = new MarkdownStore({
      controlPin,
      dataPin,
      paths,
      createId: nextId,
      now: () => NOW,
      ...(fileSystem ? { fileSystem } : {}),
    });

    await run({
      roots: { controlRoot, dataRoot },
      controlPin,
      dataPin,
      paths,
      canonical: paths.context({ type: "global", id: "global" }),
      documentKey: opaque("doc", 1),
      store,
      createdIds,
      nextId,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function contextDocument(
  revision: number,
  parentRevisionId: string | null,
  value: string,
): ClasiDocument<"context"> {
  return {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "context",
    scopeType: "global",
    scopeId: "global",
    revisionId: opaque("rev", revision),
    parentRevisionId,
    updatedAt: NOW,
    records: [
      {
        id: opaque("ctx", 1),
        logicalKey: "package-manager",
        kind: "preference",
        value,
        sourceClassification: "explicit-user-input",
        approved: true,
        priority: 80,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

export function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
