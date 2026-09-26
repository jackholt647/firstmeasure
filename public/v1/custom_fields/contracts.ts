import { badRequest } from "../platform/errors.js";
import { jsonClone, validateJson } from "../platform/publication/validation.js";
import { assertSafeTenantSchema } from "../platform/publication/tenant-schema.js";
import type { JsonObject } from "../platform/storage.js";
import { Worker } from "node:worker_threads";

export const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
export const types = ["text", "multiline", "email", "phone", "url", "number", "integer", "currency", "percentage", "slider", "date", "datetime", "boolean", "toggle", "select", "radio", "multiselect", "tags", "list", "array", "object", "key_value", "json", "formula", "organization_user", "resource_group", "organization_connection", "assignable_subject"];
export type FieldEntity = "project" | "contact" | "organization";
export function fieldPath(value: unknown): string {
  const path = String(value || "");
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(path) || path.split(".").length > 12 || path.split(".").some(p => p.length > 64 || ["__proto__", "constructor", "prototype"].includes(p))) throw badRequest("custom_field_path_reserved", "Use a stable dotted field path without reserved keys.");
  return path;
}
export function getValue(value: unknown, path: string): unknown {
  return fieldPath(path).split(".").reduce<unknown>((v, key) => Object.hasOwn(object(v), key) ? object(v)[key] : undefined, value);
}
export function putValue(value: JsonObject, path: string, next: unknown) {
  const keys = fieldPath(path).split("."); let cursor = value;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] = { ...object(cursor[key]) };
  cursor[keys.at(-1)!] = next;
}
export const empty = (v: unknown) => v === undefined || v === null || v === "";

