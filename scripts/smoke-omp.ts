import assert from "node:assert/strict";
import { access, cp, link, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDocumentLock, LockError } from "../src/lock.ts";
import { assertRootUnchanged, pinRoot } from "../src/root-safety.ts";
import {
  CLASI_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  MINIMUM_OMP_VERSION,
  evidenceDirectory,
  writePlatformEvidence,
} from "./evidence-schema.ts";
import type { NamedCheck, OmpMatrixRowName, Platform, PlatformEvidence } from "./evidence-schema.ts";
import {
  IsolationError,
  assertIsolatedRoots,
  assertPathInsideRoot,
  cleanPath,
  cleanupIsolatedRoots,
  createIsolatedRoots,
  resolveExecutable,
  runCheckedProcess,
  spawnProcess,
} from "./isolation.ts";
import type { IsolatedRoots, ProcessAdapter, ProcessRequest } from "./isolation.ts";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_JSON_BYTES = 1_048_576;
const PROCESS_TIMEOUT_MS = 45_000;
const INSTALL_TIMEOUT_MS = 120_000;
const SMOKE_PROVIDER = "clasi-smoke";
const SMOKE_MODEL = "smoke-model";
const SKILL_MARKERS = [
  "clasi provides three distinct kinds of quiet, scoped memory:",
  "Never send clasi raw prompts",
  "Routine capture and loading are silent.",
] as const;
const CONTEXT_MARKER = "# clasi context";

export interface OpenAIStub {
  readonly baseUrl: string;
  readonly requests: readonly unknown[];
  readonly unexpectedRequest: boolean;
  clear(): void;
  stop(): void;
}

interface GitHttpTransport {
  readonly installSpec: string;
  readonly unexpectedRequest: boolean;
  stop(): void;
}

export interface OmpSmokeDependencies {
  readonly process?: ProcessAdapter;
  readonly startStub?: () => OpenAIStub;
  readonly sourceRoot?: string;
  readonly now?: () => Date;
}

export interface OmpSmokeResult {
  readonly platform: Platform | "native_linux";
  readonly omp_version: string;
  readonly evidence_written: boolean;
}

interface CompletedChecks {
  readonly platform: Platform | "native_linux";
  readonly architecture: "x64" | "arm64";
  readonly ompVersion: string;
  readonly bunVersion: string;
  readonly matrixRow: OmpMatrixRowName;
  readonly packageDiagnostics: NamedCheck[];
  readonly windowsSidAcl: "passed" | "not_applicable";
  readonly publicInstall: boolean;
}

