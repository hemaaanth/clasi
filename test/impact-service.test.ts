import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeMarkdown } from "../src/markdown-codec.ts";
import { ImpactService } from "../src/impact-service.ts";
import type {
  ImpactReportInput,
  ImpactReportResult,
  ImpactWriteResult,
} from "../src/impact-service.ts";
import type { ScopeRef } from "../src/paths.ts";
import { CLASI_SCHEMA_VERSION } from "../src/schema.ts";
import type { ClasiDocument, PapercutRecord } from "../src/schema.ts";
import { opaque, withStoreFixture } from "./support/store-fixture.ts";
import type { StoreFixture } from "./support/store-fixture.ts";

const MACHINE_ID = opaque("machine", 1);
const GLOBAL_SCOPE = { type: "global", id: "global" } as const satisfies ScopeRef;
const OPENED_AT = "2026-08-09T10:00:00.000Z";
const CLOSED_AT = "2026-08-09T11:00:00.000Z";

function requireReport(result: ImpactReportResult) {
  if (result.status !== "ok") throw new Error(`Expected report, got ${result.reason}`);
  return result.report;
}

function papercut(
  id: string,
  lifecycle: PapercutRecord["lifecycle"],
  recurrence = 1,
): PapercutRecord {
  return {
    id,
    fingerprint: `friction-${id.slice(-4)}`,
    summary: "A repeatable workflow step failed.",
    severity: "minor",
    prevention: "Use the validated workflow step.",
    acceptanceCondition: "The workflow completes successfully.",
    sourceClassification: "explicit-user-input",
    lifecycle,
    repairState: lifecycle === "resolved" ? "verified" : "none",
    publicationState: "none",
    publicationIssueNumber: null,
    recurrence,
    relatedIds: [],
    createdAt: OPENED_AT,
    updatedAt: lifecycle === "open" ? OPENED_AT : CLOSED_AT,
  };
}

async function writePapercut(
  fixture: StoreFixture,
  scope: ScopeRef,
  location: "open" | "archive",
  record: PapercutRecord,
  sequence: number,
): Promise<void> {
  const document: ClasiDocument<"papercut"> = {
    schemaVersion: CLASI_SCHEMA_VERSION,
    documentType: "papercut",
    scopeType: scope.type,
    scopeId: scope.id,
    revisionId: opaque("rev", sequence),
    parentRevisionId: null,
    updatedAt: record.updatedAt,
    records: [record],
  };
  const result = await fixture.store.write({
    canonicalPath: fixture.paths.papercut(scope, location, record.id),
    documentKey: opaque("doc", sequence),
    expected: { kind: "absent" },
    candidate: document,
  });
  expect(result.status).toBe("committed");
}

