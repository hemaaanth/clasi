import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { headlessOk } from "../src/headless-response.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { runClasiCommand } from "../src/commands.ts";
import type {
  ClasiCommandOptions,
  ClasiCommandServices,
  InteractiveSetupAnswers,
  InteractiveSetupWorkflow,
} from "../src/commands.ts";
import type {
  PapercutActionHandler,
  PublicationPrepareResult,
} from "../src/interactive-actions.ts";
import type { MachineFacts } from "../src/machine.ts";
import type { SetupPlan } from "../src/onboarding.ts";
import type { ScopeRef } from "../src/paths.ts";
import type { RuntimeEnvironmentReady, RuntimeEnvironmentResult } from "../src/runtime-environment.ts";
import type { ContextRecord, NapkinRecord, PapercutRecord, ProposalRecord } from "../src/schema.ts";
import { withStoreFixture } from "./support/store-fixture.ts";

const NOW = "2026-08-09T12:00:00.000Z";
const GLOBAL_SCOPE: ScopeRef = { type: "global", id: "global" };
const MACHINE_SCOPE: ScopeRef = { type: "machine", id: opaque("machine", 1) };
const REPOSITORY_SCOPE: ScopeRef = { type: "repository", id: opaque("repo", 1) };
const SCOPES = [GLOBAL_SCOPE, MACHINE_SCOPE, REPOSITORY_SCOPE] as const;
const FACTS: MachineFacts = {
  osBoundary: "linux",
  architecture: "x64",
  wsl: "wsl2",
  container: false,
  toolManagers: ["bun"],
  filesystemConvention: "posix",
  cpuBucket: "5-8",
};

class FakeUi {
  readonly selects: Array<{ title: string; options: string[]; initialIndex: number | undefined }> = [];
  readonly inputs: Array<{ title: string; placeholder: string | undefined }> = [];
  readonly confirms: Array<{ title: string; message: string }> = [];
  readonly notifications: Array<{ message: string; type: string | undefined }> = [];
  readonly selections: Array<string | undefined>;
  readonly inputValues: Array<string | undefined>;
  readonly confirmationValues: boolean[];

  constructor(options: {
    selections?: Array<string | undefined>;
    inputs?: Array<string | undefined>;
    confirms?: boolean[];
  } = {}) {
    this.selections = [...(options.selections ?? [])];
    this.inputValues = [...(options.inputs ?? [])];
    this.confirmationValues = [...(options.confirms ?? [])];
  }

  async select(
    title: string,
    options: Array<string | { label: string }>,
    dialogOptions?: { initialIndex?: number },
  ): Promise<string | undefined> {
    const labels = options.map(option => typeof option === "string" ? option : option.label);
    this.selects.push({ title, options: labels, initialIndex: dialogOptions?.initialIndex });
    const requested = this.selections.shift();
    if (requested === undefined) return undefined;
    const selected = labels.find(label => label === requested || label.endsWith(`. ${requested}`));
    if (!selected) throw new Error(`Selection not found: ${requested} in ${labels.join(" | ")}`);
    return selected;
  }

  async input(title: string, placeholder?: string): Promise<string | undefined> {
    this.inputs.push({ title, placeholder });
    return this.inputValues.shift();
  }

  async confirm(title: string, message: string): Promise<boolean> {
    this.confirms.push({ title, message });
    return this.confirmationValues.shift() ?? false;
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifications.push({ message, type });
  }
}

