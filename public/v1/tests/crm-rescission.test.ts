import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRescission, pickRescissionRule, projectAddress, rescissionContext, rescissionDeadline, usFederalHolidays } from "../crm/rescission.js";

// Cancellation windows (docs/architecture/crm.md, "Cancellation windows"): the end of the last
// day a customer may cancel, counted the way the rule says in the organization's time zone, and
// the first rule whose conditions match the sale.

const business = { days: 3, count: "business" as const, holidays: "us_federal" as const };

test("federal holidays include the legal and the observed day", () => {
  const holidays = usFederalHolidays(2026);
  for (const day of ["2026-01-01", "2026-01-19", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25"]) assert.ok(holidays.has(day), day);
  assert.equal(holidays.has("2026-07-06"), false);
});

test("business days skip Sundays and federal holidays; the sale day does not count", () => {
  // Sold Thursday July 2: Friday the 3rd (observed) and Saturday the 4th are holidays, Sunday is skipped.
  assert.equal(rescissionDeadline(business, new Date("2026-07-02T14:00:00Z"), "America/New_York").toISOString(), "2026-07-09T03:59:59.999Z");
  // Sold Friday October 16: Saturday counts as a business day, Sunday does not.
  assert.equal(rescissionDeadline(business, new Date("2026-10-16T15:00:00Z"), "America/New_York").toISOString(), "2026-10-21T03:59:59.999Z");
  // Without holidays, July 3 counts.
  assert.equal(rescissionDeadline({ ...business, holidays: "none" }, new Date("2026-07-02T14:00:00Z"), "America/New_York").toISOString(), "2026-07-07T03:59:59.999Z");
});

test("weekdays skip weekends; calendar days count every day", () => {
  assert.equal(rescissionDeadline({ days: 3, count: "weekdays", holidays: "us_federal" }, new Date("2026-10-16T15:00:00Z"), "America/New_York").toISOString(), "2026-10-22T03:59:59.999Z");
  assert.equal(rescissionDeadline({ days: 3, count: "calendar", holidays: "none" }, new Date("2026-10-16T15:00:00Z"), "America/New_York").toISOString(), "2026-10-20T03:59:59.999Z");
  assert.equal(rescissionDeadline({ days: 0, count: "calendar", holidays: "none" }, new Date("2026-10-16T15:00:00Z"), "America/New_York").toISOString(), "2026-10-17T03:59:59.999Z", "zero days ends the day of the sale");
});

test("the day of the sale and the deadline are in the organization's time zone, across a clock change", () => {
  // 11:30 PM Friday in Los Angeles is Saturday in UTC; the sale day is still Friday there.
  assert.equal(rescissionDeadline(business, new Date("2026-10-17T06:30:00Z"), "America/Los_Angeles").toISOString(), "2026-10-21T06:59:59.999Z");
  // Daylight saving ends Sunday November 1: the deadline is the end of Tuesday in standard time.
  assert.equal(rescissionDeadline(business, new Date("2026-10-30T15:00:00Z"), "America/New_York").toISOString(), "2026-11-04T04:59:59.999Z");
});

test("the first rule whose conditions match applies; none means no window", () => {
  const settings = normalizeRescission({ enabled: true, rules: [
    { id: "ca_seniors", label: "California, 65 and over", days: 5, count: "business", holidays: "us_federal", conditions: { match: "all", rules: [{ field: "address.state", operator: "in", value: ["CA"] }, { field: "contact.age", operator: "greater_or_equal", value: 65 }] } },
    { id: "door_to_door", label: "Sold in the home", days: 3, count: "business", holidays: "us_federal", conditions: { match: "all", rules: [{ field: "lead_source.kind", operator: "not_in", value: ["walk_in"] }] } }
  ] });
  const now = new Date("2026-10-16T12:00:00Z");
  const california = { address_components: JSON.stringify({ administrative_area_level_1: { short: "CA", long: "California" }, locality: { long: "Fresno" } }), lead_source: { kind: "canvassing" } };
  assert.deepEqual(projectAddress(california), { state: "CA", state_name: "California", city: "Fresno", zip: "" });
  assert.equal(pickRescissionRule(settings, rescissionContext(california, { birthday: "1955-03-01" }, now))?.id, "ca_seniors");
  assert.equal(pickRescissionRule(settings, rescissionContext(california, { birthday: "1990-03-01" }, now))?.id, "door_to_door");
  assert.equal(pickRescissionRule(settings, rescissionContext({ lead_source: { kind: "walk_in" } }, {}, now)), null, "a walk-in sale has no window");
  assert.equal(pickRescissionRule({ ...settings, enabled: false }, rescissionContext(california, {}, now)), null, "rescission off");
});

test("rules are validated", () => {
  assert.throws(() => normalizeRescission({ enabled: true, rules: [{ id: "Bad Id", label: "x", days: 3 }] }));
  assert.throws(() => normalizeRescission({ enabled: true, rules: [{ id: "a", label: "x", days: 3, conditions: { match: "all", rules: [{ field: "x", operator: "no_such_operator", value: 1 }] } }] }));
});