export async function runOmpSmoke(
  dependencies: OmpSmokeDependencies = {},
): Promise<OmpSmokeResult> {
  const adapter = dependencies.process ?? spawnProcess;
  const sourceRoot = resolve(dependencies.sourceRoot ?? SOURCE_ROOT);
  const now = dependencies.now ?? (() => new Date());
  const roots = await createIsolatedRoots();
  const environment = await createSmokeEnvironment(roots);
  const publicGitSpec = process.env.CLASI_PUBLIC_GIT_SPEC;
  if (
    publicGitSpec !== undefined &&
    !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9a-f]{40,64}$/.test(publicGitSpec)
  ) {
    throw new IsolationError("public-git-spec-invalid");
  }
  let completed: CompletedChecks | undefined;
  let stub: OpenAIStub | undefined;
  let gitTransport: GitHttpTransport | undefined;

  try {
    assertIsolatedRoots(roots);
    const ompExecutable = await resolveExecutable("omp");
    const gitExecutable = await resolveExecutable("git");
    const bunExecutable = resolve(process.execPath);
    await access(bunExecutable);

    const ompVersion = parseOmpVersion((await checked(adapter, {
      command: ompExecutable,
      args: ["--version"],
      cwd: sourceRoot,
      env: environment,
    })).stdout);
    const bunVersion = parseBunVersion((await checked(adapter, {
      command: bunExecutable,
      args: ["--version"],
      cwd: sourceRoot,
      env: environment,
    })).stdout);
    const matrixRow = resolveMatrixRow(ompVersion, process.env.CLASI_OMP_MATRIX_ROW);
    const architecture = requireArchitecture(process.arch);
    const platform = await detectEvidencePlatform();

    const packageRoot = join(roots.work, "package");
    assertPathInsideRoot(roots.root, packageRoot);
    await copyPackageSource(sourceRoot, packageRoot);
    await assertContainedTree(packageRoot);
    const manifest = await assertPackageSource(packageRoot);
    const commit = await initializeGitRepository(adapter, gitExecutable, packageRoot, environment);
    const bareRepository = join(roots.work, "clasi.git");
    assertPathInsideRoot(roots.root, bareRepository);
    await prepareDumbGitRepository(
      adapter,
      gitExecutable,
      packageRoot,
      bareRepository,
      environment,
    );

    const paths = expectedInstallPaths(roots, packageRoot);
    for (const path of Object.values(paths)) assertPathInsideRoot(roots.root, path);

    await checked(adapter, {
      command: bunExecutable,
      args: [join(packageRoot, "bin", "clasi.ts"), "setup", "--root", roots.clasiHome, "--confirm"],
      cwd: packageRoot,
      env: environment,
    });
    const packageLocalStatus = await checked(adapter, {
      command: bunExecutable,
      args: [join(packageRoot, "bin", "clasi.ts"), "status"],
      cwd: packageRoot,
      env: environment,
    });
    assertClasiStatus(packageLocalStatus.stdout, roots.clasiHome);

    const preservationFile = join(roots.clasiHome, "uninstall-preservation-check");
    assertPathInsideRoot(roots.root, preservationFile);
    await writeFile(preservationFile, "preserved\n", { flag: "wx", mode: 0o600 });
    const preservationBytes = await readFile(preservationFile);

    await runLosslessReplacementCheck(roots);
    await runLockContentionCheck(roots);
    runPathNormalizationCheck(roots);
    const windowsSidAcl = await runWindowsBoundaryCheck(roots);

    await checked(adapter, {
      command: ompExecutable,
      args: ["plugin", "link", packageRoot, "--json"],
      cwd: packageRoot,
      env: environment,
    });
    const linkedStats = await lstat(paths.linkedPackage);
    assert(linkedStats.isSymbolicLink());
    assert.equal(await realpath(paths.linkedPackage), await realpath(packageRoot));

    const doctor = await checked(adapter, {
      command: ompExecutable,
      args: ["plugin", "doctor", "--json"],
      cwd: packageRoot,
      env: environment,
    });
    let packageDiagnostics = inspectDoctorOutput(doctor.stdout, manifest);

    stub = (dependencies.startStub ?? startOpenAIStub)();
    await writeModelsConfiguration(paths.models, stub.baseUrl);
    const skillGuidance = await readFile(join(packageRoot, "skills", "clasi", "SKILL.md"), "utf-8");
    await checked(adapter, {
      command: ompExecutable,
      args: [
        "-p",
        "--model", `${SMOKE_PROVIDER}/${SMOKE_MODEL}`,
        "--tools", "read",
        "--no-lsp",
        "--no-title",
        "--no-session",
        "--no-prewalk",
        "--thinking", "off",
        "--max-time", "30s",
        "--cwd", packageRoot,
        "/skill:clasi",
      ],
      cwd: packageRoot,
      env: environment,
    });
    assert.equal(stub.unexpectedRequest, false);
    assertCapturedModelRequests(stub.requests, skillGuidance);
    stub.clear();
    assert.equal(stub.requests.length, 0);
    stub.stop();
    stub = undefined;
    await unlink(paths.linkedPackage);
    await assertMissing(paths.linkedPackage);

    gitTransport = startDumbGitTransport(bareRepository, commit);
    if (publicGitSpec !== undefined) {
      await checked(adapter, {
        command: ompExecutable,
        args: ["plugin", "install", publicGitSpec, "--force", "--json"],
        cwd: packageRoot,
        env: environment,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      const gitInstalledPlugin = await lstat(paths.linkedPackage);
      assert(gitInstalledPlugin.isSymbolicLink());
      assertPathInsideRoot(roots.root, await realpath(paths.linkedPackage));
      const installedDoctor = await checked(adapter, {
        command: ompExecutable,
        args: ["plugin", "doctor", "--json"],
        cwd: packageRoot,
        env: environment,
      });
      packageDiagnostics = inspectDoctorOutput(installedDoctor.stdout, manifest);
    }
    await checked(adapter, {
      command: bunExecutable,
      args: [
        "install",
        "--global",
        "--omit=peer",
        "--ignore-scripts",
        "--no-progress",
        gitTransport.installSpec,
      ],
      cwd: packageRoot,
      env: environment,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assert.equal(gitTransport.unexpectedRequest, false);
    gitTransport.stop();
    gitTransport = undefined;
    const bunBinOutput = await checked(adapter, {
      command: bunExecutable,
      args: ["pm", "bin", "--global"],
      cwd: packageRoot,
      env: environment,
    });
    const globalBin = parseAbsoluteSingleLine(bunBinOutput.stdout);
    assertPathInsideRoot(roots.root, globalBin);
    const cleanEnvironment = {
      ...environment,
      PATH: cleanPath([dirname(bunExecutable), globalBin]),
    };
    const installedBin = await resolveExecutable("clasi", cleanEnvironment);
    assertPathInsideRoot(roots.root, installedBin);
    assertPathInsideRoot(roots.root, await realpath(installedBin));
    const globalStatus = await checked(adapter, {
      command: "clasi",
      args: ["status"],
      cwd: packageRoot,
      env: cleanEnvironment,
    });
    assertClasiStatus(globalStatus.stdout, roots.clasiHome);

    for (const path of [paths.plugins, paths.pluginManifest, paths.pluginLock, paths.linkedPackage]) {
      assertPathInsideRoot(roots.root, path);
    }
    if (publicGitSpec !== undefined) {
      await checked(adapter, {
        command: ompExecutable,
        args: ["plugin", "uninstall", "clasi", "--json"],
        cwd: packageRoot,
        env: environment,
      });
      await assertMissing(paths.linkedPackage);
    }
    assert.deepEqual(await readFile(preservationFile), preservationBytes);

    assertPathInsideRoot(roots.root, globalBin);
    await checked(adapter, {
      command: bunExecutable,
      args: ["remove", "--global", "clasi"],
      cwd: packageRoot,
      env: environment,
    });
    assert.deepEqual(await readFile(preservationFile), preservationBytes);

    completed = {
      platform,
      architecture,
      ompVersion,
      bunVersion,
      matrixRow,
      packageDiagnostics,
      windowsSidAcl,
      publicInstall: publicGitSpec !== undefined,
    };
  } finally {
    if (stub !== undefined) {
      stub.clear();
      stub.stop();
    }
    gitTransport?.stop();
    await cleanupIsolatedRoots(roots);
  }

  if (completed === undefined) throw new IsolationError("smoke-incomplete");
  if (completed.platform === "native_linux" || !completed.publicInstall) {
    return {
      platform: completed.platform,
      omp_version: completed.ompVersion,
      evidence_written: false,
    };
  }

  const evidence: PlatformEvidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    observed_at: now().toISOString(),
    platform: completed.platform,
    architecture: completed.architecture,
    versions: {
      omp: completed.ompVersion,
      bun: completed.bunVersion,
      clasi: CLASI_VERSION,
    },
    omp_matrix: [{
      name: completed.matrixRow,
      omp_version: completed.ompVersion,
      result: "passed",
    }],
    checks: [
      { name: "package_local_status", result: "passed" },
      { name: "lossless_replacement", result: "passed" },
      { name: "lock_contention", result: "passed" },
      { name: "windows_sid_acl", result: completed.windowsSidAcl },
      { name: "path_normalization", result: "passed" },
      { name: "cleanup", result: "passed" },
    ],
    package_diagnostics: completed.packageDiagnostics,
  };
  const configuredDirectory = evidenceDirectory(process.env);
  const outputDirectory = isAbsolute(configuredDirectory)
    ? configuredDirectory
    : resolve(process.cwd(), configuredDirectory);
  await writePlatformEvidence(evidence, { evidenceDir: outputDirectory });
  return {
    platform: completed.platform,
    omp_version: completed.ompVersion,
    evidence_written: true,
  };
}

export function inspectDoctorOutput(stdout: string, manifest: unknown): NamedCheck[] {
  const value = parseJson(stdout, "doctor-json-invalid");
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) {
    throw new IsolationError("doctor-shape-invalid");
  }
  const checks = value.map(item => {
    if (!isRecord(item)) throw new IsolationError("doctor-shape-invalid");
    const keys = Object.keys(item).sort().join(",");
    if (keys !== "message,name,status" && keys !== "fixed,message,name,status") {
      throw new IsolationError("doctor-shape-invalid");
    }
    if (
      typeof item.name !== "string" ||
      typeof item.message !== "string" ||
      !["ok", "warning", "error"].includes(String(item.status)) ||
      ("fixed" in item && typeof item.fixed !== "boolean")
    ) {
      throw new IsolationError("doctor-shape-invalid");
    }
    return { name: item.name, status: item.status };
  });
  if (new Set(checks.map(check => check.name)).size !== checks.length) {
    throw new IsolationError("doctor-shape-invalid");
  }
  const pluginCheck = checks.find(check => check.name === "plugin:clasi");
  if (pluginCheck?.status !== "ok") throw new IsolationError("clasi-doctor-failed");
  if (checks.some(check => check.name.startsWith("plugin:clasi:") || check.name === "orphan:clasi")) {
    throw new IsolationError("clasi-doctor-failed");
  }
  assertExactManifest(manifest);
  return [
    { name: "plugin:clasi", result: "passed" },
    { name: "plugin:clasi:manifest", result: "passed" },
    { name: "plugin:clasi:extension:./src/index.ts", result: "passed" },
  ];
}

export function assertCapturedModelRequests(
  requests: readonly unknown[],
  skillGuidance: string,
): void {
  if (requests.length < 2 || requests.length > 4) {
    throw new IsolationError("model-request-count-invalid");
  }
  for (const marker of SKILL_MARKERS) {
    if (!skillGuidance.includes(marker)) throw new IsolationError("bundled-skill-invalid");
  }
  for (const request of requests) {
    if (!isRecord(request) || request.model !== SMOKE_MODEL || !Array.isArray(request.messages)) {
      throw new IsolationError("model-request-shape-invalid");
    }
    if (countOccurrences(JSON.stringify(request), CONTEXT_MARKER) !== 1) {
      throw new IsolationError("clasi-context-count-invalid");
    }
  }
  const finalRequest = JSON.stringify(requests.at(-1));
  for (const marker of SKILL_MARKERS) {
    if (!finalRequest.includes(marker)) throw new IsolationError("bundled-skill-missing");
  }
}

export function startOpenAIStub(): OpenAIStub {
  const requests: unknown[] = [];
  let unexpectedRequest = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (
        request.method !== "POST" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/v1/chat/completions" ||
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > MAX_JSON_BYTES
      ) {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_JSON_BYTES) {
        unexpectedRequest = true;
        return new Response("rejected", { status: 413 });
      }
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }
      requests.push(body);
      return requests.length === 1 ? toolCallResponse() : finalTextResponse();
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    get requests() {
      return requests;
    },
    get unexpectedRequest() {
      return unexpectedRequest;
    },
    clear() {
      requests.length = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}

export function parseOmpVersion(stdout: string): string {
  const match = /^omp\/(17\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(stdout);
  if (!match?.[1]) throw new IsolationError("omp-version-invalid");
  return match[1];
}

export function resolveMatrixRow(
  ompVersion: string,
  configuredRow: string | undefined,
): OmpMatrixRowName {
  const inferred: OmpMatrixRowName = ompVersion === MINIMUM_OMP_VERSION ? "minimum" : "latest_17";
  if (configuredRow !== undefined && configuredRow !== "minimum" && configuredRow !== "latest_17") {
    throw new IsolationError("omp-matrix-row-invalid");
  }
  if (configuredRow !== undefined && configuredRow !== inferred) {
    throw new IsolationError("omp-matrix-row-mismatch");
  }
  return inferred;
}

async function checked(adapter: ProcessAdapter, request: ProcessRequest) {
  return runCheckedProcess(adapter, {
    timeoutMs: PROCESS_TIMEOUT_MS,
    maxOutputBytes: MAX_JSON_BYTES,
    ...request,
  });
}

async function createSmokeEnvironment(roots: IsolatedRoots): Promise<Record<string, string>> {
  const temporary = join(roots.root, "tmp");
  assertPathInsideRoot(roots.root, temporary);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const environment: Record<string, string> = {
    ...roots.environment,
    PATH: process.env.PATH ?? "",
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    CI: "1",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (!environment.PATH) throw new IsolationError("missing-path");
  return environment;
}

async function copyPackageSource(sourceRoot: string, packageRoot: string): Promise<void> {
  await cp(sourceRoot, packageRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter(source) {
      const rel = relative(sourceRoot, source);
      if (!rel) return true;
      const segments = rel.split(sep);
      if (segments.includes(".git") || segments.includes("node_modules")) return false;
      return !(segments[0] === "release" && segments[1] === "evidence");
    },
  });
}

async function assertContainedTree(root: string): Promise<void> {
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (++visited > 20_000) throw new IsolationError("package-tree-too-large");
    if (current !== root) assertPathInsideRoot(root, current);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      assertPathInsideRoot(root, await realpath(current));
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const entry of await readdir(current)) queue.push(join(current, entry));
  }
}

