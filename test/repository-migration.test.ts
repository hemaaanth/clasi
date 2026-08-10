import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOpaqueId } from "../src/ids.ts";
import { encodeMarkdown } from "../src/markdown-codec.ts";
import { RepositoryMigration } from "../src/repository-migration.ts";
import { RepositoryRegistry } from "../src/repository-registry.ts";
import type { RepositoryLocator } from "../src/repository-registry.ts";
import type { ClasiDocument } from "../src/schema.ts";
import { withStoreFixture } from "./support/store-fixture.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const LOCATOR: RepositoryLocator = { kind: "filesystem", device: "8", inode: "101" };
const OLD_REPOSITORY = "repo_11111111111111111111111111111111";
const NEW_REPOSITORY = "repo_22222222222222222222222222222222";
const MIGRATION = "migration_33333333333333333333333333333333";

describe("explicit repository migration", () => {
  test("keeps the old attachment until confirmed migration completes", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null })).toEqual({
        status: "attached",
        repositoryKey: OLD_REPOSITORY,
        created: true,
      });
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: NEW_REPOSITORY })).toEqual({
        status: "migration-required",
        repositoryKey: OLD_REPOSITORY,
        proposedRepositoryKey: NEW_REPOSITORY,
      });
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null })).toEqual({
        status: "attached",
        repositoryKey: OLD_REPOSITORY,
        created: false,
      });
    });
  });

  test("cancel writes no marker or target and leaves the attachment unchanged", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null });
      await writeSourceDocuments(fixture, OLD_REPOSITORY);
      const migration = createMigration(fixture, registry);

      expect(await migration.migrate(migrationInput(false))).toEqual({ status: "cancelled" });
      expect(await Bun.file(fixture.paths.migration(MIGRATION)).exists()).toBe(false);
      expect(await Bun.file(fixture.paths.repositoryScope(NEW_REPOSITORY)).exists()).toBe(false);
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null })).toEqual(
        expect.objectContaining({ repositoryKey: OLD_REPOSITORY }),
      );
    });
  });

  test("retries an interrupted copy, preserves the old scope, and attaches only after completion", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null });
      await writeSourceDocuments(fixture, OLD_REPOSITORY);
      let copied = 0;
      const interrupted = createMigration(fixture, registry, async () => {
        copied += 1;
        if (copied === 1) throw new Error("simulated interruption");
      });

      await expect(interrupted.migrate(migrationInput(true))).rejects.toThrow("simulated interruption");
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null })).toEqual(
        expect.objectContaining({ repositoryKey: OLD_REPOSITORY }),
      );
      const sourceContextPath = fixture.paths.context({
        type: "repository",
        id: OLD_REPOSITORY,
      });
      await fixture.store.mutate({
        canonicalPath: sourceContextPath,
        documentKey: fixture.nextId("doc"),
        mutate: current => {
          if (!current || current.document.documentType !== "context") {
            throw new Error("Expected source context");
          }
          return {
            ...current.document,
            revisionId: fixture.nextId("rev"),
            parentRevisionId: current.document.revisionId,
            records: current.document.records.map(record => ({
              ...record,
              value: "Use npm for package operations.",
              updatedAt: NOW,
            })),
          };
        },
      });

      const retried = createMigration(fixture, registry);
      const result = await retried.migrate(migrationInput(true));
      expect(result).toEqual(expect.objectContaining({
        status: "migrated",
        repositoryKey: NEW_REPOSITORY,
        sourcePreserved: true,
      }));
      const preservedSource = await fixture.store.read(
        fixture.paths.context({ type: "repository", id: OLD_REPOSITORY }),
      );
      expect(preservedSource.document).toEqual(expect.objectContaining({ scopeId: OLD_REPOSITORY }));
      if (preservedSource.document.documentType === "context") {
        expect(preservedSource.document.records[0]?.value).toBe("Use npm for package operations.");
      }
      const migratedContext = await fixture.store.read(
        fixture.paths.context({ type: "repository", id: NEW_REPOSITORY }),
      );
      expect(migratedContext.document).toEqual(expect.objectContaining({
        scopeId: NEW_REPOSITORY,
        parentRevisionId: null,
      }));
      if (migratedContext.document.documentType === "context") {
        expect(migratedContext.document.records[0]?.value).toBe("Use Bun for package operations.");
      }
      const migratedNapkin = await fixture.store.read(
        fixture.paths.napkin({ type: "repository", id: NEW_REPOSITORY }),
      );
      expect(migratedNapkin.document.scopeId).toBe(NEW_REPOSITORY);
      const marker = await fixture.store.read(fixture.paths.migration(MIGRATION));
      expect(marker.document.documentType).toBe("migration");
      if (marker.document.documentType === "migration") {
        expect(marker.document.records[0]?.status).toBe("complete");
        expect(marker.document.records[0]?.sourceRevisionIds).toHaveLength(2);
        expect(marker.document.records[0]?.sourceDigests).toHaveLength(2);
      }
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: NEW_REPOSITORY })).toEqual({
        status: "attached",
        repositoryKey: NEW_REPOSITORY,
        created: false,
      });

      const repeated = await retried.migrate(migrationInput(true));
      expect(repeated).toEqual(expect.objectContaining({
        status: "migrated",
        copiedDocuments: 0,
      }));
    });
  });

  test("snapshots a valid manually edited canonical without prior revision bytes", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null });
      await writeSourceDocuments(fixture, OLD_REPOSITORY);
      const sourcePath = fixture.paths.context({
        type: "repository",
        id: OLD_REPOSITORY,
      });
      const current = await fixture.store.read(sourcePath);
      if (current.document.documentType !== "context") throw new Error("Expected context");
      const edited: ClasiDocument<"context"> = {
        ...current.document,
        records: current.document.records.map(record => ({
          ...record,
          value: "Use the manually selected package runner.",
          updatedAt: NOW,
        })),
      };
      await writeFile(sourcePath, encodeMarkdown(edited), { mode: 0o600 });

      const result = await createMigration(fixture, registry).migrate(migrationInput(true));
      expect(result.status).toBe("migrated");
      const target = await fixture.store.read(
        fixture.paths.context({ type: "repository", id: NEW_REPOSITORY }),
      );
      if (target.document.documentType !== "context") throw new Error("Expected context");
      expect(target.document.records[0]?.value).toBe("Use the manually selected package runner.");
      expect((await fixture.store.read(sourcePath)).document).toEqual(edited);
    });
  });

  test("detects unrelated target occupancy before writing on a marked retry", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null });
      await writeSourceDocuments(fixture, OLD_REPOSITORY);
      let interrupted = false;
      const migration = createMigration(fixture, registry, () => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      });
      await expect(migration.migrate(migrationInput(true))).rejects.toThrow(
        "simulated interruption",
      );
      const expectedTargetPaths = [
        fixture.paths.context({ type: "repository", id: NEW_REPOSITORY }),
        fixture.paths.napkin({ type: "repository", id: NEW_REPOSITORY }),
      ];
      const copiedBeforeRetry = (await Promise.all(
        expectedTargetPaths.map(path => Bun.file(path).exists()),
      )).filter(Boolean).length;
      expect(copiedBeforeRetry).toBe(1);
      const targetRoot = fixture.paths.repositoryScope(NEW_REPOSITORY);
      const unrelated = join(targetRoot, "unrelated.md");
      await writeFile(unrelated, "external", { mode: 0o600 });

      await expect(createMigration(fixture, registry).migrate(migrationInput(true)))
        .rejects.toEqual(expect.objectContaining({ code: "migration-conflict" }));
      const copiedAfterRetry = (await Promise.all(
        expectedTargetPaths.map(path => Bun.file(path).exists()),
      )).filter(Boolean).length;
      expect(copiedAfterRetry).toBe(copiedBeforeRetry);
      expect(await Bun.file(unrelated).text()).toBe("external");
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null }))
        .toEqual(expect.objectContaining({ repositoryKey: OLD_REPOSITORY }));
    });
  });

  test("refuses an existing target without a marker and leaves both scopes untouched", async () => {
    await withStoreFixture(async fixture => {
      const registry = createRegistry(fixture);
      await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null });
      await writeSourceDocuments(fixture, OLD_REPOSITORY);
      const target = fixture.paths.repositoryScope(NEW_REPOSITORY);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFile(join(target, "unrelated.md"), "external", { mode: 0o600 });

      expect(await createMigration(fixture, registry).migrate(migrationInput(true))).toEqual({
        status: "target-exists",
        repositoryKey: NEW_REPOSITORY,
      });
      expect(await Bun.file(fixture.paths.migration(MIGRATION)).exists()).toBe(false);
      expect(await registry.resolve({ locator: LOCATOR, remoteRepositoryKey: null })).toEqual(
        expect.objectContaining({ repositoryKey: OLD_REPOSITORY }),
      );
      expect(await Bun.file(join(target, "unrelated.md")).text()).toBe("external");
    });
  });
});

