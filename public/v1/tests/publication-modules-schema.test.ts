import test from "node:test";
import assert from "node:assert/strict";
import { assertSafeTenantSchema } from "../platform/publication/tenant-schema.js";
test("tenant schema accepts bounded data contracts and rejects host regex/ref execution", () => {
  assert.doesNotThrow(() => assertSafeTenantSchema({ type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { count: { type: "number", minimum: 0 } }, required: ["count"] } } }, additionalProperties: false }));
  for (const schema of [{ pattern: "(a+)+$" }, { $ref: "https://example.com/schema" }, { properties: { x: { format: "regex" } } }, { patternProperties: { "(a+)+$": {} } }, { $defs: { recursive: { $ref: "#/$defs/recursive" } } }]) assert.throws(() => assertSafeTenantSchema(schema));
  let deep: any = {}; for (let i = 0; i < 20; i++) deep = { items: deep };
  assert.throws(() => assertSafeTenantSchema(deep), /complexity/);
});
