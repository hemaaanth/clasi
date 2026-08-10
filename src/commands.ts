import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  createDefaultPapercutActionHandler,
  legalPapercutActions,
  PAPERCUT_ACTION_LABELS,
} from "./interactive-actions.ts";
import type {
  PapercutAction,
  PapercutActionHandler,
  PublicationAction,
  RepairObservedState,
  RepositoryPapercutInput,
  VerificationObservation,
} from "./interactive-actions.ts";
import { ConflictService } from "./conflict-service.ts";
import { CoordinationService } from "./coordination-service.ts";
import { ConfigService } from "./config-service.ts";
import { resolveClasiAgentRoot } from "./config.ts";
import { ContextService } from "./context-service.ts";
import { getHeadlessDoctor } from "./doctor.ts";
import { detectCurrentMachineFacts } from "./machine.ts";
import type { MachineFacts } from "./machine.ts";
import { createOpaqueId } from "./ids.ts";
import { ImpactService } from "./impact-service.ts";
import { NapkinService } from "./napkin-service.ts";
import { commitSetup, prepareSetup } from "./onboarding.ts";
import type { PrepareSetupInput, SetupCommitResult, SetupPlan } from "./onboarding.ts";
import { PapercutService } from "./papercut-service.ts";
import type { DurableNapkinProposalInput } from "./papercut-service.ts";
import type { ScopeRef } from "./paths.ts";
import { ProposalService } from "./proposal-service.ts";
import { RepositoryMigration } from "./repository-migration.ts";
import { RepositoryRegistry } from "./repository-registry.ts";
import type { RepositoryLocator } from "./repository-registry.ts";
import { resolveRuntimeEnvironment } from "./runtime-environment.ts";
import type {
  RuntimeEnvironmentReady,
  RuntimeEnvironmentResult,
  RuntimeMigrationContext,
} from "./runtime-environment.ts";
import {
  recoveryBlocker,
  showConfigReview,
  showConflictReview,
  showImpactReview,
  shouldShowCoordinationRecovery,
  showCoordinationReview,
  showRecoveryReview,
} from "./review-views.ts";
import type {
  CommandConfigResult,
  CoordinationReviewService,
  ConfigUpdater,
  ConflictReviewService,
  ImpactReviewService,
  RecoveryHandler,
} from "./review-views.ts";
import {
  NAPKIN_CATEGORIES,
} from "./schema.ts";
import type {
  ContextRecord,
  NapkinRecord,
  PapercutRecord,
  ProposalRecord,
} from "./schema.ts";
import { scanExcludedData } from "./privacy.ts";
import { getHeadlessConfig, getHeadlessStatus } from "./status.ts";

const MAX_UI_TEXT = 600;
const MAX_SETUP_SUMMARY_TEXT = 1_200;
const MAX_OPTION_TEXT = 180;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,79}$/;

type Awaitable<T> = T | Promise<T>;
type ContextResolution = Awaited<ReturnType<ContextService["resolve"]>>;
type ProposalListOutcome = Awaited<ReturnType<ProposalService["list"]>>;
type NapkinListResult = Awaited<ReturnType<NapkinService["list"]>>;
type NapkinHistoryResult = Awaited<ReturnType<NapkinService["history"]>>;
type PapercutListResult = Awaited<ReturnType<PapercutService["inbox"]>>;

export interface ClasiCommandServices {
  context: Pick<ContextService, "resolve">;
  proposals: Pick<ProposalService, "list" | "approveContext" | "dismiss">;
  napkin: Pick<NapkinService, "list" | "history">;
  papercuts: Pick<PapercutService, "inbox">;
  conflicts?: ConflictReviewService;
  impact?: ImpactReviewService;
  coordination?: CoordinationReviewService;
}

export interface InteractiveSetupAnswers {
  machineFacts: MachineFacts;
  globalPreference?: string;
  machinePreference?: string;
  instructionPath?: string;
}

export interface InteractiveSetupWorkflow {
  detectMachineFacts(): Promise<MachineFacts>;
  prepare(answers: InteractiveSetupAnswers): Promise<SetupPlan>;
  commit(plan: SetupPlan): Promise<SetupCommitResult>;
}

export type CommandDiagnosticResult =
  | { status: "ok"; summary: string }
  | { status: "partial" | "setup-needed" | "degraded" | "error"; code: string; summary?: string };

export type CreatePapercutActions = (
  environment: RuntimeEnvironmentReady,
) => Awaitable<PapercutActionHandler>;
export type LoadCommandConfig = (cwd: string) => Promise<CommandConfigResult>;
export type RepositoryMigrationRunResult =
  | { status: "complete" }
  | { status: "incomplete"; code: string };
export type RunCommandRepositoryMigration = (
  context: RuntimeMigrationContext,
) => Promise<RepositoryMigrationRunResult>;

export interface ClasiCommandOptions {
  resolveEnvironment?: (cwd: string) => Promise<RuntimeEnvironmentResult>;
  createServices?: (environment: RuntimeEnvironmentReady) => Awaitable<ClasiCommandServices>;
  createSetup?: (cwd: string) => InteractiveSetupWorkflow;
  status?: (cwd: string) => Promise<CommandDiagnosticResult>;
  doctor?: (cwd: string) => Promise<CommandDiagnosticResult>;
  createPapercutActions?: CreatePapercutActions;
  config?: LoadCommandConfig;
  updateConfig?: ConfigUpdater;
  recovery?: RecoveryHandler;
  runRepositoryMigration?: RunCommandRepositoryMigration;
}

interface CommandDependencies {
  resolveEnvironment: (cwd: string) => Promise<RuntimeEnvironmentResult>;
  createServices: (environment: RuntimeEnvironmentReady) => Awaitable<ClasiCommandServices>;
  createSetup: (cwd: string) => InteractiveSetupWorkflow;
  status: (cwd: string) => Promise<CommandDiagnosticResult>;
  doctor: (cwd: string) => Promise<CommandDiagnosticResult>;
  createPapercutActions: CreatePapercutActions;
  config: LoadCommandConfig;
  updateConfig: ConfigUpdater;
  recovery: RecoveryHandler;
}

interface ScopedRecord<T> {
  scope: ScopeRef;
  record: T;
}

