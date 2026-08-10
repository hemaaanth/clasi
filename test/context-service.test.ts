import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContextService } from "../src/context-service.ts";
import { decodeMarkdown } from "../src/markdown-codec.ts";
import type { ScopeRef } from "../src/paths.ts";
import { ProposalService } from "../src/proposal-service.ts";
import type { SafeSourceClassification } from "../src/privacy.ts";
import { withStoreFixture } from "./support/store-fixture.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const GLOBAL_SCOPE: ScopeRef = { type: "global", id: "global" };

describe("Context and proposal services", () => {
  test("repository Context shadows machine and global values without deleting them", async () => {
    await withStoreFixture(async fixture => {
      const machineScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const repositoryScope: ScopeRef = { type: "repository", id: fixture.nextId("repo") };
      const proposals = service(fixture);
      const context = contextService(fixture);

      await proposeAndApprove(proposals, GLOBAL_SCOPE, "Use npm for package operations.", 100);
      await proposeAndApprove(proposals, machineScope, "Use pnpm for package operations.", 80);
      await proposeAndApprove(proposals, repositoryScope, "Use Bun for package operations.", 10);

      const resolved = await context.resolve([GLOBAL_SCOPE, machineScope, repositoryScope]);
      expect(resolved.status).toBe("ok");
      if (resolved.status !== "ok") return;
      expect(resolved.active).toHaveLength(1);
      expect(resolved.active[0]).toEqual(expect.objectContaining({
        scope: repositoryScope,
        record: expect.objectContaining({ value: "Use Bun for package operations." }),
      }));
      expect(resolved.shadowed.map(entry => [entry.scope.type, entry.record.value])).toEqual([
        ["machine", "Use pnpm for package operations."],
        ["global", "Use npm for package operations."],
      ]);

      for (const [scope, value] of [
        [GLOBAL_SCOPE, "Use npm for package operations."],
        [machineScope, "Use pnpm for package operations."],
        [repositoryScope, "Use Bun for package operations."],
      ] as const) {
        const scoped = await context.readScope(scope);
        expect(scoped.status).toBe("ok");
        if (scoped.status === "ok") expect(scoped.records[0]?.value).toBe(value);
      }
    });
  });

  test("all non-machine-derived Context remains an open proposal and is excluded from active reads", async () => {
    await withStoreFixture(async fixture => {
      const machineScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const repositoryScope: ScopeRef = { type: "repository", id: fixture.nextId("repo") };
      const proposals = service(fixture);
      const context = contextService(fixture);
      const candidates: Array<{
        scope: ScopeRef;
        sourceClassification: SafeSourceClassification;
        kind: "fact" | "preference";
        value: string;
      }> = [
        {
          scope: GLOBAL_SCOPE,
          sourceClassification: "explicit-user-input",
          kind: "preference",
          value: "Prefer concise explanations.",
        },
        {
          scope: repositoryScope,
          sourceClassification: "generalized-derived",
          kind: "fact",
          value: "Validation uses focused Bun tests.",
        },
        {
          scope: GLOBAL_SCOPE,
          sourceClassification: "aggregate-observation",
          kind: "fact",
          value: "Focused validation has repeated.",
        },
        {
          scope: machineScope,
          sourceClassification: "validated-system-state",
          kind: "fact",
          value: "The shell follows Bourne conventions.",
        },
      ];

      for (const [index, candidate] of candidates.entries()) {
        const result = await proposals.submitContext({
          ...candidate,
          logicalKey: `pending.context-${index}`,
          priority: 50,
        });
        expect(result.status).toBe("proposed");
        if (result.status !== "proposed") continue;
        const proposal = await fixture.store.read(fixture.paths.proposal(candidate.scope, result.proposalId));
        expect(proposal.document.documentType).toBe("proposal");
        if (proposal.document.documentType === "proposal") {
          expect(proposal.document.records[0]?.status).toBe("open");
        }
      }

      const resolved = await context.resolve([GLOBAL_SCOPE, machineScope, repositoryScope]);
      expect(resolved).toEqual({ status: "ok", active: [], shadowed: [], unapproved: [] });
      expect(await context.readScope(GLOBAL_SCOPE)).toEqual({ status: "empty", scope: GLOBAL_SCOPE });
    });
  });

  test("schema-valid unapproved Context is reviewable but never active", async () => {
    await withStoreFixture(async fixture => {
      const canonicalPath = fixture.paths.context(GLOBAL_SCOPE);
      const documentKey = `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`;
      const result = await fixture.store.mutate({
        canonicalPath,
        documentKey,
        mutate: current => {
          expect(current).toBeNull();
          return {
            schemaVersion: 1,
            documentType: "context",
            scopeType: "global",
            scopeId: "global",
            revisionId: fixture.nextId("rev"),
            parentRevisionId: null,
            updatedAt: NOW,
            records: [{
              id: fixture.nextId("ctx"),
              logicalKey: "writing.detail",
              kind: "preference",
              value: "Prefer concise explanations.",
              sourceClassification: "explicit-user-input",
              approved: false,
              priority: 70,
              createdAt: NOW,
              updatedAt: NOW,
            }],
          };
        },
      });
      expect(result.status).toBe("committed");

      const resolved = await contextService(fixture).resolve([GLOBAL_SCOPE]);
      expect(resolved.status).toBe("ok");
      if (resolved.status === "ok") {
        expect(resolved.active).toEqual([]);
        expect(resolved.shadowed).toEqual([]);
        expect(resolved.unapproved).toEqual([
          expect.objectContaining({ record: expect.objectContaining({ logicalKey: "writing.detail" }) }),
        ]);
      }
    });
  });

  test("only normalized safe machine facts activate directly", async () => {
    await withStoreFixture(async fixture => {
      const machineScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const proposals = service(fixture);
      const activated = await proposals.submitContext({
        scope: machineScope,
        logicalKey: "machine.os-boundary",
        kind: "fact",
        value: "linux",
        sourceClassification: "safe-machine-fact",
        priority: 100,
      });
      expect(activated.status).toBe("activated");

      const invalid = await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "machine.os-boundary",
        kind: "fact",
        value: "linux",
        sourceClassification: "safe-machine-fact",
        priority: 100,
      });
      expect(invalid).toEqual({ status: "rejected", code: "invalid-machine-fact" });

      const scoped = await contextService(fixture).readScope(machineScope);
      expect(scoped.status).toBe("ok");
      if (scoped.status === "ok") {
        expect(scoped.records).toEqual([
          expect.objectContaining({
            logicalKey: "machine.os-boundary",
            approved: true,
            sourceClassification: "safe-machine-fact",
          }),
        ]);
      }
    });
  });

  test("approval and dismissal are explicit terminal transitions with reviewable history", async () => {
    await withStoreFixture(async fixture => {
      const proposals = service(fixture);
      const approved = await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "writing.detail",
        kind: "preference",
        value: "Prefer concise explanations.",
        sourceClassification: "explicit-user-input",
        priority: 70,
      });
      const dismissed = await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "writing.tone",
        kind: "preference",
        value: "Prefer a formal tone.",
        sourceClassification: "explicit-user-input",
        priority: 70,
      });
      expect(approved.status).toBe("proposed");
      expect(dismissed.status).toBe("proposed");
      if (approved.status !== "proposed" || dismissed.status !== "proposed") return;

      expect(await proposals.approveContext({
        scope: GLOBAL_SCOPE,
        proposalId: approved.proposalId,
        kind: "preference",
        priority: 70,
      })).toEqual(expect.objectContaining({ status: "approved", proposalId: approved.proposalId }));
      expect(await proposals.dismiss(GLOBAL_SCOPE, dismissed.proposalId)).toEqual(
        expect.objectContaining({ status: "dismissed", proposalId: dismissed.proposalId, changed: true }),
      );
      expect(await proposals.approveContext({
        scope: GLOBAL_SCOPE,
        proposalId: dismissed.proposalId,
        kind: "preference",
        priority: 70,
      })).toEqual({ status: "rejected", code: "invalid-transition" });

      const approvedHistory = await fixture.store.read(
        fixture.paths.proposal(GLOBAL_SCOPE, approved.proposalId),
      );
      const dismissedHistory = await fixture.store.read(
        fixture.paths.proposal(GLOBAL_SCOPE, dismissed.proposalId),
      );
      expect(approvedHistory.document.documentType).toBe("proposal");
      expect(dismissedHistory.document.documentType).toBe("proposal");
      if (
        approvedHistory.document.documentType === "proposal" &&
        dismissedHistory.document.documentType === "proposal"
      ) {
        expect(approvedHistory.document.records[0]).toEqual(expect.objectContaining({
          status: "approved",
          summary: "Prefer concise explanations.",
        }));
        expect(dismissedHistory.document.records[0]).toEqual(expect.objectContaining({
          status: "dismissed",
          summary: "Prefer a formal tone.",
        }));
      }

      const resolved = await contextService(fixture).resolve([GLOBAL_SCOPE]);
      expect(resolved.status).toBe("ok");
      if (resolved.status === "ok") {
        expect(resolved.active.map(entry => entry.record.logicalKey)).toEqual(["writing.detail"]);
      }
    });
  });

  test("privacy rejection happens before IDs, timestamps, or durable derivatives are created", async () => {
    await withStoreFixture(async fixture => {
      let createdIds = 0;
      let timestamps = 0;
      const proposals = new ProposalService({
        store: fixture.store,
        paths: fixture.paths,
        createId: prefix => {
          createdIds += 1;
          return fixture.nextId(prefix);
        },
        now: () => {
          timestamps += 1;
          return NOW;
        },
      });

      expect(await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "unsafe.import",
        kind: "preference",
        value: "API_KEY=secret-value-that-must-not-persist",
        sourceClassification: "explicit-user-input",
        priority: 50,
      })).toEqual({ status: "rejected", code: "raw-environment" });
      expect(createdIds).toBe(0);
      expect(timestamps).toBe(0);
      expect(await contextService(fixture).readScope(GLOBAL_SCOPE)).toEqual({
        status: "empty",
        scope: GLOBAL_SCOPE,
      });
    });
  });

  test("concurrent exact-key updates serialize into one record and one revision lineage", async () => {
    await withStoreFixture(async fixture => {
      const machineScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const context = contextService(fixture);
      const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        context.activateSafeMachineFact({
          scope: machineScope,
          logicalKey: "machine.resource-profile",
          kind: "fact",
          value: `profile-${index + 1}`,
          sourceClassification: "safe-machine-fact",
          priority: 100,
        })
      ));
      expect(outcomes.every(outcome => outcome.status === "activated" && outcome.changed)).toBe(true);

      const active = await fixture.store.read(fixture.paths.context(machineScope));
      expect(active.document.documentType).toBe("context");
      if (active.document.documentType !== "context") return;
      expect(active.document.records).toHaveLength(1);
      expect(active.document.records[0]?.logicalKey).toBe("machine.resource-profile");

      const canonicalPath = fixture.paths.context(machineScope);
      const documentKey = `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`;
      const revisionFiles = await readdir(fixture.paths.revisionDirectory(documentKey));
      expect(revisionFiles).toHaveLength(8);
      const revisionDirectory = fixture.paths.revisionDirectory(documentKey);
      const revisions = await Promise.all(revisionFiles.map(async file =>
        decodeMarkdown(await readFile(join(revisionDirectory, file)))
      ));
      const byId = new Map(revisions.map(document => [document.revisionId, document]));
      const seen = new Set<string>();
      let revisionId: string | null = active.document.revisionId;
      while (revisionId !== null) {
        expect(seen.has(revisionId)).toBe(false);
        seen.add(revisionId);
        const revision = byId.get(revisionId);
        expect(revision).toBeDefined();
        revisionId = revision?.parentRevisionId ?? null;
      }
      expect(seen.size).toBe(8);
    });
  });
  test("lists bounded pending proposals across applicable scopes and keeps reviewed history filterable", async () => {
    await withStoreFixture(async fixture => {
      const machineScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const repositoryScope: ScopeRef = { type: "repository", id: fixture.nextId("repo") };
      const proposals = service(fixture);
      expect(fixture.paths.proposalDirectory(GLOBAL_SCOPE)).toBe(
        join(fixture.roots.dataRoot, "scopes", "global", "proposals"),
      );

      const approved = await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "review.approved",
        kind: "preference",
        value: "Prefer focused checks.",
        sourceClassification: "explicit-user-input",
        priority: 70,
      });
      const dismissed = await proposals.submitContext({
        scope: machineScope,
        logicalKey: "review.dismissed",
        kind: "fact",
        value: "The shell follows Bourne conventions.",
        sourceClassification: "generalized-derived",
        priority: 60,
      });
      const pending = await proposals.submitContext({
        scope: repositoryScope,
        logicalKey: "review.pending",
        kind: "fact",
        value: "Repository validation uses Bun.",
        sourceClassification: "generalized-derived",
        priority: 50,
      });
      expect(approved.status).toBe("proposed");
      expect(dismissed.status).toBe("proposed");
      expect(pending.status).toBe("proposed");
      if (
        approved.status !== "proposed" ||
        dismissed.status !== "proposed" ||
        pending.status !== "proposed"
      ) return;

      expect((await proposals.approveContext({
        scope: GLOBAL_SCOPE,
        proposalId: approved.proposalId,
        kind: "preference",
        priority: 70,
      })).status).toBe("approved");
      expect((await proposals.dismiss(machineScope, dismissed.proposalId)).status).toBe("dismissed");

      const scopes = [GLOBAL_SCOPE, machineScope, repositoryScope] as const;
      const open = await proposals.list(scopes);
      expect(open).toEqual({
        status: "ok",
        records: [{
          scope: repositoryScope,
          record: expect.objectContaining({ id: pending.proposalId, status: "open" }),
        }],
        truncated: false,
      });

      const all = await proposals.list(scopes, { status: "all", limit: 2 });
      expect(all.status).toBe("ok");
      if (all.status === "ok") {
        expect(all.records.map(entry => entry.record.status)).toEqual(["open", "approved"]);
        expect(all.truncated).toBe(true);
      }
      const approvedOnly = await proposals.list(scopes, { status: "approved" });
      expect(approvedOnly.status).toBe("ok");
      if (approvedOnly.status === "ok") {
        expect(approvedOnly.records.map(entry => entry.record.id)).toEqual([approved.proposalId]);
      }
    });
  });

  test("proposal listing rejects duplicate scopes, invalid bounds, and any malformed item without partial data", async () => {
    await withStoreFixture(async fixture => {
      const proposals = service(fixture);
      expect(await proposals.list([GLOBAL_SCOPE, GLOBAL_SCOPE])).toEqual({
        status: "rejected",
        code: "duplicate-scope",
      });
      expect(await proposals.list([GLOBAL_SCOPE], { limit: 101 })).toEqual({
        status: "rejected",
        code: "invalid-limit",
      });

      const valid = await proposals.submitContext({
        scope: GLOBAL_SCOPE,
        logicalKey: "review.valid",
        kind: "fact",
        value: "This proposal is valid.",
        sourceClassification: "generalized-derived",
        priority: 50,
      });
      expect(valid.status).toBe("proposed");

      const mismatchedScope: ScopeRef = { type: "machine", id: fixture.nextId("machine") };
      const proposalId = fixture.nextId("proposal");
      const canonicalPath = fixture.paths.proposal(GLOBAL_SCOPE, proposalId);
      const malformed = await fixture.store.mutate({
        canonicalPath,
        documentKey: `doc_${createHash("sha256").update(canonicalPath).digest("hex").slice(0, 32)}`,
        mutate: current => {
          expect(current).toBeNull();
          return {
            schemaVersion: 1,
            documentType: "proposal",
            scopeType: mismatchedScope.type,
            scopeId: mismatchedScope.id,
            revisionId: fixture.nextId("rev"),
            parentRevisionId: null,
            updatedAt: NOW,
            records: [{
              id: proposalId,
              targetType: "context",
              logicalKey: "review.mismatched",
              summary: "This binding does not match its directory.",
              sourceClassification: "generalized-derived",
              status: "open",
              createdAt: NOW,
              updatedAt: NOW,
            }],
          };
        },
      });
      expect(malformed.status).toBe("committed");
      expect(await proposals.list([GLOBAL_SCOPE], { status: "all" })).toEqual({
        status: "rejected",
        code: "document-mismatch",
      });
    });
  });
});

function service(fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0]): ProposalService {
  return new ProposalService({
    store: fixture.store,
    paths: fixture.paths,
    createId: fixture.nextId,
    now: () => NOW,
  });
}

function contextService(fixture: Parameters<Parameters<typeof withStoreFixture>[0]>[0]): ContextService {
  return new ContextService({
    store: fixture.store,
    paths: fixture.paths,
    createId: fixture.nextId,
    now: () => NOW,
  });
}

async function proposeAndApprove(
  proposals: ProposalService,
  scope: ScopeRef,
  value: string,
  priority: number,
): Promise<void> {
  const proposed = await proposals.submitContext({
    scope,
    logicalKey: "package-manager",
    kind: "preference",
    value,
    sourceClassification: "explicit-user-input",
    priority,
  });
  expect(proposed.status).toBe("proposed");
  if (proposed.status !== "proposed") return;
  expect(await proposals.approveContext({
    scope,
    proposalId: proposed.proposalId,
    kind: "preference",
    priority,
  })).toEqual(expect.objectContaining({ status: "approved" }));
}
