import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { injectClasiContext } from "./context-injection.ts";
import { createDefaultPapercutActionHandler } from "./interactive-actions.ts";
import { createConfiguredClasiRuntime } from "./runtime.ts";
import {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "./runtime-types.ts";
import type { ClasiRefreshResult, ClasiRuntime } from "./runtime-types.ts";
import { registerClasiTools } from "./tools.ts";

export {
  CLASI_CONTEXT_MAX_CHARACTERS,
  CLASI_CONTEXT_MESSAGE_TYPE,
  createClasiRuntime,
} from "./runtime-types.ts";
export type { ClasiRefreshResult, ClasiRuntime } from "./runtime-types.ts";

const EMPTY_CONTEXT_RUNTIME = {
  readContext: () => undefined,
  recordInjection: () => undefined,
};

export function registerClasi(
  pi: ExtensionAPI,
  runtime: ClasiRuntime = createConfiguredClasiRuntime({
    commandOptions: {
      createPapercutActions: environment => createDefaultPapercutActionHandler({
        environment,
        sendFollowUp: (message, options) => pi.sendUserMessage(message, options),
      }),
    },
  }),
): void {
  let injectionEnabled = true;
  const notifications = new BlockerNotifications();

  pi.registerMessageRenderer(CLASI_CONTEXT_MESSAGE_TYPE, () => undefined);

  pi.registerCommand("clasi", {
    description: "Review and configure clasi guidance",
    handler: async (args, context) => {
      await runtime.handleCommand(args.trim(), context);
    },
  });

  registerClasiTools(pi, runtime);

  pi.on("context", async event => ({
    messages: await injectClasiContext(
      event.messages,
      injectionEnabled ? runtime : EMPTY_CONTEXT_RUNTIME,
      CLASI_CONTEXT_MAX_CHARACTERS,
    ),
  }));

  const refresh = async (context: ExtensionContext, resetInMemorySession = false): Promise<void> => {
    let result: ClasiRefreshResult;
    try {
      result = await runtime.refresh(context.cwd);
      injectionEnabled = true;
    } catch {
      injectionEnabled = false;
      return;
    }
    if (result.status === "ready" || result.notify !== true) return;
    try {
      notifications.notify(context, result, resetInMemorySession);
    } catch {
      // UI failures never block the active coding session.
    }
  };

  pi.on("session_start", async (_event, context) => refresh(context, true));
  pi.on("turn_start", async (_event, context) => refresh(context));
  pi.on("session_switch", async (_event, context) => refresh(context, true));
  pi.on("session_branch", async (_event, context) => refresh(context, true));
  pi.on("session_tree", async (_event, context) => refresh(context));
  pi.on("session_compact", async (_event, context) => refresh(context));
}

class BlockerNotifications {
  readonly #bySessionFile = new Map<string, Set<string>>();
  readonly #inMemory = new WeakMap<object, Set<string>>();

  notify(
    context: ExtensionContext,
    result: Exclude<ClasiRefreshResult, { status: "ready" }>,
    resetInMemorySession: boolean,
  ): void {
    const code = result.code ?? result.status;
    const seen = this.#seenCodes(context, resetInMemorySession);
    if (seen.has(code)) return;
    seen.add(code);
    context.ui.notify(
      result.status === "setup-needed"
        ? "clasi setup is required. Run /clasi setup."
        : "clasi is degraded. Run /clasi doctor.",
      "warning",
    );
  }

  #seenCodes(context: ExtensionContext, resetInMemorySession: boolean): Set<string> {
    const sessionFile = context.sessionManager.getSessionFile();
    if (sessionFile) {
      const existing = this.#bySessionFile.get(sessionFile);
      if (existing) return existing;
      const created = new Set<string>();
      this.#bySessionFile.set(sessionFile, created);
      return created;
    }
    if (resetInMemorySession) this.#inMemory.delete(context.sessionManager);
    const existing = this.#inMemory.get(context.sessionManager);
    if (existing) return existing;
    const created = new Set<string>();
    this.#inMemory.set(context.sessionManager, created);
    return created;
  }
}

export default registerClasi;
