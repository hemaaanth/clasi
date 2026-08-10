import { isAbsolute } from "node:path";
import { createHeadlessResponse, exitCodeForStatus } from "./headless-response.ts";
import type { HeadlessResponse } from "./headless-response.ts";
import { isOpaqueId } from "./ids.ts";
import type { ScopeRef } from "./paths.ts";
import { MAX_BODY_TEXT_CHARACTERS, NAPKIN_CATEGORIES } from "./schema.ts";
import type { NapkinCategory } from "./schema.ts";
import { CLASI_VERSION } from "./runtime-types.ts";

export const HELP_COMMANDS = [
  "help",
  "version",
  "setup",
  "status",
  "config",
  "doctor",
  "context",
  "review",
  "proposals",
  "napkin",
  "history",
  "papercuts",
  "inbox",
  "show",
  "dismiss",
  "impact",
  "conflicts",
  "migrate",
  "locks",
  "recover-lock",
  "transactions",
  "clean-transaction",
  "publish",
  "repair",
  "resubmit-repair",
  "cancel-repair",
  "resubmit-publication",
  "reconcile-repair",
  "reconcile-publication",
  "verify",
  "resolve",
] as const;

export type ReviewTarget = "context" | "napkin" | "papercuts" | "conflicts" | "all";
export type ProposalKind = "fact" | "preference";
export type PublicationCommand =
  | "publish"
  | "resubmit-publication"
  | "reconcile-publication";
export type BasicPapercutLifecycleCommand = "repair" | "resubmit-repair" | "cancel-repair";
export type PapercutLifecycleCommand =
  | PublicationCommand
  | BasicPapercutLifecycleCommand
  | "reconcile-repair"
  | "verify"
  | "resolve";
export type ReconciledRepairState =
  | "queued"
  | "dispatched"
  | "running"
  | "awaiting_verification"
  | "failed";
export interface DurableNapkinRequest {
  logicalKey: string;
  category: NapkinCategory;
  priority: number;
  situation: string;
  action: string;
}
export interface ConfigChanges {
  napkinCategoryCap?: number;
  contextCharacterCap?: number;
}

export type HeadlessRequest =
  | { command: "help" }
  | { command: "version" }
  | { command: "setup"; root: string; confirm: true }
  | { command: "status" }
  | { command: "config" }
  | { command: "config"; action: "prepare"; changes: ConfigChanges }
  | { command: "config"; action: "update"; changes: ConfigChanges; confirm: true }
  | { command: "doctor" }
  | { command: "locks"; action: "list" }
  | { command: "context"; scope?: ScopeRef }
  | { command: "review"; target: ReviewTarget }
  | { command: "proposals"; action: "list"; scope: ScopeRef }
  | {
      command: "proposals";
      action: "approve";
      scope: ScopeRef;
      proposalId: string;
      kind: ProposalKind;
      priority: number;
      confirm: true;
    }
  | {
      command: "proposals";
      action: "dismiss";
      scope: ScopeRef;
      proposalId: string;
      confirm: true;
    }
  | { command: "napkin"; action: "list" | "history"; scope?: ScopeRef }
  | { command: "papercuts"; action: "list"; scope?: ScopeRef }
  | {
      command: "papercuts";
      action: "show";
      scope: ScopeRef;
      papercutId: string;
    }
  | {
      command: "papercuts";
      action: "dismiss";
      scope: ScopeRef;
      papercutId: string;
      confirm: true;
    }
  | { command: "impact" }
  | { command: "conflicts"; action: "list" }
  | { command: "conflicts"; action: "show" | "revalidate"; conflictId: string }
  | {
      command: "conflicts";
      action: "activate";
      conflictId: string;
      revisionId: string;
      confirm: true;
    }
  | {
      command: "migrate";
      fromRepositoryId: string;
      toRepositoryId: string;
      confirm: true;
    }
  | { command: "recover-lock"; documentId: string; confirm: true }
  | { command: "transactions"; action: "list" }
  | { command: "clean-transaction"; transactionId: string; confirm: true }
  | {
      command: PublicationCommand;
      action: "prepare";
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
    }
  | {
      command: PublicationCommand;
      action: "commit";
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
      expectedRepository: string;
      expectedAccount: string;
      confirm: true;
    }
  | {
      command: BasicPapercutLifecycleCommand;
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
      confirm: true;
    }
  | {
      command: "reconcile-repair";
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
      state: ReconciledRepairState;
      confirm: true;
    }
  | {
      command: "verify";
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
      observed: "passed" | "failed";
      confirm: true;
    }
  | {
      command: "resolve";
      scope: Extract<ScopeRef, { type: "repository" }>;
      papercutId: string;
      napkin?: DurableNapkinRequest;
      confirm: true;
    };