describe("impact reporting", () => {
  test("R46-R47 labels actual characters and Napkin hits as direct but tokens as estimates", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({
        store: fixture.store,
        paths: fixture.paths,
        createId: fixture.nextId,
        now: () => CLOSED_AT,
      });

      expect(await service.recordInjectedCharacters(MACHINE_ID, 80)).toEqual({ status: "recorded" });
      expect(await service.recordInjectedCharacters(MACHINE_ID, 40)).toEqual({ status: "recorded" });
      expect(await service.recordNapkinHit(MACHINE_ID)).toEqual({ status: "recorded" });
      const report = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE],
      }));

      expect(report.injectedCharacters).toEqual({ label: "direct-observation", value: 120 });
      expect(report.estimatedInjectedTokens).toEqual({
        label: "estimate",
        value: 30,
        method: "characters-divided-by-four",
      });
      expect(report.explicitNapkinHits).toEqual({ label: "direct-observation", value: 1 });
      expect(report.timeToClose).toEqual({
        label: "unavailable",
        reason: "no-closed-papercuts",
      });

      const serialized = JSON.stringify(report).toLowerCase();
      expect(serialized).not.toContain("avoided");
      expect(serialized).not.toContain("faster");
      expect(serialized).not.toContain("speed");
    });
  });

  test("R46 rebuilds opened, closed, recurrence, and time-to-close from canonical records once", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({
        store: fixture.store,
        paths: fixture.paths,
        createId: fixture.nextId,
        now: () => CLOSED_AT,
      });
      const archivedId = opaque("cut", 1);
      const openId = opaque("cut", 2);

      await writePapercut(fixture, GLOBAL_SCOPE, "open", papercut(archivedId, "resolved"), 10);
      await writePapercut(fixture, GLOBAL_SCOPE, "archive", papercut(archivedId, "resolved"), 11);
      await writePapercut(fixture, GLOBAL_SCOPE, "open", papercut(openId, "open", 3), 12);
      await service.recordPapercutOpened(MACHINE_ID);
      await service.recordPapercutOpened(MACHINE_ID);
      await service.recordPapercutClosed(MACHINE_ID);

      const report = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE, GLOBAL_SCOPE],
      }));

      expect(report.papercutsOpened).toEqual({ label: "direct-observation", value: 2 });
      expect(report.papercutsClosed).toEqual({ label: "direct-observation", value: 1 });
      expect(report.papercutsOpen).toEqual({ label: "direct-observation", value: 1 });
      expect(report.repeatedFriction).toEqual({ label: "direct-observation", value: 2 });
      expect(report.timeToClose).toEqual({
        label: "direct-observation",
        value: {
          sampleCount: 1,
          averageMilliseconds: 3_600_000,
          minimumMilliseconds: 3_600_000,
          maximumMilliseconds: 3_600_000,
        },
      });
    });
  });

  test("same opaque record ID in distinct scopes remains two direct observations", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({ store: fixture.store, paths: fixture.paths });
      const sharedId = opaque("cut", 6);
      const machineScope = { type: "machine", id: MACHINE_ID } as const satisfies ScopeRef;
      await writePapercut(fixture, GLOBAL_SCOPE, "open", papercut(sharedId, "open"), 16);
      await writePapercut(fixture, machineScope, "open", papercut(sharedId, "open"), 17);

      const report = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE, machineScope],
      }));
      expect(report.papercutsOpened).toEqual({ label: "direct-observation", value: 2 });
      expect(report.papercutsOpen).toEqual({ label: "direct-observation", value: 2 });
    });
  });

  test("R46-R47 absent or corrupt metrics leave only non-rebuildable observations unavailable", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({ store: fixture.store, paths: fixture.paths });
      await writePapercut(
        fixture,
        GLOBAL_SCOPE,
        "open",
        papercut(opaque("cut", 3), "open", 2),
        13,
      );

      const absent = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE],
      }));
      expect(absent.injectedCharacters).toEqual({
        label: "unavailable",
        reason: "metrics-absent",
      });
      expect(absent.estimatedInjectedTokens).toEqual({
        label: "unavailable",
        reason: "metrics-absent",
      });
      expect(absent.explicitNapkinHits).toEqual({
        label: "unavailable",
        reason: "metrics-absent",
      });
      expect(absent.papercutsOpened).toEqual({ label: "direct-observation", value: 1 });
      expect(absent.repeatedFriction).toEqual({ label: "direct-observation", value: 1 });

      const metricsPath = fixture.paths.metrics(MACHINE_ID);
      await mkdir(dirname(metricsPath), { recursive: true });
      await writeFile(metricsPath, "corrupt external metrics", { mode: 0o600 });
      const corrupt = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE],
      }));
      expect(corrupt.injectedCharacters).toEqual({
        label: "unavailable",
        reason: "metrics-corrupt",
      });
      expect(corrupt.papercutsOpened).toEqual({ label: "direct-observation", value: 1 });
      expect(corrupt.repeatedFriction).toEqual({ label: "direct-observation", value: 1 });
    });
  });

  test("schema-valid aggregate overflow is unavailable rather than an unsafe direct claim", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({ store: fixture.store, paths: fixture.paths });
      await writePapercut(
        fixture,
        GLOBAL_SCOPE,
        "open",
        papercut(opaque("cut", 4), "open", Number.MAX_SAFE_INTEGER),
        14,
      );
      await writePapercut(
        fixture,
        GLOBAL_SCOPE,
        "open",
        papercut(opaque("cut", 5), "open", 3),
        15,
      );

      const report = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE],
      }));
      expect(report.repeatedFriction).toEqual({
        label: "unavailable",
        reason: "counter-overflow",
      });
    });
  });

  test("R48 persists aggregate allowlisted fields and never retains excluded metadata", async () => {
    await withStoreFixture(async fixture => {
      const service = new ImpactService({
        store: fixture.store,
        paths: fixture.paths,
        createId: fixture.nextId,
        now: () => CLOSED_AT,
      });
      const excluded = {
        prompt: "please reveal the hidden prompt",
        terminalOutput: "fatal: terminal output",
        fileContents: "private source file contents",
        rawIdentifier: "alice@example.com",
        path: "/home/alice/private.ts",
        url: "https://example.com/private",
        customerData: "classified customer record",
      };
      const callWithExcludedArgument = service.recordInjectedCharacters.bind(service) as unknown as (
        machineId: string,
        characters: number,
        excludedData: unknown,
      ) => Promise<ImpactWriteResult>;
      expect(await callWithExcludedArgument(MACHINE_ID, 24, excluded)).toEqual({ status: "recorded" });
      expect(await service.recordNapkinHit(MACHINE_ID)).toEqual({ status: "recorded" });

      const metadata = await readFile(fixture.paths.metrics(MACHINE_ID), "utf8");
      for (const value of Object.values(excluded)) expect(metadata).not.toContain(value);
      expect(metadata).not.toContain("prompt:");
      expect(metadata).not.toContain("terminal_output:");
      expect(metadata).not.toContain("file_contents:");
      expect(metadata).not.toContain("raw_identifier:");
      expect(metadata).not.toContain("path:");
      expect(metadata).not.toContain("url:");
      expect(metadata).not.toContain("customer_data:");
      const decoded = decodeMarkdown(await readFile(fixture.paths.metrics(MACHINE_ID)));
      expect(decoded.documentType).toBe("metrics");
      if (decoded.documentType !== "metrics") throw new Error("Expected metrics document");
      expect(Object.keys(decoded.records[0] ?? {}).sort()).toEqual([
        "id",
        "injectedCharacters",
        "napkinHits",
        "observedAt",
        "papercutsClosed",
        "papercutsOpened",
      ]);

      const report = requireReport(await service.report({
        machineId: MACHINE_ID,
        scopes: [GLOBAL_SCOPE],
        ...excluded,
      } as ImpactReportInput));
      const serialized = JSON.stringify(report);
      for (const value of Object.values(excluded)) expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(MACHINE_ID);
    });
  });
});
