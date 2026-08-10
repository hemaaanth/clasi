import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { GitIdentityResult } from "../src/git-identity.ts";
import { readOrCreateMachineId } from "../src/machine.ts";
import { MarkdownStore } from "../src/markdown-store.ts";
import {
  resolveRuntimeEnvironment,
} from "../src/runtime-environment.ts";
import type {
  RuntimeEnvironmentReady,
  RuntimeEnvironmentResult,
  RuntimeGitIdentityResult,
} from "../src/runtime-environment.ts";
import type { ScopeRef } from "../src/paths.ts";
import { createPrivateRoot, pinRoot } from "../src/root-safety.ts";
import { opaque } from "./support/store-fixture.ts";

interface RuntimeFixture {
  temporary: string;
  home: string;
  agentRoot: string;
  controlRoot: string;
  dataRoot: string;
  env: NodeJS.ProcessEnv;
}

describe("resolveRuntimeEnvironment", () => {
  test("CLASI_HOME overrides only dataRoot and pins roots before machine identity", async () => {
    await withRuntimeFixture(async fixture => {
      await writeConfig(fixture.controlRoot, {
        schemaVersion: 1,
        dataRoot: "${HOME}/ignored-data",
        napkinCategoryCap: 2,
        contextCharacterCap: 2_400,
      });
      const events: string[] = [];
      const result = await resolveRuntimeEnvironment("/work/non-repository", {
        env: fixture.env,
        pin: async path => {
          events.push(path === fixture.controlRoot ? "control-pin" : "data-pin");
          return pinRoot(path);
        },
        machineIdentity: async (paths, controlPin) => {
          events.push("machine-id");
          return readOrCreateMachineId(paths, { controlPin });
        },
        gitIdentity: notRepository,
      });

      const environment = requireReady(result);
      expect(events).toEqual(["control-pin", "data-pin", "machine-id"]);
      expect(environment.config).toEqual({
        dataRoot: fixture.dataRoot,
        napkinCategoryCap: 2,
        contextCharacterCap: 2_400,
      });
      expect(environment.roots).toEqual({
        controlRoot: fixture.controlRoot,
        dataRoot: fixture.dataRoot,
      });
      expect(environment.store).toBeInstanceOf(MarkdownStore);
      expect(environment.machineId).toMatch(/^machine_[0-9a-f]{32}$/);
      expect(environment.scopes).toEqual([
        { type: "global", id: "global" },
        { type: "machine", id: environment.machineId },
      ]);
      expect(environment.repositoryKey).toBeUndefined();
      expect(environment.capabilities).toEqual({
        repositoryScope: "not-repository",
        requiresReattachOnMove: false,
      });
      expect(environment.degradations).toEqual([]);
    });
  });

  test("strict onboarding config supplies data root and configured caps when no override exists", async () => {
    await withRuntimeFixture(async fixture => {
      const sharedRoot = join(fixture.home, "shared-data");
      await createPrivateRoot(sharedRoot);
      await writeConfig(fixture.controlRoot, {
        schemaVersion: 1,
        dataRoot: "${HOME}/shared-data",
        napkinCategoryCap: 2,
        contextCharacterCap: 2_400,
      });
      const env = { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agentRoot };

      const environment = requireReady(await resolveRuntimeEnvironment("/work/plain", {
        env,
        gitIdentity: notRepository,
      }));

      expect(environment.config).toEqual({
        dataRoot: sharedRoot,
        napkinCategoryCap: 2,
        contextCharacterCap: 2_400,
      });
      expect(environment.paths.config).toBe(join(fixture.controlRoot, "config.json"));
    });
  });

  test("fresh homes and missing config request setup without creating a fallback root", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "clasi-runtime-fresh-"));
    try {
      const home = join(temporary, "home");
      const agentRoot = join(temporary, "agent");
      await mkdir(home, { recursive: true, mode: 0o700 });
      const fresh = await resolveRuntimeEnvironment(join(home, "work"), {
        env: { HOME: home, PI_CODING_AGENT_DIR: agentRoot },
        gitIdentity: notRepository,
      });
      expect(fresh).toEqual({ status: "setup-needed", code: "setup-needed" });
      expect(await Bun.file(join(agentRoot, "clasi")).exists()).toBe(false);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }

    await withRuntimeFixture(async fixture => {
      const env = { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agentRoot };
      expect(await resolveRuntimeEnvironment("/work/plain", {
        env,
        gitIdentity: notRepository,
      })).toEqual({ status: "setup-needed", code: "setup-needed" });
    });
  });

  test("invalid config and a missing configured data root fail with safe degraded codes", async () => {
    await withRuntimeFixture(async fixture => {
      const env = { HOME: fixture.home, PI_CODING_AGENT_DIR: fixture.agentRoot };
      await writeConfig(fixture.controlRoot, {
        schemaVersion: 1,
        dataRoot: fixture.dataRoot,
        napkinCategoryCap: 5,
        contextCharacterCap: 6_000,
        unexpected: true,
      });
      expect(await resolveRuntimeEnvironment("/work/plain", {
        env,
        gitIdentity: notRepository,
      })).toEqual({ status: "degraded", code: "invalid-config" });

      await writeFile(join(fixture.controlRoot, "config.json"), `${JSON.stringify({
        schemaVersion: 1,
        dataRoot: join(fixture.temporary, "missing-data"),
        napkinCategoryCap: 5,
        contextCharacterCap: 6_000,
      })}\n`, { mode: 0o600 });
      expect(await resolveRuntimeEnvironment("/work/plain", {
        env,
        gitIdentity: notRepository,
      })).toEqual({ status: "degraded", code: "unsafe-data-root" });
    });
  });

  test("non-Git work remains ready with only global and machine scopes", async () => {
    await withRuntimeFixture(async fixture => {
      const environment = requireReady(await resolveRuntimeEnvironment("/work/plain", {
        env: fixture.env,
        gitIdentity: notRepository,
      }));

      expect(environment.config.napkinCategoryCap).toBe(5);
      expect(environment.config.contextCharacterCap).toBe(6_000);
      expect(environment.scopes.map(scope => scope.type)).toEqual(["global", "machine"]);
      expect(environment.capabilities).toEqual({
        repositoryScope: "not-repository",
        requiresReattachOnMove: false,
      });
    });
  });

  test("linked worktrees and separate clones attach the same remote repository scope", async () => {
    await withRuntimeFixture(async fixture => {
      const repositoryKey = opaque("repo", 9);
      const gitIdentity = async (cwd: string): Promise<RuntimeGitIdentityResult> =>
        remoteGit(repositoryKey, "8", cwd === "/clone" ? "300" : "200");

      const linkedA = requireReady(await resolveRuntimeEnvironment("/linked-a", {
        env: fixture.env,
        gitIdentity,
      }));
      const linkedB = requireReady(await resolveRuntimeEnvironment("/linked-b", {
        env: fixture.env,
        gitIdentity,
      }));
      const clone = requireReady(await resolveRuntimeEnvironment("/clone", {
        env: fixture.env,
        gitIdentity,
      }));

      for (const environment of [linkedA, linkedB, clone]) {
        expect(environment.repositoryKey).toBe(repositoryKey);
        expect(environment.scopes.map(scope => scope.type)).toEqual([
          "global",
          "machine",
          "repository",
        ]);
        expect(environment.scopes[2]).toEqual({ type: "repository", id: repositoryKey });
        expect(environment.capabilities.requiresReattachOnMove).toBe(false);
      }
      const registry = await readFile(linkedA.paths.repositoryIndex, "utf8");
      expect(registry).not.toContain("/linked-a");
      expect(registry).not.toContain("/linked-b");
      expect(registry).not.toContain("/clone");
      expect(registry).not.toContain("github.com");
    });
  });

  test("path-hash fallback attaches safely and exposes explicit reattach-on-move capability", async () => {
    await withRuntimeFixture(async fixture => {
      let observedLocator: unknown;
      const result = await resolveRuntimeEnvironment("/private/repository", {
        env: fixture.env,
        gitIdentity: async () => ({
          ok: true,
          kind: "no-remote",
          commonDirectory: "/private/repository/.git",
          commonDirectoryIdentity: {
            kind: "path-hash",
            pathHash: "a".repeat(64),
            requiresReattach: true,
          },
        }),
        repositoryResolution: async observation => {
          observedLocator = observation.locator;
          return { status: "attached", repositoryKey: opaque("repo", 1), created: true };
        },
      });

      const environment = requireReady(result);
      expect(observedLocator).toEqual({ kind: "path-hash", pathHash: "a".repeat(64) });
      expect(environment.repositoryKey).toBe(opaque("repo", 1));
      expect(environment.capabilities).toEqual({
        repositoryScope: "attached",
        requiresReattachOnMove: true,
      });
    });
  });

  test("repository migration requirements retain the pinned old attachment and safe locator", async () => {
    await withRuntimeFixture(async fixture => {
      const migration = await resolveRuntimeEnvironment("/private/repository", {
        env: fixture.env,
        gitIdentity: async () => remoteGit(opaque("repo", 2), "8", "200"),
        repositoryResolution: async () => ({
          status: "migration-required",
          repositoryKey: opaque("repo", 1),
          proposedRepositoryKey: opaque("repo", 2),
        }),
      });
      expect(migration).toMatchObject({
        status: "degraded",
        code: "repository-migration-required",
        migration: {
          locator: { kind: "filesystem", device: "8", inode: "200" },
          fromRepositoryKey: opaque("repo", 1),
          toRepositoryKey: opaque("repo", 2),
          environment: {
            status: "ready",
            repositoryKey: opaque("repo", 1),
          },
        },
      });
    });
  });

  test("unsafe roots degrade without leaking cwd, roots, origin, or user data", async () => {
    await withRuntimeFixture(async fixture => {
      await chmod(fixture.dataRoot, 0o755);
      const sensitiveCwd = join(fixture.home, "customer-secret-repository");
      const result = await resolveRuntimeEnvironment(sensitiveCwd, {
        env: fixture.env,
        gitIdentity: async () => remoteGit(opaque("repo", 7), "8", "200"),
      });

      expect(result).toEqual({ status: "degraded", code: "unsafe-data-root" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(fixture.home);
      expect(serialized).not.toContain(fixture.controlRoot);
      expect(serialized).not.toContain(fixture.dataRoot);
      expect(serialized).not.toContain(sensitiveCwd);
      expect(serialized).not.toContain("customer-secret-repository");
    });
  });

  test("Git unavailability degrades only the optional repository capability", async () => {
    await withRuntimeFixture(async fixture => {
      const environment = requireReady(await resolveRuntimeEnvironment("/work/unknown", {
        env: fixture.env,
        gitIdentity: async () => ({ ok: false, code: "git-unavailable" }),
      }));

      expect(environment.scopes.map(scope => scope.type)).toEqual(["global", "machine"]);
      expect(environment.capabilities).toEqual({
        repositoryScope: "unavailable",
        requiresReattachOnMove: false,
      });
      expect(environment.degradations).toEqual(["git-unavailable"]);
    });
  });
});

