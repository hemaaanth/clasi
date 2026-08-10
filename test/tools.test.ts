import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as zod from "zod/v4";
import {
  CLASI_TOOL_NAMES,
  registerClasiTools,
} from "../src/tools.ts";
import type {
  ClasiToolName,
  ClasiToolOutcome,
  ClasiToolRuntime,
} from "../src/tools.ts";

const OPAQUE_NAPKIN_ID = `napkin_${"0".repeat(32)}`;
const OPAQUE_PAPERCUT_ID = `cut_${"0".repeat(32)}`;

type RegisteredTool = {
  name: string;
  approval?: string;
  loadMode?: string;
  parameters: { safeParse(value: unknown): { success: boolean } };
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
};

class ToolHost {
  readonly tools = new Map<string, RegisteredTool>();
  readonly api = {
    zod,
    registerTool: (tool: RegisteredTool) => {
      if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  get(name: ClasiToolName): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`missing tool: ${name}`);
    return tool;
  }
}

class Runtime implements ClasiToolRuntime {
  readonly calls: Array<{
    name: ClasiToolName;
    params: Readonly<Record<string, unknown>>;
    context: ExtensionContext;
  }> = [];
  readonly refreshCalls: string[] = [];
  outcomes: ClasiToolOutcome[] = [{ status: "ok" }];

  handleTool(name: string, params: unknown, context: ExtensionContext): unknown {
    this.calls.push({
      name: name as ClasiToolName,
      params: params as Readonly<Record<string, unknown>>,
      context,
    });
    return this.outcomes.shift() ?? { status: "ok" };
  }

  async refresh(cwd: string): Promise<{ status: "ready" }> {
    this.refreshCalls.push(cwd);
    return { status: "ready" };
  }
}

