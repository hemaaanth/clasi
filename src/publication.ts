import { isAbsolute } from "node:path";
import { runProcess } from "./exec.ts";
import type { ProcessAdapter, ProcessInvocation, ProcessResult } from "./exec.ts";
import { isOpaqueId } from "./ids.ts";
import type { ScopeRef } from "./paths.ts";
import type { PapercutGetResult, PapercutTransitionResult } from "./papercut-service.ts";
import { validatePrivateFields } from "./privacy.ts";
import { resolveRuntimeEnvironment } from "./runtime-environment.ts";
import type { PapercutRecord } from "./schema.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const MAX_REPOSITORY_COORDINATE_CHARACTERS = 200;
const MAX_ISSUE_URL_CHARACTERS = 500;
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export type RepositoryScope = Extract<ScopeRef, { type: "repository" }>;
export interface PublicationPapercuts {
  get(scope: ScopeRef, id: string): Promise<PapercutGetResult>;
  beginPublication(scope: ScopeRef, id: string): Promise<PapercutTransitionResult>;
  reportPublication(scope: ScopeRef, id: string, outcome: "failed" | "indeterminate" | "published", issueNumber: number | null): Promise<PapercutTransitionResult>;
  reconcilePublication(scope: ScopeRef, id: string, outcome: "failed" | "published", issueNumber: number | null): Promise<PapercutTransitionResult>;
  resubmitPublication(scope: ScopeRef, id: string, confirmed: boolean): Promise<PapercutTransitionResult>;
}
export type ResolveRepositoryKey = (cwd: string) => Promise<string | null>;
export type PublicationAction = "publish" | "reconcile" | "resubmit";
export interface PublicationIdentity { repositoryScope: RepositoryScope; cutId: string; cwd: string }
export interface PublicationPrepareInput extends PublicationIdentity { action: PublicationAction }
export interface PublicationCommitInput extends PublicationIdentity {
  confirmed: boolean;
  expectedRepository: string;
  expectedAccount: string;
}
export interface PublicationPreview {
  repository: string;
  account: string;
  title: string;
  publicationState: PapercutRecord["publicationState"];
}
export interface PublicationServiceOptions {
  papercuts: PublicationPapercuts;
  process?: ProcessAdapter;
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  resolveRepositoryKey?: ResolveRepositoryKey;
}
export type PublicationReasonCode =
  | "confirmation-required" | "create-indeterminate" | "gh-unauthenticated" | "gh-unavailable"
  | "invalid-field" | "papercut-not-found" | "publication-in-progress" | "publication-state-failed"
  | "publication-target-mismatch" | "reconciliation-ambiguous" | "reconciliation-failed"
  | "reconciliation-required" | "repository-scope-mismatch" | "repository-target-invalid"
  | "repository-target-unavailable" | "resubmit-required" | "unsafe-papercut";
export type PublicationPrepareResult =
  | { status: "prepared"; preview: PublicationPreview }
  | { status: "published"; issueNumber: number; alreadyPublished: true }
  | { status: "rejected"; code: PublicationReasonCode };
export type PublicationResult =
  | { status: "published"; issueNumber: number; alreadyPublished: boolean }
  | { status: "failed"; code: PublicationReasonCode }
  | { status: "indeterminate"; code: PublicationReasonCode }
  | { status: "rejected"; code: PublicationReasonCode };
interface PublicationTarget { repository: string; account: string }

export class PublicationService {
  readonly #papercuts: PublicationPapercuts;
  readonly #process: ProcessAdapter;
  readonly #command: string;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #resolveRepositoryKey: ResolveRepositoryKey;

  constructor(options: PublicationServiceOptions) {
    this.#papercuts = options.papercuts;
    this.#process = options.process ?? runProcess;
    this.#command = options.command ?? "gh";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#resolveRepositoryKey = options.resolveRepositoryKey ?? defaultRepositoryKey;
  }

