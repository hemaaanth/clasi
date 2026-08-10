import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const CLASI_VERSION = "0.1.0";
export const CLASI_CONTEXT_MESSAGE_TYPE = "clasi-context";
export const CLASI_CONTEXT_MAX_CHARACTERS = 6_000;

export type ClasiRefreshResult = {
  status: "ready" | "setup-needed" | "degraded";
  code?: string;
  notify?: boolean;
};

export interface ClasiRuntime {
  refresh(cwd: string): Promise<ClasiRefreshResult>;
  readContext(): Promise<string | undefined> | string | undefined;
  recordInjection(characters: number): Promise<void> | void;
  handleCommand(args: string, context: ExtensionContext): Promise<void> | void;
  handleTool(name: string, params: unknown, context: ExtensionContext): Promise<unknown> | unknown;
}

export type ClasiRuntimeOverrides = Partial<ClasiRuntime>;

export function createClasiRuntime(overrides: ClasiRuntimeOverrides = {}): ClasiRuntime {
  return {
    refresh: overrides.refresh ?? (async () => ({ status: "ready" })),
    readContext: overrides.readContext ?? (() => undefined),
    recordInjection: overrides.recordInjection ?? (() => undefined),
    handleCommand: overrides.handleCommand ?? (() => undefined),
    handleTool:
      overrides.handleTool ??
      (() => ({ status: "rejected", code: "runtime-unavailable" })),
  };
}