export async function runClasiCommand(
  args: string,
  context: ExtensionContext,
  options: ClasiCommandOptions = {},
): Promise<void> {
  if (!context.hasUI) {
    context.ui.notify("Interactive clasi requires a TUI. Use the headless clasi CLI instead.", "warning");
    return;
  }

  const resolveEnvironment = options.resolveEnvironment ?? resolveRuntimeEnvironment;
  const dependencies: CommandDependencies = {
    resolveEnvironment,
    createServices: options.createServices ?? createDefaultServices,
    createSetup: options.createSetup ?? createDefaultSetup,
    status: options.status ?? defaultStatus,
    doctor: options.doctor ?? defaultDoctor,
    createPapercutActions: options.createPapercutActions ??
      (environment => createDefaultPapercutActionHandler({ environment })),
    config: options.config ?? getHeadlessConfig,
    updateConfig: options.updateConfig ?? createDefaultConfigUpdater(context.cwd, resolveEnvironment),
    recovery: options.recovery ?? createDefaultRecoveryHandler(
      context.cwd,
      resolveEnvironment,
      options.runRepositoryMigration ?? runRepositoryMigration,
    ),
  };
  const command = args.trim().toLowerCase();
  if (command === "" || command === "review") {
    await mainMenu(context, dependencies);
    return;
  }
  if (command === "setup") {
    await setupFlow(context, dependencies.createSetup(context.cwd));
    return;
  }
  if (command === "status") {
    await showDiagnostic(context, "clasi status", () => dependencies.status(context.cwd));
    return;
  }
  if (command === "doctor") {
    await showDiagnostic(context, "clasi doctor", () => dependencies.doctor(context.cwd));
    return;
  }
  if (command === "config") {
    await showConfigReview(
      context,
      () => dependencies.config(context.cwd),
      dependencies.updateConfig,
    );
    return;
  }
  if (["conflicts", "context", "napkin", "papercuts", "history", "impact"].includes(command)) {
    const environment = await safeEnvironment(dependencies, context.cwd);
    await openReadyView(command, environment, context, dependencies);
    return;
  }
  context.ui.notify("Unknown clasi command. Use /clasi to choose an action.", "warning");
}

async function mainMenu(context: ExtensionContext, dependencies: CommandDependencies): Promise<void> {
  let selected = "";
  while (true) {
    const environment = await safeEnvironment(dependencies, context.cwd);
    const blocker = environment.status === "degraded" ? recoveryBlocker(environment.code) : null;
    const coordination: { show: boolean; service?: CoordinationReviewService } = environment.status === "ready"
      ? await inspectCoordinationRecovery(environment, dependencies)
      : { show: false };
    const showRecovery = (blocker !== null && dependencies.recovery !== undefined) || coordination.show;
    const names = [
      ...(showRecovery ? ["Recovery"] : []),
      "Conflicts",
      ...(environment.status === "setup-needed" ? ["Setup"] : []),
      "Status",
      "Config",
      "Context",
      "Napkin",
      "Papercuts",
      "History",
      "Impact",
      "Doctor",
      "Back",
    ];
    const choice = await choose(context, mainMenuTitle(environment), names, selected);
    if (!choice || choice === "Back") return;
    selected = choice;
    if (choice === "Recovery" && environment.status === "ready") {
      await showCoordinationReview(context, coordination.service);
    } else if (choice === "Recovery" && blocker && dependencies.recovery) {
      await showRecoveryReview(context, blocker, dependencies.recovery);
    } else if (choice === "Setup") {
      await setupFlow(context, dependencies.createSetup(context.cwd));
    } else if (choice === "Status") {
      await showDiagnostic(context, "clasi status", () => dependencies.status(context.cwd));
    } else if (choice === "Config") {
      await showConfigReview(
        context,
        () => dependencies.config(context.cwd),
        dependencies.updateConfig,
      );
    } else if (choice === "Doctor") {
      await showDiagnostic(context, "clasi doctor", () => dependencies.doctor(context.cwd));
    } else {
      await openReadyView(choice.toLowerCase(), environment, context, dependencies);
    }
  }
}

async function openReadyView(
  command: string,
  environment: RuntimeEnvironmentResult,
  context: ExtensionContext,
  dependencies: CommandDependencies,
): Promise<void> {
  if (environment.status === "setup-needed") {
    context.ui.notify(`Setup is required before ${viewName(command)} is available.`, "warning");
    return;
  }
  if (environment.status === "degraded") {
    context.ui.notify(`${viewName(command)} is unavailable (${safeCode(environment.code)}).`, "warning");
    return;
  }
  let services: ClasiCommandServices;
  try {
    services = await dependencies.createServices(environment);
  } catch {
    context.ui.notify(`${viewName(command)} is unavailable (service-unavailable).`, "warning");
    return;
  }
  if (command === "conflicts") {
    if (!services.conflicts) {
      context.ui.notify("Conflicts are unavailable (service-unavailable).", "warning");
      return;
    }
    await showConflictReview(context, services.conflicts);
  }
  if (command === "impact") {
    if (!services.impact) {
      context.ui.notify("Impact report unavailable (service-unavailable).", "warning");
      return;
    }
    await showImpactReview(context, services.impact, {
      machineId: environment.machineId,
      scopes: environment.scopes,
    });
  }
  if (command === "context") await contextView(context, environment.scopes, services);
  if (command === "napkin") await napkinView(context, environment.scopes, services);
  if (command === "history") await napkinHistoryView(context, environment.scopes, services);
  if (command === "papercuts") {
    let actions: PapercutActionHandler;
    try {
      actions = await dependencies.createPapercutActions(environment);
    } catch {
      context.ui.notify("Papercut actions are unavailable (service-unavailable).", "warning");
      return;
    }
    await papercutView(context, environment.scopes, services, actions);
  }
}

