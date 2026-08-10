import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const CLASI_VERSION = "0.1.0";
export const CLASI_CONTEXT_MESSAGE_TYPE = "clasi-context";
export const CLASI_CONTEXT_MAX_CHARACTERS = 6_000;

export interface ClasiRuntime {
  readContext(): Promise<string | undefined> | string | undefined;
  handleCommand(args: string, context: ExtensionContext): Promise<void> | void;
}

export type ClasiRuntimeOverrides = Partial<ClasiRuntime>;

export function createClasiRuntime(overrides: ClasiRuntimeOverrides = {}): ClasiRuntime {
  return {
    readContext: overrides.readContext ?? (() => undefined),
    handleCommand:
      overrides.handleCommand ??
      ((_args, context) => {
        context.ui.notify("clasi is installed. Run /clasi setup to configure it.", "info");
      }),
  };
}
