import { describe, expect, test } from "bun:test";
import {
  HELP_COMMANDS,
  runClasiCli,
} from "../src/cli.ts";
import type { HeadlessExecutor, HeadlessRequest } from "../src/cli.ts";
import { createHeadlessResponse } from "../src/headless-response.ts";
import type { HeadlessStatus } from "../src/headless-response.ts";

const REPO = `repo_${"1".repeat(32)}`;
const MACHINE = `machine_${"2".repeat(32)}`;
const PROPOSAL = `proposal_${"3".repeat(32)}`;
const CUT = `cut_${"4".repeat(32)}`;
const CONFLICT = `conflict_${"5".repeat(32)}`;
const REVISION = `rev_${"6".repeat(32)}`;
const DOCUMENT = `doc_${"7".repeat(32)}`;
const TRANSACTION = `tx_${"8".repeat(32)}`;
const REPOSITORY_SCOPE = `repository:${REPO}`;
const MACHINE_SCOPE = `machine:${MACHINE}`;

describe("headless CLI parser", () => {
  const cases: Array<{ args: string[]; expected: HeadlessRequest }> = [
    {
      args: ["setup", "--root", "/safe/shared", "--confirm"],
      expected: {
        command: "setup",
        root: "/safe/shared",
        confirm: true,
      },
    },
    { args: ["status"], expected: { command: "status" } },
    { args: ["config"], expected: { command: "config" } },
    { args: ["doctor"], expected: { command: "doctor" } },
    { args: ["locks"], expected: { command: "locks", action: "list" } },
    {
      args: ["config", "--napkin-category-cap", "8"],
      expected: {
        command: "config",
        action: "prepare",
        changes: { napkinCategoryCap: 8 },
      },
    },
    {
      args: [
        "config",
        "--napkin-category-cap",
        "8",
        "--context-character-cap",
        "4000",
        "--confirm",
      ],
      expected: {
        command: "config",
        action: "update",
        changes: { napkinCategoryCap: 8, contextCharacterCap: 4_000 },
        confirm: true,
      },
    },
    { args: ["context"], expected: { command: "context" } },
    {
      args: ["context", "--scope", MACHINE_SCOPE],
      expected: { command: "context", scope: { type: "machine", id: MACHINE } },
    },
    { args: ["review"], expected: { command: "review", target: "all" } },
    {
      args: ["review", "conflicts"],
      expected: { command: "review", target: "conflicts" },
    },
    {
      args: ["proposals", "list", "--scope", "global"],
      expected: {
        command: "proposals",
        action: "list",
        scope: { type: "global", id: "global" },
      },
    },
    {
      args: [
        "proposals",
        "approve",
        "--scope",
        MACHINE_SCOPE,
        "--id",
        PROPOSAL,
        "--kind",
        "preference",
        "--priority",
        "100",
        "--confirm",
      ],
      expected: {
        command: "proposals",
        action: "approve",
        scope: { type: "machine", id: MACHINE },
        proposalId: PROPOSAL,
        kind: "preference",
        priority: 100,
        confirm: true,
      },
    },
    {
      args: [
        "proposals",
        "dismiss",
        "--scope",
        REPOSITORY_SCOPE,
        "--id",
        PROPOSAL,
        "--confirm",
      ],
      expected: {
        command: "proposals",
        action: "dismiss",
        scope: { type: "repository", id: REPO },
        proposalId: PROPOSAL,
        confirm: true,
      },
    },
    { args: ["napkin", "list"], expected: { command: "napkin", action: "list" } },
    {
      args: ["napkin", "history", REPOSITORY_SCOPE],
      expected: {
        command: "napkin",
        action: "history",
        scope: { type: "repository", id: REPO },
      },
    },
    {
      args: ["history", MACHINE_SCOPE],
      expected: {
        command: "napkin",
        action: "history",
        scope: { type: "machine", id: MACHINE },
      },
    },
    { args: ["papercuts", "list"], expected: { command: "papercuts", action: "list" } },
    {
      args: ["papercuts", "list", REPOSITORY_SCOPE],
      expected: {
        command: "papercuts",
        action: "list",
        scope: { type: "repository", id: REPO },
      },
    },
    {
      args: ["papercuts", "show", "--scope", REPOSITORY_SCOPE, "--id", CUT],
      expected: {
        command: "papercuts",
        action: "show",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
      },
    },
    {
      args: [
        "papercuts",
        "dismiss",
        "--scope",
        REPOSITORY_SCOPE,
        "--id",
        CUT,
        "--confirm",
      ],
      expected: {
        command: "papercuts",
        action: "dismiss",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        confirm: true,
      },
    },
    { args: ["inbox"], expected: { command: "papercuts", action: "list" } },
    {
      args: ["show", "--scope", REPOSITORY_SCOPE, "--id", CUT],
      expected: {
        command: "papercuts",
        action: "show",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
      },
    },
    {
      args: ["dismiss", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
      expected: {
        command: "papercuts",
        action: "dismiss",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        confirm: true,
      },
    },
    { args: ["impact"], expected: { command: "impact" } },
    { args: ["conflicts", "list"], expected: { command: "conflicts", action: "list" } },
    {
      args: ["conflicts", "show", "--id", CONFLICT],
      expected: { command: "conflicts", action: "show", conflictId: CONFLICT },
    },
    {
      args: ["conflicts", "revalidate", "--id", CONFLICT],
      expected: { command: "conflicts", action: "revalidate", conflictId: CONFLICT },
    },
    {
      args: [
        "conflicts",
        "activate",
        "--id",
        CONFLICT,
        "--revision-id",
        REVISION,
        "--confirm",
      ],
      expected: {
        command: "conflicts",
        action: "activate",
        conflictId: CONFLICT,
        revisionId: REVISION,
        confirm: true,
      },
    },
    {
      args: ["migrate", "--from", REPO, "--to", `repo_${"9".repeat(32)}`, "--confirm"],
      expected: {
        command: "migrate",
        fromRepositoryId: REPO,
        toRepositoryId: `repo_${"9".repeat(32)}`,
        confirm: true,
      },
    },
    {
      args: ["recover-lock", "--document-id", DOCUMENT, "--confirm"],
      expected: { command: "recover-lock", documentId: DOCUMENT, confirm: true },
    },
    {
      args: ["transactions", "list"],
      expected: { command: "transactions", action: "list" },
    },
    {
      args: ["clean-transaction", "--id", TRANSACTION, "--confirm"],
      expected: { command: "clean-transaction", transactionId: TRANSACTION, confirm: true },
    },
    ...["repair", "resubmit-repair", "cancel-repair"].map(command => ({
      args: [command, "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
      expected: {
        command,
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        confirm: true,
      } as HeadlessRequest,
    })),
    ...["publish", "resubmit-publication", "reconcile-publication"].flatMap(command => [
      {
        args: [command, "--scope", REPOSITORY_SCOPE, "--id", CUT],
        expected: {
          command,
          action: "prepare",
          scope: { type: "repository", id: REPO },
          papercutId: CUT,
        } as HeadlessRequest,
      },
      {
        args: [
          command,
          "--scope",
          REPOSITORY_SCOPE,
          "--id",
          CUT,
          "--repository",
          "owner/project",
          "--account",
          "confirmed-login",
          "--confirm",
        ],
        expected: {
          command,
          action: "commit",
          scope: { type: "repository", id: REPO },
          papercutId: CUT,
          expectedRepository: "owner/project",
          expectedAccount: "confirmed-login",
          confirm: true,
        } as HeadlessRequest,
      },
    ]),
    {
      args: [
        "reconcile-repair",
        "--scope",
        REPOSITORY_SCOPE,
        "--id",
        CUT,
        "--state",
        "awaiting_verification",
        "--confirm",
      ],
      expected: {
        command: "reconcile-repair",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        state: "awaiting_verification",
        confirm: true,
      },
    },
    {
      args: [
        "verify",
        "--scope",
        REPOSITORY_SCOPE,
        "--id",
        CUT,
        "--observed",
        "passed",
        "--confirm",
      ],
      expected: {
        command: "verify",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        observed: "passed",
        confirm: true,
      },
    },
    {
      args: ["resolve", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
      expected: {
        command: "resolve",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        confirm: true,
      },
    },
    {
      args: [
        "resolve",
        "--scope",
        REPOSITORY_SCOPE,
        "--id",
        CUT,
        "--logical-key",
        "validation.focused-test",
        "--category",
        "Validation",
        "--priority",
        "80",
        "--situation",
        "A focused check catches the failure.",
        "--action",
        "Run the focused check before the suite.",
        "--confirm",
      ],
      expected: {
        command: "resolve",
        scope: { type: "repository", id: REPO },
        papercutId: CUT,
        napkin: {
          logicalKey: "validation.focused-test",
          category: "Validation",
          priority: 80,
          situation: "A focused check catches the failure.",
          action: "Run the focused check before the suite.",
        },
        confirm: true,
      },
    },
  ];

  test.each(cases)("parses $args", async ({ args, expected }) => {
    const requests: HeadlessRequest[] = [];
    const writes: string[] = [];
    const execute: HeadlessExecutor = async (request, cwd) => {
      requests.push(request);
      expect(cwd).toBe("/work/current");
      return createHeadlessResponse({
        status: "ok",
        code: "accepted",
        message: "Accepted.",
        data: { accepted: true },
      });
    };

    const exitCode = await runClasiCli(args, line => writes.push(line), {
      execute,
      cwd: "/work/current",
    });

    expect(exitCode).toBe(0);
    expect(requests).toEqual([expected]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schema_version: 1,
      status: "ok",
      code: "accepted",
      message: "Accepted.",
      data: { accepted: true },
      next_actions: [],
    });
  });

  test("handles help and version locally without loading or calling the backend", async () => {
    for (const [args, expected] of [
      [
        ["--help"],
        {
          schema_version: 1,
          status: "ok",
          code: "help",
          message: "clasi commands",
          data: { commands: HELP_COMMANDS },
          next_actions: [],
        },
      ],
      [
        ["version"],
        {
          schema_version: 1,
          status: "ok",
          code: "version",
          message: "clasi 0.1.0",
          data: { version: "0.1.0" },
          next_actions: [],
        },
      ],
    ] as const) {
      const writes: string[] = [];
      const exitCode = await runClasiCli(args, line => writes.push(line));
      expect(exitCode).toBe(0);
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0] ?? "")).toEqual(expected);
    }
  });
});

