import { opendir } from "node:fs/promises";
import {
  headlessDegraded,
  headlessOk,
  headlessPartial,
  headlessSetupNeeded,
} from "./headless-response.ts";
import type { HeadlessResponse } from "./headless-response.ts";
import { StoreError } from "./markdown-store.ts";
import type { ScopeRef } from "./paths.ts";
import {
  resolveRuntimeEnvironment,
} from "./runtime-environment.ts";
import type {
  RuntimeEnvironmentOptions,
  RuntimeEnvironmentReady,
  RuntimeEnvironmentResult,
} from "./runtime-environment.ts";
import { assertRootUnchanged, assertSafeContainedPath } from "./root-safety.ts";
import type { RootPin } from "./root-safety.ts";
import type { RuntimeEnvironmentResolver } from "./status.ts";

export type DoctorCheckState = "ok" | "disabled" | "unavailable" | "not-applicable" | "not-inspected" | "present";

export interface CoordinationPresence {
  locks: "clear" | "present" | "unavailable";
  transactions: "clear" | "present" | "unavailable";
}

export interface DoctorHostMetadata {
  builtInMemoryEnabled: boolean;
}

export interface DoctorData {
  reason_codes: string[];
  affected_scope: "runtime" | "global" | "machine" | "repository" | null;
  document_type: "context" | "napkin" | null;
  checks: {
    control_root: DoctorCheckState;
    data_root: DoctorCheckState;
    schema_reads: DoctorCheckState;
    repository_identity: DoctorCheckState;
    locks: DoctorCheckState;
    transactions: DoctorCheckState;
    built_in_memory?: "enabled" | "disabled";
  };
  disabled_reads: Array<"all" | "memory" | "repository">;
  disabled_writes: Array<"all" | "memory" | "repository">;
  last_good_active: boolean;
  unaffected_operations: string[];
  recovery_command?: string;
  from_repository_id?: string;
  to_repository_id?: string;
}

export type SchemaReadCheck =
  | { status: "ok" }
  | {
      status: "disabled";
      scope: "runtime" | "global" | "machine" | "repository";
      documentType: "context" | "napkin";
    };

export interface DoctorOptions {
  runtime?: RuntimeEnvironmentResolver;
  runtimeOptions?: RuntimeEnvironmentOptions;
  rootCheck?: (environment: RuntimeEnvironmentReady) => Promise<void>;
  schemaRead?: (environment: RuntimeEnvironmentReady) => Promise<SchemaReadCheck>;
  coordination?: (environment: RuntimeEnvironmentReady) => Promise<CoordinationPresence>;
  hostMetadata?: DoctorHostMetadata;
  lastGoodActive?: boolean;
}

