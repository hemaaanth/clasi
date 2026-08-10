import type { CustomMessage } from "@oh-my-pi/pi-coding-agent";
import {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
} from "./runtime-types.ts";
import type { ClasiRuntime } from "./runtime-types.ts";

export type ContextInjectionRuntime = Pick<ClasiRuntime, "readContext" | "recordInjection">;

export async function injectClasiContext<T>(
  messages: readonly T[],
  runtime: ContextInjectionRuntime,
  maximumCharacters = CLASI_CONTEXT_MAX_CHARACTERS,
): Promise<Array<T | CustomMessage>> {
  const retained = messages.filter(message => !isClasiContextMessage(message));
  let content: unknown;
  try {
    content = await runtime.readContext();
  } catch {
    return retained;
  }
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    !Number.isSafeInteger(maximumCharacters) ||
    maximumCharacters < 1 ||
    content.length > maximumCharacters
  ) {
    return retained;
  }

  try {
    await runtime.recordInjection(content.length);
  } catch {
    // Measurement failures never withhold already validated guidance.
  }
  return [
    {
      role: "custom",
      customType: CLASI_CONTEXT_MESSAGE_TYPE,
      content,
      display: false,
      timestamp: 0,
    },
    ...retained,
  ];
}

export function isClasiContextMessage(value: unknown): boolean {
  return typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "role") === "custom" &&
    Reflect.get(value, "customType") === CLASI_CONTEXT_MESSAGE_TYPE;
}
