import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import { acquireDocumentLock, LockError, readProcessIdentity } from "./lock.ts";
import type { ClasiPaths } from "./paths.ts";
import {
  assertRootUnchanged,
  assertSafeContainedPath,
  hasErrorCode,
} from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";
import { MAX_DOCUMENT_BYTES } from "./schema.ts";

export type RepositoryLocator =
  | { kind: "filesystem"; device: string; inode: string }
  | { kind: "path-hash"; pathHash: string };

export interface RepositoryObservation {
  remoteRepositoryKey: string | null;
  locator: RepositoryLocator;
}

export type RepositoryResolution =
  | { status: "attached"; repositoryKey: string; created: boolean }
  | {
      status: "migration-required";
      repositoryKey: string;
      proposedRepositoryKey: string;
    };

interface RepositoryIndexEntry {
  locator: RepositoryLocator;
  repositoryKey: string;
  remoteRepositoryKey: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RepositoryIndex {
  schemaVersion: 1;
  updatedAt: string;
  entries: RepositoryIndexEntry[];
}

export interface RepositoryRegistryOptions {
  controlPin: RootPin;
  paths: ClasiPaths;
  createRepositoryId?: () => string;
  now?: () => string;
}

const INDEX_LOCK_DOCUMENT_KEY = `doc_${createHash("sha256")
  .update("clasi:repository-index")
  .digest("hex")
  .slice(0, 32)}`;

export class RepositoryRegistry {
  readonly #controlPin: RootPin;
  readonly #paths: ClasiPaths;
  readonly #createRepositoryId: () => string;
  readonly #now: () => string;

  constructor(options: RepositoryRegistryOptions) {
    this.#controlPin = options.controlPin;
    this.#paths = options.paths;
    this.#createRepositoryId = options.createRepositoryId ?? (() => createOpaqueId("repo"));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async resolve(observation: RepositoryObservation): Promise<RepositoryResolution> {
    const normalized = validateObservation(observation);
    return this.#withIndex<RepositoryResolution>(async index => {
      const entry = index.entries.find(candidate => sameLocator(candidate.locator, normalized.locator));
      if (entry) {
        if (
          normalized.remoteRepositoryKey !== null &&
          normalized.remoteRepositoryKey !== entry.remoteRepositoryKey
        ) {
          return {
            result: {
              status: "migration-required" as const,
              repositoryKey: entry.repositoryKey,
              proposedRepositoryKey: normalized.remoteRepositoryKey,
            },
            changed: false,
          };
        }
        return {
          result: { status: "attached" as const, repositoryKey: entry.repositoryKey, created: false },
          changed: false,
        };
      }

      const now = this.#now();
      const repositoryKey = normalized.remoteRepositoryKey ?? this.#createRepositoryId();
      if (!isOpaqueId(repositoryKey, "repo")) throw new RegistryError("invalid-index");
      index.entries.push({
        locator: normalized.locator,
        repositoryKey,
        remoteRepositoryKey: normalized.remoteRepositoryKey,
        createdAt: now,
        updatedAt: now,
      });
      index.updatedAt = now;
      return {
        result: { status: "attached" as const, repositoryKey, created: true },
        changed: true,
      };
    });
  }

  async reattach(input: {
    repositoryKey: string;
    locator: RepositoryLocator;
  }): Promise<RepositoryResolution> {
    if (!isOpaqueId(input.repositoryKey, "repo")) throw new RegistryError("invalid-repository");
    const locator = validateLocator(input.locator);
    return this.#withIndex<RepositoryResolution>(async index => {
      const source = index.entries.find(entry =>
        entry.repositoryKey === input.repositoryKey && entry.remoteRepositoryKey === null
      );
      if (!source) throw new RegistryError("unknown-repository");
      const existing = index.entries.find(entry => sameLocator(entry.locator, locator));
      if (existing) {
        if (existing.repositoryKey !== input.repositoryKey) throw new RegistryError("locator-conflict");
        return {
          result: { status: "attached" as const, repositoryKey: input.repositoryKey, created: false },
          changed: false,
        };
      }
      const now = this.#now();
      index.entries.push({
        locator,
        repositoryKey: input.repositoryKey,
        remoteRepositoryKey: null,
        createdAt: now,
        updatedAt: now,
      });
      index.updatedAt = now;
      return {
        result: { status: "attached" as const, repositoryKey: input.repositoryKey, created: true },
        changed: true,
      };
    });
  }

  async confirmMigration(input: {
    locator: RepositoryLocator;
    fromRepositoryKey: string;
    toRepositoryKey: string;
  }): Promise<RepositoryResolution> {
    const locator = validateLocator(input.locator);
    if (
      !isOpaqueId(input.fromRepositoryKey, "repo") ||
      !isOpaqueId(input.toRepositoryKey, "repo")
    ) {
      throw new RegistryError("invalid-repository");
    }
    return this.#withIndex<RepositoryResolution>(async index => {
      const entry = index.entries.find(candidate => sameLocator(candidate.locator, locator));
      if (!entry) throw new RegistryError("attachment-changed");
      if (entry.repositoryKey === input.toRepositoryKey) {
        return {
          result: {
            status: "attached" as const,
            repositoryKey: input.toRepositoryKey,
            created: false,
          },
          changed: false,
        };
      }
      if (entry.repositoryKey !== input.fromRepositoryKey) {
        throw new RegistryError("attachment-changed");
      }
      const now = this.#now();
      entry.repositoryKey = input.toRepositoryKey;
      entry.remoteRepositoryKey = input.toRepositoryKey;
      entry.updatedAt = now;
      index.updatedAt = now;
      return {
        result: {
          status: "attached" as const,
          repositoryKey: input.toRepositoryKey,
          created: false,
        },
        changed: true,
      };
    });
  }

  async #withIndex<T>(
    mutate: (index: RepositoryIndex) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    const lockPath = this.#paths.lock(INDEX_LOCK_DOCUMENT_KEY);
    await assertSafeContainedPath(this.#controlPin, lockPath, {
      kind: "directory",
      allowMissingLeaf: true,
    });
    let lock;
    for (let attempt = 0; ; attempt += 1) {
      try {
        lock = await acquireDocumentLock(lockPath, {
          ownerToken: randomUUID(),
          pid: process.pid,
          processIdentity: await readProcessIdentity(process.pid) ?? `pid:${process.pid}`,
          startedAt: this.#now(),
        });
        break;
      } catch (error) {
        if (!(error instanceof LockError) || error.code !== "lock-held" || attempt >= 1_000) throw error;
        await delay(5);
      }
    }
    try {
      const index = await this.#readIndex();
      const { result, changed } = await mutate(index);
      if (changed) await this.#writeIndex(index);
      return result;
    } finally {
      await lock.release();
    }
  }

  async #readIndex(): Promise<RepositoryIndex> {
    const path = this.#paths.repositoryIndex;
    await assertRootUnchanged(this.#controlPin);
    await assertSafeContainedPath(this.#controlPin, path, {
      kind: "file",
      allowMissingLeaf: true,
      maximumBytes: MAX_DOCUMENT_BYTES,
    });
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        return { schemaVersion: 1, updatedAt: this.#now(), entries: [] };
      }
      throw new RegistryError("invalid-index");
    }
    return validateIndex(value);
  }

  async #writeIndex(index: RepositoryIndex): Promise<void> {
    const path = this.#paths.repositoryIndex;
    const temporary = `${path}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(index, null, 2)}\n`;
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export class RegistryError extends Error {
  constructor(readonly code:
    | "invalid-index"
    | "invalid-locator"
    | "invalid-repository"
    | "unknown-repository"
    | "locator-conflict"
    | "attachment-changed"
  ) {
    super(code);
    this.name = "RegistryError";
  }
}

