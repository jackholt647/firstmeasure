import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("an administrative force-kick returns work to the regular drafting queue", async () => {
  const apiSource = await readFile(new URL("../firstmeasure/api.ts", import.meta.url), "utf8");
  const handlerStart = apiSource.indexOf('app.post("/projects/:id/requeue/force"');
  const handlerEnd = apiSource.indexOf('app.post("/projects/:id/force-kick/status"', handlerStart);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, "force-kick handler is present");
  const handler = apiSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /updateStatus\(projectId, "queued"\)/);
  assert.doesNotMatch(handler, /updateStatus\(projectId, "requeue"\)/);
  assert.match(handler, /returned to the drafting queue/);
});

test("the admin UI describes force-kick as a return to regular drafting", async () => {
  const uiSource = await readFile(
    new URL("../../measure/internal/portal_scripts/projects.js", import.meta.url),
    "utf8"
  );

  assert.match(uiSource, /> Force Kick<\/button>/);
  assert.match(uiSource, /Force Kick returns the project to the regular drafting queue/);
});
