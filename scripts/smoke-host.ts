import assert from "node:assert/strict";
import { registerClasi } from "../src/index.ts";
import {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "../src/runtime-types.ts";
import { CLASI_TOOL_NAMES } from "../src/tools.ts";
import { FakeExtensionHost } from "../test/support/fake-extension-host.ts";

const EXPECTED_EVENTS = [
  "context",
  "session_branch",
  "session_compact",
  "session_start",
  "session_switch",
  "session_tree",
  "turn_start",
] as const;
const EXPECTED_COMMANDS = ["clasi"] as const;

export interface HostSmokeResult {
  readonly checks: readonly [
    "exact_extension_registration",
    "bounded_context_injection",
    "provider_free",
  ];
}

export async function runHostSmoke(): Promise<HostSmokeResult> {
  const host = new FakeExtensionHost();
  const guidance = [
    "# clasi context",
    "",
    "## Operating contract",
    "- Keep this bounded guidance available without a model provider.",
  ].join("\n");
  const recordedLengths: number[] = [];
  registerClasi(host.api, createClasiRuntime({
    readContext: () => guidance,
    recordInjection: characters => { recordedLengths.push(characters); },
  }));

  assert.deepEqual([...host.events.keys()].sort(), [...EXPECTED_EVENTS]);
  assert.deepEqual([...host.commands.keys()].sort(), [...EXPECTED_COMMANDS]);
  assert.deepEqual([...host.messageRenderers].sort(), [CLASI_CONTEXT_MESSAGE_TYPE]);
  assert.deepEqual([...host.tools].sort(), [...CLASI_TOOL_NAMES].sort());
  assert.deepEqual([...host.toolDefinitions.keys()].sort(), [...CLASI_TOOL_NAMES].sort());

  const staleContext = {
    role: "custom",
    customType: CLASI_CONTEXT_MESSAGE_TYPE,
    content: "stale",
    display: false,
    timestamp: 0,
  };
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: "host smoke" }],
    timestamp: 1,
  };
  const result = await host.invokeContext([staleContext, userMessage]);
  assert(result && Array.isArray(result.messages));
  const contextMessages = result.messages.filter(message =>
    typeof message === "object" &&
    message !== null &&
    Reflect.get(message, "role") === "custom" &&
    Reflect.get(message, "customType") === CLASI_CONTEXT_MESSAGE_TYPE
  );
  assert.equal(contextMessages.length, 1);
  assert.equal(Reflect.get(contextMessages[0]!, "content"), guidance);
  assert(guidance.length <= CLASI_CONTEXT_MAX_CHARACTERS);
  assert.deepEqual(recordedLengths, [guidance.length]);
  assert.equal(result.messages.includes(staleContext as never), false);
  assert.equal(result.messages.includes(userMessage as never), true);

  return {
    checks: [
      "exact_extension_registration",
      "bounded_context_injection",
      "provider_free",
    ],
  };
}

if (import.meta.main) {
  await runHostSmoke();
  console.log("smoke-host: passed");
}