function validateObservation(observation: RepositoryObservation): RepositoryObservation {
  if (
    observation.remoteRepositoryKey !== null &&
    !isOpaqueId(observation.remoteRepositoryKey, "repo")
  ) {
    throw new RegistryError("invalid-repository");
  }
  return {
    remoteRepositoryKey: observation.remoteRepositoryKey,
    locator: validateLocator(observation.locator),
  };
}

function validateLocator(locator: RepositoryLocator): RepositoryLocator {
  if (locator.kind === "filesystem") {
    if (!/^\d{1,32}$/.test(locator.device) || !/^\d{1,32}$/.test(locator.inode)) {
      throw new RegistryError("invalid-locator");
    }
    return { ...locator };
  }
  if (locator.kind === "path-hash" && /^[0-9a-f]{64}$/.test(locator.pathHash)) {
    return { ...locator };
  }
  throw new RegistryError("invalid-locator");
}

function sameLocator(left: RepositoryLocator, right: RepositoryLocator): boolean {
  return left.kind === "filesystem" && right.kind === "filesystem"
    ? left.device === right.device && left.inode === right.inode
    : left.kind === "path-hash" && right.kind === "path-hash" &&
      left.pathHash === right.pathHash;
}

function validateIndex(value: unknown): RepositoryIndex {
  if (typeof value !== "object" || value === null) throw new RegistryError("invalid-index");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    !Array.isArray(record.entries)
  ) {
    throw new RegistryError("invalid-index");
  }
  const entries = record.entries.map(entry => {
    if (typeof entry !== "object" || entry === null) throw new RegistryError("invalid-index");
    const candidate = entry as Record<string, unknown>;
    if (
      !isOpaqueId(candidate.repositoryKey, "repo") ||
      !(candidate.remoteRepositoryKey === null || isOpaqueId(candidate.remoteRepositoryKey, "repo")) ||
      typeof candidate.createdAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.createdAt)) ||
      typeof candidate.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(candidate.updatedAt))
    ) {
      throw new RegistryError("invalid-index");
    }
    return {
      locator: validateLocator(candidate.locator as RepositoryLocator),
      repositoryKey: candidate.repositoryKey,
      remoteRepositoryKey: candidate.remoteRepositoryKey,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt,
    };
  });
  return { schemaVersion: 1, updatedAt: record.updatedAt, entries };
}
