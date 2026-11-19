import assert from "node:assert/strict";
import test from "node:test";
import { compiledValidator, validateJson } from "../platform/publication/validation.js";

// GP-14: custom field definitions build a new schema object on every read; compiling each one again cost a
// fifth of dev web's CPU and kept every copy in Ajv's cache.
test("a schema rebuilt with the same content reuses its compiled validator and validates the same", () => {
  const build = () => ({ type: "object", properties: { name: { type: "string", maxLength: 3 } }, required: ["name"], additionalProperties: false });
  assert.equal(compiledValidator(build()), compiledValidator(build()));
  assert.notEqual(compiledValidator(build()), compiledValidator({ ...build(), required: [] }));
  validateJson(build(), { name: "abc" });
  assert.throws(() => validateJson(build(), { name: "abcd" }), { code: "publication_schema_invalid" });
  assert.throws(() => validateJson(build(), {}), { code: "publication_schema_invalid" });
});

test("values JSON would print alike, and schemas with an $id, are not shared by content", () => {
  compiledValidator({ type: "number", minimum: Number.NaN });
  assert.throws(() => compiledValidator({ type: "number", minimum: null }), /minimum must be number/, "NaN prints as null but compiles; null is still refused");
  assert.notEqual(compiledValidator({ type: "string", title: undefined }), compiledValidator({ type: "string" }));
  const identified = () => ({ $id: "https://example.test/gp-14", type: "string" });
  const first = identified();
  assert.equal(compiledValidator(first), compiledValidator(first), "the same object still hits");
  assert.throws(() => compiledValidator(identified()), "a second schema with the same $id is still Ajv's error, as before");
});
