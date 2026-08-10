import type { JsonCommandOptions, ProcessAdapter } from "./exec.ts";
import { runJsonCommand } from "./exec.ts";

export const WINDOWS_OWNERSHIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$acl = [System.IO.Directory]::GetAccessControl($env:CLASI_ROOT_CHECK)",
  "$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "$descriptor = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)",
  "@{ current_sid = $current; owner_sid = $owner; security_descriptor = $descriptor } | ConvertTo-Json -Compress",
].join("; ");

const WINDOWS_CREATE_PRIVATE_ROOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$security = New-Object System.Security.AccessControl.DirectorySecurity",
  "$security.SetAccessRuleProtection($true, $false)",
  "$security.SetOwner($current)",
  "$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($current, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
  "$security.AddAccessRule($rule)",
  "$created = [System.IO.Directory]::CreateDirectory($env:CLASI_ROOT_CHECK, $security)",
  "$actual = $created.GetAccessControl()",
  "$hasInheritedRule = $false",
  "foreach ($access in $actual.Access) { if ($access.IsInherited) { $hasInheritedRule = $true } }",
  "if ($hasInheritedRule) { throw 'Inherited access rule detected' }",
  "$owner = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "$descriptor = $actual.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access)",
  "@{ current_sid = $current.Value; owner_sid = $owner; security_descriptor = $descriptor } | ConvertTo-Json -Compress",
].join("; ");

export type WindowsOwnershipReasonCode =
  | "powershell-unavailable"
  | "ownership-probe-invalid"
  | "owner-mismatch";

export type WindowsOwnershipResult =
  | { writable: true; sid: string; securityDescriptor: string }
  | { writable: false; code: WindowsOwnershipReasonCode };

export interface WindowsOwnershipOptions {
  adapter?: ProcessAdapter;
  env?: NodeJS.ProcessEnv;
}

export async function createWindowsPrivateRoot(
  root: string,
  options: WindowsOwnershipOptions = {},
): Promise<WindowsOwnershipResult> {
  return runOwnershipScript(root, WINDOWS_CREATE_PRIVATE_ROOT_SCRIPT, options);
}

export async function probeWindowsRootOwnership(
  root: string,
  options: WindowsOwnershipOptions = {},
): Promise<WindowsOwnershipResult> {
  return runOwnershipScript(root, WINDOWS_OWNERSHIP_SCRIPT, options);
}

async function runOwnershipScript(
  root: string,
  script: string,
  options: WindowsOwnershipOptions,
): Promise<WindowsOwnershipResult> {
  const commandOptions: JsonCommandOptions = {
    ...(options.adapter ? { adapter: options.adapter } : {}),
    env: { ...(options.env ?? process.env), CLASI_ROOT_CHECK: root },
    maxOutputBytes: 4_096,
    timeoutMs: 10_000,
  };
  const result = await runJsonCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
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
  return {
    writable: true,
    sid: result.value.current_sid,
    securityDescriptor: result.value.security_descriptor,
  };
}

function isOwnershipPayload(
  value: unknown,
): value is { current_sid: string; owner_sid: string; security_descriptor: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "current_sid" ||
    keys[1] !== "owner_sid" ||
    keys[2] !== "security_descriptor"
  ) return false;
  if (!("current_sid" in value) || !("owner_sid" in value) || !("security_descriptor" in value)) {
    return false;
  }
  return (
    isSid(value.current_sid) &&
    isSid(value.owner_sid) &&
    isSecurityDescriptor(value.security_descriptor)
  );
}

function isSecurityDescriptor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 2_048 &&
    value.startsWith("O:") &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSid(value: unknown): value is string {
  return typeof value === "string" && /^S-\d-\d+(?:-\d+)+$/.test(value);
}