async function setupFlow(context: ExtensionContext, workflow: InteractiveSetupWorkflow): Promise<void> {
  try {
    const machineFacts = await workflow.detectMachineFacts();
    context.ui.notify(
      `Detected automatically: ${machineFactSummary(machineFacts)}. Recommended defaults require no typing; custom setup has three optional steps.`,
      "info",
    );
    const setupMode = await choose(context, "Set up clasi", [
      "Use recommended defaults — no typing required",
      "Customize 3 optional preferences",
      "Cancel",
    ]);
    if (setupMode === undefined || setupMode === "Cancel") return;

    let globalPreference: string | undefined;
    let machinePreference: string | undefined;
    let instructionPath: string | undefined;
    if (setupMode === "Customize 3 optional preferences") {
      const globalChoice = await choose(context, "Step 1 of 3 · Global preference", [
        "Skip — clasi can learn this later",
        "Add a preference for every repository",
      ]);
      if (globalChoice === undefined) return;
      if (globalChoice === "Add a preference for every repository") {
        globalPreference = await context.ui.input(
          "Global preference",
          "Example: Prefer concise explanations and minimal changes",
        );
        if (globalPreference === undefined) return;
      }

      const machineChoice = await choose(context, "Step 2 of 3 · Machine preference", [
        "Use detected machine facts only",
        "Add a machine-specific preference",
      ]);
      if (machineChoice === undefined) return;
      if (machineChoice === "Add a machine-specific preference") {
        machinePreference = await context.ui.input(
          "Machine-specific preference",
          "Example: Use WSL paths when commands cross into Windows",
        );
        if (machinePreference === undefined) return;
      }

      const instructionChoice = await choose(context, "Step 3 of 3 · Instruction import", [
        "Skip — no instruction file",
        "Import an instruction file for review",
      ]);
      if (instructionChoice === undefined) return;
      if (instructionChoice === "Import an instruction file for review") {
        instructionPath = await context.ui.input(
          "Instruction file",
          "Absolute path to a Markdown instruction file",
        );
        if (instructionPath === undefined) return;
      }
    }

    const plan = await workflow.prepare({
      machineFacts,
      ...(nonempty(globalPreference) ? { globalPreference: globalPreference.trim() } : {}),
      ...(nonempty(machinePreference) ? { machinePreference: machinePreference.trim() } : {}),
      ...(nonempty(instructionPath) ? { instructionPath: instructionPath.trim() } : {}),
    });
    const confirmed = await context.ui.confirm("Finish clasi setup", setupSummary(plan));
    if (!confirmed) return;
    const result = await workflow.commit(plan);
    if (result.status === "cancelled") {
      context.ui.notify("Setup was not committed.", "info");
      return;
    }
    context.ui.notify("clasi is ready. Run /clasi to review what it remembers.", "info");
  } catch (error) {
    context.ui.notify(`Setup is unavailable (${reasonFrom(error, "setup-failed")}).`, "error");
  }
}

async function contextView(
  context: ExtensionContext,
  scopes: readonly ScopeRef[],
  services: ClasiCommandServices,
): Promise<void> {
  let selectedId = "";
  let selectedIndex = 0;
  while (true) {
    let resolution: ContextResolution;
    let proposals: ProposalListOutcome;
    try {
      [resolution, proposals] = await Promise.all([
        services.context.resolve(scopes),
        services.proposals.list(scopes),
      ]);
    } catch {
      context.ui.notify("Context is degraded (read-failed).", "warning");
      return;
    }
    if (resolution.status === "degraded") {
      context.ui.notify(`Context is degraded (${safeCode(resolution.code)}).`, "warning");
      return;
    }
    if (proposals.status === "rejected") {
      context.ui.notify(`Context proposals are degraded (${safeCode(proposals.code)}).`, "warning");
      return;
    }
    const entries: Array<ScopedRecord<ContextRecord> & { state: "active" | "shadowed" | "unapproved" }> = [
      ...resolution.active.map(entry => ({ ...entry, state: "active" as const })),
      ...resolution.shadowed.map(entry => ({ ...entry, state: "shadowed" as const })),
      ...resolution.unapproved.map(entry => ({ ...entry, state: "unapproved" as const })),
    ];
    const proposalEntries = proposals.records.filter(entry => entry.record.status === "open");
    if (entries.length === 0 && proposalEntries.length === 0) {
      context.ui.notify("No Context or pending proposals for the active scopes.", "info");
      return;
    }
    const rows = [
      ...entries.map(entry => ({
        id: entry.record.id,
        label: `[${entry.state}] ${scopeLabel(entry.scope)} · ${entry.record.logicalKey}: ${entry.record.value}`,
        open: () => contextDetail(context, entry),
      })),
      ...proposalEntries.map(entry => ({
        id: entry.record.id,
        label: `[proposal] ${scopeLabel(entry.scope)} · ${entry.record.logicalKey}: ${entry.record.summary}`,
        open: () => proposalDetail(context, entry, services.proposals),
      })),
    ];
    selectedIndex = preservedIndex(rows, selectedId, selectedIndex);
    const choice = await chooseRows(context, "Context review", rows, selectedIndex);
    if (!choice) return;
    selectedId = choice.id;
    selectedIndex = choice.index;
    await choice.open();
  }
}

async function contextDetail(
  context: ExtensionContext,
  entry: ScopedRecord<ContextRecord> & { state: string },
): Promise<void> {
  await choose(context, clip([
    `Context: ${entry.record.logicalKey}`,
    `State: ${entry.state}`,
    `Scope: ${scopeLabel(entry.scope)}`,
    `Kind: ${entry.record.kind}`,
    `Priority: ${entry.record.priority}`,
    `Value: ${entry.record.value}`,
  ].join("\n")), ["Back"]);
}

