import type { HeadlessRequest } from "./cli.ts";
import { HELP_COMMANDS } from "./cli.ts";
import { ConflictService } from "./conflict-service.ts";
import { CoordinationService } from "./coordination-service.ts";
import { ConfigService } from "./config-service.ts";
import { resolveClasiRoots } from "./config.ts";
import { ContextService } from "./context-service.ts";
import { headlessChoiceRequired, headlessDegraded, headlessError, headlessOk, headlessSetupNeeded } from "./headless-response.ts";
import { getHeadlessDoctor } from "./doctor.ts";
import type { HeadlessResponse } from "./headless-response.ts";
import { createOpaqueId } from "./ids.ts";
import { ImpactService } from "./impact-service.ts";
import { detectCurrentMachineFacts } from "./machine.ts";
import { NapkinService } from "./napkin-service.ts";
import { commitSetup, prepareSetup } from "./onboarding.ts";
import { PapercutService } from "./papercut-service.ts";
import type { ScopeRef } from "./paths.ts";
import { ProposalService } from "./proposal-service.ts";
import { PublicationService } from "./publication.ts";
import { createPaseoRepairAdapter, RepairService } from "./repair.ts";
import { RepositoryMigration } from "./repository-migration.ts";
import { RepositoryRegistry } from "./repository-registry.ts";
import { resolveRuntimeEnvironment } from "./runtime-environment.ts";
import type {
  RuntimeEnvironmentReady,
  RuntimeMigrationContext,
} from "./runtime-environment.ts";
import { CLASI_VERSION } from "./runtime-types.ts";
import { getHeadlessConfig, getHeadlessStatus } from "./status.ts";

const GENERIC_NEXT_ACTION = ["Run clasi status."] as const;
export type ReadyServices = {
  context: Pick<ContextService, "resolve">;
  proposals: Pick<ProposalService, "list" | "approveContext" | "dismiss">;
  napkins: Pick<NapkinService, "list" | "history" | "curate">;
  papercuts: Pick<PapercutService,
    | "get"
    | "inbox"
    | "dismiss"
    | "queueRepair"
    | "cancelQueuedRepair"
    | "reportRepair"
    | "verifyRepair"
    | "reconcileRepair"
    | "resubmitRepair"
    | "resolve"
    | "beginPublication"
    | "reportPublication"
    | "reconcilePublication"
    | "resubmitPublication">;
  conflicts: Pick<ConflictService, "list" | "show" | "revalidate" | "activate">;
  impact: Pick<ImpactService, "report">;
};

export interface HeadlessOperationsOptions {
  runtime?: typeof resolveRuntimeEnvironment;
  status?: typeof getHeadlessStatus;
  config?: typeof getHeadlessConfig;
  doctor?: typeof getHeadlessDoctor;
  configService?: (
    environment: RuntimeEnvironmentReady,
  ) => Pick<ConfigService, "read" | "update">;
  setup?: (
    request: Extract<HeadlessRequest, { command: "setup" }>,
  ) => Promise<HeadlessResponse>;
  services?: (environment: RuntimeEnvironmentReady) => ReadyServices;
  migration?: (
    context: RuntimeMigrationContext,
    cwd: string,
    request: Extract<HeadlessRequest, { command: "migrate" }>,
  ) => Promise<HeadlessResponse>;
  coordination?: typeof coordinationResponse;
  publication?: typeof publicationResponse;
  repair?: typeof repairResponse;
}

