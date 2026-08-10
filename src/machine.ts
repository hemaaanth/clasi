import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname } from "node:path";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { OpaqueId } from "./ids.ts";
import type { ClasiPaths } from "./paths.ts";
import { assertRootUnchanged, assertSafeContainedPath, hasErrorCode } from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";

export type OsBoundary = "linux" | "macos" | "windows";
export type MachineArchitecture =
  | "x64"
  | "arm64"
  | "arm32"
  | "x86"
  | "riscv64"
  | "s390x"
  | "ppc64";
export type WslStatus = "none" | "wsl1" | "wsl2";
export type FilesystemConvention = "posix" | "windows";
export type CpuBucket = "1-2" | "3-4" | "5-8" | "9-16" | "17-plus";
export type MemoryBucket =
  | "under-4-gib"
  | "4-7-gib"
  | "8-15-gib"
  | "16-31-gib"
  | "32-63-gib"
  | "64-plus-gib";

export const TOOL_MANAGERS = [
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "corepack",
  "nvm",
  "fnm",
  "volta",
  "asdf",
  "mise",
  "sdkman",
  "nodenv",
  "homebrew",
  "chocolatey",
  "scoop",
] as const;
export type ToolManager = (typeof TOOL_MANAGERS)[number];

const SHELL_FAMILY_BY_BASENAME = {
  sh: "bourne",
  ash: "bourne",
  bash: "bourne",
  dash: "bourne",
  ksh: "bourne",
  zsh: "bourne",
  csh: "csh",
  tcsh: "csh",
  fish: "fish",
  elvish: "elvish",
  nu: "nushell",
  nushell: "nushell",
  pwsh: "powershell",
  powershell: "powershell",
  cmd: "cmd",
} as const;

export type ShellBasename = keyof typeof SHELL_FAMILY_BY_BASENAME;
export type ShellFamily = (typeof SHELL_FAMILY_BY_BASENAME)[ShellBasename];

export interface SafeShellFact {
  readonly basename: ShellBasename;
  readonly family: ShellFamily;
}

export interface MachineFacts {
  readonly osBoundary?: OsBoundary;
  readonly architecture?: MachineArchitecture;
  readonly wsl: WslStatus;
  readonly container: boolean;
  readonly shell?: SafeShellFact;
  readonly toolManagers: readonly ToolManager[];
  readonly filesystemConvention?: FilesystemConvention;
  readonly cpuBucket?: CpuBucket;
  readonly memoryBucket?: MemoryBucket;
}

export interface MachineFactInput {
  readonly platform: string;
  readonly architecture: string;
  readonly osRelease?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly shell?: string;
  readonly toolManagerCandidates?: readonly string[];
  readonly cgroup?: string;
  readonly containerMarker?: boolean;
  readonly logicalCpuCount?: number;
  readonly totalMemoryBytes?: number;
}

export interface MachineIdFileSystem {
  read(path: string): Promise<string>;
  mkdirParent(path: string): Promise<void>;
  writeExclusive(path: string, content: string): Promise<void>;
}

export const NODE_MACHINE_ID_FILE_SYSTEM: MachineIdFileSystem = {
  read: path => readFile(path, "utf8"),
  mkdirParent: async path => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  },
  writeExclusive: async (path, content) => {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
  },
};

export type MachineIdentityReasonCode = "invalid-machine-id" | "machine-id-unavailable";

export class MachineIdentityError extends Error {
  constructor(readonly code: MachineIdentityReasonCode) {
    super(code);
    this.name = "MachineIdentityError";
  }
}

export interface ReadOrCreateMachineIdOptions {
  readonly entropy?: (size: number) => Uint8Array;
  readonly fileSystem?: MachineIdFileSystem;
  readonly controlPin?: RootPin;
}

