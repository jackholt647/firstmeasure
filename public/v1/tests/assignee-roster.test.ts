import assert from "node:assert/strict";
import test from "node:test";
import { assignmentFromEvent, resolveRoster, rosterAt, type AssignmentEntry, type RosterDirectory, type Unavailability } from "../assignees/roster.js";
import { evaluateStaffingRequirements, staffingRequirementSchema, type SourcedStaffingRequirement } from "../assignees/staffing-requirements.js";

// Pure: the resolver and the evaluator are given everything and read nothing.
const person = (id: string, name: string, fields: Record<string, unknown> = {}, extra: Partial<{ status: string; type_ids: string[]; tag_ids: string[]; group_ids: string[] }> = {}) =>
  ({ id: `organization_user:${id}`, user_id: id, name, status: "active", type_ids: [], tag_ids: [], department_ids: [], group_ids: [], fields, ...extra });
const people = [person("ana", "Ana", { has_cdl: true }, { type_ids: ["crew_foreman", "supervisor"] }), person("ben", "Ben", {}, { type_ids: ["crew_member"] }), person("cy", "Cy"), person("dan", "Dan", { has_cdl: true }), person("eve", "Eve"), person("gone", "Gone", {}, { status: "inactive" })];
const group = (id: string, name: string, members: string[]) => ({ id: `resource_group:${id}`, kind: "resource_group" as const, name, status: "active", type_ids: ["crew"], tag_ids: [], member_ids: members.map((member) => `organization_user:${member}`) });
const directory: RosterDirectory = {
  people: new Map(people.map((entry) => [entry.id, entry])),
  assignees: new Map<string, any>([
    ...people.map((entry) => [entry.id, { id: entry.id, kind: "organization_user", name: entry.name, status: entry.status, type_ids: entry.type_ids, tag_ids: [], member_ids: [] }] as const),
    ...[group("a", "Crew A", ["ana", "ben", "cy", "gone"]), group("b", "Crew B", ["cy", "eve"])].map((entry) => [entry.id, entry] as const),
    ["organization_connection:summit", { id: "organization_connection:summit", kind: "organization_connection", name: "Summit Roofing", status: "active", type_ids: ["subcontractor", "labor-supplier"], tag_ids: [], member_ids: [] }]
  ])
};
const add = (type: string, id: string, range: { from?: string; until?: string } = {}): AssignmentEntry => ({ op: "add", assignee: { type: type as "resource_group", id }, ...range });
const remove = (type: string, id: string, range: { from?: string; until?: string } = {}): AssignmentEntry => ({ op: "remove", assignee: { type: type as "resource_group", id }, ...range });
// Monday to Wednesday, 08:00-17:00 each day is not modelled: the window is one continuous range, as an event's is.
const window = { from: "2026-10-12T08:00:00.000Z", until: "2026-10-14T17:00:00.000Z" };
const tuesday = { from: "2026-10-13T08:00:00.000Z", until: "2026-10-13T17:00:00.000Z" };
const ids = (roster: { people: { id: string }[] }) => roster.people.map((entry) => entry.id.split(":")[1]);

