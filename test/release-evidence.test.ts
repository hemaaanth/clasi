import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvidenceValidationError,
  MODEL_EVAL_THRESHOLD,
  type ModelEvidence,
  type OmpMatrixRow,
  type Platform,
  type PlatformEvidence,
  validateModelEvidence,
  validatePlatformEvidence,
  writeModelEvidence,
  writePlatformEvidence,
} from "../scripts/evidence-schema.ts";
import {
  MODEL_EVAL_SCENARIOS,
  ModelEvalChoiceRequiredError,
  runModelEvaluation,
} from "../scripts/model-eval.ts";
import { validateReleaseEvidenceDirectory } from "../scripts/release-validate.ts";

const NOW = Date.parse("2026-08-09T18:00:00.000Z");
const OBSERVED_AT = new Date(NOW).toISOString();
const MODEL = "openai/gpt-5.6-sol";
const REQUIRED_FILES = ["wsl.json", "macos.json", "windows.json", "model.json"] as const;

function platformEvidence(
  platform: Platform,
  ompMatrix: OmpMatrixRow[] = [
    { name: "minimum", omp_version: "17.2.4", result: "passed" },
    { name: "latest_17", omp_version: "17.2.4", result: "passed" },
  ],
): PlatformEvidence {
  return {
    schema_version: 1,
    observed_at: OBSERVED_AT,
    platform,
    architecture: platform === "macos" ? "arm64" : "x64",
    versions: { omp: "17.2.4", bun: "1.3.14", clasi: "0.1.0" },
    omp_matrix: ompMatrix,
    checks: [
      { name: "package_local_status", result: "passed" },
      { name: "lossless_replacement", result: "passed" },
      { name: "lock_contention", result: "passed" },
      {
        name: "windows_sid_acl",
        result: platform === "windows" ? "passed" : "not_applicable",
      },
      { name: "path_normalization", result: "passed" },
      { name: "cleanup", result: "passed" },
    ],
    package_diagnostics: [
      { name: "package manifest", result: "passed" },
      { name: "declared extension", result: "passed" },
    ],
  };
}

function modelEvidence(correct: number = MODEL_EVAL_THRESHOLD): ModelEvidence {
  return {
    schema_version: 1,
    observed_at: OBSERVED_AT,
    requested_model: MODEL,
    served_model: MODEL,
    total: 10,
    correct,
    threshold: 8,
    checks: [
      { name: "external_adapter", result: "passed" },
      { name: "identity_match", result: "passed" },
      { name: "decision_threshold", result: "passed" },
    ],
  };
}

async function writeValidSet(directory: string): Promise<void> {
  await Promise.all([
    writePlatformEvidence(platformEvidence("wsl"), { evidenceDir: directory, now: NOW }),
    writePlatformEvidence(platformEvidence("macos"), { evidenceDir: directory, now: NOW }),
    writePlatformEvidence(platformEvidence("windows"), { evidenceDir: directory, now: NOW }),
    writeModelEvidence(modelEvidence(), { evidenceDir: directory, now: NOW }),
  ]);
}

async function withEvidenceDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clasi-release-evidence-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function adapterDecisions(): { scenario_id: string; decision: string }[] {
  return MODEL_EVAL_SCENARIOS.map(scenario => ({
    scenario_id: scenario.scenario_id,
    decision: scenario.expected,
  }));
}

async function writeAdapter(
  directory: string,
  servedModel: string,
  decisions = adapterDecisions(),
  extraResponse = "",
): Promise<string> {
  const adapter = join(directory, "recorded-model-adapter.ts");
  await writeFile(
    adapter,
    `const request = await Bun.stdin.json();\n` +
      `console.log(JSON.stringify({ requested_model: request.requested_model, served_model: ${JSON.stringify(servedModel)}, decisions: ${JSON.stringify(decisions)}${extraResponse} }));\n`,
    "utf8",
  );
  return adapter;
}

function modelEvalEnvironment(adapter: string): Record<string, string> {
  return {
    CLASI_MODEL_EVAL_COMMAND: process.execPath,
    CLASI_MODEL_EVAL_ARGS_JSON: JSON.stringify([adapter]),
    CLASI_MODEL_EVAL_REQUESTED_MODEL: MODEL,
  };
}