export async function executeHeadlessRequest(
  request: HeadlessRequest,
  cwd: string,
  options: HeadlessOperationsOptions = {},
): Promise<HeadlessResponse> {
  try {
    if (request.command === "help") return headlessOk("help", "Available clasi commands.", { commands: [...HELP_COMMANDS] });
    if (request.command === "version") return headlessOk("version", "clasi version.", { version: CLASI_VERSION });
    if (request.command === "status") return await (options.status ?? getHeadlessStatus)(cwd);
    if (request.command === "config" && !("action" in request)) {
      return await (options.config ?? getHeadlessConfig)(cwd);
    }
    if (request.command === "doctor") return await (options.doctor ?? getHeadlessDoctor)(cwd);
    if (request.command === "setup") return await (options.setup ?? executeSetup)(request);
    const environment = await (options.runtime ?? resolveRuntimeEnvironment)(cwd);
    if (environment.status === "setup-needed") return headlessSetupNeeded("setup-needed", "clasi setup is required.", {}, ["Run clasi setup."]);
    if (environment.status === "degraded") {
      if (
        environment.code === "repository-migration-required" &&
        request.command === "migrate"
      ) {
        if (
          request.fromRepositoryId !== environment.migration.fromRepositoryKey ||
          request.toRepositoryId !== environment.migration.toRepositoryKey
        ) {
          return rejectedResponse("repository-scope-mismatch");
        }
        if (request.confirm !== true) {
          return headlessChoiceRequired(
            "confirmation-required",
            "Migration requires confirmation.",
            {
              from_repository_id: environment.migration.fromRepositoryKey,
              to_repository_id: environment.migration.toRepositoryKey,
            },
            ["Re-run the command with --confirm."],
          );
        }
        return (options.migration ?? migrationResponse)(
          environment.migration,
          cwd,
          request,
        );
      }
      const data = environment.code === "repository-migration-required"
        ? {
            reason_code: environment.code,
            from_repository_id: environment.migration.fromRepositoryKey,
            to_repository_id: environment.migration.toRepositoryKey,
          }
        : { reason_code: environment.code };
      return headlessDegraded(
        environment.code,
        "clasi is degraded.",
        data,
        environment.code === "repository-migration-required"
          ? ["Run clasi migrate with the displayed repository IDs."]
          : ["Run clasi doctor."],
      );
    }
    return await executeReady(
      request,
      cwd,
      environment,
      (options.services ?? services)(environment),
      options,
    );
  } catch (error) {
    return headlessError(safeErrorCode(error), "The clasi operation failed.", {}, GENERIC_NEXT_ACTION);
  }
}

async function executeSetup(request: Extract<HeadlessRequest, { command: "setup" }>): Promise<HeadlessResponse> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return headlessError("invalid-environment", "Required local environment is unavailable.", {}, []);
  const roots = resolveClasiRoots({ env: { ...process.env, CLASI_HOME: request.root } });
  const result = await commitSetup(await prepareSetup({ roots, home, machineFacts: await detectCurrentMachineFacts() }), { confirm: request.confirm });
  if (result.status !== "committed") return headlessChoiceRequired("confirmation-required", "Setup requires confirmation.", {}, []);
  return headlessOk("setup-complete", "clasi setup completed.", {
    machine_id: result.machineId,
    activated_machine_facts: result.activatedMachineFacts,
    activated_preferences: result.activatedPreferences,
    staged_imports: result.stagedImports,
    skipped_imports: result.skippedImports.map(item => ({ code: item.code })),
  });
}

async function executeReady(
  request: Exclude<HeadlessRequest, {
    command: "help" | "version" | "status" | "setup" | "doctor";
  }>,
  cwd: string,
  environment: RuntimeEnvironmentReady,
  service: ReadyServices,
  options: HeadlessOperationsOptions,
): Promise<HeadlessResponse> {
  switch (request.command) {
    case "config":
      if (!("action" in request)) return rejectedResponse("invalid-action");
      return configResponse(environment, request, options.configService);
    case "context": return contextResponse(service.context, request.scope ? [request.scope] : environment.scopes);
    case "review": return reviewResponse(service, environment.scopes, request.target);
    case "proposals": return proposalResponse(service.proposals, request);
    case "napkin": return napkinResponse(service.napkins, request.scope ? [request.scope] : environment.scopes, request.action);
    case "papercuts": return papercutResponse(service.papercuts, environment.scopes, request);
    case "impact": return resultResponse(await service.impact.report({ machineId: environment.machineId, scopes: environment.scopes }), "impact-ready");
    case "conflicts": return conflictResponse(service.conflicts, request);
    case "migrate": return rejectedResponse("repository-migration-not-required");
    case "locks":
    case "recover-lock":
    case "transactions":
    case "clean-transaction":
      return (options.coordination ?? coordinationResponse)(environment, request);
    case "publish":
    case "resubmit-publication":
    case "reconcile-publication":
      if (
        environment.capabilities.repositoryScope !== "attached" ||
        environment.repositoryKey !== request.scope.id
      ) return rejectedResponse("repository-scope-mismatch");
      return (options.publication ?? publicationResponse)(service.papercuts, cwd, request);
    case "repair":
    case "resubmit-repair":
    case "cancel-repair":
    case "reconcile-repair":
    case "verify":
    case "resolve":
      if (
        environment.capabilities.repositoryScope !== "attached" ||
        environment.repositoryKey !== request.scope.id
      ) return rejectedResponse("repository-scope-mismatch");
      return (options.repair ?? repairResponse)(
        environment,
        service.papercuts,
        service.napkins,
        cwd,
        request,
      );
  }
}

