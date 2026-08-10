import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import type { ClasiConfig, ClasiRoots, ResolvedClasiConfig } from "./config.ts";
import { collapseHomePath, resolveClasiConfig } from "./config.ts";
import { createOpaqueId } from "./ids.ts";
import { readOrCreateMachineId } from "./machine.ts";
import type { MachineFacts } from "./machine.ts";
import { MarkdownStore, StoreError } from "./markdown-store.ts";
import { createClasiPaths } from "./paths.ts";
import type { ClasiPaths, ScopeRef } from "./paths.ts";
import { scanExcludedData, validatePrivateFields } from "./privacy.ts";
import {
  RootSafetyError,
  assertRootUnchanged,
  assertSafeContainedPath,
  createPrivateRoot,
  hasErrorCode,
  pinRoot,
  readImportFileBounded,
} from "./root-safety.ts";
import type { AnyClasiDocument, ClasiDocument, ContextRecord, ProposalRecord } from "./schema.ts";

export interface SetupPreference {
  logicalKey: string;
  value: string;
  approved: boolean;
}

export interface SetupImportCandidate {
  sourcePath: string;
  scope: "global" | "machine";
  logicalKey: string;
  summary: string;
}

export interface PrepareSetupInput {
  roots: ClasiRoots;
  home: string;
  machineFacts: MachineFacts;
  config?: Omit<Partial<ClasiConfig>, "dataRoot">;
  globalPreference?: SetupPreference;
  machinePreference?: SetupPreference;
  imports?: readonly SetupImportCandidate[];
  now?: string;
}

export interface PreparedImport {
  proposalId: string;
  sourcePath: string;
  scope: "global" | "machine";
  logicalKey: string;
  summary: string;
}

export interface SkippedImport {
  sourcePath: string;
  code: string;
}

export interface SetupPlan {
  roots: ClasiRoots;
  home: string;
  config: ResolvedClasiConfig;
  machineFacts: MachineFacts;
  globalPreference?: SetupPreference;
  machinePreference?: SetupPreference;
  imports: PreparedImport[];
  skippedImports: SkippedImport[];
  preparedAt: string;
}

export type SetupCommitResult =
  | { status: "cancelled" }
  | {
      status: "committed";
      machineId: string;
      activatedMachineFacts: number;
      activatedPreferences: number;
      stagedImports: number;
      skippedImports: SkippedImport[];
    };

export class SetupError extends Error {
  constructor(readonly code:
    | "preference-approval-required"
    | "setup-already-configured"
    | "setup-conflict"
    | "config-write-failed"
  ) {
    super(code);
    this.name = "SetupError";
  }
}

export async function prepareSetup(input: PrepareSetupInput): Promise<SetupPlan> {
  const config = resolveClasiConfig(
    { dataRoot: input.roots.dataRoot, ...input.config },
    input.home,
  );
  for (const preference of [input.globalPreference, input.machinePreference]) {
    if (!preference) continue;
    if (!preference.approved) throw new SetupError("preference-approval-required");
    const validation = validatePrivateFields({
      classification: "explicit-user-input",
      fields: { logical_key: preference.logicalKey, value: preference.value },
    });
    if (!validation.ok) throw new SetupError("setup-conflict");
  }

  const imports: PreparedImport[] = [];
  const skippedImports: SkippedImport[] = [];
  for (const candidate of input.imports ?? []) {
    try {
      const bytes = await readImportFileBounded(candidate.sourcePath);
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        skippedImports.push({ sourcePath: candidate.sourcePath, code: "invalid-utf8" });
        continue;
      }
      source = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      const sourceValidation = scanExcludedData(source);
      if (!sourceValidation.ok) {
        skippedImports.push({ sourcePath: candidate.sourcePath, code: sourceValidation.code });
        continue;
      }
      const validation = validatePrivateFields({
        classification: "explicit-user-input",
        fields: { logical_key: candidate.logicalKey, summary: candidate.summary },
      });
      if (!validation.ok) {
        skippedImports.push({ sourcePath: candidate.sourcePath, code: validation.code });
        continue;
      }
      imports.push({
        proposalId: stableId(
          "proposal",
          `${candidate.scope}:${candidate.logicalKey}:${candidate.summary}`,
        ),
        sourcePath: candidate.sourcePath,
        scope: candidate.scope,
        logicalKey: candidate.logicalKey,
        summary: candidate.summary,
      });
    } catch (error) {
      skippedImports.push({
        sourcePath: candidate.sourcePath,
        code: safeReasonCode(error, "import-unavailable"),
      });
    }
  }

  return {
    roots: { ...input.roots, dataRoot: config.dataRoot },
    home: input.home,
    config,
    machineFacts: input.machineFacts,
    ...(input.globalPreference ? { globalPreference: input.globalPreference } : {}),
    ...(input.machinePreference ? { machinePreference: input.machinePreference } : {}),
    imports,
    skippedImports,
    preparedAt: input.now ?? new Date().toISOString(),
  };
}

