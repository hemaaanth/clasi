import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeMarkdown, encodeMarkdown } from "./markdown-codec.ts";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import { MarkdownStore, StoreError } from "./markdown-store.ts";
import type { StoreReadResult } from "./markdown-store.ts";
import type { ClasiPaths } from "./paths.ts";
import type { RepositoryLocator, RepositoryResolution } from "./repository-registry.ts";
import { RepositoryRegistry } from "./repository-registry.ts";
import {
  assertSafeContainedPath,
  hasErrorCode,
  readRegularFileBounded,
} from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";
import { MAX_DOCUMENT_BYTES } from "./schema.ts";
import type { AnyClasiDocument, ClasiDocument, MigrationRecord } from "./schema.ts";

export interface RepositoryMigrationOptions {
  dataPin: RootPin;
  paths: ClasiPaths;
  store: MarkdownStore;
  registry: RepositoryRegistry;
  now?: () => string;
  createId?: (prefix: "migration" | "rev") => string;
  afterDocument?: (targetPath: string) => void | Promise<void>;
}

export interface RepositoryMigrationInput {
  migrationId: string;
  locator: RepositoryLocator;
  fromRepositoryKey: string;
  toRepositoryKey: string;
  confirm: boolean;
}

export type RepositoryMigrationResult =
  | { status: "cancelled" }
  | { status: "target-exists"; repositoryKey: string }
  | {
      status: "migrated";
      repositoryKey: string;
      copiedDocuments: number;
      sourcePreserved: true;
      attachment: RepositoryResolution;
    };

export class RepositoryMigrationError extends Error {
  constructor(readonly code:
    | "invalid-migration"
    | "source-missing"
    | "migration-conflict"
    | "marker-conflict"
  ) {
    super(code);
    this.name = "RepositoryMigrationError";
  }
}

export class RepositoryMigration {
  readonly #dataPin: RootPin;
  readonly #paths: ClasiPaths;
  readonly #store: MarkdownStore;
  readonly #registry: RepositoryRegistry;
  readonly #now: () => string;
  readonly #createId: (prefix: "migration" | "rev") => string;
  readonly #afterDocument: ((targetPath: string) => void | Promise<void>) | undefined;

  constructor(options: RepositoryMigrationOptions) {
    this.#dataPin = options.dataPin;
    this.#paths = options.paths;
    this.#store = options.store;
    this.#registry = options.registry;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#createId = options.createId ?? (prefix => createOpaqueId(prefix));
    this.#afterDocument = options.afterDocument;
  }