describe("interactive clasi command", () => {
  test("noninteractive hosts are directed to the headless CLI without resolving state", async () => {
    const ui = new FakeUi();
    let resolved = 0;
    await runClasiCommand("", commandContext(ui, false), {
      resolveEnvironment: async () => {
        resolved += 1;
        return READY;
      },
    });
    expect(resolved).toBe(0);
    expect(ui.selects).toHaveLength(0);
    expect(ui.notifications).toEqual([{
      message: "Interactive clasi requires a TUI. Use the headless clasi CLI instead.",
      type: "warning",
    }]);
  });

  test("the setup-needed main menu is numbered and Back or Escape exits without hidden work", async () => {
    const back = new FakeUi({ selections: ["Back"] });
    await runClasiCommand("review", commandContext(back), {
      resolveEnvironment: async () => ({ status: "setup-needed", code: "setup-needed" }),
    });
    expect(back.selects[0]?.title).toBe("clasi · setup-needed (setup-needed)");
    expect(back.selects[0]?.options).toEqual([
      "1. Conflicts", "2. Setup", "3. Status", "4. Config", "5. Context", "6. Napkin",
      "7. Papercuts", "8. History", "9. Impact", "10. Doctor", "11. Back",
    ]);

    const escape = new FakeUi({ selections: [undefined] });
    await runClasiCommand("", commandContext(escape), {
      resolveEnvironment: async () => READY,
      createServices: async () => {
        throw new Error("must not load");
      },
    });
    expect(escape.selects).toHaveLength(1);
    expect(escape.notifications).toHaveLength(0);
  });

  test("recognized degraded blockers put injected Recovery before Conflicts", async () => {
    const ui = new FakeUi({ selections: ["Recovery", "Back", "Back"] });
    let runs = 0;
    await runClasiCommand("", commandContext(ui), {
      resolveEnvironment: async () => ({
        status: "degraded",
        code: "repository-migration-required",
        migration: {
          environment: READY,
          locator: { kind: "path-hash", pathHash: "a".repeat(64) },
          fromRepositoryKey: opaque("repo", 40),
          toRepositoryKey: opaque("repo", 41),
        },
      }),
      recovery: {
        available: async () => ["repository-migration"],
        run: async () => {
          runs += 1;
          return { status: "ok" };
        },
      },
    });
    expect(ui.selects[0]?.options).toEqual([
      "1. Recovery", "2. Conflicts", "3. Status", "4. Config", "5. Context", "6. Napkin",
      "7. Papercuts", "8. History", "9. Impact", "10. Doctor", "11. Back",
    ]);
    expect(ui.selects[1]?.options).toEqual(["1. Review repository migration", "2. Back"]);
    expect(runs).toBe(0);
  });

  test("default migration recovery confirms opaque from-to IDs and runs the current migration once", async () => {
    const migration = migrationRequired(42, 43, "a");
    const calls: unknown[] = [];
    const ui = new FakeUi({
      selections: ["Recovery", "Review repository migration", "Back"],
      confirms: [true],
    });
    await runClasiCommand("", commandContext(ui), {
      resolveEnvironment: async () => migration,
      runRepositoryMigration: async context => {
        calls.push(context);
        return { status: "complete" };
      },
    });

    expect(calls).toHaveLength(1);
    expect(ui.confirms[0]?.message).toContain(migration.migration.fromRepositoryKey);
    expect(ui.confirms[0]?.message).toContain(migration.migration.toRepositoryKey);
    expect(ui.confirms[0]?.message).toContain("Effect: copy validated repository guidance");
    expect(ui.confirms[0]?.message).not.toContain("/");
  });

  test("default migration recovery cancellation has zero effects", async () => {
    const migration = migrationRequired(44, 45, "b");
    let calls = 0;
    const ui = new FakeUi({
      selections: ["Recovery", "Review repository migration", "Back"],
      confirms: [false],
    });
    await runClasiCommand("", commandContext(ui), {
      resolveEnvironment: async () => migration,
      runRepositoryMigration: async () => {
        calls += 1;
        return { status: "complete" };
      },
    });
    expect(calls).toBe(0);
  });

  test("default migration recovery rejects context drift before any effect", async () => {
    const initial = migrationRequired(46, 47, "c");
    const drifted = migrationRequired(46, 48, "d");
    let resolutions = 0;
    let calls = 0;
    const ui = new FakeUi({
      selections: ["Recovery", "Review repository migration", "Back"],
      confirms: [true],
    });
    await runClasiCommand("", commandContext(ui), {
      resolveEnvironment: async () => {
        resolutions += 1;
        return resolutions <= 2 ? initial : drifted;
      },
      runRepositoryMigration: async () => {
        calls += 1;
        return { status: "complete" };
      },
    });

    expect(calls).toBe(0);
    expect(ui.notifications).toContainEqual({
      message: "Recovery action unavailable (migration-context-changed).",
      type: "warning",
    });
  });

  test("ready main inspects both coordination lists and hides Recovery only when both are empty", async () => {
    let lockLists = 0;
    let transactionLists = 0;
    const emptyServices: ClasiCommandServices = {
      ...commandServices({}),
      coordination: {
        listLocks: async () => {
          lockLists += 1;
          return { status: "empty" };
        },
        listTransactions: async () => {
          transactionLists += 1;
          return { status: "empty" };
        },
        recoverLock: async () => ({ status: "rejected", code: "lock-recovery-unavailable" }),
        cleanTransaction: async () => ({ status: "rejected", code: "transaction-not-terminal" }),
      },
    };
    const emptyUi = new FakeUi({ selections: ["Back"] });
    await runClasiCommand("", commandContext(emptyUi), readyOptions(emptyServices));
    expect(emptyUi.selects[0]?.options).toEqual([
      "1. Conflicts", "2. Status", "3. Config", "4. Context", "5. Napkin",
      "6. Papercuts", "7. History", "8. Impact", "9. Doctor", "10. Back",
    ]);
    expect([lockLists, transactionLists]).toEqual([1, 1]);

    const unavailableUi = new FakeUi({ selections: ["Back"] });
    await runClasiCommand("", commandContext(unavailableUi), readyOptions({
      ...emptyServices,
      coordination: {
        ...emptyServices.coordination!,
        listLocks: async () => ({ status: "rejected", code: "storage-unavailable" }),
      },
    }));
    expect(unavailableUi.selects[0]?.options[0]).toBe("1. Recovery");
  });

  test("recommended setup detects the machine and needs only one final confirmation", async () => {
    const ui = new FakeUi({
      selections: ["Use recommended defaults — no typing required"],
      confirms: [true],
    });
    let prepared: InteractiveSetupAnswers | undefined;
    const plan = setupPlan({});
    const workflow: InteractiveSetupWorkflow = {
      detectMachineFacts: async () => FACTS,
      prepare: async answers => {
        prepared = answers;
        return plan;
      },
      commit: async () => ({
        status: "committed",
        machineId: opaque("machine", 2),
        activatedMachineFacts: 7,
        activatedPreferences: 0,
        stagedImports: 0,
        skippedImports: [],
      }),
    };

    await runClasiCommand("setup", commandContext(ui), { createSetup: () => workflow });

    expect(ui.selects[0]).toEqual({
      title: "Set up clasi",
      options: [
        "1. Use recommended defaults — no typing required",
        "2. Customize 3 optional preferences",
        "3. Cancel",
      ],
      initialIndex: 0,
    });
    expect(ui.notifications[0]?.message).toContain(
      "Recommended defaults require no typing; custom setup has three optional steps.",
    );
    expect(ui.inputs).toHaveLength(0);
    expect(prepared).toEqual({ machineFacts: FACTS });
    expect(ui.confirms[0]?.message).toContain(
      "Detected automatically: OS linux · Architecture x64 · WSL WSL2 · Container no",
    );
    expect(ui.notifications.at(-1)?.message).toBe("clasi is ready. Run /clasi to review what it remembers.");
  });

  test("custom setup explains and gates each optional freeform value", async () => {
    const ui = new FakeUi({
      selections: [
        "Customize 3 optional preferences",
        "Add a preference for every repository",
        "Add a machine-specific preference",
        "Import an instruction file for review",
      ],
      inputs: ["Prefer Bun for package scripts", "Use WSL-aware commands", "/safe/instructions.txt"],
      confirms: [true],
    });
    let prepared: InteractiveSetupAnswers | undefined;
    let committed: SetupPlan | undefined;
    const plan = setupPlan({ imports: 1, global: true, machine: true });
    const workflow: InteractiveSetupWorkflow = {
      detectMachineFacts: async () => FACTS,
      prepare: async answers => {
        prepared = answers;
        return plan;
      },
      commit: async candidate => {
        committed = candidate;
        return {
          status: "committed",
          machineId: opaque("machine", 2),
          activatedMachineFacts: 7,
          activatedPreferences: 2,
          stagedImports: 1,
          skippedImports: [],
        };
      },
    };

    await runClasiCommand("setup", commandContext(ui), { createSetup: () => workflow });

    expect(ui.selects.map(select => select.title)).toEqual([
      "Set up clasi",
      "Step 1 of 3 · Global preference",
      "Step 2 of 3 · Machine preference",
      "Step 3 of 3 · Instruction import",
    ]);
    expect(ui.selects.slice(1).map(select => select.options)).toEqual([
      [
        "1. Skip — clasi can learn this later",
        "2. Add a preference for every repository",
      ],
      [
        "1. Use detected machine facts only",
        "2. Add a machine-specific preference",
      ],
      [
        "1. Skip — no instruction file",
        "2. Import an instruction file for review",
      ],
    ]);
    expect(ui.inputs.map(input => input.title)).toEqual([
      "Global preference", "Machine-specific preference", "Instruction file",
    ]);
    expect(prepared).toEqual({
      machineFacts: FACTS,
      globalPreference: "Prefer Bun for package scripts",
      machinePreference: "Use WSL-aware commands",
      instructionPath: "/safe/instructions.txt",
    });
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0]?.message).toContain("Instruction import: Ready for review");
    expect(committed).toBe(plan);
  });

  test("setup confirmation keeps every stored machine fact and bounded preference visible", async () => {
    const globalPreference = "g".repeat(240);
    const machinePreference = "m".repeat(240);
    const plan: SetupPlan = {
      ...setupPlan({}),
      globalPreference: { logicalKey: "coding-default", value: globalPreference, approved: true },
      machinePreference: { logicalKey: "machine-preference", value: machinePreference, approved: true },
    };
    const ui = new FakeUi({
      selections: ["Use recommended defaults — no typing required"],
      confirms: [false],
    });
    const workflow: InteractiveSetupWorkflow = {
      detectMachineFacts: async () => FACTS,
      prepare: async () => plan,
      commit: async () => {
        throw new Error("commit should not run");
      },
    };

    await runClasiCommand("setup", commandContext(ui), { createSetup: () => workflow });

    const summary = ui.confirms[0]?.message ?? "";
    expect(summary).toContain(globalPreference);
    expect(summary).toContain(machinePreference);
    expect(summary).toContain("Container no");
    expect(summary).toContain("Filesystem posix");
    expect(summary).toContain("CPU 5-8");
    expect(summary).toContain("Instruction import: None");
    expect(summary).toContain("Nothing is written until you finish setup.");
  });

  test("setup cancellation at the first choice or final confirmation performs no commit", async () => {
    let prepares = 0;
    let commits = 0;
    const workflow: InteractiveSetupWorkflow = {
      detectMachineFacts: async () => FACTS,
      prepare: async () => {
        prepares += 1;
        return setupPlan({});
      },
      commit: async () => {
        commits += 1;
        return { status: "cancelled" };
      },
    };
    const escaped = new FakeUi();
    await runClasiCommand("setup", commandContext(escaped), { createSetup: () => workflow });
    expect(prepares).toBe(0);
    expect(commits).toBe(0);

    const cancelled = new FakeUi({
      selections: ["Use recommended defaults — no typing required"],
      confirms: [false],
    });
    await runClasiCommand("setup", commandContext(cancelled), { createSetup: () => workflow });
    expect(prepares).toBe(1);
    expect(commits).toBe(0);
  });

  test("Context labels precedence states and reviews pending proposals with approve and dismiss", async () => {
    const active = contextRecord(1, "package-manager", "bun", true);
    const shadowed = contextRecord(2, "package-manager", "npm", true);
    const unapproved = contextRecord(3, "editor", "vim", false);
    const approve = proposalRecord(1, "coding-default", "Prefer short commands");
    const dismiss = proposalRecord(2, "obsolete-default", "Retire an old preference");
    let pending = [{ scope: GLOBAL_SCOPE, record: approve }, { scope: MACHINE_SCOPE, record: dismiss }];
    const approved: unknown[] = [];
    const dismissed: unknown[] = [];
    const services = commandServices({
      resolution: {
        status: "ok",
        active: [{ scope: REPOSITORY_SCOPE, record: active }],
        shadowed: [{ scope: GLOBAL_SCOPE, record: shadowed }],
        unapproved: [{ scope: MACHINE_SCOPE, record: unapproved }],
      },
      proposals: () => ({ status: "ok", records: pending, truncated: false }),
      approve: async input => {
        approved.push(input);
        pending = pending.filter(entry => entry.record.id !== approve.id);
        return {
          status: "approved",
          proposalId: approve.id,
          contextRecordId: opaque("ctx", 9),
          contextRevisionId: opaque("rev", 9),
        };
      },
      dismissProposal: async (scope, id) => {
        dismissed.push({ scope, id });
        pending = pending.filter(entry => entry.record.id !== id);
        return { status: "dismissed", proposalId: id, revisionId: opaque("rev", 8), changed: true };
      },
    });
    const ui = new FakeUi({
      selections: [
        "[proposal] global · coding-default: Prefer short commands", "Approve proposal", "Preference",
        "[proposal] machine · obsolete-default: Retire an old preference", "Dismiss proposal", "Back",
      ],
      inputs: ["80"],
      confirms: [true, true],
    });
    await runReady("context", ui, services);
    expect(ui.selects[0]?.options.join("\n")).toContain("[active] repository · package-manager: bun");
    expect(ui.selects[0]?.options.join("\n")).toContain("[shadowed] global · package-manager: npm");
    expect(ui.selects[0]?.options.join("\n")).toContain("[unapproved] machine · editor: vim");
    expect(approved).toEqual([{ scope: GLOBAL_SCOPE, proposalId: approve.id, kind: "preference", priority: 80 }]);
    expect(dismissed).toEqual([{ scope: MACHINE_SCOPE, id: dismiss.id }]);
    expect(ui.notifications.map(item => item.message)).toEqual(["Proposal approved.", "Proposal dismissed."]);
  });

  test("Napkin groups active guidance by category cap and exposes validated demoted history", async () => {
    const active = napkinRecord(1, "Validation", "Checks drift after retries", "Re-run the focused check");
    const demoted = napkinRecord(2, "Validation", "Old checks hid failures", "Use observable assertions");
    const services = commandServices({
      napkinList: { status: "ok", categoryCap: 2, records: [active] },
      napkinHistory: {
        status: "ok",
        categoryCap: 2,
        revisions: [{
          revisionId: opaque("rev", 4),
          parentRevisionId: opaque("rev", 3),
          updatedAt: NOW,
          activeRecords: [active],
          demotedRecords: [demoted],
          demotedRecordsTruncated: false,
        }],
        revisionsTruncated: false,
        completeLineage: true,
      },
    });
    const activeUi = new FakeUi({ selections: ["[Validation 1/2] Checks drift after retries", "Back", "Back"] });
    await runReady("napkin", activeUi, services);
    expect(activeUi.selects[1]?.title).toContain("Category: Validation (cap 2)");
    expect(activeUi.selects[1]?.title).toContain("Do instead: Re-run the focused check");

    const historyUi = new FakeUi({ selections: [
      "[demoted] global · Validation: Old checks hid failures", "Back", "Back",
    ] });
    await runReady("history", historyUi, services);
    expect(historyUi.selects[1]?.title).toContain(`Revision: ${opaque("rev", 4)}`);
    expect(historyUi.selects[1]?.title).toContain("Do instead: Use observable assertions");
  });

  test("empty and degraded lists have distinct factual messages", async () => {
    const cases: Array<{ command: string; services: ClasiCommandServices; expected: string }> = [
      { command: "context", services: commandServices({}), expected: "No Context or pending proposals for the active scopes." },
      { command: "napkin", services: commandServices({ napkinList: { status: "ok", categoryCap: 5, records: [] } }), expected: "No active Napkin guidance for the active scopes." },
      { command: "history", services: commandServices({ napkinHistory: { status: "ok", categoryCap: 5, revisions: [], revisionsTruncated: false, completeLineage: true } }), expected: "No demoted Napkin guidance in validated history." },
      { command: "papercuts", services: commandServices({}), expected: "No open Papercuts for the active scopes." },
      { command: "napkin", services: commandServices({ napkinList: { status: "rejected", code: "read-failed" } }), expected: "Napkin is degraded (read-failed)." },
      { command: "papercuts", services: commandServices({ papercutList: { status: "rejected", code: "storage-unavailable" } }), expected: "Papercuts are degraded (storage-unavailable)." },
    ];
    for (const item of cases) {
      const ui = new FakeUi();
      await runReady(item.command, ui, item.services);
      expect(ui.notifications.at(-1)?.message).toBe(item.expected);
    }
  });

  test("Papercut details expose only legal actions and preserve the selected row after an action", async () => {
    const queued = papercutRecord(1, "queued", "pending");
    const repairable = papercutRecord(2, "none", "none");
    const services = commandServices({ papercutList: () => ({ status: "ok", records: [queued, repairable] }) });
    const calls: string[] = [];
    const actions = actionHandler({
      cancelRepair: async () => {
        calls.push("cancel");
        queued.repairState = "none";
        return { status: "updated", record: queued };
      },
      dispatchRepair: async input => {
        calls.push(`dispatch:${input.cutId}`);
        return { status: "dispatched", adapter: "paseo" };
      },
    });
    const ui = new FakeUi({
      selections: [
        "[open/queued] major · recurrence 2: Friction 1", "Cancel queued repair",
        "[open/none] major · recurrence 2: Friction 2", "Start repair", "Back",
      ],
      confirms: [true, true],
    });
    await runClasiCommand("papercuts", commandContext(ui), readyOptions(services, {
      createPapercutActions: () => actions,
    }));
    expect(calls).toEqual(["cancel", `dispatch:${repairable.id}`]);
    expect(ui.selects[1]?.options).toEqual(["1. Cancel queued repair", "2. Back"]);
    expect(ui.selects[3]?.options).toEqual([
      "1. Start repair",
      "2. Publish GitHub issue",
      "3. Dismiss Papercut",
      "4. Back",
    ]);
    expect(ui.selects[4]?.initialIndex).toBe(1);
  });

  test("Papercut dismissal requires explicit confirmation and cancellation changes nothing", async () => {
    const record = papercutRecord(3, "failed", "none");
    let dismissals = 0;
    const services = commandServices({ papercutList: { status: "ok", records: [record] } });
    const actions = actionHandler({
      dismiss: async () => {
        dismissals += 1;
        return { status: "archived", record };
      },
    });
    const ui = new FakeUi({
      selections: ["[open/failed] major · recurrence 2: Friction 3", "Dismiss Papercut", "Back", "Back"],
      confirms: [false],
    });
    await runClasiCommand("papercuts", commandContext(ui), readyOptions(services, {
      createPapercutActions: () => actions,
    }));
    expect(ui.confirms[0]?.message).toContain(`Target: ${record.id}`);
    expect(dismissals).toBe(0);
  });

  test("publication previews the resolved repository, account, and title before committing that target", async () => {
    const record = papercutRecord(4, "none", "none");
    const services = commandServices({ papercutList: { status: "ok", records: [record] } });
    const committed: unknown[] = [];
    const actions = actionHandler({
      preparePublication: async (): Promise<PublicationPrepareResult> => ({
        status: "prepared",
        preview: {
          repository: "team/project",
          account: "octocat",
          title: record.summary,
          publicationState: "none",
        },
      }),
      commitPublication: async input => {
        committed.push(input);
        return { status: "published", issueNumber: 17, alreadyPublished: false };
      },
    });
    const ui = new FakeUi({
      selections: [
        "[open/none] major · recurrence 2: Friction 4",
        "Publish GitHub issue",
      ],
      confirms: [true],
    });
    await runClasiCommand("papercuts", commandContext(ui), readyOptions(services, {
      createPapercutActions: () => actions,
    }));
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0]?.message).toContain("Repository: team/project");
    expect(ui.confirms[0]?.message).toContain("Authenticated account: octocat");
    expect(ui.confirms[0]?.message).toContain(`Issue title: ${record.summary}`);
    expect(committed).toEqual([expect.objectContaining({
      expectedRepository: "team/project",
      expectedAccount: "octocat",
      confirmed: true,
    })]);

    let canceledCommits = 0;
    const canceledUi = new FakeUi({
      selections: [
        "[open/none] major · recurrence 2: Friction 4",
        "Publish GitHub issue",
        "Back",
      ],
      confirms: [false],
    });
    await runClasiCommand("papercuts", commandContext(canceledUi), readyOptions(services, {
      createPapercutActions: () => actionHandler({
        preparePublication: actions.preparePublication,
        commitPublication: async () => {
          canceledCommits += 1;
          return { status: "published", issueNumber: 18, alreadyPublished: false };
        },
      }),
    }));
    expect(canceledCommits).toBe(0);
  });

  test("verification records only an explicit observation and resolution copies no narrative by default", async () => {
    const awaiting = papercutRecord(5, "awaiting_verification", "published");
    const observed: unknown[] = [];
    const verifyUi = new FakeUi({
      selections: [
        "[open/awaiting_verification] major · recurrence 2: Friction 5",
        "Verify repair",
        "Observed passed",
      ],
      confirms: [true],
    });
    await runClasiCommand(
      "papercuts",
      commandContext(verifyUi),
      readyOptions(commandServices({ papercutList: { status: "ok", records: [awaiting] } }), {
        createPapercutActions: () => actionHandler({
          verifyRepair: async input => {
            observed.push(input);
            return { status: "verified" };
          },
        }),
      }),
    );
    expect(observed).toEqual([expect.objectContaining({ observation: "passed", confirmed: true })]);

    const verified = papercutRecord(6, "verified", "published");

    const durableVerified = papercutRecord(7, "verified", "published");
    const durableResolutions: unknown[] = [];
    const durableUi = new FakeUi({
      selections: [
        "[open/verified] major · recurrence 2: Friction 7",
        "Resolve Papercut",
        "Add durable lesson",
        "Validation",
      ],
      inputs: [
        "verified-workflow",
        "70",
        "A repaired workflow can regress.",
        "Use the verified workflow.",
      ],
      confirms: [true],
    });
    await runClasiCommand(
      "papercuts",
      commandContext(durableUi),
      readyOptions(commandServices({ papercutList: { status: "ok", records: [durableVerified] } }), {
        createPapercutActions: () => actionHandler({
          resolve: async input => {
            durableResolutions.push(input);
            return { status: "resolved", napkinOutcome: "created" };
          },
        }),
      }),
    );
    expect(durableResolutions).toEqual([expect.objectContaining({
      durableNapkinProposal: {
        durable: true,
        logicalKey: "verified-workflow",
        category: "Validation",
        priority: 70,
        situation: "A repaired workflow can regress.",
        action: "Use the verified workflow.",
        sourceClassification: "generalized-derived",
      },
    })]);
    const resolutions: unknown[] = [];
    const resolveUi = new FakeUi({
      selections: [
        "[open/verified] major · recurrence 2: Friction 6",
        "Resolve Papercut",
        "No durable lesson",
      ],
      confirms: [true],
    });
    await runClasiCommand(
      "papercuts",
      commandContext(resolveUi),
      readyOptions(commandServices({ papercutList: { status: "ok", records: [verified] } }), {
        createPapercutActions: () => actionHandler({
          resolve: async input => {
            resolutions.push(input);
            return { status: "resolved", napkinOutcome: "not-requested" };
          },
        }),
      }),
    );
    expect(resolutions).toEqual([expect.not.objectContaining({
      durableNapkinProposal: expect.anything(),
    })]);
  });

  test("durable lesson cancellation stops before later prompts or effects", async () => {
    const verified = papercutRecord(8, "verified", "published");
    let resolutions = 0;
    const ui = new FakeUi({
      selections: [
        "[open/verified] major · recurrence 2: Friction 8",
        "Resolve Papercut",
        "Add durable lesson",
        "Back",
        "Back",
      ],
      inputs: ["verified-workflow"],
    });
    await runClasiCommand(
      "papercuts",
      commandContext(ui),
      readyOptions(commandServices({ papercutList: { status: "ok", records: [verified] } }), {
        createPapercutActions: () => actionHandler({
          resolve: async () => {
            resolutions += 1;
            return { status: "resolved", napkinOutcome: "created" };
          },
        }),
      }),
    );
    expect(ui.inputs.map(input => input.title)).toEqual(["Durable lesson key"]);
    expect(ui.confirms).toHaveLength(0);
    expect(resolutions).toBe(0);
  });

  test("default config updater atomically persists the confirmed cap", async () => {
    await withStoreFixture(async fixture => {
      const stored = {
        schemaVersion: 1,
        dataRoot: fixture.roots.dataRoot,
        napkinCategoryCap: 5,
        contextCharacterCap: 6_000,
      };
      await writeFile(fixture.paths.config, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const environment: RuntimeEnvironmentReady = {
        status: "ready",
        config: {
          dataRoot: fixture.roots.dataRoot,
          napkinCategoryCap: 5,
          contextCharacterCap: 6_000,
        },
        roots: fixture.roots,
        controlPin: fixture.controlPin,
        dataPin: fixture.dataPin,
        paths: fixture.paths,
        store: fixture.store,
        machineId: opaque("machine", 50),
        scopes: [GLOBAL_SCOPE],
        capabilities: { repositoryScope: "not-repository", requiresReattachOnMove: false },
        degradations: [],
      };
      const loadConfig = async () => {
        const current = JSON.parse(await readFile(fixture.paths.config, "utf8")) as {
          napkinCategoryCap: number;
          contextCharacterCap: number;
        };
        return headlessOk("config-ready", "ready", {
          data_root: "${HOME}/.clasi",
          caps: {
            napkin_category: current.napkinCategoryCap,
            context_characters: current.contextCharacterCap,
          },
          capabilities: {
            repository_scope: "not-repository" as const,
            requires_reattach_on_move: false,
          },
          degradations: [],
        });
      };
      const ui = new FakeUi({
        selections: ["Change Napkin category cap", "Back"],
        inputs: ["7"],
        confirms: [true],
      });
      await runClasiCommand("config", commandContext(ui), {
        resolveEnvironment: async () => environment,
        config: loadConfig,
      });

      const persisted = JSON.parse(await readFile(fixture.paths.config, "utf8")) as {
        napkinCategoryCap: number;
      };
      expect(persisted.napkinCategoryCap).toBe(7);
      expect(ui.confirms[0]?.message).toContain("Effect: replace 5 with 7");
      expect(ui.selects[1]?.title).toContain("Napkin category cap: 7");
    });
  }, 15_000);

  test("direct conflicts and impact commands use optional ready services", async () => {
    const conflictUi = new FakeUi();
    const conflictServices = {
      ...commandServices({}),
      conflicts: {
        list: async () => ({ status: "ok" as const, conflicts: [], truncated: false }),
        show: async () => ({ status: "rejected" as const, code: "not-found" as const }),
        revalidate: async () => ({ status: "rejected" as const, code: "not-found" as const }),
        activate: async () => ({ status: "rejected" as const, code: "not-found" as const }),
      },
    };
    await runReady("conflicts", conflictUi, conflictServices);
    expect(conflictUi.notifications).toEqual([{
      message: "No unresolved conflicts.",
      type: "info",
    }]);

    const impactUi = new FakeUi();
    const impactServices = {
      ...commandServices({}),
      impact: {
        report: async () => ({ status: "rejected" as const, reason: "invalid-machine-id" as const }),
      },
    };
    await runReady("impact", impactUi, impactServices);
    expect(impactUi.notifications).toEqual([{
      message: "Impact report unavailable (invalid-machine-id).",
      type: "warning",
    }]);
  });

  test("status and doctor callbacks emit bounded factual outcomes", async () => {
    const statusUi = new FakeUi();
    await runClasiCommand("status", commandContext(statusUi), {
      status: async () => ({ status: "ok", summary: "repository attached; no degradations" }),
    });
    expect(statusUi.notifications).toEqual([{
      message: "clasi status: ok. repository attached; no degradations",
      type: "info",
    }]);

    const doctorUi = new FakeUi();
    await runClasiCommand("doctor", commandContext(doctorUi), {
      doctor: async () => ({ status: "degraded", code: "unsafe-data-root" }),
    });
    expect(doctorUi.notifications).toEqual([{
      message: "clasi doctor: degraded. (unsafe-data-root)",
      type: "warning",
    }]);
  });
});

