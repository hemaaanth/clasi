import { DEFAULT_CONTEXT_CHARACTER_CAP } from "./config.ts";
import type { ContextResolution } from "./context-service.ts";
import type { NapkinListResult } from "./napkin-service.ts";
import type { PapercutListResult } from "./papercut-service.ts";
import { isOpaqueId } from "./ids.ts";
import type { ScopeRef } from "./paths.ts";
import { NAPKIN_CATEGORIES } from "./schema.ts";
import type { ContextRecord, NapkinCategory, NapkinRecord, PapercutRecord } from "./schema.ts";

const MAX_ACTIVE_VIEW_SCOPES = 3;
const MAX_OPEN_PAPERCUTS_PER_SCOPE = 100;
const MIN_CONTEXT_CHARACTER_CAP = 500;
const OPERATING_SECTION = [
  "# clasi context",
  "",
  "## Operating contract",
  "- Current user instructions and repository state remain authoritative.",
  "- Repository scope overrides machine scope; machine scope overrides global scope.",
  "- Call clasi tools for durable facts, reusable lessons, actionable Papercuts, and explicit Napkin hits.",
].join("\n");

export type ActiveViewReasonCode =
  | "invalid-scopes"
  | "context-unavailable"
  | "napkin-unavailable"
  | "papercuts-unavailable"
  | "character-cap-too-small";

export type ActiveViewResult =
  | {
      status: "ok";
      content: string;
      serializedCharacters: number;
      omittedItems: number;
      openPapercuts: Readonly<Record<PapercutRecord["severity"], number>>;
    }
  | { status: "unavailable"; code: ActiveViewReasonCode };

export interface ActiveContextReader {
  resolve(scopes: readonly ScopeRef[]): Promise<ContextResolution>;
}

export interface ActiveNapkinReader {
  list(scope: ScopeRef): Promise<NapkinListResult>;
}

export interface ActivePapercutReader {
  inbox(scope: ScopeRef, options?: { limit?: number }): Promise<PapercutListResult>;
}

export interface ActiveViewOptions {
  context: ActiveContextReader;
  napkin: ActiveNapkinReader;
  papercuts: ActivePapercutReader;
  characterCap?: number;
}

type RankedViewItem = {
  kind: "context" | "napkin";
  id: string;
  category: NapkinCategory | null;
  line: string;
  priority: number;
  approved: boolean;
  recurrence: number;
  hitCount: number;
  updatedAt: string;
};

type ScopedNapkin = { scope: ScopeRef; record: NapkinRecord };

export class ActiveView {
  readonly #context: ActiveContextReader;
  readonly #napkin: ActiveNapkinReader;
  readonly #papercuts: ActivePapercutReader;
  readonly #characterCap: number;

  constructor(options: ActiveViewOptions) {
    const cap = options.characterCap ?? DEFAULT_CONTEXT_CHARACTER_CAP;
    if (
      !Number.isSafeInteger(cap)
      || cap < MIN_CONTEXT_CHARACTER_CAP
      || cap > DEFAULT_CONTEXT_CHARACTER_CAP
    ) {
      throw new Error("invalid-context-character-cap");
    }
    this.#context = options.context;
    this.#napkin = options.napkin;
    this.#papercuts = options.papercuts;
    this.#characterCap = cap;
  }