async function proposalDetail(
  context: ExtensionContext,
  entry: ScopedRecord<ProposalRecord>,
  proposals: ClasiCommandServices["proposals"],
): Promise<void> {
  while (true) {
    const choice = await choose(context, clip([
      `Pending proposal: ${entry.record.logicalKey}`,
      `Scope: ${scopeLabel(entry.scope)}`,
      `Summary: ${entry.record.summary}`,
      `Source: ${entry.record.sourceClassification}`,
    ].join("\n")), ["Approve proposal", "Dismiss proposal", "Back"]);
    if (!choice || choice === "Back") return;
    if (choice === "Approve proposal") {
      const kind = await choose(context, "Choose the Context kind", ["Fact", "Preference", "Back"]);
      if (!kind || kind === "Back") continue;
      const priorityText = await context.ui.input("Context priority", "Integer from 0 to 100");
      if (priorityText === undefined) continue;
      const priority = strictPriority(priorityText);
      if (priority === null) {
        context.ui.notify("Use an integer priority from 0 to 100.", "warning");
        continue;
      }
      const confirmed = await context.ui.confirm(
        "Approve Context proposal",
        `Approve ${entry.record.id} as ${kind.toLowerCase()} with priority ${priority}?`,
      );
      if (!confirmed) continue;
      const result = await proposals.approveContext({
        scope: entry.scope,
        proposalId: entry.record.id,
        kind: kind === "Fact" ? "fact" : "preference",
        priority,
      });
      notifyOutcome(context, "Proposal approved.", result);
      if (result.status === "approved" || result.status === "activation-pending") return;
    } else {
      const confirmed = await context.ui.confirm(
        "Dismiss Context proposal",
        `Dismiss ${entry.record.id}? It will remain in reviewable history.`,
      );
      if (!confirmed) continue;
      const result = await proposals.dismiss(entry.scope, entry.record.id);
      notifyOutcome(context, "Proposal dismissed.", result);
      if (result.status === "dismissed") return;
    }
  }
}

async function napkinView(
  context: ExtensionContext,
  scopes: readonly ScopeRef[],
  services: ClasiCommandServices,
): Promise<void> {
  let selectedId = "";
  let selectedIndex = 0;
  while (true) {
    const loaded = await loadNapkins(scopes, services.napkin);
    if ("code" in loaded) {
      context.ui.notify(`Napkin is degraded (${loaded.code}).`, "warning");
      return;
    }
    const rows = loaded.records.map(entry => ({
      id: `${entry.scope.type}:${entry.scope.id}:${entry.record.id}`,
      label: `[${entry.record.category} ${entry.categoryIndex}/${entry.categoryCap}] ${entry.record.situation}`,
      open: () => napkinDetail(context, entry.scope, entry.record, entry.categoryCap),
    }));
    if (rows.length === 0) {
      context.ui.notify("No active Napkin guidance for the active scopes.", "info");
      return;
    }
    selectedIndex = preservedIndex(rows, selectedId, selectedIndex);
    const choice = await chooseRows(context, "Napkin by category and cap", rows, selectedIndex);
    if (!choice) return;
    selectedId = choice.id;
    selectedIndex = choice.index;
    await choice.open();
  }
}

async function napkinDetail(
  context: ExtensionContext,
  scope: ScopeRef,
  record: NapkinRecord,
  categoryCap: number,
): Promise<void> {
  await choose(context, clip([
    `Napkin: ${record.logicalKey}`,
    `Category: ${record.category} (cap ${categoryCap})`,
    `Scope: ${scopeLabel(scope)}`,
    `Priority: ${record.priority} · recurrence: ${record.recurrence} · hits: ${record.hitCount}`,
    `Situation: ${record.situation}`,
    `Do instead: ${record.action}`,
  ].join("\n")), ["Back"]);
}

async function napkinHistoryView(
  context: ExtensionContext,
  scopes: readonly ScopeRef[],
  services: ClasiCommandServices,
): Promise<void> {
  let histories: Array<{ scope: ScopeRef; result: NapkinHistoryResult }>;
  try {
    histories = await Promise.all(scopes.map(async scope => ({
      scope,
      result: await services.napkin.history(scope),
    })));
  } catch {
    context.ui.notify("Napkin history is degraded (read-failed).", "warning");
    return;
  }
  const rejected = histories.find(entry => entry.result.status === "rejected");
  if (rejected?.result.status === "rejected") {
    context.ui.notify(`Napkin history is degraded (${safeCode(rejected.result.code)}).`, "warning");
    return;
  }
  const rows: Array<{ id: string; label: string; open: () => Promise<void> }> = [];
  for (const entry of histories) {
    if (entry.result.status !== "ok") continue;
    for (const revision of entry.result.revisions) {
      for (const record of revision.demotedRecords) {
        rows.push({
          id: `${entry.scope.type}:${entry.scope.id}:${revision.revisionId}:${record.id}`,
          label: `[demoted] ${scopeLabel(entry.scope)} · ${record.category}: ${record.situation}`,
          open: () => historyDetail(context, entry.scope, revision.revisionId, record),
        });
      }
    }
  }
  if (rows.length === 0) {
    context.ui.notify("No demoted Napkin guidance in validated history.", "info");
    return;
  }
  while (true) {
    const choice = await chooseRows(context, "Validated Napkin history", rows, 0);
    if (!choice) return;
    await choice.open();
  }
}

async function historyDetail(
  context: ExtensionContext,
  scope: ScopeRef,
  revisionId: string,
  record: NapkinRecord,
): Promise<void> {
  await choose(context, clip([
    `Demoted Napkin guidance: ${record.logicalKey}`,
    `Scope: ${scopeLabel(scope)}`,
    `Revision: ${revisionId}`,
    `Situation: ${record.situation}`,
    `Do instead: ${record.action}`,
  ].join("\n")), ["Back"]);
}

async function papercutView(
  context: ExtensionContext,
  scopes: readonly ScopeRef[],
  services: ClasiCommandServices,
  actions: PapercutActionHandler,
): Promise<void> {
  let selectedId = "";
  let selectedIndex = 0;
  while (true) {
    const loaded = await loadPapercuts(scopes, services.papercuts);
    if ("code" in loaded) {
      context.ui.notify(`Papercuts are degraded (${loaded.code}).`, "warning");
      return;
    }
    if (loaded.records.length === 0) {
      context.ui.notify("No open Papercuts for the active scopes.", "info");
      return;
    }
    const rows = loaded.records.map(entry => ({
      id: entry.record.id,
      label: `[${entry.record.lifecycle}/${entry.record.repairState}] ${entry.record.severity} · recurrence ${entry.record.recurrence}: ${entry.record.summary}`,
      open: () => papercutDetail(context, entry, actions),
    }));
    selectedIndex = preservedIndex(rows, selectedId, selectedIndex);
    const choice = await chooseRows(context, "Papercut inbox", rows, selectedIndex);
    if (!choice) return;
    selectedId = choice.id;
    selectedIndex = choice.index;
    await choice.open();
  }
}