  async migrate(input: RepositoryMigrationInput): Promise<RepositoryMigrationResult> {
    validateInput(input);
    if (!input.confirm) return { status: "cancelled" };

    const markerPath = this.#paths.migration(input.migrationId);
    let marker = await this.#readMarker(markerPath, input);
    const targetRoot = this.#paths.repositoryScope(input.toRepositoryKey);
    let snapshots: StoreReadResult[];
    if (!marker) {
      if (await exists(targetRoot)) {
        return { status: "target-exists", repositoryKey: input.toRepositoryKey };
      }
      const snapshotDirectory = this.#paths.migrationSnapshotDirectory(input.migrationId);
      if (await exists(snapshotDirectory)) {
        snapshots = await readMigrationSnapshots(
          this.#dataPin,
          this.#paths,
          input.migrationId,
        );
      } else {
        const sourcePaths = await discoverCanonicalDocuments(
          this.#dataPin,
          this.#paths,
          input.fromRepositoryKey,
        );
        if (sourcePaths.length === 0) throw new RepositoryMigrationError("source-missing");
        const sources: StoreReadResult[] = [];
        for (const sourcePath of sourcePaths) {
          const source = await this.#store.read(sourcePath);
          assertSourceDocument(source.document, input.fromRepositoryKey);
          sources.push(source);
        }
        if (await exists(targetRoot)) {
          return { status: "target-exists", repositoryKey: input.toRepositoryKey };
        }
        snapshots = await createMigrationSnapshots(
          this.#dataPin,
          this.#paths,
          input.migrationId,
          sources,
          this.#createId,
          this.#now,
        );
      }
      await this.#writeMarker(markerPath, input, snapshots);
      marker = await this.#readMarker(markerPath, input);
      if (!marker) throw new RepositoryMigrationError("marker-conflict");
    } else {
      if (marker.document.documentType !== "migration") {
        throw new RepositoryMigrationError("marker-conflict");
      }
      const record = marker.document.records[0];
      if (
        !record?.sourceRevisionIds.length ||
        record.sourceRevisionIds.length !== record.sourceDigests.length
      ) {
        throw new RepositoryMigrationError("marker-conflict");
      }
      snapshots = await readMigrationSnapshots(
        this.#dataPin,
        this.#paths,
        input.migrationId,
        record.sourceRevisionIds,
        record.sourceDigests,
      );
    }

    const expectedTargets = new Map<string, StoreReadResult>();
    for (const snapshot of snapshots) {
      assertSourceDocument(snapshot.document, input.fromRepositoryKey);
      const targetPath = targetPathForSnapshot(
        this.#paths,
        snapshot.document,
        input.toRepositoryKey,
      );
      if (expectedTargets.has(targetPath)) {
        throw new RepositoryMigrationError("migration-conflict");
      }
      expectedTargets.set(targetPath, snapshot);
    }

    const existingTargets = await listAllFiles(this.#dataPin, targetRoot);
    for (const targetPath of existingTargets) {
      const source = expectedTargets.get(targetPath);
      if (!source) throw new RepositoryMigrationError("migration-conflict");
      const target = await this.#store.read(targetPath);
      if (!sameMigratedDocument(source.document, target.document, input.toRepositoryKey)) {
        throw new RepositoryMigrationError("migration-conflict");
      }
    }

    let copiedDocuments = 0;
    for (const [targetPath, source] of expectedTargets) {
      if (await this.#copyDocument(source, targetPath, input.toRepositoryKey)) {
        copiedDocuments += 1;
        await this.#afterDocument?.(targetPath);
      }
    }

    const targetFiles = await listAllFiles(this.#dataPin, targetRoot);
    if (
      targetFiles.length !== expectedTargets.size ||
      targetFiles.some(path => !expectedTargets.has(path))
    ) {
      throw new RepositoryMigrationError("migration-conflict");
    }

    const currentMarker = await this.#readMarker(markerPath, input);
    if (!currentMarker || currentMarker.document.documentType !== "migration") {
      throw new RepositoryMigrationError("marker-conflict");
    }
    if (currentMarker.document.records[0]?.status !== "complete") {
      await this.#completeMarker(markerPath, currentMarker, input);
    }
    const attachment = await this.#registry.confirmMigration({
      locator: input.locator,
      fromRepositoryKey: input.fromRepositoryKey,
      toRepositoryKey: input.toRepositoryKey,
    });
    return {
      status: "migrated",
      repositoryKey: input.toRepositoryKey,
      copiedDocuments,
      sourcePreserved: true,
      attachment,
    };
  }

  async #copyDocument(
    source: StoreReadResult,
    targetPath: string,
    toRepositoryKey: string,
  ): Promise<boolean> {
    try {
      const target = await this.#store.read(targetPath);
      if (!sameMigratedDocument(source.document, target.document, toRepositoryKey)) {
        throw new RepositoryMigrationError("migration-conflict");
      }
      return false;
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== "canonical-missing") throw error;
    }

    const candidate = {
      ...source.document,
      scopeId: toRepositoryKey,
      revisionId: this.#createId("rev"),
      parentRevisionId: null,
      updatedAt: this.#now(),
    } as AnyClasiDocument;
    const result = await this.#store.write({
      canonicalPath: targetPath,
      documentKey: stableDocumentKey(targetPath),
      expected: { kind: "absent" },
      candidate,
    });
    if (result.status !== "committed") throw new RepositoryMigrationError("migration-conflict");
    return true;
  }

  async #readMarker(
    markerPath: string,
    input: RepositoryMigrationInput,
  ): Promise<StoreReadResult | undefined> {
    try {
      const marker = await this.#store.read(markerPath);
      if (
        marker.document.documentType !== "migration" ||
        marker.document.records.length !== 1 ||
        marker.document.records[0]?.id !== input.migrationId ||
        marker.document.records[0]?.fromScopeId !== input.fromRepositoryKey ||
        marker.document.records[0]?.toScopeId !== input.toRepositoryKey
      ) {
        throw new RepositoryMigrationError("marker-conflict");
      }
      return marker;
    } catch (error) {
      if (error instanceof StoreError && error.code === "canonical-missing") return undefined;
      throw error;
    }
  }

  async #writeMarker(
    markerPath: string,
    input: RepositoryMigrationInput,
    snapshots: StoreReadResult[],
  ): Promise<void> {
    const now = this.#now();
    const record: MigrationRecord = {
      id: input.migrationId,
      fromScopeId: input.fromRepositoryKey,
      toScopeId: input.toRepositoryKey,
      sourceRevisionIds: snapshots.map(snapshot => snapshot.document.revisionId),
      sourceDigests: snapshots.map(snapshot => snapshot.digest),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const document: ClasiDocument<"migration"> = {
      schemaVersion: 1,
      documentType: "migration",
      scopeType: "repository",
      scopeId: input.fromRepositoryKey,
      revisionId: this.#createId("rev"),
      parentRevisionId: null,
      updatedAt: now,
      records: [record],
    };
    const result = await this.#store.write({
      canonicalPath: markerPath,
      documentKey: stableDocumentKey(markerPath),
      expected: { kind: "absent" },
      candidate: document,
    });
    if (result.status !== "committed") throw new RepositoryMigrationError("marker-conflict");
  }

  async #completeMarker(
    markerPath: string,
    current: StoreReadResult,
    input: RepositoryMigrationInput,
  ): Promise<void> {
    if (current.document.documentType !== "migration") {
      throw new RepositoryMigrationError("marker-conflict");
    }
    const now = this.#now();
    const record = current.document.records[0];
    if (!record) throw new RepositoryMigrationError("marker-conflict");
    const document: ClasiDocument<"migration"> = {
      ...current.document,
      revisionId: this.#createId("rev"),
      parentRevisionId: current.document.revisionId,
      updatedAt: now,
      records: [{ ...record, status: "complete", updatedAt: now }],
    };
    const result = await this.#store.write({
      canonicalPath: markerPath,
      documentKey: stableDocumentKey(markerPath),
      expected: {
        kind: "revision",
        revisionId: current.document.revisionId,
        digest: current.digest,
      },
      candidate: document,
    });
    if (result.status !== "committed") throw new RepositoryMigrationError("marker-conflict");
  }
}

