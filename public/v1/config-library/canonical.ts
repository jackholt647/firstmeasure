import { createHash } from "node:crypto";

/** Canonical JSON (object keys sorted, no whitespace): the form an entry's sha256 is taken over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const contentHash = (data: unknown) => sha256(canonicalJson(data));

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Snapshot file name for an entry id: lower-case letters, digits and `_.-` are kept, anything else is %-escaped. */
export function snapshotFileName(id: string) {
  return id.replace(/[^a-z0-9_.-]/g, (char) => "%" + char.charCodeAt(0).toString(16).padStart(2, "0")) + ".json";
}
export function idFromSnapshotFileName(file: string) {
  return file.replace(/\.json$/, "").replace(/%([0-9a-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
