import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import { createOpaqueId, isOpaqueId } from "./ids.ts";
import type { IdPrefix } from "./ids.ts";
import { MarkdownStore, StoreError } from "./markdown-store.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { CLASI_SCHEMA_VERSION } from "./schema.ts";
import type {
  AnyClasiDocument,
  ClasiDocument,
  MetricsRecord,
  PapercutRecord,
} from "./schema.ts";

const TOKEN_ESTIMATE_CHARACTER_RATIO = 4;
const MAX_REPORT_SCOPES = 32;
const DIRECTORY_PROBE_CUT_ID = "cut_00000000000000000000000000000000";
const PAPERCUT_FILE_PATTERN = /^(cut_[0-9a-f]{32})\.md$/;

export type DirectObservation<T> = {
  label: "direct-observation";
  value: T;
};

export type Estimate<T> = {
  label: "estimate";
  value: T;
  method: "characters-divided-by-four";
};

export type UnavailableMeasurement = {
  label: "unavailable";
  reason:
    | "metrics-absent"
    | "metrics-corrupt"
    | "papercuts-degraded"
    | "no-closed-papercuts"
    | "timestamps-unavailable"
    | "counter-overflow";
};

export type ImpactMeasurement<T> = DirectObservation<T> | UnavailableMeasurement;
export type ImpactEstimate<T> = Estimate<T> | UnavailableMeasurement;

export interface TimeToCloseSummary {
  sampleCount: number;
  averageMilliseconds: number;
  minimumMilliseconds: number;
  maximumMilliseconds: number;
}

export interface ImpactReport {
  injectedCharacters: ImpactMeasurement<number>;
  estimatedInjectedTokens: ImpactEstimate<number>;
  explicitNapkinHits: ImpactMeasurement<number>;
  papercutsOpened: ImpactMeasurement<number>;
  papercutsClosed: ImpactMeasurement<number>;
  papercutsOpen: ImpactMeasurement<number>;
  papercutsDismissed: ImpactMeasurement<number>;
  repeatedFriction: ImpactMeasurement<number>;
  timeToClose: ImpactMeasurement<TimeToCloseSummary>;
}

export interface ImpactReportInput {
  machineId: string;
  scopes: readonly ScopeRef[];
}

export type ImpactReportResult =
  | { status: "ok"; report: ImpactReport }
  | {
      status: "rejected";
      reason: "invalid-machine-id" | "invalid-scope" | "report-too-broad";
    };

export type ImpactWriteResult =
  | { status: "recorded" }
  | { status: "rejected"; reason: "invalid-machine-id" | "invalid-count" }
  | {
      status: "degraded";
      reason: "counter-overflow" | "metrics-conflict" | "metrics-corrupt" | "write-failed";
    };

export interface ImpactServiceOptions {
  store: MarkdownStore;
  paths: ClasiPaths;
  createId?: (prefix: IdPrefix) => string;
  now?: () => string;
}

type MetricsField =
  | "injectedCharacters"
  | "papercutsOpened"
  | "papercutsClosed"
  | "napkinHits";

type MetricsRead =
  | { status: "ok"; record: MetricsRecord }
  | { status: "absent" }
  | { status: "corrupt" };

type PapercutRead =
  | { status: "ok"; records: PapercutRecord[] }
  | { status: "degraded" };

class ImpactMutationError extends Error {
  constructor(readonly reason: "counter-overflow" | "metrics-corrupt") {
    super(reason);
    this.name = "ImpactMutationError";
  }
}

export class ImpactService {
  readonly #store: MarkdownStore;
  readonly #paths: ClasiPaths;
  readonly #createId: (prefix: IdPrefix) => string;
  readonly #now: () => string;

  constructor(options: ImpactServiceOptions) {
    this.#store = options.store;
    this.#paths = options.paths;
    this.#createId = options.createId ?? createOpaqueId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  recordInjectedCharacters(machineId: string, characters: number): Promise<ImpactWriteResult> {
    return this.#increment(machineId, "injectedCharacters", characters);
  }

  recordNapkinHit(machineId: string): Promise<ImpactWriteResult> {
    return this.#increment(machineId, "napkinHits", 1);
  }

  recordPapercutOpened(machineId: string): Promise<ImpactWriteResult> {
    return this.#increment(machineId, "papercutsOpened", 1);
  }

  recordPapercutClosed(machineId: string): Promise<ImpactWriteResult> {
    return this.#increment(machineId, "papercutsClosed", 1);
  }

