import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ConflictService, ConflictRevisionPreview } from "./conflict-service.ts";
import type {
  CleanTransactionResult,
  LockListResult,
  RecoverLockResult,
  TransactionListResult,
} from "./coordination-service.ts";
import type { ImpactReport, ImpactService, UnavailableMeasurement } from "./impact-service.ts";
import { isOpaqueId } from "./ids.ts";
import type { ScopeRef } from "./paths.ts";
import type { ConfigStatusData, getHeadlessConfig } from "./status.ts";

const MAX_UI_TEXT = 600;
const MAX_OPTION_TEXT = 180;
const SAFE_CODE = /^[a-z][a-z0-9-]{0,79}$/;

export type ConflictReviewService = Pick<ConflictService, "list" | "show" | "revalidate" | "activate">;
export type ImpactReviewService = Pick<ImpactService, "report">;
export interface CoordinationReviewService {
  listLocks(limit?: number): Promise<LockListResult>;
  listTransactions(limit?: number): Promise<TransactionListResult>;
  recoverLock(documentId: string, confirmed: boolean): Promise<RecoverLockResult>;
  cleanTransaction(transactionId: string, confirmed: boolean): Promise<CleanTransactionResult>;
}
export type CommandConfigResult = Awaited<ReturnType<typeof getHeadlessConfig>>;
export type CommandConfigLoader = () => Promise<CommandConfigResult>;
export type ConfigCapField = "napkin-category-cap" | "context-character-cap";
export type ConfigUpdateResult =
  | { status: "updated" }
  | { status: "rejected" | "unavailable"; code: string };
export type ConfigUpdater = (field: ConfigCapField, value: number) => Promise<ConfigUpdateResult>;

export type RecoveryActionId = "repository-migration" | "lock-recovery" | "transaction-recovery";
export type RecoveryBlockerCode =
  | "repository-migration-required"
  | "lock-recovery-required"
  | "transaction-recovery-required";
export type RecoveryDescriptionResult =
  | {
      status: "ok";
      target: {
        kind: "repository-migration";
        fromRepositoryId: string;
        toRepositoryId: string;
      };
    }
  | { status: "rejected" | "unavailable"; code: string };
export interface RecoveryHandler {
  available(blocker: RecoveryBlockerCode): Promise<readonly RecoveryActionId[]>;
  describe?(action: RecoveryActionId): Promise<RecoveryDescriptionResult>;
  run(action: RecoveryActionId, confirmed: boolean): Promise<
    | { status: "ok" }
    | { status: "rejected" | "unavailable"; code: string }
  >;
}

export function recoveryBlocker(code: string): RecoveryBlockerCode | null {
  switch (code) {
    case "repository-migration-required":
    case "lock-recovery-required":
    case "transaction-recovery-required":
      return code;
    default:
      return null;
  }
}

export async function showConflictReview(
  context: ExtensionContext,
  service: ConflictReviewService,
): Promise<void> {
  let selectedId = "";
  while (true) {
    const listed = await service.list();
    if (listed.status !== "ok") {
      context.ui.notify(`Conflicts unavailable (${safeCode(listed.code)}).`, "warning");
      return;
    }
    if (listed.conflicts.length === 0) {
      context.ui.notify("No unresolved conflicts.", "info");
      return;
    }
    const rows = listed.conflicts.map(conflict => ({
      id: conflict.id,
      label: `${conflict.conflictKind} · ${safeCode(conflict.reasonCode)} · ${scopeLabel(conflict.scope)} · ${conflict.id}`,
    }));
    const selected = await chooseRows(
      context,
      listed.truncated ? "Conflicts (list truncated)" : "Conflicts",
      rows,
      preservedIndex(rows, selectedId, 0),
    );
    if (!selected) return;
    selectedId = selected.id;
    await conflictDetail(context, service, selected.id);
  }
}

