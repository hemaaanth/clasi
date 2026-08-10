import type { PapercutArchiveResult, PapercutTransitionResult } from "./papercut-service.ts";
import { PapercutService } from "./papercut-service.ts";
import { NapkinService } from "./napkin-service.ts";
import type { DurableNapkinProposalInput } from "./papercut-service.ts";
import type { ScopeRef } from "./paths.ts";
import { PublicationService } from "./publication.ts";
import type {
  PublicationAction as DomainPublicationAction,
  PublicationCommitInput as DomainPublicationCommitInput,
  PublicationPrepareInput as DomainPublicationPrepareInput,
  PublicationPrepareResult as DomainPublicationPrepareResult,
  PublicationResult,
} from "./publication.ts";
import { RepairService } from "./repair.ts";
import type { ReconcileRepairInput, RepairDispatchAdapter, RepairServiceResult } from "./repair.ts";
import type { RuntimeEnvironmentReady } from "./runtime-environment.ts";
import type { PapercutRecord } from "./schema.ts";

const MAX_FOLLOW_UP_CHARACTERS = 1_400;

export const PAPERCUT_ACTION_LABELS = {
  dismiss: "Dismiss Papercut",
  "publication-publish": "Publish GitHub issue",
  "publication-reconcile": "Reconcile publication",
  "publication-resubmit": "Resubmit publication",
  "repair-dispatch": "Start repair",
  "repair-cancel": "Cancel queued repair",
  "repair-reconcile": "Reconcile repair",
  "repair-resubmit": "Resubmit repair",
  "repair-verify": "Verify repair",
  resolve: "Resolve Papercut",
} as const;
export type PublicationAction = DomainPublicationAction;
export type PublicationCommitInput = DomainPublicationCommitInput;
export type PublicationPrepareInput = DomainPublicationPrepareInput;
export type PublicationPrepareResult = DomainPublicationPrepareResult;
export type PapercutAction = keyof typeof PAPERCUT_ACTION_LABELS;
export type RepositoryScope = Extract<ScopeRef, { type: "repository" }>;
export type RepairObservedState = ReconcileRepairInput["observedState"];
export type VerificationObservation = "passed" | "failed";

export interface PapercutIdentityInput { scope: ScopeRef; cutId: string; confirmed: boolean }
export interface RepositoryPapercutInput {
  repositoryScope: RepositoryScope;
  repositoryKey: string;
  cutId: string;
  cwd: string;
  confirmed: boolean;
}
export type PublicationPreview = Extract<
  PublicationPrepareResult,
  { status: "prepared" }
>["preview"];

export interface PapercutActionHandler {
  dismiss(input: PapercutIdentityInput): Promise<PapercutArchiveResult>;
  preparePublication(input: PublicationPrepareInput): Promise<PublicationPrepareResult>;
  commitPublication(input: PublicationCommitInput): Promise<PublicationResult>;
  reconcilePublication(input: PublicationCommitInput): Promise<PublicationResult>;
  resubmitPublication(input: PublicationCommitInput): Promise<PublicationResult>;
  dispatchRepair(input: RepositoryPapercutInput): Promise<RepairServiceResult>;
  cancelRepair(input: PapercutIdentityInput): Promise<PapercutTransitionResult>;
  reconcileRepair(input: RepositoryPapercutInput & { observedState: RepairObservedState }): Promise<RepairServiceResult>;
  resubmitRepair(input: RepositoryPapercutInput): Promise<RepairServiceResult>;
  verifyRepair(input: RepositoryPapercutInput & { observation: VerificationObservation }): Promise<RepairServiceResult>;
  resolve(input: RepositoryPapercutInput & { durableNapkinProposal?: DurableNapkinProposalInput }): Promise<RepairServiceResult>;
}

interface PublicationWorkflow {
  prepare(input: PublicationPrepareInput): Promise<PublicationPrepareResult>;
  publish(input: PublicationCommitInput): Promise<PublicationResult>;
  reconcile(input: PublicationCommitInput): Promise<PublicationResult>;
  resubmit(input: PublicationCommitInput): Promise<PublicationResult>;
}

export interface DefaultPapercutActionHandlerOptions {
  environment: RuntimeEnvironmentReady;
  sendFollowUp?: (message: string, options: { deliverAs: "followUp" }) => void;
  papercuts?: PapercutService;
  publication?: PublicationWorkflow;
}

