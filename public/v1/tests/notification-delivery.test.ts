import assert from "node:assert/strict";
import test from "node:test";
import { categoryForNotification, normalizeNotificationPreferences, notificationCategories, preferenceKeyForNotification } from "../platform/notification_delivery.js";
import { measurementNotificationTransition } from "../firstmeasure/notifications.js";

test("notification categories are stable and producers map to mobile channels", () => {
  assert.deepEqual(notificationCategories, ["leads", "messages", "mentions", "tasks", "scheduling", "payments", "celebrations", "measurements", "system"]);
  assert.equal(categoryForNotification({ kind: "comms_message" }), "messages");
  assert.equal(categoryForNotification({ kind: "mention" }), "mentions");
  assert.equal(categoryForNotification({ source: "payments" }), "payments");
  assert.equal(categoryForNotification({ kind: "celebration" }), "celebrations");
  assert.equal(categoryForNotification({ category: "scheduling", kind: "passive" }), "scheduling");
  assert.equal(categoryForNotification({ source: "firstmeasure" }), "measurements");
  assert.equal(preferenceKeyForNotification({ category: "measurements", preference_key: "measurements.report_delivered" }), "measurements.report_delivered");
});

test("notification preferences keep desktop and push independent", () => {
  const defaults = normalizeNotificationPreferences({});
  assert.equal(defaults.in_app.celebrations, true);
  assert.equal(defaults.push.celebrations, false);
  assert.equal(defaults.push.messages, true);
  assert.equal(defaults.push["measurements.report_delivered"], true);
  assert.equal(defaults.push["measurements.report_status"], false);
  const custom = normalizeNotificationPreferences({ in_app: { messages: false }, push: { messages: true, celebrations: true } });
  assert.equal(custom.in_app.messages, false);
  assert.equal(custom.push.messages, true);
  assert.equal(custom.push.celebrations, true);
});

test("measurement events follow committed delivery and status transitions", () => {
  const base = { id:"report_1", status:"processing", delivery:{} };
  assert.deepEqual(measurementNotificationTransition(base, { ...base, status:"completed" }), null);
  assert.deepEqual(measurementNotificationTransition(base, { ...base, status:"completed", delivery:{ report_sent_at:"2026-09-25T12:00:00Z" } }), { event:"report_delivered", status:"delivered" });
  assert.deepEqual(measurementNotificationTransition(base, { ...base, delivery:{ rework_report_sent_at:"2026-09-25T12:00:00Z" } }), { event:"report_revised", status:"revised" });
  assert.deepEqual(measurementNotificationTransition(base, { ...base, status:"cancelled" }), { event:"report_canceled", status:"canceled" });
  assert.deepEqual(measurementNotificationTransition(base, { ...base, status:"rejected_no_coverage" }), { event:"report_rejected", status:"rejected" });
  assert.deepEqual(measurementNotificationTransition(base, { ...base, status:"queued" }), { event:"report_status", status:"queued" });
});