export type CliWriter = (line: string) => void;
export type HeadlessExecutor = (
  request: HeadlessRequest,
  cwd: string,
) => HeadlessResponse | Promise<HeadlessResponse>;

export interface RunClasiCliOptions {
  execute?: HeadlessExecutor;
  cwd?: string;
}

type ParseFailure = { ok: false; error: "usage" | "confirmation" };
type ParseResult = HeadlessRequest | ParseFailure;
type FlagKind = "value" | "boolean";
type ParsedFlags = { ok: true; values: Map<string, string | true> } | ParseFailure;
type OptionalScope = { ok: true; scope?: ScopeRef } | ParseFailure;

const USAGE_FAILURE: ParseFailure = { ok: false, error: "usage" };
const CONFIRMATION_FAILURE: ParseFailure = { ok: false, error: "confirmation" };
const SCOPE_FLAG: Record<string, FlagKind> = { "--scope": "value" };
const SETUP_FLAGS: Record<string, FlagKind> = {
  "--root": "value",
  "--confirm": "boolean",
};
const PROPOSAL_LIST_FLAGS: Record<string, FlagKind> = { "--scope": "value" };
const PROPOSAL_APPROVE_FLAGS: Record<string, FlagKind> = {
  "--scope": "value",
  "--id": "value",
  "--kind": "value",
  "--priority": "value",
  "--confirm": "boolean",
};
const SCOPED_CONFIRMED_ID_FLAGS: Record<string, FlagKind> = {
  "--scope": "value",
  "--id": "value",
  "--confirm": "boolean",
};
const SCOPED_ID_FLAGS: Record<string, FlagKind> = {
  "--scope": "value",
  "--id": "value",
};
const ID_FLAG: Record<string, FlagKind> = { "--id": "value" };
const CONFLICT_ACTIVATE_FLAGS: Record<string, FlagKind> = {
  "--id": "value",
  "--revision-id": "value",
  "--confirm": "boolean",
};
const MIGRATE_FLAGS: Record<string, FlagKind> = {
  "--from": "value",
  "--to": "value",
  "--confirm": "boolean",
};
const RECOVER_LOCK_FLAGS: Record<string, FlagKind> = {
  "--document-id": "value",
  "--confirm": "boolean",
};
const TRANSACTION_FLAGS: Record<string, FlagKind> = {
  "--id": "value",
  "--confirm": "boolean",
};
const BASIC_LIFECYCLE_COMMANDS: Record<string, true> = {
  repair: true,
  "resubmit-repair": true,
  "cancel-repair": true,
};
const PUBLICATION_COMMANDS: Record<string, true> = {
  publish: true,
  "resubmit-publication": true,
  "reconcile-publication": true,
};
const PUBLICATION_COMMIT_FLAGS: Record<string, FlagKind> = {
  ...SCOPED_CONFIRMED_ID_FLAGS,
  "--repository": "value",
  "--account": "value",
};
const RECONCILE_REPAIR_FLAGS: Record<string, FlagKind> = {
  ...SCOPED_CONFIRMED_ID_FLAGS,
  "--state": "value",
};
const VERIFY_FLAGS: Record<string, FlagKind> = {
  ...SCOPED_CONFIRMED_ID_FLAGS,
  "--observed": "value",
};
const RESOLVE_FLAGS: Record<string, FlagKind> = {
  ...SCOPED_CONFIRMED_ID_FLAGS,
  "--logical-key": "value",
  "--category": "value",
  "--priority": "value",
  "--situation": "value",
  "--action": "value",
};
const RECONCILED_REPAIR_STATES: Record<string, true> = {
  queued: true,
  dispatched: true,
  running: true,
  awaiting_verification: true,
  failed: true,
};
const REVIEW_TARGETS: Record<string, true> = {
  context: true,
  napkin: true,
  papercuts: true,
  conflicts: true,
  all: true,
};
const CONFIG_FLAGS: Record<string, FlagKind> = {
  "--napkin-category-cap": "value",
  "--context-character-cap": "value",
  "--confirm": "boolean",
};