async function conflictDetail(
  context: ExtensionContext,
  service: ConflictReviewService,
  conflictId: string,
): Promise<void> {
  while (true) {
    const shown = await service.show(conflictId);
    if (shown.status === "rejected") {
      context.ui.notify(`Conflict unavailable (${safeCode(shown.code)}).`, "warning");
      return;
    }
    if (shown.status === "opaque") {
      const metadata = shown.conflict;
      const action = await choose(
        context,
        [
          "Opaque conflict",
          `Kind: ${metadata.conflictKind}`,
          `Reason: ${safeCode(metadata.reasonCode)}`,
          `Scope: ${scopeLabel(metadata.scope)}`,
          `Canonical occupied: ${metadata.canonicalOccupied ? "yes" : "no"}`,
          `Conflict ID: ${metadata.id}`,
        ].join("\n"),
        ["Revalidate", "Keep unresolved", "Back"],
      );
      if (action === undefined || action === "Keep unresolved" || action === "Back") return;
      const result = await service.revalidate(conflictId);
      if (result.status === "validated") {
        context.ui.notify("Conflict revisions revalidated.", "info");
        continue;
      }
      const code = "code" in result ? safeCode(result.code) : "unavailable";
      context.ui.notify(`Conflict remains opaque (${code}).`, "warning");
      continue;
    }

    const action = await choose(
      context,
      `${revisionSummary(shown.candidate)}\n${revisionSummary(shown.alternate)}`,
      ["Choose A", "Choose B", "Keep unresolved", "Back"],
    );
    if (action === undefined || action === "Keep unresolved" || action === "Back") return;
    const selected = action === "Choose A" ? shown.candidate : shown.alternate;
    const confirmed = await context.ui.confirm(
      `Activate revision ${selected.label}`,
      `Target: ${selected.documentType} ${scopeLabel(selected.scope)}. Effect: create a new active revision from ${selected.label} (${selected.revisionId}); keep the other revision and conflict history.`,
    );
    if (!confirmed) continue;
    const activated = await service.activate(conflictId, selected.revisionId, true);
    if (activated.status === "activated") {
      context.ui.notify(`Revision ${selected.label} activated.`, "info");
      return;
    }
    const code = "code" in activated ? safeCode(activated.code) : "unavailable";
    context.ui.notify(`Activation not completed (${code}).`, "warning");
  }
}

export async function showConfigReview(
  context: ExtensionContext,
  load: CommandConfigLoader,
  update?: ConfigUpdater,
): Promise<void> {
  while (true) {
    let result: CommandConfigResult;
    try {
      result = await load();
    } catch {
      context.ui.notify("Configuration unavailable (read-failed).", "warning");
      return;
    }
    const envelope = result.envelope;
    if ((envelope.status !== "ok" && envelope.status !== "partial") || !isConfigData(envelope.data)) {
      context.ui.notify(`Configuration unavailable (${safeCode(envelope.code)}).`, "warning");
      return;
    }
    const data = envelope.data;
    const title = [
      "Configuration",
      `Data root: ${safeRootLabel(data.data_root)}`,
      `Napkin category cap: ${data.caps.napkin_category}`,
      `Context character cap: ${data.caps.context_characters}`,
      `Repository scope: ${data.capabilities.repository_scope}`,
      `Reattach on move: ${data.capabilities.requires_reattach_on_move ? "required" : "not required"}`,
      `Degradations: ${data.degradations.length === 0 ? "none" : data.degradations.map(safeCode).join(", ")}`,
    ].join("\n");
    const choices = update
      ? ["Change Napkin category cap", "Change Context character cap", "Back"]
      : ["Back"];
    const action = await choose(context, title, choices);
    if (action === undefined || action === "Back") return;
    if (!update) return;
    const field: ConfigCapField = action === "Change Napkin category cap"
      ? "napkin-category-cap"
      : "context-character-cap";
    const current = field === "napkin-category-cap"
      ? data.caps.napkin_category
      : data.caps.context_characters;
    const bounds = field === "napkin-category-cap"
      ? { minimum: 1, maximum: 20 }
      : { minimum: 500, maximum: 6_000 };
    const entered = await context.ui.input(
      action,
      `Integer from ${bounds.minimum} to ${bounds.maximum}`,
    );
    if (entered === undefined) continue;
    const value = boundedInteger(entered, bounds.minimum, bounds.maximum);
    if (value === null) {
      context.ui.notify("Cap unchanged (invalid-cap).", "warning");
      continue;
    }
    const target = field === "napkin-category-cap" ? "Napkin category cap" : "Context character cap";
    const confirmed = await context.ui.confirm(
      `Change ${target}`,
      `Target: ${target}. Effect: replace ${current} with ${value}; the runtime will reload configuration after the committed update.`,
    );
    if (!confirmed) continue;
    const changed = await update(field, value);
    if (changed.status !== "updated") {
      context.ui.notify(`Configuration unchanged (${safeCode(changed.code)}).`, "warning");
      continue;
    }
    context.ui.notify(`${target} updated.`, "info");
  }
}