async function papercutDetail(
  context: ExtensionContext,
  entry: ScopedRecord<PapercutRecord>,
  handler: PapercutActionHandler,
): Promise<void> {
  const record = entry.record;
  while (true) {
    const available = legalPapercutActions(entry.scope, record);
    const labels = available.map(action => PAPERCUT_ACTION_LABELS[action]);
    const choice = await choose(context, clip([
      `Papercut: ${record.summary}`,
      `Scope: ${scopeLabel(entry.scope)}`,
      `State: ${record.lifecycle} · repair ${record.repairState} · publication ${record.publicationState}`,
      `Severity: ${record.severity} · recurrence: ${record.recurrence}`,
      `Prevention: ${record.prevention}`,
      `Acceptance: ${record.acceptanceCondition}`,
    ].join("\n")), [...labels, "Back"]);
    if (!choice || choice === "Back") return;
    const action = available.find(candidate => PAPERCUT_ACTION_LABELS[candidate] === choice);
    if (action === undefined) continue;
    if (await performPapercutAction(context, entry, action, handler)) return;
  }
}

async function performPapercutAction(
  context: ExtensionContext,
  entry: ScopedRecord<PapercutRecord>,
  action: PapercutAction,
  handler: PapercutActionHandler,
): Promise<boolean> {
  if (action === "dismiss") {
    if (!(await confirmPapercutEffect(
      context,
      "Dismiss Papercut",
      entry,
      "Archive this Papercut as dismissed.",
    ))) return false;
    const result = await handler.dismiss({ scope: entry.scope, cutId: entry.record.id, confirmed: true });
    notifyOutcome(context, "Papercut dismissed.", result);
    return true;
  }
  const target = repositoryActionInput(context, entry);
  if (target === null) return false;
  if (action.startsWith("publication-")) {
    return performPublicationAction(
      context,
      entry,
      action as Extract<PapercutAction, `publication-${string}`>,
      target,
      handler,
    );
  }
  if (action === "repair-dispatch") {
    if (!(await confirmPapercutEffect(
      context,
      "Start repair",
      entry,
      "Queue the repair before dispatching one bounded generalized handoff.",
    ))) return false;
    notifyOutcome(context, "Repair dispatched.", await handler.dispatchRepair(target));
    return true;
  }
  if (action === "repair-cancel") {
    if (!(await confirmPapercutEffect(
      context,
      "Cancel queued repair",
      entry,
      "Cancel the queued repair before acknowledgment.",
    ))) return false;
    notifyOutcome(
      context,
      "Queued repair cancelled.",
      await handler.cancelRepair({ scope: entry.scope, cutId: entry.record.id, confirmed: true }),
    );
    return true;
  }
  if (action === "repair-reconcile") {
    const observed = await choose(
      context,
      "Observed repair state",
      ["queued", "dispatched", "running", "awaiting_verification", "failed", "Back"],
    );
    if (!observed || observed === "Back") return false;
    if (!(await confirmPapercutEffect(
      context,
      "Reconcile repair",
      entry,
      `Persist the explicitly observed repair state: ${observed}.`,
    ))) return false;
    notifyOutcome(context, "Repair reconciled.", await handler.reconcileRepair({
      ...target,
      observedState: observed as RepairObservedState,
    }));
    return true;
  }
  if (action === "repair-resubmit") {
    if (!(await confirmPapercutEffect(
      context,
      "Resubmit repair",
      entry,
      "Queue a new repair dispatch after an indeterminate attempt.",
    ))) return false;
    notifyOutcome(context, "Repair resubmitted.", await handler.resubmitRepair(target));
    return true;
  }
  if (action === "repair-verify") {
    const observed = await choose(
      context,
      "Acceptance observation",
      ["Observed passed", "Observed failed", "Back"],
    );
    if (!observed || observed === "Back") return false;
    const observation: VerificationObservation =
      observed === "Observed passed" ? "passed" : "failed";
    if (!(await confirmPapercutEffect(
      context,
      "Verify repair",
      entry,
      `Persist the acceptance condition as observed ${observation}.`,
    ))) return false;
    notifyOutcome(context, "Repair verification recorded.", await handler.verifyRepair({
      ...target,
      observation,
    }));
    return true;
  }
  if (action === "resolve") {
    const durable = await collectDurableNapkinProposal(context);
    if (durable === null) return false;
    if (!(await confirmPapercutEffect(
      context,
      "Resolve Papercut",
      entry,
      durable.proposal === undefined
        ? "Archive this verified Papercut without copying a lesson."
        : "Archive this verified Papercut and submit the entered durable lesson through normal validation.",
    ))) return false;
    notifyOutcome(context, "Papercut resolved.", await handler.resolve({
      ...target,
      ...(durable.proposal === undefined ? {} : { durableNapkinProposal: durable.proposal }),
    }));
    return true;
  }
  return false;
}

async function performPublicationAction(
  context: ExtensionContext,
  entry: ScopedRecord<PapercutRecord>,
  action: Extract<PapercutAction, `publication-${string}`>,
  target: RepositoryPapercutInput,
  handler: PapercutActionHandler,
): Promise<boolean> {
  const publicationAction = action.slice("publication-".length) as PublicationAction;
  const prepared = await handler.preparePublication({
    action: publicationAction,
    repositoryScope: target.repositoryScope,
    cutId: target.cutId,
    cwd: target.cwd,
  });
  if (prepared.status !== "prepared") {
    notifyOutcome(context, "Publication already complete.", prepared);
    return prepared.status === "published";
  }
  const confirmed = await context.ui.confirm(
    PAPERCUT_ACTION_LABELS[action],
    [
      `Target Papercut: ${entry.record.id}`,
      `Repository: ${prepared.preview.repository}`,
      `Authenticated account: ${prepared.preview.account}`,
      `Issue title: ${prepared.preview.title}`,
      publicationAction === "reconcile"
        ? "Effect: reconcile the prior publication without creating a duplicate."
        : publicationAction === "resubmit"
        ? "Effect: explicitly create a new issue attempt."
        : "Effect: create one GitHub issue.",
    ].join("\n"),
  );
  if (!confirmed) return false;
  const commit = {
    repositoryScope: target.repositoryScope,
    cutId: target.cutId,
    cwd: target.cwd,
    confirmed: true,
    expectedRepository: prepared.preview.repository,
    expectedAccount: prepared.preview.account,
  };
  const result = publicationAction === "publish"
    ? await handler.commitPublication(commit)
    : publicationAction === "reconcile"
    ? await handler.reconcilePublication(commit)
    : await handler.resubmitPublication(commit);
  notifyOutcome(context, "Publication action completed.", result);
  return true;
}

