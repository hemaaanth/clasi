import { describe, expect, test } from "bun:test";
import { NapkinService } from "../src/napkin-service.ts";
import type { CurateNapkinInput } from "../src/napkin-service.ts";
import type { ScopeRef } from "../src/paths.ts";
import { withStoreFixture } from "./support/store-fixture.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const GLOBAL_SCOPE: ScopeRef = { type: "global", id: "global" };

describe("NapkinService", () => {
  test("a sixth default-cap item demotes the lowest rank without deleting it or its revisions", async () => {
    await withStoreFixture(async fixture => {
      const napkin = service(fixture);
      const createdIds: string[] = [];
      for (let index = 1; index <= 6; index += 1) {
        const result = await napkin.curate(candidate(index, index * 10));
        expect(result.status).toBe("created");
        if (result.status === "created") createdIds.push(result.id);
      }
      const demotedId = createdIds[0];
      expect(demotedId).toBeDefined();
      if (!demotedId) return;

      const listed = await napkin.list(GLOBAL_SCOPE);
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.categoryCap).toBe(5);
      expect(listed.records.map(record => record.logicalKey)).toEqual([
        "lesson-6",
        "lesson-5",
        "lesson-4",
        "lesson-3",
        "lesson-2",
      ]);

      const canonical = await fixture.store.read(fixture.paths.napkin(GLOBAL_SCOPE));
      expect(canonical.document.documentType).toBe("napkin");
      if (canonical.document.documentType === "napkin") {
        expect(canonical.document.records).toHaveLength(6);
        expect(canonical.document.records.some(record => record.id === demotedId)).toBe(true);
      }

      const history = await napkin.history(GLOBAL_SCOPE);
      expect(history.status).toBe("ok");
      if (history.status !== "ok") return;
      expect(history.completeLineage).toBe(true);
      expect(history.revisions).toHaveLength(6);
      expect(history.revisions[0]?.demotedRecords.map(record => record.id)).toEqual([demotedId]);
    });
  });

  test("a service reload applies a cap of two to retained records and history", async () => {
    await withStoreFixture(async fixture => {
      const original = service(fixture);
      for (let index = 1; index <= 6; index += 1) {
        expect((await original.curate(candidate(index, index * 10))).status).toBe("created");
      }

      const reloaded = service(fixture, 2);
      const listed = await reloaded.list(GLOBAL_SCOPE);
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.categoryCap).toBe(2);
      expect(listed.records.map(record => record.logicalKey)).toEqual(["lesson-6", "lesson-5"]);

      const history = await reloaded.history(GLOBAL_SCOPE);
      expect(history.status).toBe("ok");
      if (history.status !== "ok") return;
      expect(history.revisions[0]?.activeRecords.map(record => record.logicalKey)).toEqual([
        "lesson-6",
        "lesson-5",
      ]);
      expect(history.revisions[0]?.demotedRecords.map(record => record.logicalKey)).toEqual([
        "lesson-4",
        "lesson-3",
        "lesson-2",
        "lesson-1",
      ]);
    });
  });

  test("concurrent exact-key recurrence reinforcement loses no increments", async () => {
    await withStoreFixture(async fixture => {
      const napkin = service(fixture);
      const first = await napkin.curate(candidate(1, 50));
      expect(first.status).toBe("created");

      const reinforced = await Promise.all(
        Array.from({ length: 8 }, () => napkin.curate(candidate(1, 50))),
      );
      expect(reinforced.every(result => result.status === "reinforced")).toBe(true);

      const listed = await napkin.list(GLOBAL_SCOPE);
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.records).toHaveLength(1);
      expect(listed.records[0]?.recurrence).toBe(9);
    });
  });

  test("similar lessons return bounded candidates and merge only an explicit target", async () => {
    await withStoreFixture(async fixture => {
      const napkin = service(fixture);
      const alpha = await napkin.curate({
        ...candidate(1, 50),
        logicalKey: "alpha-beta",
        situation: "Alpha beta check repeats.",
        action: "Apply alpha beta action.",
      });
      const gamma = await napkin.curate({
        ...candidate(2, 50),
        logicalKey: "gamma-delta",
        situation: "Gamma delta check repeats.",
        action: "Apply gamma delta action.",
      });
      expect(alpha.status).toBe("created");
      expect(gamma.status).toBe("created");
      if (alpha.status !== "created" || gamma.status !== "created") return;

      const ambiguous: CurateNapkinInput = {
        ...candidate(3, 50),
        logicalKey: "alpha-beta-gamma-delta",
        situation: "Alpha beta gamma delta check repeats.",
        action: "Apply alpha beta gamma delta action.",
      };
      const candidates = await napkin.curate(ambiguous);
      expect(candidates).toEqual({
        status: "candidates",
        candidateIds: [alpha.id, gamma.id].sort(),
      });

      const afterCandidates = await napkin.list(GLOBAL_SCOPE);
      expect(afterCandidates.status).toBe("ok");
      if (afterCandidates.status === "ok") {
        expect(afterCandidates.records.map(record => record.recurrence)).toEqual([1, 1]);
      }

      const targeted = await napkin.curate({ ...ambiguous, targetId: alpha.id });
      expect(targeted).toEqual(expect.objectContaining({
        status: "reinforced",
        id: alpha.id,
        recurrence: 2,
      }));
      const listed = await napkin.list(GLOBAL_SCOPE);
      expect(listed.status).toBe("ok");
      if (listed.status === "ok") {
        expect(listed.records.find(record => record.id === alpha.id)?.logicalKey).toBe("alpha-beta");
      }
    });
  });

  test("an explicit hit increments only its target and affects deterministic ranking", async () => {
    await withStoreFixture(async fixture => {
      const napkin = service(fixture);
      const first = await napkin.curate(candidate(1, 50));
      const second = await napkin.curate(candidate(2, 50));
      expect(first.status).toBe("created");
      expect(second.status).toBe("created");
      if (first.status !== "created" || second.status !== "created") return;

      const hit = await napkin.markHit({ scope: GLOBAL_SCOPE, id: second.id });
      expect(hit).toEqual(expect.objectContaining({
        status: "recorded",
        id: second.id,
        hitCount: 1,
      }));
      const listed = await napkin.list(GLOBAL_SCOPE);
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") return;
      expect(listed.records[0]?.id).toBe(second.id);
      expect(listed.records.find(record => record.id === first.id)?.hitCount).toBe(0);
    });
  });

  test("scope separation and privacy rejection happen before candidate IDs or writes", async () => {
    await withStoreFixture(async fixture => {
      const napkin = service(fixture);
      const repositoryScope: ScopeRef = { type: "repository", id: fixture.nextId("repo") };
      expect((await napkin.curate(candidate(1, 50))).status).toBe("created");
      expect((await napkin.curate({ ...candidate(2, 60), scope: repositoryScope })).status).toBe("created");

      const global = await napkin.list(GLOBAL_SCOPE);
      const repository = await napkin.list(repositoryScope);
      expect(global.status === "ok" ? global.records.map(record => record.logicalKey) : []).toEqual(["lesson-1"]);
      expect(repository.status === "ok" ? repository.records.map(record => record.logicalKey) : []).toEqual(["lesson-2"]);

      const idsBefore = fixture.createdIds.length;
      const rejected = await napkin.curate({
        ...candidate(3, 70),
        situation: "Read /home/alice/project/config.ts before continuing.",
      });
      expect(rejected).toEqual({ status: "rejected", code: "path-bearing" });
      expect(fixture.createdIds).toHaveLength(idsBefore);
      expect((await napkin.list(GLOBAL_SCOPE)).status).toBe("ok");
    });
  });
});