export async function showImpactReview(
  context: ExtensionContext,
  service: ImpactReviewService,
  input: { machineId: string; scopes: readonly ScopeRef[] },
): Promise<void> {
  const result = await service.report(input);
  if (result.status !== "ok") {
    context.ui.notify(`Impact report unavailable (${safeCode(result.reason)}).`, "warning");
    return;
  }
  await choose(context, impactSummary(result.report), ["Back"]);
}

type CoordinationUnavailable = {
  status: "unavailable";
  code: "coordination-unavailable";
};
type CoordinationList<T extends { status: string }> = T | CoordinationUnavailable;
export async function shouldShowCoordinationRecovery(
  service: CoordinationReviewService | undefined,
): Promise<boolean> {
  if (!service) return true;
  const [locks, transactions] = await loadCoordinationLists(service);
  return locks.status !== "empty" || transactions.status !== "empty";
}

export async function showCoordinationReview(
  context: ExtensionContext,
  service: CoordinationReviewService | undefined,
): Promise<void> {
  if (!service) {
    context.ui.notify("Recovery coordination unavailable (service-unavailable).", "warning");
    return;
  }
  while (true) {
    const [locks, transactions] = await loadCoordinationLists(service);
    const action = await choose(
      context,
      [
        "Recovery",
        `Locks: ${coordinationCount(locks, "documentIds")}`,
        `Retained transactions: ${coordinationCount(transactions, "transactions")}`,
      ].join("\n"),
      ["Locks", "Retained transactions", "Back"],
    );
    if (action === undefined || action === "Back") return;
    if (action === "Locks") await lockRecoveryView(context, service);
    if (action === "Retained transactions") await transactionRecoveryView(context, service);
  }
}

async function lockRecoveryView(
  context: ExtensionContext,
  service: CoordinationReviewService,
): Promise<void> {
  let selectedId = "";
  while (true) {
    const result = await safeCoordinationCall(() => service.listLocks());
    if (result.status === "unavailable" || result.status === "rejected") {
      const code = result.status === "unavailable" ? result.code : result.code;
      context.ui.notify(`Locks unavailable (${safeCode(code)}).`, "warning");
      return;
    }
    if (result.status === "empty") {
      context.ui.notify("No retained locks.", "info");
      return;
    }
    const rows = result.documentIds
      .filter(id => isOpaqueId(id, "doc"))
      .map(id => ({ id, label: id }));
    if (rows.length !== result.documentIds.length) {
      context.ui.notify("Locks unavailable (invalid-document-id).", "warning");
      return;
    }
    const selected = await chooseRows(
      context,
      result.truncated ? "Locks (list truncated)" : "Locks",
      rows,
      preservedIndex(rows, selectedId, 0),
    );
    if (!selected) return;
    selectedId = selected.id;
    const confirmed = await context.ui.confirm(
      "Recover stale lock",
      `Target: ${selected.id}. Effect: revalidate lock ownership and remove only the stale lock when recovery is safe.`,
    );
    if (!confirmed) continue;
    const recovered = await safeCoordinationCall(() => service.recoverLock(selected.id, true));
    if (recovered.status === "recovered") {
      context.ui.notify("Stale lock recovered.", "info");
      continue;
    }
    const code = recovered.status === "unavailable"
      ? recovered.code
      : "code" in recovered
        ? recovered.code
        : "lock-recovery-unavailable";
    context.ui.notify(`Lock not recovered (${safeCode(code)}).`, "warning");
  }
}

