import { describe, expect, test } from "bun:test";
import type { HeadlessRequest } from "../src/cli.ts";
import { executeHeadlessRequest, type HeadlessOperationsOptions, type ReadyServices } from "../src/headless-operations.ts";
import { headlessChoiceRequired, headlessOk, headlessPartial } from "../src/headless-response.ts";
import type { RuntimeEnvironmentReady, RuntimeEnvironmentResult } from "../src/runtime-environment.ts";

const GLOBAL = { type: "global", id: "global" } as const;
const MACHINE = { type: "machine", id: "machine_11111111111111111111111111111111" } as const;
const REPOSITORY = { type: "repository", id: "repo_22222222222222222222222222222222" } as const;
const OTHER = { type: "repository", id: "repo_33333333333333333333333333333333" } as const;
const PROPOSAL = "proposal_44444444444444444444444444444444";
const CUT = "cut_55555555555555555555555555555555";
const CONFLICT = "conflict_66666666666666666666666666666666";
const REVISION = "rev_77777777777777777777777777777777";
const DOCUMENT = "doc_88888888888888888888888888888888";
const TRANSACTION = "tx_99999999999999999999999999999999";
const CWD = "/workspace";

function ready(): RuntimeEnvironmentReady {
  return {
    status: "ready",
    machineId: MACHINE.id,
    scopes: [GLOBAL, MACHINE, REPOSITORY],
    repositoryKey: REPOSITORY.id,
    capabilities: { repositoryScope: "attached", requiresReattachOnMove: false },
    degradations: [],
    config: { dataRoot: "/private/data", napkinCategoryCap: 5, contextCharacterCap: 6_000 },
  } as unknown as RuntimeEnvironmentReady;
}

function migration(): Extract<RuntimeEnvironmentResult, { status: "degraded"; code: "repository-migration-required" }> {
  return {
    status: "degraded",
    code: "repository-migration-required",
    migration: {
      environment: ready(),
      locator: { kind: "filesystem", device: "8", inode: "42" },
      fromRepositoryKey: REPOSITORY.id,
      toRepositoryKey: OTHER.id,
    },
  };
}

function fixture() {
  const calls: string[] = [];
  const log = (name: string, value?: unknown) => calls.push(`${name}:${JSON.stringify(value)}`);
  const services = {
    context: { resolve: async (value: unknown) => (log("context", value), { status: "ok", active: [], shadowed: [] }) },
    proposals: {
      list: async (...value: unknown[]) => (log("proposals:list", value), { status: "ok", records: [], truncated: false }),
      approveContext: async (value: unknown) => (log("proposals:approve", value), { status: "approved", proposalId: PROPOSAL, revisionId: REVISION, changed: true }),
      dismiss: async (...value: unknown[]) => (log("proposals:dismiss", value), { status: "dismissed", proposalId: PROPOSAL, revisionId: REVISION, changed: true }),
    },
    napkins: {
      list: async (value: unknown) => (log("napkin:list", value), { status: "ok", categoryCap: 5, records: [] }),
      history: async (value: unknown) => (log("napkin:history", value), { status: "ok", categoryCap: 5, current: [], revisions: [], truncated: false }),
      curate: async (value: unknown) => (log("napkin:curate", value), { status: "created", id: "napkin_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", active: true, revisionId: REVISION }),
    },
    papercuts: {
      inbox: async (value: unknown) => (log("papercuts:list", value), { status: "ok", records: [] }),
      get: async (...value: unknown[]) => (log("papercuts:show", value), { status: "rejected", code: "not-found" }),
      dismiss: async (...value: unknown[]) => (log("papercuts:dismiss", value), { status: "rejected", code: "not-found" }),
    },
    conflicts: {
      list: async () => (log("conflicts:list"), { status: "ok", conflicts: [], truncated: false }),
      show: async (value: unknown) => (log("conflicts:show", value), { status: "rejected", code: "not-found" }),
      revalidate: async (value: unknown) => (log("conflicts:revalidate", value), { status: "rejected", code: "not-found" }),
      activate: async (...value: unknown[]) => (log("conflicts:activate", value), { status: "rejected", code: "not-found" }),
    },
    impact: { report: async (value: unknown) => (log("impact", value), { status: "rejected", reason: "metrics-absent" }) },
  } as unknown as ReadyServices;
  const options: HeadlessOperationsOptions = { runtime: async () => ready(), services: () => services };
  return { calls, services, options };
}