function services(environment: RuntimeEnvironmentReady): ReadyServices {
  const context = new ContextService({ store: environment.store, paths: environment.paths });
  const proposals = new ProposalService({ store: environment.store, paths: environment.paths });
  const napkins = new NapkinService({ store: environment.store, paths: environment.paths, categoryCap: environment.config.napkinCategoryCap });
  const papercuts = new PapercutService({ store: environment.store, paths: environment.paths });
  return {
    context,
    proposals,
    napkins,
    papercuts,
    conflicts: new ConflictService({ store: environment.store, paths: environment.paths }),
    impact: new ImpactService({ store: environment.store, paths: environment.paths }),
  };
}

async function contextResponse(context: ReadyServices["context"], scopes: readonly ScopeRef[]): Promise<HeadlessResponse> {
  const result = await context.resolve(scopes);
  if (result.status !== "ok") return rejectedResponse(result.code);
  return headlessOk("context-ready", "Context is ready.", {
    records: result.active.map(({ scope, record }) => ({ scope, ...record })),
    shadowed: result.shadowed.map(({ scope, record }) => ({ scope, ...record })),
  });
}

async function reviewResponse(service: ReadyServices, scopes: readonly ScopeRef[], target: "context" | "napkin" | "papercuts" | "conflicts" | "all"): Promise<HeadlessResponse> {
  const data: Record<string, unknown> = {};
  if (target === "context" || target === "napkin" || target === "all") {
    const proposals = await service.proposals.list(scopes, { status: "open" });
    if (proposals.status !== "ok") return rejectedResponse(proposals.code);
    data.proposals = target === "all" ? proposals.records : proposals.records.filter(item => item.record.targetType === target);
    data.proposals_truncated = proposals.truncated;
  }
  if (target === "papercuts" || target === "all") {
    const items = await listPapercuts(service.papercuts, scopes);
    if ("code" in items) return rejectedResponse(items.code);
    data.papercuts = items.records;
  }
  if (target === "conflicts" || target === "all") {
    const conflicts = await service.conflicts.list();
    if (conflicts.status !== "ok") return rejectedResponse(conflicts.code);
    data.conflicts = conflicts.conflicts;
    data.conflicts_truncated = conflicts.truncated;
  }
  return headlessOk("review-ready", "Review data is ready.", data);
}

async function proposalResponse(proposals: ReadyServices["proposals"], request: Extract<HeadlessRequest, { command: "proposals" }>): Promise<HeadlessResponse> {
  if (request.action === "list") {
    const result = await proposals.list([request.scope], { status: "all" });
    return result.status === "ok" ? headlessOk("proposals-ready", "Proposals are ready.", { records: result.records, truncated: result.truncated }) : rejectedResponse(result.code);
  }
  if (request.action === "approve") {
    return resultResponse(await proposals.approveContext({ scope: request.scope, proposalId: request.proposalId, kind: request.kind, priority: request.priority }), "proposal-approved");
  }
  return resultResponse(await proposals.dismiss(request.scope, request.proposalId), "proposal-dismissed");
}

