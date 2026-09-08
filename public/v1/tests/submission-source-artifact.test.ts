import assert from "node:assert/strict";
import test from "node:test";

import { findSubmissionSourceArtifactName } from "../firstmeasure/api.js";

test("original QA reference image names resolve to uploaded source artifacts", () => {
  const files = [
    { name: "source_1_1788881945424_8a.jpg", updated_at: "2026-09-08T15:39:05.638Z" },
    { name: "source_1_1788881945424_8a.png", updated_at: "2026-09-08T17:40:28.128Z" },
    { name: "source_2_1788881946038_8.jpg", updated_at: "2026-09-08T15:39:06.234Z" }
  ];

  assert.equal(findSubmissionSourceArtifactName("8a.JPG", files), "source_1_1788881945424_8a.jpg");
  assert.equal(findSubmissionSourceArtifactName("8.JPG", files), "source_2_1788881946038_8.jpg");
  assert.equal(findSubmissionSourceArtifactName("SOURCE_2_1788881946038_8.JPG", files), "source_2_1788881946038_8.jpg");
  assert.equal(findSubmissionSourceArtifactName("sources_notes.txt", files), null);
  assert.equal(findSubmissionSourceArtifactName("missing.JPG", files), null);
});
