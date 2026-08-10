import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ActiveView } from "./active-view.ts";
import type { ActiveViewResult } from "./active-view.ts";
import { runClasiCommand } from "./commands.ts";
import type { ClasiCommandOptions } from "./commands.ts";
import { ContextService } from "./context-service.ts";
import type { ContextCandidate, ContextScopeRead } from "./context-service.ts";
import { ImpactService } from "./impact-service.ts";
import type { ImpactWriteResult } from "./impact-service.ts";
import { NapkinService } from "./napkin-service.ts";
import type {
  CurateNapkinInput,
  MarkNapkinHitInput,
  NapkinCurateResult,
  NapkinHitResult,
  NapkinListResult,
} from "./napkin-service.ts";
import type { ScopeRef } from "./paths.ts";
import { PapercutService } from "./papercut-service.ts";
import type {
  CapturePapercutInput,
  CapturePapercutResult,
  PapercutListResult,
  PapercutTransitionResult,
} from "./papercut-service.ts";
import { ProposalService } from "./proposal-service.ts";
import type { ContextSubmissionOutcome } from "./proposal-service.ts";
import { resolveRuntimeEnvironment } from "./runtime-environment.ts";
import type {
  RuntimeEnvironmentReady,
  RuntimeEnvironmentResult,
} from "./runtime-environment.ts";
import type { ClasiRefreshResult, ClasiRuntime } from "./runtime-types.ts";
import { CLASI_TOOL_NAMES } from "./tools.ts";
import type { ClasiJsonValue, ClasiToolName, ClasiToolOutcome } from "./tools.ts";

const READ_TOOL_FIELDS = ["scope", "scopeId"] as const;
const SAFE_REPAIR_REPORTS = [
  "running",
  "awaiting_verification",
  "failed",
  "indeterminate",
] as const;

export interface ConfiguredRuntimeServices {
  context: {
    readScope(scope: ScopeRef): Promise<ContextScopeRead>;
  };
  proposals: {
    submitContext(candidate: ContextCandidate): Promise<ContextSubmissionOutcome>;
  };
  napkin: {
    list(scope: ScopeRef): Promise<NapkinListResult>;
    curate(input: CurateNapkinInput): Promise<NapkinCurateResult>;
    markHit(input: MarkNapkinHitInput): Promise<NapkinHitResult>;
  };
  papercuts: {
    inbox(scope: ScopeRef, options?: { limit?: number }): Promise<PapercutListResult>;
    capture(input: CapturePapercutInput): Promise<CapturePapercutResult>;
    reportRepair(
      scope: ScopeRef,
      id: string,
      outcome: "dispatched" | "running" | "awaiting_verification" | "failed" | "indeterminate",
    ): Promise<PapercutTransitionResult>;
  };
  activeView: {
    build(scopes: readonly ScopeRef[]): Promise<ActiveViewResult>;
  };
  impact: {
    recordInjectedCharacters(machineId: string, characters: number): Promise<ImpactWriteResult>;
  };
}

export interface ConfiguredClasiRuntimeOptions {
  resolveEnvironment?: (cwd: string) => Promise<RuntimeEnvironmentResult>;
  createServices?: (environment: RuntimeEnvironmentReady) => ConfiguredRuntimeServices;
  commandOptions?: ClasiCommandOptions;
}

type CurrentRuntime = {
  scopeKey: string;
  machineId: string;
  scopes: readonly ScopeRef[];
  services: ConfiguredRuntimeServices;
};

type CachedView = {
  scopeKey: string;
  content: string;
};

export function createConfiguredClasiRuntime(
  options: ConfiguredClasiRuntimeOptions = {},
): ClasiRuntime {
  return new ConfiguredClasiRuntime(options);
}

class ConfiguredClasiRuntime implements ClasiRuntime {
  readonly #resolveEnvironment: (cwd: string) => Promise<RuntimeEnvironmentResult>;
  readonly #createServices: (environment: RuntimeEnvironmentReady) => ConfiguredRuntimeServices;
  readonly #commandOptions: ClasiCommandOptions;
  #current: CurrentRuntime | undefined;
  #cache: CachedView | undefined;
  #refreshGeneration = 0;

