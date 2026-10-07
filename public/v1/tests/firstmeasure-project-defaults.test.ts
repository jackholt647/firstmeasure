import test from "node:test";
import assert from "node:assert/strict";
import { firstMeasureSignupValues, capabilityDefaultValues } from "../platform/capabilities.js";
import "../platform/capability_defs.js";

test("FirstMeasure signup exposes language and units and suppresses stale board defaults", () => {
  const stale: ReturnType<typeof capabilityDefaultValues> = { ...capabilityDefaultValues(), "firstmeasure.report_localization": false, "platform.project_boards": true, "platform.project_stages_view": true, "platform.manual_project_stage_movement": true };
  const values = firstMeasureSignupValues(stale);
  assert.equal(values["firstmeasure.report_localization"], true);
  for (const key of ["platform.project_boards", "platform.project_stages_view", "platform.manual_project_stage_movement"]) assert.equal(values[key], false);
  assert.equal(values["firstmeasure.metric_measurements"], stale["firstmeasure.metric_measurements"], "Showing the selector must not force US accounts to metric");
  assert.equal(stale["platform.project_boards"], true, "Signup normalization leaves stored presets intact");
});
