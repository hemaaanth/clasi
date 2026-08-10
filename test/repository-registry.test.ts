import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClasiPaths } from "../src/paths.ts";
import {
  RepositoryRegistry,
  type RepositoryLocator,
} from "../src/repository-registry.ts";
import { createPrivateRoot, pinRoot } from "../src/root-safety.ts";
import { opaque } from "./support/store-fixture.ts";

const filesystem = (device: string, inode: string): RepositoryLocator => ({
  kind: "filesystem",
  device,
  inode,
});
const fallback = (pathHash: string): RepositoryLocator => ({ kind: "path-hash", pathHash });

describe("repository registry", () => {
  test("converges clones and worktrees by remote while keeping forks distinct", async () => {
    await withRegistry(async ({ registry, paths }) => {
      const upstream = opaque("repo", 1);
      const fork = opaque("repo", 2);
      const first = await registry.resolve({
        remoteRepositoryKey: upstream,
        locator: filesystem("10", "20"),
      });
      const worktree = await registry.resolve({
        remoteRepositoryKey: upstream,
        locator: filesystem("10", "20"),
      });
      const clone = await registry.resolve({
        remoteRepositoryKey: upstream,
        locator: filesystem("11", "21"),
      });
      const separateFork = await registry.resolve({
        remoteRepositoryKey: fork,
        locator: filesystem("12", "22"),
      });

      expect(first).toEqual({ status: "attached", repositoryKey: upstream, created: true });
      expect(worktree).toEqual({ status: "attached", repositoryKey: upstream, created: false });
      expect(clone).toEqual({ status: "attached", repositoryKey: upstream, created: true });
      expect(separateFork).toEqual({ status: "attached", repositoryKey: fork, created: true });
      const persisted = await readFile(paths.repositoryIndex, "utf8");
      expect(persisted).not.toContain("github.com");
      expect(persisted).not.toContain("/home/");
    });
  });

  test("keeps no-remote repositories machine-local and supports explicit move reattachment", async () => {
    await withRegistry(async ({ registry }) => {
      const first = await registry.resolve({
        remoteRepositoryKey: null,
        locator: fallback("a".repeat(64)),
      });
      const second = await registry.resolve({
        remoteRepositoryKey: null,
        locator: fallback("b".repeat(64)),
      });
      expect(first.status).toBe("attached");
      expect(second.status).toBe("attached");
      if (first.status !== "attached" || second.status !== "attached") throw new Error("attached");
      expect(first.repositoryKey).not.toBe(second.repositoryKey);

      const reattached = await registry.reattach({
        repositoryKey: first.repositoryKey,
        locator: fallback("c".repeat(64)),
      });
      expect(reattached).toEqual({ status: "attached", repositoryKey: first.repositoryKey, created: true });
      expect(await registry.resolve({
        remoteRepositoryKey: null,
        locator: fallback("c".repeat(64)),
      })).toEqual({ status: "attached", repositoryKey: first.repositoryKey, created: false });
    });
  });

  test("retains the prior attachment until a remote migration is explicit", async () => {
    await withRegistry(async ({ registry }) => {
      const oldKey = opaque("repo", 1);
      const newKey = opaque("repo", 2);
      const locator = filesystem("10", "20");
      await registry.resolve({ remoteRepositoryKey: oldKey, locator });

      expect(await registry.resolve({ remoteRepositoryKey: newKey, locator })).toEqual({
        status: "migration-required",
        repositoryKey: oldKey,
        proposedRepositoryKey: newKey,
      });
      expect(await registry.resolve({ remoteRepositoryKey: newKey, locator })).toEqual({
        status: "migration-required",
        repositoryKey: oldKey,
        proposedRepositoryKey: newKey,
      });
      expect(await registry.confirmMigration({
        locator,
        fromRepositoryKey: oldKey,
        toRepositoryKey: newKey,
      })).toEqual({ status: "attached", repositoryKey: newKey, created: false });
    });
  });

  test("serializes concurrent index updates without losing either attachment", async () => {
    await withRegistry(async ({ registry }) => {
      const [first, second] = await Promise.all([
        registry.resolve({ remoteRepositoryKey: opaque("repo", 1), locator: filesystem("1", "1") }),
        registry.resolve({ remoteRepositoryKey: opaque("repo", 2), locator: filesystem("2", "2") }),
      ]);
      expect(first.status).toBe("attached");
      expect(second.status).toBe("attached");
      expect(await registry.resolve({
        remoteRepositoryKey: opaque("repo", 1),
        locator: filesystem("1", "1"),
      })).toEqual({ status: "attached", repositoryKey: opaque("repo", 1), created: false });
      expect(await registry.resolve({
        remoteRepositoryKey: opaque("repo", 2),
        locator: filesystem("2", "2"),
      })).toEqual({ status: "attached", repositoryKey: opaque("repo", 2), created: false });
    });
  });
});

async function withRegistry(
  run: (fixture: { registry: RepositoryRegistry; paths: ReturnType<typeof createClasiPaths> }) => Promise<void>,
): Promise<void> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "clasi-registry-test-")));
  try {
    const controlRoot = join(temporary, "control");
    const dataRoot = join(temporary, "data");
    await createPrivateRoot(controlRoot);
    await createPrivateRoot(dataRoot);
    const paths = createClasiPaths({ controlRoot, dataRoot });
    let sequence = 100;
    const registry = new RepositoryRegistry({
      controlPin: await pinRoot(controlRoot),
      paths,
      createRepositoryId: () => opaque("repo", sequence++),
      now: () => "2026-08-09T12:00:00.000Z",
    });
    await run({ registry, paths });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
