import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_DOCUMENT_ID,
  ConfigService,
} from "../src/config-service.ts";
import { isOpaqueId } from "../src/ids.ts";
import { acquireDocumentLock } from "../src/lock.ts";
import { createClasiPaths } from "../src/paths.ts";
import { createPrivateRoot, pinRoot } from "../src/root-safety.ts";
import type { RuntimeEnvironmentReady } from "../src/runtime-environment.ts";

const INITIAL = {
  schemaVersion: 1,
  dataRoot: "${HOME}/synced/clasi",
  napkinCategoryCap: 5,
  contextCharacterCap: 6_000,
} as const;

describe("ConfigService", () => {
  test("reads the exact bounded config and exposes resolved caps", async () => {
    await withConfigFixture(async fixture => {
      const result = await new ConfigService(fixture.environment).read();

      expect(result).toEqual({
        ok: true,
        config: {
          dataRoot: fixture.environment.config.dataRoot,
          napkinCategoryCap: 5,
          contextCharacterCap: 6_000,
        },
      });
      expect(isOpaqueId(CONFIG_DOCUMENT_ID, "doc")).toBe(true);
    });
  });

  test("atomically updates either or both caps, preserves dataRoot, and notifies after commit", async () => {
    await withConfigFixture(async fixture => {
      const notifications: RuntimeEnvironmentReady["config"][] = [];
      const service = new ConfigService(fixture.environment, {
        onUpdated: config => {
          notifications.push(config);
          return readFile(fixture.environment.paths.config, "utf8").then(contents => {
            expect(JSON.parse(contents).napkinCategoryCap).toBe(config.napkinCategoryCap);
          });
        },
      });

      const first = await service.update({ napkinCategoryCap: 8, confirmed: true });
      const second = await service.update({ contextCharacterCap: 4_000, confirmed: true });

      expect(first).toEqual({
        ok: true,
        previous: {
          dataRoot: fixture.environment.config.dataRoot,
          napkinCategoryCap: 5,
          contextCharacterCap: 6_000,
        },
        config: {
          dataRoot: fixture.environment.config.dataRoot,
          napkinCategoryCap: 8,
          contextCharacterCap: 6_000,
        },
      });
      expect(second).toMatchObject({
        ok: true,
        previous: { napkinCategoryCap: 8, contextCharacterCap: 6_000 },
        config: { napkinCategoryCap: 8, contextCharacterCap: 4_000 },
      });
      expect(notifications).toHaveLength(2);

      const stored = JSON.parse(await readFile(fixture.environment.paths.config, "utf8"));
      expect(stored).toEqual({
        ...INITIAL,
        napkinCategoryCap: 8,
        contextCharacterCap: 4_000,
      });
      expect((await stat(fixture.environment.paths.config)).mode & 0o777).toBe(0o600);
    });
  });

  test("keeps a committed update successful when its observer fails", async () => {
    await withConfigFixture(async fixture => {
      const service = new ConfigService(fixture.environment, {
        onUpdated: () => {
          throw new Error("observer failed");
        },
      });

      const result = await service.update({ napkinCategoryCap: 7, confirmed: true });

      expect(result).toMatchObject({
        ok: true,
        previous: { napkinCategoryCap: 5 },
        config: { napkinCategoryCap: 7 },
      });
      const stored = JSON.parse(await readFile(fixture.environment.paths.config, "utf8"));
      expect(stored.napkinCategoryCap).toBe(7);
    });
  });

  test("rejects missing confirmation, invalid ranges, empty updates, and unchanged values", async () => {
    await withConfigFixture(async fixture => {
      let notifications = 0;
      const service = new ConfigService(fixture.environment, {
        onUpdated: () => {
          notifications += 1;
        },
      });
      const before = await readFile(fixture.environment.paths.config, "utf8");

      expect(await service.update({ napkinCategoryCap: 7, confirmed: false })).toEqual({
        ok: false,
        code: "confirmation-required",
      });
      expect(await service.update({ confirmed: true })).toEqual({
        ok: false,
        code: "invalid-input",
      });
      expect(await service.update({ napkinCategoryCap: 0, confirmed: true })).toEqual({
        ok: false,
        code: "invalid-input",
      });
      expect(await service.update({ contextCharacterCap: 6_001, confirmed: true })).toEqual({
        ok: false,
        code: "invalid-input",
      });
      expect(await service.update({
        napkinCategoryCap: 5,
        contextCharacterCap: 6_000,
        confirmed: true,
      })).toEqual({ ok: false, code: "no-change" });

      expect(await readFile(fixture.environment.paths.config, "utf8")).toBe(before);
      expect(notifications).toBe(0);
    });
  });

  test("detects a manual config change after staging and never overwrites it", async () => {
    await withConfigFixture(async fixture => {
      const manual = {
        ...INITIAL,
        napkinCategoryCap: 9,
      };
      const manualText = `${JSON.stringify(manual, null, 2)}\n`;
      const service = new ConfigService(fixture.environment, {
        beforeDigestRevalidation: () => writeFile(
          fixture.environment.paths.config,
          manualText,
          { mode: 0o600 },
        ),
      });

      expect(await service.update({ napkinCategoryCap: 8, confirmed: true })).toEqual({
        ok: false,
        code: "write-conflict",
      });
      expect(await readFile(fixture.environment.paths.config, "utf8")).toBe(manualText);
    });
  });

  test("uses the stable config lock and returns bounded lock and config failures", async () => {
    await withConfigFixture(async fixture => {
      const lock = await acquireDocumentLock(fixture.environment.paths.lock(CONFIG_DOCUMENT_ID), {
        ownerToken: "test-owner",
        pid: process.pid,
        processIdentity: "test-process",
        startedAt: "2026-08-09T12:00:00.000Z",
      });
      try {
        expect(await new ConfigService(fixture.environment).update({
          napkinCategoryCap: 7,
          confirmed: true,
        })).toEqual({ ok: false, code: "lock-held" });
      } finally {
        await lock.release();
      }

      await writeFile(fixture.environment.paths.config, "not-json", { mode: 0o600 });
      const result = await new ConfigService(fixture.environment).read();
      expect(result).toEqual({ ok: false, code: "invalid-config" });
      expect(JSON.stringify(result)).not.toContain(fixture.root);
      expect(JSON.stringify(result)).not.toContain("not-json");
    });
  });

  test("rejects changed control-root safety without writing", async () => {
    await withConfigFixture(async fixture => {
      await chmod(fixture.environment.roots.controlRoot, 0o755);
      const result = await new ConfigService(fixture.environment).update({
        napkinCategoryCap: 7,
        confirmed: true,
      });

      expect(result).toEqual({ ok: false, code: "unsafe-control-root" });
    });
  });
});

