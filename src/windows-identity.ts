import type { JsonCommandOptions, ProcessAdapter } from "./exec.ts";
import { runJsonCommand } from "./exec.ts";

export const WINDOWS_OWNERSHIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$ownerName = (Get-Acl -LiteralPath $env:CLASI_ROOT_CHECK).Owner",
  "$owner = (New-Object System.Security.Principal.NTAccount($ownerName)).Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "@{ current_sid = $current; owner_sid = $owner } | ConvertTo-Json -Compress",
].join("; ");

export type WindowsOwnershipReasonCode =
  | "powershell-unavailable"
  | "ownership-probe-invalid"
  | "owner-mismatch";

export type WindowsOwnershipResult =
  | { writable: true; sid: string }
  | { writable: false; code: WindowsOwnershipReasonCode };

export interface WindowsOwnershipOptions {
  adapter?: ProcessAdapter;
  env?: NodeJS.ProcessEnv;
}

export async function probeWindowsRootOwnership(
  root: string,
  options: WindowsOwnershipOptions = {},
): Promise<WindowsOwnershipResult> {
  const commandOptions: JsonCommandOptions = {
    ...(options.adapter ? { adapter: options.adapter } : {}),
    env: { ...(options.env ?? process.env), CLASI_ROOT_CHECK: root },
    maxOutputBytes: 4_096,
    timeoutMs: 10_000,
  };
  const result = await runJsonCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_OWNERSHIP_SCRIPT],
    commandOptions,
  );
  if (!result.ok) {
    return {
      writable: false,
      code: result.code === "spawn-failed" ? "powershell-unavailable" : "ownership-probe-invalid",
    };
  }
  if (!isOwnershipPayload(result.value)) {
    return { writable: false, code: "ownership-probe-invalid" };
  }
  if (result.value.current_sid !== result.value.owner_sid) {
    return { writable: false, code: "owner-mismatch" };
  }
  return { writable: true, sid: result.value.current_sid };
}

function isOwnershipPayload(value: unknown): value is { current_sid: string; owner_sid: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "current_sid" || keys[1] !== "owner_sid") return false;
  if (!("current_sid" in value) || !("owner_sid" in value)) return false;
  return isSid(value.current_sid) && isSid(value.owner_sid);
}

function isSid(value: unknown): value is string {
  return typeof value === "string" && /^S-\d-\d+(?:-\d+)+$/.test(value);
}