function commandContext(ui: FakeUi, hasUI = true): ExtensionContext {
  return { cwd: "/workspace", hasUI, ui } as unknown as ExtensionContext;
}

const READY = {
  status: "ready",
  scopes: SCOPES,
  config: { dataRoot: "/data", napkinCategoryCap: 5, contextCharacterCap: 6_000 },
} as unknown as RuntimeEnvironmentReady;

function migrationRequired(
  fromIndex: number,
  toIndex: number,
  hashCharacter: string,
): Extract<RuntimeEnvironmentResult, { code: "repository-migration-required" }> {
  return {
    status: "degraded",
    code: "repository-migration-required",
    migration: {
      environment: READY,
      locator: { kind: "path-hash", pathHash: hashCharacter.repeat(64) },
      fromRepositoryKey: opaque("repo", fromIndex),
      toRepositoryKey: opaque("repo", toIndex),
    },
  };
}

function readyOptions(services: ClasiCommandServices, rest: ClasiCommandOptions = {}): ClasiCommandOptions {
  return { resolveEnvironment: async () => READY, createServices: async () => services, ...rest };
}

async function runReady(command: string, ui: FakeUi, services: ClasiCommandServices): Promise<void> {
  await runClasiCommand(command, commandContext(ui), readyOptions(services));
}

