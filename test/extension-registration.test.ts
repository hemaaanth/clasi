import { describe, expect, test } from "bun:test";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import registerClasi, {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "../src/index.ts";
import { runClasiCli } from "../src/cli.ts";
import { runJsonCommand } from "../src/exec.ts";
import type { JsonCommandResult } from "../src/exec.ts";
import { CLASI_VERSION } from "../src/runtime-types.ts";
import { FakeProcessAdapter, exited } from "./support/fake-exec.ts";
import { FakeExtensionHost } from "./support/fake-extension-host.ts";

describe("public package contract", () => {
  test("declares one extension, one executable, and the supported peer range", async () => {
    const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();

    expect(manifest.name).toBe("clasi");
    expect(manifest.version).toBe(CLASI_VERSION);
    expect(manifest.omp.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.bin).toEqual({ clasi: "./bin/clasi.ts" });
    expect(manifest.peerDependencies).toEqual({
      "@oh-my-pi/pi-coding-agent": ">=17.2.4 <18",
    });
    expect(manifest.dependencies).toBeUndefined();
  });

  test("imports entry modules without starting domain work", async () => {
    // Dynamic import is intentional: this test exercises the module-load boundary.
    const extension = await import("../src/index.ts");
    const executable = await import("../bin/clasi.ts");

    expect(extension.default).toBeFunction();
    expect(executable.main).toBeFunction();
  });
});

describe("extension registration", () => {
  test("registers the clasi command, context hook, and message renderer once", () => {
    const host = new FakeExtensionHost();

    registerClasi(host.api);

    expect([...host.commands.keys()]).toEqual(["clasi"]);
    expect([...host.events.keys()]).toEqual(["context"]);
    expect([...host.messageRenderers]).toEqual([CLASI_CONTEXT_MESSAGE_TYPE]);
    expect([...host.tools]).toEqual([]);
    expect(host.commands.has("memory")).toBeFalse();
  });

  test("duplicate registration fails visibly", () => {
    const host = new FakeExtensionHost();
    registerClasi(host.api);

    expect(() => registerClasi(host.api)).toThrow("Duplicate");
  });

  test("replaces an older clasi message with one bounded current message", async () => {
    const host = new FakeExtensionHost();
    const runtime = createClasiRuntime({
      readContext: () => "x".repeat(CLASI_CONTEXT_MAX_CHARACTERS + 100),
    });
    registerClasi(host.api, runtime);

    const result = await host.invokeContext([
      {
        role: "custom",
        customType: CLASI_CONTEXT_MESSAGE_TYPE,
        content: "stale",
        display: false,
        timestamp: 0,
      },
      { role: "user", content: "keep", timestamp: 0 },
    ]);
    const messages = result?.messages ?? [];
    const clasiMessages = messages.filter(isClasiMessage);

    expect(clasiMessages).toHaveLength(1);
    expect(clasiMessages[0]?.content).toHaveLength(CLASI_CONTEXT_MAX_CHARACTERS);
    expect(clasiMessages[0]?.display).toBeFalse();
    expect(messages[1]).toEqual({ role: "user", content: "keep", timestamp: 0 });
  });

  test("constructs command contexts with and without interactive UI", async () => {
    const host = new FakeExtensionHost();
    const observed: boolean[] = [];
    const runtime = createClasiRuntime({
      handleCommand: (_args, context) => {
        observed.push(context.hasUI);
      },
    });
    registerClasi(host.api, runtime);

    await host.invokeCommand("clasi", "status", true);
    await host.invokeCommand("clasi", "status", false);

    expect(observed).toEqual([true, false]);
  });
});

describe("provider-free CLI contract", () => {
  test("emits one JSON envelope for version requests", async () => {
    const lines: string[] = [];

    const exitCode = await runClasiCli(["--version"], line => lines.push(line));

    expect(exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      schema_version: 1,
      status: "ok",
      code: "version",
      message: "clasi 0.1.0",
      data: { version: "0.1.0" },
      next_actions: [],
    });
  });
});

describe("bounded JSON process execution", () => {
  test("passes an argument array and parses successful JSON", async () => {
    const adapter = new FakeProcessAdapter(exited('{"owner":"S-1-5-21"}'));

    const result = await runJsonCommand("pwsh", ["-NoProfile", "-Command", "Get-Acl"], {
      adapter: adapter.run,
      env: { CLASI_TEST: "1" },
    });

    expect(result).toEqual({ ok: true, value: { owner: "S-1-5-21" } });
    expect(adapter.calls).toEqual([
      {
        command: "pwsh",
        args: ["-NoProfile", "-Command", "Get-Acl"],
        cwd: undefined,
        env: { CLASI_TEST: "1" },
        maxOutputBytes: 65_536,
        timeoutMs: 10_000,
      },
    ]);
  });

  test("reports spawn failure, timeout, malformed JSON, and oversized output", async () => {
    const adapter = new FakeProcessAdapter(
      { status: "spawn-failed", message: "ENOENT" },
      { status: "timed-out" },
      exited("not json"),
      exited(`"${"x".repeat(100)}"`),
    );

    assertFailure(
      await runJsonCommand("missing", [], { adapter: adapter.run }),
      "spawn-failed",
    );
    assertFailure(await runJsonCommand("slow", [], { adapter: adapter.run }), "timeout");
    assertFailure(
      await runJsonCommand("bad", [], { adapter: adapter.run }),
      "malformed-json",
    );
    assertFailure(
      await runJsonCommand("loud", [], { adapter: adapter.run, maxOutputBytes: 32 }),
      "output-too-large",
    );
  });
});

function assertFailure(
  result: JsonCommandResult,
  code: Exclude<JsonCommandResult, { ok: true }>["code"],
): void {
  expect(result.ok).toBeFalse();
  if (result.ok) throw new Error(`Expected ${code}, received success`);
  expect(result.code).toBe(code);
}

function isClasiMessage(
  value: unknown,
): value is CustomMessage & { content: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "custom" &&
    "customType" in value &&
    value.customType === CLASI_CONTEXT_MESSAGE_TYPE &&
    "content" in value &&
    typeof value.content === "string" &&
    "display" in value &&
    typeof value.display === "boolean"
  );
}