export async function runClasiCli(
  args: readonly string[],
  write: CliWriter = line => console.log(line),
  options: RunClasiCliOptions = {},
): Promise<number> {
  const parsed = parseRequest(args);
  let response: HeadlessResponse;

  if ("error" in parsed) {
    response = parsed.error === "confirmation"
      ? createHeadlessResponse({
          status: "choice-required",
          code: "confirmation-required",
          message: "Confirmation is required.",
          data: {},
          next_actions: ["Retry with --confirm."],
        })
      : createHeadlessResponse({
          status: "choice-required",
          code: "usage-error",
          message: "Invalid clasi command arguments.",
          data: {},
          next_actions: ["Run clasi help."],
        });
  } else if (parsed.command === "help") {
    response = createHeadlessResponse({
      status: "ok",
      code: "help",
      message: "clasi commands",
      data: { commands: [...HELP_COMMANDS] },
    });
  } else if (parsed.command === "version") {
    response = createHeadlessResponse({
      status: "ok",
      code: "version",
      message: `clasi ${CLASI_VERSION}`,
      data: { version: CLASI_VERSION },
    });
  } else {
    try {
      const execute = options.execute ?? defaultExecute;
      response = await execute(parsed, options.cwd ?? process.cwd());
    } catch {
      response = createHeadlessResponse({
        status: "error",
        code: "backend-failed",
        message: "The clasi command could not be completed.",
        data: {},
      });
    }
  }

  write(JSON.stringify(response.envelope));
  return exitCodeForStatus(response.envelope.status);
}

async function defaultExecute(request: HeadlessRequest, cwd: string): Promise<HeadlessResponse> {
  const modulePath = "./headless-operations.ts";
  const operations = await import(modulePath) as { executeHeadlessRequest?: HeadlessExecutor };
  if (typeof operations.executeHeadlessRequest !== "function") throw new Error("backend-unavailable");
  return operations.executeHeadlessRequest(request, cwd);
}

function parseRequest(args: readonly string[]): ParseResult {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help") {
    return rest.length === 0 ? { command: "help" } : USAGE_FAILURE;
  }
  if (command === "version" || command === "--version") {
    return rest.length === 0 ? { command: "version" } : USAGE_FAILURE;
  }
  if (command === "setup") return parseSetup(rest);
  if (command === "status") return rest.length === 0 ? { command: "status" } : USAGE_FAILURE;
  if (command && PUBLICATION_COMMANDS[command]) {
    return parsePublication(command as PublicationCommand, rest);
  }
  if (command === "config") return parseConfig(rest);
  if (command === "doctor") return rest.length === 0 ? { command: "doctor" } : USAGE_FAILURE;
  if (command === "locks") {
    return rest.length === 0 ? { command: "locks", action: "list" } : USAGE_FAILURE;
  }
  if (command === "impact") return rest.length === 0 ? { command: "impact" } : USAGE_FAILURE;
  if (command === "context") return parseContext(rest);
  if (command === "review") return parseReview(rest);
  if (command === "proposals") return parseProposals(rest);
  if (command === "napkin") return parseNapkin(rest);
  if (command === "history") return parseNapkinAction("history", rest);
  if (command === "papercuts") return parsePapercuts(rest);
  if (command === "inbox") return parsePapercutList(rest);
  if (command === "show" || command === "dismiss") return parsePapercutAction(command, rest);
  if (command === "conflicts") return parseConflicts(rest);
  if (command === "migrate") return parseMigrate(rest);
  if (command === "recover-lock") return parseRecoverLock(rest);
  if (command === "transactions") {
    return rest.length === 1 && rest[0] === "list"
      ? { command: "transactions", action: "list" }
      : USAGE_FAILURE;
  }
  if (command === "clean-transaction") return parseCleanTransaction(rest);
  if (command === "reconcile-repair") return parseReconcileRepair(rest);
  if (command === "verify") return parseVerify(rest);
  if (command === "resolve") return parseResolve(rest);
  if (command && BASIC_LIFECYCLE_COMMANDS[command]) {
    return parseBasicLifecycle(command as BasicPapercutLifecycleCommand, rest);
  }
  return USAGE_FAILURE;
}

function parseSetup(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, SETUP_FLAGS);
  if (!parsed.ok) return parsed;
  const root = flagValue(parsed.values, "--root");
  if (!root || !isAbsolute(root)) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "setup", root, confirm: true };
}

