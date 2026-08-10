import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NODE_MACHINE_ID_FILE_SYSTEM,
  detectMachineFacts,
  readOrCreateMachineId,
} from "../src/machine.ts";
import type { MachineFactInput, MachineFacts } from "../src/machine.ts";
import { createClasiPaths } from "../src/paths.ts";

const GIB = 1024 ** 3;

const MACHINE_CASES: readonly {
  name: string;
  input: MachineFactInput;
  expected: MachineFacts;
  excluded: readonly string[];
}[] = [
  {
    name: "WSL2",
    input: {
      platform: "linux",
      architecture: "x64",
      osRelease: "5.15.153.1-microsoft-standard-WSL2-private-host",
      environment: {
        SHELL: "/home/alice/private/bin/bash",
        WSL_DISTRO_NAME: "Alice-Private-Distro",
        BUN_INSTALL: "/home/alice/.bun",
        PNPM_HOME: "/home/alice/.local/share/pnpm",
        PRIVATE_ADDRESS: "192.168.10.24",
      },
      logicalCpuCount: 16,
      totalMemoryBytes: 32 * GIB,
    },
    expected: {
      osBoundary: "linux",
      architecture: "x64",
      wsl: "wsl2",
      container: false,
      shell: { basename: "bash", family: "bourne" },
      toolManagers: ["bun", "pnpm"],
      filesystemConvention: "posix",
      cpuBucket: "9-16",
      memoryBucket: "32-63-gib",
    },
    excluded: ["alice", "private-host", "Alice-Private-Distro", "/home/", "192.168.10.24"],
  },
  {
    name: "Linux container",
    input: {
      platform: "linux",
      architecture: "aarch64",
      osRelease: "6.8.0-generic",
      environment: {
        SHELL: "/usr/local/private/fish",
        VOLTA_HOME: "/workspace/private/.volta",
        container: "customer-container-name",
        HOSTNAME: "container-private-host",
      },
      cgroup: "0::/kubepods/customer-private-id",
      logicalCpuCount: 4,
      totalMemoryBytes: 8 * GIB,
    },
    expected: {
      osBoundary: "linux",
      architecture: "arm64",
      wsl: "none",
      container: true,
      shell: { basename: "fish", family: "fish" },
      toolManagers: ["volta"],
      filesystemConvention: "posix",
      cpuBucket: "3-4",
      memoryBucket: "8-15-gib",
    },
    excluded: ["customer-container-name", "container-private-host", "customer-private-id", "/workspace/"],
  },
  {
    name: "macOS",
    input: {
      platform: "darwin",
      architecture: "arm64",
      osRelease: "25.6.0",
      environment: {
        SHELL: "/Users/alice/private/zsh",
        HOMEBREW_PREFIX: "/opt/homebrew",
        USER: "alice",
      },
      logicalCpuCount: 10,
      totalMemoryBytes: 16 * GIB,
    },
    expected: {
      osBoundary: "macos",
      architecture: "arm64",
      wsl: "none",
      container: false,
      shell: { basename: "zsh", family: "bourne" },
      toolManagers: ["homebrew"],
      filesystemConvention: "posix",
      cpuBucket: "9-16",
      memoryBucket: "16-31-gib",
    },
    excluded: ["alice", "/Users/", "/opt/homebrew"],
  },
  {
    name: "native Windows",
    input: {
      platform: "win32",
      architecture: "AMD64",
      osRelease: "10.0.26100",
      environment: {
        ComSpec: "C:\\Users\\alice\\private\\cmd.exe",
        ChocolateyInstall: "C:\\ProgramData\\chocolatey",
        SCOOP: "C:\\Users\\alice\\scoop",
        USERPROFILE: "C:\\Users\\alice",
      },
      logicalCpuCount: 24,
      totalMemoryBytes: 64 * GIB,
    },
    expected: {
      osBoundary: "windows",
      architecture: "x64",
      wsl: "none",
      container: false,
      shell: { basename: "cmd", family: "cmd" },
      toolManagers: ["chocolatey", "scoop"],
      filesystemConvention: "windows",
      cpuBucket: "17-plus",
      memoryBucket: "64-plus-gib",
    },
    excluded: ["alice", "C:\\Users", "C:\\ProgramData"],
  },
  {
    name: "native Linux",
    input: {
      platform: "linux",
      architecture: "riscv64",
      osRelease: "6.12.0-generic",
      environment: {
        SHELL: "/home/carol/private/fish",
        MISE_DATA_DIR: "/home/carol/.local/share/mise",
        API_TOKEN: "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
      },
      toolManagerCandidates: ["npm", "mise", "unknown-manager", "/home/carol/bin/bun"],
      logicalCpuCount: 2,
      totalMemoryBytes: 2 * GIB,
    },
    expected: {
      osBoundary: "linux",
      architecture: "riscv64",
      wsl: "none",
      container: false,
      shell: { basename: "fish", family: "fish" },
      toolManagers: ["npm", "mise"],
      filesystemConvention: "posix",
      cpuBucket: "1-2",
      memoryBucket: "under-4-gib",
    },
    excluded: ["carol", "/home/", "unknown-manager", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"],
  },
];

describe("machine identity", () => {
  test("persists one private opaque ID per control root", async () => {
    await withTemporaryDirectory(async temporary => {
      const paths = createClasiPaths({
        controlRoot: join(temporary, "control"),
        dataRoot: join(temporary, "data"),
      });
      const first = await readOrCreateMachineId(paths, { entropy: fixedEntropy(0x11) });
      const second = await readOrCreateMachineId(paths, { entropy: fixedEntropy(0x22) });

      expect(first).toBe("machine_11111111111111111111111111111111");
      expect(second).toBe(first);
      expect(await readFile(paths.machineId, "utf8")).toBe(`${first}\n`);
      if (process.platform !== "win32") {
        expect((await stat(paths.machineId)).mode & 0o777).toBe(0o600);
      }
    });
  });

  test("creates different IDs under isolated control roots", async () => {
    await withTemporaryDirectory(async temporary => {
      const firstPaths = createClasiPaths({
        controlRoot: join(temporary, "first-control"),
        dataRoot: join(temporary, "first-data"),
      });
      const secondPaths = createClasiPaths({
        controlRoot: join(temporary, "second-control"),
        dataRoot: join(temporary, "second-data"),
      });

      const first = await readOrCreateMachineId(firstPaths, { entropy: fixedEntropy(0x33) });
      const second = await readOrCreateMachineId(secondPaths, { entropy: fixedEntropy(0x44) });

      expect(first).not.toBe(second);
    });
  });

  test("racing creators converge by rereading the exclusive winner", async () => {
    await withTemporaryDirectory(async temporary => {
      const paths = createClasiPaths({
        controlRoot: join(temporary, "control"),
        dataRoot: join(temporary, "data"),
      });
      const { promise: bothInitialReads, resolve } = Promise.withResolvers<void>();
      let initialReads = 0;
      const racingFileSystem = {
        ...NODE_MACHINE_ID_FILE_SYSTEM,
        read: async (path: string): Promise<string> => {
          if (initialReads < 2) {
            initialReads += 1;
            if (initialReads === 2) resolve();
            await bothInitialReads;
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return NODE_MACHINE_ID_FILE_SYSTEM.read(path);
        },
      };

      const [first, second] = await Promise.all([
        readOrCreateMachineId(paths, {
          entropy: fixedEntropy(0x55),
          fileSystem: racingFileSystem,
        }),
        readOrCreateMachineId(paths, {
          entropy: fixedEntropy(0x66),
          fileSystem: racingFileSystem,
        }),
      ]);

      expect(first).toBe(second);
      expect([
        "machine_55555555555555555555555555555555",
        "machine_66666666666666666666666666666666",
      ]).toContain(first);
      expect((await readFile(paths.machineId, "utf8")).trimEnd()).toBe(first);
    });
  });
});

describe("safe machine facts", () => {
  test.each([...MACHINE_CASES])("normalizes every R12 category for $name", ({ input, expected, excluded }) => {
    const facts = detectMachineFacts(input);
    const serialized = JSON.stringify(facts);

    expect(facts).toEqual(expected);
    for (const sentinel of excluded) expect(serialized).not.toContain(sentinel);
  });

  test("keeps platform fixtures meaningfully distinct", () => {
    const serialized = MACHINE_CASES.map(({ input }) => JSON.stringify(detectMachineFacts(input)));
    expect(new Set(serialized).size).toBe(MACHINE_CASES.length);
  });

  test("omits unrecognized and unsafe probe values", () => {
    expect(detectMachineFacts({
      platform: "private-os-/home/alice",
      architecture: "/home/alice/x64",
      environment: { SHELL: "/home/alice/private-shell", HOSTNAME: "private-host" },
      toolManagerCandidates: ["npm", "unknown-manager", "/home/alice/bin/bun"],
      logicalCpuCount: 0,
      totalMemoryBytes: Number.NaN,
    })).toEqual({
      wsl: "none",
      container: false,
      toolManagers: ["npm"],
    });
  });
});

function fixedEntropy(byte: number): (size: number) => Uint8Array {
  return size => new Uint8Array(size).fill(byte);
}

async function withTemporaryDirectory(run: (path: string) => Promise<void>): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "clasi-machine-test-"));
  try {
    await run(temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