async function napkinResponse(napkins: ReadyServices["napkins"], scopes: readonly ScopeRef[], action: "list" | "history"): Promise<HeadlessResponse> {
  const results = await Promise.all(scopes.map(scope => action === "list" ? napkins.list(scope) : napkins.history(scope)));
  const rejected = results.find(result => result.status !== "ok");
  if (rejected?.status === "rejected") return rejectedResponse(rejected.code);
  return headlessOk(`napkin-${action}-ready`, "Napkin data is ready.", { scopes: results.map((result, index) => ({ scope: scopes[index], ...result })) });
}

async function papercutResponse(
  papercuts: ReadyServices["papercuts"],
  scopes: readonly ScopeRef[],
  request: Extract<HeadlessRequest, { command: "papercuts" }>,
): Promise<HeadlessResponse> {
  if (request.action === "list") {
    const listed = await listPapercuts(
      papercuts,
      request.scope ? [request.scope] : scopes,
    );
    return "code" in listed
      ? rejectedResponse(listed.code)
      : headlessOk("papercuts-ready", "Papercuts are ready.", {
          records: listed.records,
        });
  }
  if (request.action === "show") {
    return resultResponse(
      await papercuts.get(request.scope, request.papercutId),
      "papercut-ready",
    );
  }
  return resultResponse(
    await papercuts.dismiss(request.scope, request.papercutId),
    "papercut-dismissed",
  );
}

async function listPapercuts(
  papercuts: ReadyServices["papercuts"],
  scopes: readonly ScopeRef[],
): Promise<
  | { records: Array<{ scope: ScopeRef; record: unknown }> }
  | { code: string }
> {
  const results = await Promise.all(scopes.map(scope => papercuts.inbox(scope)));
  const rejected = results.find(result => result.status !== "ok");
  if (rejected?.status === "rejected") return { code: rejected.code };
  return {
    records: results.flatMap((result, index) =>
      result.status === "ok"
        ? result.records.map(record => ({ scope: scopes[index]!, record }))
        : []),
  };
}

async function conflictResponse(
  conflicts: ReadyServices["conflicts"],
  request: Extract<HeadlessRequest, { command: "conflicts" }>,
): Promise<HeadlessResponse> {
  if (request.action === "list") {
    const result = await conflicts.list();
    return result.status === "ok"
      ? headlessOk("conflicts-ready", "Conflicts are ready.", {
          conflicts: result.conflicts,
          truncated: result.truncated,
        })
      : rejectedResponse(result.code);
  }
  if (request.action === "show") {
    return resultResponse(await conflicts.show(request.conflictId), "conflict-ready");
  }
  if (request.action === "revalidate") {
    return resultResponse(
      await conflicts.revalidate(request.conflictId),
      "conflict-revalidated",
    );
  }
  if (request.action === "activate") {
    return resultResponse(
      await conflicts.activate(request.conflictId, request.revisionId, request.confirm),
      "conflict-activated",
    );
  }
  return rejectedResponse("invalid-action");
}

async function configResponse(
  environment: RuntimeEnvironmentReady,
  request: Extract<HeadlessRequest, { command: "config"; action: unknown }>,
  factory: HeadlessOperationsOptions["configService"],
): Promise<HeadlessResponse> {
  const config = factory?.(environment) ?? new ConfigService(environment);
  const current = await config.read();
  if (!current.ok) return rejectedResponse(current.code);
  const data = {
    current: {
      napkin_category_cap: current.config.napkinCategoryCap,
      context_character_cap: current.config.contextCharacterCap,
    },
    requested: {
      napkin_category_cap: request.changes.napkinCategoryCap,
      context_character_cap: request.changes.contextCharacterCap,
    },
  };
  if (request.action === "prepare") {
    return headlessChoiceRequired(
      "confirmation-required",
      "Confirm the configuration update.",
      data,
      ["Re-run the command with --confirm."],
    );
  }
  const updated = await config.update({ ...request.changes, confirmed: request.confirm });
  if (!updated.ok) {
    return updated.code === "confirmation-required"
      ? headlessChoiceRequired(
          updated.code,
          "Confirm the configuration update.",
          data,
          ["Re-run the command with --confirm."],
        )
      : rejectedResponse(updated.code);
  }
  return headlessOk("config-updated", "clasi configuration updated.", {
    previous: {
      napkin_category_cap: updated.previous.napkinCategoryCap,
      context_character_cap: updated.previous.contextCharacterCap,
    },
    config: {
      napkin_category_cap: updated.config.napkinCategoryCap,
      context_character_cap: updated.config.contextCharacterCap,
    },
    reload_required: true,
  });
}

