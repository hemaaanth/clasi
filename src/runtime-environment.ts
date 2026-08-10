import { join } from "node:path";
import {
  DEFAULT_CONTEXT_CHARACTER_CAP,
  DEFAULT_NAPKIN_CATEGORY_CAP,
  resolveClasiConfig,
  resolveClasiRoots,
} from "./config.ts";
import type { ClasiConfig, ClasiRoots, ResolvedClasiConfig } from "./config.ts";
import type { GitIdentityResult } from "./git-identity.ts";
import { resolveGitIdentity } from "./git-identity.ts";
import { isOpaqueId } from "./ids.ts";
import { readOrCreateMachineId } from "./machine.ts";
import { MarkdownStore } from "./markdown-store.ts";
import { createClasiPaths } from "./paths.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { RepositoryRegistry } from "./repository-registry.ts";
import type {
  RepositoryLocator,
  RepositoryObservation,
  RepositoryResolution,
} from "./repository-registry.ts";
import {
  assertRootUnchanged,
  assertSafeContainedPath,
  hasErrorCode,
  pinRoot,
  readRegularFileBounded,
  RootSafetyError,
} from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";

const MAX_CONFIG_BYTES = 16_384;

export type RuntimeCapabilityDegradation = "git-unavailable";

export type RuntimeEnvironmentDegradedCode =
  | "invalid-environment"
  | "invalid-config"
  | "unsafe-control-root"
  | "unsafe-data-root"
  | "machine-id-unavailable"
  | "git-identity-unavailable"
  | "repository-migration-required"
  | "repository-registry-unavailable";

export type RuntimeGitIdentityResult =
  | GitIdentityResult
  | { ok: true; kind: "not-repository" };

export interface RuntimeCapabilities {
  repositoryScope: "attached" | "not-repository" | "unavailable";
  requiresReattachOnMove: boolean;
}

export interface RuntimeEnvironmentReady {
  status: "ready";
  config: ResolvedClasiConfig;
  roots: ClasiRoots;
  controlPin: RootPin;
  dataPin: RootPin;
  paths: ClasiPaths;
  store: MarkdownStore;
  machineId: string;
  scopes: ScopeRef[];
  repositoryKey?: string;
  capabilities: RuntimeCapabilities;
  degradations: RuntimeCapabilityDegradation[];
}

export interface RuntimeMigrationContext {
  environment: RuntimeEnvironmentReady;
  locator: RepositoryLocator;
  fromRepositoryKey: string;
  toRepositoryKey: string;
}

export type RuntimeEnvironmentResult =
  | RuntimeEnvironmentReady
  | { status: "setup-needed"; code: "setup-needed" }
  | {
      status: "degraded";
      code: Exclude<RuntimeEnvironmentDegradedCode, "repository-migration-required">;
    }
  | {
      status: "degraded";
      code: "repository-migration-required";
      migration: RuntimeMigrationContext;
    };

export interface RuntimeEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  pin?: (path: string) => Promise<RootPin>;
  machineIdentity?: (paths: ClasiPaths, controlPin: RootPin) => Promise<string>;
  gitIdentity?: (cwd: string) => Promise<RuntimeGitIdentityResult>;
  repositoryResolution?: (
    observation: RepositoryObservation,
    context: { controlPin: RootPin; paths: ClasiPaths },
  ) => Promise<RepositoryResolution>;
  storeFactory?: (input: {
    controlPin: RootPin;
    dataPin: RootPin;
    paths: ClasiPaths;
  }) => MarkdownStore;
}