  async report(input: ImpactReportInput): Promise<ImpactReportResult> {
    if (!isOpaqueId(input.machineId, "machine")) {
      return { status: "rejected", reason: "invalid-machine-id" };
    }
    if (input.scopes.length > MAX_REPORT_SCOPES) {
      return { status: "rejected", reason: "report-too-broad" };
    }
    if (!input.scopes.every(isScopeRef)) {
      return { status: "rejected", reason: "invalid-scope" };
    }

    const scopes = [
      ...new Map(input.scopes.map(scope => [`${scope.type}:${scope.id}`, scope])).values(),
    ];
    const [metrics, papercuts] = await Promise.all([
      this.#readMetrics(input.machineId),
      this.#readPapercuts(scopes),
    ]);

    const unavailableMetrics: UnavailableMeasurement | undefined = metrics.status === "ok"
      ? undefined
      : {
          label: "unavailable",
          reason: metrics.status === "absent" ? "metrics-absent" : "metrics-corrupt",
        };
    const injectedCharacters: ImpactMeasurement<number> = unavailableMetrics ?? direct(
      metrics.status === "ok" ? metrics.record.injectedCharacters : 0,
    );
    const explicitNapkinHits: ImpactMeasurement<number> = unavailableMetrics ?? direct(
      metrics.status === "ok" ? metrics.record.napkinHits : 0,
    );
    const estimatedInjectedTokens: ImpactEstimate<number> = metrics.status === "ok"
      ? {
          label: "estimate",
          value: Math.ceil(metrics.record.injectedCharacters / TOKEN_ESTIMATE_CHARACTER_RATIO),
          method: "characters-divided-by-four",
        }
      : unavailableMetrics as UnavailableMeasurement;

    if (papercuts.status === "degraded") {
      const unavailable: UnavailableMeasurement = {
        label: "unavailable",
        reason: "papercuts-degraded",
      };
      return {
        status: "ok",
        report: {
          injectedCharacters,
          estimatedInjectedTokens,
          explicitNapkinHits,
          papercutsOpened: unavailable,
          papercutsClosed: unavailable,
          papercutsOpen: unavailable,
          papercutsDismissed: unavailable,
          repeatedFriction: unavailable,
          timeToClose: unavailable,
        },
      };
    }

    const open = papercuts.records.filter(record => record.lifecycle === "open").length;
    const closed = papercuts.records.filter(record => record.lifecycle === "resolved").length;
    const dismissed = papercuts.records.filter(record => record.lifecycle === "dismissed").length;
    const repeats = safeSum(papercuts.records.map(record => record.recurrence - 1));
    const durations = papercuts.records
      .filter(record => record.lifecycle === "resolved")
      .map(record => Date.parse(record.updatedAt) - Date.parse(record.createdAt))
      .filter(duration => Number.isSafeInteger(duration) && duration >= 0);
    const durationSummary = durations.length === closed ? summarizeDurations(durations) : null;

    return {
      status: "ok",
      report: {
        injectedCharacters,
        estimatedInjectedTokens,
        explicitNapkinHits,
        papercutsOpened: direct(papercuts.records.length),
        papercutsClosed: direct(closed),
        papercutsOpen: direct(open),
        papercutsDismissed: direct(dismissed),
        repeatedFriction: repeats === null
          ? { label: "unavailable", reason: "counter-overflow" }
          : direct(repeats),
        timeToClose: closed === 0
          ? { label: "unavailable", reason: "no-closed-papercuts" }
          : durations.length !== closed
            ? { label: "unavailable", reason: "timestamps-unavailable" }
            : durationSummary === null
              ? { label: "unavailable", reason: "counter-overflow" }
              : direct(durationSummary),
      },
    };
  }