describe("strict CLI failures", () => {
  const invalidCases = [
    [],
    ["unknown"],
    ["help", "junk"],
    ["status", "--unknown"],
    ["setup", "--root", "/safe", "--root", "/duplicate", "--confirm"],
    ["setup", "--root", "relative", "--confirm"],
    ["setup", "--root", "/safe", "--global-preference", "bun", "--confirm"],
    ["setup", "--root", "/safe", "--machine-preference", "low-memory", "--confirm"],
    ["setup", "--root", "/safe", "--import", "/safe/instructions.md", "--confirm"],
    ["doctor", "--confirm"],
    ["locks", "list"],
    ["config", "--confirm"],
    ["config", "--unknown", "1"],
    ["config", "--napkin-category-cap", "0"],
    ["config", "--napkin-category-cap", "21"],
    ["config", "--napkin-category-cap", "5", "--napkin-category-cap", "6"],
    ["config", "--context-character-cap", "499"],
    ["config", "--context-character-cap", "6001"],
    ["config", "--context-character-cap", "500.5"],
    ["context", "--scope", `machine:${REPO}`],
    ["context", "repository"],
    ["review", "unknown"],
    ["review", "all", "junk"],
    ["proposals", "list", "global"],
    ["proposals", "list", "--scope"],
    ["proposals", "approve", "--scope", "global", "--id", CUT, "--kind", "fact", "--priority", "1", "--confirm"],
    ["proposals", "approve", "--scope", "global", "--id", PROPOSAL, "--kind", "other", "--priority", "1", "--confirm"],
    ["proposals", "approve", "--scope", "global", "--id", PROPOSAL, "--kind", "fact", "--priority", "101", "--confirm"],
    ["napkin", "list", "global", "junk"],
    ["papercuts", "show", "--scope", REPOSITORY_SCOPE, "--id", PROPOSAL],
    ["show", REPOSITORY_SCOPE, CUT],
    ["conflicts", "activate", "--id", CONFLICT, "--revision-id", CONFLICT, "--confirm"],
    ["migrate", "--from", CUT, "--to", REPO, "--confirm"],
    ["recover-lock", "--document-id", REPO, "--confirm"],
    ["transactions"],
    ["clean-transaction", "--id", DOCUMENT, "--confirm"],
    ["publish", "--scope", MACHINE_SCOPE, "--id", CUT, "--confirm"],
    ["publish", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
    ["publish", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--repository", "owner/project", "--confirm"],
    ["publish", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--repository", "https://github.com/owner/project", "--account", "login", "--confirm"],
    ["publish", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--repository", "owner/project", "--account", "bad/login", "--confirm"],
    ["publish", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--repository", "owner/project", "--account", "login"],
    ["reconcile-repair", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
    ["reconcile-repair", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--state", "indeterminate", "--confirm"],
    ["verify", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--confirm"],
    ["verify", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--observed", "unknown", "--confirm"],
    ["resolve", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--logical-key", "only.partial", "--confirm"],
    ["resolve", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--logical-key", "valid.key", "--category", "Unknown", "--priority", "1", "--situation", "Safe.", "--action", "Act.", "--confirm"],
    ["resolve", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--logical-key", "valid.key", "--category", "Tooling", "--priority", "1", "--situation", "x".repeat(241), "--action", "Act.", "--confirm"],
  ].map(args => ({ args }));

  test.each(invalidCases)("rejects invalid args %# before backend execution", async ({ args }) => {
    let calls = 0;
    const writes: string[] = [];
    const exitCode = await runClasiCli(args, line => writes.push(line), {
      execute: async () => {
        calls += 1;
        throw new Error("must not run");
      },
      cwd: "/work/current",
    });

    expect(exitCode).toBe(2);
    expect(calls).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schema_version: 1,
      status: "choice-required",
      code: "usage-error",
      message: "Invalid clasi command arguments.",
      data: {},
      next_actions: ["Run clasi help."],
    });
  });

  const confirmationCases = [
    ["setup", "--root", "/safe"],
    ["proposals", "approve", "--scope", "global", "--id", PROPOSAL, "--kind", "fact", "--priority", "0"],
    ["proposals", "dismiss", "--scope", "global", "--id", PROPOSAL],
    ["papercuts", "dismiss", "--scope", REPOSITORY_SCOPE, "--id", CUT],
    ["dismiss", "--scope", REPOSITORY_SCOPE, "--id", CUT],
    ["conflicts", "activate", "--id", CONFLICT, "--revision-id", REVISION],
    ["migrate", "--from", REPO, "--to", `repo_${"9".repeat(32)}`],
    ["recover-lock", "--document-id", DOCUMENT],
    ["clean-transaction", "--id", TRANSACTION],
    ["repair", "--scope", REPOSITORY_SCOPE, "--id", CUT],
    ["resubmit-repair", "--scope", REPOSITORY_SCOPE, "--id", CUT],
    ["cancel-repair", "--scope", REPOSITORY_SCOPE, "--id", CUT],
    ["reconcile-repair", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--state", "failed"],
    ["verify", "--scope", REPOSITORY_SCOPE, "--id", CUT, "--observed", "passed"],
    ["resolve", "--scope", REPOSITORY_SCOPE, "--id", CUT],
  ].map(args => ({ args }));

  test.each(confirmationCases)("requires confirmation for %j", async ({ args }) => {
    let calls = 0;
    const writes: string[] = [];
    const exitCode = await runClasiCli(args, line => writes.push(line), {
      execute: async () => {
        calls += 1;
        throw new Error("must not run");
      },
      cwd: "/work/current",
    });

    expect(exitCode).toBe(2);
    expect(calls).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schema_version: 1,
      status: "choice-required",
      code: "confirmation-required",
      message: "Confirmation is required.",
      data: {},
      next_actions: ["Retry with --confirm."],
    });
  });
});

describe("headless response forwarding", () => {
  const statusCases: Array<readonly [HeadlessStatus, number]> = [
    ["ok", 0],
    ["partial", 0],
    ["choice-required", 2],
    ["setup-needed", 2],
    ["degraded", 1],
    ["error", 1],
  ];

  test.each(statusCases)("maps %s to exit %d", async (status, expectedExit) => {
    const writes: string[] = [];
    const exitCode = await runClasiCli(["status"], line => writes.push(line), {
      execute: async () =>
        createHeadlessResponse({
          status: status as HeadlessStatus,
          code: "backend-result",
          message: "Backend result.",
          data: { value: 1 },
        }),
      cwd: "/work/current",
    });

    expect(exitCode).toBe(expectedExit);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "").status).toBe(status);
  });

  test("catches backend exceptions without leaking messages or paths", async () => {
    const writes: string[] = [];
    const exitCode = await runClasiCli(["status"], line => writes.push(line), {
      execute: async () => {
        throw new Error("secret at /home/alice/customer/repository");
      },
      cwd: "/home/alice/customer/repository",
    });

    expect(exitCode).toBe(1);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schema_version: 1,
      status: "error",
      code: "backend-failed",
      message: "The clasi command could not be completed.",
      data: {},
      next_actions: [],
    });
    expect(writes[0]).not.toContain("alice");
    expect(writes[0]).not.toContain("secret");
  });
});