  async prepare(input: PublicationPrepareInput): Promise<PublicationPrepareResult> {
    const validation = validateIdentity(input);
    if (validation !== null || !isAction(input?.action)) return rejected(validation ?? "invalid-field");
    if (!(await this.#isCurrentScope(input))) return rejected("repository-scope-mismatch");
    const record = await this.#loadOpen(input);
    if ("code" in record) return rejected(record.code);
    if (!safePapercut(record)) return rejected("unsafe-papercut");
    const state = actionState(input.action, record);
    if (state !== null) return state;
    const target = await this.#preflight(input.cwd);
    if ("code" in target) return rejected(target.code);
    return { status: "prepared", preview: {
      repository: target.repository,
      account: target.account,
      title: record.summary,
      publicationState: record.publicationState,
    } };
  }

  async publish(input: PublicationCommitInput): Promise<PublicationResult> {
    const prepared = await this.#prepareCommit(input, "publish");
    if ("result" in prepared) return prepared.result;
    const pending = await this.#papercuts.beginPublication(input.repositoryScope, input.cutId);
    if (pending.status !== "updated") return rejected("publication-state-failed");
    return this.#publishPending(input, pending.record);
  }

  async resubmit(input: PublicationCommitInput): Promise<PublicationResult> {
    const prepared = await this.#prepareCommit(input, "resubmit");
    if ("result" in prepared) return prepared.result;
    const pending = await this.#papercuts.resubmitPublication(input.repositoryScope, input.cutId, true);
    if (pending.status !== "updated") return rejected("publication-state-failed");
    return this.#publishPending(input, pending.record);
  }

  async reconcile(input: PublicationCommitInput): Promise<PublicationResult> {
    const prepared = await this.#prepareCommit(input, "reconcile");
    if ("result" in prepared) return prepared.result;
    const search = await this.#invoke([
      "issue", "list", "--repo", prepared.target.repository, "--state", "all",
      "--search", `clasi:${input.cutId} in:body`, "--json", "number,url",
    ], input.cwd);
    if (search.status !== "exited" || search.exitCode !== 0) return { status: "indeterminate", code: "reconciliation-failed" };
    const matches = parseIssueList(search, this.#maxOutputBytes, prepared.target.repository);
    if (matches === null || matches.length > 1) return { status: "indeterminate", code: "reconciliation-ambiguous" };
    const outcome = matches.length === 1 ? "published" : "failed";
    const issueNumber = matches.length === 1 ? matches[0]!.number : null;
    const persisted = await this.#papercuts.reconcilePublication(input.repositoryScope, input.cutId, outcome, issueNumber);
    if (persisted.status !== "updated") return rejected("publication-state-failed");
    return outcome === "published"
      ? { status: "published", issueNumber: issueNumber!, alreadyPublished: false }
      : { status: "failed", code: "reconciliation-failed" };
  }

  async #prepareCommit(input: PublicationCommitInput, action: PublicationAction): Promise<
    { target: PublicationTarget; record: PapercutRecord } | { result: PublicationResult }
  > {
    const validation = validateCommit(input);
    if (validation !== null) return { result: rejected(validation) };
    if (!input.confirmed) return { result: rejected("confirmation-required") };
    if (!(await this.#isCurrentScope(input))) return { result: rejected("repository-scope-mismatch") };
    const record = await this.#loadOpen(input);
    if ("code" in record) return { result: rejected(record.code) };
    if (!safePapercut(record)) return { result: rejected("unsafe-papercut") };
    const state = actionState(action, record);
    if (state !== null) return { result: state };
    const target = await this.#preflight(input.cwd);
    if ("code" in target) {
      return action === "reconcile"
        ? { result: { status: "indeterminate", code: "reconciliation-failed" } }
        : { result: await this.#recordFailed(input, target.code) };
    }
    if (target.repository !== input.expectedRepository || target.account !== input.expectedAccount) {
      return { result: rejected("publication-target-mismatch") };
    }
    return { target, record };
  }

  async #publishPending(
    input: PublicationCommitInput,
    record: PapercutRecord,
  ): Promise<PublicationResult> {
    const target = await this.#preflight(input.cwd);
    if ("code" in target) return this.#recordPendingFailed(input, target.code);
    if (
      target.repository !== input.expectedRepository ||
      target.account !== input.expectedAccount
    ) {
      return this.#recordPendingFailed(input, "publication-target-mismatch");
    }
    const effect = await this.#invoke([
      "api", `repos/${target.repository}/issues`, "--method", "POST",
      "-f", `title=${record.summary}`, "-f", `body=${issueBody(record)}`,
    ], input.cwd);
    if (effect.status !== "exited" || effect.exitCode !== 0) return this.#recordIndeterminate(input, "create-indeterminate");
    const issueNumber = parseCreatedIssue(effect, this.#maxOutputBytes);
    if (issueNumber === null) return this.#recordIndeterminate(input, "create-indeterminate");
    const published = await this.#papercuts.reportPublication(input.repositoryScope, input.cutId, "published", issueNumber);
    if (published.status !== "updated") {
      await this.#papercuts.reportPublication(input.repositoryScope, input.cutId, "indeterminate", null);
      return { status: "indeterminate", code: "publication-state-failed" };
    }
    return { status: "published", issueNumber, alreadyPublished: false };
  }

  async #recordFailed(input: PublicationIdentity, code: PublicationReasonCode): Promise<PublicationResult> {
    const pending = await this.#papercuts.beginPublication(input.repositoryScope, input.cutId);
    if (pending.status !== "updated") return rejected("publication-state-failed");
    const persisted = await this.#papercuts.reportPublication(input.repositoryScope, input.cutId, "failed", null);
    return persisted.status === "updated" ? { status: "failed", code } : rejected("publication-state-failed");
  }

  async #recordPendingFailed(
    input: PublicationIdentity,
    code: PublicationReasonCode,
  ): Promise<PublicationResult> {
    const persisted = await this.#papercuts.reportPublication(
      input.repositoryScope,
      input.cutId,
      "failed",
      null,
    );
    return persisted.status === "updated"
      ? { status: "failed", code }
      : rejected("publication-state-failed");
  }

  async #recordIndeterminate(input: PublicationIdentity, code: PublicationReasonCode): Promise<PublicationResult> {
    const persisted = await this.#papercuts.reportPublication(input.repositoryScope, input.cutId, "indeterminate", null);
    return persisted.status === "updated" ? { status: "indeterminate", code } : rejected("publication-state-failed");
  }

  async #preflight(cwd: string): Promise<PublicationTarget | { code: PublicationReasonCode }> {
    const version = await this.#invoke(["--version"], cwd);
    if (version.status !== "exited" || version.exitCode !== 0) return { code: "gh-unavailable" };
    const auth = await this.#invoke(["auth", "status"], cwd);
    if (auth.status !== "exited" || auth.exitCode !== 0) return { code: "gh-unauthenticated" };
    const repositoryResult = await this.#invoke(["repo", "view", "--json", "nameWithOwner"], cwd);
    if (repositoryResult.status !== "exited" || repositoryResult.exitCode !== 0) return { code: "repository-target-unavailable" };
    const repository = parseRepository(repositoryResult, this.#maxOutputBytes);
    if (repository === null) return { code: "repository-target-invalid" };
    const accountResult = await this.#invoke(["api", "user", "--jq", "{login: .login}"], cwd);
    if (accountResult.status !== "exited" || accountResult.exitCode !== 0) return { code: "gh-unauthenticated" };
    const account = parseAccount(accountResult, this.#maxOutputBytes);
    return account === null ? { code: "gh-unauthenticated" } : { repository, account };
  }

  async #invoke(args: readonly string[], cwd: string): Promise<ProcessResult> {
    const invocation: ProcessInvocation = { command: this.#command, args: [...args], cwd, env: undefined, timeoutMs: this.#timeoutMs, maxOutputBytes: this.#maxOutputBytes };
    try { return await this.#process(invocation); }
    catch { return { status: "spawn-failed", message: "process-failed" }; }
  }

  async #isCurrentScope(input: PublicationIdentity): Promise<boolean> {
    try { return await this.#resolveRepositoryKey(input.cwd) === input.repositoryScope.id; }
    catch { return false; }
  }

  async #loadOpen(input: PublicationIdentity): Promise<PapercutRecord | { code: "papercut-not-found" }> {
    try {
      const result = await this.#papercuts.get(input.repositoryScope, input.cutId);
      return result.status === "ok" && result.location === "open" && result.record.lifecycle === "open" ? result.record : { code: "papercut-not-found" };
    } catch { return { code: "papercut-not-found" }; }
  }
}