// Formats are a small, bounded platform vocabulary. Tenant regexes/references
// are never handed to AJV. Nested contracts use the same bounded schema subset.
export function formatValid(format: string, v: string): boolean {
  if (format === "email") return v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (format === "phone") return /^[+\d\s().-]+$/.test(v) && v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15;
  if (format === "url") { try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; } }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (format === "datetime") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(v) && formatValid("date", v.slice(0, 10)) && Number.isFinite(Date.parse(v));
  return false;
}
function withoutFormats(schema: JsonObject): JsonObject {
  const next = { ...schema };
  if (next.format !== undefined) {
    if (!["email", "phone", "url", "date", "datetime"].includes(String(next.format))) throw badRequest("custom_field_format", "Unsupported field format.");
    delete next.format;
  }
  if (next.properties) next.properties = Object.fromEntries(Object.entries(object(next.properties)).map(([k,v]) => [k, v && typeof v === "object" ? withoutFormats(object(v)) : v]));
  for (const key of ["items", "additionalProperties"]) if (next[key] && typeof next[key] === "object") next[key] = withoutFormats(object(next[key]));
  // Keep contracts predictable for the browser's recursive form builder.
  for (const key of ["allOf", "anyOf", "oneOf", "not"]) if (key in next) throw badRequest("custom_field_schema", "Field schemas use properties, items and additionalProperties rather than schema composition.");
  return next;
}
export function fieldSchema(field: JsonObject): JsonObject {
  if (field.schema !== undefined && (!field.schema || typeof field.schema !== "object" || Array.isArray(field.schema))) throw badRequest("custom_field_schema","A field schema must be an object.");
  const type = String(field.type || "text");
  if (!types.includes(type)) throw badRequest("custom_field_type_invalid", `Unsupported field type ${type}.`);
  let schema: JsonObject;
  if (["number", "currency", "percentage", "slider", "formula", "integer"].includes(type)) schema = { type: type === "integer" ? "integer" : "number" };
  else if (["boolean", "toggle"].includes(type)) schema = { type: "boolean" };
  else if (["list", "tags", "multiselect", "array"].includes(type)) schema = { type: "array", items: type === "array" ? {} : { type: "string" } };
  else if (["object", "key_value"].includes(type)) schema = { type: "object", additionalProperties: type === "key_value" ? { type: "string" } : true };
  else if (type === "json") schema = {};
  else if (["organization_user", "resource_group", "organization_connection", "assignable_subject"].includes(type)) schema = field.cardinality === "many" ? { type:"array", items:{type:"object"} } : { type:"object" };
  else schema = { type:"string" };
  if (["email", "phone", "url", "date", "datetime"].includes(type)) schema.format = type;
  const declared = object(field.schema);
  if (declared.type && schema.type && declared.type !== schema.type) throw badRequest("custom_field_schema","The schema root type must match the selected field type.");
  if (field.step != null && field.step !== "" && !(Number(field.step) > 0 && Number.isFinite(Number(field.step)))) throw badRequest("custom_field_step","The field step must be positive.");
  schema = { ...schema, ...declared, ...(schema.type ? { type:schema.type } : {}) };
  for (const [from,to] of [["min","minimum"],["max","maximum"],["min_length","minLength"],["max_length","maxLength"]]) if (field[from!] !== null && field[from!] !== undefined && field[from!] !== "") schema[to!] = Number(field[from!]);
  const options = Array.isArray(field.options) ? field.options.map(v => typeof v === "object" ? object(v).value : v) : [];
  if (options.length && ["select", "radio"].includes(type)) schema.enum = options;
  if (options.length && type === "multiselect") schema.items = { type:"string", enum:options };
  assertSafeTenantSchema(withoutFormats(jsonClone(schema, 64000)));
  // Compile now, so malformed declarations fail when saved, not on first use.
  try { validateJson(withoutFormats(schema), null); } catch (e: any) { if (e.code !== "publication_schema_invalid") throw badRequest("custom_field_schema", "Invalid field schema."); }
  return schema;
}
export function validateField(field: JsonObject, value: unknown) {
  if (empty(value)) { if (field.required === true) throw badRequest("custom_field_required", `${field.label || field.path} is required.`); return; }
  const schema = fieldSchema(field);
  validateJson(withoutFormats(schema), value, String(field.label || field.path));
  if (typeof value === "number" && field.step != null && field.step !== "") {
    const step = Number(field.step), ratio = (value - Number(field.min || 0)) / step;
    if (!(step > 0) || Math.abs(ratio - Math.round(ratio)) > 1e-8) throw badRequest("custom_field_step",`${field.label || field.path} does not match its declared step.`);
  }
  const walk = (s: JsonObject, v: unknown, path: string) => {
    if (s.format && typeof v === "string" && !formatValid(String(s.format), v)) throw badRequest("custom_field_format", `${path} must be a valid ${s.format}.`);
    if (Array.isArray(v)) v.forEach((child, i) => walk(object(s.items), child, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [key,child] of Object.entries(v)) walk(object(object(s.properties)[key] ?? s.additionalProperties), child, `${path}.${key}`);
  };
  walk(schema, value, String(field.label || field.path));
}
export function normalizeDefinitions(input: unknown): JsonObject[] {
  if (!Array.isArray(input) || input.length > 256) throw badRequest("custom_field_definitions", "Supply at most 256 field definitions.");
  const seen = new Set<string>();
  return input.map(raw => {
    const f = jsonClone(object(raw), 64000);
    const entity = String(f.entity || "project");
    if (!["project", "contact", "organization"].includes(entity)) throw badRequest("custom_field_entity", "Unknown field owner.");
    const path = fieldPath(f.path || f.key);
    const key = `${entity}:${path}`;
    if ([...seen].some(p => p === key || p.startsWith(key + ".") || key.startsWith(p + "."))) throw badRequest("custom_field_conflict", "Field paths must be unique and cannot overlap. Declare subfields inside the parent schema.");
    seen.add(key);
    const result = { ...f, entity, path, key:path, type:String(f.type || "text") };
    if (f.pattern) {
      if (typeof f.pattern !== "string" || f.pattern.length > 256) throw badRequest("custom_field_pattern", "Patterns may contain at most 256 characters.");
      try { new RegExp(f.pattern); } catch { throw badRequest("custom_field_pattern", "Invalid validation pattern."); }
    }
    fieldSchema(result);
    if (!empty(f.default_value) && (typeof f.default_value !== "object" || Object.keys(f.default_value as object).length)) validateField(result, f.default_value);
    return result;
  });
}

/** Tenant patterns execute off the request thread with a hard deadline. */
export async function validatePattern(field: JsonObject, value: unknown) {
  if (!field.pattern || typeof value !== "string" || !value) return;
  if (value.length > 4096 || String(field.pattern).length > 256) throw badRequest("custom_field_pattern_limit", "Pattern validation exceeds its input limit.");
  const valid = await new Promise<boolean>((resolve,reject) => {
    const worker = new Worker('const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage(new RegExp(workerData.pattern).test(workerData.value));', {eval:true,workerData:{pattern:field.pattern,value},resourceLimits:{maxOldGenerationSizeMb:16}});
    const timer = setTimeout(() => { void worker.terminate(); reject(badRequest("custom_field_pattern_limit","Validation pattern exceeded its time limit.")); },500);
    worker.once("message",v => { clearTimeout(timer); void worker.terminate(); resolve(v === true); });
    worker.once("error",() => { clearTimeout(timer); reject(badRequest("custom_field_pattern","Invalid validation pattern.")); });
  });
  if (!valid) throw badRequest("custom_field_pattern", `${field.label || field.path} does not match its declared pattern.`);
}

export function calculateFormula(expression: string, resolve: (path:string) => unknown): number {
  if (expression.length > 4096) throw badRequest("custom_field_formula_limit","Formula is too long.");
  const source = expression.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,(_match,path) => {
    const value = resolve(path);
    if (empty(value)) throw badRequest("custom_field_formula_missing",`Formula input ${path} is missing.`);
    if (typeof value !== "number" && typeof value !== "boolean") throw badRequest("custom_field_formula_type",`Formula input ${path} is not numeric.`);
    return `(${Number(value)})`;
  });
  const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+*/%\-]/g) || [];
  if (!tokens.length || tokens.join("") !== source.replace(/\s/g,"")) throw badRequest("custom_field_formula","Use numeric fields and basic arithmetic.");
  let index=0, depth=0;
  const atom = ():number => {
    if (++depth > 64) throw badRequest("custom_field_formula_limit","Formula is nested too deeply.");
    const token=tokens[index++]; let value:number;
    if (token === "(" ) { value=sum(); if(tokens[index++] !== ")") throw badRequest("custom_field_formula","Unbalanced formula."); }
    else if (token === "+" || token === "-") value=(token === "-" ? -1 : 1)*atom();
    else { value=Number(token); if (!token || !Number.isFinite(value)) throw badRequest("custom_field_formula","Invalid formula operand."); }
    depth--; return value;
  };
  const product = ():number => { let v=atom(); while (["*","/","%"].includes(tokens[index] || "")) { const op=tokens[index++], right=atom(); v=op === "*" ? v*right : op === "/" ? v/right : v%right; } return v; };
  const sum = ():number => { let v=product(); while (["+","-"].includes(tokens[index] || "")) { const op=tokens[index++], right=product(); v=op === "+" ? v+right : v-right; } return v; };
  const value=sum();
  if(index !== tokens.length || !Number.isFinite(value)) throw badRequest("custom_field_formula","Formula did not produce a finite number.");
  return value;
}