function repositoryActionInput(
  context: ExtensionContext,
  entry: ScopedRecord<PapercutRecord>,
): RepositoryPapercutInput | null {
  if (entry.scope.type !== "repository") return null;
  return {
    repositoryScope: entry.scope,
    repositoryKey: entry.scope.id,
    cutId: entry.record.id,
    cwd: context.cwd,
    confirmed: true,
  };
}

async function confirmPapercutEffect(
  context: ExtensionContext,
  title: string,
  entry: ScopedRecord<PapercutRecord>,
  effect: string,
): Promise<boolean> {
  return context.ui.confirm(
    title,
    `Target: ${entry.record.id} (${scopeLabel(entry.scope)})\nEffect: ${effect}`,
  );
}

async function collectDurableNapkinProposal(
  context: ExtensionContext,
): Promise<{ proposal?: DurableNapkinProposalInput } | null> {
  const remains = await choose(
    context,
    "Does durable guidance remain after the fix?",
    ["No durable lesson", "Add durable lesson", "Back"],
  );
  if (!remains || remains === "Back") return null;
  if (remains === "No durable lesson") return {};
  const logicalKey = await context.ui.input("Durable lesson key", "lowercase-logical-key");
  if (logicalKey === undefined) return null;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(logicalKey)) {
    context.ui.notify("Durable lesson was not submitted (invalid-field).", "warning");
    return null;
  }
  const category = await choose(
    context,
    "Durable lesson category",
    [...NAPKIN_CATEGORIES, "Back"],
  );
  if (!category || category === "Back") return null;
  const priorityText = await context.ui.input("Durable lesson priority", "0-100");
  if (priorityText === undefined) return null;
  const priority = strictPriority(priorityText);
  if (priority === null) {
    context.ui.notify("Durable lesson was not submitted (invalid-field).", "warning");
    return null;
  }
  const situation = await context.ui.input("When this applies", "Generalized situation");
  if (situation === undefined) return null;
  if (!safeLessonText(situation)) {
    context.ui.notify("Durable lesson was not submitted (invalid-field).", "warning");
    return null;
  }
  const action = await context.ui.input("Do instead", "Generalized action");
  if (action === undefined) return null;
  if (!safeLessonText(action)) {
    context.ui.notify("Durable lesson was not submitted (invalid-field).", "warning");
    return null;
  }
  return {
    proposal: {
      durable: true,
      logicalKey,
      category: category as DurableNapkinProposalInput["category"],
      priority,
      situation,
      action,
      sourceClassification: "generalized-derived",
    },
  };
}

function safeLessonText(value: string | undefined): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 240
    && !/[\r\n]/.test(value)
    && scanExcludedData(value).ok;
}

async function loadNapkins(
  scopes: readonly ScopeRef[],
  napkin: ClasiCommandServices["napkin"],
): Promise<
  | { records: Array<ScopedRecord<NapkinRecord> & { categoryCap: number; categoryIndex: number }> }
  | { code: string }
> {
  let results: Array<{ scope: ScopeRef; result: NapkinListResult }>;
  try {
    results = await Promise.all(scopes.map(async scope => ({ scope, result: await napkin.list(scope) })));
  } catch {
    return { code: "read-failed" };
  }
  const rejected = results.find(entry => entry.result.status === "rejected");
  if (rejected?.result.status === "rejected") return { code: safeCode(rejected.result.code) };
  const records: Array<ScopedRecord<NapkinRecord> & { categoryCap: number; categoryIndex: number }> = [];
  for (const entry of results) {
    if (entry.result.status !== "ok") continue;
    const categoryCounts = new Map<string, number>();
    for (const record of entry.result.records) {
      const categoryIndex = (categoryCounts.get(record.category) ?? 0) + 1;
      categoryCounts.set(record.category, categoryIndex);
      records.push({ scope: entry.scope, record, categoryCap: entry.result.categoryCap, categoryIndex });
    }
  }
  return { records };
}

async function loadPapercuts(
  scopes: readonly ScopeRef[],
  papercuts: ClasiCommandServices["papercuts"],
): Promise<{ records: Array<ScopedRecord<PapercutRecord>> } | { code: string }> {
  let results: Array<{ scope: ScopeRef; result: PapercutListResult }>;
  try {
    results = await Promise.all(scopes.map(async scope => ({ scope, result: await papercuts.inbox(scope) })));
  } catch {
    return { code: "storage-unavailable" };
  }
  const rejected = results.find(entry => entry.result.status === "rejected");
  if (rejected?.result.status === "rejected") return { code: safeCode(rejected.result.code) };
  return {
    records: results.flatMap(entry => entry.result.status === "ok"
      ? entry.result.records.map(record => ({ scope: entry.scope, record }))
      : []),
  };
}

async function showDiagnostic(
  context: ExtensionContext,
  title: string,
  load: () => Promise<CommandDiagnosticResult>,
): Promise<void> {
  try {
    const result = await load();
    const suffix = result.status === "ok"
      ? result.summary
      : `${result.summary ? `${result.summary} ` : ""}(${safeCode(result.code)})`;
    context.ui.notify(clip(`${title}: ${result.status}. ${suffix}`), result.status === "ok" ? "info" : "warning");
  } catch {
    context.ui.notify(`${title}: error (diagnostic-unavailable).`, "error");
  }
}

function notifyOutcome(
  context: ExtensionContext,
  success: string,
  result: { status: string; code?: string },
): void {
  if ([
    "approved",
    "dismissed",
    "archived",
    "updated",
    "dispatched",
    "canceled",
    "reported",
    "verified",
    "verification-failed",
    "resolved",
    "reconciled",
    "published",
  ].includes(result.status)) {
    context.ui.notify(success, "info");
    return;
  }
  const code = safeCode(result.code ?? result.status);
  context.ui.notify(`Action not completed (${code}).`, "warning");
}