export async function resolveRuntimeEnvironment(
  cwd: string,
  options: RuntimeEnvironmentOptions = {},
): Promise<RuntimeEnvironmentResult> {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE;
  if (!nonempty(home) || !nonempty(cwd)) {
    return { status: "degraded", code: "invalid-environment" };
  }

  let controlRoot: string;
  try {
    controlRoot = resolveClasiRoots({
      env: { ...env, CLASI_HOME: home },
    }).controlRoot;
  } catch {
    return { status: "degraded", code: "invalid-environment" };
  }

  const pin = options.pin ?? pinRoot;
  let controlPin: RootPin;
  try {
    controlPin = await pin(controlRoot);
  } catch (error) {
    return rootFailure(error, "unsafe-control-root", true);
  }

  let config: ResolvedClasiConfig;
  if (nonempty(env.CLASI_HOME)) {
    let napkinCategoryCap = DEFAULT_NAPKIN_CATEGORY_CAP;
    let contextCharacterCap = DEFAULT_CONTEXT_CHARACTER_CAP;
    const loaded = await readStoredConfig(join(controlRoot, "config.json"), controlPin);
    if (loaded.status === "ok") {
      try {
        const stored = resolveClasiConfig(loaded.config, home);
        napkinCategoryCap = stored.napkinCategoryCap;
        contextCharacterCap = stored.contextCharacterCap;
      } catch {
        // CLASI_HOME remains authoritative when an optional stored config is invalid.
      }
    }
    try {
      config = resolveClasiConfig({
        dataRoot: env.CLASI_HOME,
        napkinCategoryCap,
        contextCharacterCap,
      }, home);
    } catch {
      return { status: "degraded", code: "invalid-config" };
    }
  } else {
    const loaded = await readStoredConfig(join(controlRoot, "config.json"), controlPin);
    if (loaded.status !== "ok") return loaded;
    try {
      config = resolveClasiConfig(loaded.config, home);
    } catch {
      return { status: "degraded", code: "invalid-config" };
    }
  }

  const roots: ClasiRoots = { controlRoot, dataRoot: config.dataRoot };
  let dataPin: RootPin;
  try {
    dataPin = await pin(roots.dataRoot);
  } catch (error) {
    return rootFailure(error, "unsafe-data-root", false);
  }

  const paths = createClasiPaths(roots);
  let machineId: string;
  try {
    machineId = await (options.machineIdentity ?? defaultMachineIdentity)(paths, controlPin);
    if (!isOpaqueId(machineId, "machine")) {
      return { status: "degraded", code: "machine-id-unavailable" };
    }
  } catch {
    return { status: "degraded", code: "machine-id-unavailable" };
  }

  const store = (options.storeFactory ?? defaultStoreFactory)({ controlPin, dataPin, paths });
  const baseScopes: ScopeRef[] = [
    { type: "global", id: "global" },
    { type: "machine", id: machineId },
  ];

  let git: RuntimeGitIdentityResult;
  try {
    git = await (options.gitIdentity ?? defaultGitIdentity)(cwd);
  } catch {
    return { status: "degraded", code: "git-identity-unavailable" };
  }

  if (!git.ok && git.code === "git-unavailable") {
    return ready({
      config,
      roots,
      controlPin,
      dataPin,
      paths,
      store,
      machineId,
      scopes: baseScopes,
      capabilities: { repositoryScope: "unavailable", requiresReattachOnMove: false },
      degradations: ["git-unavailable"],
    });
  }
  if (!git.ok) return { status: "degraded", code: "git-identity-unavailable" };
  if (git.kind === "not-repository") {
    return ready({
      config,
      roots,
      controlPin,
      dataPin,
      paths,
      store,
      machineId,
      scopes: baseScopes,
      capabilities: { repositoryScope: "not-repository", requiresReattachOnMove: false },
      degradations: [],
    });
  }
  const requiresReattachOnMove = git.commonDirectoryIdentity.kind === "path-hash";
  const observation: RepositoryObservation = {
    remoteRepositoryKey: git.kind === "remote" ? git.repository.repositoryKey : null,
    locator: git.commonDirectoryIdentity.kind === "path-hash"
      ? { kind: "path-hash", pathHash: git.commonDirectoryIdentity.pathHash }
      : {
          kind: "filesystem",
          device: git.commonDirectoryIdentity.device,
          inode: git.commonDirectoryIdentity.inode,
        },
  };
  let repository: RepositoryResolution;
  try {
    repository = await (options.repositoryResolution ?? defaultRepositoryResolution)(
      observation,
      { controlPin, paths },
    );
  } catch {
    return { status: "degraded", code: "repository-registry-unavailable" };
  }
  if (repository.status === "migration-required") {
    if (
      !isOpaqueId(repository.repositoryKey, "repo") ||
      !isOpaqueId(repository.proposedRepositoryKey, "repo")
    ) {
      return { status: "degraded", code: "repository-registry-unavailable" };
    }
    const environment = ready({
      config,
      roots,
      controlPin,
      dataPin,
      paths,
      store,
      machineId,
      scopes: [...baseScopes, { type: "repository", id: repository.repositoryKey }],
      repositoryKey: repository.repositoryKey,
      capabilities: { repositoryScope: "attached", requiresReattachOnMove },
      degradations: [],
    });
    return {
      status: "degraded",
      code: "repository-migration-required",
      migration: {
        environment,
        locator: observation.locator,
        fromRepositoryKey: repository.repositoryKey,
        toRepositoryKey: repository.proposedRepositoryKey,
      },
    };
  }
  if (!isOpaqueId(repository.repositoryKey, "repo")) {
    return { status: "degraded", code: "repository-registry-unavailable" };
  }

  return ready({
    config,
    roots,
    controlPin,
    dataPin,
    paths,
    store,
    machineId,
    scopes: [...baseScopes, { type: "repository", id: repository.repositoryKey }],
    repositoryKey: repository.repositoryKey,
    capabilities: { repositoryScope: "attached", requiresReattachOnMove },
    degradations: [],
  });
}