export async function commitSetup(
  plan: SetupPlan,
  options: { confirm: boolean },
): Promise<SetupCommitResult> {
  if (!options.confirm) return { status: "cancelled" };

  await createPrivateRoot(plan.roots.controlRoot);
  const controlPin = await pinRoot(plan.roots.controlRoot);
  const paths = createClasiPaths(plan.roots);
  await assertSafeContainedPath(controlPin, paths.config, {
    kind: "file",
    allowMissingLeaf: true,
    maximumBytes: 16_384,
  });
  await assertConfigAbsentOrEquivalent(paths.config, plan, controlPin);

  await createPrivateRoot(plan.roots.dataRoot);
  const dataPin = await pinRoot(plan.roots.dataRoot);
  const machineId = await readOrCreateMachineId(paths, { controlPin });
  const store = new MarkdownStore({ controlPin, dataPin, paths });

  const machineScope: ScopeRef = { type: "machine", id: machineId };
  const machineRecords = machineFactRecords(plan.machineFacts, plan.preparedAt);
  if (plan.machinePreference) {
    machineRecords.push(preferenceRecord(plan.machinePreference, plan.preparedAt));
  }
  await ensureInitialDocument(
    store,
    paths,
    paths.context(machineScope),
    machineScope,
    "context",
    machineRecords,
    plan.preparedAt,
  );

  let activatedPreferences = plan.machinePreference ? 1 : 0;
  if (plan.globalPreference) {
    const globalScope: ScopeRef = { type: "global", id: "global" };
    await ensureInitialDocument(
      store,
      paths,
      paths.context(globalScope),
      globalScope,
      "context",
      [preferenceRecord(plan.globalPreference, plan.preparedAt)],
      plan.preparedAt,
    );
    activatedPreferences += 1;
  }

  for (const candidate of plan.imports) {
    const scope: ScopeRef = candidate.scope === "global"
      ? { type: "global", id: "global" }
      : machineScope;
    const now = plan.preparedAt;
    const record: ProposalRecord = {
      id: candidate.proposalId,
      targetType: "context",
      logicalKey: candidate.logicalKey,
      summary: candidate.summary,
      sourceClassification: "explicit-user-input",
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    await ensureInitialDocument(
      store,
      paths,
      paths.proposal(scope, candidate.proposalId),
      scope,
      "proposal",
      [record],
      now,
    );
  }

  await writeConfigLast(paths.config, plan, controlPin);
  return {
    status: "committed",
    machineId,
    activatedMachineFacts: machineRecords.length - (plan.machinePreference ? 1 : 0),
    activatedPreferences,
    stagedImports: plan.imports.length,
    skippedImports: plan.skippedImports,
  };
}

function machineFactRecords(facts: MachineFacts, now: string): ContextRecord[] {
  const values: Array<[string, string | undefined]> = [
    ["machine.os-boundary", facts.osBoundary],
    ["machine.architecture", facts.architecture],
    ["machine.wsl", facts.wsl],
    ["machine.container", String(facts.container)],
    ["machine.shell", facts.shell && `${facts.shell.basename}:${facts.shell.family}`],
    ["machine.tool-managers", facts.toolManagers.length ? facts.toolManagers.join(",") : undefined],
    ["machine.filesystem", facts.filesystemConvention],
    ["machine.cpu-profile", facts.cpuBucket],
    ["machine.memory-profile", facts.memoryBucket],
  ];
  return values.flatMap(([logicalKey, value]) => value === undefined ? [] : [{
    id: stableId("ctx", `${logicalKey}:${value}`),
    logicalKey,
    kind: "fact" as const,
    value,
    sourceClassification: "safe-machine-fact" as const,
    approved: true,
    priority: 100,
    createdAt: now,
    updatedAt: now,
  }]);
}

function preferenceRecord(preference: SetupPreference, now: string): ContextRecord {
  return {
    id: stableId("ctx", `${preference.logicalKey}:${preference.value}`),
    logicalKey: preference.logicalKey,
    kind: "preference",
    value: preference.value,
    sourceClassification: "explicit-user-input",
    approved: true,
    priority: 100,
    createdAt: now,
    updatedAt: now,
  };
}

async function ensureInitialDocument<T extends "context" | "proposal">(
  store: MarkdownStore,
  paths: ClasiPaths,
  canonicalPath: string,
  scope: ScopeRef,
  documentType: T,
  records: ClasiDocument<T>["records"],
  now: string,
): Promise<void> {
  try {
    const current = await store.read(canonicalPath);
    if (sameRecords(current.document, documentType, records)) return;
    throw new SetupError("setup-conflict");
  } catch (error) {
    if (!(error instanceof StoreError) || error.code !== "canonical-missing") throw error;
  }
  const document = {
    schemaVersion: 1,
    documentType,
    scopeType: scope.type,
    scopeId: scope.id,
    revisionId: createOpaqueId("rev"),
    parentRevisionId: null,
    updatedAt: now,
    records,
  } as ClasiDocument<T>;
  const result = await store.write({
    canonicalPath,
    documentKey: stableId("doc", canonicalPath),
    expected: { kind: "absent" },
    candidate: document as AnyClasiDocument,
  });
  if (result.status !== "committed") throw new SetupError("setup-conflict");
}

function sameRecords<T extends "context" | "proposal">(
  existing: AnyClasiDocument,
  documentType: T,
  records: ClasiDocument<T>["records"],
): boolean {
  if (existing.documentType !== documentType) return false;
  const project = (record: Record<string, unknown>) => {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...stable } = record;
    return stable;
  };
  return JSON.stringify(existing.records.map(record => project(record as unknown as Record<string, unknown>))) ===
    JSON.stringify(records.map(record => project(record as unknown as Record<string, unknown>)));
}