export async function readOrCreateMachineId(
  paths: Pick<ClasiPaths, "machineId">,
  options: ReadOrCreateMachineIdOptions = {},
): Promise<OpaqueId<"machine">> {
  const fileSystem = options.fileSystem ?? NODE_MACHINE_ID_FILE_SYSTEM;
  if (options.controlPin) {
    await assertSafeContainedPath(options.controlPin, paths.machineId, {
      kind: "file",
      allowMissingLeaf: true,
      maximumBytes: 42,
    });
  }
  const existing = await readMachineId(paths.machineId, fileSystem);
  if (existing !== undefined) return existing;

  const candidate = createOpaqueId("machine", options.entropy);
  try {
    if (options.controlPin) await assertRootUnchanged(options.controlPin);
    await fileSystem.mkdirParent(paths.machineId);
    if (options.controlPin) {
      await assertSafeContainedPath(options.controlPin, paths.machineId, {
        kind: "file",
        allowMissingLeaf: true,
        maximumBytes: 42,
      });
    }
    await fileSystem.writeExclusive(paths.machineId, `${candidate}\n`);
    return candidate;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      const winner = await readMachineId(paths.machineId, fileSystem);
      if (winner !== undefined) return winner;
    }
    if (error instanceof MachineIdentityError) throw error;
    throw new MachineIdentityError("machine-id-unavailable");
  }
}

export function detectMachineFacts(input: MachineFactInput): MachineFacts {
  const environment = input.environment ?? {};
  const osBoundary = input.platform.length <= 16
    ? OS_BOUNDARY_BY_PLATFORM[input.platform.toLowerCase()]
    : undefined;
  const architecture = input.architecture.length <= 16
    ? ARCHITECTURE_BY_PROBE[input.architecture.toLowerCase()]
    : undefined;
  const shell = normalizeShell(input.shell ?? environment.SHELL ?? environment.ComSpec ?? environment.COMSPEC);
  const toolManagers = detectToolManagers(input.toolManagerCandidates, environment);
  const filesystemConvention = osBoundary === "windows"
    ? "windows"
    : osBoundary === "linux" || osBoundary === "macos"
      ? "posix"
      : undefined;
  const osRelease = typeof input.osRelease === "string"
    ? input.osRelease.slice(0, 256).toLowerCase()
    : "";
  const wslDetected = osBoundary === "linux" && (
    hasEnvironmentValue(environment, "WSL_DISTRO_NAME") ||
    hasEnvironmentValue(environment, "WSL_INTEROP") ||
    osRelease.includes("microsoft") ||
    osRelease.includes("wsl")
  );
  const wsl: WslStatus = !wslDetected
    ? "none"
    : osRelease.includes("wsl2") ||
        osRelease.includes("microsoft-standard") ||
        hasEnvironmentValue(environment, "WSL2_GUI_APPS_ENABLED")
      ? "wsl2"
      : "wsl1";
  const cgroup = typeof input.cgroup === "string" ? input.cgroup.slice(0, 4096).toLowerCase() : "";
  const container = input.containerMarker === true ||
    hasEnvironmentValue(environment, "container") ||
    hasEnvironmentValue(environment, "KUBERNETES_SERVICE_HOST") ||
    /(?:docker|containerd|kubepods|lxc|podman)/.test(cgroup);
  const cpuBucket = bucketCpu(input.logicalCpuCount);
  const memoryBucket = bucketMemory(input.totalMemoryBytes);

  return {
    ...(osBoundary === undefined ? {} : { osBoundary }),
    ...(architecture === undefined ? {} : { architecture }),
    wsl,
    container,
    ...(shell === undefined ? {} : { shell }),
    toolManagers,
    ...(filesystemConvention === undefined ? {} : { filesystemConvention }),
    ...(cpuBucket === undefined ? {} : { cpuBucket }),
    ...(memoryBucket === undefined ? {} : { memoryBucket }),
  };
}

export async function detectCurrentMachineFacts(): Promise<MachineFacts> {
  const [dockerMarker, containerMarker, cgroup] = await Promise.all([
    fixedPathExists("/.dockerenv"),
    fixedPathExists("/run/.containerenv"),
    readFixedSystemText("/proc/1/cgroup"),
  ]);
  return detectMachineFacts({
    platform: platform(),
    architecture: arch(),
    osRelease: release(),
    environment: process.env,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    containerMarker: dockerMarker || containerMarker,
    ...(cgroup === undefined ? {} : { cgroup }),
  });
}

const OS_BOUNDARY_BY_PLATFORM: Readonly<Record<string, OsBoundary>> = {
  linux: "linux",
  darwin: "macos",
  win32: "windows",
};

