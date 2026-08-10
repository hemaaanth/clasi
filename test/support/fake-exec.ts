import type {
  ProcessAdapter,
  ProcessInvocation,
  ProcessResult,
} from "../../src/exec.ts";

export class FakeProcessAdapter {
  readonly calls: ProcessInvocation[] = [];
  private readonly outcomes: ProcessResult[];

  constructor(...outcomes: ProcessResult[]) {
    this.outcomes = [...outcomes];
  }

  readonly run: ProcessAdapter = async invocation => {
    this.calls.push(invocation);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("Fake process adapter has no remaining outcome");
    return outcome;
  };
}

export function exited(stdout: string, exitCode = 0, stderr = ""): ProcessResult {
  return {
    status: "exited",
    exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(stderr),
  };
}