function createRegistry(fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0]): RepositoryRegistry {
  return new RepositoryRegistry({
    controlPin: fixture.controlPin,
    paths: fixture.paths,
    createRepositoryId: () => OLD_REPOSITORY,
    now: () => NOW,
  });
}

function createMigration(
  fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0],
  registry: RepositoryRegistry,
  afterDocument?: (targetPath: string) => void | Promise<void>,
): RepositoryMigration {
  return new RepositoryMigration({
    dataPin: fixture.dataPin,
    paths: fixture.paths,
    store: fixture.store,
    registry,
    now: () => NOW,
    createId: prefix => createOpaqueId(prefix),
    ...(afterDocument ? { afterDocument } : {}),
  });
}

function migrationInput(confirm: boolean) {
  return {
    migrationId: MIGRATION,
    locator: LOCATOR,
    fromRepositoryKey: OLD_REPOSITORY,
    toRepositoryKey: NEW_REPOSITORY,
    confirm,
  };
}

async function writeSourceDocuments(
  fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0],
  repositoryKey: string,
): Promise<void> {
  const scope = { type: "repository" as const, id: repositoryKey };
  const context: ClasiDocument<"context"> = {
    schemaVersion: 1,
    documentType: "context",
    scopeType: "repository",
    scopeId: repositoryKey,
    revisionId: fixture.nextId("rev"),
    parentRevisionId: null,
    updatedAt: NOW,
    records: [{
      id: fixture.nextId("ctx"),
      logicalKey: "repository.package-runner",
      kind: "fact",
      value: "Use Bun for package operations.",
      sourceClassification: "validated-system-state",
      approved: true,
      priority: 90,
      createdAt: NOW,
      updatedAt: NOW,
    }],
  };
  const napkin: ClasiDocument<"napkin"> = {
    schemaVersion: 1,
    documentType: "napkin",
    scopeType: "repository",
    scopeId: repositoryKey,
    revisionId: fixture.nextId("rev"),
    parentRevisionId: null,
    updatedAt: NOW,
    records: [{
      id: fixture.nextId("napkin"),
      logicalKey: "validation.focused",
      category: "Validation",
      priority: 80,
      recurrence: 1,
      hitCount: 0,
      situation: "A focused behavior changes.",
      action: "Run its focused validation before broad checks.",
      sourceClassification: "generalized-derived",
      createdAt: NOW,
      updatedAt: NOW,
    }],
  };
  for (const [path, document] of [
    [fixture.paths.context(scope), context],
    [fixture.paths.napkin(scope), napkin],
  ] as const) {
    const result = await fixture.store.write({
      canonicalPath: path,
      documentKey: fixture.nextId("doc"),
      expected: { kind: "absent" },
      candidate: document,
    });
    expect(result.status).toBe("committed");
  }
}