function service(
  fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0],
  categoryCap?: number,
): NapkinService {
  return new NapkinService({
    store: fixture.store,
    paths: fixture.paths,
    createId: fixture.nextId,
    now: () => NOW,
    ...(categoryCap === undefined ? {} : { categoryCap }),
  });
}

function candidate(index: number, priority: number): CurateNapkinInput {
  const lessons = [
    ["Cache checksums diverge after interrupted writes.", "Rebuild cache indexes before accepting cached state."],
    ["Database fixtures leak across isolated cases.", "Reset database fixtures between independent cases."],
    ["Network retries conceal bounded timeout failures.", "Expose the final timeout reason after bounded retries."],
    ["Parser normalization changes mixed newline input.", "Normalize encoding before parsing structured records."],
    ["Lock ownership becomes stale after process exit.", "Verify process identity before recovering a stale lock."],
    ["Clock drift reorders otherwise equivalent events.", "Use stable identifiers when timestamps compare equally."],
  ] as const;
  const lesson = lessons[index - 1] ?? [
    `Variant ${index} requires a distinct validation invariant.`,
    `Apply distinct safeguard ${index} before continuing.`,
  ];
  return {
    scope: GLOBAL_SCOPE,
    logicalKey: `lesson-${index}`,
    category: "Validation",
    priority,
    situation: lesson[0],
    action: lesson[1],
    sourceClassification: "generalized-derived",
  };
}