async function coordinationResponse(
  environment: RuntimeEnvironmentReady,
  request: Extract<HeadlessRequest, {
    command: "locks" | "recover-lock" | "transactions" | "clean-transaction";
  }>,
): Promise<HeadlessResponse> {
  const coordination = new CoordinationService({
    controlPin: environment.controlPin,
    dataPin: environment.dataPin,
    paths: environment.paths,
    store: environment.store,
  });
  const result = request.command === "locks"
    ? await coordination.listLocks()
    : request.command === "recover-lock"
      ? await coordination.recoverLock(request.documentId, request.confirm)
      : request.command === "clean-transaction"
        ? await coordination.cleanTransaction(request.transactionId, request.confirm)
        : await coordination.listTransactions();
  if (result.status === "choice-required") {
    return headlessChoiceRequired(
      result.code,
      "The operation requires confirmation.",
      result,
      ["Re-run the command with --confirm."],
    );
  }
  if (result.status === "rejected") return rejectedResponse(result.code);
  return headlessOk(
    request.command === "transactions"
      ? "transactions-ready"
      : request.command === "locks"
        ? "locks-ready"
        : result.status,
    "Coordination state is ready.",
    result,
  );
}

async function migrationResponse(
  context: RuntimeMigrationContext,
  _cwd: string,
  request: Extract<HeadlessRequest, { command: "migrate" }>,
): Promise<HeadlessResponse> {
  if (
    request.fromRepositoryId !== context.fromRepositoryKey ||
    request.toRepositoryId !== context.toRepositoryKey
  ) {
    return rejectedResponse("repository-scope-mismatch");
  }
  if (request.confirm !== true) {
    return headlessChoiceRequired(
      "confirmation-required",
      "Migration requires confirmation.",
      {
        from_repository_id: context.fromRepositoryKey,
        to_repository_id: context.toRepositoryKey,
      },
      ["Re-run the command with --confirm."],
    );
  }
  const environment = context.environment;
  const registry = new RepositoryRegistry({
    controlPin: environment.controlPin,
    paths: environment.paths,
  });
  const migration = new RepositoryMigration({
    dataPin: environment.dataPin,
    paths: environment.paths,
    store: environment.store,
    registry,
  });
  const result = await migration.migrate({
    migrationId: createOpaqueId("migration"),
    locator: context.locator,
    fromRepositoryKey: context.fromRepositoryKey,
    toRepositoryKey: context.toRepositoryKey,
    confirm: true,
  });
  return result.status === "cancelled"
    ? headlessChoiceRequired(
        "confirmation-required",
        "Migration requires confirmation.",
        {},
        ["Re-run the command with --confirm."],
      )
    : headlessOk("migration-complete", "Repository migration completed.", result);
}

async function publicationResponse(
  papercuts: ReadyServices["papercuts"],
  cwd: string,
  request: Extract<HeadlessRequest, {
    command: "publish" | "resubmit-publication" | "reconcile-publication";
  }>,
): Promise<HeadlessResponse> {
  const publication = new PublicationService({ papercuts });
  const action = request.command === "publish"
    ? "publish"
    : request.command === "resubmit-publication"
      ? "resubmit"
      : "reconcile";
  if (request.action === "prepare") {
    const result = await publication.prepare({
      action,
      repositoryScope: request.scope,
      cutId: request.papercutId,
      cwd,
    });
    if (result.status === "rejected") return rejectedResponse(result.code);
    if (result.status === "published") {
      return headlessOk("already-published", "The Papercut is already published.", result);
    }
    return headlessChoiceRequired(
      "publication-confirmation-required",
      "Confirm the resolved publication target and account.",
      result.preview,
      ["Re-run with --repository, --account, and --confirm."],
    );
  }
  const input = {
    repositoryScope: request.scope,
    cutId: request.papercutId,
    cwd,
    confirmed: request.confirm,
    expectedRepository: request.expectedRepository,
    expectedAccount: request.expectedAccount,
  };
  const result = action === "publish"
    ? await publication.publish(input)
    : action === "resubmit"
      ? await publication.resubmit(input)
      : await publication.reconcile(input);
  return resultResponse(result, "publication-complete");
}

