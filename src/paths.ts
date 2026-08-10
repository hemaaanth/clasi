import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ClasiRoots } from "./config.ts";
import { isOpaqueId } from "./ids.ts";

export type ScopeRef =
  | { type: "global"; id: "global" }
  | { type: "machine"; id: string }
  | { type: "repository"; id: string };

export interface ClasiPaths {
  readonly config: string;
  readonly machineId: string;
  readonly repositoryIndex: string;
  context(scope: ScopeRef): string;
  napkin(scope: ScopeRef): string;
  metrics(machineId: string): string;
  proposal(scope: ScopeRef, proposalId: string): string;
  papercut(scope: ScopeRef, lifecycle: "open" | "archive", papercutId: string): string;
  revision(documentKey: string, revisionId: string): string;
  conflict(conflictId: string): string;
  migration(migrationId: string): string;
  transaction(transactionId: string): string;
  quarantine(transactionId: string): string;
  lock(documentKey: string): string;
  lastGood(documentKey: string): string;
}

export class PathSafetyError extends Error {
  constructor(readonly code: "path-escape" | "invalid-scope" | "invalid-id", message = code) {
    super(message);
    this.name = "PathSafetyError";
  }
}

export function resolveWithin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      isAbsolute(segment) ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw new PathSafetyError("path-escape");
    }
  }
  const target = resolve(root, ...segments);
  const relation = relative(resolve(root), target);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PathSafetyError("path-escape");
  }
  return target;
}

export function createClasiPaths(roots: ClasiRoots): ClasiPaths {
  const control = resolve(roots.controlRoot);
  const data = resolve(roots.dataRoot);

  return {
    config: join(control, "config.json"),
    machineId: join(control, "machine-id"),
    repositoryIndex: join(control, "repo-index.json"),
    context: scope => join(scopeDirectory(data, scope), "context.md"),
    napkin: scope => join(scopeDirectory(data, scope), "napkin.md"),
    metrics: machineId =>
      join(scopeDirectory(data, { type: "machine", id: requireId(machineId, "machine") }), "metrics.md"),
    proposal: (scope, proposalId) =>
      join(scopeDirectory(data, scope), "proposals", `${requireId(proposalId, "proposal")}.md`),
    papercut: (scope, lifecycle, papercutId) =>
      join(
        scopeDirectory(data, scope),
        "papercuts",
        lifecycle,
        `${requireId(papercutId, "cut")}.md`,
      ),
    revision: (documentKey, revisionId) =>
      resolveWithin(
        join(data, ".clasi", "revisions"),
        requireId(documentKey, "doc"),
        `${requireId(revisionId, "rev")}.md`,
      ),
    conflict: conflictId =>
      join(data, ".clasi", "conflicts", `${requireId(conflictId, "conflict")}.md`),
    migration: migrationId =>
      join(data, ".clasi", "migrations", `${requireId(migrationId, "migration")}.md`),
    transaction: transactionId =>
      join(data, ".clasi", "transactions", requireId(transactionId, "tx"), "state.md"),
    quarantine: transactionId =>
      join(data, ".clasi", "quarantine", requireId(transactionId, "tx"), "displaced.md"),
    lock: documentKey => join(control, "locks", requireId(documentKey, "doc")),
    lastGood: documentKey => join(control, "last-good", `${requireId(documentKey, "doc")}.md`),
  };
}

function scopeDirectory(dataRoot: string, scope: ScopeRef): string {
  if (scope.type === "global" && scope.id === "global") {
    return join(dataRoot, "scopes", "global");
  }
  if (scope.type === "machine" && isOpaqueId(scope.id, "machine")) {
    return join(dataRoot, "scopes", "machines", scope.id);
  }
  if (scope.type === "repository" && isOpaqueId(scope.id, "repo")) {
    return join(dataRoot, "scopes", "repositories", scope.id);
  }
  throw new PathSafetyError("invalid-scope");
}

function requireId(value: string, prefix: Parameters<typeof isOpaqueId>[1]): string {
  if (!isOpaqueId(value, prefix)) throw new PathSafetyError("invalid-id");
  return value;
}