export async function getHeadlessDoctor(
  cwd: string,
  options: DoctorOptions = {},
): Promise<HeadlessResponse<DoctorData | Record<string, never>>> {
  const environment = await (options.runtime ?? resolveRuntimeEnvironment)(cwd, options.runtimeOptions);
  if (environment.status === "setup-needed") {
    return headlessSetupNeeded(
      "setup-needed",
      "clasi setup is required before diagnostics can run.",
      {},
      ["Run clasi setup."],
    );
  }
  if (environment.status === "degraded") {
    return headlessDegraded(
      environment.code,
      "clasi runtime state is degraded.",
      unavailableRuntime(environment, options.lastGoodActive ?? false),
      ["Run the recovery command shown in data."],
    );
  }

  try {
    await (options.rootCheck ?? defaultRootCheck)(environment);
  } catch {
    return headlessDegraded(
      "root-safety-check-failed",
      "clasi roots are unavailable for safe reads and writes.",
      {
        ...baseDoctorData(environment, options),
        reason_codes: ["root-safety-check-failed"],
        affected_scope: "runtime",
        checks: {
          ...baseChecks(environment, options),
          control_root: "disabled",
          data_root: "disabled",
          schema_reads: "disabled",
        },
        disabled_reads: ["all"],
        disabled_writes: ["all"],
        unaffected_operations: ["help", "version"],
        recovery_command: "clasi doctor",
      },
      ["Run the recovery command shown in data."],
    );
  }

  const schema = await (options.schemaRead ?? defaultSchemaRead)(environment).catch(() => ({
    status: "disabled" as const,
    scope: "runtime" as const,
    documentType: "context" as const,
  }));
  if (schema.status === "disabled") {
    const affectedScope = schema.scope;
    return headlessDegraded(
      "schema-read-disabled",
      "A canonical memory document is unavailable for safe reads.",
      {
        ...baseDoctorData(environment, options),
        reason_codes: ["schema-read-disabled"],
        affected_scope: affectedScope,
        document_type: schema.documentType,
        checks: { ...baseChecks(environment, options), schema_reads: "disabled" },
        disabled_reads: ["memory"],
        disabled_writes: ["memory"],
        unaffected_operations: ["help", "version", "status", "doctor"],
        recovery_command: "clasi doctor",
      },
      ["Run the recovery command shown in data."],
    );
  }

  let coordination: CoordinationPresence;
  try {
    coordination = await (options.coordination ?? defaultCoordination)(environment);
    if (!validCoordination(coordination)) {
      coordination = { locks: "unavailable", transactions: "unavailable" };
    }
  } catch {
    coordination = { locks: "unavailable", transactions: "unavailable" };
  }

  const reasons: string[] = [];
  const disabledReads: DoctorData["disabled_reads"] = [];
  const disabledWrites: DoctorData["disabled_writes"] = [];
  if (environment.capabilities.repositoryScope === "unavailable") {
    reasons.push("repository-identity-unavailable");
    disabledReads.push("repository");
    disabledWrites.push("repository");
  }
  if (coordination.locks === "unavailable" || coordination.transactions === "unavailable") {
    reasons.push("coordination-check-unavailable");
    disabledWrites.push("memory");
  }
  if (coordination.locks === "present" || coordination.transactions === "present") {
    reasons.push("coordination-state-present");
  }
  if (options.hostMetadata?.builtInMemoryEnabled === true) {
    reasons.push("built-in-memory-coexistence");
  }

  const data: DoctorData = {
    ...baseDoctorData(environment, options),
    reason_codes: reasons,
    checks: {
      ...baseChecks(environment, options),
      schema_reads: "ok",
      locks: coordinationState(coordination.locks),
      transactions: coordinationState(coordination.transactions),
    },
    disabled_reads: unique(disabledReads),
    disabled_writes: unique(disabledWrites),
    unaffected_operations: disabledReads.length === 0 && disabledWrites.length === 0
      ? ["status", "config", "review", "inbox", "impact"]
      : ["help", "version", "status", "doctor"],
    ...(coordination.locks === "present" || coordination.transactions === "present"
      ? { recovery_command: "clasi doctor" }
      : {}),
  };

  return reasons.length === 0
    ? headlessOk("doctor-clean", "clasi diagnostics passed.", data)
    : headlessPartial(
        "doctor-partial",
        "clasi is usable with the reported limitations.",
        data,
        data.recovery_command ? ["Run the recovery command shown in data."] : [],
      );
}

function baseDoctorData(
  environment: RuntimeEnvironmentReady,
  options: DoctorOptions,
): DoctorData {
  return {
    reason_codes: [],
    affected_scope: null,
    document_type: null,
    checks: baseChecks(environment, options),
    disabled_reads: [],
    disabled_writes: [],
    last_good_active: options.lastGoodActive ?? false,
    unaffected_operations: [],
  };
}

function baseChecks(
  environment: RuntimeEnvironmentReady,
  options: DoctorOptions,
): DoctorData["checks"] {
  return {
    control_root: "ok",
    data_root: "ok",
    schema_reads: "not-inspected",
    repository_identity: environment.capabilities.repositoryScope === "unavailable"
      ? "unavailable"
      : environment.capabilities.repositoryScope === "not-repository"
        ? "not-applicable"
        : "ok",
    locks: "not-inspected",
    transactions: "not-inspected",
    ...(options.hostMetadata
      ? { built_in_memory: options.hostMetadata.builtInMemoryEnabled ? "enabled" : "disabled" }
      : {}),
  };
}

