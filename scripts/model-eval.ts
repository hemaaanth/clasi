import {
  MODEL_EVAL_THRESHOLD,
  MODEL_EVAL_TOTAL,
  writeModelEvidence,
  type CheckResult,
  type ModelEvidence,
} from "./evidence-schema.ts";

const MAX_ADAPTER_OUTPUT_BYTES = 32 * 1_024;
const ADAPTER_TIMEOUT_MS = 2 * 60 * 1_000;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DECISIONS = ["capture_context", "capture_napkin", "capture_papercut", "skip"] as const;

type CaptureDecision = (typeof DECISIONS)[number];

export interface ModelEvalScenario {
  scenario_id: string;
  category: string;
  scenario: string;
  expected: CaptureDecision;
}

export const MODEL_EVAL_SCENARIOS: readonly ModelEvalScenario[] = [
  {
    scenario_id: "scenario_01",
    category: "verified_machine_fact",
    scenario: "A host fact was verified through a structured API and will remain useful in later sessions on this machine. Choose the clasi capture action.",
    expected: "capture_context",
  },
  {
    scenario_id: "scenario_02",
    category: "stable_repository_convention",
    scenario: "A repository convention was confirmed from maintained configuration and should guide future work in this repository. Choose the clasi capture action.",
    expected: "capture_context",
  },
  {
    scenario_id: "scenario_03",
    category: "generalized_reusable_lesson",
    scenario: "A completed fix produced a short generalized constraint that prevents the same class of mistake without retaining source material. Choose the clasi capture action.",
    expected: "capture_napkin",
  },
  {
    scenario_id: "scenario_04",
    category: "verified_tool_caveat",
    scenario: "A tool behavior was reproduced twice and can be expressed as a durable safe do-instead rule. Choose the clasi capture action.",
    expected: "capture_napkin",
  },
  {
    scenario_id: "scenario_05",
    category: "recurring_actionable_friction",
    scenario: "The same fixable workflow failure has recurred and has a bounded cause plus a verifiable acceptance condition. Choose the clasi capture action.",
    expected: "capture_papercut",
  },
  {
    scenario_id: "scenario_06",
    category: "repeated_papercut",
    scenario: "A known open friction point happened again with the same canonical fingerprint and remains actionable. Choose the clasi capture action.",
    expected: "capture_papercut",
  },
  {
    scenario_id: "scenario_07",
    category: "one_off_typo",
    scenario: "A single typing mistake was corrected immediately and reveals no durable constraint or recurring fixable cause. Choose the clasi capture action.",
    expected: "skip",
  },
  {
    scenario_id: "scenario_08",
    category: "unverified_speculation",
    scenario: "There is an unverified guess about why a command was slow, with no reproduction or stable observation. Choose the clasi capture action.",
    expected: "skip",
  },
  {
    scenario_id: "scenario_09",
    category: "excluded_sensitive_material",
    scenario: "The only available description contains excluded private material and cannot be generalized safely at the structured boundary. Choose the clasi capture action.",
    expected: "skip",
  },
  {
    scenario_id: "scenario_10",
    category: "ephemeral_task_progress",
    scenario: "A current task step completed successfully, but the event adds no reusable guidance or actionable recurring friction. Choose the clasi capture action.",
    expected: "skip",
  },
] as const;

interface AdapterDecision {
  scenario_id: string;
  decision: CaptureDecision;
}

interface AdapterResponse {
  requested_model: string;
  served_model: string;
  decisions: AdapterDecision[];
}

export class ModelEvalChoiceRequiredError extends Error {
  constructor() {
    super("model_eval_choice_required");
    this.name = "ModelEvalChoiceRequiredError";
  }
}

export interface ModelEvalOptions {
  env?: Record<string, string | undefined>;
  now?: number;
  evidenceDir?: string;
}

