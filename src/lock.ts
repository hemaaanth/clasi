import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasErrorCode as hasCode } from "./root-safety.ts";

export const MAX_LOCK_OWNER_BYTES = 1_024;

export type LockReasonCode =
  | "lock-held"
  | "lock-owner-invalid"
  | "lock-owner-changed"
  | "lock-owner-alive"
  | "confirmation-required";

export class LockError extends Error {
  constructor(readonly code: LockReasonCode) {
    super(code);
    this.name = "LockError";
  }
}

export interface LockOwner {
  ownerToken: string;
  pid: number;
  processIdentity: string;
  startedAt: string;
}

export interface DocumentLock {
  readonly owner: LockOwner;
  release(): Promise<void>;
}

export async function acquireDocumentLock(
  lockPath: string,
  owner: LockOwner,
): Promise<DocumentLock> {
  validateOwner(owner);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new LockError("lock-held");
    throw error;
  }

  const ownerPath = documentLockOwnerPath(lockPath);
  try {
    await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    owner,
    release: async () => {
      if (released) return;
      const current = await readOwner(ownerPath);
      if (current.ownerToken !== owner.ownerToken) throw new LockError("lock-owner-changed");
      await unlink(ownerPath);
      await rmdir(lockPath);
      released = true;
    },
  };
}

export async function recoverDocumentLock(
  lockPath: string,
  options: {
    confirm: boolean;
    readProcessIdentity?: (pid: number) => Promise<string | null>;
  },
): Promise<void> {
  if (!options.confirm) throw new LockError("confirmation-required");
  const ownerPath = documentLockOwnerPath(lockPath);
  const owner = await readOwner(ownerPath);
  const currentProcessIdentity =
    await (options.readProcessIdentity ?? readProcessIdentity)(owner.pid);
  if (currentProcessIdentity === owner.processIdentity) throw new LockError("lock-owner-alive");
  const current = await readOwner(ownerPath);
  if (current.ownerToken !== owner.ownerToken) throw new LockError("lock-owner-changed");
  await unlink(ownerPath);
  await rmdir(lockPath);
}

export function documentLockOwnerPath(lockPath: string): string {
  return join(lockPath, "owner.json");
}

export function validateLockOwnerDocument(content: string): void {
  parseOwner(content);
}

async function readOwner(path: string): Promise<LockOwner> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new LockError("lock-owner-invalid");
  }
  return parseOwner(content);
}

function parseOwner(content: string): LockOwner {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new LockError("lock-owner-invalid");
  }
  if (typeof value !== "object" || value === null) {
    throw new LockError("lock-owner-invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "ownerToken,pid,processIdentity,startedAt") {
    throw new LockError("lock-owner-invalid");
  }
  const owner = {
    ownerToken: record.ownerToken,
    pid: record.pid,
    processIdentity: record.processIdentity,
    startedAt: record.startedAt,
  };
  validateOwner(owner);
  return owner;
}

function validateOwner(value: {
  ownerToken: unknown;
  pid: unknown;
  processIdentity: unknown;
  startedAt: unknown;
}): asserts value is LockOwner {
  if (
    typeof value.ownerToken !== "string" ||
    value.ownerToken.length < 1 ||
    value.ownerToken.length > 128 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.processIdentity !== "string" ||
    !/^[A-Za-z0-9:._-]{1,128}$/.test(value.processIdentity) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new LockError("lock-owner-invalid");
  }
}

export async function readProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const startTicks = fields[19];
      return startTicks ? `linux:${startTicks}` : null;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }
  return processIsAlive(pid) ? `pid:${pid}` : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

