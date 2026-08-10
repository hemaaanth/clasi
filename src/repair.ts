import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { runJsonCommand, runProcess } from "./exec.ts";
import type { ProcessAdapter, ProcessResult } from "./exec.ts";
import { isOpaqueId } from "./ids.ts";
import type { ScopeRef } from "./paths.ts";
import type {
  CurateNapkinInput,
  NapkinCurateResult,
} from "./napkin-service.ts";
import type {
  DurableNapkinProposalInput,
  PapercutArchiveResult,
  PapercutGetResult,
  PapercutTransitionResult,
} from "./papercut-service.ts";
import type { PapercutRecord, RepairState } from "./schema.ts";
import { scanExcludedData } from "./privacy.ts";
import { resolveRuntimeEnvironment } from "./runtime-environment.ts";

const PASEO_PREFERENCES_MAX_BYTES = 16_384;
const PASEO_TIMEOUT_MS = 30_000;
const PASEO_MAX_OUTPUT_BYTES = 65_536;
const DEFAULT_IMPLEMENTATION_PROVIDER = "codex/gpt-5.4";

export interface RepairHandoff {
  readonly schemaVersion: 1;
  readonly repositoryKey: string;
  readonly papercutId: string;
  readonly summary: string;
  readonly prevention: string;
  readonly acceptanceCondition: string;
  readonly repairState: RepairState;
}

export type RepairEffectResult =
  | { status: "acknowledged" }
  | { status: "definitive-failure"; code: string }
  | { status: "ambiguous"; code: string };

export type RepairCancellationResult =
  | { status: "canceled" }
  | { status: "too-late" }
  | { status: "ambiguous" };

export interface RepairDispatchAdapter {
  availability?(): Promise<"available" | "unavailable" | "unauthenticated">;
  dispatch(handoff: RepairHandoff, cwd: string): Promise<RepairEffectResult>;
  cancel?(handoff: RepairHandoff, cwd: string): Promise<RepairCancellationResult>;
}

export interface RepairVerifier {
  verify(
    handoff: RepairHandoff,
    cwd: string,
  ): Promise<{ status: "passed" | "failed" | "ambiguous" }>;
}

export interface RepairPapercuts {
  get(scope: ScopeRef, id: string): Promise<PapercutGetResult>;
  queueRepair(scope: ScopeRef, id: string): Promise<PapercutTransitionResult>;
  reportRepair(
    scope: ScopeRef,
    id: string,
    outcome: "dispatched" | "running" | "awaiting_verification" | "failed" | "indeterminate",
  ): Promise<PapercutTransitionResult>;
  verifyRepair(scope: ScopeRef, id: string, accepted: boolean): Promise<PapercutTransitionResult>;
  reconcileRepair(
    scope: ScopeRef,
    id: string,
    outcome: "queued" | "dispatched" | "running" | "awaiting_verification" | "failed",
  ): Promise<PapercutTransitionResult>;
  resubmitRepair(scope: ScopeRef, id: string, confirmed: boolean): Promise<PapercutTransitionResult>;
  resolve(
    scope: ScopeRef,
    id: string,
    options?: { durableNapkinProposal?: DurableNapkinProposalInput },
  ): Promise<PapercutArchiveResult>;
}

export interface RepairNapkinCurator {
  curate(input: CurateNapkinInput): Promise<NapkinCurateResult>;
}

export interface RepairServiceOptions {
  papercuts: RepairPapercuts;
  paseo?: RepairDispatchAdapter;
  followUp: RepairDispatchAdapter;
  verifier: RepairVerifier;
  napkin?: RepairNapkinCurator;
  resolveRepositoryKey?: (cwd: string) => Promise<string | null>;
}

export interface RepairIdentityInput {
  repositoryScope: Extract<ScopeRef, { type: "repository" }>;
  repositoryKey: string;
  cutId: string;
}

export interface DispatchRepairInput extends RepairIdentityInput {
  cwd: string;
  confirmed: boolean;
}

export interface ReconcileRepairInput extends RepairIdentityInput {
  confirmed: boolean;
  observedState: "queued" | "dispatched" | "running" | "awaiting_verification" | "failed";
}