  constructor(options: ConfiguredClasiRuntimeOptions) {
    this.#resolveEnvironment = options.resolveEnvironment ?? resolveRuntimeEnvironment;
    this.#createServices = options.createServices ?? createDefaultServices;
    this.#commandOptions = options.commandOptions ?? {};
  }

  async refresh(cwd: string): Promise<ClasiRefreshResult> {
    const generation = ++this.#refreshGeneration;
    let environment: RuntimeEnvironmentResult;
    try {
      environment = await this.#resolveEnvironment(cwd);
    } catch {
      if (generation === this.#refreshGeneration) this.#clear();
      return { status: "degraded", code: "runtime-environment-unavailable", notify: true };
    }
    if (generation !== this.#refreshGeneration) {
      return { status: "degraded", code: "refresh-superseded" };
    }
    if (environment.status !== "ready") {
      this.#clear();
      return { ...environment, notify: true };
    }

    const scopeKey = normalizedScopeKey(environment.scopes);
    const sameScope = this.#cache?.scopeKey === scopeKey;
    if (!sameScope) this.#clear();

    let services: ConfiguredRuntimeServices;
    try {
      services = this.#createServices(environment);
    } catch {
      return { status: "degraded", code: "service-construction-failed", notify: true };
    }
    const current: CurrentRuntime = {
      scopeKey,
      machineId: environment.machineId,
      scopes: environment.scopes,
      services,
    };
    this.#current = current;
    const view = await this.#buildView(current);
    if (generation !== this.#refreshGeneration) {
      return { status: "degraded", code: "refresh-superseded" };
    }
    if (view.status !== "ok") {
      if (!sameScope) this.#cache = undefined;
      return { status: "degraded", code: "active-view-unavailable", notify: true };
    }
    this.#cache = { scopeKey, content: view.content };
    return { status: "ready" };
  }

  readContext(): string | undefined {
    return this.#cache?.content;
  }

  async recordInjection(characters: number): Promise<void> {
    const current = this.#current;
    if (current === undefined || !Number.isSafeInteger(characters) || characters <= 0) return;
    try {
      await current.services.impact.recordInjectedCharacters(current.machineId, characters);
    } catch {
      // Metrics must never interrupt the host request.
    }
  }

  async handleCommand(args: string, context: ExtensionContext): Promise<void> {
    await runClasiCommand(args, context, this.#commandOptions);
  }

  async handleTool(
    name: string,
    params: unknown,
    _context: ExtensionContext,
  ): Promise<ClasiToolOutcome> {
    if (!(CLASI_TOOL_NAMES as readonly string[]).includes(name)) {
      return rejected("unknown-tool");
    }
    const current = this.#current;
    if (current === undefined) return unavailable("runtime-not-ready");
    const record = toolParams(params);
    if (record === null) return rejected("invalid-params");
    const scope = applicableScope(record, current.scopes);
    if (scope === null) return rejected("scope-not-applicable");

    switch (name as ClasiToolName) {
      case "clasi_get_context": {
        if (!hasToolFields(record, READ_TOOL_FIELDS, [])) return rejected("invalid-params");
        try {
          const result = await current.services.context.readScope(scope);
          if (result.status === "degraded") return unavailable(result.code);
          return ok({ records: result.status === "ok" ? result.records : [] });
        } catch {
          return unavailable("context-read-failed");
        }
      }
      case "clasi_propose_context": {
        if (!hasToolFields(record, [
          ...READ_TOOL_FIELDS,
          "logicalKey",
          "kind",
          "value",
          "sourceClassification",
          "priority",
        ], ["logicalKey", "kind", "value", "sourceClassification"], ["priority"])) {
          return rejected("invalid-params");
        }
        const result = await safeCall(() => current.services.proposals.submitContext({
          scope,
          logicalKey: record.logicalKey as string,
          kind: record.kind as ContextCandidate["kind"],
          value: record.value as string,
          sourceClassification: record.sourceClassification as ContextCandidate["sourceClassification"],
          priority: record.priority as number,
        }));
        return this.#finishMutation(current, result, ["activated", "proposed"]);
      }
      case "clasi_get_napkin": {
        if (!hasToolFields(record, READ_TOOL_FIELDS, [])) return rejected("invalid-params");
        try {
          const result = await current.services.napkin.list(scope);
          return result.status === "ok"
            ? ok({ categoryCap: result.categoryCap, records: result.records })
            : rejected(result.code);
        } catch {
          return unavailable("napkin-read-failed");
        }
      }
      case "clasi_curate_napkin": {
        if (!hasToolFields(record, [
          ...READ_TOOL_FIELDS,
          "logicalKey",
          "category",
          "priority",
          "situation",
          "action",
          "sourceClassification",
          "targetId",
        ], ["logicalKey", "category", "situation", "action", "sourceClassification"], ["priority"], ["targetId"])) {
          return rejected("invalid-params");
        }
        const result = await safeCall(() => current.services.napkin.curate({
          scope,
          logicalKey: record.logicalKey as string,
          category: record.category as CurateNapkinInput["category"],
          priority: record.priority as number,
          situation: record.situation as string,
          action: record.action as string,
          sourceClassification: record.sourceClassification as CurateNapkinInput["sourceClassification"],
          ...(record.targetId === undefined ? {} : { targetId: record.targetId as string }),
        }));
        return this.#finishMutation(current, result, ["created", "reinforced"]);
      }
      case "clasi_mark_hit": {
        if (!hasToolFields(record, [...READ_TOOL_FIELDS, "id"], ["id"])) {
          return rejected("invalid-params");
        }
        const result = await safeCall(() => current.services.napkin.markHit({
          scope,
          id: record.id as string,
        }));
        return this.#finishMutation(current, result, ["recorded"]);
      }
      case "clasi_get_papercuts": {
        if (!hasToolFields(record, READ_TOOL_FIELDS, [])) return rejected("invalid-params");
        try {
          const result = await current.services.papercuts.inbox(scope);
          return result.status === "ok" ? ok({ records: result.records }) : rejected(result.code);
        } catch {
          return unavailable("papercut-read-failed");
        }
      }
      case "clasi_capture_papercut": {
        if (!hasToolFields(record, [
          ...READ_TOOL_FIELDS,
          "fingerprint",
          "summary",
          "severity",
          "prevention",
          "acceptanceCondition",
          "sourceClassification",
          "explicitMatchId",
        ], [
          "fingerprint",
          "summary",
          "severity",
          "prevention",
          "acceptanceCondition",
          "sourceClassification",
        ], [], ["explicitMatchId"])) {
          return rejected("invalid-params");
        }
        const result = await safeCall(() => current.services.papercuts.capture({
          scope,
          fingerprint: record.fingerprint as string,
          summary: record.summary as string,
          severity: record.severity as CapturePapercutInput["severity"],
          prevention: record.prevention as string,
          acceptanceCondition: record.acceptanceCondition as string,
          sourceClassification: record.sourceClassification as CapturePapercutInput["sourceClassification"],
          ...(record.explicitMatchId === undefined
            ? {}
            : { explicitMatchId: record.explicitMatchId as string }),
        }));
        return this.#finishMutation(current, result, ["created", "reinforced"]);
      }
      case "clasi_update_repair": {
        if (!hasToolFields(
          record,
          [...READ_TOOL_FIELDS, "id", "repairState"],
          ["id", "repairState"],
        )) {
          return rejected("invalid-params");
        }
        const repairState = record.repairState as string;
        if (!(SAFE_REPAIR_REPORTS as readonly string[]).includes(repairState)) {
          return rejected("repair-transition-not-reportable");
        }
        const result = await safeCall(() => current.services.papercuts.reportRepair(
          scope,
          record.id as string,
          repairState as (typeof SAFE_REPAIR_REPORTS)[number],
        ));
        return this.#finishMutation(current, result, ["updated"]);
      }
    }
  }

  async #finishMutation(
    current: CurrentRuntime,
    result: unknown,
    successfulStatuses: readonly string[],
  ): Promise<ClasiToolOutcome> {
    if (!isRecord(result) || typeof result.status !== "string") {
      return unavailable("service-failed");
    }
    if (result.status === "rejected") {
      return rejected(typeof result.code === "string" ? result.code : "service-rejected");
    }
    if (result.status === "conflict") {
      return {
        status: "conflict",
        code: typeof result.code === "string" ? result.code : "write-conflict",
        changed: false,
      };
    }
    if (result.status === "candidates") {
      const candidateIds = Array.isArray(result.candidateIds)
        ? result.candidateIds.filter((id): id is string => typeof id === "string")
        : [];
      return { status: "candidates", changed: false, candidateIds };
    }
    if (!successfulStatuses.includes(result.status)) return unavailable("service-failed");

    const changed = result.changed !== false;
    if (changed) await this.#rebuildAfterMutation(current);
    return {
      status: "ok",
      changed,
      data: result as unknown as ClasiJsonValue,
    };
  }

  async #rebuildAfterMutation(current: CurrentRuntime): Promise<void> {
    if (this.#current !== current) return;
    const view = await this.#buildView(current);
    if (this.#current === current && view.status === "ok") {
      this.#cache = { scopeKey: current.scopeKey, content: view.content };
    }
  }

  async #buildView(current: CurrentRuntime): Promise<ActiveViewResult> {
    try {
      return await current.services.activeView.build(current.scopes);
    } catch {
      return { status: "unavailable", code: "context-unavailable" };
    }
  }