async function defaultRepositoryKey(cwd: string): Promise<string | null> {
  const environment = await resolveRuntimeEnvironment(cwd);
  return environment.status === "ready" && environment.capabilities.repositoryScope === "attached" && environment.repositoryKey !== undefined ? environment.repositoryKey : null;
}
function actionState(
  action: PublicationAction,
  record: PapercutRecord,
): Exclude<PublicationPrepareResult, { status: "prepared" }> | null {
  if (record.publicationState === "published") return { status: "published", issueNumber: record.publicationIssueNumber!, alreadyPublished: true };
  if (action === "publish") {
    if (record.publicationState === "pending") return rejected("publication-in-progress");
    if (record.publicationState === "indeterminate") return rejected("reconciliation-required");
    return null;
  }
  return record.publicationState !== "indeterminate" ? rejected(action === "resubmit" ? "resubmit-required" : "reconciliation-required") : null;
}
function validateIdentity(input: PublicationIdentity): PublicationReasonCode | null {
  if (input?.repositoryScope?.type !== "repository" || !isOpaqueId(input.repositoryScope.id, "repo") || !isOpaqueId(input.cutId, "cut") || typeof input.cwd !== "string" || !isAbsolute(input.cwd) || input.cwd.includes("\0")) return "invalid-field";
  return null;
}
function validateCommit(input: PublicationCommitInput): PublicationReasonCode | null {
  const identity = validateIdentity(input);
  if (identity !== null) return identity;
  return typeof input.confirmed !== "boolean" || !validRepository(input.expectedRepository) || !validAccount(input.expectedAccount) ? "invalid-field" : null;
}
function isAction(value: unknown): value is PublicationAction { return value === "publish" || value === "reconcile" || value === "resubmit"; }
function safePapercut(record: PapercutRecord): boolean {
  const privacy = validatePrivateFields({ classification: record.sourceClassification, fields: { summary: record.summary, prevention: record.prevention, acceptance_condition: record.acceptanceCondition, severity: record.severity, recurrence: record.recurrence } });
  const reference = record.publicationState === "published" ? typeof record.publicationIssueNumber === "number" && Number.isSafeInteger(record.publicationIssueNumber) && record.publicationIssueNumber > 0 : record.publicationIssueNumber === null;
  return privacy.ok && reference && isOpaqueId(record.id, "cut") && record.lifecycle === "open" && Number.isSafeInteger(record.recurrence) && record.recurrence >= 1;
}
function issueBody(record: PapercutRecord): string {
  return ["## Summary", record.summary, "## Prevention", record.prevention, "## Acceptance condition", record.acceptanceCondition, `Severity: ${record.severity}`, `Recurrence: ${record.recurrence}`, `clasi:${record.id}`].join("\n\n");
}
function parseRepository(result: Extract<ProcessResult, { status: "exited" }>, maximum: number): string | null {
  const value = parseJson(result, maximum);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const repository = (value as Record<string, unknown>).nameWithOwner;
  return typeof repository === "string" && validRepository(repository) ? repository : null;
}
function parseAccount(result: Extract<ProcessResult, { status: "exited" }>, maximum: number): string | null {
  const value = parseJson(result, maximum);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1) return null;
  const account = (value as Record<string, unknown>).login;
  return typeof account === "string" && validAccount(account) ? account : null;
}
function validRepository(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_REPOSITORY_COORDINATE_CHARACTERS) return false;
  const parts = value.split("/");
  return parts.length === 2 && validAccount(parts[0]) && REPOSITORY_NAME_PATTERN.test(parts[1]!) && parts[1] !== "." && parts[1] !== "..";
}
function validAccount(value: unknown): value is string { return typeof value === "string" && ACCOUNT_PATTERN.test(value); }
function parseCreatedIssue(result: Extract<ProcessResult, { status: "exited" }>, maximum: number): number | null {
  const value = parseJson(result, maximum);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const number = (value as Record<string, unknown>).number;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : null;
}
function parseIssueList(result: Extract<ProcessResult, { status: "exited" }>, maximum: number, repository: string): Array<{ number: number }> | null {
  const value = parseJson(result, maximum);
  if (!Array.isArray(value)) return null;
  const matches: Array<{ number: number }> = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== "number" && key !== "url") || typeof record.number !== "number" || !Number.isSafeInteger(record.number) || record.number <= 0 || typeof record.url !== "string" || record.url.length > MAX_ISSUE_URL_CHARACTERS || record.url !== `https://github.com/${repository}/issues/${record.number}`) return null;
    matches.push({ number: record.number });
  }
  return matches;
}
function parseJson(result: Extract<ProcessResult, { status: "exited" }>, maximum: number): unknown | null {
  if (result.stdout.byteLength + result.stderr.byteLength > maximum) return null;
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)) as unknown; }
  catch { return null; }
}
function rejected(code: PublicationReasonCode): PublicationResult & { status: "rejected" } { return { status: "rejected", code }; }
