import { isAbsolute, join, normalize } from "node:path";

export const DEFAULT_NAPKIN_CATEGORY_CAP = 5;
export const DEFAULT_CONTEXT_CHARACTER_CAP = 6_000;
const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_PROFILE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

export interface ClasiConfig {
  dataRoot: string;
  napkinCategoryCap?: number;
  contextCharacterCap?: number;
}

export interface ResolvedClasiConfig {
  dataRoot: string;
  napkinCategoryCap: number;
  contextCharacterCap: number;
}

export interface ClasiRoots {
  controlRoot: string;
  dataRoot: string;
}

export interface ResolveRootsOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<ClasiConfig>;
}

export class ConfigError extends Error {
  constructor(readonly code: "setup-needed" | "invalid-config", message: string = code) {
    super(message);
    this.name = "ConfigError";
  }
}
export function resolveClasiAgentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new ConfigError("invalid-config", "HOME is required");
  if (env.PI_CODING_AGENT_DIR) return normalizeAbsolute(env.PI_CODING_AGENT_DIR, home);
  const profile = resolveOmpProfile(env);
  return normalizeAbsolute(join(
    home,
    env.PI_CONFIG_DIR || ".omp",
    ...(profile ? ["profiles", profile] : []),
    "agent",
  ), home);
}

export function resolveClasiRoots(options: ResolveRootsOptions = {}): ClasiRoots {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new ConfigError("invalid-config", "HOME is required");
  const agentRoot = resolveClasiAgentRoot(env);

  const configuredDataRoot = env.CLASI_HOME || options.config?.dataRoot;
  if (!configuredDataRoot) throw new ConfigError("setup-needed");

  return {
    controlRoot: normalizeAbsolute(join(agentRoot, "clasi"), home),
    dataRoot: normalizeAbsolute(configuredDataRoot, home),
  };
}

function resolveOmpProfile(env: NodeJS.ProcessEnv): string | undefined {
  const value = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
  if (!value || value === "default") return undefined;
  if (
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    !OMP_PROFILE_NAME.test(value) ||
    WINDOWS_RESERVED_PROFILE.test(value)
  ) {
    throw new ConfigError("invalid-config", "Invalid OMP profile");
  }
  return value;
}

export function resolveClasiConfig(config: ClasiConfig, home: string): ResolvedClasiConfig {
  const napkinCategoryCap = config.napkinCategoryCap ?? DEFAULT_NAPKIN_CATEGORY_CAP;
  const contextCharacterCap = config.contextCharacterCap ?? DEFAULT_CONTEXT_CHARACTER_CAP;
  if (!Number.isInteger(napkinCategoryCap) || napkinCategoryCap < 1 || napkinCategoryCap > 20) {
    throw new ConfigError("invalid-config", "Napkin category cap must be between 1 and 20");
  }
  if (
    !Number.isInteger(contextCharacterCap) ||
    contextCharacterCap < 500 ||
    contextCharacterCap > DEFAULT_CONTEXT_CHARACTER_CAP
  ) {
    throw new ConfigError("invalid-config", "Context character cap must be between 500 and 6000");
  }

  return {
    dataRoot: normalizeAbsolute(config.dataRoot, home),
    napkinCategoryCap,
    contextCharacterCap,
  };
}

export function collapseHomePath(value: string, home: string): string {
  const normalizedValue = normalize(value);
  const normalizedHome = normalize(home);
  if (normalizedValue === normalizedHome) return "${HOME}";
  const prefix = `${normalizedHome}${process.platform === "win32" ? "\\" : "/"}`;
  return normalizedValue.startsWith(prefix)
    ? `\${HOME}${process.platform === "win32" ? "\\" : "/"}${normalizedValue.slice(prefix.length)}`
    : normalizedValue;
}

function normalizeAbsolute(value: string, home: string): string {
  const expanded = value === "~" || value === "${HOME}"
    ? home
    : value.startsWith("~/")
      ? join(home, value.slice(2))
      : value.startsWith("${HOME}/")
        ? join(home, value.slice(8))
        : value;
  const normalized = normalize(expanded);
  if (!isAbsolute(normalized)) {
    throw new ConfigError("invalid-config", "clasi roots must be absolute");
  }
  return normalized;
}
