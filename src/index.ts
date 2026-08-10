import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "./runtime-types.ts";
import type { ClasiRuntime } from "./runtime-types.ts";

export {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "./runtime-types.ts";
export type { ClasiRuntime } from "./runtime-types.ts";

export function registerClasi(
  pi: ExtensionAPI,
  runtime: ClasiRuntime = createClasiRuntime(),
): void {
  pi.registerMessageRenderer(CLASI_CONTEXT_MESSAGE_TYPE, () => undefined);

  pi.registerCommand("clasi", {
    description: "Review and configure clasi guidance",
    handler: async (args, context) => {
      await runtime.handleCommand(args.trim(), context);
    },
  });

  pi.on("context", async event => {
    const messages = event.messages.filter(
      message =>
        !(message.role === "custom" && message.customType === CLASI_CONTEXT_MESSAGE_TYPE),
    );
    const current = await runtime.readContext();
    if (!current) return { messages };

    return {
      messages: [
        {
          role: "custom",
          customType: CLASI_CONTEXT_MESSAGE_TYPE,
          content: current.slice(0, CLASI_CONTEXT_MAX_CHARACTERS),
          display: false,
          timestamp: 0,
        },
        ...messages,
      ],
    };
  });
}

export default registerClasi;
