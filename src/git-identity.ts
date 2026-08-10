import { createHash } from "node:crypto";
import { stat as fsStat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProcessAdapter, ProcessResult } from "./exec.ts";
import { runProcess } from "./exec.ts";
import type { OpaqueId } from "./ids.ts";

export const GIT_COMMON_DIRECTORY_ARGS = ["rev-parse", "--git-common-dir"] as const;
export const GIT_ORIGIN_ARGS = ["config", "--get", "remote.origin.url"] as const;

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 4_096;
const CASE_INSENSITIVE_FORGE_HOSTS: Record<string, true> = {
  "bitbucket.org": true,
  "codeberg.org": true,
  "dev.azure.com": true,
  "gitea.com": true,
  "github.com": true,
  "gitlab.com": true,
  "ssh.dev.azure.com": true,
};

export interface RemoteRepositoryIdentity {
  kind: "remote";
  repositoryKey: OpaqueId<"repo">;
  canonicalHash: string;
}

export type CommonDirectoryIdentity =
  | { kind: "device-inode"; device: string; inode: string }
  | { kind: "path-hash"; pathHash: string; requiresReattach: true };

export interface CommonDirectoryStat {
  dev: number | bigint;
  ino: number | bigint;
}

export type CommonDirectoryStatHook = (
  path: string,
) => CommonDirectoryStat | Promise<CommonDirectoryStat>;

export type OriginIdentityResult =
  | { ok: true; identity: RemoteRepositoryIdentity }
  | { ok: false; code: "origin-malformed" };

export type GitIdentityReasonCode =
  | "git-unavailable"
  | "common-directory-command-failed"
  | "common-directory-malformed"
  | "origin-command-failed"
  | "origin-malformed";

export type GitIdentityResult =
  | {
      ok: true;
      kind: "remote";
      commonDirectory: string;
      commonDirectoryIdentity: CommonDirectoryIdentity;
      repository: RemoteRepositoryIdentity;
    }
  | {
      ok: true;
      kind: "no-remote";
      commonDirectory: string;
      commonDirectoryIdentity: CommonDirectoryIdentity;
    }
  | { ok: false; code: GitIdentityReasonCode };

export interface GitIdentityOptions {
  adapter?: ProcessAdapter;
  stat?: CommonDirectoryStatHook;
}

export function identityFromOrigin(origin: string): OriginIdentityResult {
  const canonical = canonicalizeOrigin(origin);
  if (canonical === undefined) return { ok: false, code: "origin-malformed" };

  const canonicalHash = sha256(canonical);
  return {
    ok: true,
    identity: {
      kind: "remote",
      repositoryKey: `repo_${canonicalHash.slice(0, 32)}`,
      canonicalHash,
    },
  };
}

export async function deriveCommonDirectoryIdentity(
  commonDirectory: string,
  stat: CommonDirectoryStatHook = defaultCommonDirectoryStat,
): Promise<CommonDirectoryIdentity> {
  const absolutePath = resolve(commonDirectory);
  try {
    const identity = await stat(absolutePath);
    const device = stableInteger(identity.dev, true);
    const inode = stableInteger(identity.ino, false);
    if (device !== undefined && inode !== undefined) {
      return { kind: "device-inode", device, inode };
    }
  } catch {
    // A stable stat identity is optional; moves are explicit when path hashing is required.
  }
  return {
    kind: "path-hash",
    pathHash: sha256(absolutePath),
    requiresReattach: true,
  };
}

export async function resolveGitIdentity(
  cwd: string,
  options: GitIdentityOptions = {},
): Promise<GitIdentityResult> {
  const absoluteCwd = resolve(cwd);
  const adapter = options.adapter ?? runProcess;

  const commonResult = await invokeGit(adapter, absoluteCwd, GIT_COMMON_DIRECTORY_ARGS);
  if (commonResult === undefined) {
    return { ok: false, code: "common-directory-command-failed" };
  }
  if (commonResult.status === "spawn-failed") return { ok: false, code: "git-unavailable" };
  if (commonResult.status !== "exited" || commonResult.exitCode !== 0) {
    return { ok: false, code: "common-directory-command-failed" };
  }

  const commonOutput = decodeSingleLine(commonResult.stdout);
  if (commonOutput === undefined) return { ok: false, code: "common-directory-malformed" };
  const commonDirectory = resolve(absoluteCwd, commonOutput);

  const originResult = await invokeGit(adapter, absoluteCwd, GIT_ORIGIN_ARGS);
  if (originResult === undefined) return { ok: false, code: "origin-command-failed" };
  if (originResult.status === "spawn-failed") return { ok: false, code: "git-unavailable" };
  if (originResult.status !== "exited") return { ok: false, code: "origin-command-failed" };

  const commonDirectoryIdentity = await deriveCommonDirectoryIdentity(
    commonDirectory,
    options.stat ?? defaultCommonDirectoryStat,
  );

  if (originResult.exitCode === 1 && isEmptyOutput(originResult.stdout)) {
    return {
      ok: true,
      kind: "no-remote",
      commonDirectory,
      commonDirectoryIdentity,
    };
  }
  if (originResult.exitCode !== 0) return { ok: false, code: "origin-command-failed" };

  const origin = decodeSingleLine(originResult.stdout);
  if (origin === undefined) return { ok: false, code: "origin-malformed" };
  const repository = identityFromOrigin(origin);
  if (!repository.ok) return repository;

  return {
    ok: true,
    kind: "remote",
    commonDirectory,
    commonDirectoryIdentity,
    repository: repository.identity,
  };
}