async function assertConfigAbsentOrEquivalent(
  path: string,
  plan: SetupPlan,
  controlPin: Awaited<ReturnType<typeof pinRoot>>,
): Promise<void> {
  try {
    await assertSafeContainedPath(controlPin, path, {
      kind: "file",
      allowMissingLeaf: true,
      maximumBytes: 16_384,
    });
    const bytes = await readImportFileBounded(path);
    if (bytes.byteLength > 16_384) throw new SetupError("setup-already-configured");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const existing = JSON.parse(text) as unknown;
    await assertRootUnchanged(controlPin);
    if (JSON.stringify(existing) !== JSON.stringify(configPayload(plan))) {
      throw new SetupError("setup-already-configured");
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || (
      error instanceof RootSafetyError && error.code === "root-missing"
    )) return;
    if (error instanceof SetupError) throw error;
    throw new SetupError("setup-already-configured");
  }
}

async function writeConfigLast(
  path: string,
  plan: SetupPlan,
  controlPin: Awaited<ReturnType<typeof pinRoot>>,
): Promise<void> {
  await assertRootUnchanged(controlPin);
  const content = `${JSON.stringify(configPayload(plan), null, 2)}\n`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  await assertSafeContainedPath(controlPin, temporary, {
    kind: "file",
    allowMissingLeaf: true,
    maximumBytes: 16_384,
  });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertSafeContainedPath(controlPin, temporary, {
      kind: "file",
      maximumBytes: 16_384,
    });
    try {
      await link(temporary, path);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await assertConfigAbsentOrEquivalent(path, plan, controlPin);
    }
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError("config-write-failed");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function configPayload(plan: SetupPlan): ClasiConfig & { schemaVersion: 1 } {
  return {
    schemaVersion: 1,
    dataRoot: collapseHomePath(plan.config.dataRoot, plan.home),
    napkinCategoryCap: plan.config.napkinCategoryCap,
    contextCharacterCap: plan.config.contextCharacterCap,
  };
}

function stableId(prefix: "ctx" | "doc" | "proposal", value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function safeReasonCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(code)) return code;
  }
  return fallback;
}