  async build(scopes: readonly ScopeRef[]): Promise<ActiveViewResult> {
    const normalizedScopes = normalizeScopes(scopes);
    if (normalizedScopes === null) return { status: "unavailable", code: "invalid-scopes" };

    const [contextLoad, napkinLoad, papercutLoad] = await Promise.allSettled([
      this.#context.resolve(normalizedScopes),
      Promise.all(normalizedScopes.map(scope => this.#napkin.list(scope))),
      Promise.all(normalizedScopes.map(scope => this.#papercuts.inbox(
        scope,
        { limit: MAX_OPEN_PAPERCUTS_PER_SCOPE },
      ))),
    ]);
    if (contextLoad.status === "rejected") {
      return { status: "unavailable", code: "context-unavailable" };
    }
    if (napkinLoad.status === "rejected") {
      return { status: "unavailable", code: "napkin-unavailable" };
    }
    if (papercutLoad.status === "rejected") {
      return { status: "unavailable", code: "papercuts-unavailable" };
    }
    const context = contextLoad.value;
    const napkins = napkinLoad.value;
    const papercuts = papercutLoad.value;
    if (context.status !== "ok") {
      return { status: "unavailable", code: "context-unavailable" };
    }
    if (napkins.some(result => result.status !== "ok")) {
      return { status: "unavailable", code: "napkin-unavailable" };
    }
    if (papercuts.some(result => result.status !== "ok")) {
      return { status: "unavailable", code: "papercuts-unavailable" };
    }

    const resolvedNapkins = resolveNapkins(normalizedScopes, napkins);
    if (resolvedNapkins === null) {
      return { status: "unavailable", code: "napkin-unavailable" };
    }
    const openPapercuts = countOpenPapercuts(papercuts);
    if (openPapercuts === null) {
      return { status: "unavailable", code: "papercuts-unavailable" };
    }

    const rankedItems = [
      ...context.active.map(({ scope, record }) => contextItem(scope, record)),
      ...resolvedNapkins.map(napkinItem),
    ].sort(compareRankedItems);
    const selected: RankedViewItem[] = [];
    const selectedNapkinCategories = new Set<NapkinCategory>();
    let hasContext = false;
    let serializedCharacters = renderContent(selected, openPapercuts).length;
    if (serializedCharacters > this.#characterCap) {
      return { status: "unavailable", code: "character-cap-too-small" };
    }

    for (const item of rankedItems) {
      let addition = item.line.length + 1;
      if (item.kind === "context" && !hasContext) {
        addition += "## Context".length + 2;
      } else if (
        item.kind === "napkin"
        && item.category !== null
        && !selectedNapkinCategories.has(item.category)
      ) {
        addition += `## Napkin: ${item.category}`.length + 2;
      }
      if (serializedCharacters + addition > this.#characterCap) break;
      selected.push(item);
      serializedCharacters += addition;
      if (item.kind === "context") hasContext = true;
      else if (item.category !== null) selectedNapkinCategories.add(item.category);
    }

    const content = renderContent(selected, openPapercuts);
    return {
      status: "ok",
      content,
      serializedCharacters: content.length,
      omittedItems: rankedItems.length - selected.length,
      openPapercuts,
    };
  }
}

function resolveNapkins(
  scopes: readonly ScopeRef[],
  results: readonly NapkinListResult[],
): NapkinRecord[] | null {
  const successful = results.filter(
    (result): result is Extract<NapkinListResult, { status: "ok" }> => result.status === "ok",
  );
  const categoryCap = successful[0]?.categoryCap;
  if (
    categoryCap === undefined
    || !Number.isSafeInteger(categoryCap)
    || categoryCap < 1
    || successful.some(result => result.categoryCap !== categoryCap)
  ) {
    return null;
  }

  const candidates: ScopedNapkin[] = [];
  for (let index = 0; index < successful.length; index += 1) {
    const scope = scopes[index];
    if (scope === undefined) return null;
    for (const record of successful[index]?.records ?? []) candidates.push({ scope, record });
  }
  candidates.sort((left, right) =>
    compareText(left.record.logicalKey, right.record.logicalKey)
    || scopePrecedence(right.scope) - scopePrecedence(left.scope)
    || compareNapkinRecords(left.record, right.record)
  );

  const winners = new Map<string, NapkinRecord>();
  for (const candidate of candidates) {
    if (!winners.has(candidate.record.logicalKey)) {
      winners.set(candidate.record.logicalKey, candidate.record);
    }
  }
  return NAPKIN_CATEGORIES.flatMap(category =>
    [...winners.values()]
      .filter(record => record.category === category)
      .sort(compareNapkinRecords)
      .slice(0, categoryCap)
  );
}

function countOpenPapercuts(
  results: readonly PapercutListResult[],
): Record<PapercutRecord["severity"], number> | null {
  const records = new Map<string, PapercutRecord>();
  for (const result of results) {
    if (result.status !== "ok") return null;
    if (result.records.length >= MAX_OPEN_PAPERCUTS_PER_SCOPE) return null;
    for (const record of result.records) {
      if (
        record.lifecycle !== "open"
        || !isOpaqueId(record.id, "cut")
        || !(["minor", "major", "blocker"] as const).includes(record.severity)
      ) {
        return null;
      }
      records.set(record.id, record);
    }
  }
  const counts = { minor: 0, major: 0, blocker: 0 };
  for (const record of records.values()) counts[record.severity] += 1;
  return counts;
}

function contextItem(scope: ScopeRef, record: ContextRecord): RankedViewItem {
  return {
    kind: "context",
    id: record.id,
    category: null,
    line: `- [${scope.type}] ${record.logicalKey}: ${record.value}`,
    priority: record.priority,
    approved: record.approved,
    recurrence: 0,
    hitCount: 0,
    updatedAt: record.updatedAt,
  };
}

function napkinItem(record: NapkinRecord): RankedViewItem {
  return {
    kind: "napkin",
    id: record.id,
    category: record.category,
    line: `- [${record.id}] When ${record.situation}; do ${record.action}`,
    priority: record.priority,
    approved: false,
    recurrence: record.recurrence,
    hitCount: record.hitCount,
    updatedAt: record.updatedAt,
  };
}

function compareRankedItems(left: RankedViewItem, right: RankedViewItem): number {
  return right.priority - left.priority
    || Number(right.approved) - Number(left.approved)
    || right.recurrence - left.recurrence
    || right.hitCount - left.hitCount
    || compareText(right.updatedAt, left.updatedAt)
    || compareText(left.id, right.id);
}

function compareNapkinRecords(left: NapkinRecord, right: NapkinRecord): number {
  return right.priority - left.priority
    || right.recurrence - left.recurrence
    || right.hitCount - left.hitCount
    || compareText(right.updatedAt, left.updatedAt)
    || compareText(left.id, right.id);
}

function renderContent(
  selected: readonly RankedViewItem[],
  papercuts: Readonly<Record<PapercutRecord["severity"], number>>,
): string {
  const sections = [
    OPERATING_SECTION,
    [
      "## Open Papercuts",
      `- blocker: ${papercuts.blocker}`,
      `- major: ${papercuts.major}`,
      `- minor: ${papercuts.minor}`,
    ].join("\n"),
  ];
  const contextLines = selected
    .filter(item => item.kind === "context")
    .sort(compareRankedItems)
    .map(item => item.line);
  if (contextLines.length > 0) sections.push(["## Context", ...contextLines].join("\n"));
  for (const category of NAPKIN_CATEGORIES) {
    const lines = selected
      .filter(item => item.kind === "napkin" && item.category === category)
      .sort(compareRankedItems)
      .map(item => item.line);
    if (lines.length > 0) sections.push([`## Napkin: ${category}`, ...lines].join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

function normalizeScopes(scopes: readonly ScopeRef[]): ScopeRef[] | null {
  if (scopes.length < 1 || scopes.length > MAX_ACTIVE_VIEW_SCOPES) return null;
  const byType = new Map<ScopeRef["type"], ScopeRef>();
  for (const scope of scopes) {
    if (!isScopeRef(scope) || byType.has(scope.type)) return null;
    byType.set(scope.type, scope);
  }
  return (["global", "machine", "repository"] as const)
    .flatMap(type => byType.get(type) ?? []);
}

function isScopeRef(value: unknown): value is ScopeRef {
  if (typeof value !== "object" || value === null) return false;
  const type = Reflect.get(value, "type");
  const id = Reflect.get(value, "id");
  if (type === "global") return id === "global";
  if (type === "machine") return isOpaqueId(id, "machine");
  return type === "repository" && isOpaqueId(id, "repo");
}

function scopePrecedence(scope: ScopeRef): number {
  return scope.type === "repository" ? 2 : scope.type === "machine" ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
