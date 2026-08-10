import { describe, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeMarkdown, encodeMarkdown } from "../src/markdown-codec.ts";
import { NODE_STORE_FILE_SYSTEM, StoreError } from "../src/markdown-store.ts";
import type { StoreFileSystem } from "../src/markdown-store.ts";
import {
  contextDocument,
  opaque,
  withStoreFixture,
} from "./support/store-fixture.ts";

describe("lossless Markdown store", () => {
  test("creates and updates canonical Markdown with immutable revisions and last-good state", async () => {
    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      const created = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });

      expect(created.status).toBe("committed");
      const active = await fixture.store.read(fixture.canonical);
      expect(active.document).toEqual(first);
      expect(await readFile(fixture.paths.revision(fixture.documentKey, first.revisionId), "utf8"))
        .toBe(encodeMarkdown(first));
      expect((await fixture.store.readRevision(
        fixture.documentKey,
        first.revisionId,
      )).document).toEqual(first);

      const second = contextDocument(2, first.revisionId, "Use Bun for package operations.");
      const updated = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: {
          kind: "revision",
          revisionId: first.revisionId,
          digest: active.digest,
        },
        candidate: second,
      });

      expect(updated.status).toBe("committed");
      if (updated.status !== "committed") throw new Error("Expected commit");
      expect(updated.retainedQuarantine).toBeTrue();
      expect((await fixture.store.read(fixture.canonical)).document).toEqual(second);
      expect(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8"))
        .toBe(encodeMarkdown(second));
      expect(await readFile(fixture.paths.quarantine(updated.transactionId), "utf8"))
        .toBe(encodeMarkdown(first));
    });
  });

  test("preserves a divergent validated edit as a second immutable revision", async () => {
    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const read = await fixture.store.read(fixture.canonical);
      const external = contextDocument(3, first.revisionId, "Use npm for package operations.");
      await writeFile(fixture.canonical, encodeMarkdown(external), { mode: 0o600 });
      const candidate = contextDocument(2, first.revisionId, "Use Bun for package operations.");

      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: read.digest },
        candidate,
      });

      expect(result.status).toBe("conflict");
      if (result.status !== "conflict") throw new Error("Expected conflict");
      expect(result.kind).toBe("validated-revisions");
      expect(result.alternateRevisionId).toMatch(/^rev_[0-9a-f]{32}$/);
      expect(await readFile(fixture.paths.revision(fixture.documentKey, candidate.revisionId), "utf8"))
        .toBe(encodeMarkdown(candidate));
      expect(await readFile(
        fixture.paths.revision(fixture.documentKey, result.alternateRevisionId as string),
        "utf8",
      )).toContain("Use npm for package operations.");
      expect(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8"))
        .toBe(encodeMarkdown(first));
    });
  });

  test("keeps unsafe displaced bytes opaque and out of conflict metadata", async () => {
    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const read = await fixture.store.read(fixture.canonical);
      const sentinel = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
      await writeFile(fixture.canonical, sentinel, { mode: 0o600 });

      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: read.digest },
        candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
      });

      expect(result.status).toBe("conflict");
      if (result.status !== "conflict") throw new Error("Expected conflict");
      expect(result.kind).toBe("opaque-quarantine");
      expect(result.alternateRevisionId).toBeNull();
      const metadata = await readFile(fixture.paths.conflict(result.conflictId), "utf8");
      expect(metadata).not.toContain(sentinel);
      expect(metadata).not.toContain("ghp_");
      expect(await readFile(fixture.paths.quarantine(result.transactionId), "utf8")).toBe(sentinel);
    });
  });

  test("converts an opaque conflict only after stable safe revalidation into an absent path", async () => {
    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(fixture.canonical);
      await writeFile(fixture.canonical, "unsafe external bytes", { mode: 0o600 });
      const conflict = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
        candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
      });
      if (conflict.status !== "conflict") throw new Error("Expected conflict");
      const safeDisplaced = contextDocument(3, first.revisionId, "Use npm for package operations.");
      await writeFile(
        fixture.paths.quarantine(conflict.transactionId),
        encodeMarkdown(safeDisplaced),
      );
      await writeFile(fixture.canonical, "external recovery winner", { flag: "wx", mode: 0o600 });

      expect(await fixture.store.revalidateConflict({
        conflictId: conflict.conflictId,
        transactionId: conflict.transactionId,
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
      })).toEqual({ status: "opaque", code: "canonical-occupied" });

      await unlink(fixture.canonical);
      const revalidated = await fixture.store.revalidateConflict({
        conflictId: conflict.conflictId,
        transactionId: conflict.transactionId,
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
      });

      expect(revalidated.status).toBe("validated");
      if (revalidated.status !== "validated") throw new Error("Expected validation");
      const metadata = decodeMarkdown(
        await readFile(fixture.paths.conflict(conflict.conflictId)),
      );
      expect(metadata.documentType).toBe("conflict");
      if (metadata.documentType !== "conflict") throw new Error("Expected conflict document");
      expect(metadata.records[0]?.conflictKind).toBe("validated-revisions");
      expect(metadata.records[0]?.alternateRevisionId).toBe(revalidated.alternateRevisionId);
      expect(await readFile(
        fixture.paths.revision(fixture.documentKey, revalidated.alternateRevisionId),
        "utf8",
      )).toContain("Use npm for package operations.");
    });
  });

  test("leaves changing quarantine bytes opaque during revalidation", async () => {
    let armed = false;
    let quarantinePath = "";
    let quarantineReads = 0;
    const fileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      readBytes: async path => {
        const bytes = await NODE_STORE_FILE_SYSTEM.readBytes(path);
        if (armed && path === quarantinePath && ++quarantineReads === 1) {
          await writeFile(
            path,
            encodeMarkdown(contextDocument(4, opaque("rev", 1), "Use pnpm for package operations.")),
          );
        }
        return bytes;
      },
    };

    await withStoreFixture(async fixture => {
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(fixture.canonical);
      await writeFile(fixture.canonical, "unsafe external bytes", { mode: 0o600 });
      const conflict = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
        candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
      });
      if (conflict.status !== "conflict") throw new Error("Expected conflict");
      quarantinePath = fixture.paths.quarantine(conflict.transactionId);
      await writeFile(
        quarantinePath,
        encodeMarkdown(contextDocument(3, first.revisionId, "Use npm for package operations.")),
      );
      armed = true;

      expect(await fixture.store.revalidateConflict({
        conflictId: conflict.conflictId,
        transactionId: conflict.transactionId,
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
      })).toEqual({ status: "opaque", code: "revalidation-changing" });
      const metadata = await readFile(fixture.paths.conflict(conflict.conflictId), "utf8");
      expect(metadata).toContain("opaque-quarantine");
    }, fileSystem);
  });

  test("never replaces an occupied first-create destination", async () => {
    await withStoreFixture(async fixture => {
      await mkdir(dirname(fixture.canonical), { recursive: true, mode: 0o700 });
      await writeFile(fixture.canonical, "external bytes", { mode: 0o600 });

      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: contextDocument(1, null, "Prefer Bun for package operations."),
      });

      expect(result.status).toBe("conflict");
      expect(await readFile(fixture.canonical, "utf8")).toBe("external bytes");
    });
  });

  test("revalidates a safe occupied canonical without activating or overwriting it", async () => {
    await withStoreFixture(async fixture => {
      const external = contextDocument(3, opaque("rev", 99), "Use npm for package operations.");
      const externalMarkdown = encodeMarkdown(external);
      await mkdir(dirname(fixture.canonical), { recursive: true, mode: 0o700 });
      await writeFile(fixture.canonical, externalMarkdown, { mode: 0o600 });
      const result = await fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: contextDocument(1, null, "Prefer Bun for package operations."),
      });
      if (result.status !== "conflict") throw new Error("Expected conflict");

      const revalidated = await fixture.store.revalidateConflict({
        conflictId: result.conflictId,
        transactionId: result.transactionId,
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
      });

      expect(revalidated.status).toBe("validated");
      if (revalidated.status !== "validated") throw new Error("Expected validation");
      expect(await readFile(fixture.canonical, "utf8")).toBe(externalMarkdown);
      const preserved = decodeMarkdown(await readFile(
        fixture.paths.revision(fixture.documentKey, revalidated.alternateRevisionId),
      ));
      expect(preserved.revisionId).toBe(revalidated.alternateRevisionId);
      expect(preserved.parentRevisionId).toBeNull();
      expect(preserved.records).toEqual(external.records);
      const metadata = decodeMarkdown(await readFile(fixture.paths.conflict(result.conflictId)));
      expect(metadata.documentType).toBe("conflict");
      if (metadata.documentType !== "conflict") throw new Error("Expected conflict document");
      expect(metadata.records[0]?.canonicalOccupied).toBeTrue();
      expect(metadata.records[0]?.conflictKind).toBe("validated-revisions");
      expect((await fixture.store.reconcileRevisionHeads({
        documentKey: fixture.documentKey,
        canonicalPath: fixture.canonical,
      })).status).toBe("conflicts");
    });
  });

  test("removes atomic-write temporaries when replacement fails", async () => {
    let temporaryPath = "";
    let targetPath = "";
    const fileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      rename: async (oldPath, newPath) => {
        if (newPath === targetPath) {
          temporaryPath = oldPath;
          throw Object.assign(new Error("simulated rename failure"), { code: "EIO" });
        }
        await NODE_STORE_FILE_SYSTEM.rename(oldPath, newPath);
      },
    };
    await withStoreFixture(async fixture => {
      targetPath = fixture.paths.lastGood(fixture.documentKey);
      await expect(fixture.store.write({
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: contextDocument(1, null, "Prefer Bun for package operations."),
      })).rejects.toThrow("simulated rename failure");

      expect(temporaryPath).not.toBe("");
      expect(await Bun.file(temporaryPath).exists()).toBeFalse();
    }, fileSystem);
  });

  test("rejects candidate lineage mismatches before filesystem mutation", async () => {
    await withStoreFixture(async fixture => {
      await expect(
        fixture.store.write({
          canonicalPath: fixture.canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "absent" },
          candidate: contextDocument(1, opaque("rev", 9), "Prefer Bun for package operations."),
        }),
      ).rejects.toEqual(new StoreError("lineage-mismatch"));
      expect(await Bun.file(fixture.canonical).exists()).toBeFalse();
    });
  });
});