function parseConfig(args: readonly string[]): ParseResult {
  if (args.length === 0) return { command: "config" };
  const parsed = parseFlags(args, CONFIG_FLAGS);
  if (!parsed.ok) return parsed;
  const napkinValue = flagValue(parsed.values, "--napkin-category-cap");
  const contextValue = flagValue(parsed.values, "--context-character-cap");
  if (napkinValue === undefined && contextValue === undefined) return USAGE_FAILURE;
  if (
    napkinValue !== undefined &&
    !/^(?:[1-9]|1\d|20)$/.test(napkinValue)
  ) return USAGE_FAILURE;
  if (
    contextValue !== undefined &&
    !/^(?:[5-9]\d{2}|[1-5]\d{3}|6000)$/.test(contextValue)
  ) return USAGE_FAILURE;
  const changes = {
    ...(napkinValue === undefined ? {} : { napkinCategoryCap: Number(napkinValue) }),
    ...(contextValue === undefined ? {} : { contextCharacterCap: Number(contextValue) }),
  };
  return parsed.values.has("--confirm")
    ? { command: "config", action: "update", changes, confirm: true }
    : { command: "config", action: "prepare", changes };
}

function parseContext(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, SCOPE_FLAG);
  if (!parsed.ok) return parsed;
  const scopeValue = flagValue(parsed.values, "--scope");
  if (scopeValue === undefined) return { command: "context" };
  const scope = parseScope(scopeValue);
  return scope ? { command: "context", scope } : USAGE_FAILURE;
}

function parseReview(args: readonly string[]): ParseResult {
  if (args.length === 0) return { command: "review", target: "all" };
  const target = args[0];
  if (args.length !== 1 || !target || !REVIEW_TARGETS[target]) return USAGE_FAILURE;
  return { command: "review", target: target as ReviewTarget };
}

function parseProposals(args: readonly string[]): ParseResult {
  const [action, ...rest] = args;
  if (action === "list") {
    const parsed = parseFlags(rest, PROPOSAL_LIST_FLAGS);
    if (!parsed.ok) return parsed;
    const scope = parseRequiredScope(parsed.values);
    return scope ? { command: "proposals", action: "list", scope } : USAGE_FAILURE;
  }
  if (action === "approve") return parseProposalApprove(rest);
  if (action === "dismiss") return parseProposalDismiss(rest);
  return USAGE_FAILURE;
}

function parseProposalApprove(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, PROPOSAL_APPROVE_FLAGS);
  if (!parsed.ok) return parsed;
  const scope = parseRequiredScope(parsed.values);
  const proposalId = flagValue(parsed.values, "--id");
  const kind = flagValue(parsed.values, "--kind");
  const priorityValue = flagValue(parsed.values, "--priority");
  if (
    !scope ||
    !isOpaqueId(proposalId, "proposal") ||
    (kind !== "fact" && kind !== "preference") ||
    !priorityValue ||
    !/^(?:0|[1-9]\d?|100)$/.test(priorityValue)
  ) {
    return USAGE_FAILURE;
  }
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return {
    command: "proposals",
    action: "approve",
    scope,
    proposalId,
    kind,
    priority: Number(priorityValue),
    confirm: true,
  };
}

function parseProposalDismiss(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, SCOPED_CONFIRMED_ID_FLAGS);
  if (!parsed.ok) return parsed;
  const scope = parseRequiredScope(parsed.values);
  const proposalId = flagValue(parsed.values, "--id");
  if (!scope || !isOpaqueId(proposalId, "proposal")) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "proposals", action: "dismiss", scope, proposalId, confirm: true };
}

function parseNapkin(args: readonly string[]): ParseResult {
  const [action, ...rest] = args;
  return action === "list" || action === "history"
    ? parseNapkinAction(action, rest)
    : USAGE_FAILURE;
}

function parseNapkinAction(
  action: "list" | "history",
  args: readonly string[],
): ParseResult {
  const parsed = parseOptionalScope(args);
  if (!parsed.ok) return parsed;
  return parsed.scope
    ? { command: "napkin", action, scope: parsed.scope }
    : { command: "napkin", action };
}

function parsePapercuts(args: readonly string[]): ParseResult {
  const [action, ...rest] = args;
  if (action === "list") return parsePapercutList(rest);
  if (action === "show" || action === "dismiss") return parsePapercutAction(action, rest);
  return USAGE_FAILURE;
}

