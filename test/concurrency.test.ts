import { describe, expect, test } from "bun:test";
import { open, readFile, writeFile } from "node:fs/promises";
import {
  LockError,
  acquireDocumentLock,
  recoverDocumentLock,
} from "../src/lock.ts";
import { NODE_STORE_FILE_SYSTEM } from "../src/markdown-store.ts";
import type { StoreFileSystem } from "../src/markdown-store.ts";
import {
  contextDocument,
  withStoreFixture,
} from "./support/store-fixture.ts";

describe("same-machine concurrency", () => {
  test("serializes writers with an owned mkdir lock and never steals it", async () => {
    await withStoreFixture(async fixture => {
      const lockPath = fixture.paths.lock(fixture.documentKey);
      const lock = await acquireDocumentLock(lockPath, {
        ownerToken: "owner-a",
        pid: 100,
        processIdentity: "process-start-a",
        startedAt: "2026-08-09T12:00:00.000Z",
      });

      await expect(
        fixture.store.write({
          canonicalPath: fixture.canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "absent" },
          candidate: contextDocument(1, null, "Prefer Bun for package operations."),
        }),
      ).rejects.toEqual(new LockError("lock-held"));

      await lock.release();
      await expect(lock.release()).resolves.toBeUndefined();
      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: contextDocument(1, null, "Prefer Bun for package operations."),
      });
      expect(result.status).toBe("committed");
    });
  });

  test("recovers a stale lock only after confirmation and a dead-owner probe", async () => {
    await withStoreFixture(async fixture => {
      const lockPath = fixture.paths.lock(fixture.documentKey);
      await acquireDocumentLock(lockPath, {
        ownerToken: "stale-owner",
        pid: 999_999,
        processIdentity: "process-start-a",
        startedAt: "2026-08-09T12:00:00.000Z",
      });

      await expect(
        recoverDocumentLock(lockPath, {
          confirm: false,
          readProcessIdentity: async () => null,
        }),
      ).rejects.toEqual(new LockError("confirmation-required"));
      await expect(
        recoverDocumentLock(lockPath, {
          confirm: true,
          readProcessIdentity: async () => "process-start-a",
        }),
      ).rejects.toEqual(new LockError("lock-owner-alive"));
      await recoverDocumentLock(lockPath, {
        confirm: true,
        readProcessIdentity: async () => "process-start-b",
      });

      const replacement = await acquireDocumentLock(lockPath, {
        ownerToken: "new-owner",
        pid: 101,
        startedAt: "2026-08-09T12:01:00.000Z",
        processIdentity: "process-start-b",
      });
      await replacement.release();
    });
  });

  test("a replacement created after displacement survives failed no-replace promotion", async () => {
    let canonicalPath = "";
    let raceArmed = false;
    const racingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      link: async (existingPath, newPath) => {
        if (raceArmed && newPath === canonicalPath) {
          await writeFile(newPath, "external replacement", { flag: "wx", mode: 0o600 });
        }
        await NODE_STORE_FILE_SYSTEM.link(existingPath, newPath);
      },
    };

    await withStoreFixture(async fixture => {
      canonicalPath = fixture.canonical;
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const read = await fixture.store.read(canonicalPath);
      raceArmed = true;

      const result = await fixture.store.write({
        canonicalPath,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: read.digest },
        candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
      });

      expect(result.status).toBe("conflict");
      expect(await readFile(canonicalPath, "utf8")).toBe("external replacement");
      if (result.status !== "conflict") throw new Error("Expected conflict");
      expect(result.kind).toBe("opaque-quarantine");
      expect(result.alternateRevisionId).toBeNull();
      expect(await fixture.store.revalidateConflict({
        conflictId: result.conflictId,
        transactionId: result.transactionId,
        canonicalPath,
        documentKey: fixture.documentKey,
      })).toEqual({ status: "opaque", code: "revalidation-unsafe" });
      expect(await readFile(fixture.paths.quarantine(result.transactionId), "utf8"))
        .toBe(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8"));
    }, racingFileSystem);
  });

  test("serializes atomic read-modify-write callbacks without losing updates", async () => {
    await withStoreFixture(async fixture => {
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: contextDocument(1, null, "0"),
      });
      let revision = 10;

      await Promise.all(Array.from({ length: 8 }, () =>
        fixture.store.mutate({
          canonicalPath: fixture.canonical,
          documentKey: fixture.documentKey,
          mutate: current => {
            if (!current || current.document.documentType !== "context") {
              throw new Error("Expected context");
            }
            const value = Number(current.document.records[0]?.value);
            return contextDocument(revision++, current.document.revisionId, String(value + 1));
          },
        })
      ));

      const current = await fixture.store.read(fixture.canonical);
      expect(current.document.documentType).toBe("context");
      if (current.document.documentType === "context") {
        expect(current.document.records[0]?.value).toBe("8");
      }
    });
  });

  test("an external descriptor can mutate only the retained quarantine inode", async () => {
    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const read = await fixture.store.read(fixture.canonical);
      const descriptor = await open(fixture.canonical, "r+");
      const second = contextDocument(2, first.revisionId, "Use Bun for package operations.");
      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: read.digest },
        candidate: second,
      });
      if (result.status !== "committed") throw new Error("Expected commit");
      const sentinel = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

      await descriptor.truncate(0);
      await descriptor.writeFile(sentinel);
      await descriptor.close();

      expect(await readFile(fixture.canonical, "utf8")).toBe(
        await readFile(fixture.paths.revision(fixture.documentKey, second.revisionId), "utf8"),
      );
      expect(await readFile(fixture.paths.quarantine(result.transactionId), "utf8")).toBe(sentinel);
      expect(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8")).not.toContain(sentinel);
    });
  });
});