type ServicesFixture = {
  resolution?: unknown;
  proposals?: unknown | (() => unknown);
  approve?: (input: unknown) => Promise<unknown>;
  dismissProposal?: (scope: ScopeRef, id: string) => Promise<unknown>;
  napkinList?: unknown | (() => unknown);
  napkinHistory?: unknown | (() => unknown);
  papercutList?: unknown | (() => unknown);
};

function commandServices(fixture: ServicesFixture): ClasiCommandServices {
  const value = <T>(source: T | (() => T) | undefined, fallback: T): T =>
    typeof source === "function" ? (source as () => T)() : source ?? fallback;
  return {
    context: { resolve: async () => value(fixture.resolution, { status: "ok", active: [], shadowed: [], unapproved: [] }) },
    proposals: {
      list: async () => value(fixture.proposals, { status: "ok", records: [], truncated: false }),
      approveContext: async (input: unknown) =>
        fixture.approve ? fixture.approve(input) : { status: "rejected", code: "invalid-transition" },
      dismiss: async (scope: ScopeRef, id: string) =>
        fixture.dismissProposal
          ? fixture.dismissProposal(scope, id)
          : { status: "rejected", code: "invalid-transition" },
    },
    napkin: {
      list: async () => value(fixture.napkinList, { status: "ok", categoryCap: 5, records: [] }),
      history: async () => value(fixture.napkinHistory, { status: "ok", categoryCap: 5, revisions: [], revisionsTruncated: false, completeLineage: true }),
    },
    papercuts: {
      inbox: async (scope: ScopeRef) => scope.type === "repository"
        ? value(fixture.papercutList, { status: "ok", records: [] })
        : { status: "ok", records: [] },
    },
  } as unknown as ClasiCommandServices;
}