function parsePapercutList(args: readonly string[]): ParseResult {
  const parsed = parseOptionalScope(args);
  if (!parsed.ok) return parsed;
  return parsed.scope
    ? { command: "papercuts", action: "list", scope: parsed.scope }
    : { command: "papercuts", action: "list" };
}

function parsePapercutAction(
  action: "show" | "dismiss",
  args: readonly string[],
): ParseResult {
  const parsed = parseFlags(
    args,
    action === "show" ? SCOPED_ID_FLAGS : SCOPED_CONFIRMED_ID_FLAGS,
  );
  if (!parsed.ok) return parsed;
  const scope = parseRequiredScope(parsed.values);
  const papercutId = flagValue(parsed.values, "--id");
  if (!scope || !isOpaqueId(papercutId, "cut")) return USAGE_FAILURE;
  if (action === "show") return { command: "papercuts", action, scope, papercutId };
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "papercuts", action, scope, papercutId, confirm: true };
}

function parseConflicts(args: readonly string[]): ParseResult {
  const [action, ...rest] = args;
  if (action === "list") {
    return rest.length === 0 ? { command: "conflicts", action: "list" } : USAGE_FAILURE;
  }
  if (action === "show" || action === "revalidate") {
    const parsed = parseFlags(rest, ID_FLAG);
    if (!parsed.ok) return parsed;
    const conflictId = flagValue(parsed.values, "--id");
    return isOpaqueId(conflictId, "conflict")
      ? { command: "conflicts", action, conflictId }
      : USAGE_FAILURE;
  }
  if (action !== "activate") return USAGE_FAILURE;
  const parsed = parseFlags(rest, CONFLICT_ACTIVATE_FLAGS);
  if (!parsed.ok) return parsed;
  const conflictId = flagValue(parsed.values, "--id");
  const revisionId = flagValue(parsed.values, "--revision-id");
  if (!isOpaqueId(conflictId, "conflict") || !isOpaqueId(revisionId, "rev")) {
    return USAGE_FAILURE;
  }
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "conflicts", action, conflictId, revisionId, confirm: true };
}

function parseMigrate(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, MIGRATE_FLAGS);
  if (!parsed.ok) return parsed;
  const fromRepositoryId = flagValue(parsed.values, "--from");
  const toRepositoryId = flagValue(parsed.values, "--to");
  if (!isOpaqueId(fromRepositoryId, "repo") || !isOpaqueId(toRepositoryId, "repo")) {
    return USAGE_FAILURE;
  }

  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "migrate", fromRepositoryId, toRepositoryId, confirm: true };
}
function parsePublication(command: PublicationCommand, args: readonly string[]): ParseResult {
  if (!args.includes("--confirm")) {
    const parsed = parseFlags(args, SCOPED_ID_FLAGS);
    if (!parsed.ok) return parsed;
    const target = parseRepositoryPapercut(parsed.values);
    return target ? { command, action: "prepare", ...target } : USAGE_FAILURE;
  }

  const parsed = parseFlags(args, PUBLICATION_COMMIT_FLAGS);
  if (!parsed.ok) return parsed;
  const target = parseRepositoryPapercut(parsed.values);
  const expectedRepository = flagValue(parsed.values, "--repository");
  const expectedAccount = flagValue(parsed.values, "--account");
  if (
    !target ||
    !expectedRepository ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
      expectedRepository,
    ) ||
    !expectedAccount ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(expectedAccount)
  ) {
    return USAGE_FAILURE;
  }
  return {
    command,
    action: "commit",
    ...target,
    expectedRepository,
    expectedAccount,
    confirm: true,
  };
}

function parseRecoverLock(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, RECOVER_LOCK_FLAGS);
  if (!parsed.ok) return parsed;
  const documentId = flagValue(parsed.values, "--document-id");
  if (!isOpaqueId(documentId, "doc")) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "recover-lock", documentId, confirm: true };
}

function parseCleanTransaction(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, TRANSACTION_FLAGS);
  if (!parsed.ok) return parsed;
  const transactionId = flagValue(parsed.values, "--id");
  if (!isOpaqueId(transactionId, "tx")) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "clean-transaction", transactionId, confirm: true };
}

function parseBasicLifecycle(
  command: BasicPapercutLifecycleCommand,
  args: readonly string[],
): ParseResult {
  const parsed = parseFlags(args, SCOPED_CONFIRMED_ID_FLAGS);
  if (!parsed.ok) return parsed;
  const target = parseRepositoryPapercut(parsed.values);
  if (!target) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command, ...target, confirm: true };
}

