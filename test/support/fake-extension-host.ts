import type {
  ContextEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

export type EventHandler = (event: unknown, context: ExtensionContext) => unknown;
export type CommandHandler = (args: string, context: ExtensionContext) => unknown;

export class FakeExtensionHost {
  readonly commands = new Map<string, CommandHandler>();
  readonly events = new Map<string, EventHandler>();
  readonly messageRenderers = new Set<string>();
  readonly tools = new Set<string>();

  readonly api = {
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
    },
  } as unknown as ExtensionAPI;

  async invokeContext(messages: unknown[]): Promise<ContextEventResult | undefined> {
    const handler = this.events.get("context");
    if (!handler) throw new Error("No context handler registered");
    return (await handler(
      { type: "context", messages },
      createFakeExtensionContext(false),
    )) as ContextEventResult | undefined;
  }

  async invokeCommand(name: string, args: string, hasUI: boolean): Promise<void> {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    await handler(args, createFakeExtensionContext(hasUI));
  }

  private addUnique<T>(target: Map<string, T>, name: string, value: T): void {
    if (target.has(name)) throw new Error(`Duplicate registration: ${name}`);
    target.set(name, value);
  }
}

export function createFakeExtensionContext(hasUI: boolean): ExtensionContext {
  return {
    hasUI,
    ui: {
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}
