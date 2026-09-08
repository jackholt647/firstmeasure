import assert from "node:assert/strict";
import test from "node:test";

import { resolvePostgresIdentityPhonePatch } from "../platform/storage_postgres.js";

test("metadata-only identity patches preserve an invalid legacy phone", () => {
  const result = resolvePostgresIdentityPhonePatch(
    { phone: "legacy-invalid-phone" },
    { metadata: { password_reset: { channel: "email" } } }
  );

  assert.deepEqual(result, {
    phonePatched: false,
    rawPhone: "legacy-invalid-phone",
    phoneNormalized: ""
  });
});

test("an explicitly patched phone is still validated and normalized", () => {
  assert.throws(
    () => resolvePostgresIdentityPhonePatch({}, { phone: "555-0101" }),
    (error: unknown) => error instanceof Error && error.message === "A valid mobile phone number is required."
  );

  assert.deepEqual(resolvePostgresIdentityPhonePatch({}, { phone: "(415) 555-0101" }), {
    phonePatched: true,
    rawPhone: "(415) 555-0101",
    phoneNormalized: "+14155550101"
  });
});
