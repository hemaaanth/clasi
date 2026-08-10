import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { probeWindowsRootOwnership } from "./windows-identity.ts";
import type { WindowsOwnershipOptions } from "./windows-identity.ts";

export const MAX_IMPORT_BYTES = 65_536;

export type RootSafetyReasonCode =
  | "path-escape"
  | "root-missing"
  | "root-replaced"
  | "symlink-component"
  | "special-file"
  | "wrong-kind"
  | "file-too-large"
  | "owner-mismatch"
  | "permissions-changed"
  | "permission-denied"
  | "powershell-unavailable"
  | "ownership-probe-invalid";

export class RootSafetyError extends Error {
  constructor(readonly code: RootSafetyReasonCode) {
    super(code);
    this.name = "RootSafetyError";
  }
}

export interface RootPin {
  readonly path: string;
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly owner: string;
  readonly platform: NodeJS.Platform;
  readonly privateMode: number;
}

export interface SafePathOptions {
  kind: "file" | "directory";
  allowMissingLeaf?: boolean;
  maximumBytes?: number;
}


export interface RootSafetyOptions {
  platform?: NodeJS.Platform;
  windowsOwnership?: WindowsOwnershipOptions;
}
export async function createPrivateRoot(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new RootSafetyError("path-escape");
  await assertNoSymlinkComponents(path);
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (isPermissionError(error)) throw new RootSafetyError("permission-denied");
    throw error;
  }
  await assertNoSymlinkComponents(path);
  const stats = await safeLstat(path);
  if (!stats.isDirectory()) throw new RootSafetyError("wrong-kind");
  assertPrivateOwnership(stats.uid, stats.mode, process.platform);
}

export async function pinRoot(path: string, options: RootSafetyOptions = {}): Promise<RootPin> {
  if (!isAbsolute(path)) throw new RootSafetyError("path-escape");
  const absolute = resolve(path);
  const platform = options.platform ?? process.platform;
  await assertNoSymlinkComponents(absolute);
  const stats = await safeLstat(absolute);
  if (!stats.isDirectory()) throw new RootSafetyError("wrong-kind");
  assertPrivateOwnership(stats.uid, stats.mode, platform);
  const owner = platform === "win32"
    ? await readWindowsOwner(absolute, options.windowsOwnership)
    : String(stats.uid);

  return {
    path: absolute,
    realPath: await realpath(absolute),
    device: BigInt(stats.dev),
    inode: BigInt(stats.ino),
    owner,
    platform,
    privateMode: stats.mode & 0o777,
  };
}

export async function assertRootUnchanged(
  pin: RootPin,
  options: Pick<RootSafetyOptions, "windowsOwnership"> = {},
): Promise<void> {
  await assertNoSymlinkComponents(pin.path);
  const stats = await safeLstat(pin.path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RootSafetyError("root-replaced");
  const currentRealPath = await realpath(pin.path);
  if (
    currentRealPath !== pin.realPath ||
    BigInt(stats.dev) !== pin.device ||
    BigInt(stats.ino) !== pin.inode
  ) {
    throw new RootSafetyError("root-replaced");
  }
  if (pin.platform === "win32") {
    const owner = await readWindowsOwner(pin.path, options.windowsOwnership);
    if (owner !== pin.owner) throw new RootSafetyError("owner-mismatch");
    return;
  }
  if (String(stats.uid) !== pin.owner) throw new RootSafetyError("owner-mismatch");
  if ((stats.mode & 0o777) !== pin.privateMode) {
    throw new RootSafetyError("permissions-changed");
  }
}

export async function assertSafeContainedPath(
  pin: RootPin,
  candidate: string,
  options: SafePathOptions,
): Promise<void> {
  await assertRootUnchanged(pin);
  const absolute = resolve(candidate);
  const relation = relative(pin.path, absolute);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    if (!relation && options.kind === "directory") return;
    throw new RootSafetyError("path-escape");
  }
  await assertNoSymlinkComponents(absolute);

  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (isMissing(error) && options.allowMissingLeaf) return;
    if (isPermissionError(error)) throw new RootSafetyError("permission-denied");
    throw error;
  }
  if (stats.isSymbolicLink()) throw new RootSafetyError("symlink-component");
  if (options.kind === "directory" && !stats.isDirectory()) throw new RootSafetyError("wrong-kind");
  if (options.kind === "file" && !stats.isFile()) throw new RootSafetyError("special-file");
  if (options.maximumBytes !== undefined && stats.size > options.maximumBytes) {
    throw new RootSafetyError("file-too-large");
  }
}

export async function inspectImportFile(path: string): Promise<{ size: number }> {
  if (!isAbsolute(path)) throw new RootSafetyError("path-escape");
  await assertNoSymlinkComponents(path);
  const stats = await safeLstat(path);
  if (stats.isSymbolicLink()) throw new RootSafetyError("symlink-component");
  if (!stats.isFile()) throw new RootSafetyError("special-file");
  if (stats.size > MAX_IMPORT_BYTES) throw new RootSafetyError("file-too-large");
  if (process.platform !== "win32" && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new RootSafetyError("owner-mismatch");
  }
  return { size: stats.size };
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new RootSafetyError("symlink-component");
    } catch (error) {
      if (error instanceof RootSafetyError) throw error;
      if (isMissing(error)) return;
      if (isPermissionError(error)) throw new RootSafetyError("permission-denied");
      throw error;
    }
  }
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) throw new RootSafetyError("root-missing");
    if (isPermissionError(error)) throw new RootSafetyError("permission-denied");
    throw error;
  }
}

function assertPrivateOwnership(uid: number, mode: number, platform: NodeJS.Platform): void {
  if (platform === "win32") return;
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new RootSafetyError("owner-mismatch");
  }
  if ((mode & 0o077) !== 0) throw new RootSafetyError("permissions-changed");
}

async function readWindowsOwner(
  path: string,
  options: WindowsOwnershipOptions | undefined,
): Promise<string> {
  const result = await probeWindowsRootOwnership(path, options);
  if (result.writable) return result.sid;
  throw new RootSafetyError(result.code);
}

function isMissing(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isPermissionError(error: unknown): boolean {
  return hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