  #clear(): void {
    this.#current = undefined;
    this.#cache = undefined;
  }
}

function createDefaultServices(environment: RuntimeEnvironmentReady): ConfiguredRuntimeServices {
  const shared = { store: environment.store, paths: environment.paths };
  const context = new ContextService(shared);
  const proposals = new ProposalService(shared);
  const napkin = new NapkinService({
    ...shared,
    categoryCap: environment.config.napkinCategoryCap,
  });
  const papercuts = new PapercutService(shared);
  return {
    context,
    proposals,
    napkin,
    papercuts,
    activeView: new ActiveView({
      context,
      napkin,
      papercuts,
      characterCap: environment.config.contextCharacterCap,
    }),
    impact: new ImpactService(shared),
  };
}

async function safeCall(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch {
    return null;
  }
}

function toolParams(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function hasToolFields(
  params: Record<string, unknown>,
  allowed: readonly string[],
  requiredStrings: readonly string[],
  requiredNumbers: readonly string[] = [],
  optionalStrings: readonly string[] = [],
): boolean {
  return Object.keys(params).every(key => allowed.includes(key))
    && requiredStrings.every(key => typeof params[key] === "string")
    && requiredNumbers.every(key => typeof params[key] === "number")
    && optionalStrings.every(key => params[key] === undefined || typeof params[key] === "string");
}

function applicableScope(
  params: Record<string, unknown>,
  scopes: readonly ScopeRef[],
): ScopeRef | null {
  const type = params.scope;
  const scopeId = params.scopeId;
  if (type === "global") {
    if (scopeId !== undefined) return null;
    return scopes.find(scope => scope.type === "global" && scope.id === "global") ?? null;
  }
  if (type !== "machine" && type !== "repository") return null;
  if (typeof scopeId !== "string") return null;
  return scopes.find(scope => scope.type === type && scope.id === scopeId) ?? null;
}

function normalizedScopeKey(scopes: readonly ScopeRef[]): string {
  const order: Readonly<Record<ScopeRef["type"], number>> = {
    global: 0,
    machine: 1,
    repository: 2,
  };
  return [...scopes]
    .sort((left, right) => order[left.type] - order[right.type] || left.id.localeCompare(right.id))
    .map(scope => `${scope.type}:${scope.id}`)
    .join("|");
}

function ok(data: unknown): ClasiToolOutcome {
  return { status: "ok", changed: false, data: data as ClasiJsonValue };
}

function rejected(code: string): ClasiToolOutcome {
  return { status: "rejected", code, changed: false };
}

function unavailable(code: string): ClasiToolOutcome {
  return { status: "unavailable", code, changed: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
