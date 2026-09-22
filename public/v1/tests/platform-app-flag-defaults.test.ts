import assert from "node:assert/strict";
import test from "node:test";

import { appFlagDefaults, canManageTestAppFlags } from "../platform/app_flags.js";

test("new organizations enable the standard FirstMeasure report options by default", () => {
  const defaults = appFlagDefaults();

  assert.equal(defaults.firstmeasure.materials_promo, false);
  assert.equal(defaults.firstmeasure.metric_measurements, false);
  assert.equal(defaults.firstmeasure.report_localization, false);
  assert.equal(defaults.firstmeasure.gutter_reports, true);
  assert.equal(defaults.firstmeasure.measurement_report_summary, true);
  assert.equal(defaults.firstmeasure.report_expedite_options, true);
});


test("flag administration requires both a specified test organization and an operator admin", () => {
  const previous = process.env.PLATFORM_TEST_ORG_IDS;
  try {
    const operator = { identity: { email: "notifications@1m8.ai" }, role: "owner", orgId: "test-one" };
    delete process.env.PLATFORM_TEST_ORG_IDS;
    assert.equal(canManageTestAppFlags(operator), false);
    process.env.PLATFORM_TEST_ORG_IDS = "test-one, test-two";
    assert.equal(canManageTestAppFlags(operator), true);
    assert.equal(canManageTestAppFlags({ ...operator, orgId: "new-org" }), false);
    assert.equal(canManageTestAppFlags({ ...operator, role: "viewer" }), false);
    assert.equal(canManageTestAppFlags({ ...operator, identity: { email: "owner@example.test" } }), false);
    assert.equal(appFlagDefaults().platform?.my_settings, false);
  } finally {
    if (previous === undefined) delete process.env.PLATFORM_TEST_ORG_IDS;
    else process.env.PLATFORM_TEST_ORG_IDS = previous;
  }
});
