import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;

export interface ProcessInvocation {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ProcessResult =
  | {
      status: "exited";
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
    }
  | { status: "spawn-failed"; message: string }
  | { status: "timed-out" }
  | { status: "output-too-large" };

export type ProcessAdapter = (invocation: ProcessInvocation) => Promise<ProcessResult>;

export interface JsonCommandOptions {
  adapter?: ProcessAdapter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type JsonCommandResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      code:
        | "spawn-failed"
        | "timeout"
        | "output-too-large"
        | "nonzero-exit"
        | "malformed-json";
      message: string;
      exitCode?: number;
    };

export async function runJsonCommand(
  command: string,
  args: readonly string[],
  options: JsonCommandOptions = {},
): Promise<JsonCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError("maxOutputBytes must be a positive integer");
  }

  const invocation: ProcessInvocation = {
    command,
    args: [...args],
    cwd: options.cwd,
    env: options.env,
    timeoutMs,
    maxOutputBytes,
  };

  let result: ProcessResult;
  try {
    result = await (options.adapter ?? runProcess)(invocation);
  } catch (error) {
    return failure(
      "spawn-failed",
      error instanceof Error ? error.message : "Process failed to start",
    );
  }

  if (result.status === "spawn-failed") return failure("spawn-failed", result.message);
  if (result.status === "timed-out") return failure("timeout", "Process timed out");
  if (result.status === "output-too-large") {
    return failure("output-too-large", "Process output exceeded the configured limit");
  }
  if (result.stdout.byteLength + result.stderr.byteLength > maxOutputBytes) {
    return failure("output-too-large", "Process output exceeded the configured limit");
  }
  if (result.exitCode !== 0) {
    return {
      ...failure("nonzero-exit", `Process exited with code ${result.exitCode}`),
      exitCode: result.exitCode,
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch {
    return failure("malformed-json", "Process output was not valid UTF-8 JSON");
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure("malformed-json", "Process output was not valid JSON");
  }
}

export const runProcess: ProcessAdapter = invocation => {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  const child = spawn(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const finish = (result: ProcessResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const collect = (target: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > invocation.maxOutputBytes) {
      child.kill();
      finish({ status: "output-too-large" });
      return;
    }
    target.push(chunk);
  };

  child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
  child.once("error", error => finish({ status: "spawn-failed", message: error.message }));
  child.once("close", code => {
    finish({
      status: "exited",
      exitCode: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    });
  });

  timer = setTimeout(() => {
    child.kill();
    finish({ status: "timed-out" });
  }, invocation.timeoutMs);

  return promise;
};

export const runProcessSync: ProcessAdapter = invocation => {
  const result = spawnSync(invocation.command, [...invocation.args], {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: invocation.timeoutMs,
    maxBuffer: invocation.maxOutputBytes,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") return Promise.resolve({ status: "timed-out" });
    if (code === "ENOBUFS") return Promise.resolve({ status: "output-too-large" });
    return Promise.resolve({ status: "spawn-failed", message: result.error.message });
  }
  const stdout = result.stdout ?? new Uint8Array();
  const stderr = result.stderr ?? new Uint8Array();
  if (stdout.byteLength + stderr.byteLength > invocation.maxOutputBytes) {
    return Promise.resolve({ status: "output-too-large" });
  }
  return Promise.resolve({
    status: "exited",
    exitCode: result.status ?? 1,
    stdout,
    stderr,
  });
};

function failure(code: Exclude<JsonCommandResult, { ok: true }>["code"], message: string) {
  return { ok: false, code, message } as const;
}