  async #increment(
    machineId: string,
    field: MetricsField,
    amount: number,
  ): Promise<ImpactWriteResult> {
    if (!isOpaqueId(machineId, "machine")) {
      return { status: "rejected", reason: "invalid-machine-id" };
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { status: "rejected", reason: "invalid-count" };
    }

    const canonicalPath = this.#paths.metrics(machineId);
    try {
      const result = await this.#store.mutate({
        canonicalPath,
        documentKey: stableDocumentKey(canonicalPath),
        mutate: current => {
          const now = this.#now();
          let record: MetricsRecord;
          if (current === null) {
            record = emptyMetrics(this.#createId("metric"), now);
          } else {
            const aggregate = aggregateMetrics(current.document, machineId);
            if (aggregate === null) throw new ImpactMutationError("metrics-corrupt");
            record = { ...aggregate, observedAt: now };
          }
          record[field] = checkedAdd(record[field], amount);
          return metricsDocument(
            machineId,
            this.#createId("rev"),
            current?.document.revisionId ?? null,
            now,
            record,
          );
        },
      });
      return result.status === "conflict"
        ? { status: "degraded", reason: "metrics-conflict" }
        : { status: "recorded" };
    } catch (error) {
      if (error instanceof ImpactMutationError) {
        return { status: "degraded", reason: error.reason };
      }
      return { status: "degraded", reason: "write-failed" };
    }
  }

  async #readMetrics(machineId: string): Promise<MetricsRead> {
    try {
      const read = await this.#store.read(this.#paths.metrics(machineId));
      const record = aggregateMetrics(read.document, machineId);
      return record === null ? { status: "corrupt" } : { status: "ok", record };
    } catch (error) {
      if (error instanceof StoreError && error.code === "canonical-missing") {
        return { status: "absent" };
      }
      return { status: "corrupt" };
    }
  }

  async #readPapercuts(scopes: readonly ScopeRef[]): Promise<PapercutRead> {
    const records = new Map<string, PapercutRecord>();
    for (const scope of scopes) {
      const open = await this.#readPapercutDirectory(scope, "open");
      if (open.status === "degraded") return open;
      for (const record of open.records) records.set(scopedRecordKey(scope, record.id), record);

      const archive = await this.#readPapercutDirectory(scope, "archive");
      if (archive.status === "degraded") return archive;
      // An archived canonical wins over a stale duplicate left in open, but is counted once.
      for (const record of archive.records) records.set(scopedRecordKey(scope, record.id), record);
    }
    return { status: "ok", records: [...records.values()] };
  }

  async #readPapercutDirectory(
    scope: ScopeRef,
    location: "open" | "archive",
  ): Promise<PapercutRead> {
    const directory = dirname(this.#paths.papercut(scope, location, DIRECTORY_PROBE_CUT_ID));
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && Reflect.get(error, "code") === "ENOENT"
      ) {
        return { status: "ok", records: [] };
      }
      return { status: "degraded" };
    }

    const records: PapercutRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = PAPERCUT_FILE_PATTERN.exec(entry.name);
      if (match === null) continue;
      const papercutId = match[1];
      if (papercutId === undefined) return { status: "degraded" };
      try {
        const read = await this.#store.read(this.#paths.papercut(scope, location, papercutId));
        const document = read.document;
        if (
          document.documentType !== "papercut"
          || document.scopeType !== scope.type
          || document.scopeId !== scope.id
          || document.records.length !== 1
        ) {
          return { status: "degraded" };
        }
        const record = document.records[0];
        if (
          record === undefined
          || record.id !== papercutId
          || (location === "archive" && record.lifecycle === "open")
        ) {
          return { status: "degraded" };
        }
        records.push(record);
      } catch {
        return { status: "degraded" };
      }
    }
    return { status: "ok", records };
  }
}

function metricsDocument(
  machineId: string,
  revisionId: string,
  parentRevisionId: string | null,
  now: string,
  record: MetricsRecord,
): ClasiDocument<"metrics"> {
  return {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "metrics",
    scopeType: "machine",
    scopeId: machineId,
    revisionId,
    parentRevisionId,
    updatedAt: now,
    records: [record],
  };
}

function aggregateMetrics(
  document: AnyClasiDocument,
  machineId: string,
): MetricsRecord | null {
  if (
    document.documentType !== "metrics"
    || document.scopeType !== "machine"
    || document.scopeId !== machineId
    || document.records.length === 0
  ) {
    return null;
  }
  return aggregateMetricsDocument(document);
}

function aggregateMetricsDocument(document: ClasiDocument<"metrics">): MetricsRecord {
  const records = new Map(document.records.map(record => [record.id, record]));
  const first = records.values().next().value as MetricsRecord | undefined;
  if (first === undefined) throw new ImpactMutationError("metrics-corrupt");
  let aggregate = emptyMetrics(first.id, first.observedAt);
  for (const record of records.values()) {
    aggregate = {
      id: aggregate.id,
      injectedCharacters: checkedAdd(aggregate.injectedCharacters, record.injectedCharacters),
      papercutsOpened: checkedAdd(aggregate.papercutsOpened, record.papercutsOpened),
      papercutsClosed: checkedAdd(aggregate.papercutsClosed, record.papercutsClosed),
      napkinHits: checkedAdd(aggregate.napkinHits, record.napkinHits),
      observedAt: record.observedAt > aggregate.observedAt ? record.observedAt : aggregate.observedAt,
    };
  }
  return aggregate;
}

function emptyMetrics(id: string, observedAt: string): MetricsRecord {
  return {
    id,
    injectedCharacters: 0,
    papercutsOpened: 0,
    papercutsClosed: 0,
    napkinHits: 0,
    observedAt,
  };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new ImpactMutationError("counter-overflow");
  return result;
}

function stableDocumentKey(canonicalPath: string): string {
  return `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`;
}

function direct<T>(value: T): DirectObservation<T> {
  return { label: "direct-observation", value };
}

function summarizeDurations(durations: readonly number[]): TimeToCloseSummary | null {
  const total = safeSum(durations);
  if (total === null) return null;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (const duration of durations) {
    minimum = Math.min(minimum, duration);
    maximum = Math.max(maximum, duration);
  }
  return {
    sampleCount: durations.length,
    averageMilliseconds: Math.round(total / durations.length),
    minimumMilliseconds: minimum,
    maximumMilliseconds: maximum,
  };
}

function safeSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function scopedRecordKey(scope: ScopeRef, recordId: string): string {
  return `${scope.type}:${scope.id}:${recordId}`;
}

function isScopeRef(value: unknown): value is ScopeRef {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  const id = Reflect.get(value, "id");
  if (type === "global") return id === "global";
  if (type === "machine") return isOpaqueId(id, "machine");
  return type === "repository" && isOpaqueId(id, "repo");
}

