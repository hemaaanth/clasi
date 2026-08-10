import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { SAFE_SOURCE_CLASSIFICATIONS } from "./privacy.ts";
import { NAPKIN_CATEGORIES } from "./schema.ts";
import type { ClasiRuntime } from "./runtime-types.ts";

export const CLASI_TOOL_NAMES = [
  "clasi_get_context",
  "clasi_propose_context",
  "clasi_get_napkin",
  "clasi_curate_napkin",
  "clasi_mark_hit",
  "clasi_get_papercuts",
  "clasi_capture_papercut",
  "clasi_update_repair",
] as const;

export type ClasiToolName = (typeof CLASI_TOOL_NAMES)[number];
export type ClasiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ClasiJsonValue[]
  | { readonly [key: string]: ClasiJsonValue };

export interface ClasiToolOutcome {
  readonly status: string;
  readonly code?: string;
  readonly reason?: string;
  readonly changed?: boolean;
  readonly [key: string]: ClasiJsonValue | undefined;
}

export interface ClasiToolDetails {
  status: string;
  reason?: string;
}

export type ClasiToolRuntime = Pick<ClasiRuntime, "handleTool" | "refresh">;

const SCOPE_TYPES = ["global", "machine", "repository"] as const;
const CONTEXT_KINDS = ["fact", "preference"] as const;
const PAPERCUT_SEVERITIES = ["minor", "major", "blocker"] as const;
const REPAIR_STATES = [
  "running",
  "awaiting_verification",
  "failed",
  "indeterminate",
] as const;
const LOGICAL_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SCOPE_ID_PATTERN = /^(?:machine|repo)_[0-9a-f]{32}$/;
const NAPKIN_ID_PATTERN = /^napkin_[0-9a-f]{32}$/;
const PAPERCUT_ID_PATTERN = /^cut_[0-9a-f]{32}$/;
const SAFE_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;

export function registerClasiTools(pi: ExtensionAPI, runtime: ClasiToolRuntime): void {
  const z = pi.zod;
  const boundedText = z.string().min(1).max(240).regex(/^[^\r\n]+$/);
  const logicalKey = z.string().min(1).max(80).regex(LOGICAL_KEY_PATTERN);
  const sourceClassification = z.enum(SAFE_SOURCE_CLASSIFICATIONS);
  const scoped = (shape: Parameters<typeof z.object>[0]) =>
    z.object({
      scope: z.enum(SCOPE_TYPES),
      scopeId: z.string().regex(SCOPE_ID_PATTERN).optional(),
      ...shape,
    }).strict().refine((value) => {
      const scopedValue = value as {
        scope: (typeof SCOPE_TYPES)[number];
        scopeId?: string;
      };
      const scopeId = scopedValue.scopeId;
      return scopedValue.scope === "global"
        ? scopeId === undefined
        : scopedValue.scope === "machine"
        ? scopeId?.startsWith("machine_") === true
        : scopeId?.startsWith("repo_") === true;
    }, { message: "scopeId must match scope" });

  const specifications = [
    {
      name: "clasi_get_context",
      label: "Get clasi Context",
      description: "Read the bounded active Context for one clasi scope.",
      approval: "read",
      parameters: scoped({}),
    },
    {
      name: "clasi_propose_context",
      label: "Propose clasi Context",
      description: "Submit a generalized Context fact or preference for safe activation or review.",
      approval: "write",
      parameters: scoped({
        logicalKey,
        kind: z.enum(CONTEXT_KINDS),
        value: boundedText,
        sourceClassification,
        priority: z.number().int().min(0).max(100),
      }),
    },
    {
      name: "clasi_get_napkin",
      label: "Get clasi Napkin",
      description: "Read category-bounded reusable guidance for one clasi scope.",
      approval: "read",
      parameters: scoped({}),
    },
    {
      name: "clasi_curate_napkin",
      label: "Curate clasi Napkin",
      description: "Create or reinforce one generalized reusable lesson.",
      approval: "write",
      parameters: scoped({
        logicalKey,
        category: z.enum(NAPKIN_CATEGORIES),
        priority: z.number().int().min(0).max(100),
        situation: boundedText,
        action: boundedText,
        sourceClassification,
        targetId: z.string().regex(NAPKIN_ID_PATTERN).optional(),
      }),
    },
    {
      name: "clasi_mark_hit",
      label: "Mark clasi Napkin hit",
      description: "Record one explicit use of a reusable lesson.",
      approval: "write",
      parameters: scoped({ id: z.string().regex(NAPKIN_ID_PATTERN) }),
    },
    {
      name: "clasi_get_papercuts",
      label: "Get clasi Papercuts",
      description: "Read the bounded unresolved Papercut inbox for one clasi scope.",
      approval: "read",
      parameters: scoped({}),
    },
    {
      name: "clasi_capture_papercut",
      label: "Capture clasi Papercut",
      description: "Capture or reinforce one generalized actionable friction record.",
      approval: "write",
      parameters: scoped({
        fingerprint: logicalKey,
        summary: boundedText,
        severity: z.enum(PAPERCUT_SEVERITIES),
        prevention: boundedText,
        acceptanceCondition: boundedText,
        sourceClassification,
        explicitMatchId: z.string().regex(PAPERCUT_ID_PATTERN).optional(),
      }),
    },
    {
      name: "clasi_update_repair",
      label: "Update clasi repair",
      description: "Request one safe repair-state transition for an open Papercut.",
      approval: "write",
      parameters: scoped({
        id: z.string().regex(PAPERCUT_ID_PATTERN),
        repairState: z.enum(REPAIR_STATES),
      }),
    },
  ] as const;

  for (const specification of specifications) {
    pi.registerTool({
      ...specification,
      loadMode: "discoverable",
      execute: async (_toolCallId, params, _signal, _onUpdate, context) =>
        executeClasiTool(
          runtime,
          specification.name,
          params as Readonly<Record<string, unknown>>,
          context,
        ),
    });
  }
}

async function executeClasiTool(
  runtime: ClasiToolRuntime,
  name: ClasiToolName,
  params: Readonly<Record<string, unknown>>,
  context: ExtensionContext,
): Promise<AgentToolResult<ClasiToolDetails>> {
  try {
    return resultFrom(safeOutcome(await runtime.handleTool(name, params, context)));
  } catch {
    return resultFrom({ status: "rejected", code: "tool-failed" });
  }
}

function safeOutcome(outcome: unknown): ClasiToolOutcome {
  if (typeof outcome !== "object" || outcome === null) {
    return { status: "rejected", code: "invalid-outcome" };
  }
  const record = outcome as Record<string, unknown>;
  if (
    typeof record.status !== "string" ||
    !SAFE_TOKEN_PATTERN.test(record.status) ||
    (record.code !== undefined &&
      (typeof record.code !== "string" || !SAFE_TOKEN_PATTERN.test(record.code))) ||
    (record.reason !== undefined &&
      (typeof record.reason !== "string" || !SAFE_TOKEN_PATTERN.test(record.reason)))
  ) {
    return { status: "rejected", code: "invalid-outcome" };
  }
  return record as unknown as ClasiToolOutcome;
}

function resultFrom(outcome: ClasiToolOutcome): AgentToolResult<ClasiToolDetails> {
  const reason = outcome.reason ?? outcome.code;
  const details: ClasiToolDetails = reason === undefined
    ? { status: outcome.status }
    : { status: outcome.status, reason };
  return {
    content: [{ type: "text", text: JSON.stringify(outcome) }],
    details,
    ...(outcome.status === "rejected" ? { isError: true } : {}),
  };
}
