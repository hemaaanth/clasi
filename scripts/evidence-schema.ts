import { access, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CLASI_VERSION = "0.1.0" as const;
export const MINIMUM_OMP_VERSION = "17.2.4" as const;
export const MODEL_EVAL_TOTAL = 10 as const;
export const MODEL_EVAL_THRESHOLD = 8 as const;
export const DEFAULT_EVIDENCE_DIRECTORY = join("release", "evidence");
export const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_EVIDENCE_FILE_BYTES = 64 * 1_024;

export const PLATFORMS = ["wsl", "macos", "windows"] as const;
export const OMP_MATRIX_ROWS = ["minimum", "latest_17"] as const;
export const REQUIRED_PLATFORM_CHECKS = [
  "package_local_status",
  "lossless_replacement",
  "lock_contention",
  "windows_sid_acl",
  "path_normalization",
  "cleanup",
] as const;
export const REQUIRED_MODEL_CHECKS = [
  "external_adapter",
  "identity_match",
  "decision_threshold",
] as const;

export type Platform = (typeof PLATFORMS)[number];
export type CheckResult = "passed" | "failed" | "not_applicable";
export type OmpMatrixRowName = (typeof OMP_MATRIX_ROWS)[number];

export interface NamedCheck {
  name: string;
  result: CheckResult;
}

export interface OmpMatrixRow {
  name: OmpMatrixRowName;
  omp_version: string;
  result: CheckResult;
}

export interface PlatformEvidence {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  observed_at: string;
  platform: Platform;
  architecture: "x64" | "arm64";
  versions: {
    omp: string;
    bun: string;
    clasi: typeof CLASI_VERSION;
  };
  omp_matrix: OmpMatrixRow[];
  checks: NamedCheck[];
  package_diagnostics: NamedCheck[];
}

export interface ModelEvidence {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  observed_at: string;
  requested_model: string;
  served_model: string;
  total: typeof MODEL_EVAL_TOTAL;
  correct: number;
  threshold: typeof MODEL_EVAL_THRESHOLD;
  checks: NamedCheck[];
}

export interface ValidationOptions {
  now?: number;
  maxAgeMs?: number;
}

export interface EvidenceWriterOptions extends ValidationOptions {
  evidenceDir?: string;
}

export class EvidenceValidationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "EvidenceValidationError";
    this.code = code;
  }
}

const FORBIDDEN_KEY_PART = /(?:^|_)(?:raw|path|error|prompt|output|transcript|command|content|source|credential|secret|environment)(?:_|$)/i;
const FORBIDDEN_STRING_PART = /(?:^|[\s._:-])(?:raw|error|prompt|output|transcript|terminal|credential|secret|sentinel)(?:[\s._:-]|$)/i;
const SECRET_SHAPE = /(?:\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,})/i;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_DIAGNOSTIC_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/+-]{0,127}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PLATFORM_KEYS = [
  "schema_version",
  "observed_at",
  "platform",
  "architecture",
  "versions",
  "omp_matrix",
  "checks",
  "package_diagnostics",
] as const;
const MODEL_KEYS = [
  "schema_version",
  "observed_at",
  "requested_model",
  "served_model",
  "total",
  "correct",
  "threshold",
  "checks",
] as const;

export function evidenceDirectory(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLASI_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIRECTORY;
}

export function validatePlatformEvidence(
  value: unknown,
  expectedPlatform?: Platform,
  options: ValidationOptions = {},
): PlatformEvidence {
  return validatePlatformEvidenceRows(value, expectedPlatform, options, true);
}

function validatePlatformEvidenceRows(
  value: unknown,
  expectedPlatform: Platform | undefined,
  options: ValidationOptions,
  requireCompleteMatrix: boolean,
): PlatformEvidence {
  assertSafeTree(value);
  const evidence = assertObject(value, "invalid_platform_evidence");
  assertExactKeys(evidence, PLATFORM_KEYS, "invalid_platform_evidence");
  assertEqual(evidence.schema_version, EVIDENCE_SCHEMA_VERSION, "unsupported_schema");
  validateTimestamp(evidence.observed_at, options);

  if (!PLATFORMS.includes(evidence.platform as Platform)) {
    fail("unsupported_platform");
  }
  const platform = evidence.platform as Platform;
  if (expectedPlatform !== undefined && platform !== expectedPlatform) {
    fail("platform_identity_mismatch");
  }
  if (evidence.architecture !== "x64" && evidence.architecture !== "arm64") {
    fail("unsupported_architecture");
  }

  const versions = assertObject(evidence.versions, "invalid_versions");
  assertExactKeys(versions, ["omp", "bun", "clasi"], "invalid_versions");
  assertSupportedOmpVersion(versions.omp);
  assertSemver(versions.bun, "unsupported_bun_version");
  assertEqual(versions.clasi, CLASI_VERSION, "unsupported_clasi_version");

  const matrix = validateOmpMatrix(evidence.omp_matrix, requireCompleteMatrix);
  if (!matrix.some(row => row.result === "passed")) {
    fail("platform_matrix_missing_pass");
  }
  if (!matrix.some(row => row.result === "passed" && row.omp_version === versions.omp)) {
    fail("platform_version_not_observed");
  }

  const checks = validateNamedChecks(evidence.checks, REQUIRED_PLATFORM_CHECKS);
  if (
    REQUIRED_PLATFORM_CHECKS.some(
      name => name !== "windows_sid_acl" &&
        checks.find(check => check.name === name)?.result !== "passed",
    )
  ) {
    fail("required_check_not_passed");
  }
  const sidCheck = checks.find(check => check.name === "windows_sid_acl");
  if (
    (platform === "windows" && sidCheck?.result !== "passed") ||
    (platform !== "windows" && sidCheck?.result !== "not_applicable")
  ) {
    fail("invalid_windows_boundary_check");
  }

  const packageDiagnostics = validateNamedChecks(evidence.package_diagnostics, [], true);
  if (packageDiagnostics.length === 0 || packageDiagnostics.some(check => check.result !== "passed")) {
    fail("invalid_package_diagnostics");
  }

  return value as PlatformEvidence;
}