function unavailableRuntime(
  environment: Extract<RuntimeEnvironmentResult, { status: "degraded" }>,
  lastGoodActive: boolean,
): DoctorData {
  const migration = environment.code === "repository-migration-required"
    ? {
        from_repository_id: environment.migration.fromRepositoryKey,
        to_repository_id: environment.migration.toRepositoryKey,
      }
    : {};
  return {
    reason_codes: [environment.code],
    affected_scope: environment.code === "repository-migration-required"
      ? "repository"
      : "runtime",
    document_type: null,
    checks: {
      control_root: "unavailable",
      data_root: "unavailable",
      schema_reads: "disabled",
      repository_identity: "unavailable",
      locks: "not-inspected",
      transactions: "not-inspected",
    },
    disabled_reads: ["all"],
    disabled_writes: ["all"],
    last_good_active: lastGoodActive,
    unaffected_operations: environment.code === "repository-migration-required"
      ? ["help", "version", "doctor", "migrate"]
      : ["help", "version", "doctor"],
    recovery_command: environment.code === "repository-migration-required"
      ? `clasi migrate --from ${environment.migration.fromRepositoryKey} --to ${environment.migration.toRepositoryKey} --confirm`
      : environment.code === "invalid-config"
        ? "clasi setup"
        : "clasi doctor",
    ...migration,
  };
}

async function defaultRootCheck(environment: RuntimeEnvironmentReady): Promise<void> {
  await assertRootUnchanged(environment.controlPin);
  await assertRootUnchanged(environment.dataPin);
}

async function defaultCoordination(
  environment: RuntimeEnvironmentReady,
): Promise<CoordinationPresence> {
  const [locks, transactions] = await Promise.all([
    inspectPresence(environment.controlPin, environment.paths.lockDirectory),
    inspectPresence(environment.dataPin, environment.paths.transactionDirectory),
  ]);
  return { locks, transactions };
}

async function inspectPresence(
  pin: RootPin,
  path: string,
): Promise<CoordinationPresence["locks"]> {
  try {
    await assertSafeContainedPath(pin, path, {
      kind: "directory",
      allowMissingLeaf: true,
    });
  } catch {
    return "unavailable";
  }

  let directory;
  try {
    directory = await opendir(path);
  } catch (error) {
    return hasCode(error, "ENOENT") ? "clear" : "unavailable";
  }

  try {
    return await directory.read() === null ? "clear" : "present";
  } catch (error) {
    return hasCode(error, "ENOENT") ? "clear" : "unavailable";
  } finally {
    try {
      await directory.close();
    } catch {
      // Presence was already classified; close failures never expose filesystem details.
    }
  }
}

async function defaultSchemaRead(environment: RuntimeEnvironmentReady): Promise<SchemaReadCheck> {
  for (const scope of environment.scopes) {
    const context = await readExpected(environment, scope, "context");
    if (!context) return { status: "disabled", scope: scope.type, documentType: "context" };
    const napkin = await readExpected(environment, scope, "napkin");
    if (!napkin) return { status: "disabled", scope: scope.type, documentType: "napkin" };
  }
  return { status: "ok" };
}

async function readExpected(
  environment: RuntimeEnvironmentReady,
  scope: ScopeRef,
  documentType: "context" | "napkin",
): Promise<boolean> {
  const path = documentType === "context"
    ? environment.paths.context(scope)
    : environment.paths.napkin(scope);
  try {
    const read = await environment.store.read(path);
    return read.document.documentType === documentType &&
      read.document.scopeType === scope.type &&
      read.document.scopeId === scope.id;
  } catch (error) {
    return error instanceof StoreError && error.code === "canonical-missing";
  }
}

function validCoordination(value: CoordinationPresence): boolean {
  return ["clear", "present", "unavailable"].includes(value.locks) &&
    ["clear", "present", "unavailable"].includes(value.transactions);
}

function coordinationState(value: CoordinationPresence["locks"]): DoctorCheckState {
  return value === "clear" ? "ok" : value;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === code;
}
