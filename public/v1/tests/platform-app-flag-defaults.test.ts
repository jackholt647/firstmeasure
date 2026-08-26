import assert from "node:assert/strict";
import test from "node:test";

import { appFlagDefaults } from "../platform/app_flags.js";

test("new organizations enable the standard FirstMeasure report options by default", () => {
  const defaults = appFlagDefaults();

  assert.equal(defaults.firstmeasure.gutter_reports, true);
  assert.equal(defaults.firstmeasure.measurement_report_summary, true);
  assert.equal(defaults.firstmeasure.report_expedite_options, true);
});