type ConfigReadResult =
  | { status: "ok"; config: ClasiConfig }
  | { status: "setup-needed"; code: "setup-needed" }
  | { status: "degraded"; code: "invalid-config" | "unsafe-control-root" };

async function readStoredConfig(path: string, controlPin: RootPin): Promise<ConfigReadResult> {
  try {
    await assertSafeContainedPath(controlPin, path, {
      kind: "file",
      allowMissingLeaf: true,
      maximumBytes: MAX_CONFIG_BYTES,
    });
    const bytes = await readRegularFileBounded(path, MAX_CONFIG_BYTES);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(source) as unknown;
    await assertRootUnchanged(controlPin);
    const config = strictStoredConfig(parsed);
    return config ? { status: "ok", config } : { status: "degraded", code: "invalid-config" };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { status: "setup-needed", code: "setup-needed" };
    if (error instanceof RootSafetyError) {
      return error.code === "root-missing"
        ? { status: "setup-needed", code: "setup-needed" }
        : { status: "degraded", code: "unsafe-control-root" };
    }
    return { status: "degraded", code: "invalid-config" };
  }
}

function strictStoredConfig(value: unknown): ClasiConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "contextCharacterCap",
    "dataRoot",
    "napkinCategoryCap",
    "schemaVersion",
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  if (
    record.schemaVersion !== 1 ||
    !nonempty(record.dataRoot) ||
    !Number.isInteger(record.napkinCategoryCap) ||
    !Number.isInteger(record.contextCharacterCap)
  ) {
    return null;
  }
  return {
    dataRoot: record.dataRoot,
    napkinCategoryCap: record.napkinCategoryCap as number,
    contextCharacterCap: record.contextCharacterCap as number,
  };
}

async function defaultGitIdentity(cwd: string): Promise<RuntimeGitIdentityResult> {
  const result = await resolveGitIdentity(cwd);
  return !result.ok && result.code === "common-directory-command-failed"
    ? { ok: true, kind: "not-repository" }
    : result;
}

async function defaultMachineIdentity(paths: ClasiPaths, controlPin: RootPin): Promise<string> {
  return readOrCreateMachineId(paths, { controlPin });
}

async function defaultRepositoryResolution(
  observation: RepositoryObservation,
  context: { controlPin: RootPin; paths: ClasiPaths },
): Promise<RepositoryResolution> {
  return new RepositoryRegistry(context).resolve(observation);
}

function defaultStoreFactory(input: {
  controlPin: RootPin;
  dataPin: RootPin;
  paths: ClasiPaths;
}): MarkdownStore {
  return new MarkdownStore(input);
}

function ready(input: Omit<RuntimeEnvironmentReady, "status">): RuntimeEnvironmentReady {
  return { status: "ready", ...input };
}

function rootFailure(
  error: unknown,
  unsafeCode: "unsafe-control-root" | "unsafe-data-root",
  missingIsSetup: boolean,
): RuntimeEnvironmentResult {
  return missingIsSetup && error instanceof RootSafetyError && error.code === "root-missing"
    ? { status: "setup-needed", code: "setup-needed" }
    : { status: "degraded", code: unsafeCode };
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
