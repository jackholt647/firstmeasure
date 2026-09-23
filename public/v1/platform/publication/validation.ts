import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { badRequest } from "../errors.js";
import type { JsonSchema } from "./contracts.js";

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true });
const validators = new WeakMap<JsonSchema, ValidateFunction>();
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

export function jsonClone<T>(value: T, maxBytes = 2_000_000): T {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 64) throw badRequest("publication_value_limit", "Published data exceeds the structural limit.");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item) throw badRequest("publication_non_json", "Only finite JSON values are supported.");
    if (ancestors.has(item)) throw badRequest("publication_cycle", "Published data contains a cycle.");
    ancestors.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map(child => visit(child, depth + 1));
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw badRequest("publication_non_json", "Published objects must be plain JSON objects.");
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(item)) {
        if (unsafeKeys.has(key)) throw badRequest("publication_unsafe_key", "Reserved object keys cannot be published.");
        out[key] = visit(child, depth + 1);
      }
      result = out;
    }
    ancestors.delete(item);
    return result;
  };
  const clean = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(clean)) > maxBytes) throw badRequest("publication_value_limit", "Published data exceeds the byte limit.");
  return clean as T;
}

export function validateJson(schema: JsonSchema, value: unknown, label = "value"): void {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  jsonClone(value);
  if (!validate(value)) throw badRequest("publication_schema_invalid", `${label} does not match its declared schema.`, validate.errors?.map(e => ({ path: e.instancePath, keyword: e.keyword, message: e.message })));
}

export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sort(jsonClone(value)));
}
export function contentHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

export function readPointer(value: unknown, pointer = ""): unknown {
  if (!pointer) return value;
  if (!pointer.startsWith("/")) throw badRequest("publication_path_invalid", "Export paths must be JSON pointers.");
  let current = value;
  for (const part of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(part)) throw badRequest("publication_path_invalid", "Invalid JSON pointer escape.");
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (unsafeKeys.has(key)) throw badRequest("publication_path_invalid", "Reserved paths cannot be read.");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
