import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { decodeMarkdown, encodeMarkdown } from "../src/markdown-codec.ts";
import { NODE_STORE_FILE_SYSTEM } from "../src/markdown-store.ts";
import type { StoreFileSystem } from "../src/markdown-store.ts";
import { contextDocument, withStoreFixture } from "./support/store-fixture.ts";

class SimulatedCrash extends Error {}

describe("transaction recovery", () => {
  test("resumes safely after displacement completed but its state update did not", async () => {
    let armed = false;
    let canonical = "";
    const crashingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      rename: async (oldPath, newPath) => {
        await NODE_STORE_FILE_SYSTEM.rename(oldPath, newPath);
        if (armed && oldPath === canonical && newPath.endsWith("displaced.md")) {
          armed = false;
          throw new SimulatedCrash("after displacement");
        }
      },
    };

    await withStoreFixture(async fixture => {
      canonical = fixture.canonical;
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(canonical);
      armed = true;
      let transactionId = "";
      try {
        await fixture.store.write({
          canonicalPath: canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
          candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
        });
        throw new Error("Expected simulated crash");
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        transactionId = fixture.createdIds.findLast(id => id.startsWith("tx_")) ?? "";
      }

      const recovered = await fixture.store.recover({
        transactionId,
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
      });

      expect(recovered.status).toBe("committed");
      expect((await fixture.store.read(canonical)).document.revisionId).toBe("rev_00000000000000000000000000000002");
      expect(await readFile(fixture.paths.quarantine(transactionId), "utf8")).toContain(
        "Prefer Bun for package operations.",
      );
    }, crashingFileSystem);
  });

  test("never promotes a staging file mutated after a crash", async () => {
    let armed = false;
    let canonical = "";
    const crashingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      rename: async (oldPath, newPath) => {
        await NODE_STORE_FILE_SYSTEM.rename(oldPath, newPath);
        if (armed && oldPath === canonical && newPath.endsWith("displaced.md")) {
          armed = false;
          throw new SimulatedCrash("after displacement");
        }
      },
    };

    await withStoreFixture(async fixture => {
      canonical = fixture.canonical;
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(canonical);
      const candidate = contextDocument(2, first.revisionId, "Use Bun for package operations.");
      armed = true;
      try {
        await fixture.store.write({
          canonicalPath: canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
          candidate,
        });
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
      }
      const transactionId = fixture.createdIds.findLast(id => id.startsWith("tx_")) ?? "";
      const stagingPath = fixture.paths.staging(canonical, candidate.revisionId);
      const sentinel = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
      await writeFile(stagingPath, sentinel);

      const recovered = await fixture.store.recover({
        transactionId,
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
      });

      expect(recovered.status).toBe("conflict");
      if (recovered.status !== "conflict") throw new Error("Expected conflict");
      expect(recovered.kind).toBe("opaque-quarantine");
      expect(recovered.reasonCode).toBe("staging-mismatch");
      expect(await Bun.file(canonical).exists()).toBeFalse();
      expect(await Bun.file(stagingPath).exists()).toBeFalse();
      expect(await readFile(fixture.paths.revision(fixture.documentKey, candidate.revisionId), "utf8"))
        .not.toContain(sentinel);
    }, crashingFileSystem);
  });

  test("recognizes a completed no-replace link after interruption", async () => {
    let armed = false;
    let canonical = "";
    const crashingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      link: async (oldPath, newPath) => {
        await NODE_STORE_FILE_SYSTEM.link(oldPath, newPath);
        if (armed && newPath === canonical) {
          armed = false;
          throw new SimulatedCrash("after promotion link");
        }
      },
    };

    await withStoreFixture(async fixture => {
      canonical = fixture.canonical;
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(canonical);
      armed = true;
      let transactionId = "";
      try {
        await fixture.store.write({
          canonicalPath: canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
          candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
        });
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
        transactionId = fixture.createdIds.findLast(id => id.startsWith("tx_")) ?? "";
      }

      const recovered = await fixture.store.recover({
        transactionId,
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
      });

      expect(recovered.status).toBe("committed");
      expect((await fixture.store.read(canonical)).document.revisionId).toBe("rev_00000000000000000000000000000002");
      expect(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8"))
        .toBe(await readFile(canonical, "utf8"));
    }, crashingFileSystem);
  });

  test("preserves a canonical path occupied during recovery and records a conflict", async () => {
    let armed = false;
    let canonical = "";
    const crashingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      rename: async (oldPath, newPath) => {
        await NODE_STORE_FILE_SYSTEM.rename(oldPath, newPath);
        if (armed && oldPath === canonical && newPath.endsWith("displaced.md")) {
          armed = false;
          throw new SimulatedCrash("after displacement");
        }
      },
    };

    await withStoreFixture(async fixture => {
      canonical = fixture.canonical;
      const first = contextDocument(1, null, "Prefer Bun for package operations.");
      await fixture.store.write({
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
        expected: { kind: "absent" },
        candidate: first,
      });
      const active = await fixture.store.read(canonical);
      armed = true;
      try {
        await fixture.store.write({
          canonicalPath: canonical,
          documentKey: fixture.documentKey,
          expected: { kind: "revision", revisionId: first.revisionId, digest: active.digest },
          candidate: contextDocument(2, first.revisionId, "Use Bun for package operations."),
        });
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error;
      }
      const transactionId = fixture.createdIds.findLast(id => id.startsWith("tx_")) ?? "";
      await writeFile(canonical, "external recovery winner", { flag: "wx", mode: 0o600 });

      const recovered = await fixture.store.recover({
        transactionId,
        canonicalPath: canonical,
        documentKey: fixture.documentKey,
      });

      expect(recovered.status).toBe("conflict");
      expect(await readFile(canonical, "utf8")).toBe("external recovery winner");
    }, crashingFileSystem);
  });

  test("activates a single validated head into a missing canonical path", async () => {
    await withStoreFixture(async fixture => {
      const base = contextDocument(1, null, "Prefer Bun for package operations.");
      const head = contextDocument(2, base.revisionId, "Use Bun for package operations.");
      for (const document of [base, head]) {
        const path = fixture.paths.revision(fixture.documentKey, document.revisionId);
        await NODE_STORE_FILE_SYSTEM.mkdirParent(path);
        await writeFile(path, encodeMarkdown(document), { flag: "wx", mode: 0o600 });
      }

      const result = await fixture.store.reconcileRevisionHeads({
        documentKey: fixture.documentKey,
        canonicalPath: fixture.canonical,
      });

      expect(result.status).toBe("activated");
      expect((await fixture.store.read(fixture.canonical)).document).toEqual(head);
      expect(await readFile(fixture.paths.lastGood(fixture.documentKey), "utf8"))
        .toBe(encodeMarkdown(head));
    });
  });

  test("preserves a replacement that wins the one-head activation race", async () => {
    let canonical = "";
    let armed = true;
    const racingFileSystem: StoreFileSystem = {
      ...NODE_STORE_FILE_SYSTEM,
      link: async (oldPath, newPath) => {
        if (armed && newPath === canonical) {
          armed = false;
          await writeFile(newPath, "external activation winner", { flag: "wx", mode: 0o600 });
        }
        await NODE_STORE_FILE_SYSTEM.link(oldPath, newPath);
      },
    };

    await withStoreFixture(async fixture => {
      canonical = fixture.canonical;
      const head = contextDocument(1, null, "Prefer Bun for package operations.");
      const revisionPath = fixture.paths.revision(fixture.documentKey, head.revisionId);
      await NODE_STORE_FILE_SYSTEM.mkdirParent(revisionPath);
      await writeFile(revisionPath, encodeMarkdown(head), { flag: "wx", mode: 0o600 });

      const result = await fixture.store.reconcileRevisionHeads({
        documentKey: fixture.documentKey,
        canonicalPath: canonical,
      });

      expect(result.status).toBe("conflicts");
      if (result.status !== "conflicts") throw new Error("Expected activation conflict");
      expect(result.conflictIds).toHaveLength(1);
      expect(await readFile(canonical, "utf8")).toBe("external activation winner");
      const conflictId = result.conflictIds[0];
      if (!conflictId) throw new Error("Expected conflict ID");
      const conflict = decodeMarkdown(await readFile(fixture.paths.conflict(conflictId)));
      expect(conflict.documentType).toBe("conflict");
      if (conflict.documentType !== "conflict") throw new Error("Expected conflict document");
      expect(conflict.records[0]?.conflictKind).toBe("opaque-quarantine");
      expect(conflict.records[0]?.alternateRevisionId).toBeNull();
    }, racingFileSystem);
  });

  test("reconciles injected revision heads into a validated conflict without choosing a winner", async () => {
    await withStoreFixture(async fixture => {
      const base = contextDocument(1, null, "Prefer Bun for package operations.");
      const left = contextDocument(2, base.revisionId, "Use Bun for package operations.");
      const right = contextDocument(3, base.revisionId, "Use npm for package operations.");
      for (const document of [base, left, right]) {
        const path = fixture.paths.revision(fixture.documentKey, document.revisionId);
        await NODE_STORE_FILE_SYSTEM.mkdirParent(path);
        await writeFile(path, encodeMarkdown(document), { flag: "wx", mode: 0o600 });
      }

      const result = await fixture.store.reconcileRevisionHeads({
        documentKey: fixture.documentKey,
        canonicalPath: fixture.canonical,
      });

      expect(result.status).toBe("conflicts");
      if (result.status !== "conflicts") throw new Error("Expected multi-head conflict");
      expect(result.heads).toEqual([left.revisionId, right.revisionId]);
      expect(result.conflictIds).toHaveLength(1);
      const conflictId = result.conflictIds[0];
      if (!conflictId) throw new Error("Expected conflict ID");
      const conflict = decodeMarkdown(
        await readFile(fixture.paths.conflict(conflictId)),
      );
      expect(conflict.documentType).toBe("conflict");
      if (conflict.documentType !== "conflict") throw new Error("Expected conflict document");
      expect(conflict.records[0]?.conflictKind).toBe("validated-revisions");
      expect(conflict.records[0]?.candidateRevisionId).toBe(left.revisionId);
      expect(conflict.records[0]?.alternateRevisionId).toBe(right.revisionId);
      expect(await Bun.file(fixture.paths.revision(fixture.documentKey, left.revisionId)).exists())
        .toBeTrue();
      expect(await Bun.file(fixture.paths.revision(fixture.documentKey, right.revisionId)).exists())
        .toBeTrue();
      expect(await Bun.file(fixture.canonical).exists()).toBeFalse();
      expect(await fixture.store.reconcileRevisionHeads({
        documentKey: fixture.documentKey,
        canonicalPath: fixture.canonical,
      })).toEqual(result);
    });
  });

  test("fails closed on malformed transaction state", async () => {
    await withStoreFixture(async fixture => {
      const transactionId = fixture.nextId("tx");
      const statePath = fixture.paths.transaction(transactionId);
      await NODE_STORE_FILE_SYSTEM.mkdirParent(statePath);
      await writeFile(statePath, "not transaction Markdown", { mode: 0o600 });

      const recovered = await fixture.store.recover({
        transactionId,
        canonicalPath: fixture.canonical,
        documentKey: fixture.documentKey,
      });

      expect(recovered).toEqual({ status: "degraded", code: "invalid-transaction-state" });
      expect(await Bun.file(fixture.canonical).exists()).toBeFalse();
    });
  });
});
