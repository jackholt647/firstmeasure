import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMediaTags } from "../platform/storage.js";

test("media tags normalize into stable workflow keys", () => {
  assert.deepEqual(
    normalizeMediaTags([" Before Photos ", "#Roof-Damage", "before photos", "Röof!"]),
    ["before_photos", "roof-damage", "rof"]
  );
});

test("media tags deduplicate and enforce storage limits", () => {
  const tags = normalizeMediaTags([
    "Featured",
    "featured",
    "",
    ...Array.from({ length: 60 }, (_, index) => `tag ${index}`)
  ]);
  assert.equal(tags[0], "featured");
  assert.equal(tags.length, 50);
  assert.ok(tags.every((tag) => tag.length <= 64));
});