async function defaultCommonDirectoryStat(path: string): Promise<CommonDirectoryStat> {
  const value = await fsStat(path, { bigint: true });
  return { dev: value.dev, ino: value.ino };
}

async function invokeGit(
  adapter: ProcessAdapter,
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult | undefined> {
  try {
    return await adapter({
      command: "git",
      args,
      cwd,
      env: undefined,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    });
  } catch {
    return undefined;
  }
}

function canonicalizeOrigin(origin: string): string | undefined {
  if (
    origin.length === 0 ||
    origin !== origin.trim() ||
    /[\u0000-\u001f\u007f]/.test(origin)
  ) {
    return undefined;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
    if (!/^https:\/\//i.test(origin) && !/^ssh:\/\//i.test(origin)) return undefined;
    return canonicalizeUrlOrigin(origin);
  }
  return canonicalizeScpOrigin(origin);
}

function canonicalizeUrlOrigin(origin: string): string | undefined {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return undefined;

  const hostname = normalizeHost(url.hostname);
  if (hostname === undefined) return undefined;
  const port = url.port && !(url.protocol === "ssh:" && url.port === "22") ? `:${url.port}` : "";
  return joinCanonicalCoordinates(hostname, port, url.pathname);
}

function canonicalizeScpOrigin(origin: string): string | undefined {
  const match = /^(?:[^@/:?#\s]+@)?([^@/:?#\s]+):(.+)$/.exec(origin);
  if (!match) return undefined;
  const hostname = normalizeHost(match[1] ?? "");
  if (hostname === undefined) return undefined;

  const rawPath = match[2] ?? "";
  const suffixStart = rawPath.search(/[?#]/);
  const path = suffixStart === -1 ? rawPath : rawPath.slice(0, suffixStart);
  return joinCanonicalCoordinates(hostname, "", path);
}

function joinCanonicalCoordinates(
  hostname: string,
  port: string,
  rawPath: string,
): string | undefined {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }

  const withoutOuterSlashes = decodedPath.replace(/^\/+|\/+$/g, "");
  const withoutGitSuffix = withoutOuterSlashes.replace(/\.git$/i, "");
  if (withoutGitSuffix.length === 0) return undefined;

  let segments = withoutGitSuffix.split("/");
  if (
    segments.some(
      segment =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    return undefined;
  }
  if (CASE_INSENSITIVE_FORGE_HOSTS[hostname]) {
    segments = segments.map(segment => segment.toLowerCase());
  }
  return `${hostname}${port}/${segments.join("/")}`;
}

function normalizeHost(hostname: string): string | undefined {
  if (hostname.length === 0 || /[\s/?#@]/.test(hostname)) return undefined;
  return hostname.toLowerCase();
}

function decodeSingleLine(output: Uint8Array): string | undefined {
  if (output.byteLength > MAX_GIT_OUTPUT_BYTES) return undefined;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return undefined;
  }

  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (value.length === 0 || /[\u0000\r\n]/.test(value)) return undefined;
  return value;
}

function isEmptyOutput(output: Uint8Array): boolean {
  if (output.byteLength > MAX_GIT_OUTPUT_BYTES) return false;
  try {
    return /^[\r\n]*$/.test(new TextDecoder("utf-8", { fatal: true }).decode(output));
  } catch {
    return false;
  }
}

function stableInteger(value: number | bigint, allowZero: boolean): string | undefined {
  if (typeof value === "bigint") {
    if (value < 0n || (!allowZero && value === 0n)) return undefined;
    return value.toString();
  }
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    return undefined;
  }
  return String(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