async function transactionRecoveryView(
  context: ExtensionContext,
  service: CoordinationReviewService,
): Promise<void> {
  let selectedId = "";
  while (true) {
    const result = await safeCoordinationCall(() => service.listTransactions());
    if (result.status === "unavailable" || result.status === "rejected") {
      const code = result.status === "unavailable" ? result.code : result.code;
      context.ui.notify(`Retained transactions unavailable (${safeCode(code)}).`, "warning");
      return;
    }
    if (result.status === "empty") {
      context.ui.notify("No retained transactions.", "info");
      return;
    }
    const valid = result.transactions.every(transaction =>
      isOpaqueId(transaction.id, "tx")
      && isOpaqueId(transaction.documentId, "doc")
    );
    if (!valid) {
      context.ui.notify("Retained transactions unavailable (invalid-transaction-id).", "warning");
      return;
    }
    const rows = result.transactions.map(transaction => ({
      id: transaction.id,
      label: `${safeCode(transaction.state)} · ${safeTimestamp(transaction.updatedAt)} · ${transaction.id}`,
      transaction,
    }));
    const selected = await chooseRows(
      context,
      result.truncated ? "Retained transactions (list truncated)" : "Retained transactions",
      rows,
      preservedIndex(rows, selectedId, 0),
    );
    if (!selected) return;
    selectedId = selected.id;
    const transaction = selected.transaction;
    const action = await choose(
      context,
      [
        "Retained transaction",
        `Transaction ID: ${transaction.id}`,
        `Document ID: ${transaction.documentId}`,
        `State: ${safeCode(transaction.state)}`,
        `Created: ${safeTimestamp(transaction.createdAt)}`,
        `Updated: ${safeTimestamp(transaction.updatedAt)}`,
        "Warning: editors and sync clients must be quiescent; cleanup removes terminal transaction state and its quarantine copy if present.",
      ].join("\n"),
      ["Clean retained transaction", "Back"],
    );
    if (action === undefined || action === "Back") continue;
    const confirmed = await context.ui.confirm(
      "Clean retained transaction",
      `Target: ${transaction.id}. Warning: editors and sync clients must be quiescent. Effect: remove terminal transaction state and its quarantine copy if present; preserve canonical documents, revisions, and other directories.`,
    );
    if (!confirmed) continue;
    const cleaned = await safeCoordinationCall(() => service.cleanTransaction(transaction.id, true));
    if (cleaned.status === "cleaned") {
      context.ui.notify(
        cleaned.quarantineRemoved
          ? "Retained transaction state and quarantine removed."
          : "Retained transaction state removed; no quarantine copy remained.",
        "info",
      );
      continue;
    }
    const code = cleaned.status === "unavailable"
      ? cleaned.code
      : "code" in cleaned
        ? cleaned.code
        : "storage-unavailable";
    context.ui.notify(`Transaction not cleaned (${safeCode(code)}).`, "warning");
  }
}

async function loadCoordinationLists(
  service: CoordinationReviewService,
): Promise<[
  CoordinationList<LockListResult>,
  CoordinationList<TransactionListResult>,
]> {
  return Promise.all([
    safeCoordinationCall(() => service.listLocks()),
    safeCoordinationCall(() => service.listTransactions()),
  ]);
}