export function validateModelEvidence(
  value: unknown,
  options: ValidationOptions = {},
): ModelEvidence {
  assertSafeTree(value);
  const evidence = assertObject(value, "invalid_model_evidence");
  assertExactKeys(evidence, MODEL_KEYS, "invalid_model_evidence");
  assertEqual(evidence.schema_version, EVIDENCE_SCHEMA_VERSION, "unsupported_schema");
  validateTimestamp(evidence.observed_at, options);
  assertModelId(evidence.requested_model);
  assertModelId(evidence.served_model);
  assertEqual(evidence.requested_model, evidence.served_model, "model_identity_mismatch");
  assertEqual(evidence.total, MODEL_EVAL_TOTAL, "invalid_model_total");
  assertEqual(evidence.threshold, MODEL_EVAL_THRESHOLD, "invalid_model_threshold");
  if (
    !Number.isInteger(evidence.correct) ||
    (evidence.correct as number) < MODEL_EVAL_THRESHOLD ||
    (evidence.correct as number) > MODEL_EVAL_TOTAL
  ) {
    fail("model_threshold_not_met");
  }
  const checks = validateNamedChecks(evidence.checks, REQUIRED_MODEL_CHECKS);
  if (checks.some(check => check.result !== "passed")) {
    fail("required_check_not_passed");
  }
  return value as ModelEvidence;
}

export async function writePlatformEvidence(
  evidence: PlatformEvidence,
  options: EvidenceWriterOptions = {},
): Promise<void> {
  const validated = validatePlatformEvidenceRows(evidence, evidence.platform, options, false);
  const directory = options.evidenceDir ?? evidenceDirectory();
  const filename = `${validated.platform}.json`;
  const destination = join(directory, filename);
  let rows = validated.omp_matrix;
  let exists = false;
  try {
    await access(destination);
    exists = true;
  } catch (cause) {
    if (
      typeof cause !== "object" ||
      cause === null ||
      !("code" in cause) ||
      cause.code !== "ENOENT"
    ) {
      fail("evidence_read_failed");
    }
  }
  if (exists) {
    const previous = validatePlatformEvidenceRows(
      await readEvidenceFile(directory, filename),
      validated.platform,
      options,
      false,
    );
    if (previous.architecture !== validated.architecture) {
      fail("platform_identity_mismatch");
    }
    const replacing = new Set(rows.map(row => row.name));
    rows = [...previous.omp_matrix.filter(row => !replacing.has(row.name)), ...rows]
      .sort((left, right) => OMP_MATRIX_ROWS.indexOf(left.name) - OMP_MATRIX_ROWS.indexOf(right.name));
  }
  const merged: PlatformEvidence = { ...validated, omp_matrix: rows };
  if (rows.length === OMP_MATRIX_ROWS.length) {
    validatePlatformEvidence(merged, merged.platform, options);
  } else {
    validatePlatformEvidenceRows(merged, merged.platform, options, false);
  }
  await writeValidatedEvidence(filename, merged, options);
}

export async function writeModelEvidence(
  evidence: ModelEvidence,
  options: EvidenceWriterOptions = {},
): Promise<void> {
  const validated = validateModelEvidence(evidence, options);
  await writeValidatedEvidence("model.json", validated, options);
}

export async function readPlatformEvidence(
  directory: string,
  platform: Platform,
  options: ValidationOptions = {},
): Promise<PlatformEvidence> {
  return validatePlatformEvidence(await readEvidenceFile(directory, `${platform}.json`), platform, options);
}

export async function readModelEvidence(
  directory: string,
  options: ValidationOptions = {},
): Promise<ModelEvidence> {
  return validateModelEvidence(await readEvidenceFile(directory, "model.json"), options);
}

