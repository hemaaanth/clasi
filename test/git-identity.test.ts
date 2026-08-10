import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createOpaqueId } from "../src/ids.ts";
import {
  GIT_COMMON_DIRECTORY_ARGS,
  GIT_ORIGIN_ARGS,
  deriveCommonDirectoryIdentity,
  identityFromOrigin,
  resolveGitIdentity,
} from "../src/git-identity.ts";
import { FakeProcessAdapter, exited } from "./support/fake-exec.ts";

describe("canonical remote identity", () => {
  test("converges HTTPS, ssh URL, and SCP-like forms without retaining transport details", () => {
    const forms = [
      "https://token:secret@GITHUB.com/PrivateOwner/CustomerProject.git/?access_token=secret#readme",
      "ssh://git@github.com/privateowner/customerproject.git",
      "git@GitHub.com:PRIVATEOWNER/CUSTOMERPROJECT.git/",
    ];

    const results = forms.map(identityFromOrigin);
    expect(results.every(result => result.ok)).toBe(true);
    const identities = results.flatMap(result => (result.ok ? [result.identity] : []));

    expect(new Set(identities.map(identity => identity.repositoryKey)).size).toBe(1);
    expect(new Set(identities.map(identity => identity.canonicalHash)).size).toBe(1);
    expect(identities[0]?.repositoryKey).toMatch(/^repo_[0-9a-f]{32}$/);
    expect(identities[0]?.canonicalHash).toMatch(/^[0-9a-f]{64}$/);

    const persisted = JSON.stringify(identities[0]);
    for (const raw of [
      "github.com",
      "privateowner",
      "customerproject",
      "token",
      "secret",
      "https",
      "ssh",
    ]) {
      expect(persisted.toLowerCase()).not.toContain(raw);
    }
  });

  test("keeps fork owner coordinates distinct", () => {
    const upstream = identityFromOrigin("https://github.com/upstream/project.git");
    const fork = identityFromOrigin("git@github.com:contributor/project.git");

    expect(upstream.ok).toBe(true);
    expect(fork.ok).toBe(true);
    if (!upstream.ok || !fork.ok) return;
    expect(upstream.identity.repositoryKey).not.toBe(fork.identity.repositoryKey);
    expect(upstream.identity.canonicalHash).not.toBe(fork.identity.canonicalHash);
  });

  test("preserves coordinates on hosts not known to be case-insensitive", () => {
    const upper = identityFromOrigin("ssh://git@git.example.test/Team/Project.git");
    const lower = identityFromOrigin("git@git.example.test:team/project.git");

    expect(upper.ok).toBe(true);
    expect(lower.ok).toBe(true);
    if (!upper.ok || !lower.ok) return;
    expect(upper.identity.repositoryKey).not.toBe(lower.identity.repositoryKey);
  });

  test("rejects unsupported or malformed origins with a bounded reason", () => {
    for (const origin of [
      "",
      "file:///home/person/repository",
      "http://github.com/owner/repository.git",
      "https://github.com/",
      "git@github.com:../repository.git",
      "https://github.com/owner/repository.git\nsecond-line",
    ]) {
      expect(identityFromOrigin(origin)).toEqual({ ok: false, code: "origin-malformed" });
    }
  });
});