async function safeCoordinationCall<T extends { status: string }>(
  call: () => Promise<T>,
): Promise<T | CoordinationUnavailable> {
  try {
    return await call();
  } catch {
    return { status: "unavailable", code: "coordination-unavailable" };
  }
}

function coordinationCount(
  result: CoordinationList<LockListResult> | CoordinationList<TransactionListResult>,
  field: "documentIds" | "transactions",
): string {
  if (result.status === "empty") return "none";
  if (result.status === "rejected" || result.status === "unavailable") {
    return `unavailable (${safeCode(result.code)})`;
  }
  return field === "documentIds" && "documentIds" in result
    ? `${result.documentIds.length}${result.truncated ? "+" : ""}`
    : field === "transactions" && "transactions" in result
      ? `${result.transactions.length}${result.truncated ? "+" : ""}`
      : "unavailable";
}
export async function showRecoveryReview(
  context: ExtensionContext,
  blocker: RecoveryBlockerCode,
  handler: RecoveryHandler,
): Promise<void> {
  let available: readonly RecoveryActionId[];
  try {
    available = (await handler.available(blocker)).filter(action => validRecoveryAction(blocker, action));
  } catch {
    context.ui.notify("Recovery actions unavailable (read-failed).", "warning");
    return;
  }
  if (available.length === 0) {
    context.ui.notify("No safe recovery actions are available.", "warning");
    return;
  }
  const choices = [...available.map(recoveryLabel), "Back"];
  const selected = await choose(context, `Recovery blocker: ${recoveryBlockerLabel(blocker)}`, choices);
  if (selected === undefined || selected === "Back") return;
  const actionIndex = choices.indexOf(selected);
  const action = available[actionIndex];
  if (!action) return;
  let target = recoveryBlockerLabel(blocker);
  if (handler.describe) {
    let description: RecoveryDescriptionResult;
    try {
      description = await handler.describe(action);
    } catch {
      context.ui.notify("Recovery action unavailable (read-failed).", "warning");
      return;
    }
    if (description.status !== "ok") {
      context.ui.notify(`Recovery action unavailable (${safeCode(description.code)}).`, "warning");
      return;
    }
    if (
      !isOpaqueId(description.target.fromRepositoryId, "repo")
      || !isOpaqueId(description.target.toRepositoryId, "repo")
    ) {
      context.ui.notify("Recovery action unavailable (invalid-repository-id).", "warning");
      return;
    }
    target = `${description.target.fromRepositoryId} → ${description.target.toRepositoryId}`;
  }
  const confirmed = await context.ui.confirm(
    recoveryLabel(action),
    `Target: ${target}. Effect: ${recoveryEffect(action)}.`,
  );
  if (!confirmed) return;
  const result = await handler.run(action, true);
  if (result.status === "ok") context.ui.notify("Recovery action completed.", "info");
  else context.ui.notify(`Recovery action unavailable (${safeCode(result.code)}).`, "warning");
}

function revisionSummary(preview: ConflictRevisionPreview): string {
  const truncation = preview.recordsTruncated ? "+ records truncated" : "records";
  return `${preview.label}: ${preview.documentType} · ${scopeLabel(preview.scope)} · ${preview.records.length} ${truncation} · ${preview.revisionId}`;
}

function impactSummary(report: ImpactReport): string {
  return [
    "Impact",
    observation("Injected characters", report.injectedCharacters),
    estimate("Estimated injected tokens", report.estimatedInjectedTokens),
    observation("Explicit Napkin hits", report.explicitNapkinHits),
    observation("Papercuts opened", report.papercutsOpened),
    observation("Papercuts closed", report.papercutsClosed),
    observation("Papercuts currently open", report.papercutsOpen),
    observation("Papercuts dismissed", report.papercutsDismissed),
    observation("Repeated friction", report.repeatedFriction),
    timeToClose(report.timeToClose),
  ].join("\n");
}