export type RepairServiceResult =
  | { status: "dispatched"; adapter: "paseo" | "follow-up" }
  | { status: "canceled" }
  | { status: "reported"; repairState: "running" | "awaiting_verification" | "failed" | "indeterminate" }
  | { status: "verified" }
  | { status: "verification-failed" }
  | { status: "resolved"; napkinOutcome: "not-requested" | "created" | "reinforced" }
  | {
      status: "partially-resolved";
      code: "napkin-candidates" | "napkin-conflict" | "napkin-curation-failed" | "napkin-suggestion-missing";
      candidateIds?: string[];
    }
  | { status: "reconciled"; repairState: ReconcileRepairInput["observedState"] }
  | { status: "failed"; code: string }
  | { status: "indeterminate"; code: string }
  | { status: "rejected"; code: string };

type InFlightRepair = {
  handoff: RepairHandoff;
  cwd: string;
  adapter: RepairDispatchAdapter;
  acknowledged: boolean;
  terminal: RepairServiceResult | undefined;
};

export class RepairService {
  readonly #papercuts: RepairPapercuts;
  readonly #paseo: RepairDispatchAdapter;
  readonly #napkin: RepairNapkinCurator | undefined;
  readonly #followUp: RepairDispatchAdapter;
  readonly #verifier: RepairVerifier;
  readonly #resolveRepositoryKey: (cwd: string) => Promise<string | null>;
  readonly #inFlight = new Map<string, InFlightRepair>();

  constructor(options: RepairServiceOptions) {
    this.#papercuts = options.papercuts;
    this.#paseo = options.paseo ?? createPaseoRepairAdapter();
    this.#followUp = options.followUp;
    this.#verifier = options.verifier;
    this.#resolveRepositoryKey = options.resolveRepositoryKey ?? resolveCurrentRepositoryKey;
    this.#napkin = options.napkin;
  }