interface ConfigFixture {
  root: string;
  environment: RuntimeEnvironmentReady;
}

async function withConfigFixture(run: (fixture: ConfigFixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clasi-config-service-")));
  try {
    const controlRoot = join(root, "control");
    const dataRoot = join(root, "data");
    await createPrivateRoot(controlRoot);
    await createPrivateRoot(dataRoot);
    const roots = { controlRoot, dataRoot };
    const paths = createClasiPaths(roots);
    await writeFile(paths.config, `${JSON.stringify(INITIAL, null, 2)}\n`, { mode: 0o600 });
    const controlPin = await pinRoot(controlRoot);
    const dataPin = await pinRoot(dataRoot);
    const environment = {
      status: "ready",
      config: {
        dataRoot,
        napkinCategoryCap: INITIAL.napkinCategoryCap,
        contextCharacterCap: INITIAL.contextCharacterCap,
      },
      roots,
      controlPin,
      dataPin,
      paths,
      store: {} as RuntimeEnvironmentReady["store"],
      machineId: `machine_${"1".repeat(32)}`,
      scopes: [{ type: "global", id: "global" }],
      capabilities: { repositoryScope: "not-repository", requiresReattachOnMove: false },
      degradations: [],
    } satisfies RuntimeEnvironmentReady;
    await run({ root, environment });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