async function safeEnvironment(
  dependencies: CommandDependencies,
  cwd: string,
): Promise<RuntimeEnvironmentResult> {
  try {
    return await dependencies.resolveEnvironment(cwd);
  } catch {
    return { status: "degraded", code: "invalid-environment" };
  }
}

function mainMenuTitle(environment: RuntimeEnvironmentResult): string {
  if (environment.status === "ready") return "clasi · ready";
  return `clasi · ${environment.status} (${safeCode(environment.code)})`;
}

function viewName(command: string): string {
  if (command === "papercuts") return "Papercuts";
  if (command === "history") return "History";
  return command.charAt(0).toUpperCase() + command.slice(1);
}

async function choose(
  context: ExtensionContext,
  title: string,
  choices: readonly string[],
  selected = "",
): Promise<string | undefined> {
  const options = choices.map((choice, index) => `${index + 1}. ${choice}`);
  const initialIndex = Math.max(0, choices.indexOf(selected));
  const selectedLabel = await context.ui.select(clip(title), options, { initialIndex });
  if (selectedLabel === undefined) return undefined;
  const index = options.indexOf(selectedLabel);
  return index < 0 ? undefined : choices[index];
}

async function chooseRows<T extends { id: string; label: string }>(
  context: ExtensionContext,
  title: string,
  rows: readonly T[],
  initialIndex: number,
): Promise<(T & { index: number }) | undefined> {
  const labels = [...rows.map((row, index) => `${index + 1}. ${clip(row.label, MAX_OPTION_TEXT)}`), `${rows.length + 1}. Back`];
  const selected = await context.ui.select(clip(title), labels, {
    initialIndex: Math.min(initialIndex, Math.max(0, rows.length - 1)),
  });
  if (selected === undefined || selected === labels.at(-1)) return undefined;
  const index = labels.indexOf(selected);
  if (index < 0 || index >= rows.length) return undefined;
  const row = rows[index];
  return row === undefined ? undefined : { ...row, index };
}

function preservedIndex<T extends { id: string }>(rows: readonly T[], id: string, fallback: number): number {
  const matched = rows.findIndex(row => row.id === id);
  return matched >= 0 ? matched : Math.min(fallback, Math.max(0, rows.length - 1));
}

function strictPriority(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d?|100)$/.test(trimmed)) return null;
  return Number(trimmed);
}

function scopeLabel(scope: ScopeRef): string {
  return scope.type;
}

function setupSummary(plan: SetupPlan): string {
  const instructionImport = plan.imports.length > 0
    ? "Ready for review"
    : plan.skippedImports.length > 0
      ? "Skipped by safety checks"
      : "None";
  return clip([
    `Detected automatically: ${machineFactSummary(plan.machineFacts)}`,
    `Global preference: ${plan.globalPreference?.value ?? "None"}`,
    `Machine preference: ${plan.machinePreference?.value ?? "None"}`,
    `Instruction import: ${instructionImport}`,
    "Nothing is written until you finish setup.",
  ].join("\n"), MAX_SETUP_SUMMARY_TEXT);
}

function machineFactSummary(facts: MachineFacts): string {
  return [
    facts.osBoundary ? `OS ${facts.osBoundary}` : undefined,
    facts.architecture ? `Architecture ${facts.architecture}` : undefined,
    `WSL ${facts.wsl.toUpperCase()}`,
    `Container ${facts.container ? "yes" : "no"}`,
    facts.shell ? `Shell ${facts.shell.basename} (${facts.shell.family})` : undefined,
    facts.toolManagers.length > 0 ? `Package managers ${facts.toolManagers.join(", ")}` : undefined,
    facts.filesystemConvention ? `Filesystem ${facts.filesystemConvention}` : undefined,
    facts.cpuBucket ? `CPU ${facts.cpuBucket}` : undefined,
    facts.memoryBucket ? `Memory ${facts.memoryBucket}` : undefined,
  ].filter((value): value is string => value !== undefined).join(" · ");
}


interface CapturedMigration {
  locator: RepositoryLocator;
  fromRepositoryKey: string;
  toRepositoryKey: string;
}

function createDefaultRecoveryHandler(
  cwd: string,
  resolveEnvironment: (cwd: string) => Promise<RuntimeEnvironmentResult>,
  migrate: RunCommandRepositoryMigration,
): RecoveryHandler {
  let expected: CapturedMigration | undefined;
  return {
    available: async blocker => {
      if (blocker !== "repository-migration-required") return [];
      let environment: RuntimeEnvironmentResult;
      try {
        environment = await resolveEnvironment(cwd);
      } catch {
        expected = undefined;
        return [];
      }
      if (
        environment.status !== "degraded"
        || environment.code !== "repository-migration-required"
      ) {
        expected = undefined;
        return [];
      }
      expected = captureMigration(environment.migration);
      return ["repository-migration"];
    },
    describe: async action => {
      if (action !== "repository-migration" || !expected) {
        return { status: "rejected", code: "migration-context-unavailable" };
      }
      return {
        status: "ok",
        target: {
          kind: "repository-migration",
          fromRepositoryId: expected.fromRepositoryKey,
          toRepositoryId: expected.toRepositoryKey,
        },
      };
    },
    run: async (action, confirmed) => {
      if (action !== "repository-migration") {
        return { status: "rejected", code: "invalid-recovery-action" };
      }
      if (!confirmed) return { status: "rejected", code: "confirmation-required" };
      if (!expected) return { status: "rejected", code: "migration-context-unavailable" };
      let environment: RuntimeEnvironmentResult;
      try {
        environment = await resolveEnvironment(cwd);
      } catch {
        return { status: "unavailable", code: "invalid-environment" };
      }
      if (
        environment.status !== "degraded"
        || environment.code !== "repository-migration-required"
        || !sameMigration(expected, environment.migration)
      ) {
        return { status: "rejected", code: "migration-context-changed" };
      }
      let result: RepositoryMigrationRunResult;
      try {
        result = await migrate(environment.migration);
      } catch {
        return { status: "unavailable", code: "migration-failed" };
      }
      if (result.status !== "complete") {
        return { status: "rejected", code: result.code };
      }
      expected = undefined;
      return { status: "ok" };
    },
  };
}

