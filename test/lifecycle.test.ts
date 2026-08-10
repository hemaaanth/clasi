import { describe, expect, test } from "bun:test";
import registerClasi, {
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "../src/index.ts";
import { CLASI_TOOL_NAMES } from "../src/tools.ts";
import { FakeExtensionHost } from "./support/fake-extension-host.ts";

const LIFECYCLE_EVENTS = [
  "session_start",
  "turn_start",
  "session_switch",
  "session_branch",
  "session_tree",
  "session_compact",
] as const;

describe("extension lifecycle", () => {
  test("registers the exact command, tool, message, context, and refresh event surface", () => {
    const host = new FakeExtensionHost();
    registerClasi(host.api, createClasiRuntime());

    expect([...host.commands.keys()]).toEqual(["clasi"]);
    expect([...host.messageRenderers]).toEqual([CLASI_CONTEXT_MESSAGE_TYPE]);
    expect([...host.tools]).toEqual([...CLASI_TOOL_NAMES]);
    expect([...host.events.keys()]).toEqual(["context", ...LIFECYCLE_EVENTS]);
    expect(host.commands.has("memory")).toBeFalse();
  });

  test("startup, turns, resume, fork, tree navigation, and compaction refresh the current cwd", async () => {
    const host = new FakeExtensionHost();
    const calls: string[] = [];
    const runtime = createClasiRuntime({
      refresh: async cwd => {
        calls.push(cwd);
        return { status: "ready" };
      },
    });
    registerClasi(host.api, runtime);

    for (const [index, event] of LIFECYCLE_EVENTS.entries()) {
      host.cwd = `/workspace-${index}`;
      await host.invokeEvent(event);
    }

    expect(calls).toEqual(LIFECYCLE_EVENTS.map((_event, index) => `/workspace-${index}`));
    expect(host.notifications).toEqual([]);
  });

  test("repeated model requests receive one current message and one exact measurement each", async () => {
    const host = new FakeExtensionHost();
    let content = "first context";
    const measurements: number[] = [];
    registerClasi(host.api, createClasiRuntime({
      readContext: () => content,
      recordInjection: characters => {
        measurements.push(characters);
      },
    }));

    const first = await host.invokeContext([staleMessage(), userMessage()]);
    content = "retry context";
    const retry = await host.invokeContext(first?.messages ?? []);

    expect(clasiMessages(first?.messages ?? []).map(message => message.content)).toEqual(["first context"]);
    expect(clasiMessages(retry?.messages ?? []).map(message => message.content)).toEqual(["retry context"]);
    expect(measurements).toEqual(["first context".length, "retry context".length]);
  });

  test("refresh errors omit stale context without blocking and a later refresh restores injection", async () => {
    const host = new FakeExtensionHost();
    let fail = false;
    registerClasi(host.api, createClasiRuntime({
      refresh: async () => {
        if (fail) throw new Error("refresh failed");
        return { status: "ready" };
      },
      readContext: () => "safe current context",
    }));

    await host.invokeEvent("session_start");
    expect(clasiMessages((await host.invokeContext([userMessage()]))?.messages ?? [])).toHaveLength(1);

    fail = true;
    await expect(host.invokeEvent("turn_start")).resolves.toBeUndefined();
    const omitted = await host.invokeContext([staleMessage(), userMessage()]);
    expect(clasiMessages(omitted?.messages ?? [])).toHaveLength(0);
    expect(omitted?.messages).toEqual([userMessage()]);

    fail = false;
    await host.invokeEvent("session_tree");
    expect(clasiMessages((await host.invokeContext([userMessage()]))?.messages ?? [])).toHaveLength(1);
  });

  test("one actionable notification is emitted per session and blocker code", async () => {
    const host = new FakeExtensionHost();
    let code = "root-unavailable";
    let status: "ready" | "degraded" = "degraded";
    registerClasi(host.api, createClasiRuntime({
      refresh: async () => ({ status, code, notify: status !== "ready" }),
    }));

    for (const event of LIFECYCLE_EVENTS) await host.invokeEvent(event);
    expect(host.notifications).toEqual([{
      message: "clasi is degraded. Run /clasi doctor.",
      type: "warning",
    }]);

    code = "document-invalid";
    await host.invokeEvent("turn_start");
    expect(host.notifications).toHaveLength(2);

    status = "ready";
    await host.invokeEvent("turn_start");
    expect(host.notifications).toHaveLength(2);
  });
});

function staleMessage() {
  return {
    role: "custom",
    customType: CLASI_CONTEXT_MESSAGE_TYPE,
    content: "stale",
    display: false,
    timestamp: 0,
  } as const;
}

function userMessage() {
  return { role: "user", content: "keep", timestamp: 0 } as const;
}

function clasiMessages(messages: readonly unknown[]): Array<{ content: unknown }> {
  return messages.filter((message): message is { content: unknown } =>
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "role") === "custom" &&
    Reflect.get(message, "customType") === CLASI_CONTEXT_MESSAGE_TYPE);
}