function contextRecord(index: number, logicalKey: string, value: string, approved: boolean): ContextRecord {
  return {
    id: opaque("ctx", index), logicalKey, kind: "preference", value,
    sourceClassification: "generalized-derived", approved, priority: 50, createdAt: NOW, updatedAt: NOW,
  };
}

function proposalRecord(index: number, logicalKey: string, summary: string): ProposalRecord {
  return {
    id: opaque("proposal", index), targetType: "context", logicalKey, summary,
    sourceClassification: "generalized-derived", status: "open", createdAt: NOW, updatedAt: NOW,
  };
}

function napkinRecord(index: number, category: NapkinRecord["category"], situation: string, action: string): NapkinRecord {
  return {
    id: opaque("napkin", index), logicalKey: `lesson-${index}`, category, priority: 50,
    recurrence: 2, hitCount: 1, situation, action, sourceClassification: "generalized-derived",
    createdAt: NOW, updatedAt: NOW,
  };
}

function papercutRecord(
  index: number,
  repairState: PapercutRecord["repairState"],
  publicationState: PapercutRecord["publicationState"],
): PapercutRecord {
  return {
    id: opaque("cut", index), fingerprint: `friction-${index}`, summary: `Friction ${index}`,
    severity: "major", prevention: "Use the guarded workflow", acceptanceCondition: "The focused check passes",
    sourceClassification: "generalized-derived", lifecycle: "open", repairState, publicationState,
    publicationIssueNumber: publicationState === "published" ? 42 : null,
    recurrence: 2, relatedIds: [], createdAt: NOW, updatedAt: NOW,
  };
}
function actionHandler(
  overrides: Partial<PapercutActionHandler> = {},
): PapercutActionHandler {
  const unavailable = async () => ({ status: "rejected", code: "not-configured" } as never);
  return {
    dismiss: unavailable,
    preparePublication: unavailable,
    commitPublication: unavailable,
    reconcilePublication: unavailable,
    resubmitPublication: unavailable,
    dispatchRepair: unavailable,
    cancelRepair: unavailable,
    reconcileRepair: unavailable,
    resubmitRepair: unavailable,
    verifyRepair: unavailable,
    resolve: unavailable,
    ...overrides,
  };
}


function setupPlan(options: { imports?: number; global?: boolean; machine?: boolean }): SetupPlan {
  return {
    machineFacts: FACTS,
    ...(options.global ? { globalPreference: { logicalKey: "coding-default", value: "global", approved: true } } : {}),
    ...(options.machine ? { machinePreference: { logicalKey: "machine-preference", value: "machine", approved: true } } : {}),
    imports: Array.from({ length: options.imports ?? 0 }, (_, index) => ({
      proposalId: opaque("proposal", index + 10), sourcePath: `/transient/${index}`,
      scope: "global" as const, logicalKey: "imported-instructions", summary: "Imported instruction guidance pending review.",
    })),
    skippedImports: [],
  } as unknown as SetupPlan;
}

function opaque(prefix: string, value: number): string {
  return `${prefix}_${value.toString(16).padStart(32, "0")}`;
}