function validateOmpMatrix(value: unknown, requireComplete: boolean): OmpMatrixRow[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > OMP_MATRIX_ROWS.length ||
    (requireComplete && value.length !== OMP_MATRIX_ROWS.length)
  ) {
    fail("invalid_omp_matrix");
  }
  const rows = value.map(item => {
    const row = assertObject(item, "invalid_omp_matrix_row");
    assertExactKeys(row, ["name", "omp_version", "result"], "invalid_omp_matrix_row");
    if (!OMP_MATRIX_ROWS.includes(row.name as OmpMatrixRowName)) {
      fail("unsupported_omp_matrix_row");
    }
    assertSupportedOmpVersion(row.omp_version);
    assertCheckResult(row.result);
    if (row.result === "failed") {
      fail("failed_check");
    }
    if (row.name === "minimum" && row.omp_version !== MINIMUM_OMP_VERSION) {
      fail("unsupported_omp_matrix_row");
    }
    return row as unknown as OmpMatrixRow;
  });
  if (new Set(rows.map(row => row.name)).size !== rows.length) {
    fail("duplicate_omp_matrix_row");
  }
  if (requireComplete) {
    for (const name of OMP_MATRIX_ROWS) {
      if (!rows.some(row => row.name === name)) {
        fail("missing_omp_matrix_row");
      }
    }
  }
  return rows;
}

function validateNamedChecks(
  value: unknown,
  requiredNames: readonly string[],
  diagnosticNames = false,
): NamedCheck[] {
  if (!Array.isArray(value)) {
    fail("invalid_checks");
  }
  const checks = value.map(item => {
    const check = assertObject(item, "invalid_check");
    assertExactKeys(check, ["name", "result"], "invalid_check");
    if (
      typeof check.name !== "string" ||
      !(diagnosticNames ? SAFE_DIAGNOSTIC_NAME : SAFE_NAME).test(check.name)
    ) {
      fail("unsafe_check_name");
    }
    assertCheckResult(check.result);
    if (check.result === "failed") {
      fail("failed_check");
    }
    return check as unknown as NamedCheck;
  });
  if (new Set(checks.map(check => check.name)).size !== checks.length) {
    fail("duplicate_check");
  }
  for (const required of requiredNames) {
    if (!checks.some(check => check.name === required)) {
      fail("missing_check");
    }
  }
  return checks;
}

function validateTimestamp(value: unknown, options: ValidationOptions): void {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    fail("malformed_timestamp");
  }
  const observed = Date.parse(value);
  if (!Number.isFinite(observed) || new Date(observed).toISOString() !== value) {
    fail("malformed_timestamp");
  }
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? MAX_EVIDENCE_AGE_MS;
  if (observed < now - maxAge || observed > now + 5 * 60 * 1_000) {
    fail("stale_timestamp");
  }
}

function assertSupportedOmpVersion(value: unknown): asserts value is string {
  assertSemver(value, "unsupported_omp_version");
  const match = SEMVER.exec(value);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  if (
    major !== 17 ||
    minor < 2 ||
    (minor === 2 && patch < 4)
  ) {
    fail("unsupported_omp_version");
  }
}

function assertSemver(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    fail(code);
  }
}

function assertModelId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_MODEL_ID.test(value)) {
    fail("unsafe_model_identity");
  }
}

function assertCheckResult(value: unknown): asserts value is CheckResult {
  if (value !== "passed" && value !== "failed" && value !== "not_applicable") {
    fail("invalid_check_result");
  }
}

function assertSafeTree(value: unknown): void {
  if (typeof value === "string") {
    if (
      value.length === 0 ||
      value.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      value.startsWith("/") ||
      value.startsWith("~/") ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.startsWith("\\\\") ||
      value.toLowerCase().startsWith("file://") ||
      SECRET_SHAPE.test(value) ||
      FORBIDDEN_STRING_PART.test(value)
    ) {
      fail("unsafe_string");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY_PART.test(key)) {
        fail("unsafe_key");
      }
      assertSafeTree(item);
    }
  }
}

function assertObject(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    fail(code);
  }
}


function assertEqual(actual: unknown, expected: unknown, code: string): void {
  if (actual !== expected) fail(code);
}

function fail(code: string): never {
  throw new EvidenceValidationError(code);
}

async function writeValidatedEvidence(
  filename: string,
  evidence: PlatformEvidence | ModelEvidence,
  options: EvidenceWriterOptions,
): Promise<void> {
  const directory = options.evidenceDir ?? evidenceDirectory();
  const temporary = join(directory, `.evidence-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, join(directory, filename));
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    if (cause instanceof EvidenceValidationError) throw cause;
    fail("evidence_write_failed");
  }
}

async function readEvidenceFile(directory: string, filename: string): Promise<unknown> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(join(directory, filename), "r");
    const information = await handle.stat();
    if (!information.isFile() || information.size > MAX_EVIDENCE_FILE_BYTES) {
      fail("invalid_evidence_file");
    }
    const bytes = Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_EVIDENCE_FILE_BYTES) {
      fail("invalid_evidence_file");
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } catch (cause) {
    if (cause instanceof EvidenceValidationError) throw cause;
    fail("invalid_evidence_file");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