const ARCHITECTURE_BY_PROBE: Readonly<Record<string, MachineArchitecture>> = {
  x64: "x64",
  amd64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
  arm: "arm32",
  armv7l: "arm32",
  ia32: "x86",
  x86: "x86",
  riscv64: "riscv64",
  s390x: "s390x",
  ppc64: "ppc64",
};

const TOOL_MANAGER_BY_ENVIRONMENT_KEY: Readonly<Record<string, ToolManager>> = {
  BUN_INSTALL: "bun",
  PNPM_HOME: "pnpm",
  COREPACK_HOME: "corepack",
  NVM_DIR: "nvm",
  FNM_DIR: "fnm",
  FNM_MULTISHELL_PATH: "fnm",
  VOLTA_HOME: "volta",
  ASDF_DIR: "asdf",
  ASDF_DATA_DIR: "asdf",
  MISE_DATA_DIR: "mise",
  MISE_CONFIG_DIR: "mise",
  MISE_SHELL: "mise",
  SDKMAN_DIR: "sdkman",
  NODENV_ROOT: "nodenv",
  HOMEBREW_PREFIX: "homebrew",
  HOMEBREW_CELLAR: "homebrew",
  ChocolateyInstall: "chocolatey",
  SCOOP: "scoop",
};

async function readMachineId(
  path: string,
  fileSystem: MachineIdFileSystem,
): Promise<OpaqueId<"machine"> | undefined> {
  let content: string;
  try {
    content = await fileSystem.read(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new MachineIdentityError("machine-id-unavailable");
  }

  if (content.length > 42) throw new MachineIdentityError("invalid-machine-id");
  const value = content.endsWith("\r\n")
    ? content.slice(0, -2)
    : content.endsWith("\n")
      ? content.slice(0, -1)
      : content;
  if (!isOpaqueId(value, "machine")) throw new MachineIdentityError("invalid-machine-id");
  return value as OpaqueId<"machine">;
}

function normalizeShell(value: string | undefined): SafeShellFact | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
  const basenameWithExtension = value.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!basenameWithExtension) return undefined;
  const basename = basenameWithExtension.endsWith(".exe")
    ? basenameWithExtension.slice(0, -4)
    : basenameWithExtension;
  if (!Object.hasOwn(SHELL_FAMILY_BY_BASENAME, basename)) return undefined;
  const recognized = basename as ShellBasename;
  return { basename: recognized, family: SHELL_FAMILY_BY_BASENAME[recognized] };
}

function detectToolManagers(
  candidates: readonly string[] | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): readonly ToolManager[] {
  const detected = new Set<ToolManager>();
  for (const candidate of candidates ?? []) {
    if (typeof candidate !== "string" || candidate.length > 32) continue;
    const normalized = candidate.toLowerCase();
    const recognized = TOOL_MANAGERS.find(manager => manager === normalized);
    if (recognized !== undefined) detected.add(recognized);
  }
  for (const [key, manager] of Object.entries(TOOL_MANAGER_BY_ENVIRONMENT_KEY)) {
    if (hasEnvironmentValue(environment, key)) detected.add(manager);
  }

  const userAgent = environment.npm_config_user_agent;
  if (typeof userAgent === "string" && userAgent.length <= 256) {
    const name = userAgent.split(/[\/\s]/, 1)[0]?.toLowerCase();
    const recognized = TOOL_MANAGERS.find(manager => manager === name);
    if (recognized !== undefined) detected.add(recognized);
  }
  return TOOL_MANAGERS.filter(manager => detected.has(manager));
}

function hasEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): boolean {
  const value = environment[key];
  return typeof value === "string" && value.length > 0;
}

function bucketCpu(value: number | undefined): CpuBucket | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return undefined;
  if (value <= 2) return "1-2";
  if (value <= 4) return "3-4";
  if (value <= 8) return "5-8";
  if (value <= 16) return "9-16";
  return "17-plus";
}

function bucketMemory(value: number | undefined): MemoryBucket | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const gibibytes = value / (1024 ** 3);
  if (gibibytes < 4) return "under-4-gib";
  if (gibibytes < 8) return "4-7-gib";
  if (gibibytes < 16) return "8-15-gib";
  if (gibibytes < 32) return "16-31-gib";
  if (gibibytes < 64) return "32-63-gib";
  return "64-plus-gib";
}

async function fixedPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readFixedSystemText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).slice(0, 4096);
  } catch {
    return undefined;
  }
}