describe("Git identity resolution", () => {
  test("uses fixed shell-free argument arrays and explicit cwd", async () => {
    const workingDirectory = resolve("/workspace/linked");
    const commonDirectory = resolve(workingDirectory, "../primary/.git");
    const adapter = new FakeProcessAdapter(
      exited("../primary/.git\n"),
      exited("git@github.com:Owner/Repository.git\n"),
    );
    const statPaths: string[] = [];

    const result = await resolveGitIdentity(workingDirectory, {
      adapter: adapter.run,
      stat: path => {
        statPaths.push(path);
        return { dev: 7n, ino: 42n };
      },
    });

    expect(result).toMatchObject({
      ok: true,
      kind: "remote",
      commonDirectory,
      commonDirectoryIdentity: { kind: "device-inode", device: "7", inode: "42" },
    });
    expect(statPaths).toEqual([commonDirectory]);
    expect(adapter.calls.map(call => ({ command: call.command, args: call.args, cwd: call.cwd }))).toEqual([
      { command: "git", args: GIT_COMMON_DIRECTORY_ARGS, cwd: workingDirectory },
      { command: "git", args: GIT_ORIGIN_ARGS, cwd: workingDirectory },
    ]);
    for (const call of adapter.calls) {
      expect(Object.hasOwn(call, "shell")).toBe(false);
      expect(call.env).toBeUndefined();
    }
  });

  test("separate clones converge through the remote key", async () => {
    const first = new FakeProcessAdapter(
      exited(".git\n"),
      exited("https://github.com/Owner/Repository.git\n"),
    );
    const second = new FakeProcessAdapter(
      exited(".git\n"),
      exited("git@github.com:owner/repository.git\n"),
    );

    const [left, right] = await Promise.all([
      resolveGitIdentity("/clones/one", {
        adapter: first.run,
        stat: () => ({ dev: 1n, ino: 11n }),
      }),
      resolveGitIdentity("/other/clone", {
        adapter: second.run,
        stat: () => ({ dev: 2n, ino: 22n }),
      }),
    ]);

    expect(left.ok && left.kind === "remote").toBe(true);
    expect(right.ok && right.kind === "remote").toBe(true);
    if (!left.ok || left.kind !== "remote" || !right.ok || right.kind !== "remote") return;
    expect(left.repository.repositoryKey).toBe(right.repository.repositoryKey);
    expect(left.commonDirectoryIdentity).not.toEqual(right.commonDirectoryIdentity);
  });

  test("linked worktrees share common-directory identity", async () => {
    const primary = new FakeProcessAdapter(exited(".git\n"), exited("", 1));
    const linked = new FakeProcessAdapter(exited("../primary/.git\n"), exited("", 1));
    const stat = (path: string) => {
      expect(path).toBe("/work/primary/.git");
      return { dev: 9n, ino: 99n };
    };

    const [first, second] = await Promise.all([
      resolveGitIdentity("/work/primary", { adapter: primary.run, stat }),
      resolveGitIdentity("/work/linked", { adapter: linked.run, stat }),
    ]);

    expect(first).toMatchObject({ ok: true, kind: "no-remote" });
    expect(second).toMatchObject({ ok: true, kind: "no-remote" });
    if (!first.ok || !second.ok) return;
    expect(first.commonDirectoryIdentity).toEqual(second.commonDirectoryIdentity);
  });

  test("returns typed, distinct no-remote results without generating repository convergence", async () => {
    const first = new FakeProcessAdapter(exited(".git\n"), exited("", 1));
    const second = new FakeProcessAdapter(exited(".git\n"), exited("", 1));

    const [left, right] = await Promise.all([
      resolveGitIdentity("/local/one", {
        adapter: first.run,
        stat: () => ({ dev: 3n, ino: 31n }),
      }),
      resolveGitIdentity("/local/two", {
        adapter: second.run,
        stat: () => ({ dev: 3n, ino: 32n }),
      }),
    ]);

    expect(left).toMatchObject({ ok: true, kind: "no-remote" });
    expect(right).toMatchObject({ ok: true, kind: "no-remote" });
    expect(left).not.toHaveProperty("repository");
    expect(right).not.toHaveProperty("repository");
    if (!left.ok || !right.ok) return;
    expect(left.commonDirectoryIdentity).not.toEqual(right.commonDirectoryIdentity);

    const entropy = () => new Uint8Array(16).fill(1);
    const machineId = createOpaqueId("machine", entropy);
    const futureLocalRepositoryId = createOpaqueId("repo", entropy);
    expect(machineId).toMatch(/^machine_[0-9a-f]{32}$/);
    expect(futureLocalRepositoryId).toMatch(/^repo_[0-9a-f]{32}$/);
    expect(String(machineId)).not.toBe(String(futureLocalRepositoryId));
    expect(left.kind).toBe("no-remote");
  });

  test("fails safely for command and output errors while treating only a missing origin as no-remote", async () => {
    const cases = [
      {
        adapter: new FakeProcessAdapter({ status: "spawn-failed", message: "raw failure" }),
        code: "git-unavailable",
      },
      {
        adapter: new FakeProcessAdapter(exited("", 128, "raw stderr")),
        code: "common-directory-command-failed",
      },
      {
        adapter: new FakeProcessAdapter(exited(".git\nother\n")),
        code: "common-directory-malformed",
      },
      {
        adapter: new FakeProcessAdapter(exited(".git\n"), { status: "timed-out" }),
        code: "origin-command-failed",
      },
      {
        adapter: new FakeProcessAdapter(exited(".git\n"), exited("not a remote\n")),
        code: "origin-malformed",
      },
      {
        adapter: new FakeProcessAdapter(exited(".git\n"), exited("unexpected\n", 1)),
        code: "origin-command-failed",
      },
    ] as const;

    for (const fixture of cases) {
      const result = await resolveGitIdentity("/safe/repository", {
        adapter: fixture.adapter.run,
        stat: () => ({ dev: 1n, ino: 2n }),
      });
      expect(result).toEqual({ ok: false, code: fixture.code });
      expect(JSON.stringify(result)).not.toContain("raw");
    }
  });
});

describe("persistable common-directory identity", () => {
  test("uses stable device and inode values across a same-filesystem move", async () => {
    const stat = () => ({ dev: 2_049n, ino: 8_192n });
    const before = await deriveCommonDirectoryIdentity("/home/private/project/.git", stat);
    const after = await deriveCommonDirectoryIdentity("/home/private/moved/.git", stat);

    expect(before).toEqual({ kind: "device-inode", device: "2049", inode: "8192" });
    expect(after).toEqual(before);
    expect(JSON.stringify(before)).not.toContain("/home/private");
  });

  test("falls back to a path hash that requires reattachment and exposes no path", async () => {
    const path = "/home/alice/private/customer/repository/.git";
    const first = await deriveCommonDirectoryIdentity(path, () => {
      throw new Error("stat denied");
    });
    const second = await deriveCommonDirectoryIdentity(path, () => ({ dev: 1n, ino: 0n }));

    for (const identity of [first, second]) {
      expect(identity).toMatchObject({ kind: "path-hash", requiresReattach: true });
      if (identity.kind !== "path-hash") continue;
      expect(identity.pathHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(identity)).not.toContain(path);
      expect(identity).not.toHaveProperty("path");
    }
    expect(first).toEqual(second);
    const moved = await deriveCommonDirectoryIdentity(`${path}-moved`, () => {
      throw new Error("stat denied");
    });
    expect(moved).not.toEqual(first);
    expect(moved).toMatchObject({ kind: "path-hash", requiresReattach: true });
  });
});
