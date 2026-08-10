import type { JsonCommandOptions, JsonCommandResult, ProcessAdapter } from "./exec.ts";
import { runJsonCommand } from "./exec.ts";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const WINDOWS_POWERSHELL_COMMANDS = ["pwsh.exe", "powershell.exe"] as const;

export const WINDOWS_OWNERSHIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "if ($PSVersionTable.PSEdition -eq 'Core') { $directory = New-Object System.IO.DirectoryInfo($env:CLASI_ROOT_CHECK); $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($directory) } else { $acl = [System.IO.Directory]::GetAccessControl($env:CLASI_ROOT_CHECK) }",
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
  "if ($PSVersionTable.PSEdition -eq 'Core') { $created = [System.IO.FileSystemAclExtensions]::CreateDirectory($security, $env:CLASI_ROOT_CHECK); $actual = [System.IO.FileSystemAclExtensions]::GetAccessControl($created) } else { $created = [System.IO.Directory]::CreateDirectory($env:CLASI_ROOT_CHECK, $security); $actual = $created.GetAccessControl() }",
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
  const env = { ...(options.env ?? process.env), CLASI_ROOT_CHECK: root };
  const commandOptions: JsonCommandOptions = {
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    env,
    maxOutputBytes: 4_096,
    timeoutMs: 30_000,
  };
  for (const command of WINDOWS_POWERSHELL_COMMANDS) {
    const args = ["-NoProfile", "-NonInteractive", "-Command", script];
    const result = options.adapter === undefined
      ? await runDefaultOwnershipCommand(command, args, script, env)
      : await runJsonCommand(command, args, commandOptions);
    if (!result.ok) {
      if (result.code === "spawn-failed") continue;
      return { writable: false, code: "ownership-probe-invalid" };
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
  return { writable: false, code: "powershell-unavailable" };
}

async function runDefaultOwnershipCommand(
  command: string,
  args: readonly string[],
  script: string,
  env: NodeJS.ProcessEnv,
): Promise<JsonCommandResult> {
  const outputRoot = env.TEMP ?? env.TMP ?? tmpdir();
  if (!isAbsolute(outputRoot)) {
    return { ok: false, code: "spawn-failed", message: "Temporary directory is not absolute" };
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const captureRoot = await mkdtemp(join(outputRoot, "clasi-ownership-"));
  const resultPath = join(captureRoot, "result");
  const completionPath = join(captureRoot, "complete");
  const wrappedScript = [
    "$encoding = New-Object System.Text.UTF8Encoding($false)",
    `try { $result = & { ${script} }; [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_RESULT, [string]$result, $encoding); [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_COMPLETE, 'ok', $encoding) }`,
    "catch { [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_COMPLETE, 'error', $encoding) }",
  ].join("; ");
  let child: Bun.Subprocess | undefined;
  try {
    child = Bun.spawn([command, ...args.slice(0, -1), wrappedScript], {
      env: {
        ...env,
        CLASI_OWNERSHIP_RESULT: resultPath,
        CLASI_OWNERSHIP_COMPLETE: completionPath,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const completion = await readFile(completionPath, "utf8").catch(() => undefined);
      if (completion === "error") {
        return { ok: false, code: "nonzero-exit", message: "Ownership probe failed" };
      }
      if (completion === "ok") {
        const resultStats = await stat(resultPath);
        if (resultStats.size > 4_096) {
          return { ok: false, code: "output-too-large", message: "Ownership probe output is too large" };
        }
        const text = (await readFile(resultPath, "utf8")).replace(/^\uFEFF/, "").trim();
        try {
          return { ok: true, value: JSON.parse(text) as unknown };
        } catch {
          return { ok: false, code: "malformed-json", message: "Ownership probe returned invalid JSON" };
        }
      }
      await Bun.sleep(25);
    }
    child.kill();
    return { ok: false, code: "timeout", message: "Ownership probe timed out" };
  } catch (error) {
    child?.kill();
    return {
      ok: false,
      code: "spawn-failed",
      message: error instanceof Error ? error.message : "Ownership probe failed to start",
    };
  } finally {
    await rm(captureRoot, { recursive: true, force: true }).catch(() => undefined);
  }
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
