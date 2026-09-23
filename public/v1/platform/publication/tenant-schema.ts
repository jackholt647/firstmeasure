import { badRequest } from "../errors.js";
import { jsonClone } from "./validation.js";
import type { JsonSchema } from "./contracts.js";

/** Tenant contracts are deliberately a bounded JSON Schema subset. Trusted
 * built-in adapter schemas may use broader AJV features outside this entry. */
export function assertSafeTenantSchema(input: unknown): asserts input is JsonSchema {
  const value = jsonClone(input, 64_000);
  let nodes = 0;
  const scalar = new Set(["type", "title", "description", "default", "examples", "const", "enum", "required", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
  const walk = (schema: unknown, depth: number) => {
    if (++nodes > 256 || depth > 12) throw badRequest("tenant_schema_limit", "Schema exceeds the complexity limit.");
    if (typeof schema === "boolean") return;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw badRequest("tenant_schema_invalid", "Schema must be an object or boolean.");
    for (const [key, child] of Object.entries(schema)) {
      if (scalar.has(key)) {
        if (["enum", "required", "examples"].includes(key) && (!Array.isArray(child) || child.length > 128)) throw badRequest("tenant_schema_limit", "Schema list exceeds the limit.");
        continue;
      }
      if (key === "properties") {
        if (!child || typeof child !== "object" || Array.isArray(child) || Object.keys(child).length > 128) throw badRequest("tenant_schema_limit", "Schema properties exceed the limit.");
        Object.values(child).forEach(item => walk(item, depth + 1));
      } else if (["items", "additionalProperties", "not"].includes(key)) walk(child, depth + 1);
      else if (["allOf", "anyOf", "oneOf"].includes(key)) {
        if (!Array.isArray(child) || !child.length || child.length > 8) throw badRequest("tenant_schema_limit", "Schema composition exceeds the limit.");
        child.forEach(item => walk(item, depth + 1));
      } else throw badRequest("tenant_schema_keyword", `Tenant schemas do not support '${key}'. References, formats and regular expressions are not executed on the host.`);
    }
  };
  walk(value, 0);
}
