import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMarkdown } from "../src/markdown-codec.ts";
import type { MachineFacts } from "../src/machine.ts";
import { commitSetup, prepareSetup, SetupError } from "../src/onboarding.ts";
import { createClasiPaths } from "../src/paths.ts";

const FACTS: MachineFacts = {
  osBoundary: "linux",
  architecture: "x64",
  wsl: "wsl2",
  container: false,
  shell: { basename: "zsh", family: "bourne" },
  toolManagers: ["bun", "mise"],
  filesystemConvention: "posix",
  cpuBucket: "5-8",
  memoryBucket: "16-31-gib",
};

const NOW = "2026-08-09T12:00:00.000Z";

describe("atomic onboarding", () => {
  test("prepares every choice in memory and cancellation writes nothing", async () => {
    await withSetupFixture(async fixture => {
      const source = join(fixture.temporary, "instructions.txt");
      await writeFile(source, "Prefer small direct changes.", "utf8");
      const plan = await prepareSetup({
        ...fixture,
        machineFacts: FACTS,
        globalPreference: {
          logicalKey: "coding.package-runner",
          value: "Prefer Bun for package operations.",
          approved: true,
        },
        imports: [{
          sourcePath: source,
          scope: "global",
          logicalKey: "import.instructions",
          summary: "Review imported direct-change guidance.",
        }],
        now: NOW,
      });

      expect(await commitSetup(plan, { confirm: false })).toEqual({ status: "cancelled" });
      expect(await Bun.file(fixture.roots.controlRoot).exists()).toBe(false);
      expect(await Bun.file(fixture.roots.dataRoot).exists()).toBe(false);
    });
  });

  test("commits safe machine facts and approved preferences before writing config last", async () => {
    await withSetupFixture(async fixture => {
      const plan = await prepareSetup({
        ...fixture,
        machineFacts: FACTS,
        globalPreference: {
          logicalKey: "coding.package-runner",
          value: "Prefer Bun for package operations.",
          approved: true,
        },
        machinePreference: {
          logicalKey: "machine.shell-usage",
          value: "Use zsh-compatible commands.",
          approved: true,
        },
        now: NOW,
      });
      const result = await commitSetup(plan, { confirm: true });
      expect(result.status).toBe("committed");
      if (result.status !== "committed") return;

      const paths = createClasiPaths(fixture.roots);
      const machine = decodeMarkdown(await readFile(
        paths.context({ type: "machine", id: result.machineId }),
      ));
      expect(machine.documentType).toBe("context");
      expect(machine.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ logicalKey: "machine.wsl", value: "wsl2", approved: true }),
        expect.objectContaining({
          logicalKey: "machine.shell-usage",
          kind: "preference",
          approved: true,
        }),
      ]));
      const global = decodeMarkdown(await readFile(paths.context({ type: "global", id: "global" })));
      expect(global.records[0]).toEqual(expect.objectContaining({
        logicalKey: "coding.package-runner",
        approved: true,
      }));
      expect(JSON.parse(await readFile(paths.config, "utf8"))).toEqual({
        schemaVersion: 1,
        dataRoot: fixture.roots.dataRoot,
        napkinCategoryCap: 5,
        contextCharacterCap: 6000,
      });
      if (process.platform !== "win32") {
        expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
      }
    });
  });

  test("requires explicit approval for personal preferences without creating roots", async () => {
    await withSetupFixture(async fixture => {
      await expect(prepareSetup({
        ...fixture,
        machineFacts: FACTS,
        globalPreference: {
          logicalKey: "coding.package-runner",
          value: "Prefer Bun for package operations.",
          approved: false,
        },
      })).rejects.toEqual(new SetupError("preference-approval-required"));
      expect(await Bun.file(fixture.roots.controlRoot).exists()).toBe(false);
    });
  });

  test("stages valid imports as proposals and reports unsafe imports without derivatives", async () => {
    await withSetupFixture(async fixture => {
      const safe = join(fixture.temporary, "safe.txt");
      const unsafe = join(fixture.temporary, "unsafe.txt");
      await writeFile(
        safe,
        "\uFEFFPrefer focused validation after each change.\r\nKeep summaries bounded.\r\n",
        "utf8",
      );
      await writeFile(unsafe, "API_KEY=secret-value-that-must-not-persist", "utf8");
      const plan = await prepareSetup({
        ...fixture,
        machineFacts: FACTS,
        imports: [
          {
            sourcePath: safe,
            scope: "machine",
            logicalKey: "import.validation",
            summary: "Review imported focused-validation guidance.",
          },
          {
            sourcePath: unsafe,
            scope: "global",
            logicalKey: "import.unsafe",
            summary: "Review unsafe imported guidance.",
          },
        ],
        now: NOW,
      });
      expect(plan.imports).toHaveLength(1);
      expect(plan.skippedImports).toEqual([{ sourcePath: unsafe, code: "raw-environment" }]);

      const result = await commitSetup(plan, { confirm: true });
      expect(result.status).toBe("committed");
      if (result.status !== "committed") return;
      const paths = createClasiPaths(fixture.roots);
      const proposal = await readFile(
        paths.proposal(
          { type: "machine", id: result.machineId },
          plan.imports[0]!.proposalId,
        ),
        "utf8",
      );
      expect(proposal).toContain("Review imported focused-validation guidance.");
      expect(proposal).not.toContain(safe);
      expect(proposal).not.toContain(unsafe);
      expect(proposal).not.toContain("secret-value");
    });
  });

  test("leaves setup inactive when a pre-config document conflicts", async () => {
    await withSetupFixture(async fixture => {
      await mkdir(fixture.roots.controlRoot, { recursive: true, mode: 0o700 });
      await mkdir(fixture.roots.dataRoot, { recursive: true, mode: 0o700 });
      const paths = createClasiPaths(fixture.roots);
      const fixedMachineId = "machine_00000000000000000000000000000000";
      await writeFile(paths.machineId, `${fixedMachineId}\n`, { mode: 0o600 });
      const contextPath = paths.context({ type: "machine", id: fixedMachineId });
      await mkdir(join(contextPath, ".."), { recursive: true, mode: 0o700 });
      await writeFile(contextPath, "not a clasi document", { mode: 0o600 });
      const plan = await prepareSetup({ ...fixture, machineFacts: FACTS, now: NOW });

      await expect(commitSetup(plan, { confirm: true })).rejects.toBeTruthy();
      expect(await Bun.file(paths.config).exists()).toBe(false);
    });
  });

  test("is idempotent after a completed setup and rejects a different configured root", async () => {
    await withSetupFixture(async fixture => {
      const plan = await prepareSetup({ ...fixture, machineFacts: FACTS, now: NOW });
      const first = await commitSetup(plan, { confirm: true });
      const second = await commitSetup(plan, { confirm: true });
      expect(first.status).toBe("committed");
      expect(second).toEqual(first);

      const changed = await prepareSetup({
        ...fixture,
        roots: { ...fixture.roots, dataRoot: join(fixture.temporary, "different-data") },
        machineFacts: FACTS,
        now: NOW,
      });
      await expect(commitSetup(changed, { confirm: true })).rejects.toEqual(
        new SetupError("setup-already-configured"),
      );
    });
  });
});

async function withSetupFixture(
  run: (fixture: {
    temporary: string;
    roots: { controlRoot: string; dataRoot: string };
    home: string;
  }) => Promise<void>,
): Promise<void> {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "clasi-onboarding-")));
  const fixture = {
    temporary,
    roots: {
      controlRoot: join(temporary, "control"),
      dataRoot: join(temporary, "data"),
    },
    home: join(temporary, "home"),
  };
  try {
    await run(fixture);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