  async dispatch(input: DispatchRepairInput): Promise<RepairServiceResult> {
    const invalid = validateDispatchInput(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const targetError = await this.#repositoryTargetError(input);
    if (targetError !== null) return rejected(targetError);
    if (this.#inFlight.has(input.cutId)) return rejected("dispatch-in-progress");

    const record = await this.#loadOpen(input);
    if ("code" in record) return rejected(record.code);
    if (record.repairState !== "none") {
      return rejected(record.repairState === "indeterminate"
        ? "indeterminate-requires-reconciliation"
        : "repair-already-started");
    }

    const queued = await this.#papercuts.queueRepair(input.repositoryScope, input.cutId);
    if (queued.status !== "updated") return rejected(queued.code);
    const handoff = createRepairHandoff(input.repositoryKey, queued.record);
    if (handoff === null) {
      await this.#papercuts.reportRepair(input.repositoryScope, input.cutId, "failed");
      return rejected("unsafe-handoff");
    }
    const selected = await this.#selectAdapter();
    return this.#dispatchQueued(input, handoff, selected.adapter, selected.kind);
  }

  async cancel(input: RepairIdentityInput & { confirmed: boolean }): Promise<RepairServiceResult> {
    const invalid = validateIdentity(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const flight = this.#inFlight.get(input.cutId);
    if (flight === undefined || flight.acknowledged || flight.terminal !== undefined) {
      return rejected("cancellation-unavailable");
    }
    if (flight.adapter.cancel === undefined) return rejected("cancellation-unavailable");

    let cancellation: RepairCancellationResult;
    try {
      cancellation = await flight.adapter.cancel!(flight.handoff, flight.cwd);
    } catch {
      cancellation = { status: "ambiguous" };
    }
    if (cancellation.status === "too-late") return rejected("cancellation-too-late");
    if (cancellation.status === "ambiguous") {
      const result = await this.#recordEffect(input, "indeterminate", "cancellation-ambiguous");
      flight.terminal = result;
      return result;
    }
    const result = await this.#recordEffect(input, "failed", "canceled-before-acknowledgment");
    flight.terminal = result.status === "failed" ? { status: "canceled" } : result;
    return flight.terminal;
  }

  async report(
    input: RepairIdentityInput & {
      repairState: "running" | "awaiting_verification" | "failed" | "indeterminate";
    },
  ): Promise<RepairServiceResult> {
    const invalid = validateIdentity(input);
    if (invalid !== null) return rejected(invalid);
    const result = await this.#papercuts.reportRepair(
      input.repositoryScope,
      input.cutId,
      input.repairState,
    );
    return result.status === "updated"
      ? { status: "reported", repairState: input.repairState }
      : rejected(result.code);
  }

  async reconcile(input: ReconcileRepairInput): Promise<RepairServiceResult> {
    const invalid = validateIdentity(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const record = await this.#loadOpen(input);
    if ("code" in record) return rejected(record.code);
    if (record.repairState !== "indeterminate") return rejected("repair-not-indeterminate");
    const result = await this.#papercuts.reconcileRepair(
      input.repositoryScope,
      input.cutId,
      input.observedState,
    );
    return result.status === "updated"
      ? { status: "reconciled", repairState: input.observedState }
      : rejected(result.code);
  }

  async resubmit(input: DispatchRepairInput): Promise<RepairServiceResult> {
    const invalid = validateDispatchInput(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const targetError = await this.#repositoryTargetError(input);
    if (targetError !== null) return rejected(targetError);
    if (this.#inFlight.has(input.cutId)) return rejected("dispatch-in-progress");
    const current = await this.#loadOpen(input);
    if ("code" in current) return rejected(current.code);
    if (current.repairState !== "indeterminate") return rejected("repair-not-indeterminate");

    const queued = await this.#papercuts.resubmitRepair(
      input.repositoryScope,
      input.cutId,
      true,
    );
    if (queued.status !== "updated") return rejected(queued.code);
    const handoff = createRepairHandoff(input.repositoryKey, queued.record);
    if (handoff === null) {
      await this.#papercuts.reportRepair(input.repositoryScope, input.cutId, "failed");
      return rejected("unsafe-handoff");
    }
    const selected = await this.#selectAdapter();
    return this.#dispatchQueued(input, handoff, selected.adapter, selected.kind);
  }

  async verify(input: DispatchRepairInput): Promise<RepairServiceResult> {
    const invalid = validateDispatchInput(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const targetError = await this.#repositoryTargetError(input);
    if (targetError !== null) return rejected(targetError);
    const record = await this.#loadOpen(input);
    if ("code" in record) return rejected(record.code);
    if (record.repairState !== "awaiting_verification") {
      return rejected("repair-not-awaiting-verification");
    }
    const handoff = createRepairHandoff(input.repositoryKey, record);
    if (handoff === null) return rejected("unsafe-handoff");

    let verification: { status: "passed" | "failed" | "ambiguous" };
    try {
      verification = await this.#verifier.verify(handoff, input.cwd);
    } catch {
      verification = { status: "ambiguous" };
    }
    if (verification.status === "ambiguous") {
      const result = await this.#papercuts.reportRepair(
        input.repositoryScope,
        input.cutId,
        "indeterminate",
      );
      return result.status === "updated"
        ? { status: "indeterminate", code: "verification-ambiguous" }
        : rejected(result.code);
    }
    const result = await this.#papercuts.verifyRepair(
      input.repositoryScope,
      input.cutId,
      verification.status === "passed",
    );
    if (result.status !== "updated") return rejected(result.code);
    return verification.status === "passed"
      ? { status: "verified" }
      : { status: "verification-failed" };
  }

  async resolve(
    input: RepairIdentityInput & {
      confirmed: boolean;
      durableNapkinProposal?: DurableNapkinProposalInput;
    },
  ): Promise<RepairServiceResult> {
    const invalid = validateIdentity(input);
    if (invalid !== null) return rejected(invalid);
    if (input.confirmed !== true) return rejected("confirmation-required");
    const record = await this.#loadOpen(input);
    if ("code" in record) return rejected(record.code);
    if (record.repairState !== "verified") return rejected("repair-not-verified");
    if (input.durableNapkinProposal !== undefined && this.#napkin === undefined) {
      return rejected("napkin-curator-unavailable");
    }
    const result = await this.#papercuts.resolve(
      input.repositoryScope,
      input.cutId,
      input.durableNapkinProposal === undefined
        ? {}
        : { durableNapkinProposal: input.durableNapkinProposal },
    );
    if (result.status !== "archived") return rejected(result.code);
    if (input.durableNapkinProposal === undefined) {
      return { status: "resolved", napkinOutcome: "not-requested" };
    }
    const suggestion = result.napkinProposalSuggestion;
    if (suggestion === undefined) {
      return { status: "partially-resolved", code: "napkin-suggestion-missing" };
    }
    let curated: NapkinCurateResult;
    try {
      curated = await this.#napkin!.curate({
        scope: input.repositoryScope,
        logicalKey: suggestion.logicalKey,
        category: suggestion.category,
        priority: suggestion.priority,
        situation: suggestion.situation,
        action: suggestion.action,
        sourceClassification: suggestion.sourceClassification,
        ...(suggestion.targetId === undefined ? {} : { targetId: suggestion.targetId }),
      });
    } catch {
      return { status: "partially-resolved", code: "napkin-curation-failed" };
    }
    if (curated.status === "created" || curated.status === "reinforced") {
      return { status: "resolved", napkinOutcome: curated.status };
    }
    if (curated.status === "candidates") {
      return {
        status: "partially-resolved",
        code: "napkin-candidates",
        candidateIds: curated.candidateIds,
      };
    }
    return {
      status: "partially-resolved",
      code: curated.status === "conflict" ? "napkin-conflict" : "napkin-curation-failed",
    };
  }

  async #dispatchQueued(
    input: DispatchRepairInput,
    handoff: RepairHandoff,
    adapter: RepairDispatchAdapter,
    kind: "paseo" | "follow-up",
  ): Promise<RepairServiceResult> {
    const flight: InFlightRepair = {
      handoff,
      cwd: input.cwd,
      adapter,
      acknowledged: false,
      terminal: undefined,
    };
    this.#inFlight.set(input.cutId, flight);
    try {
      let effect: RepairEffectResult;
      try {
        effect = await adapter.dispatch(handoff, input.cwd);
      } catch {
        effect = { status: "ambiguous", code: "adapter-crashed" };
      }
      if (flight.terminal !== undefined) return flight.terminal;
      if (effect.status === "acknowledged") {
        flight.acknowledged = true;
        const persisted = await this.#papercuts.reportRepair(
          input.repositoryScope,
          input.cutId,
          "dispatched",
        );
        if (persisted.status === "updated") return { status: "dispatched", adapter: kind };
        await this.#papercuts.reportRepair(input.repositoryScope, input.cutId, "indeterminate");
        return { status: "indeterminate", code: "acknowledgment-state-uncertain" };
      }
      return effect.status === "definitive-failure"
        ? this.#recordEffect(input, "failed", effect.code)
        : this.#recordEffect(input, "indeterminate", effect.code);
    } finally {
      this.#inFlight.delete(input.cutId);
    }
  }

  async #recordEffect(
    input: RepairIdentityInput,
    state: "failed" | "indeterminate",
    code: string,
  ): Promise<RepairServiceResult> {
    const persisted = await this.#papercuts.reportRepair(
      input.repositoryScope,
      input.cutId,
      state,
    );
    if (persisted.status !== "updated") return rejected(persisted.code);
    return state === "failed" ? { status: "failed", code } : { status: "indeterminate", code };
  }

  async #selectAdapter(): Promise<{
    kind: "paseo" | "follow-up";
    adapter: RepairDispatchAdapter;
  }> {
    try {
      if ((await this.#paseo.availability?.()) === "available") {
        return { kind: "paseo", adapter: this.#paseo };
      }
    } catch {
      // Provider discovery has no effect; fallback is safe.
    }
    return { kind: "follow-up", adapter: this.#followUp };
  }

  async #repositoryTargetError(input: DispatchRepairInput): Promise<string | null> {
    let currentKey: string | null;
    try {
      currentKey = await this.#resolveRepositoryKey(input.cwd);
    } catch {
      return "repository-target-unavailable";
    }
    if (currentKey === null) return "repository-target-unavailable";
    return currentKey === input.repositoryKey ? null : "repository-target-mismatch";
  }

  async #loadOpen(input: RepairIdentityInput): Promise<PapercutRecord | { code: string }> {
    let selected: PapercutGetResult;
    try {
      selected = await this.#papercuts.get(input.repositoryScope, input.cutId);
    } catch {
      return { code: "papercut-read-failed" };
    }
    if (selected.status !== "ok") return { code: selected.code };
    return selected.record.lifecycle === "open"
      ? selected.record
      : { code: "papercut-not-open" };
  }
}

