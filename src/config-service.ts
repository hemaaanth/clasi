import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { DEFAULT_CONTEXT_CHARACTER_CAP, resolveClasiConfig } from "./config.ts";
import type { ClasiConfig, ResolvedClasiConfig } from "./config.ts";
import { acquireDocumentLock, LockError, readProcessIdentity } from "./lock.ts";
import {
  assertRootUnchanged,
  assertSafeContainedPath,
  readRegularFileBounded,
  RootSafetyError,
} from "./root-safety.ts";
import type { RuntimeEnvironmentReady } from "./runtime-environment.ts";

const MAX_CONFIG_BYTES = 16_384;
export const CONFIG_DOCUMENT_ID = `doc_${createHash("sha256")
  .update("clasi:config")
  .digest("hex")
  .slice(0, 32)}` as const;

export type ConfigServiceReasonCode =
  | "confirmation-required"
  | "invalid-input"
  | "no-change"
  | "invalid-config"
  | "unsafe-control-root"
  | "lock-held"
  | "write-conflict"
  | "write-failed";

export interface ConfigUpdateInput {
  napkinCategoryCap?: number;
  contextCharacterCap?: number;
  confirmed: boolean;
}

export type ConfigReadResult =
  | { ok: true; config: ResolvedClasiConfig }
  | { ok: false; code: ConfigServiceReasonCode };

export type ConfigUpdateResult =
  | { ok: true; previous: ResolvedClasiConfig; config: ResolvedClasiConfig }
  | { ok: false; code: ConfigServiceReasonCode };

export type ConfigUpdatedCallback = (config: ResolvedClasiConfig) => void | Promise<void>;

export interface ConfigServiceOptions {
  onUpdated?: ConfigUpdatedCallback;
  beforeDigestRevalidation?: () => void | Promise<void>;
}

interface StoredConfig extends ClasiConfig {
  schemaVersion: 1;
  napkinCategoryCap: number;
  contextCharacterCap: number;
}

interface CurrentConfig {
  bytes: Uint8Array;
  stored: StoredConfig;
  resolved: ResolvedClasiConfig;
}

export class ConfigService {
  readonly #environment: RuntimeEnvironmentReady;
  readonly #onUpdated: ConfigUpdatedCallback | undefined;
  readonly #beforeDigestRevalidation: (() => void | Promise<void>) | undefined;

  constructor(environment: RuntimeEnvironmentReady, options: ConfigServiceOptions = {}) {
    this.#environment = environment;
    this.#onUpdated = options.onUpdated;
    this.#beforeDigestRevalidation = options.beforeDigestRevalidation;
  }

  async read(): Promise<ConfigReadResult> {
    try {
      const current = await this.#readCurrent();
      return { ok: true, config: current.resolved };
    } catch (error) {
      return { ok: false, code: reasonFor(error, "invalid-config") };
    }
  }

  async update(input: ConfigUpdateInput): Promise<ConfigUpdateResult> {
    if (input.napkinCategoryCap === undefined && input.contextCharacterCap === undefined) {
      return { ok: false, code: "invalid-input" };
    }
    if (!validCapInput(input)) return { ok: false, code: "invalid-input" };
    if (!input.confirmed) return { ok: false, code: "confirmation-required" };

    const lockPath = this.#environment.paths.lock(CONFIG_DOCUMENT_ID);
    try {
      await assertRootUnchanged(this.#environment.controlPin);
      await assertSafeContainedPath(this.#environment.controlPin, lockPath, {
        kind: "directory",
        allowMissingLeaf: true,
      });
      const lock = await acquireDocumentLock(lockPath, {
        ownerToken: randomUUID(),
        pid: process.pid,
        processIdentity: await readProcessIdentity(process.pid) ?? `pid:${process.pid}`,
        startedAt: new Date().toISOString(),
      });
      try {
        return await this.#updateLocked(input);
      } finally {
        await lock.release().catch(() => undefined);
      }
    } catch (error) {
      return { ok: false, code: reasonFor(error, "write-failed") };
    }
  }

  async #updateLocked(input: ConfigUpdateInput): Promise<ConfigUpdateResult> {
    const current = await this.#readCurrent();
    const nextNapkinCap = input.napkinCategoryCap ?? current.stored.napkinCategoryCap;
    const nextContextCap = input.contextCharacterCap ?? current.stored.contextCharacterCap;
    if (
      nextNapkinCap === current.stored.napkinCategoryCap &&
      nextContextCap === current.stored.contextCharacterCap
    ) {
      return { ok: false, code: "no-change" };
    }