describe("clasi tool registry", () => {
  test("registers exactly eight discoverable tools with read and write approvals", () => {
    const host = new ToolHost();
    registerClasiTools(host.api, new Runtime());

    expect([...host.tools.keys()]).toEqual([...CLASI_TOOL_NAMES]);
    expect([...host.tools.values()].map(tool => [tool.name, tool.approval])).toEqual([
      ["clasi_get_context", "read"],
      ["clasi_propose_context", "write"],
      ["clasi_get_napkin", "read"],
      ["clasi_curate_napkin", "write"],
      ["clasi_mark_hit", "write"],
      ["clasi_get_papercuts", "read"],
      ["clasi_capture_papercut", "write"],
      ["clasi_update_repair", "write"],
    ]);
    expect([...host.tools.values()].every(tool => tool.loadMode === "discoverable")).toBe(true);
    expect([...host.tools.keys()].filter(name => name.includes("memory"))).toEqual([]);
  });

  test("strict schemas accept only bounded generalized inputs and safe enums", () => {
    const host = new ToolHost();
    registerClasiTools(host.api, new Runtime());
    const inputs = validInputs();

    for (const name of CLASI_TOOL_NAMES) {
      const schema = host.get(name).parameters;
      expect(schema.safeParse(inputs[name]).success).toBe(true);
      expect(schema.safeParse({ ...inputs[name], prompt: "raw prompt" }).success).toBe(false);
      expect(schema.safeParse({ ...inputs[name], evidence: "raw evidence" }).success).toBe(false);
      expect(schema.safeParse({ ...inputs[name], path: "/home/alice/project" }).success).toBe(false);
      expect(schema.safeParse({ ...inputs[name], approval: true }).success).toBe(false);
      expect(schema.safeParse({ ...inputs[name], publication: "pending" }).success).toBe(false);
    }

    const propose = host.get("clasi_propose_context").parameters;
    expect(propose.safeParse({ ...inputs.clasi_propose_context, value: "x".repeat(241) }).success)
      .toBe(false);
    expect(propose.safeParse({
      ...inputs.clasi_propose_context,
      sourceClassification: "prompt",
    }).success).toBe(false);
    expect(propose.safeParse({
      ...inputs.clasi_propose_context,
      scope: "machine",
      scopeId: `repo_${"0".repeat(32)}`,
    }).success).toBe(false);

    const curate = host.get("clasi_curate_napkin").parameters;
    expect(curate.safeParse({ ...inputs.clasi_curate_napkin, situation: "x".repeat(241) }).success)
      .toBe(false);
    expect(curate.safeParse({
      ...inputs.clasi_curate_napkin,
      sourceClassification: "terminal-output",
    }).success).toBe(false);

    const capture = host.get("clasi_capture_papercut").parameters;
    expect(capture.safeParse({ ...inputs.clasi_capture_papercut, summary: "x".repeat(241) }).success)
      .toBe(false);
    expect(capture.safeParse({
      ...inputs.clasi_capture_papercut,
      sourceClassification: "environment-dump",
    }).success).toBe(false);

    const repair = host.get("clasi_update_repair").parameters;
    for (const forbidden of ["none", "queued", "dispatched", "verified"]) {
      expect(repair.safeParse({ ...inputs.clasi_update_repair, repairState: forbidden }).success)
        .toBe(false);
    }
  });

  test("execute dispatches the exact name and params and returns one safe JSON text block", async () => {
    const host = new ToolHost();
    const runtime = new Runtime();
    runtime.outcomes = [{ status: "ok", records: [] }];
    registerClasiTools(host.api, runtime);
    const notifications: unknown[][] = [];
    const context = fakeContext(notifications);
    const params = { scope: "global" };

    const result = await host.get("clasi_get_context").execute(
      "call-1",
      params,
      undefined,
      undefined,
      context,
    );

    expect(runtime.calls).toEqual([{ name: "clasi_get_context", params, context }]);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual({ status: "ok", records: [] });
    expect(result.details).toEqual({ status: "ok" });
    expect(runtime.refreshCalls).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test("the registrar never refreshes or notifies; runtime owns durable-mutation refresh", async () => {
    const host = new ToolHost();
    const runtime = new Runtime();
    runtime.outcomes = [
      { status: "proposed" },
      { status: "rejected", code: "path-bearing" },
      { status: "candidates", candidateIds: [OPAQUE_NAPKIN_ID] },
      { status: "recorded", changed: true },
      { status: "unchanged", changed: false },
    ];
    registerClasiTools(host.api, runtime);
    const notifications: unknown[][] = [];
    const context = fakeContext(notifications);
    const inputs = validInputs();
    const calls: ClasiToolName[] = [
      "clasi_propose_context",
      "clasi_capture_papercut",
      "clasi_curate_napkin",
      "clasi_mark_hit",
      "clasi_update_repair",
    ];

    const results = [];
    for (const name of calls) {
      results.push(await host.get(name).execute("call", inputs[name], undefined, undefined, context));
    }

    expect(runtime.calls.map(call => call.name)).toEqual(calls);
    expect(runtime.refreshCalls).toEqual([]);
    expect(results[1]?.details).toEqual({ status: "rejected", reason: "path-bearing" });
    expect(results[1]?.isError).toBe(true);
    expect(results.every(result => result.content.length === 1)).toBe(true);
    expect(notifications).toEqual([]);
  });
});

function validInputs(): Record<ClasiToolName, Record<string, unknown>> {
  return {
    clasi_get_context: { scope: "global" },
    clasi_propose_context: {
      scope: "global",
      logicalKey: "coding.package-manager",
      kind: "preference",
      value: "Prefer Bun for package operations.",
      sourceClassification: "explicit-user-input",
      priority: 80,
    },
    clasi_get_napkin: { scope: "global" },
    clasi_curate_napkin: {
      scope: "global",
      logicalKey: "validation.focused-tests",
      category: "Validation",
      priority: 80,
      situation: "A focused check catches a local regression.",
      action: "Run the focused check after changing the behavior.",
      sourceClassification: "generalized-derived",
    },
    clasi_mark_hit: { scope: "global", id: OPAQUE_NAPKIN_ID },
    clasi_get_papercuts: { scope: "global" },
    clasi_capture_papercut: {
      scope: "global",
      fingerprint: "validation.missing-focused-check",
      summary: "A changed behavior lacks a focused check.",
      severity: "minor",
      prevention: "Add a focused check for the changed behavior.",
      acceptanceCondition: "The focused check passes.",
      sourceClassification: "generalized-derived",
    },
    clasi_update_repair: {
      scope: "global",
      id: OPAQUE_PAPERCUT_ID,
      repairState: "running",
    },
  };
}

function fakeContext(notifications: unknown[][]): ExtensionContext {
  return {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      notify: (...args: unknown[]) => {
        notifications.push(args);
      },
    },
  } as unknown as ExtensionContext;
}