export interface PaseoRepairAdapterOptions {
  process?: ProcessAdapter;
  command?: string;
  preferencesPath?: string;
}

export function createPaseoRepairAdapter(
  options: PaseoRepairAdapterOptions = {},
): RepairDispatchAdapter {
  const process = options.process ?? runProcess;
  const command = options.command ?? "paseo";
  const preferencesPath = options.preferencesPath
    ?? join(homedir(), ".paseo", "orchestration-preferences.json");
  return {
    availability: async () => {
      const provider = await readImplementationProvider(preferencesPath);
      const result = await runJsonCommand(command, ["provider", "ls", "--json"], {
        adapter: process,
        timeoutMs: PASEO_TIMEOUT_MS,
        maxOutputBytes: PASEO_MAX_OUTPUT_BYTES,
      });
      if (!result.ok || !Array.isArray(result.value)) return "unavailable";
      const providerName = provider.split("/", 1)[0];
      const entry = result.value.find(value =>
        isObject(value) && Reflect.get(value, "provider") === providerName);
      if (!isObject(entry)) return "unavailable";
      const status = Reflect.get(entry, "status");
      return status === "available" ? "available" : status === "error" ? "unauthenticated" : "unavailable";
    },
    dispatch: async (handoff, cwd) => {
      const provider = await readImplementationProvider(preferencesPath);
      const suffix = handoff.papercutId.slice(-12);
      const result = await process({
        command,
        args: [
          "run",
          "--background",
          "--json",
          "--title",
          `clasi repair ${handoff.papercutId}`,
          "--provider",
          provider,
          "--mode",
          "full-access",
          "--new-workspace",
          "worktree",
          "--worktree-mode",
          "branch-off",
          "--worktree-slug",
          `clasi-repair-${suffix}`,
          "--new-branch",
          `clasi-repair/${suffix}`,
          JSON.stringify(handoff),
        ],
        cwd,
        env: undefined,
        timeoutMs: PASEO_TIMEOUT_MS,
        maxOutputBytes: PASEO_MAX_OUTPUT_BYTES,
      });
      return classifyPaseoDispatch(result);
    },
  };
}