const execute = (request: HeadlessRequest, options: HeadlessOperationsOptions) =>
  executeHeadlessRequest(request, CWD, options);

describe("headless operation backend", () => {
  test("bootstrap commands are provider-free and preserve envelope exits", async () => {
    let runtimeCalls = 0;
    const options: HeadlessOperationsOptions = {
      runtime: async () => (runtimeCalls += 1, { status: "setup-needed", code: "setup-needed" }),
      status: async () => headlessPartial("limited", "limited", {}, []),
      config: async () => headlessOk("config", "config", {}),
      setup: async request => headlessOk("setup", "setup", { accepted: request.root === "/safe" }),
    };
    expect((await execute({ command: "help" }, options)).exitCode).toBe(0);
    expect((await execute({ command: "version" }, options)).exitCode).toBe(0);
    expect((await execute({ command: "status" }, options)).envelope.status).toBe("partial");
    expect((await execute({ command: "config" }, options)).envelope.code).toBe("config");
    expect((await execute({ command: "setup", root: "/safe", confirm: true }, options)).envelope.code).toBe("setup");
    expect(runtimeCalls).toBe(0);
  });

  test("runtime setup and degraded gates never construct services", async () => {
    let services = 0;
    const factory = () => { services += 1; throw new Error("must not run"); };
    expect(await execute({ command: "context" }, { runtime: async () => ({ status: "setup-needed", code: "setup-needed" }), services: factory })).toMatchObject({ exitCode: 2, envelope: { status: "setup-needed" } });
    expect(await execute({ command: "context" }, { runtime: async () => ({ status: "degraded", code: "unsafe-data-root" }), services: factory })).toMatchObject({ exitCode: 1, envelope: { status: "degraded" } });
    expect(services).toBe(0);
  });

  test("routes every local domain request with scoped arguments", async () => {
    const { calls, options } = fixture();
    const requests: HeadlessRequest[] = [
      { command: "context", scope: REPOSITORY }, { command: "review", target: "all" },
      { command: "proposals", action: "list", scope: REPOSITORY },
      { command: "proposals", action: "approve", scope: REPOSITORY, proposalId: PROPOSAL, kind: "fact", priority: 70, confirm: true },
      { command: "proposals", action: "dismiss", scope: REPOSITORY, proposalId: PROPOSAL, confirm: true },
      { command: "napkin", action: "list", scope: REPOSITORY }, { command: "napkin", action: "history", scope: REPOSITORY },
      { command: "papercuts", action: "list", scope: REPOSITORY }, { command: "papercuts", action: "show", scope: REPOSITORY, papercutId: CUT },
      { command: "papercuts", action: "dismiss", scope: REPOSITORY, papercutId: CUT, confirm: true }, { command: "impact" },
      { command: "conflicts", action: "list" }, { command: "conflicts", action: "show", conflictId: CONFLICT },
      { command: "conflicts", action: "revalidate", conflictId: CONFLICT },
      { command: "conflicts", action: "activate", conflictId: CONFLICT, revisionId: REVISION, confirm: true },
    ];
    for (const request of requests) await execute(request, options);
    expect(calls).toContain(`context:${JSON.stringify([REPOSITORY])}`);
    expect(calls).toContain(`proposals:approve:${JSON.stringify({ scope: REPOSITORY, proposalId: PROPOSAL, kind: "fact", priority: 70 })}`);
    expect(calls).toContain(`conflicts:activate:${JSON.stringify([CONFLICT, REVISION, true])}`);
    expect(calls).toContain(`impact:${JSON.stringify({ machineId: MACHINE.id, scopes: [GLOBAL, MACHINE, REPOSITORY] })}`);
  });

  test("routes coordination, publication, and repair families with exact requests", async () => {
    const { services, options } = fixture();
    const routed: string[] = [];
    options.coordination = async (_environment, request) => (routed.push(`coordination:${request.command}`), headlessOk("ok", "ok", {}));
    options.publication = async (actual, cwd, request) => {
      expect(actual).toBe(services.papercuts); expect(cwd).toBe(CWD); routed.push(`publication:${request.command}:${request.action}`);
      return request.action === "prepare" ? headlessChoiceRequired("confirm", "confirm", { repository: "owner/repo", account: "login" }, ["confirm"]) : headlessOk("ok", "ok", {});
    };
    options.repair = async (_environment, actual, napkins, cwd, request) => {
      expect(actual).toBe(services.papercuts); expect(napkins).toBe(services.napkins); expect(cwd).toBe(CWD); routed.push(`repair:${request.command}`); return headlessOk("ok", "ok", {});
    };
    const requests: HeadlessRequest[] = [
      { command: "transactions", action: "list" }, { command: "recover-lock", documentId: DOCUMENT, confirm: true }, { command: "clean-transaction", transactionId: TRANSACTION, confirm: true },
      { command: "publish", action: "prepare", scope: REPOSITORY, papercutId: CUT },
      { command: "publish", action: "commit", scope: REPOSITORY, papercutId: CUT, expectedRepository: "owner/repo", expectedAccount: "login", confirm: true },
      { command: "resubmit-publication", action: "prepare", scope: REPOSITORY, papercutId: CUT }, { command: "reconcile-publication", action: "prepare", scope: REPOSITORY, papercutId: CUT },
      { command: "repair", scope: REPOSITORY, papercutId: CUT, confirm: true }, { command: "resubmit-repair", scope: REPOSITORY, papercutId: CUT, confirm: true },
      { command: "reconcile-repair", scope: REPOSITORY, papercutId: CUT, state: "running", confirm: true }, { command: "verify", scope: REPOSITORY, papercutId: CUT, observed: "passed", confirm: true }, { command: "resolve", scope: REPOSITORY, papercutId: CUT, confirm: true },
    ];
    const responses = []; for (const request of requests) responses.push(await execute(request, options));
    expect(responses[3]?.envelope.status).toBe("choice-required");
    expect(routed).toHaveLength(requests.length);
    const count = routed.length;
    await execute({ command: "repair", scope: OTHER, papercutId: CUT, confirm: true }, options);
    await execute({ command: "publish", action: "prepare", scope: OTHER, papercutId: CUT }, options);
    expect(routed).toHaveLength(count);
  });

  test("migration requires exact IDs and confirmation before any effect", async () => {
    let effects = 0;
    const options: HeadlessOperationsOptions = {
      runtime: async () => migration(),
      migration: async (context, cwd) => {
        effects += 1; expect(context.fromRepositoryKey).toBe(REPOSITORY.id); expect(context.toRepositoryKey).toBe(OTHER.id); expect(cwd).toBe(CWD); return headlessOk("migrated", "migrated", {});
      },
    };
    const wrong = await execute({ command: "migrate", fromRepositoryId: OTHER.id, toRepositoryId: REPOSITORY.id, confirm: true }, options);
    const canceled = await execute({ command: "migrate", fromRepositoryId: REPOSITORY.id, toRepositoryId: OTHER.id, confirm: false } as unknown as HeadlessRequest, options);
    expect(wrong).toMatchObject({ exitCode: 1, envelope: { code: "repository-scope-mismatch" } });
    expect(canceled).toMatchObject({ exitCode: 2, envelope: { status: "choice-required" } }); expect(effects).toBe(0);
    expect((await execute({ command: "migrate", fromRepositoryId: REPOSITORY.id, toRepositoryId: OTHER.id, confirm: true }, options)).envelope.code).toBe("migrated");
    expect(effects).toBe(1); expect(JSON.stringify([wrong, canceled])).not.toContain("/private/data");
  });

  test("unexpected failures never leak paths, errors, or secrets", async () => {
    const { services, options } = fixture();
    services.context.resolve = async () => { throw Object.assign(new Error("token=secret /home/alice/customer"), { code: "not safe /home/alice" }); };
    const result = await execute({ command: "context" }, options);
    expect(result).toMatchObject({ exitCode: 1, envelope: { code: "operation-failed", data: {} } });
    expect(JSON.stringify(result)).not.toMatch(/secret|alice|customer|token|\/home\//);
  });
});
