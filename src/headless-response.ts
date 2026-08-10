export const HEADLESS_SCHEMA_VERSION = 1 as const;

export type HeadlessStatus =
  | "ok"
  | "choice-required"
  | "setup-needed"
  | "degraded"
  | "partial"
  | "error";

export type HeadlessExitCode = 0 | 1 | 2;

export interface HeadlessEnvelope<T extends object = object> {
  schema_version: typeof HEADLESS_SCHEMA_VERSION;
  status: HeadlessStatus;
  code: string;
  message: string;
  data: T;
  next_actions: string[];
}

export interface HeadlessResponse<T extends object = object> {
  exitCode: HeadlessExitCode;
  envelope: HeadlessEnvelope<T>;
}

export function createHeadlessResponse<T extends object>(input: {
  status: HeadlessStatus;
  code: string;
  message: string;
  data: T;
  next_actions?: readonly string[];
}): HeadlessResponse<T> {
  return {
    exitCode: exitCodeForStatus(input.status),
    envelope: {
      schema_version: HEADLESS_SCHEMA_VERSION,
      status: input.status,
      code: input.code,
      message: input.message,
      data: input.data,
      next_actions: [...(input.next_actions ?? [])],
    },
  };
}

export function headlessOk<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[] = [],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "ok", code, message, data, next_actions });
}

export function headlessChoiceRequired<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "choice-required", code, message, data, next_actions });
}

export function headlessSetupNeeded<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "setup-needed", code, message, data, next_actions });
}

export function headlessDegraded<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "degraded", code, message, data, next_actions });
}

export function headlessPartial<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[] = [],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "partial", code, message, data, next_actions });
}

export function headlessError<T extends object>(
  code: string,
  message: string,
  data: T,
  next_actions: readonly string[],
): HeadlessResponse<T> {
  return createHeadlessResponse({ status: "error", code, message, data, next_actions });
}

export function exitCodeForStatus(status: HeadlessStatus): HeadlessExitCode {
  if (status === "ok" || status === "partial") return 0;
  if (status === "choice-required" || status === "setup-needed") return 2;
  return 1;
}
