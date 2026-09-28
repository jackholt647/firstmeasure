import assert from "node:assert/strict";
import test from "node:test";
import "../platform/capability_defs.js";
import "../comms/capabilities.js";
import "../chat/capabilities.js";
import "../assistant/capabilities.js";
import { resolveCapabilities } from "../platform/capabilities.js";
import { resolveAppFlags } from "../platform/app_flags.js";

test("existing organizations default to the complete FirstMeasure product without other apps", () => {
  const state = resolveCapabilities({});
  for (const key of ["apps.project_map", "apps.projects", "apps.firstmeasure", "apps.billing", "firstmeasure.report_orders", "firstmeasure.gutter_reports", "firstmeasure.measurement_report_summary", "firstmeasure.report_expedite_options", "firstmeasure.report_cancellations", "permission.manage_company_settings", "permission.manage_company_users"]) {
    assert.equal(state.effectiveByKey[key], true, key);
  }
  for (const key of ["platform.expanded_access", "platform.more_apps", "apps.stats", "apps.channels", "apps.crew", "apps.sales", "apps.messaging", "apps.comms", "apps.live_chat", "platform.documents", "platform.contacts", "platform.scheduling", "platform.custom_fields", "platform.advanced_app_menu"]) {
    assert.equal(state.effectiveByKey[key], false, key);
  }
  assert.equal(state.values["platform.new_button_mode"], "report");
});

test("app flags cannot bypass the release gate or change FirstMeasure's ordering entry point", () => {
  const flags = resolveAppFlags({ apps: { stats: true }, platform: { more_apps: true, new_button_mode: "project", new_button_items: "document,payment" }, firstmeasure: { gutter_reports: false } });
  assert.equal(flags.resolved.apps?.stats, false);
  assert.equal(flags.resolved.platform?.more_apps, false);
  assert.equal(flags.resolved.platform?.new_button_mode, "report");
  assert.equal(flags.resolved.firstmeasure?.gutter_reports, false);
});

test("explicit platform access enables selected apps while app discovery remains separately controlled", () => {
  const state = resolveCapabilities({ "platform.expanded_access": true, "apps.channels": true, "platform.new_button_mode": "project" });
  assert.equal(state.effectiveByKey["apps.channels"], true);
  assert.equal(state.values["platform.new_button_mode"], "project");
  assert.equal(state.effectiveByKey["platform.more_apps"], false);
  assert.equal(resolveCapabilities({ "platform.expanded_access": true, "platform.more_apps": true }).effectiveByKey["platform.more_apps"], true);
});
