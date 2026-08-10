import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const ISOLATED_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PI_CODING_AGENT_DIR",
  "BUN_INSTALL",
  "CLASI_HOME",
] as const;

export class IsolationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IsolationError";
  }
}

export interface IsolatedRoots {
  readonly root: string;
  readonly parent: string;
  readonly home: string;
  readonly xdgConfig: string;
  readonly xdgData: string;
  readonly xdgCache: string;
  readonly agent: string;
  readonly bunInstall: string;
  readonly clasiHome: string;
  readonly work: string;
  readonly environment: Readonly<Record<(typeof ISOLATED_ENV_KEYS)[number], string>>;
}

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessAdapter = (request: ProcessRequest) => Promise<ProcessResult>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const issuedRoots = new WeakMap<IsolatedRoots, { root: string; parent: string }>();

export async function createIsolatedRoots(options: {
  parent?: string;
  prefix?: string;
} = {}): Promise<IsolatedRoots> {
  const parentInput = resolve(options.parent ?? tmpdir());
  const prefix = options.prefix ?? "clasi-smoke-";
  if (!/^[A-Za-z0-9._-]+-$/.test(prefix)) throw new IsolationError("invalid-prefix");
  await mkdir(parentInput, { recursive: true, mode: 0o700 });
  const parent = await realpath(parentInput);
  const root = await mkdtemp(join(parent, prefix));

  try {
    assertPathInsideRoot(parent, root);
    const home = join(root, "home");
    const roots: IsolatedRoots = {
      root,
      parent,
      home,
      xdgConfig: join(root, "xdg", "config"),
      xdgData: join(root, "xdg", "data"),
      xdgCache: join(root, "xdg", "cache"),
      agent: join(root, "omp", "agent"),
      bunInstall: join(root, "bun"),
      clasiHome: join(root, "clasi", "data"),
      work: join(root, "work"),
      environment: Object.freeze({
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(root, "xdg", "config"),
        XDG_DATA_HOME: join(root, "xdg", "data"),
        XDG_CACHE_HOME: join(root, "xdg", "cache"),
        PI_CODING_AGENT_DIR: join(root, "omp", "agent"),
        BUN_INSTALL: join(root, "bun"),
        CLASI_HOME: join(root, "clasi", "data"),
      }),
    };
    assertIsolatedRoots(roots);
    await Promise.all([
      roots.home,
      roots.xdgConfig,
      roots.xdgData,
      roots.xdgCache,
      roots.agent,
      roots.bunInstall,
      roots.clasiHome,
      roots.work,
    ].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
    const frozen = Object.freeze(roots);
    issuedRoots.set(frozen, { root, parent });
    return frozen;
  } catch (error) {
    assertPathInsideRoot(parent, root);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function assertPathInsideRoot(root: string, candidate: string, allowRoot = false): string {
  if (!isAbsolute(root) || !isAbsolute(candidate)) throw new IsolationError("path-not-absolute");
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const relation = relative(absoluteRoot, absoluteCandidate);
  if (
    (relation === "" && !allowRoot) ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new IsolationError("path-escape");
  }
  return absoluteCandidate;
}

export function assertIsolatedRoots(roots: IsolatedRoots): void {
  assertPathInsideRoot(roots.parent, roots.root);
  for (const path of [
    roots.home,
    roots.xdgConfig,
    roots.xdgData,
    roots.xdgCache,
    roots.agent,
    roots.bunInstall,
    roots.clasiHome,
    roots.work,
  ]) {
    assertPathInsideRoot(roots.root, path);
  }
  for (const key of ISOLATED_ENV_KEYS) {
    const path = roots.environment[key];
    if (!path) throw new IsolationError("missing-isolated-environment");
    assertPathInsideRoot(roots.root, path);
  }
  if (roots.environment.HOME !== roots.home || roots.environment.USERPROFILE !== roots.home) {
    throw new IsolationError("home-mismatch");
  }
}

export async function cleanupIsolatedRoots(roots: IsolatedRoots): Promise<void> {
  const issued = issuedRoots.get(roots);
  if (!issued || roots.root !== issued.root || roots.parent !== issued.parent) {
    throw new IsolationError("unissued-root");
  }
  assertIsolatedRoots(roots);
  assertPathInsideRoot(issued.parent, issued.root);
  await rm(issued.root, { recursive: true, force: true });
  issuedRoots.delete(roots);
}

export const spawnProcess: ProcessAdapter = async request => {
  validateProcessRequest(request);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const child = Bun.spawn([request.command, ...request.args], {
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      child.kill();
      reject(new IsolationError("process-timeout"));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    const completed = Promise.all([
      child.exited,
      readBounded(child.stdout, maximumBytes),
      readBounded(child.stderr, maximumBytes),
    ]);
    const [exitCode, stdout, stderr] = await Promise.race([completed, timeout]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export async function runCheckedProcess(
  adapter: ProcessAdapter,
  request: ProcessRequest,
): Promise<ProcessResult> {
  validateProcessRequest(request);
  const result = await adapter(request);
  const maximumBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    Buffer.byteLength(result.stdout) > maximumBytes ||
    Buffer.byteLength(result.stderr) > maximumBytes
  ) {
    throw new IsolationError("process-output-limit");
  }
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
    throw new IsolationError("process-failed");
  }
  return result;
}

export async function resolveExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  if (!name || name.includes("\0") || name.includes("/") || name.includes("\\")) {
    throw new IsolationError("invalid-executable");
  }
  const pathValue = env.PATH;
  if (!pathValue) throw new IsolationError("missing-path");
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidate = resolve(entry, process.platform === "win32" ? `${name}${extension}` : name);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new IsolationError("executable-not-found");
}

export function cleanPath(binDirectories: readonly string[]): string {
  if (binDirectories.length === 0) throw new IsolationError("empty-clean-path");
  for (const path of binDirectories) {
    if (!isAbsolute(path) || basename(path) === "" || dirname(path) === path) {
      throw new IsolationError("invalid-clean-path");
    }
  }
  return [...new Set(binDirectories.map(path => resolve(path)))].join(delimiter);
}

function validateProcessRequest(request: ProcessRequest): void {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!request.command || request.command.includes("\0")) throw new IsolationError("invalid-command");
  if (request.args.some(argument => argument.includes("\0"))) throw new IsolationError("invalid-argument");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new IsolationError("invalid-timeout");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8_388_608) {
    throw new IsolationError("invalid-output-limit");
  }
  if (request.cwd !== undefined && !isAbsolute(request.cwd)) throw new IsolationError("cwd-not-absolute");
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) throw new IsolationError("process-output-limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