async function assertPackageSource(packageRoot: string): Promise<unknown> {
  for (const relativePath of [
    "package.json",
    join("bin", "clasi.ts"),
    join("src", "index.ts"),
    join("skills", "clasi", "SKILL.md"),
  ]) {
    const path = join(packageRoot, relativePath);
    assertPathInsideRoot(packageRoot, path);
    await access(path);
  }
  const manifest = parseJson(
    await readFile(join(packageRoot, "package.json"), "utf8"),
    "manifest-json-invalid",
  );
  assertExactManifest(manifest);
  return manifest;
}

function assertExactManifest(value: unknown): void {
  if (!isRecord(value)) throw new IsolationError("manifest-invalid");
  if (
    value.name !== "clasi" ||
    value.version !== CLASI_VERSION ||
    !isRecord(value.omp) ||
    Object.keys(value.omp).sort().join(",") !== "extensions" ||
    !Array.isArray(value.omp.extensions) ||
    value.omp.extensions.length !== 1 ||
    value.omp.extensions[0] !== "./src/index.ts" ||
    !isRecord(value.bin) ||
    Object.keys(value.bin).join(",") !== "clasi" ||
    value.bin.clasi !== "./bin/clasi.ts" ||
    !isRecord(value.peerDependencies) ||
    value.peerDependencies["@oh-my-pi/pi-coding-agent"] !== ">=17.2.4 <18"
  ) {
    throw new IsolationError("manifest-invalid");
  }
}