export function legalPapercutActions(
  scope: ScopeRef,
  record: PapercutRecord,
): readonly PapercutAction[] {
  if (record.lifecycle !== "open") return [];
  const actions: PapercutAction[] = [];
  if (scope.type === "repository") {
    if (record.repairState === "none" || record.repairState === "failed") {
      actions.push("repair-dispatch");
    } else if (record.repairState === "queued") {
      actions.push("repair-cancel");
    } else if (record.repairState === "awaiting_verification") {
      actions.push("repair-verify");
    } else if (record.repairState === "indeterminate") {
      actions.push("repair-reconcile", "repair-resubmit");
    } else if (
      record.repairState === "verified"
      && ["none", "failed", "published"].includes(record.publicationState)
    ) {
      actions.push("resolve");
    }
    if (record.publicationState === "none" || record.publicationState === "failed") {
      actions.push("publication-publish");
    } else if (record.publicationState === "indeterminate") {
      actions.push("publication-reconcile", "publication-resubmit");
    }
  }
  const repairBlocksDismiss = [
    "queued",
    "dispatched",
    "running",
    "awaiting_verification",
    "indeterminate",
  ].includes(record.repairState);
  const publicationBlocksDismiss = ["pending", "indeterminate"].includes(
    record.publicationState,
  );
  if (!repairBlocksDismiss && !publicationBlocksDismiss) actions.push("dismiss");
  return actions;
}

export function createDefaultPapercutActionHandler(
  options: DefaultPapercutActionHandlerOptions,
): PapercutActionHandler {
  const papercuts = options.papercuts ?? new PapercutService({
    store: options.environment.store,
    paths: options.environment.paths,
  });
  const napkin = new NapkinService({
    store: options.environment.store,
    paths: options.environment.paths,
    categoryCap: options.environment.config.napkinCategoryCap,
  });
  const publication: PublicationWorkflow = options.publication
    ?? new PublicationService({ papercuts });
  const followUp = createPiFollowUpAdapter(options.sendFollowUp);
  const repair = (observation: VerificationObservation = "failed") => new RepairService({
    papercuts,
    followUp,
    verifier: { verify: async () => ({ status: observation }) },
    napkin,
  });
  return {
    dismiss: input => input.confirmed
      ? papercuts.dismiss(input.scope, input.cutId)
      : Promise.resolve({ status: "rejected", code: "confirmation-required" }),
    preparePublication: input => publication.prepare(input),
    commitPublication: input => publication.publish(input),
    reconcilePublication: input => publication.reconcile(input),
    resubmitPublication: input => publication.resubmit(input),
    dispatchRepair: input => repair().dispatch(input),
    cancelRepair: input => input.confirmed
      ? papercuts.cancelQueuedRepair(input.scope, input.cutId)
      : Promise.resolve({ status: "rejected", code: "confirmation-required" }),
    reconcileRepair: input => repair().reconcile(input),
    resubmitRepair: input => repair().resubmit(input),
    verifyRepair: input => repair(input.observation).verify(input),
    resolve: input => repair().resolve(input),
  };
}

export function createPiFollowUpAdapter(sendFollowUp?: (message: string, options: { deliverAs: "followUp" }) => void): RepairDispatchAdapter {
  return {
    availability: async () => sendFollowUp === undefined ? "unavailable" : "available",
    dispatch: async handoff => {
      if (sendFollowUp === undefined) return { status: "definitive-failure", code: "pi-follow-up-unavailable" };
      const message = [
        "clasi repair handoff",
        `Repository: ${handoff.repositoryKey}`,
        `Papercut: ${handoff.papercutId}`,
        `Summary: ${handoff.summary}`,
        `Prevention: ${handoff.prevention}`,
        `Acceptance: ${handoff.acceptanceCondition}`,
        "Work in a fresh isolated workspace. Report running, awaiting_verification, failed, or indeterminate through clasi_update_repair. Do not resolve automatically.",
      ].join("\n");
      if (message.length > MAX_FOLLOW_UP_CHARACTERS) return { status: "definitive-failure", code: "pi-follow-up-oversized" };
      try {
        sendFollowUp(message, { deliverAs: "followUp" });
        return { status: "acknowledged" };
      } catch {
        return { status: "definitive-failure", code: "pi-follow-up-failed" };
      }
    },
  };
}