test("a list of additions and removals resolves to the people actually on the work", () => {
  const crew = resolveRoster({ assignment: [add("resource_group", "a")], window, directory });
  assert.deepEqual(ids(crew), ["ana", "ben", "cy"], "a group is its active members");
  assert.deepEqual(crew.absent.map((entry) => [entry.name, entry.reason]), [["Gone", "inactive"]], "a member who is not active is named, not silently dropped");
  assert.deepEqual([crew.facts.count, crew.facts.min_count, crew.facts.max_count], [3, 3, 3]);
  assert.deepEqual([crew.people.map((entry) => entry.type_ids), crew.facts.type_ids], [[["crew_foreman", "supervisor"], ["crew_member"], []], ["crew_foreman", "crew_member", "supervisor"]], "a person's types are their roles, and the roster lists everyone's");
  assert.equal(crew.people.every((entry) => entry.whole_window), true);
  assert.deepEqual(crew.assigned, [{ id: "resource_group:a", kind: "resource_group", name: "Crew A" }]);

  assert.deepEqual(ids(resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan")], window, directory })), ["ana", "ben", "cy", "dan"], "crew A plus Dan");

  const minus = resolveRoster({ assignment: [add("resource_group", "a"), remove("organization_user", "ben")], window, directory });
  assert.deepEqual(ids(minus), ["ana", "cy"], "crew A minus Ben");
  const ben = minus.absent.find((entry) => entry.name === "Ben")!;
  assert.deepEqual([ben.reason, ben.removed, ben.via], ["removed", [window], ["resource_group:a"]], "who was removed, when, and how they had come to be on the work");

  // Cy is in both crews and is one person.
  const both = resolveRoster({ assignment: [add("resource_group", "a"), add("resource_group", "b")], window, directory });
  assert.deepEqual(ids(both), ["ana", "ben", "cy", "eve"]);
  assert.deepEqual(both.people.find((entry) => entry.name === "Cy")!.via, ["resource_group:a", "resource_group:b"]);
  assert.equal(both.facts.count, 4);
  // Removing one of the groups takes its members off, including the shared one: the later entry wins.
  assert.deepEqual(ids(resolveRoster({ assignment: [add("resource_group", "a"), add("resource_group", "b"), remove("resource_group", "b")], window, directory })), ["ana", "ben"]);
  // A removal before the addition it would cancel does nothing: entries apply in order.
  assert.deepEqual(ids(resolveRoster({ assignment: [remove("organization_user", "dan"), add("organization_user", "dan")], window, directory })), ["dan"]);
});

test("an entry limited to part of the work changes the roster for exactly that part", () => {
  const roster = resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan", tuesday), remove("organization_user", "ben", { from: tuesday.from })], window, directory });
  const dan = roster.people.find((entry) => entry.name === "Dan")!, ben = roster.people.find((entry) => entry.name === "Ben")!;
  assert.deepEqual(dan.present, [tuesday], "Dan covers Tuesday only");
  assert.equal(dan.whole_window, false);
  assert.deepEqual(ben.present, [{ from: window.from, until: tuesday.from }], "Ben is on the work until he is taken off");
  assert.deepEqual(ben.removed, [{ from: tuesday.from, until: window.until }]);
  assert.deepEqual(roster.timeline.map((segment) => [segment.from, segment.until, segment.person_ids.map((id) => id.split(":")[1])]), [
    [window.from, tuesday.from, ["ana", "ben", "cy"]],
    [tuesday.from, tuesday.until, ["ana", "cy", "dan"]],
    [tuesday.until, window.until, ["ana", "cy"]]
  ]);
  assert.deepEqual([roster.facts.count, roster.facts.min_count, roster.facts.max_count], [4, 2, 3]);
  assert.deepEqual(rosterAt(roster, "2026-10-13T12:00:00.000Z").person_ids, ["organization_user:ana", "organization_user:cy", "organization_user:dan"]);
  assert.deepEqual(rosterAt(roster, "2026-10-12T09:00:00.000Z").person_ids, ["organization_user:ana", "organization_user:ben", "organization_user:cy"]);
  // An entry that falls wholly outside the window puts no one on the work.
  assert.deepEqual(ids(resolveRoster({ assignment: [add("organization_user", "dan", { from: "2026-11-01T00:00:00.000Z", until: "2026-11-02T00:00:00.000Z" })], window, directory })), []);
});

test("time off is compared as exact intervals, so part of a day is part of a day", () => {
  const morning = { from: "2026-10-13T08:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };
  const unavailable: Unavailability[] = [
    { assignee_id: "organization_user:ana", ...morning, reason: "Dentist", source: "time_off", source_id: "t1" },
    { assignee_id: "organization_user:ben", from: "2026-10-01T00:00:00.000Z", until: "2026-10-31T00:00:00.000Z", reason: "Leave", source: "time_off", source_id: "t2" },
    { assignee_id: "organization_user:eve", ...morning, reason: "Not on this work", source: "time_off", source_id: "t3" }
  ];
  const roster = resolveRoster({ assignment: [add("resource_group", "a")], window, directory, unavailable });
  const ana = roster.people.find((entry) => entry.name === "Ana")!;
  assert.deepEqual(ana.present, [{ from: window.from, until: morning.from }, { from: morning.until, until: window.until }], "Ana is off for the morning and on either side of it");
  assert.deepEqual(ana.unavailable, [{ ...morning, reason: "Dentist", source: "time_off", source_id: "t1" }], "with the exact overlap and where it is recorded");
  const ben = roster.absent.find((entry) => entry.name === "Ben")!;
  assert.deepEqual([ben.reason, ben.unavailable.map((entry) => [entry.from, entry.until])], ["unavailable", [[window.from, window.until]]], "time off is cut to the part that overlaps the work");
  assert.deepEqual(roster.timeline.map((segment) => segment.person_ids.length), [2, 1, 2]);
  assert.equal(roster.facts.min_count, 1);
  assert.equal(roster.absent.some((entry) => entry.name === "Eve"), false, "time off for someone not on the work is nobody's business here");
});

test("an outside company is one party, and a person promised to two things is reported once per overlap", () => {
  const roster = resolveRoster({
    assignment: [add("resource_group", "a"), add("organization_connection", "summit", tuesday), add("organization_user", "nobody")], window, directory,
    other_work: [
      { id: "ev_other", title: "9 Elm St install", project_id: "p2", from: "2026-10-13T12:00:00.000Z", until: "2026-10-13T20:00:00.000Z", assignment: [add("resource_group", "b")] },
      { id: "ev_later", title: "Later", project_id: "p3", from: "2026-10-20T08:00:00.000Z", until: "2026-10-20T17:00:00.000Z", assignment: [add("resource_group", "a")] }
    ]
  });
  assert.deepEqual(roster.parties.map((party) => [party.id, party.present, party.type_ids]), [["organization_connection:summit", [tuesday], ["subcontractor", "labor-supplier"]]], "a company keeps all of its types");
  assert.equal(roster.facts.party_count, 1);
  assert.equal(roster.facts.count, 3, "a company adds no people");
  assert.deepEqual(roster.unknown, [{ id: "organization_user:nobody", op: "add" }]);
  // Cy is in crew A (this work) and crew B (the other work): the group on the other event holds its members.
  assert.deepEqual(roster.conflicts.map((conflict) => [conflict.name, conflict.work.id, conflict.intervals]), [["Cy", "ev_other", [{ from: "2026-10-13T12:00:00.000Z", until: "2026-10-13T20:00:00.000Z" }]]]);
  assert.deepEqual(ids(roster), ["ana", "ben", "cy"], "a conflict is a warning: Cy is still on the work");
  assert.deepEqual(roster.facts.fields, { has_cdl: [true] }, "each field as the list of everyone's values");
});

const requirement = (input: Partial<SourcedStaffingRequirement> & { where: SourcedStaffingRequirement["where"] }): SourcedStaffingRequirement => ({ id: "r1", label: "CDL driver", count: 1, source: { kind: "work" }, ...input });
const cdl = { match: "all" as const, rules: [{ field: "fields.has_cdl", operator: "equals", value: true }] };

test("a staffing requirement is a count and a condition, checked at every moment of the window", () => {
  const met = evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a")], window, directory }), [requirement({ where: cdl })]);
  assert.deepEqual([met[0]!.met, met[0]!.reason, met[0]!.matching_ids], [true, "", ["organization_user:ana"]]);

  // The crew's only CDL driver is off for a morning.
  const morning = { from: "2026-10-13T08:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };
  const off: Unavailability[] = [{ assignee_id: "organization_user:ana", ...morning, reason: "Dentist", source: "time_off", source_id: "t1" }];
  const roster = resolveRoster({ assignment: [add("resource_group", "a")], window, directory, unavailable: off });
  const [unmet] = evaluateStaffingRequirements(roster, [requirement({ where: cdl, source: { kind: "assignee", id: "resource_group:a", name: "Crew A" } })]);
  assert.equal(unmet!.met, false);
  assert.deepEqual(unmet!.unmet, [{ ...morning, matching: 0 }], "exactly when it falls short");
  assert.deepEqual(unmet!.missing, [{ id: "organization_user:ana", name: "Ana", reason: "unavailable", intervals: [morning] }]);
  assert.equal(unmet!.reason, "Crew A is assigned, but its only CDL driver (Ana) is off 8:00 AM-12:00 PM on Oct 13.");
  assert.equal(evaluateStaffingRequirements(roster, [requirement({ where: cdl })], { timezone: "America/Chicago" })[0]!.reason, "Crew A is assigned, but its only CDL driver (Ana) is off 3:00 AM-7:00 AM on Oct 13.", "times are said in the organization's timezone");
  // The remedy is to add someone for that time: Dan has a CDL and covers the morning.
  const covered = resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan", morning)], window, directory, unavailable: off });
  assert.equal(evaluateStaffingRequirements(covered, [requirement({ where: cdl })])[0]!.met, true);
  assert.notEqual(unmet!.id, evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a")], window, directory, unavailable: [{ ...off[0]!, until: "2026-10-13T13:00:00.000Z" }] }), [requirement({ where: cdl, source: { kind: "assignee", id: "resource_group:a", name: "Crew A" } })])[0]!.id, "an accepted warning stops being accepted when what it was about changes");

  // Nobody on the work has one at all.
  const none = evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "b")], window, directory }), [requirement({ where: cdl })]);
  assert.equal(none[0]!.reason, "Crew B is assigned, but no one on the work is a CDL driver (it needs 1 CDL driver).");
  // A count above one, and someone who would have counted was taken off.
  const two = evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan"), remove("organization_user", "dan")], window, directory }), [requirement({ where: cdl, count: 2 })]);
  assert.deepEqual([two[0]!.met, two[0]!.unmet.map((entry) => entry.matching)], [false, [1]]);
  assert.equal(two[0]!.reason, "Crew A is assigned, but Dan was taken off the work, leaving 1 of the 2 CDL drivers needed.");
  // A role is a condition on the person's types, because a person's types are their roles.
  const foreman = requirement({ id: "foreman", label: "foreman", where: { rules: [{ field: "type_ids", operator: "contains", value: "crew_foreman" }] } });
  assert.deepEqual([evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a")], window, directory }), [foreman])[0]!.matching_ids, evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "b")], window, directory }), [foreman])[0]!.met], [["organization_user:ana"], false]);
  assert.match(met[0]!.id, /^staffing-requirement:/);
  assert.equal(met[0]!.staffing_requirement_id, "r1");
  // "This specific person" is a condition on the person's id.
  const specific = requirement({ id: "dan", label: "Dan", where: { rules: [{ field: "id", operator: "equals", value: "organization_user:dan" }] } });
  assert.equal(evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a")], window, directory }), [specific])[0]!.met, false);
  assert.equal(evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan")], window, directory }), [specific])[0]!.met, true);
  // Covering only part of the window does not meet it.
  const partial = evaluateStaffingRequirements(resolveRoster({ assignment: [add("resource_group", "a"), add("organization_user", "dan", tuesday)], window, directory }), [specific]);
  assert.deepEqual(partial[0]!.unmet.map((entry) => [entry.from, entry.until]), [[window.from, tuesday.from], [tuesday.until, window.until]]);
  assert.deepEqual(partial[0]!.missing.map((entry) => [entry.name, entry.reason]), [["Dan", "not_assigned"]]);

  // The shape is the one condition contract; anything else is refused when it is saved.
  assert.equal(staffingRequirementSchema.safeParse({ id: "r", label: "Lead", count: 1, where: { rules: [{ field: "tag_ids", operator: "contains", value: "lead" }] } }).success, true);
  assert.equal(staffingRequirementSchema.safeParse({ id: "r", label: "Lead", count: 0, where: cdl }).success, false, "at least one");
  assert.equal(staffingRequirementSchema.safeParse({ id: "r", label: "Lead", count: 1, where: { rules: [{ field: "fields.x", operator: "resembles", value: 1 }] } }).success, false, "an operator the condition contract does not have");
  assert.equal(staffingRequirementSchema.safeParse({ id: "r", label: "Lead", count: 1, where: { "fields.x": 1 } }).success, false, "the equality-map spelling is not accepted");
});

test("an event's resources read as an assignment list", () => {
  const event = { id: "ev1", start_at: "2026-10-12T08:00:00.000Z", end_at: "2026-10-12T17:00:00.000Z", assigned_user_ids: ["eve"],
    resource_refs: [{ kind: "resource_group", id: "a", role: "crew" }, { kind: "organization_user", id: "ben", op: "remove" }, { kind: "equipment_type", id: "lift", quantity: 2 }, { kind: "crew", id: "legacy-alias" }] };
  const change = { id: "ev2", parent_event_id: "ev1", start_at: "2026-10-12T08:00:00.000Z", end_at: "2026-10-12T12:00:00.000Z", resource_refs: [{ kind: "organization_user", id: "dan" }] };
  assert.deepEqual(assignmentFromEvent(event, [change]), [
    { op: "add", assignee: { type: "resource_group", id: "a" } },
    { op: "remove", assignee: { type: "organization_user", id: "ben" } },
    { op: "add", assignee: { type: "organization_user", id: "eve" } },
    { op: "add", assignee: { type: "organization_user", id: "dan" }, from: "2026-10-12T08:00:00.000Z", until: "2026-10-12T12:00:00.000Z" }
  ], "equipment and kinds that are not assignees are skipped; a change event limits its entries to its own range");
});