async function initializeGitRepository(
  adapter: ProcessAdapter,
  git: string,
  packageRoot: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "clasi smoke"],
    ["config", "user.email", "clasi-smoke@example.invalid"],
    ["add", "--all"],
    ["commit", "--quiet", "-m", "smoke package"],
  ] as const) {
    await checked(adapter, { command: git, args, cwd: packageRoot, env });
  }
  const head = (await checked(adapter, {
    command: git,
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: packageRoot,
    env,
  })).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) throw new IsolationError("git-commit-invalid");
  return head;
}

async function prepareDumbGitRepository(
  adapter: ProcessAdapter,
  git: string,
  packageRoot: string,
  bareRepository: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  await checked(adapter, {
    command: git,
    args: ["clone", "--bare", "--no-local", packageRoot, bareRepository],
    cwd: dirname(bareRepository),
    env,
  });
  await checked(adapter, {
    command: git,
    args: ["--git-dir", bareRepository, "update-server-info"],
    cwd: dirname(bareRepository),
    env,
  });
  await assertContainedTree(bareRepository);
}

function startDumbGitTransport(
  bareRepository: string,
  commit: string,
): GitHttpTransport {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new IsolationError("git-commit-invalid");
  const root = resolve(bareRepository);
  let unexpectedRequest = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const prefix = "/clasi.git/";
      if (
        (request.method !== "GET" && request.method !== "HEAD") ||
        url.hostname !== "127.0.0.1" ||
        !url.pathname.startsWith(prefix)
      ) {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }

      let relativePath: string;
      try {
        relativePath = decodeURIComponent(url.pathname.slice(prefix.length));
      } catch {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }
      if (!relativePath || relativePath.includes("\0")) {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }

      const target = resolve(root, relativePath);
      try {
        assertPathInsideRoot(root, target);
      } catch {
        unexpectedRequest = true;
        return new Response("rejected", { status: 400 });
      }

      let stats;
      try {
        stats = await lstat(target);
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") {
          return new Response("not found", { status: 404 });
        }
        throw error;
      }
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1_024 * 1_024) {
        unexpectedRequest = true;
        return new Response("rejected", { status: 403 });
      }
      try {
        assertPathInsideRoot(root, await realpath(target));
      } catch {
        unexpectedRequest = true;
        return new Response("rejected", { status: 403 });
      }

      const headers = {
        "cache-control": "no-store",
        "content-length": String(stats.size),
        "content-type": relativePath === "HEAD" || relativePath === "info/refs"
          ? "text/plain; charset=utf-8"
          : "application/octet-stream",
      };
      return request.method === "HEAD"
        ? new Response(null, { status: 200, headers })
        : new Response(Bun.file(target), { status: 200, headers });
    },
  });
  return {
    installSpec: `git+http://127.0.0.1:${server.port}/clasi.git#${commit}`,
    get unexpectedRequest() {
      return unexpectedRequest;
    },
    stop() {
      server.stop(true);
    },
  };
}

