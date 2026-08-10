import type {
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import * as zod from "zod/v4";

export type EventHandler = (event: unknown, context: ExtensionContext) => unknown;
export type CommandHandler = (args: string, context: ExtensionContext) => unknown;

export interface FakeExtensionContextOptions {
  cwd?: string;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  sessionManager?: object;
}

export class FakeExtensionHost {
  readonly commands = new Map<string, CommandHandler>();
  readonly events = new Map<string, EventHandler>();
  readonly messageRenderers = new Set<string>();
  readonly tools = new Set<string>();
  readonly toolDefinitions = new Map<string, unknown>();
  readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  cwd = "/workspace";
  sessionFile = "/sessions/fake-session.jsonl";
  readonly #sessionManager = {
    getSessionFile: () => this.sessionFile,
  };

  readonly api = {
    zod,
    on: (name: string, handler: EventHandler) => this.addUnique(this.events, name, handler),
    registerCommand: (name: string, options: { handler: CommandHandler }) =>
      this.addUnique(this.commands, name, options.handler),
    registerMessageRenderer: (name: string) => {
      if (this.messageRenderers.has(name)) throw new Error(`Duplicate message renderer: ${name}`);
      this.messageRenderers.add(name);
    },
    registerTool: (tool: { name: string }) => {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.tools.add(tool.name);
      this.toolDefinitions.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  async invokeContext(messages: unknown[]): Promise<ContextEventResult | undefined> {
    const handler = this.events.get("context");
    if (!handler) throw new Error("No context handler registered");
    return (await handler(
      { type: "context", messages },
      this.#context(false),
    )) as ContextEventResult | undefined;
  }

  async invokeEvent(name: string, event: object = { type: name }): Promise<void> {
    const handler = this.events.get(name);
    if (!handler) throw new Error(`No ${name} handler registered`);
    await handler(event, this.#context(true));
  }

  async invokeCommand(name: string, args: string, hasUI: boolean): Promise<void> {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    await handler(args, this.#context(hasUI));
  }

  private addUnique<T>(target: Map<string, T>, name: string, value: T): void {
    if (target.has(name)) throw new Error(`Duplicate registration: ${name}`);
    target.set(name, value);
  }

  #context(hasUI: boolean): ExtensionContext {
    return createFakeExtensionContext(hasUI, {
      cwd: this.cwd,
      sessionManager: this.#sessionManager,
      notify: (message, type) => this.notifications.push({
        message,
        ...(type === undefined ? {} : { type }),
      }),
    });
  }
}

export function createFakeExtensionContext(
  hasUI: boolean,
  options: FakeExtensionContextOptions = {},
): ExtensionContext {
  return {
    hasUI,
    cwd: options.cwd ?? "/workspace",
    sessionManager: options.sessionManager ?? { getSessionFile: () => "/sessions/fake-session.jsonl" },
    ui: {
      notify: options.notify ?? (() => undefined),
    },
  } as unknown as ExtensionContext;
}
