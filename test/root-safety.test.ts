import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { resolveClasiRoots } from "../src/config.ts";
import { createClasiPaths, resolveWithin } from "../src/paths.ts";
import {
  RootSafetyError,
  assertRootUnchanged,
  assertSafeContainedPath,
  createPrivateRoot,
  inspectImportFile,
  readImportFileBounded,
  pinRoot,
} from "../src/root-safety.ts";
import type { RootSafetyReasonCode } from "../src/root-safety.ts";
import {
  createWindowsPrivateRoot,
  WINDOWS_OWNERSHIP_SCRIPT,
  probeWindowsRootOwnership,
} from "../src/windows-identity.ts";
import type {
  WindowsOwnershipReasonCode,
  WindowsOwnershipResult,
} from "../src/windows-identity.ts";
import { FakeProcessAdapter, exited } from "./support/fake-exec.ts";

const WINDOWS_SID = "S-1-5-21-100";
const WINDOWS_SECURITY_DESCRIPTOR =
  "O:S-1-5-21-100D:P(A;OICI;FA;;;S-1-5-21-100)";

function ownershipPayload(
  owner = WINDOWS_SID,
  securityDescriptor = WINDOWS_SECURITY_DESCRIPTOR,
): string {
  return JSON.stringify({
    current_sid: WINDOWS_SID,
    owner_sid: owner,
    security_descriptor: securityDescriptor,
  });
}

describe("two-root path layout", () => {
  test("resolves configurable shared data separately from machine control state", () => {
    const home = join(tmpdir(), "home", "tester");
    const agentDirectory = join(home, ".omp", "agent");
    const roots = resolveClasiRoots({
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      config: { dataRoot: "${HOME}/Synced/clasi" },
    });
    const paths = createClasiPaths(roots);

    expect(roots).toEqual({
      controlRoot: join(agentDirectory, "clasi"),
      dataRoot: join(home, "Synced", "clasi"),
    });
    expect(paths.context({ type: "repository", id: opaque("repo", 1) })).toBe(
      join(home, "Synced", "clasi", "scopes", "repositories", opaque("repo", 1), "context.md"),
    );
    expect(paths.machineId).toBe(join(agentDirectory, "clasi", "machine-id"));
    expect(paths.lock(opaque("doc", 1))).toBe(
      join(agentDirectory, "clasi", "locks", opaque("doc", 1)),
    );
  });

  test("CLASI_HOME wins and no data root falls back to a worktree", () => {
    expect(
      resolveClasiRoots({
        env: {
          HOME: "/home/tester",
          PI_CODING_AGENT_DIR: "/home/tester/.omp/agent",
          CLASI_HOME: "/mnt/sync/clasi",
        },
        config: { dataRoot: "${HOME}/other" },
      }).dataRoot,
    ).toBe(normalize("/mnt/sync/clasi"));
    expect(() =>
      resolveClasiRoots({
        env: { HOME: "/home/tester", PI_CODING_AGENT_DIR: "/home/tester/.omp/agent" },
      }),
    ).toThrow("setup-needed");
  });

  test("rejects absolute, parent, and separator-bearing path segments", () => {
    expect(() => resolveWithin("/safe/root", "../escape")).toThrow("path-escape");
    expect(() => resolveWithin("/safe/root", "/absolute")).toThrow("path-escape");
    expect(() => resolveWithin("/safe/root", "nested/segment")).toThrow("path-escape");
  });
});

describe("root safety", () => {
  test("pins a private root and accepts a missing contained leaf", async () => {
    await withTempDirectory(async temporary => {
      const root = join(temporary, "root");
      await createPrivateRoot(root);
      const pin = await pinRoot(root);

      await expect(
        assertSafeContainedPath(pin, join(root, "scopes", "global"), {
          kind: "directory",
          allowMissingLeaf: true,
        }),
      ).resolves.toBeUndefined();
      await expect(assertRootUnchanged(pin)).resolves.toBeUndefined();
    });
  });

  test("rechecks changed Windows roots without rejecting contained writes", async () => {
    await withTempDirectory(async temporary => {
      const root = join(temporary, "root");
      await createPrivateRoot(root);
      const adapter = new FakeProcessAdapter(
        exited(ownershipPayload()),
        exited(ownershipPayload()),
        exited(ownershipPayload(WINDOWS_SID, `${WINDOWS_SECURITY_DESCRIPTOR}(A;;FA;;;WD)`)),
      );
      const windows = { adapter: adapter.run, env: { PATH: "C:\\Windows\\System32" } };

      const pin = await pinRoot(root, { platform: "win32", windowsOwnership: windows });
      await Bun.sleep(2);
      await writeFile(join(root, "child"), "safe");
      await expect(assertRootUnchanged(pin)).resolves.toBeUndefined();
      expect(adapter.calls).toHaveLength(2);
      await Bun.sleep(2);
      await writeFile(join(root, "changed"), "changed");
      await expectSafetyFailure(assertRootUnchanged(pin), "permissions-changed");
    });
  });

  test("rejects symlinks, path escapes, insecure permissions, and root replacement", async () => {
    await withTempDirectory(async temporary => {
      const root = join(temporary, "root");
      const outside = join(temporary, "outside");
      await createPrivateRoot(root);
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(root, "linked"), "dir");
      const pin = await pinRoot(root);

      await expectSafetyFailure(
        assertSafeContainedPath(pin, join(root, "linked", "file.md"), {
          kind: "file",
          allowMissingLeaf: true,
        }),
        "symlink-component",
      );
      await expectSafetyFailure(
        assertSafeContainedPath(pin, join(temporary, "escape.md"), {
          kind: "file",
          allowMissingLeaf: true,
        }),
        "path-escape",
      );

      if (process.platform !== "win32") {
        await chmod(root, 0o755);
        await expectSafetyFailure(assertRootUnchanged(pin), "permissions-changed");
        await chmod(root, 0o700);
      }
      await rename(root, `${root}-old`);
      await mkdir(root, { mode: 0o700 });
      await expectSafetyFailure(assertRootUnchanged(pin), "root-replaced");
    });
  });

  test("rejects oversized, symlinked, and non-regular imports before reading", async () => {
    await withTempDirectory(async temporary => {
      const regular = join(temporary, "regular.md");
      const oversized = join(temporary, "oversized.md");
      const linked = join(temporary, "linked.md");
      await writeFile(regular, "safe", { mode: 0o600 });
      await writeFile(oversized, Buffer.alloc(65_537), { mode: 0o600 });
      await symlink(regular, linked, "file");

      await expect(inspectImportFile(regular)).resolves.toEqual({ size: 4 });
      expect(new TextDecoder().decode(await readImportFileBounded(regular))).toBe("safe");
      await expectSafetyFailure(inspectImportFile(oversized), "file-too-large");
      await expectSafetyFailure(inspectImportFile(linked), "symlink-component");
      await expectSafetyFailure(readImportFileBounded(oversized), "file-too-large");
      await expectSafetyFailure(readImportFileBounded(linked), "symlink-component");

      if (process.platform !== "win32") {
        const fifo = join(temporary, "pipe");
        const processResult = Bun.spawnSync(["mkfifo", fifo]);
        expect(processResult.exitCode).toBe(0);
        await expectSafetyFailure(inspectImportFile(fifo), "special-file");
      }
    });
  });
});