function expectedInstallPaths(roots: IsolatedRoots, packageRoot: string) {
  const plugins = join(roots.home, ".omp", "plugins");
  return {
    packageRoot,
    plugins,
    pluginManifest: join(plugins, "package.json"),
    pluginModules: join(plugins, "node_modules"),
    pluginLock: join(plugins, "omp-plugins.lock.json"),
    pluginCache: join(plugins, "cache"),
    linkedPackage: join(plugins, "node_modules", "clasi"),
    models: join(roots.agent, "models.yml"),
    bunBin: join(roots.bunInstall, "bin"),
  };
}

async function writeModelsConfiguration(path: string, baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1") {
    throw new IsolationError("stub-url-invalid");
  }
  await writeFile(path, [
    "providers:",
    `  ${SMOKE_PROVIDER}:`,
    `    baseUrl: ${baseUrl}`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    `      - id: ${SMOKE_MODEL}`,
    "        name: clasi smoke model",
    "        reasoning: false",
    "        input: [text]",
    "        cost:",
    "          input: 0",
    "          output: 0",
    "          cacheRead: 0",
    "          cacheWrite: 0",
    "        contextWindow: 16384",
    "        maxTokens: 1024",
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
}

function assertClasiStatus(stdout: string, dataRoot: string): void {
  const value = parseJson(stdout, "clasi-status-invalid");
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    (value.status !== "ok" && value.status !== "partial") ||
    !isRecord(value.data) ||
    value.data.data_root !== dataRoot
  ) {
    throw new IsolationError("clasi-status-invalid");
  }
}

