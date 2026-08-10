import { describe, expect, test } from "bun:test";
import type { ProcessAdapter, ProcessInvocation, ProcessResult } from "../src/exec.ts";
import type { ScopeRef } from "../src/paths.ts";
import type {
  PapercutGetResult,
  PapercutTransitionResult,
} from "../src/papercut-service.ts";
import {
  PublicationService,
  type PublicationCommitInput,
  type PublicationPapercuts,
} from "../src/publication.ts";
import type { PapercutRecord, PublicationState } from "../src/schema.ts";

const REPOSITORY_SCOPE: Extract<ScopeRef, { type: "repository" }> = {
  type: "repository",
  id: "repo_11111111111111111111111111111111",
};
const OTHER_REPOSITORY_KEY = "repo_99999999999999999999999999999999";
const CUT_ID = "cut_22222222222222222222222222222222";
const CWD = "/workspace/project";
const NOW = "2026-08-09T12:00:00.000Z";
const encoder = new TextEncoder();

class FakePapercuts implements PublicationPapercuts {
  record: PapercutRecord;
  location: "open" | "archive" = "open";
  readonly events: string[];

  constructor(state: PublicationState, events: string[] = []) {
    this.record = papercut(state);
    this.events = events;
  }

  async get(_scope: ScopeRef, id: string): Promise<PapercutGetResult> {
    this.events.push("get");
    return id === this.record.id
      ? { status: "ok", location: this.location, record: { ...this.record } }
      : { status: "rejected", code: "not-found" };
  }

  async beginPublication(_scope: ScopeRef, id: string): Promise<PapercutTransitionResult> {
    this.events.push("begin");
    if (id !== this.record.id || !["none", "failed"].includes(this.record.publicationState)) {
      return { status: "rejected", code: "illegal-transition" };
    }
    return this.update("pending", null);
  }

  async reportPublication(
    _scope: ScopeRef,
    id: string,
    outcome: "failed" | "indeterminate" | "published",
    issueNumber: number | null,
  ): Promise<PapercutTransitionResult> {
    this.events.push(`report:${outcome}`);
    if (id !== this.record.id || this.record.publicationState !== "pending") {
      return { status: "rejected", code: "illegal-transition" };
    }
    return this.update(outcome, issueNumber);
  }

  async reconcilePublication(
    _scope: ScopeRef,
    id: string,
    outcome: "failed" | "published",
    issueNumber: number | null,
  ): Promise<PapercutTransitionResult> {
    this.events.push(`reconcile:${outcome}`);
    if (id !== this.record.id || this.record.publicationState !== "indeterminate") {
      return { status: "rejected", code: "illegal-transition" };
    }
    return this.update(outcome, issueNumber);
  }

  async resubmitPublication(
    _scope: ScopeRef,
    id: string,
    confirmed: boolean,
  ): Promise<PapercutTransitionResult> {
    this.events.push("resubmit");
    if (!confirmed || id !== this.record.id || this.record.publicationState !== "indeterminate") {
      return { status: "rejected", code: "illegal-transition" };
    }
    return this.update("pending", null);
  }

  private update(
    publicationState: PublicationState,
    publicationIssueNumber: number | null,
  ): PapercutTransitionResult {
    this.record = { ...this.record, publicationState, publicationIssueNumber };
    return { status: "updated", record: { ...this.record } };
  }
}

