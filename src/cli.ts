import { CLASI_VERSION } from "./runtime-types.ts";

export interface CliEnvelope {
  schema_version: 1;
  status: "ok" | "error";
  code: string;
  message: string;
  data: Record<string, unknown>;
  next_actions: string[];
}

export type CliWriter = (line: string) => void;

export async function runClasiCli(
  args: readonly string[],
  write: CliWriter = line => console.log(line),
): Promise<number> {
  const [command, ...rest] = args;

  if ((command === "--version" || command === "version") && rest.length === 0) {
    writeEnvelope(write, {
      status: "ok",
      code: "version",
      message: `clasi ${CLASI_VERSION}`,
      data: { version: CLASI_VERSION },
      next_actions: [],
    });
    return 0;
  }

  if ((command === "--help" || command === "help") && rest.length === 0) {
    writeEnvelope(write, {
      status: "ok",
      code: "help",
      message: "clasi commands",
      data: { commands: ["help", "version"] },
      next_actions: ["Run clasi version to inspect the installed version."],
    });
    return 0;
  }

  writeEnvelope(write, {
    status: "error",
    code: "usage-error",
    message: command ? `Unknown clasi command: ${command}` : "A clasi command is required.",
    data: {},
    next_actions: ["Run clasi help."],
  });
  return 2;
}

function writeEnvelope(
  write: CliWriter,
  envelope: Omit<CliEnvelope, "schema_version">,
): void {
  write(JSON.stringify({ schema_version: 1, ...envelope } satisfies CliEnvelope));
}