async function runLosslessReplacementCheck(roots: IsolatedRoots): Promise<void> {
  const directory = join(roots.root, "platform-checks", "replacement");
  const canonical = join(directory, "canonical");
  const preserved = join(directory, "preserved");
  const staging = join(directory, "staging");
  for (const path of [directory, canonical, preserved, staging]) {
    assertPathInsideRoot(roots.root, path);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(canonical, "before\n", { flag: "wx", mode: 0o600 });
  await link(canonical, preserved);
  await writeFile(staging, "after\n", { flag: "wx", mode: 0o600 });
  await rename(staging, canonical);
  assert.equal(await readFile(canonical, "utf8"), "after\n");
  assert.equal(await readFile(preserved, "utf8"), "before\n");
}

async function runLockContentionCheck(roots: IsolatedRoots): Promise<void> {
  const lockPath = join(roots.root, "platform-checks", "locks", "document");
  assertPathInsideRoot(roots.root, lockPath);
  const first = await acquireDocumentLock(lockPath, {
    ownerToken: "smoke-owner-a",
    pid: process.pid,
    processIdentity: "clasi-smoke-a",
    startedAt: "2026-08-09T00:00:00.000Z",
  });
  try {
    await assert.rejects(
      acquireDocumentLock(lockPath, {
        ownerToken: "smoke-owner-b",
        pid: process.pid,
        processIdentity: "clasi-smoke-b",
        startedAt: "2026-08-09T00:00:01.000Z",
      }),
      (error: unknown) => error instanceof LockError && error.code === "lock-held",
    );
  } finally {
    await first.release();
  }
}

function runPathNormalizationCheck(roots: IsolatedRoots): void {
  assert.equal(
    assertPathInsideRoot(roots.root, join(roots.root, "nested", "..", "normalized")),
    join(roots.root, "normalized"),
  );
  assert.throws(
    () => assertPathInsideRoot(roots.root, resolve(roots.root, "..", "escape")),
    (error: unknown) => error instanceof IsolationError && error.code === "path-escape",
  );
}

async function runWindowsBoundaryCheck(
  roots: IsolatedRoots,
): Promise<"passed" | "not_applicable"> {
  if (process.platform !== "win32") return "not_applicable";
  const pin = await pinRoot(roots.root);
  await assertRootUnchanged(pin);
  return "passed";
}

async function detectEvidencePlatform(): Promise<Platform | "native_linux"> {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform !== "linux") throw new IsolationError("unsupported-platform");
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return "wsl";
  try {
    const release = await readFile("/proc/sys/kernel/osrelease", "utf8");
    if (/microsoft/i.test(release)) return "wsl";
  } catch {
    // Native Linux remains a smoke target but cannot emit platform evidence.
  }
  return "native_linux";
}

