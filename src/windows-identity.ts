import type { JsonCommandOptions, JsonCommandResult, ProcessAdapter } from "./exec.ts";
import { runJsonCommand } from "./exec.ts";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

const WINDOWS_POWERSHELL_COMMANDS = ["powershell.exe", "pwsh.exe"] as const;

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
  | "ownership-probe-authentication-failed"
  | "ownership-probe-execution-error"
  | "ownership-probe-malformed"
  | "ownership-payload-invalid"
  | "ownership-probe-access-denied"
  | "ownership-probe-method-error"
  | "ownership-probe-platform-error"
  | "ownership-probe-runtime-error"
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
      ? await runDefaultOwnershipCommand(resolveDefaultPowerShellCommand(command, env), script, env)
      : await runJsonCommand(command, args, commandOptions);
    if (!result.ok) {
      if (result.code === "spawn-failed") continue;
      if (result.message === "access") {
        return { writable: false, code: "ownership-probe-access-denied" };
      }
      if (result.message === "method") {
        return { writable: false, code: "ownership-probe-method-error" };
      }
      if (result.message === "platform") {
        return { writable: false, code: "ownership-probe-platform-error" };
      }
      if (result.message === "runtime") {
        return { writable: false, code: "ownership-probe-runtime-error" };
      }
      if (result.message === "authentication") {
        return { writable: false, code: "ownership-probe-authentication-failed" };
      }
      if (result.message === "other") {
        return { writable: false, code: "ownership-probe-execution-error" };
      }
      if (result.code === "malformed-json") {
        return { writable: false, code: "ownership-probe-malformed" };
      }
      return { writable: false, code: "ownership-probe-invalid" };
    }
    if (!isOwnershipPayload(result.value)) {
      return { writable: false, code: "ownership-payload-invalid" };
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
function resolveDefaultPowerShellCommand(
  command: (typeof WINDOWS_POWERSHELL_COMMANDS)[number],
  env: NodeJS.ProcessEnv,
): string {
  if (command !== "powershell.exe" || process.platform !== "win32") return command;
  const systemRoot = env.SystemRoot ?? env.windir;
  if (systemRoot === undefined || !win32.isAbsolute(systemRoot)) return command;
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", command);
}


async function runDefaultOwnershipCommand(
  command: string,
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
  const authenticationKey = randomBytes(32);
  const wrappedScript = [
    "$encoding = New-Object System.Text.UTF8Encoding($false)",
    `try { $result = & { ${script} }; $text = [string]$result; $key = [Convert]::FromBase64String($env:CLASI_OWNERSHIP_KEY); $hmac = New-Object System.Security.Cryptography.HMACSHA256; try { $hmac.Key = $key; $signature = [Convert]::ToBase64String($hmac.ComputeHash($encoding.GetBytes($text))) } finally { $hmac.Dispose() }; [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_RESULT, $text, $encoding); [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_COMPLETE, "ok:$signature", $encoding) }`,
    "catch { $name = $_.Exception.GetType().Name; if ($name -eq 'UnauthorizedAccessException') { $kind = 'access' } elseif ($name -eq 'MethodException' -or $name -eq 'MethodInvocationException') { $kind = 'method' } elseif ($name -eq 'PlatformNotSupportedException') { $kind = 'platform' } elseif ($name -eq 'RuntimeException') { $kind = 'runtime' } else { $kind = 'other' }; [System.IO.File]::WriteAllText($env:CLASI_OWNERSHIP_COMPLETE, \"error:$kind\", $encoding) }",
  ].join("\n");
  let child: Bun.Subprocess | undefined;
  try {
    const encodedScript = Buffer.from(wrappedScript, "utf16le").toString("base64");
    child = Bun.spawn(
      [command, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        env: {
          ...env,
          CLASI_OWNERSHIP_RESULT: resultPath,
          CLASI_OWNERSHIP_COMPLETE: completionPath,
          CLASI_OWNERSHIP_KEY: authenticationKey.toString("base64"),
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    child.unref();
    let exitedAt: number | undefined;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const completion = await readFile(completionPath, "utf8").catch(() => undefined);
      if (completion?.startsWith("error:")) {
        return {
          ok: false,
          code: "nonzero-exit",
          message: completion.slice("error:".length),
        };
      }
      if (completion?.startsWith("ok:")) {
        const resultStats = await stat(resultPath);
        if (resultStats.size > 4_096) {
          return { ok: false, code: "output-too-large", message: "Ownership probe output is too large" };
        }
        const bytes = await readFile(resultPath);
        if (!verifyOwnershipSignature(bytes, completion, authenticationKey)) {
          return { ok: false, code: "nonzero-exit", message: "authentication" };
        }
        const text = bytes.toString("utf8").replace(/^\uFEFF/, "").trim();
        try {
          return { ok: true, value: JSON.parse(text) as unknown };
        } catch {
          return { ok: false, code: "malformed-json", message: "Ownership probe returned invalid JSON" };
        }
      }
      if (child.exitCode !== null) {
        exitedAt ??= Date.now();
        if (Date.now() - exitedAt >= 100) {
          return {
            ok: false,
            code: "spawn-failed",
            message: "PowerShell exited before completing the ownership probe",
          };
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

export function verifyOwnershipSignature(
  bytes: Uint8Array,
  completion: string,
  authenticationKey: Uint8Array,
): boolean {
  if (
    authenticationKey.byteLength !== 32 ||
    !/^ok:[A-Za-z0-9+/]{43}=$/.test(completion)
  ) return false;
  const actualSignature = Buffer.from(completion.slice("ok:".length), "base64");
  const expectedSignature = createHmac("sha256", authenticationKey).update(bytes).digest();
  return (
    actualSignature.length === expectedSignature.length &&
    timingSafeEqual(actualSignature, expectedSignature)
  );
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