function papercut(publicationState: PublicationState): PapercutRecord {
  return {
    id: CUT_ID,
    fingerprint: "validation-record-shape",
    summary: "Validation misses malformed records",
    severity: "major",
    prevention: "Validate records before committing changes",
    acceptanceCondition: "Malformed records are rejected before activation",
    sourceClassification: "generalized-derived",
    lifecycle: "open",
    repairState: "verified",
    publicationState,
    publicationIssueNumber: publicationState === "published" ? 42 : null,
    recurrence: 3,
    relatedIds: ["cut_33333333333333333333333333333333"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function input(confirmed = true): PublicationCommitInput {
  return {
    repositoryScope: REPOSITORY_SCOPE,
    cutId: CUT_ID,
    cwd: CWD,
    confirmed,
    expectedRepository: "goldsky-io/clasi",
    expectedAccount: "octocat",
  };
}

function exited(stdout = "", exitCode = 0, stderr = ""): ProcessResult {
  return {
    status: "exited",
    exitCode,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
  };
}

function preflight(): ProcessResult[] {
  return [
    exited("gh version 2"),
    exited(),
    exited(JSON.stringify({ nameWithOwner: "goldsky-io/clasi" })),
    exited(JSON.stringify({ login: "octocat" })),
  ];
}

function scriptedProcess(
  steps: Array<ProcessResult | Error>,
  calls: ProcessInvocation[],
  events?: string[],
): ProcessAdapter {
  return async invocation => {
    calls.push(invocation);
    events?.push(`process:${invocation.args.join(" ")}`);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (step === undefined) throw new Error("unexpected process call");
    return step;
  };
}

function service(
  papercuts: FakePapercuts,
  steps: Array<ProcessResult | Error>,
  calls: ProcessInvocation[] = [],
): PublicationService {
  return new PublicationService({
    papercuts,
    process: scriptedProcess(steps, calls, papercuts.events),
    resolveRepositoryKey: async () => REPOSITORY_SCOPE.id,
  });
}

describe("PublicationService", () => {
  test("confirmation and current cwd/repository binding fail before reads, transitions, or gh", async () => {
    const unconfirmedPapercuts = new FakePapercuts("none");
    const unconfirmedCalls: ProcessInvocation[] = [];
    const unconfirmed = service(unconfirmedPapercuts, [], unconfirmedCalls);

    expect(await unconfirmed.publish(input(false))).toEqual({
      status: "rejected",
      code: "confirmation-required",
    });
    expect(await unconfirmed.publish({
      ...input(),
      repositoryScope: undefined,
    } as unknown as PublicationCommitInput)).toEqual({
      status: "rejected",
      code: "invalid-field",
    });
    expect(unconfirmedPapercuts.events).toEqual([]);
    expect(unconfirmedCalls).toEqual([]);

    const wrongPapercuts = new FakePapercuts("none");
    const wrongCalls: ProcessInvocation[] = [];
    const wrong = new PublicationService({
      papercuts: wrongPapercuts,
      process: scriptedProcess([], wrongCalls, wrongPapercuts.events),
      resolveRepositoryKey: async cwd => cwd === CWD ? OTHER_REPOSITORY_KEY : null,
    });
    expect(await wrong.publish(input())).toEqual({
      status: "rejected",
      code: "repository-scope-mismatch",
    });
    expect(wrongPapercuts.events).toEqual([]);
    expect(wrongCalls).toEqual([]);
  });

  test("requires the exact validated open Papercut", async () => {
    const papercuts = new FakePapercuts("none");
    papercuts.location = "archive";
    const calls: ProcessInvocation[] = [];

    expect(await service(papercuts, [], calls).publish(input())).toEqual({
      status: "rejected",
      code: "papercut-not-found",
    });
    expect(papercuts.events).toEqual(["get"]);
    expect(calls).toEqual([]);
  });

  test("prepares a safe review target without state writes and commit rejects target drift", async () => {
    const preparedPapercuts = new FakePapercuts("none");
    const preparedCalls: ProcessInvocation[] = [];
    expect(await service(preparedPapercuts, preflight(), preparedCalls).prepare({
      action: "publish",
      repositoryScope: REPOSITORY_SCOPE,
      cutId: CUT_ID,
      cwd: CWD,
    })).toEqual({
      status: "prepared",
      preview: {
        repository: "goldsky-io/clasi",
        account: "octocat",
        title: preparedPapercuts.record.summary,
        publicationState: "none",
      },
    });
    expect(preparedPapercuts.record.publicationState).toBe("none");
    expect(preparedPapercuts.events).not.toContain("begin");

    const driftPapercuts = new FakePapercuts("none");
    const driftCalls: ProcessInvocation[] = [];
    expect(await service(driftPapercuts, preflight(), driftCalls).publish({
      ...input(),
      expectedAccount: "another-account",
    })).toEqual({ status: "rejected", code: "publication-target-mismatch" });
    expect(driftPapercuts.record.publicationState).toBe("none");
    expect(driftPapercuts.events).not.toContain("begin");
    expect(driftCalls.some(call => call.args.includes("POST"))).toBe(false);
  });

  test("revalidates target after begin and fails pending state without posting on drift", async () => {
    const papercuts = new FakePapercuts("none");
    const calls: ProcessInvocation[] = [];
    const driftedPreflight = [
      exited("gh version 2"),
      exited(),
      exited(JSON.stringify({ nameWithOwner: "goldsky-io/clasi" })),
      exited(JSON.stringify({ login: "another-account" })),
    ];
    const result = await service(
      papercuts,
      [...preflight(), ...driftedPreflight],
      calls,
    ).publish(input());
    expect(result).toEqual({ status: "failed", code: "publication-target-mismatch" });
    expect(papercuts.record.publicationState).toBe("failed");
    expect(papercuts.events).toContain("begin");
    expect(calls.some(call => call.args.includes("POST"))).toBe(false);
  });

  test("queues before every gh call and publishes only the minimized safe issue body", async () => {
    const events: string[] = [];
    const papercuts = new FakePapercuts("none", events);
    const calls: ProcessInvocation[] = [];
    const publication = new PublicationService({
      papercuts,
      process: scriptedProcess(
        [...preflight(), ...preflight(), exited(JSON.stringify({ number: 42, html_url: "https://github.com/goldsky-io/clasi/issues/42" }))],
        calls,
        events,
      ),
      resolveRepositoryKey: async () => REPOSITORY_SCOPE.id,
    });

    expect(await publication.publish(input())).toEqual({
      status: "published",
      issueNumber: 42,
      alreadyPublished: false,
    });
    expect(papercuts.record.publicationState).toBe("published");
    expect(papercuts.record.publicationIssueNumber).toBe(42);
    expect(events.findIndex(event => event.startsWith("process:"))).toBeLessThan(
      events.indexOf("begin"),
    );
    expect(events.indexOf("begin")).toBeLessThan(
      events.findIndex(event => event.startsWith("process:api repos/")),
    );
    expect(calls.map(call => call.args)).toEqual([
      ["--version"],
      ["auth", "status"],
      ["repo", "view", "--json", "nameWithOwner"],
      ["api", "user", "--jq", "{login: .login}"],
      ["--version"],
      ["auth", "status"],
      ["repo", "view", "--json", "nameWithOwner"],
      ["api", "user", "--jq", "{login: .login}"],
      [
        "api",
        "repos/goldsky-io/clasi/issues",
        "--method",
        "POST",
        "-f",
        `title=${papercuts.record.summary}`,
        "-f",
        expect.stringMatching(/^body=/),
      ],
    ]);
    expect(calls.every(call => call.command === "gh" && call.cwd === CWD && call.env === undefined)).toBe(true);

    const body = calls[8]!.args.find(argument => argument.startsWith("body="));
    expect(body).toContain(papercuts.record.summary);
    expect(body).toContain(papercuts.record.prevention);
    expect(body).toContain(papercuts.record.acceptanceCondition);
    expect(body).toContain("Severity: major");
    expect(body).toContain("Recurrence: 3");
    expect(body).toContain(`clasi:${CUT_ID}`);
    for (const excluded of [
      papercuts.record.fingerprint,
      papercuts.record.sourceClassification,
      papercuts.record.repairState,
      papercuts.record.relatedIds[0]!,
      papercuts.record.createdAt,
      REPOSITORY_SCOPE.id,
      CWD,
      "Context",
      "Napkin",
    ]) {
      expect(body).not.toContain(excluded);
    }
  });

  test("records unavailable and unauthenticated gh as definitive failures without leaking output", async () => {
    const unavailable = new FakePapercuts("none");
    const unavailableResult = await service(
      unavailable,
      [{ status: "spawn-failed", message: "secret-path" }],
    ).publish(input());
    expect(unavailableResult).toEqual({ status: "failed", code: "gh-unavailable" });
    expect(unavailable.record.publicationState).toBe("failed");
    expect(JSON.stringify(unavailableResult)).not.toContain("secret-path");

    const unauthenticated = new FakePapercuts("none");
    const unauthenticatedResult = await service(
      unauthenticated,
      [exited("gh version 2"), exited("", 1, "token=secret-value")],
    ).publish(input());
    expect(unauthenticatedResult).toEqual({ status: "failed", code: "gh-unauthenticated" });
    expect(unauthenticated.record.publicationState).toBe("failed");
    expect(JSON.stringify(unauthenticatedResult)).not.toContain("secret-value");
  });

  test("treats every outcome after POST begins as indeterminate", async () => {
    const cases: Array<{
      effect: ProcessResult | Error;
      status: "indeterminate";
      code: "create-indeterminate";
      persisted: PublicationState;
    }> = [
      { effect: exited("", 1, "private failure"), status: "indeterminate", code: "create-indeterminate", persisted: "indeterminate" },
      { effect: { status: "timed-out" }, status: "indeterminate", code: "create-indeterminate", persisted: "indeterminate" },
      { effect: { status: "output-too-large" }, status: "indeterminate", code: "create-indeterminate", persisted: "indeterminate" },
      { effect: new Error("adapter crash with secret"), status: "indeterminate", code: "create-indeterminate", persisted: "indeterminate" },
      { effect: exited("not json"), status: "indeterminate", code: "create-indeterminate", persisted: "indeterminate" },
    ];

    for (const candidate of cases) {
      const papercuts = new FakePapercuts("none");
      const result = await service(papercuts, [...preflight(), ...preflight(), candidate.effect]).publish(input());
      expect(result).toEqual({ status: candidate.status, code: candidate.code });
      expect(papercuts.record.publicationState).toBe(candidate.persisted);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  test("reconciles zero and one marker matches while keeping many and command errors indeterminate", async () => {
    const cases: Array<{
      search: ProcessResult;
      expectedStatus: "failed" | "published" | "indeterminate";
      persisted: PublicationState;
      issueNumber?: number;
    }> = [
      { search: exited("[]"), expectedStatus: "failed", persisted: "failed" },
      {
        search: exited(JSON.stringify([{ number: 9, url: "https://github.com/goldsky-io/clasi/issues/9" }])),
        expectedStatus: "published",
        persisted: "published",
        issueNumber: 9,
      },
      {
        search: exited(JSON.stringify([
          { number: 9, url: "https://github.com/goldsky-io/clasi/issues/9" },
          { number: 10, url: "https://github.com/goldsky-io/clasi/issues/10" },
        ])),
        expectedStatus: "indeterminate",
        persisted: "indeterminate",
      },
      { search: exited("", 1, "secret error"), expectedStatus: "indeterminate", persisted: "indeterminate" },
    ];

    for (const candidate of cases) {
      const papercuts = new FakePapercuts("indeterminate");
      const calls: ProcessInvocation[] = [];
      const result = await service(papercuts, [...preflight(), candidate.search], calls).reconcile(input());
      expect(result.status).toBe(candidate.expectedStatus);
      if (candidate.issueNumber !== undefined && result.status === "published") {
        expect(result.issueNumber).toBe(candidate.issueNumber);
      }
      expect(papercuts.record.publicationState).toBe(candidate.persisted);
      expect(papercuts.record.publicationIssueNumber).toBe(candidate.issueNumber ?? null);
      expect(calls[4]?.args).toEqual([
        "issue",
        "list",
        "--repo",
        "goldsky-io/clasi",
        "--state",
        "all",
        "--search",
        `clasi:${CUT_ID} in:body`,
        "--json",
        "number,url",
      ]);
      expect(JSON.stringify(result)).not.toContain("secret error");
    }
  });

  test("requires explicit confirmed resubmit after an indeterminate create", async () => {
    const papercuts = new FakePapercuts("indeterminate");
    const calls: ProcessInvocation[] = [];
    const publication = service(papercuts, [], calls);

    expect(await publication.publish(input())).toEqual({
      status: "rejected",
      code: "reconciliation-required",
    });
    expect(await publication.resubmit(input(false))).toEqual({
      status: "rejected",
      code: "confirmation-required",
    });
    expect(papercuts.record.publicationState).toBe("indeterminate");
    expect(calls).toEqual([]);

    const resubmitCalls: ProcessInvocation[] = [];
    const resubmitted = await service(
      papercuts,
      [...preflight(), ...preflight(), exited(JSON.stringify({ number: 77 }))],
      resubmitCalls,
    ).resubmit(input());
    expect(resubmitted).toEqual({ status: "published", issueNumber: 77, alreadyPublished: false });
    expect(papercuts.events.findIndex(event => event.startsWith("process:"))).toBeLessThan(
      papercuts.events.indexOf("resubmit"),
    );
    expect(papercuts.record.publicationState).toBe("published");
    expect(papercuts.record.publicationIssueNumber).toBe(77);
  });

  test("published records are idempotent without gh or state transitions", async () => {
    const papercuts = new FakePapercuts("published");
    const calls: ProcessInvocation[] = [];
    const publication = service(papercuts, [], calls);

    expect(await publication.publish(input())).toEqual({
      status: "published",
      issueNumber: 42,
      alreadyPublished: true,
    });
    expect(await publication.reconcile(input())).toEqual({
      status: "published",
      issueNumber: 42,
      alreadyPublished: true,
    });
    expect(await publication.resubmit(input())).toEqual({
      status: "published",
      issueNumber: 42,
      alreadyPublished: true,
    });
    expect(calls).toEqual([]);
    expect(papercuts.events).toEqual(["get", "get", "get"]);
  });

  test("revalidates publishable fields before any state transition or process", async () => {
    const papercuts = new FakePapercuts("none");
    papercuts.record = { ...papercuts.record, summary: "https://secret.example/private" };
    const calls: ProcessInvocation[] = [];

    expect(await service(papercuts, [], calls).publish(input())).toEqual({
      status: "rejected",
      code: "unsafe-papercut",
    });
    expect(papercuts.events).toEqual(["get"]);
    expect(calls).toEqual([]);
  });
});