function observation(label: string, measurement: ImpactReport["injectedCharacters"]): string {
  return measurement.label === "direct-observation"
    ? `${label} (directly observed): ${measurement.value}`
    : unavailable(label, measurement);
}

function estimate(label: string, measurement: ImpactReport["estimatedInjectedTokens"]): string {
  return measurement.label === "estimate"
    ? `${label} (estimate; characters divided by four): ${measurement.value}`
    : unavailable(label, measurement);
}

function timeToClose(measurement: ImpactReport["timeToClose"]): string {
  if (measurement.label === "unavailable") return unavailable("Time to close", measurement);
  const value = measurement.value;
  return `Time to close (directly observed): ${value.averageMilliseconds} ms average; ${value.sampleCount} samples; ${value.minimumMilliseconds}–${value.maximumMilliseconds} ms range`;
}

function unavailable(label: string, measurement: UnavailableMeasurement): string {
  return `${label}: unavailable (${safeCode(measurement.reason)})`;
}

function safeRootLabel(value: string): string {
  if (value === "configured" || value === "${HOME}" || value.startsWith("${HOME}/") || value.startsWith("${HOME}\\")) {
    return clip(value, MAX_OPTION_TEXT);
  }
  return "configured";
}

function isConfigData(value: unknown): value is ConfigStatusData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Partial<ConfigStatusData>;
  return typeof data.data_root === "string"
    && typeof data.caps?.napkin_category === "number"
    && Number.isSafeInteger(data.caps.napkin_category)
    && typeof data.caps.context_characters === "number"
    && Number.isSafeInteger(data.caps.context_characters)
    && (data.capabilities?.repository_scope === "attached"
      || data.capabilities?.repository_scope === "not-repository"
      || data.capabilities?.repository_scope === "unavailable")
    && typeof data.capabilities.requires_reattach_on_move === "boolean"
    && Array.isArray(data.degradations)
    && data.degradations.every(item => typeof item === "string");
}

function boundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function validRecoveryAction(blocker: RecoveryBlockerCode, action: RecoveryActionId): boolean {
  return (blocker === "repository-migration-required" && action === "repository-migration")
    || (blocker === "lock-recovery-required" && action === "lock-recovery")
    || (blocker === "transaction-recovery-required" && action === "transaction-recovery");
}

function recoveryLabel(action: RecoveryActionId): string {
  switch (action) {
    case "repository-migration": return "Review repository migration";
    case "lock-recovery": return "Recover stale lock";
    case "transaction-recovery": return "Recover interrupted transaction";
  }
}

function recoveryEffect(action: RecoveryActionId): string {
  switch (action) {
    case "repository-migration": return "copy validated repository guidance to the target identity, preserve the source, and attach the current repository locator to the target";
    case "lock-recovery": return "run the injected stale-lock recovery";
    case "transaction-recovery": return "run the injected transaction recovery";
  }
}

function recoveryBlockerLabel(blocker: RecoveryBlockerCode): string {
  switch (blocker) {
    case "repository-migration-required": return "repository migration";
    case "lock-recovery-required": return "stale lock";
    case "transaction-recovery-required": return "interrupted transaction";
  }
}

async function choose(
  context: ExtensionContext,
  title: string,
  choices: readonly string[],
): Promise<string | undefined> {
  const options = choices.map((choice, index) => `${index + 1}. ${choice}`);
  const selected = await context.ui.select(clip(title), options, { initialIndex: 0 });
  if (selected === undefined) return undefined;
  const index = options.indexOf(selected);
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

function scopeLabel(scope: ScopeRef): string {
  return scope.type;
}

function safeCode(value: string): string {
  return SAFE_CODE.test(value) ? value : "unavailable";
}

function safeTimestamp(value: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    ? value
    : "unavailable";
}

function clip(value: string, maximum = MAX_UI_TEXT): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