export async function runModelEvaluation(options: ModelEvalOptions = {}): Promise<ModelEvidence> {
  const env = options.env ?? process.env;
  const command = env.CLASI_MODEL_EVAL_COMMAND;
  const requestedModel = env.CLASI_MODEL_EVAL_REQUESTED_MODEL;
  if (!command || !requestedModel) {
    throw new ModelEvalChoiceRequiredError();
  }
  if (
    command.length > 4_096 ||
    command.includes("\0") ||
    !SAFE_MODEL_ID.test(requestedModel)
  ) {
    throw new ModelEvalChoiceRequiredError();
  }
  const args = parseAdapterArguments(env.CLASI_MODEL_EVAL_ARGS_JSON);
  const request = JSON.stringify({
    schema_version: 1,
    requested_model: requestedModel,
    scenarios: MODEL_EVAL_SCENARIOS.map(({ scenario_id, scenario }) => ({ scenario_id, scenario })),
  });
  const output = await executeAdapter(command, args, request, env);
  const response = parseAdapterResponse(output);
  if (
    response.requested_model !== requestedModel ||
    response.served_model !== requestedModel
  ) {
    throw new Error("model_eval_identity_mismatch");
  }

  const expectedByScenario = new Map(
    MODEL_EVAL_SCENARIOS.map(scenario => [scenario.scenario_id, scenario.expected]),
  );
  const correct = response.decisions.reduce(
    (count, decision) => count + Number(expectedByScenario.get(decision.scenario_id) === decision.decision),
    0,
  );
  if (correct < MODEL_EVAL_THRESHOLD) {
    throw new Error("model_eval_threshold_not_met");
  }

  const passed: CheckResult = "passed";
  const evidence: ModelEvidence = {
    schema_version: 1,
    observed_at: new Date(options.now ?? Date.now()).toISOString(),
    requested_model: requestedModel,
    served_model: response.served_model,
    total: MODEL_EVAL_TOTAL,
    correct,
    threshold: MODEL_EVAL_THRESHOLD,
    checks: [
      { name: "external_adapter", result: passed },
      { name: "identity_match", result: passed },
      { name: "decision_threshold", result: passed },
    ],
  };
  const selectedDirectory = options.evidenceDir ?? env.CLASI_EVIDENCE_DIR;
  await writeModelEvidence(evidence, {
    ...(selectedDirectory === undefined ? {} : { evidenceDir: selectedDirectory }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return evidence;
}

function parseAdapterArguments(value: string | undefined): string[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ModelEvalChoiceRequiredError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    parsed.some(argument => typeof argument !== "string" || argument.length > 4_096 || argument.includes("\0"))
  ) {
    throw new ModelEvalChoiceRequiredError();
  }
  return parsed as string[];
}

async function executeAdapter(
  command: string,
  args: readonly string[],
  request: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const subprocess = Bun.spawn([command, ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  subprocess.stdin.write(request);
  subprocess.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, ADAPTER_TIMEOUT_MS);
  try {
    const [output, exitCode] = await Promise.all([
      readBoundedOutput(subprocess.stdout, MAX_ADAPTER_OUTPUT_BYTES),
      subprocess.exited,
    ]);
    if (timedOut || exitCode !== 0) throw new Error("model_eval_adapter_failed");
    return output;
  } catch {
    subprocess.kill();
    await subprocess.exited.catch(() => undefined);
    throw new Error("model_eval_adapter_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) throw new Error("model_eval_adapter_failed");
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function parseAdapterResponse(output: string): AdapterResponse {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("model_eval_adapter_failed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("model_eval_adapter_failed");
  }
  const response = value as Record<string, unknown>;
  assertExactKeys(response, ["requested_model", "served_model", "decisions"]);
  if (
    typeof response.requested_model !== "string" ||
    typeof response.served_model !== "string" ||
    !SAFE_MODEL_ID.test(response.requested_model) ||
    !SAFE_MODEL_ID.test(response.served_model) ||
    !Array.isArray(response.decisions) ||
    response.decisions.length !== MODEL_EVAL_TOTAL
  ) {
    throw new Error("model_eval_adapter_failed");
  }
  const decisions = response.decisions.map(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("model_eval_adapter_failed");
    }
    const decision = item as Record<string, unknown>;
    assertExactKeys(decision, ["scenario_id", "decision"]);
    if (
      typeof decision.scenario_id !== "string" ||
      !MODEL_EVAL_SCENARIOS.some(scenario => scenario.scenario_id === decision.scenario_id) ||
      !DECISIONS.includes(decision.decision as CaptureDecision)
    ) {
      throw new Error("model_eval_adapter_failed");
    }
    return decision as unknown as AdapterDecision;
  });
  if (new Set(decisions.map(decision => decision.scenario_id)).size !== MODEL_EVAL_TOTAL) {
    throw new Error("model_eval_adapter_failed");
  }
  return {
    requested_model: response.requested_model,
    served_model: response.served_model,
    decisions,
  };
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new Error("model_eval_adapter_failed");
  }
}

if (import.meta.main) {
  try {
    await runModelEvaluation();
    console.log("model evidence recorded");
  } catch (cause) {
    if (cause instanceof ModelEvalChoiceRequiredError) {
      console.error("model evaluation requires an external recorded-model adapter");
      process.exit(2);
    }
    console.error("model evaluation failed");
    process.exit(1);
  }
}