describe("native Windows ownership probe", () => {
  test("passes the root only through the environment and accepts matching SIDs", async () => {
    const adapter = new FakeProcessAdapter(
      exited(ownershipPayload()),
    );
    const hostileRoot = 'C:\\Users\\A\"; Remove-Item C:\\\\*; #';

    const result = await probeWindowsRootOwnership(hostileRoot, {
      adapter: adapter.run,
      env: { PATH: "C:\\Windows\\System32" },
    });

    expect(result).toEqual({
      writable: true,
      sid: WINDOWS_SID,
      securityDescriptor: WINDOWS_SECURITY_DESCRIPTOR,
    });
    expect(adapter.calls[0]?.command).toBe("powershell.exe");
    expect(adapter.calls[0]?.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_OWNERSHIP_SCRIPT,
    ]);
    expect(adapter.calls[0]?.args.join(" ")).not.toContain(hostileRoot);
    expect(adapter.calls[0]?.env).toEqual({
      PATH: "C:\\Windows\\System32",
      CLASI_ROOT_CHECK: hostileRoot,
    });
    expect(WINDOWS_OWNERSHIP_SCRIPT).toContain("[System.IO.Directory]::GetAccessControl(");
    expect(WINDOWS_OWNERSHIP_SCRIPT).not.toContain("Get-Acl");
  });

  test("creates a private root atomically with the current Windows identity", async () => {
    const adapter = new FakeProcessAdapter(
      exited(ownershipPayload()),
    );

    const result = await createWindowsPrivateRoot("C:\\safe", { adapter: adapter.run });

    expect(result).toEqual({
      writable: true,
      sid: WINDOWS_SID,
      securityDescriptor: WINDOWS_SECURITY_DESCRIPTOR,
    });
    expect(adapter.calls[0]?.args.join(" ")).toContain("Directory]::CreateDirectory");
    expect(adapter.calls[0]?.args.join(" ")).not.toContain("SetAccessControl");
    expect(adapter.calls[0]?.args.join(" ")).toContain("SetAccessRuleProtection($true, $false)");
    expect(adapter.calls[0]?.args.join(" ")).toContain("$access.IsInherited");
    expect(adapter.calls[0]?.env?.CLASI_ROOT_CHECK).toBe("C:\\safe");
  });

  test("fails closed for missing, malformed, oversized, and mismatched probes", async () => {
    const adapter = new FakeProcessAdapter(
      { status: "spawn-failed", message: "ENOENT" },
      exited("not-json"),
      exited(`"${"x".repeat(70_000)}"`),
      exited(ownershipPayload("S-1-5-21-200")),
    );

    expectOwnershipFailure(
      await probeWindowsRootOwnership("C:\\safe", { adapter: adapter.run }),
      "powershell-unavailable",
    );
    expectOwnershipFailure(
      await probeWindowsRootOwnership("C:\\safe", { adapter: adapter.run }),
      "ownership-probe-invalid",
    );
    expectOwnershipFailure(
      await probeWindowsRootOwnership("C:\\safe", { adapter: adapter.run }),
      "ownership-probe-invalid",
    );
    expectOwnershipFailure(
      await probeWindowsRootOwnership("C:\\safe", { adapter: adapter.run }),
      "owner-mismatch",
    );
  });
});

async function withTempDirectory(run: (path: string) => Promise<void>): Promise<void> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "clasi-root-test-")));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function expectSafetyFailure(
  promise: Promise<unknown>,
  code: RootSafetyReasonCode,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected root safety failure: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RootSafetyError);
    expect((error as RootSafetyError).code).toBe(code);
  }
}

function expectOwnershipFailure(
  result: WindowsOwnershipResult,
  code: WindowsOwnershipReasonCode,
): void {
  expect(result.writable).toBeFalse();
  if (result.writable) throw new Error(`Expected ${code}, received writable root`);
  expect(result.code).toBe(code);
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
