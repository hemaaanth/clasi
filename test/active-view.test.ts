import { describe, expect, test } from "bun:test";
import {
  ActiveView,
} from "../src/active-view.ts";
import type {
  ActiveContextReader,
  ActiveNapkinReader,
  ActivePapercutReader,
  ActiveViewResult,
} from "../src/active-view.ts";
import type { ScopeRef } from "../src/paths.ts";
import type { ContextRecord, NapkinCategory, NapkinRecord, PapercutRecord } from "../src/schema.ts";
import { opaque } from "./support/store-fixture.ts";

const GLOBAL = { type: "global", id: "global" } as const satisfies ScopeRef;
const MACHINE = {
  type: "machine",
  id: opaque("machine", 1),
} as const satisfies ScopeRef;
const REPOSITORY = {
  type: "repository",
  id: opaque("repo", 1),
} as const satisfies ScopeRef;
const NOW = "2026-08-09T12:00:00.000Z";

function requireView(result: ActiveViewResult) {
  if (result.status !== "ok") throw new Error(`Expected active view, got ${result.code}`);
  return result;
}

function contextRecord(
  sequence: number,
  logicalKey: string,
  value: string,
  priority: number,
): ContextRecord {
  return {
    id: opaque("ctx", sequence),
    logicalKey,
    kind: "fact",
    value,
    sourceClassification: "explicit-user-input",
    approved: true,
    priority,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function napkinRecord(
  sequence: number,
  logicalKey: string,
  action: string,
  priority: number,
  category: NapkinCategory = "Execution",
): NapkinRecord {
  return {
    id: opaque("napkin", sequence),
    logicalKey,
    category,
    priority,
    recurrence: 1,
    hitCount: 0,
    situation: "the workflow repeats",
    action,
    sourceClassification: "explicit-user-input",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function papercutRecord(
  sequence: number,
  severity: PapercutRecord["severity"],
  summary: string,
): PapercutRecord {
  return {
    id: opaque("cut", sequence),
    fingerprint: `friction-${sequence}`,
    summary,
    severity,
    prevention: "Use the validated workflow.",
    acceptanceCondition: "The workflow completes.",
    sourceClassification: "explicit-user-input",
    lifecycle: "open",
    repairState: "none",
    publicationState: "none",
    publicationIssueNumber: null,
    recurrence: 1,
    relatedIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function readers(input: {
  context?: ActiveContextReader;
  napkins?: ReadonlyMap<ScopeRef["type"], readonly NapkinRecord[]>;
  papercuts?: ReadonlyMap<ScopeRef["type"], readonly PapercutRecord[]>;
  categoryCap?: number;
} = {}): {
  context: ActiveContextReader;
  napkin: ActiveNapkinReader;
  papercuts: ActivePapercutReader;
} {
  return {
    context: input.context ?? {
      resolve: async () => ({ status: "ok", active: [], shadowed: [], unapproved: [] }),
    },
    napkin: {
      list: async scope => ({
        status: "ok",
        categoryCap: input.categoryCap ?? 5,
        records: [...(input.napkins?.get(scope.type) ?? [])],
      }),
    },
    papercuts: {
      inbox: async scope => ({
        status: "ok",
        records: [...(input.papercuts?.get(scope.type) ?? [])],
      }),
    },
  };
}

describe("active view assembly", () => {
  test("applies scope precedence and category caps while exposing stable Napkin IDs", async () => {
    const receivedScopes: ScopeRef[][] = [];
    const context: ActiveContextReader = {
      resolve: async scopes => {
        receivedScopes.push([...scopes]);
        return {
          status: "ok",
          active: [
            { scope: REPOSITORY, record: contextRecord(1, "package-manager", "Use Bun.", 90) },
            { scope: GLOBAL, record: contextRecord(2, "test-policy", "Run focused tests.", 80) },
          ],
          shadowed: [],
          unapproved: [],
        };
      },
    };
    const napkins = new Map<ScopeRef["type"], readonly NapkinRecord[]>([
      ["global", [
        napkinRecord(1, "shared-lesson", "global action", 100),
        napkinRecord(2, "global-only", "global-only action", 80),
        napkinRecord(3, "global-extra", "global-extra action", 70),
      ]],
      ["machine", [napkinRecord(4, "shared-lesson", "machine action", 20)]],
      ["repository", [
        napkinRecord(5, "shared-lesson", "repository action", 100),
        napkinRecord(6, "repository-only", "repository-only action", 90),
      ]],
    ]);
    const dependencies = readers({ context, napkins, categoryCap: 2 });
    const view = new ActiveView(dependencies);

    const result = requireView(await view.build([REPOSITORY, GLOBAL, MACHINE]));

    expect(receivedScopes).toEqual([[GLOBAL, MACHINE, REPOSITORY]]);
    expect(result.content).toContain("package-manager: Use Bun.");
    expect(result.content).toContain(`[${opaque("napkin", 5)}]`);
    expect(result.content).toContain("repository action");
    expect(result.content).toContain("repository-only action");
    expect(result.content).not.toContain("global action");
    expect(result.content).not.toContain("machine action");
    expect(result.content).not.toContain("global-only action");
    expect(result.serializedCharacters).toBe(result.content.length);
  });

  test("serializes deterministically and exposes only Papercut severity counts", async () => {
    let reverse = false;
    const first = napkinRecord(10, "validation-order", "validate before writing", 70, "Validation");
    const second = napkinRecord(11, "execution-order", "inspect before editing", 80, "Execution");
    const contextA = contextRecord(10, "runtime", "Use the local runtime.", 70);
    const contextB = contextRecord(11, "commands", "Prefer bounded commands.", 80);
    const papercutBody = "Sensitive Papercut body must never be injected.";
    const context: ActiveContextReader = {
      resolve: async () => {
        reverse = !reverse;
        const active = [
          { scope: GLOBAL, record: contextA },
          { scope: MACHINE, record: contextB },
        ];
        return {
          status: "ok",
          active: reverse ? active : [...active].reverse(),
          shadowed: [],
          unapproved: [],
        };
      },
    };
    const dependencies = readers({
      context,
      napkins: new Map<ScopeRef["type"], readonly NapkinRecord[]>([
        ["global", [first, second]],
      ]),
      papercuts: new Map<ScopeRef["type"], readonly PapercutRecord[]>([
        ["global", [
          papercutRecord(1, "minor", papercutBody),
          papercutRecord(2, "blocker", "Another private body."),
        ]],
        ["repository", [papercutRecord(3, "major", "Repository-only body.")]],
      ]),
    });
    const view = new ActiveView(dependencies);

    const firstBuild = requireView(await view.build([GLOBAL, MACHINE, REPOSITORY]));
    const secondBuild = requireView(await view.build([GLOBAL, MACHINE, REPOSITORY]));

    expect(secondBuild.content).toBe(firstBuild.content);
    expect(firstBuild.openPapercuts).toEqual({ minor: 1, major: 1, blocker: 1 });
    expect(firstBuild.content).toContain("- blocker: 1");
    expect(firstBuild.content).toContain("- major: 1");
    expect(firstBuild.content).toContain("- minor: 1");
    expect(firstBuild.content).not.toContain(papercutBody);
    expect(firstBuild.content).not.toContain("Another private body.");
    expect(firstBuild.content).not.toContain("Repository-only body.");
    expect(firstBuild.content).toContain("Current user instructions and repository state remain authoritative.");
  });

  test("enforces the hard character cap by omitting whole lowest-ranked lines", async () => {
    const highValue = `high-${"a".repeat(60)}`;
    const lowValue = `low-${"b".repeat(120)}`;
    const context: ActiveContextReader = {
      resolve: async () => ({
        status: "ok",
        active: [
          { scope: GLOBAL, record: contextRecord(20, "low-ranked", lowValue, 1) },
          { scope: REPOSITORY, record: contextRecord(21, "high-ranked", highValue, 100) },
        ],
        shadowed: [],
        unapproved: [],
      }),
    };
    const view = new ActiveView({ ...readers({ context }), characterCap: 500 });

    const result = requireView(await view.build([GLOBAL, REPOSITORY]));

    expect(result.serializedCharacters).toBeLessThanOrEqual(500);
    expect(result.content).toContain(`high-ranked: ${highValue}`);
    expect(result.content).not.toContain("low-ranked");
    expect(result.content).not.toContain(lowValue);
    expect(result.omittedItems).toBe(1);
    expect(result.content.endsWith("\n")).toBeTrue();
  });

  test("returns no partial view when any applicable scope is degraded", async () => {
    const context: ActiveContextReader = {
      resolve: async () => ({
        status: "ok",
        active: [{
          scope: GLOBAL,
          record: contextRecord(30, "private-value", "Must not escape partial assembly.", 100),
        }],
        shadowed: [],
        unapproved: [],
      }),
    };
    const dependencies = readers({ context });
    const degradedNapkin: ActiveNapkinReader = {
      list: async scope => scope.type === "repository"
        ? { status: "rejected", code: "read-failed" }
        : { status: "ok", categoryCap: 5, records: [] },
    };
    const view = new ActiveView({ ...dependencies, napkin: degradedNapkin });

    const result = await view.build([GLOBAL, MACHINE, REPOSITORY]);

    expect(result).toEqual({ status: "unavailable", code: "napkin-unavailable" });
    expect(JSON.stringify(result)).not.toContain("Must not escape partial assembly.");
  });
});
