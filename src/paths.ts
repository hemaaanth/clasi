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
  readonly conflictDirectory: string;
  readonly revisionRoot: string;
  readonly lockDirectory: string;
  readonly transactionDirectory: string;
  repositoryScope(repositoryKey: string): string;
  context(scope: ScopeRef): string;
  napkin(scope: ScopeRef): string;
  metrics(machineId: string): string;
  proposalDirectory(scope: ScopeRef): string;
  proposal(scope: ScopeRef, proposalId: string): string;
  papercut(scope: ScopeRef, lifecycle: "open" | "archive", papercutId: string): string;
  revisionDirectory(documentKey: string): string;
  revision(documentKey: string, revisionId: string): string;
  conflict(conflictId: string): string;
  staging(canonicalPath: string, revisionId: string): string;
  migration(migrationId: string): string;
  migrationSnapshotDirectory(migrationId: string): string;
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
  const conflictDirectory = join(data, ".clasi", "conflicts");
  const revisionRoot = join(data, ".clasi", "revisions");
  const lockDirectory = join(control, "locks");
  const transactionDirectory = join(data, ".clasi", "transactions");
  const proposalDirectory = (scope: ScopeRef): string =>
    join(scopeDirectory(data, scope), "proposals");

  return {
    config: join(control, "config.json"),
    machineId: join(control, "machine-id"),
    repositoryIndex: join(control, "repo-index.json"),
    conflictDirectory,
    revisionRoot,
    lockDirectory,
    transactionDirectory,
    repositoryScope: repositoryKey =>
      scopeDirectory(data, { type: "repository", id: requireId(repositoryKey, "repo") }),
    context: scope => join(scopeDirectory(data, scope), "context.md"),
    napkin: scope => join(scopeDirectory(data, scope), "napkin.md"),
    metrics: machineId =>
      join(scopeDirectory(data, { type: "machine", id: requireId(machineId, "machine") }), "metrics.md"),
    proposalDirectory,
    proposal: (scope, proposalId) =>
      join(proposalDirectory(scope), `${requireId(proposalId, "proposal")}.md`),
    papercut: (scope, lifecycle, papercutId) =>
      join(
        scopeDirectory(data, scope),
        "papercuts",
        lifecycle,
        `${requireId(papercutId, "cut")}.md`,
      ),
    revisionDirectory: documentKey => resolveWithin(revisionRoot, requireId(documentKey, "doc")),
    revision: (documentKey, revisionId) =>
      resolveWithin(
        resolveWithin(revisionRoot, requireId(documentKey, "doc")),
        `${requireId(revisionId, "rev")}.md`,
      ),
    conflict: conflictId =>
      join(conflictDirectory, `${requireId(conflictId, "conflict")}.md`),
    staging: (canonicalPath, revisionId) => {
      const canonical = requireContainedFile(data, canonicalPath);
      return `${canonical}.${requireId(revisionId, "rev")}.staging`;
    },
    migration: migrationId =>
      join(data, ".clasi", "migrations", `${requireId(migrationId, "migration")}.md`),
    migrationSnapshotDirectory: migrationId =>
      join(data, ".clasi", "migration-snapshots", requireId(migrationId, "migration")),
    transaction: transactionId =>
      join(transactionDirectory, requireId(transactionId, "tx"), "state.md"),
    quarantine: transactionId =>
      join(data, ".clasi", "quarantine", requireId(transactionId, "tx"), "displaced.md"),
    lock: documentKey => join(lockDirectory, requireId(documentKey, "doc")),
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

function requireContainedFile(root: string, path: string): string {
  const absolute = resolve(path);
  const relation = relative(root, absolute);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new PathSafetyError("path-escape");
  }
  return absolute;
}

function requireId(value: string, prefix: Parameters<typeof isOpaqueId>[1]): string {
  if (!isOpaqueId(value, prefix)) throw new PathSafetyError("invalid-id");
  return value;
}