    let resolved: ResolvedClasiConfig;
    try {
      resolved = resolveClasiConfig({
        dataRoot: this.#environment.config.dataRoot,
        napkinCategoryCap: nextNapkinCap,
        contextCharacterCap: nextContextCap,
      }, this.#environment.config.dataRoot);
    } catch {
      return { ok: false, code: "invalid-input" };
    }

    const nextStored: StoredConfig = {
      schemaVersion: 1,
      dataRoot: current.stored.dataRoot,
      napkinCategoryCap: nextNapkinCap,
      contextCharacterCap: nextContextCap,
    };
    const content = `${JSON.stringify(nextStored, null, 2)}\n`;
    const temporary = `${this.#environment.paths.config}.${randomUUID()}.tmp`;
    await assertSafeContainedPath(this.#environment.controlPin, temporary, {
      kind: "file",
      allowMissingLeaf: true,
      maximumBytes: MAX_CONFIG_BYTES,
    });

    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertSafeContainedPath(this.#environment.controlPin, temporary, {
        kind: "file",
        maximumBytes: MAX_CONFIG_BYTES,
      });
      await this.#beforeDigestRevalidation?.();
      const latestBytes = await this.#readConfigBytes();
      if (digest(latestBytes) !== digest(current.bytes)) {
        return { ok: false, code: "write-conflict" };
      }
      await rename(temporary, this.#environment.paths.config);
      await assertRootUnchanged(this.#environment.controlPin);
    } catch (error) {
      if (error instanceof RootSafetyError) throw error;
      return { ok: false, code: "write-failed" };
    } finally {
      await unlink(temporary).catch(() => undefined);
    }

    try {
      await this.#onUpdated?.(resolved);
    } catch {
      // Persistence is authoritative; observer refresh can retry independently.
    }
    return { ok: true, previous: current.resolved, config: resolved };
  }

  async #readCurrent(): Promise<CurrentConfig> {
    const bytes = await this.#readConfigBytes();
    const stored = parseStoredConfig(bytes);
    if (!stored) throw new ConfigServiceError("invalid-config");
    try {
      const resolved = resolveClasiConfig({
        dataRoot: this.#environment.config.dataRoot,
        napkinCategoryCap: stored.napkinCategoryCap,
        contextCharacterCap: stored.contextCharacterCap,
      }, this.#environment.config.dataRoot);
      return { bytes, stored, resolved };
    } catch {
      throw new ConfigServiceError("invalid-config");
    }
  }

  async #readConfigBytes(): Promise<Uint8Array> {
    await assertSafeContainedPath(
      this.#environment.controlPin,
      this.#environment.paths.config,
      { kind: "file", maximumBytes: MAX_CONFIG_BYTES },
    );
    const bytes = await readRegularFileBounded(this.#environment.paths.config, MAX_CONFIG_BYTES);
    await assertRootUnchanged(this.#environment.controlPin);
    return bytes;
  }
}

class ConfigServiceError extends Error {
  constructor(readonly code: ConfigServiceReasonCode) {
    super(code);
    this.name = "ConfigServiceError";
  }
}

function parseStoredConfig(bytes: Uint8Array): StoredConfig | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "contextCharacterCap",
    "dataRoot",
    "napkinCategoryCap",
    "schemaVersion",
  ];
  const keys = Object.keys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    typeof record.dataRoot !== "string" ||
    record.dataRoot.length === 0 ||
    !Number.isInteger(record.napkinCategoryCap) ||
    !Number.isInteger(record.contextCharacterCap)
  ) return undefined;
  return {
    schemaVersion: 1,
    dataRoot: record.dataRoot,
    napkinCategoryCap: record.napkinCategoryCap as number,
    contextCharacterCap: record.contextCharacterCap as number,
  };
}

function validCapInput(input: ConfigUpdateInput): boolean {
  return (
    input.napkinCategoryCap === undefined ||
    Number.isInteger(input.napkinCategoryCap) &&
      input.napkinCategoryCap >= 1 &&
      input.napkinCategoryCap <= 20
  ) && (
    input.contextCharacterCap === undefined ||
    Number.isInteger(input.contextCharacterCap) &&
      input.contextCharacterCap >= 500 &&
      input.contextCharacterCap <= DEFAULT_CONTEXT_CHARACTER_CAP
  );
}

function reasonFor(error: unknown, fallback: ConfigServiceReasonCode): ConfigServiceReasonCode {
  if (error instanceof ConfigServiceError) return error.code;
  if (error instanceof LockError && error.code === "lock-held") return "lock-held";
  if (error instanceof RootSafetyError) return "unsafe-control-root";
  return fallback;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