function parseReconcileRepair(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, RECONCILE_REPAIR_FLAGS);
  if (!parsed.ok) return parsed;
  const target = parseRepositoryPapercut(parsed.values);
  const state = flagValue(parsed.values, "--state");
  if (!target || !state || !RECONCILED_REPAIR_STATES[state]) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "reconcile-repair", ...target, state: state as ReconciledRepairState, confirm: true };
}

function parseVerify(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, VERIFY_FLAGS);
  if (!parsed.ok) return parsed;
  const target = parseRepositoryPapercut(parsed.values);
  const observed = flagValue(parsed.values, "--observed");
  if (!target || (observed !== "passed" && observed !== "failed")) return USAGE_FAILURE;
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return { command: "verify", ...target, observed, confirm: true };
}

function parseResolve(args: readonly string[]): ParseResult {
  const parsed = parseFlags(args, RESOLVE_FLAGS);
  if (!parsed.ok) return parsed;
  const target = parseRepositoryPapercut(parsed.values);
  if (!target) return USAGE_FAILURE;

  const logicalKey = flagValue(parsed.values, "--logical-key");
  const category = flagValue(parsed.values, "--category");
  const priorityValue = flagValue(parsed.values, "--priority");
  const situation = flagValue(parsed.values, "--situation");
  const action = flagValue(parsed.values, "--action");
  const napkinValues = [logicalKey, category, priorityValue, situation, action];
  const providedValues = napkinValues.filter(value => value !== undefined).length;
  if (providedValues !== 0 && providedValues !== napkinValues.length) return USAGE_FAILURE;

  let napkin: DurableNapkinRequest | undefined;
  if (providedValues > 0) {
    if (
      !logicalKey ||
      logicalKey.length > 80 ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(logicalKey) ||
      !category ||
      !NAPKIN_CATEGORIES.includes(category as NapkinCategory) ||
      !priorityValue ||
      !/^(?:0|[1-9]\d?|100)$/.test(priorityValue) ||
      !isBoundedLine(situation) ||
      !isBoundedLine(action)
    ) {
      return USAGE_FAILURE;
    }
    napkin = {
      logicalKey,
      category: category as NapkinCategory,
      priority: Number(priorityValue),
      situation,
      action,
    };
  }
  if (!parsed.values.has("--confirm")) return CONFIRMATION_FAILURE;
  return {
    command: "resolve",
    ...target,
    ...(napkin === undefined ? {} : { napkin }),
    confirm: true,
  };
}

function parseRepositoryPapercut(
  flags: Map<string, string | true>,
): { scope: Extract<ScopeRef, { type: "repository" }>; papercutId: string } | undefined {
  const scope = parseRequiredScope(flags);
  const papercutId = flagValue(flags, "--id");
  return scope?.type === "repository" && isOpaqueId(papercutId, "cut")
    ? { scope, papercutId }
    : undefined;
}

function isBoundedLine(value: string | undefined): value is string {
  return value !== undefined &&
    value.length > 0 &&
    value.length <= MAX_BODY_TEXT_CHARACTERS &&
    !/[\r\n]/.test(value);
}

function parseFlags(args: readonly string[], specification: Record<string, FlagKind>): ParsedFlags {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag || values.has(flag)) return USAGE_FAILURE;
    const kind = specification[flag];
    if (!kind) return USAGE_FAILURE;
    if (kind === "boolean") {
      values.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) return USAGE_FAILURE;
    values.set(flag, value);
    index += 1;
  }
  return { ok: true, values };
}

function parseOptionalScope(args: readonly string[]): OptionalScope {
  if (args.length === 0) return { ok: true };
  if (args.length !== 1 || !args[0]) return USAGE_FAILURE;
  const scope = parseScope(args[0]);
  return scope ? { ok: true, scope } : USAGE_FAILURE;
}

function parseRequiredScope(flags: Map<string, string | true>): ScopeRef | undefined {
  const value = flagValue(flags, "--scope");
  return value === undefined ? undefined : parseScope(value);
}

function parseScope(value: string): ScopeRef | undefined {
  if (value === "global" || value === "global:global") return { type: "global", id: "global" };
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":")) return undefined;
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (type === "machine" && isOpaqueId(id, "machine")) return { type, id };
  if (type === "repository" && isOpaqueId(id, "repo")) return { type, id };
  return undefined;
}

function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}