async function discoverCanonicalDocuments(
  dataPin: RootPin,
  paths: ClasiPaths,
  repositoryKey: string,
): Promise<string[]> {
  const scope = { type: "repository" as const, id: repositoryKey };
  const candidates: string[] = [];
  for (const path of [paths.context(scope), paths.napkin(scope)]) {
    if (await exists(path)) candidates.push(path);
  }
  await appendOpaqueDocuments(dataPin, join(paths.repositoryScope(repositoryKey), "proposals"), "proposal", id =>
    paths.proposal(scope, id), candidates);
  for (const lifecycle of ["open", "archive"] as const) {
    await appendOpaqueDocuments(
      dataPin,
      join(paths.repositoryScope(repositoryKey), "papercuts", lifecycle),
      "cut",
      id => paths.papercut(scope, lifecycle, id),
      candidates,
    );
  }
  return candidates.sort();
}

async function createMigrationSnapshots(
  dataPin: RootPin,
  paths: ClasiPaths,
  migrationId: string,
  sources: StoreReadResult[],
  createId: (prefix: "migration" | "rev") => string,
  now: () => string,
): Promise<StoreReadResult[]> {
  const snapshotDirectory = paths.migrationSnapshotDirectory(migrationId);
  if (await exists(snapshotDirectory)) {
    return readMigrationSnapshots(dataPin, paths, migrationId);
  }
  const parent = dirname(snapshotDirectory);
  await assertSafeContainedPath(dataPin, parent, {
    kind: "directory",
    allowMissingLeaf: true,
  });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertSafeContainedPath(dataPin, parent, { kind: "directory" });
  const temporary = `${snapshotDirectory}.${randomUUID()}.tmp`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const source of sources) {
      const snapshot = {
        ...source.document,
        revisionId: createId("rev"),
        parentRevisionId: null,
        updatedAt: now(),
      } as AnyClasiDocument;
      const markdown = encodeMarkdown(snapshot);
      await writeFile(join(temporary, `${snapshot.revisionId}.md`), markdown, {
        flag: "wx",
        mode: 0o600,
      });
    }
    try {
      await rename(temporary, snapshotDirectory);
    } catch (error) {
      if (!await exists(snapshotDirectory)) throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return readMigrationSnapshots(dataPin, paths, migrationId);
}

