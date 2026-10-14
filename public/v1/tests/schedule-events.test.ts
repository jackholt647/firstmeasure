import assert from "node:assert/strict";
import test from "node:test";

import { eventAssigneeKeys, eventAssignees, eventEquipment, eventFamilyIds, eventPrimaryAssignee, eventResources, eventWindow, parentWouldCycle, stripRemovedEventFields } from "../scheduling/event-model.js";
import { evaluatePlacement, manualPlacement, normalizePlacement, placeChildren } from "../scheduling/placement.js";

// The pure rules behind docs/architecture/schedule-events.md: one resource
// list, parents that drive their children, and who counts as family.

const TZ = "America/Denver";
const ctx = { timezone: TZ };
const at = (value: string) => Date.parse(value);
const iso = (value: number) => new Date(value).toISOString();

test("an event's resources are one list, typed, without dates and without the event itself", () => {
  const event = {
    id: "event_1",
    assigned_user_ids: ["user_9"],
    resource_refs: [
      { kind: "crew", id: "rg_1", name: "North", unit_id: "unit_2" },
      { kind: "resource_group", id: "RG_1", name: "duplicate" },
      { kind: "equipment_type", id: "lift", name: "Lift", quantity: 2, start_at: "2026-10-13T00:00:00Z", end_at: "2026-10-14T00:00:00Z" },
      { kind: "equipment_unit", id: "truck_4", unit_id: "ignored" },
      { kind: "user", id: "user_3", role: "operator" },
      { kind: "resource_group", id: "event_1" },
      { kind: "nonsense", id: "x" }
    ]
  };
  assert.deepEqual(eventResources(event), [
    { kind: "resource_group", id: "rg_1", name: "North", role: "crew", unit_id: "unit_2" },
    { kind: "equipment_type", id: "lift", name: "Lift", role: "equipment", quantity: 2 },
    { kind: "equipment_unit", id: "truck_4", name: "", role: "equipment" },
    { kind: "organization_user", id: "user_3", name: "", role: "operator" }
  ]);
  assert.deepEqual(eventAssignees(event).map((ref) => ref.id), ["rg_1", "user_3"]);
  assert.deepEqual(eventEquipment(event).map((ref) => ref.id), ["lift", "truck_4"]);
  assert.equal(eventPrimaryAssignee(event)?.id, "rg_1", "an operator is not the primary assignee");
  assert.deepEqual(eventAssigneeKeys(event), ["resource_group:rg_1", "organization_user:user_3", "organization_user:user_9"]);
});

test("fields that said the same thing twice are never stored", () => {
  const cleaned = stripRemovedEventFields({
    id: "event_1", work_resource_ref: { id: "rg_1" }, assigned_crew_id: "rg_1", crew_id: "rg_1", material_list_id: "list_1", labor_list_id: "list_1",
    schedule_rule: { bundle: {} }, schedule_rollup: "auto", is_schedule_group: true, scope_resource_list_id: "list_1",
    metadata: { material_list_id: "list_1", scope_resource_list_id: "list_1", schedule_rule: {}, generated_from_scope: true }
  });
  assert.deepEqual(cleaned, { id: "event_1", scope_resource_list_id: "list_1", metadata: { generated_from_scope: true } });
});

test("a placement puts a child relative to its parent in the organization's timezone", () => {
  // A three-day installation, Tuesday to Thursday, as whole local days.
  const parent = { start: at("2026-10-13T06:00:00Z"), end: at("2026-10-16T06:00:00Z") };
  const dayBefore = normalizePlacement({ anchor: "start", offset: { value: -1, unit: "business_day" }, duration: { value: 1, unit: "day" }, all_day: true })!;
  assert.deepEqual(evaluatePlacement(dayBefore, parent, {}, ctx), { start: at("2026-10-12T06:00:00Z"), end: at("2026-10-13T06:00:00Z"), all_day: true });
  // One business day before a Monday is the Friday.
  const monday = { start: at("2026-10-19T06:00:00Z"), end: at("2026-10-20T06:00:00Z") };
  assert.equal(iso(evaluatePlacement(dayBefore, monday, {}, ctx).start), "2026-10-16T06:00:00.000Z");
  // Halfway through, worked out from the parent's length.
  const midway = normalizePlacement({ anchor: "start", offset: { unit: "day", expression: { operator: "floor", value: { operator: "divide", left: { operator: "subtract", left: { ref: "parent.duration.days" }, right: 1 }, right: 2 } } }, duration: { value: 1, unit: "day" }, all_day: true })!;
  assert.equal(iso(evaluatePlacement(midway, parent, {}, ctx).start), "2026-10-14T06:00:00.000Z");
  assert.equal(iso(evaluatePlacement(midway, { start: parent.start, end: at("2026-10-18T06:00:00Z") }, {}, ctx).start), "2026-10-15T06:00:00.000Z", "a longer parent moves the midpoint");
  // A span child covers its parent; an end anchor follows the parent's end.
  assert.deepEqual(evaluatePlacement({ anchor: "span" }, parent, { all_day: true }, ctx), { ...parent, all_day: true });
  const afterEnd = normalizePlacement({ anchor: "end", offset: { value: 2, unit: "hour" }, duration: { value: 90, unit: "minute" }, all_day: false })!;
  assert.deepEqual(evaluatePlacement(afterEnd, parent, {}, ctx), { start: parent.end + 2 * 3600000, end: parent.end + 2 * 3600000 + 90 * 60000, all_day: false });
  // With no duration of its own, a child keeps the length it has.
  const kept = evaluatePlacement({ anchor: "start", offset: { value: 1, unit: "day" } }, parent, { start_at: "2026-10-01T15:00:00Z", end_at: "2026-10-01T19:00:00Z", status: "scheduled" }, ctx);
  assert.equal(kept.end - kept.start, 4 * 3600000);
  // A whole day added across the autumn clock change is still local midnight.
  const overClockChange = { start: at("2026-10-31T06:00:00Z"), end: at("2026-11-01T06:00:00Z") };
  assert.equal(iso(evaluatePlacement({ anchor: "start", offset: { value: 2, unit: "day" }, duration: { value: 1, unit: "day" }, all_day: true }, overClockChange, {}, ctx).start), "2026-11-02T07:00:00.000Z");
});