async function runRepositoryMigration(
  context: RuntimeMigrationContext,
): Promise<RepositoryMigrationRunResult> {
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
  try {
    const result = await migration.migrate({
      migrationId: createOpaqueId("migration"),
      locator: context.locator,
      fromRepositoryKey: context.fromRepositoryKey,
      toRepositoryKey: context.toRepositoryKey,
      confirm: true,
    });
    return result.status === "migrated"
      ? { status: "complete" }
      : {
          status: "incomplete",
          code: result.status === "target-exists"
            ? "migration-target-exists"
            : "confirmation-required",
        };
  } catch {
    return { status: "incomplete", code: "migration-failed" };
  }
}

function captureMigration(context: RuntimeMigrationContext): CapturedMigration {
  return {
    locator: { ...context.locator },
    fromRepositoryKey: context.fromRepositoryKey,
    toRepositoryKey: context.toRepositoryKey,
  };
}

function sameMigration(expected: CapturedMigration, current: RuntimeMigrationContext): boolean {
  return expected.fromRepositoryKey === current.fromRepositoryKey
    && expected.toRepositoryKey === current.toRepositoryKey
    && sameLocator(expected.locator, current.locator);
}

function sameLocator(left: RepositoryLocator, right: RepositoryLocator): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "filesystem" && right.kind === "filesystem"
    ? left.device === right.device && left.inode === right.inode
    : left.kind === "path-hash" && right.kind === "path-hash" && left.pathHash === right.pathHash;
}

function createDefaultConfigUpdater(
  cwd: string,
  resolveEnvironment: (cwd: string) => Promise<RuntimeEnvironmentResult>,
): ConfigUpdater {
  return async (field, value) => {
    let environment: RuntimeEnvironmentResult;
    try {
      environment = await resolveEnvironment(cwd);
    } catch {
      return { status: "unavailable", code: "invalid-environment" };
    }
    if (environment.status !== "ready") {
      return { status: "unavailable", code: environment.code };
    }
    const result = await new ConfigService(environment).update({
      ...(field === "napkin-category-cap"
        ? { napkinCategoryCap: value }
        : { contextCharacterCap: value }),
      confirmed: true,
    });
    return result.ok
      ? { status: "updated" }
      : { status: "rejected", code: result.code };
  };
}

async function inspectCoordinationRecovery(
  environment: RuntimeEnvironmentReady,
  dependencies: CommandDependencies,
): Promise<{ show: boolean; service?: CoordinationReviewService }> {
  try {
    const services = await dependencies.createServices(environment);
    const service = services.coordination;
    const show = await shouldShowCoordinationRecovery(service);
    return service ? { show, service } : { show };
  } catch {
    return { show: true };
  }
}

function createDefaultServices(environment: RuntimeEnvironmentReady): ClasiCommandServices {
  const common = { store: environment.store, paths: environment.paths };
  return {
    context: new ContextService(common),
    proposals: new ProposalService(common),
    napkin: new NapkinService({ ...common, categoryCap: environment.config.napkinCategoryCap }),
    papercuts: new PapercutService(common),
    conflicts: new ConflictService(common),
    impact: new ImpactService(common),
    coordination: new CoordinationService({
      ...common,
      controlPin: environment.controlPin,
      dataPin: environment.dataPin,
    }),
  };
}

function createDefaultSetup(_cwd: string): InteractiveSetupWorkflow {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return {
    detectMachineFacts: detectCurrentMachineFacts,
    prepare: async answers => {
      if (!nonempty(home)) throw new Error("invalid-environment");
      const agentRoot = resolveClasiAgentRoot();
      const roots = {
        controlRoot: join(agentRoot, "clasi"),
        dataRoot: process.env.CLASI_HOME ?? join(agentRoot, "clasi", "data"),
      };
      const input: PrepareSetupInput = {
        roots,
        home,
        machineFacts: answers.machineFacts,
        ...(answers.globalPreference
          ? { globalPreference: { logicalKey: "coding-default", value: answers.globalPreference, approved: true } }
          : {}),
        ...(answers.machinePreference
          ? { machinePreference: { logicalKey: "machine-preference", value: answers.machinePreference, approved: true } }
          : {}),
        ...(answers.instructionPath
          ? {
              imports: [{
                sourcePath: answers.instructionPath,
                scope: "global",
                logicalKey: "imported-instructions",
                summary: "Imported instruction guidance pending review.",
              }],
            }
          : {}),
      };
      return prepareSetup(input);
    },
    commit: plan => commitSetup(plan, { confirm: true }),
  };
}

async function defaultStatus(cwd: string): Promise<CommandDiagnosticResult> {
  const { envelope } = await getHeadlessStatus(cwd);
  if (envelope.status === "ok") {
    const data = envelope.data as {
      capabilities?: { repository_scope?: string };
      caps?: { napkin_category?: number; context_characters?: number };
    };
    return {
      status: "ok",
      summary: `repository ${data.capabilities?.repository_scope ?? "unknown"}; Napkin cap ${data.caps?.napkin_category ?? "unknown"}; Context cap ${data.caps?.context_characters ?? "unknown"}`,
    };
  }
  return {
    status: envelope.status === "partial" ||
        envelope.status === "setup-needed" ||
        envelope.status === "degraded"
      ? envelope.status
      : "error",
    code: safeCode(envelope.code),
  };
}

async function defaultDoctor(cwd: string): Promise<CommandDiagnosticResult> {
  const { envelope } = await getHeadlessDoctor(cwd);
  if (envelope.status === "ok") return { status: "ok", summary: "All available checks passed." };
  return {
    status: envelope.status === "partial" ||
        envelope.status === "setup-needed" ||
        envelope.status === "degraded"
      ? envelope.status
      : "error",
    code: safeCode(envelope.code),
  };
}

function nonempty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clip(value: string, maximum = MAX_UI_TEXT): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function safeCode(value: string): string {
  return SAFE_CODE.test(value) ? value : "unavailable";
}

function reasonFrom(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? safeCode(code) : fallback;
}