async function repairResponse(
  environment: RuntimeEnvironmentReady,
  papercuts: ReadyServices["papercuts"],
  napkins: ReadyServices["napkins"],
  cwd: string,
  request: Extract<HeadlessRequest, {
    command:
      | "repair"
      | "resubmit-repair"
      | "cancel-repair"
      | "reconcile-repair"
      | "verify"
      | "resolve"
  }>,
): Promise<HeadlessResponse> {
  const repair = new RepairService({
    papercuts,
    napkin: napkins,
    paseo: createPaseoRepairAdapter(),
    followUp: {
      availability: async () => "unavailable",
      dispatch: async () => ({ status: "definitive-failure", code: "follow-up-unavailable" }),
    },
    verifier: { verify: async () => ({ status: "ambiguous" }) },
  });
  const identity = {
    repositoryScope: request.scope,
    repositoryKey: environment.repositoryKey!,
    cutId: request.papercutId,
  };
  if (request.command === "cancel-repair") {
    return resultResponse(
      await papercuts.cancelQueuedRepair(request.scope, request.papercutId),
      "repair-cancelled",
    );
  }
  if (request.command === "repair") {
    return resultResponse(
      await repair.dispatch({ ...identity, cwd, confirmed: request.confirm }),
      "repair-dispatched",
    );
  }
  if (request.command === "resubmit-repair") {
    return resultResponse(
      await repair.resubmit({ ...identity, cwd, confirmed: request.confirm }),
      "repair-resubmitted",
    );
  }
  if (request.command === "reconcile-repair") {
    return resultResponse(
      await repair.reconcile({
        ...identity,
        observedState: request.state,
        confirmed: request.confirm,
      }),
      "repair-reconciled",
    );
  }
  if (request.command === "verify") {
    return resultResponse(
      await papercuts.verifyRepair(
        request.scope,
        request.papercutId,
        request.observed === "passed",
      ),
      request.observed === "passed" ? "repair-verified" : "repair-verification-failed",
    );
  }
  if (request.command === "resolve") {
    const suggestion = request.napkin
      ? {
          durable: true as const,
          logicalKey: request.napkin.logicalKey,
          category: request.napkin.category,
          priority: request.napkin.priority,
          situation: request.napkin.situation,
          action: request.napkin.action,
          sourceClassification: "explicit-user-input" as const,
        }
      : undefined;
    return resultResponse(
      await repair.resolve({
        ...identity,
        confirmed: request.confirm,
        ...(suggestion ? { durableNapkinProposal: suggestion } : {}),
      }),
      "papercut-resolved",
    );
  }
  return rejectedResponse("invalid-action");
}

function resultResponse(result: object, successCode: string): HeadlessResponse {
  const record = result as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : "rejected";
  const reason = typeof record.code === "string"
    ? record.code
    : typeof record.reason === "string"
      ? record.reason
      : "operation-rejected";
  if (status === "rejected" || status === "failed" || status === "indeterminate") {
    return headlessError(reason, "The clasi operation did not complete.", result, GENERIC_NEXT_ACTION);
  }
  if (status === "unavailable" || status === "degraded") {
    return headlessDegraded(reason, "The clasi operation is unavailable.", result, GENERIC_NEXT_ACTION);
  }
  return headlessOk(successCode, "The clasi operation completed.", result);
}

function rejectedResponse(code: string): HeadlessResponse {
  return headlessError(code, "The clasi operation was rejected.", { reason_code: code }, GENERIC_NEXT_ACTION);
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(code)) return code;
  }
  return "operation-failed";
}
