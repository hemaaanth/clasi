import { randomBytes } from "node:crypto";

export const ID_PREFIXES = [
  "ctx",
  "napkin",
  "cut",
  "proposal",
  "conflict",
  "migration",
  "tx",
  "metric",
  "machine",
  "repo",
  "rev",
  "doc",
] as const;

export type IdPrefix = (typeof ID_PREFIXES)[number];
export type OpaqueId<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

const OPAQUE_ID_PATTERN = /^(ctx|napkin|cut|proposal|conflict|migration|tx|metric|machine|repo|rev|doc)_[0-9a-f]{32}$/;

export function createOpaqueId<P extends IdPrefix>(
  prefix: P,
  entropy: (size: number) => Uint8Array = randomBytes,
): OpaqueId<P> {
  const bytes = entropy(16);
  if (bytes.byteLength !== 16) throw new Error("Opaque ID entropy must contain 16 bytes");
  return `${prefix}_${Buffer.from(bytes).toString("hex")}`;
}

export function isOpaqueId(value: unknown, prefix?: IdPrefix): value is OpaqueId {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}

export function requireOpaqueId<P extends IdPrefix>(value: unknown, prefix: P): OpaqueId<P> {
  if (!isOpaqueId(value, prefix)) throw new Error(`invalid-id:${prefix}`);
  return value as OpaqueId<P>;
}