function classifyPaseoDispatch(result: ProcessResult): RepairEffectResult {
  if (result.status === "spawn-failed") {
    return { status: "definitive-failure", code: "paseo-spawn-failed" };
  }
  if (result.status === "timed-out") return { status: "ambiguous", code: "paseo-timeout" };
  if (result.status === "output-too-large") {
    return { status: "ambiguous", code: "paseo-output-uncertain" };
  }
  if (result.exitCode !== 0) {
    return { status: "ambiguous", code: "paseo-exit-uncertain" };
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
    if (
      isObject(value)
      && (typeof Reflect.get(value, "agentId") === "string"
        || typeof Reflect.get(value, "id") === "string")
    ) {
      return { status: "acknowledged" };
    }
  } catch {
    // A successful process without an acknowledgment is ambiguous.
  }
  return { status: "ambiguous", code: "paseo-acknowledgment-missing" };
}

async function readImplementationProvider(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > PASEO_PREFERENCES_MAX_BYTES) return DEFAULT_IMPLEMENTATION_PROVIDER;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const providers = isObject(value) ? Reflect.get(value, "providers") : undefined;
    const implementation = isObject(providers) ? Reflect.get(providers, "impl") : undefined;
    return typeof implementation === "string" && /^[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(implementation)
      ? implementation
      : DEFAULT_IMPLEMENTATION_PROVIDER;
  } catch {
    return DEFAULT_IMPLEMENTATION_PROVIDER;
  }
}

async function resolveCurrentRepositoryKey(cwd: string): Promise<string | null> {
  const environment = await resolveRuntimeEnvironment(cwd);
  if (
    environment.status !== "ready"
    || environment.repositoryKey === undefined
    || !environment.scopes.some(scope =>
      scope.type === "repository" && scope.id === environment.repositoryKey)
  ) {
    return null;
  }
  return environment.repositoryKey;
}

function createRepairHandoff(repositoryKey: string, record: PapercutRecord): RepairHandoff | null {
  if (
    !isOpaqueId(repositoryKey, "repo")
    || !isOpaqueId(record.id, "cut")
    || !safeHandoffText(record.summary)
    || !safeHandoffText(record.prevention)
    || !safeHandoffText(record.acceptanceCondition)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    repositoryKey,
    papercutId: record.id,
    summary: record.summary,
    prevention: record.prevention,
    acceptanceCondition: record.acceptanceCondition,
    repairState: record.repairState,
  });
}

function safeHandoffText(value: string): boolean {
  return value.length > 0
    && value.length <= 240
    && !/[\r\n]/.test(value)
    && scanExcludedData(value).ok;
}

function validateDispatchInput(input: DispatchRepairInput): string | null {
  const invalid = validateIdentity(input);
  if (invalid !== null) return invalid;
  return typeof input.cwd === "string" && isAbsolute(input.cwd) ? null : "invalid-cwd";
}

function validateIdentity(input: RepairIdentityInput): string | null {
  if (
    input.repositoryScope?.type !== "repository"
    || !isOpaqueId(input.repositoryScope.id, "repo")
    || !isOpaqueId(input.repositoryKey, "repo")
    || input.repositoryScope.id !== input.repositoryKey
  ) {
    return "repository-scope-not-applicable";
  }
  return isOpaqueId(input.cutId, "cut") ? null : "invalid-cut-id";
}

function rejected(code: string): RepairServiceResult {
  return { status: "rejected", code };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