test("a child moved by hand holds its distance from the parent", () => {
  const parent = { start: at("2026-10-13T06:00:00Z"), end: at("2026-10-16T06:00:00Z") };
  const allDay = manualPlacement({ start: at("2026-10-14T06:00:00Z"), end: at("2026-10-16T06:00:00Z"), all_day: true }, parent, ctx);
  assert.deepEqual(allDay, { anchor: "start", offset: { value: 1, unit: "day" }, duration: { value: 2, unit: "day" }, all_day: true, manual: true });
  const moved = { start: at("2026-10-20T06:00:00Z"), end: at("2026-10-23T06:00:00Z") };
  assert.deepEqual(evaluatePlacement(allDay, moved, {}, ctx), { start: at("2026-10-21T06:00:00Z"), end: at("2026-10-23T06:00:00Z"), all_day: true });
  const timed = manualPlacement({ start: parent.start + 9 * 3600000, end: parent.start + 11 * 3600000, all_day: false }, parent, ctx);
  assert.deepEqual(timed, { anchor: "start", offset: { value: 540, unit: "minute" }, duration: { value: 120, unit: "minute" }, all_day: false, manual: true });
});

test("moving a parent re-places everything under it except what is locked, finished or free", () => {
  const events = [
    { id: "span", kind: "schedule_group", status: "scheduled", start_at: "2026-10-20T06:00:00Z", end_at: "2026-10-23T06:00:00Z", all_day: true },
    { id: "install", parent_event_id: "span", placement: { anchor: "span" }, status: "scheduled", start_at: "2026-10-13T06:00:00Z", end_at: "2026-10-16T06:00:00Z", all_day: true, event_revision: 4 },
    { id: "lift", parent_event_id: "install", placement: { anchor: "start", offset: { value: 1, unit: "day" }, duration: { value: 2, unit: "day" }, all_day: true }, status: "unscheduled" },
    { id: "delivery", parent_event_id: "span", placement: { anchor: "start", offset: { value: -1, unit: "business_day" }, duration: { value: 1, unit: "day" }, all_day: true }, status: "scheduled", start_at: "2026-10-12T06:00:00Z", end_at: "2026-10-13T06:00:00Z", locked: true },
    { id: "walkthrough", parent_event_id: "span", status: "scheduled", start_at: "2026-10-16T20:00:00Z", end_at: "2026-10-16T21:00:00Z" },
    { id: "done", parent_event_id: "span", placement: { anchor: "span" }, status: "completed", start_at: "2026-10-13T06:00:00Z", end_at: "2026-10-16T06:00:00Z" },
    { id: "elsewhere", status: "scheduled", start_at: "2026-10-13T06:00:00Z", end_at: "2026-10-14T06:00:00Z" }
  ];
  const { updated, blocked } = placeChildren(events, "span", ctx, "2026-10-13T00:00:00.000Z");
  assert.deepEqual(updated.map((event) => [event.id, event.start_at, event.end_at, event.status]), [
    ["install", "2026-10-20T06:00:00.000Z", "2026-10-23T06:00:00.000Z", "scheduled"],
    ["lift", "2026-10-21T06:00:00.000Z", "2026-10-23T06:00:00.000Z", "scheduled"]
  ]);
  assert.equal(updated[0]!.event_revision, 5, "a re-placed child is a new revision of itself");
  assert.deepEqual(blocked.map((event) => event.id).sort(), ["delivery", "done"]);
  assert.equal(events[1]!.start_at, "2026-10-13T06:00:00Z", "the events passed in are not changed");
  // Taking the parent off the calendar takes its children off too.
  const cleared = placeChildren([{ ...events[0]!, status: "unscheduled", start_at: "", end_at: "" }, ...events.slice(1)], "span", ctx);
  assert.deepEqual(cleared.updated.map((event) => [event.id, event.status, event.start_at]), [["install", "unscheduled", ""]]);
  // A parent that did not move changes nothing.
  const still = [{ ...events[0]!, start_at: "2026-10-13T06:00:00Z", end_at: "2026-10-16T06:00:00Z" }, events[1]!];
  assert.deepEqual(placeChildren(still, "span", ctx), { updated: [], blocked: [] });
});

test("family is an event, everything above it and everything under it", () => {
  const events = [{ id: "span" }, { id: "install", parent_event_id: "span" }, { id: "lift", parent_event_id: "install" }, { id: "delivery", parent_event_id: "span" }, { id: "other" }];
  assert.deepEqual([...eventFamilyIds(events, events[1])].sort(), ["install", "lift", "span"]);
  assert.deepEqual([...eventFamilyIds(events, events[0])].sort(), ["delivery", "install", "lift", "span"]);
  assert.equal(parentWouldCycle(events, "span", "lift"), true);
  assert.equal(parentWouldCycle(events, "install", "install"), true);
  assert.equal(parentWouldCycle(events, "delivery", "install"), false);
  assert.equal(eventWindow({ status: "cancelled", start_at: "2026-10-13T06:00:00Z" }), null, "a cancelled event holds nothing");
});
