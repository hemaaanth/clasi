import { collapseHomePath } from "./config.ts";
import {
  headlessDegraded,
  headlessOk,
  headlessPartial,
  headlessSetupNeeded,
} from "./headless-response.ts";
import type { HeadlessResponse } from "./headless-response.ts";
import {
  resolveRuntimeEnvironment,
} from "./runtime-environment.ts";
import type {
  RuntimeEnvironmentOptions,
  RuntimeEnvironmentReady,
  RuntimeEnvironmentResult,
} from "./runtime-environment.ts";

export type DiagnosticSubsystem = "all" | "memory" | "repository";

export interface DegradedDiagnosticData {
  reason_code: string;
  affected_scope: "runtime" | "global" | "machine" | "repository";
  document_type: "context" | "napkin" | "papercut" | "metrics" | null;
  disabled_reads: DiagnosticSubsystem[];
  disabled_writes: DiagnosticSubsystem[];
  last_good_active: boolean;
  unaffected_operations: string[];
  recovery_command: string;
  from_repository_id?: string;
  to_repository_id?: string;
}

export interface StatusData {
  machine_id: string;
  repository_key?: string;
  scopes: Array<{ type: "global" | "machine" | "repository"; id: string }>;
  data_root: string;
  caps: {
    napkin_category: number;
    context_characters: number;
  };
  capabilities: {
    repository_scope: "attached" | "not-repository" | "unavailable";
    requires_reattach_on_move: boolean;
  };
  degradations: string[];
}

export interface ConfigStatusData {
  data_root: string;
  caps: {
    napkin_category: number;
    context_characters: number;
  };
  capabilities: StatusData["capabilities"];
  degradations: string[];
}

export type RuntimeEnvironmentResolver = (
  cwd: string,
  options?: RuntimeEnvironmentOptions,
) => Promise<RuntimeEnvironmentResult>;

export interface StatusOptions {
  runtime?: RuntimeEnvironmentResolver;
  runtimeOptions?: RuntimeEnvironmentOptions;
}

export async function getHeadlessStatus(
  cwd: string,
  options: StatusOptions = {},
): Promise<HeadlessResponse<StatusData | DegradedDiagnosticData | Record<string, never>>> {
  const environment = await (options.runtime ?? resolveRuntimeEnvironment)(cwd, options.runtimeOptions);
  if (environment.status === "setup-needed") return setupNeeded();
  if (environment.status === "degraded") return degradedEnvironment(environment);

  const data = statusData(environment, options.runtimeOptions?.env ?? process.env);
  return environment.degradations.length === 0
    ? headlessOk("ready", "clasi is ready.", data)
    : headlessPartial(
        "repository-capability-limited",
        "clasi is ready with limited repository context.",
        data,
        ["Run clasi doctor."],
      );
}

export async function getHeadlessConfig(
  cwd: string,
  options: StatusOptions = {},
): Promise<HeadlessResponse<ConfigStatusData | DegradedDiagnosticData | Record<string, never>>> {
  const environment = await (options.runtime ?? resolveRuntimeEnvironment)(cwd, options.runtimeOptions);
  if (environment.status === "setup-needed") return setupNeeded();
  if (environment.status === "degraded") return degradedEnvironment(environment);

  const status = statusData(environment, options.runtimeOptions?.env ?? process.env);
  const data: ConfigStatusData = {
    data_root: status.data_root,
    caps: status.caps,
    capabilities: status.capabilities,
    degradations: status.degradations,
  };
  return environment.degradations.length === 0
    ? headlessOk("config-ready", "clasi configuration is ready.", data)
    : headlessPartial(
        "config-partial",
        "clasi configuration is ready with limited repository context.",
        data,
        ["Run clasi doctor."],
      );
}

export function degradedDiagnosticData(
  reasonCode: string,
  input: Partial<Pick<
    DegradedDiagnosticData,
    | "affected_scope"
    | "document_type"
    | "disabled_reads"
    | "disabled_writes"
    | "last_good_active"
    | "unaffected_operations"
    | "recovery_command"
  >> = {},
): DegradedDiagnosticData {
  return {
    reason_code: reasonCode,
    affected_scope: input.affected_scope ?? "runtime",
    document_type: input.document_type ?? null,
    disabled_reads: input.disabled_reads ?? ["memory"],
    disabled_writes: input.disabled_writes ?? ["memory"],
    last_good_active: input.last_good_active ?? false,
    unaffected_operations: input.unaffected_operations ?? ["help", "version", "doctor"],
    recovery_command: input.recovery_command ?? "clasi doctor",
  };
}

function statusData(environment: RuntimeEnvironmentReady, env: NodeJS.ProcessEnv): StatusData {
  const home = env.HOME ?? env.USERPROFILE;
  return {
    machine_id: environment.machineId,
    scopes: environment.scopes.map(scope => ({ type: scope.type, id: scope.id })),
    data_root: home ? collapseHomePath(environment.config.dataRoot, home) : "configured",
    caps: {
      napkin_category: environment.config.napkinCategoryCap,
      context_characters: environment.config.contextCharacterCap,
    },
    capabilities: {
      repository_scope: environment.capabilities.repositoryScope,
      requires_reattach_on_move: environment.capabilities.requiresReattachOnMove,
    },
    degradations: [...environment.degradations],
    ...(environment.repositoryKey ? { repository_key: environment.repositoryKey } : {}),
  };
}

function setupNeeded(): HeadlessResponse<Record<string, never>> {
  return headlessSetupNeeded(
    "setup-needed",
    "clasi setup is required.",
    {},
    ["Run clasi setup."],
  );
}

function degradedEnvironment(
  environment: Extract<RuntimeEnvironmentResult, { status: "degraded" }>,
): HeadlessResponse<DegradedDiagnosticData> {
  const migration = environment.code === "repository-migration-required"
    ? {
        affected_scope: "repository" as const,
        recovery_command: `clasi migrate --from ${environment.migration.fromRepositoryKey} --to ${environment.migration.toRepositoryKey} --confirm`,
        from_repository_id: environment.migration.fromRepositoryKey,
        to_repository_id: environment.migration.toRepositoryKey,
      }
    : {};
  return headlessDegraded(
    environment.code,
    "clasi is degraded. Run the recovery command before using memory features.",
    {
      ...degradedDiagnosticData(environment.code, migration),
      ...migration,
    },
    ["Run the recovery command shown in data."],
  );
}
