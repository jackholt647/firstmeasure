import assert from "node:assert/strict";
import test from "node:test";

import { projectArtifactKey } from "../src/storage/project_artifacts.js";

test("project artifact keys isolate projects and preserve artifact filename case", () => {
  assert.equal(
    projectArtifactKey("Project_ABC", "Instant Report.pdf"),
    "firstmeasure/projects/project_abc/Instant Report.pdf"
  );
  assert.equal(
    projectArtifactKey("project-1", "sync/upload-1/000001.part"),
    "firstmeasure/projects/project-1/sync/upload-1/000001.part"
  );
});