async function readMigrationSnapshots(
  dataPin: RootPin,
  paths: ClasiPaths,
  migrationId: string,
  expectedRevisionIds?: readonly string[],
  expectedDigests?: readonly string[],
): Promise<StoreReadResult[]> {
  const directory = paths.migrationSnapshotDirectory(migrationId);
  await assertSafeContainedPath(dataPin, directory, { kind: "directory" });
  const names = await readdir(directory);
  const discovered = names.map(name => {
    if (!name.endsWith(".md")) throw new RepositoryMigrationError("migration-conflict");
    const revisionId = name.slice(0, -3);
    if (!isOpaqueId(revisionId, "rev")) {
      throw new RepositoryMigrationError("migration-conflict");
    }
    return revisionId;
  }).sort();
  const revisionIds = expectedRevisionIds ? [...expectedRevisionIds] : discovered;
  const discoveredIds = new Set<string>(discovered);
  if (
    revisionIds.length !== discovered.length ||
    revisionIds.some(revisionId => !discoveredIds.has(revisionId)) ||
    (expectedDigests && expectedDigests.length !== revisionIds.length)
  ) {
    throw new RepositoryMigrationError("marker-conflict");
  }
  const snapshots: StoreReadResult[] = [];
  for (const [index, revisionId] of revisionIds.entries()) {
    const path = join(directory, `${revisionId}.md`);
    await assertSafeContainedPath(dataPin, path, {
      kind: "file",
      maximumBytes: MAX_DOCUMENT_BYTES,
    });
    const bytes = await readRegularFileBounded(path, MAX_DOCUMENT_BYTES);
    const document = decodeMarkdown(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (
      document.revisionId !== revisionId ||
      (expectedDigests && digest !== expectedDigests[index])
    ) {
      throw new RepositoryMigrationError("migration-conflict");
    }
    snapshots.push({ document, bytes, digest });
  }
  return snapshots;
}

function targetPathForSnapshot(
  paths: ClasiPaths,
  document: AnyClasiDocument,
  repositoryKey: string,
): string {
  const scope = { type: "repository" as const, id: repositoryKey };
  if (document.documentType === "context") return paths.context(scope);
  if (document.documentType === "napkin") return paths.napkin(scope);
  if (document.documentType === "proposal") {
    const record = document.records[0];
    if (!record || document.records.length !== 1) {
      throw new RepositoryMigrationError("migration-conflict");
    }
    return paths.proposal(scope, record.id);
  }
  if (document.documentType === "papercut") {
    const record = document.records[0];
    if (!record || document.records.length !== 1) {
      throw new RepositoryMigrationError("migration-conflict");
    }
    return paths.papercut(
      scope,
      record.lifecycle === "open" ? "open" : "archive",
      record.id,
    );
  }
  throw new RepositoryMigrationError("migration-conflict");
}

async function appendOpaqueDocuments(
  dataPin: RootPin,
  directory: string,
  prefix: "proposal" | "cut",
  resolvePath: (id: string) => string,
  output: string[],
): Promise<void> {
  let names: string[];
  try {
    await assertSafeContainedPath(dataPin, directory, { kind: "directory" });
    names = await readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) throw new RepositoryMigrationError("migration-conflict");
    const id = name.slice(0, -3);
    if (!isOpaqueId(id, prefix)) throw new RepositoryMigrationError("migration-conflict");
    const path = resolvePath(id);
    await assertSafeContainedPath(dataPin, path, { kind: "file" });
    output.push(path);
  }
}

async function listAllFiles(dataPin: RootPin, root: string): Promise<string[]> {
  if (!await exists(root)) return [];
  await assertSafeContainedPath(dataPin, root, { kind: "directory" });
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await assertSafeContainedPath(dataPin, path, { kind: "directory" });
        await visit(path);
      } else if (entry.isFile()) {
        await assertSafeContainedPath(dataPin, path, { kind: "file" });
        output.push(path);
      } else {
        throw new RepositoryMigrationError("migration-conflict");
      }
    }
  };
  await visit(root);
  return output.sort();
}

function assertSourceDocument(document: AnyClasiDocument, repositoryKey: string): void {
  if (document.scopeType !== "repository" || document.scopeId !== repositoryKey) {
    throw new RepositoryMigrationError("migration-conflict");
  }
  if (!["context", "napkin", "proposal", "papercut"].includes(document.documentType)) {
    throw new RepositoryMigrationError("migration-conflict");
  }
}

function sameMigratedDocument(
  source: AnyClasiDocument,
  target: AnyClasiDocument,
  toRepositoryKey: string,
): boolean {
  return target.documentType === source.documentType &&
    target.scopeType === "repository" &&
    target.scopeId === toRepositoryKey &&
    target.parentRevisionId === null &&
    JSON.stringify(target.records) === JSON.stringify(source.records);
}

function validateInput(input: RepositoryMigrationInput): void {
  if (
    !isOpaqueId(input.migrationId, "migration") ||
    !isOpaqueId(input.fromRepositoryKey, "repo") ||
    !isOpaqueId(input.toRepositoryKey, "repo") ||
    input.fromRepositoryKey === input.toRepositoryKey
  ) {
    throw new RepositoryMigrationError("invalid-migration");
  }
}

function stableDocumentKey(path: string): string {
  return `doc_${createHash("sha256").update(path).digest("hex").slice(0, 32)}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}