function requireArchitecture(value: string): "x64" | "arm64" {
  if (value !== "x64" && value !== "arm64") {
    throw new IsolationError("unsupported-architecture");
  }
  return value;
}

function parseBunVersion(stdout: string): string {
  const value = stdout.trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new IsolationError("bun-version-invalid");
  }
  return value;
}

function parseAbsoluteSingleLine(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0] || !isAbsolute(lines[0])) {
    throw new IsolationError("global-bin-invalid");
  }
  return resolve(lines[0]);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new IsolationError("package-still-installed");
}

function parseJson(text: string, code: string): unknown {
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new IsolationError(code);
  try {
    return JSON.parse(text);
  } catch {
    throw new IsolationError(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = value.indexOf(needle, offset);
    if (next === -1) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function toolCallResponse(): Response {
  return sseResponse([
    completionChunk({
      role: "assistant",
      content: null,
      tool_calls: [{
        index: 0,
        id: "call_clasi_skill_read",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({ path: "skill://clasi" }),
        },
      }],
    }, null),
    completionChunk({}, "tool_calls"),
  ]);
}

function finalTextResponse(): Response {
  return sseResponse([
    completionChunk({ role: "assistant", content: "smoke complete" }, null),
    completionChunk({}, "stop"),
  ]);
}

function completionChunk(delta: object, finishReason: string | null): object {
  return {
    id: "chatcmpl-clasi-smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: SMOKE_MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseResponse(chunks: readonly object[]): Response {
  const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

if (import.meta.main) {
  const result = await runOmpSmoke();
  console.log(`smoke-omp: passed (${result.platform}, omp ${result.omp_version})`);
}