async function withRuntimeFixture(run: (fixture: RuntimeFixture) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "clasi-runtime-environment-"));
  const home = join(temporary, "home");
  const agentRoot = join(temporary, "agent");
  const controlRoot = join(agentRoot, "clasi");
  const dataRoot = join(temporary, "data");
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await createPrivateRoot(controlRoot);
    await createPrivateRoot(dataRoot);
    await run({
      temporary,
      home,
      agentRoot,
      controlRoot,
      dataRoot,
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agentRoot,
        CLASI_HOME: dataRoot,
      },
    });
  } finally {
    await chmod(dataRoot, 0o700).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function writeConfig(controlRoot: string, value: unknown): Promise<void> {
  await writeFile(join(controlRoot, "config.json"), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function notRepository(): Promise<RuntimeGitIdentityResult> {
  return { ok: true, kind: "not-repository" };
}

function remoteGit(
  repositoryKey: string,
  device: string,
  inode: string,
): GitIdentityResult {
  return {
    ok: true,
    kind: "remote",
    commonDirectory: "/private/common-directory",
    commonDirectoryIdentity: { kind: "device-inode", device, inode },
    repository: {
      kind: "remote",
      repositoryKey: repositoryKey as `repo_${string}`,
      canonicalHash: "b".repeat(64),
    },
  };
}

function requireReady(result: RuntimeEnvironmentResult): RuntimeEnvironmentReady {
  if (result.status !== "ready") throw new Error(`Expected ready, received ${result.status}`);
  return result;
}