describe("release evidence", () => {
  test("accepts one valid evidence file for every required gate", async () => {
    await withEvidenceDirectory(async directory => {
      await writeValidSet(directory);
      const release = await validateReleaseEvidenceDirectory(directory, { now: NOW });
      expect(Object.keys(release.platforms).sort()).toEqual(["macos", "windows", "wsl"]);
      expect(release.model.correct).toBe(8);
    });
  });

  test.each([...REQUIRED_FILES])("rejects a missing %s", async missing => {
    await withEvidenceDirectory(async directory => {
      await writeValidSet(directory);
      await rm(join(directory, missing));
      await expect(validateReleaseEvidenceDirectory(directory, { now: NOW })).rejects.toThrow();
    });
  });

  test("release CLI fails without disclosing the selected directory", async () => {
    await withEvidenceDirectory(async directory => {
      const subprocess = Bun.spawn([process.execPath, "scripts/release-validate.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, CLASI_EVIDENCE_DIR: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).not.toContain(directory);
    });
  });

  test("rejects extra keys and unsafe string values", () => {
    expect(() => validatePlatformEvidence(
      { ...platformEvidence("wsl"), note: "aggregate" },
      "wsl",
      { now: NOW },
    )).toThrow(EvidenceValidationError);
    expect(() => validateModelEvidence(
      { ...modelEvidence(), requested_model: "/private/model", served_model: "/private/model" },
      { now: NOW },
    )).toThrow(EvidenceValidationError);
    expect(() => validateModelEvidence(
      { ...modelEvidence(), requested_model: "raw_sentinel", served_model: "raw_sentinel" },
      { now: NOW },
    )).toThrow(EvidenceValidationError);
  });

  test.each(["raw_output", "source_path", "error_detail", "prompt_text", "command_output"])(
    "rejects unsafe evidence key %s",
    unsafeKey => {
      expect(() => validatePlatformEvidence(
        { ...platformEvidence("wsl"), [unsafeKey]: "omitted" },
        "wsl",
        { now: NOW },
      )).toThrow("unsafe_key");
    },
  );

  test("rejects failed platform rows and checks", () => {
    const failedRow = platformEvidence("wsl");
    failedRow.omp_matrix[0] = { name: "minimum", omp_version: "17.2.4", result: "failed" };
    expect(() => validatePlatformEvidence(failedRow, "wsl", { now: NOW })).toThrow("failed_check");

    const failedCheck = platformEvidence("wsl");
    failedCheck.checks[0] = { name: "package_local_status", result: "failed" };
    expect(() => validatePlatformEvidence(failedCheck, "wsl", { now: NOW })).toThrow("failed_check");
  });

  test("accepts model threshold 8 of 10 and rejects 7 of 10", () => {
    expect(validateModelEvidence(modelEvidence(8), { now: NOW }).correct).toBe(8);
    expect(() => validateModelEvidence(modelEvidence(7), { now: NOW })).toThrow(
      "model_threshold_not_met",
    );
  });

  test("rejects requested and served model identity mismatch", () => {
    expect(() => validateModelEvidence(
      { ...modelEvidence(), served_model: "openai/gpt-5.6-other" },
      { now: NOW },
    )).toThrow("model_identity_mismatch");
  });

  test("rejects malformed and stale timestamps", () => {
    expect(() => validateModelEvidence(
      { ...modelEvidence(), observed_at: "2026-08-09" },
      { now: NOW },
    )).toThrow("malformed_timestamp");
    expect(() => validateModelEvidence(
      { ...modelEvidence(), observed_at: "2026-01-01T00:00:00.000Z" },
      { now: NOW },
    )).toThrow("stale_timestamp");
  });

  test("rejects unsupported platform and OMP matrix rows", () => {
    expect(() => validatePlatformEvidence(
      { ...platformEvidence("wsl"), platform: "linux" },
      undefined,
      { now: NOW },
    )).toThrow("unsupported_platform");
    const unsupported = platformEvidence("wsl");
    unsupported.omp_matrix[1] = {
      name: "latest_17",
      omp_version: "18.0.0",
      result: "passed",
    };
    expect(() => validatePlatformEvidence(unsupported, "wsl", { now: NOW })).toThrow(
      "unsupported_omp_version",
    );
  });

  test("merges separately observed OMP rows without inventing the other row", async () => {
    await withEvidenceDirectory(async directory => {
      await writePlatformEvidence(
        platformEvidence("wsl", [
          { name: "minimum", omp_version: "17.2.4", result: "passed" },
        ]),
        { evidenceDir: directory, now: NOW },
      );
      const partial = JSON.parse(await readFile(join(directory, "wsl.json"), "utf8"));
      expect(partial.omp_matrix).toHaveLength(1);

      await writePlatformEvidence(
        platformEvidence("wsl", [
          { name: "latest_17", omp_version: "17.2.4", result: "passed" },
        ]),
        { evidenceDir: directory, now: NOW },
      );
      expect(validatePlatformEvidence(
        JSON.parse(await readFile(join(directory, "wsl.json"), "utf8")),
        "wsl",
        { now: NOW },
      ).omp_matrix).toHaveLength(2);
    });
  });

  test("requires an explicit adapter and creates no model file when none is chosen", async () => {
    await withEvidenceDirectory(async directory => {
      await expect(runModelEvaluation({ env: {}, evidenceDir: directory, now: NOW })).rejects.toBeInstanceOf(
        ModelEvalChoiceRequiredError,
      );
      expect(await Bun.file(join(directory, "model.json")).exists()).toBeFalse();
    });
  });

  test("records only safe aggregate model evidence after an adapter run", async () => {
    await withEvidenceDirectory(async directory => {
      const adapter = await writeAdapter(directory, MODEL);
      await runModelEvaluation({
        env: modelEvalEnvironment(adapter),
        evidenceDir: directory,
        now: NOW,
      });
      const stored = await readFile(join(directory, "model.json"), "utf8");
      expect(stored).not.toContain("scenario_01");
      expect(stored).not.toContain("A host fact was verified");
      expect(stored).not.toContain("decisions");
      expect(stored).not.toMatch(/raw|prompt|transcript|terminal output/i);
      expect(Object.keys(JSON.parse(stored)).sort()).toEqual([
        "checks",
        "correct",
        "observed_at",
        "requested_model",
        "schema_version",
        "served_model",
        "threshold",
        "total",
      ]);
    });
  });

  test("writes no model evidence below threshold or on identity mismatch", async () => {
    await withEvidenceDirectory(async directory => {
      const belowThreshold = await writeAdapter(
        directory,
        MODEL,
        adapterDecisions().map((decision, index) =>
          index < 3 ? { ...decision, decision: "skip" } : decision
        ),
      );
      await expect(runModelEvaluation({
        env: modelEvalEnvironment(belowThreshold),
        evidenceDir: directory,
        now: NOW,
      })).rejects.toThrow("model_eval_threshold_not_met");
      expect(await Bun.file(join(directory, "model.json")).exists()).toBeFalse();

      const mismatched = await writeAdapter(directory, "openai/gpt-5.6-other");
      await expect(runModelEvaluation({
        env: modelEvalEnvironment(mismatched),
        evidenceDir: directory,
        now: NOW,
      })).rejects.toThrow("model_eval_identity_mismatch");
      expect(await Bun.file(join(directory, "model.json")).exists()).toBeFalse();
    });
  });

  test("rejects adapter responses carrying raw-output-like fields", async () => {
    await withEvidenceDirectory(async directory => {
      const adapter = await writeAdapter(
        directory,
        MODEL,
        adapterDecisions(),
        `, raw_output: "do not persist"`,
      );
      await expect(runModelEvaluation({
        env: modelEvalEnvironment(adapter),
        evidenceDir: directory,
        now: NOW,
      })).rejects.toThrow("model_eval_adapter_failed");
      expect(await Bun.file(join(directory, "model.json")).exists()).toBeFalse();
    });
  });
});
