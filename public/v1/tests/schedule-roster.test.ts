import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

/**
 * Scheduling reads the assignee base's roster and check (docs/architecture/schedule-events.md, "Roster and warnings"):
 * who is on an event, unmet staffing requirements and conflicts come from one answer, derived and never stored, and
 * never blocking.
 */
const dir = await mkdtemp(path.join(os.tmpdir(), "schedule-roster-"));
Object.assign(process.env, {
  NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
  WORK_SCHEDULER_DISABLED: "1", APPOINTMENT_CONFIRMATIONS_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1"
});
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_schedule_roster", BRANCHED = "org_schedule_roster_branches";
const FEATURE = "platform.multiple_branches";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true }, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: {} }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } }, accessProfile: { roles: [] } } as any;
const target = { scope: "organization" as const, organizationId: ORG };
const crewRef = (id: string, name: string) => ({ kind: "resource_group", id, name, role: "crew" });
const userRef = (id: string, name: string) => ({ kind: "organization_user", id, name, role: "crew" });
const DAY = { from: "2026-10-20T08:00:00.000Z", until: "2026-10-20T17:00:00.000Z" };

let ready: Promise<{ crewA: string; crewB: string; crewC: string }> | null = null;
/** Crew A is Ana (the only CDL), Ben and Cy; crew B is Cy and Eve; crew C is Fay and Gus, who has left. */
function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    await s.createOrganization({ id: ORG, name: "Roster" });
    await s.saveGlobal(ORG, { data: { timezone: "UTC", app_flags: { platform: { expanded_access: true } } } }, { replace: false });
    await enableExpandedPlatformFixture(ORG, {});
    await s.saveBranchModule(ORG, "default", "custom_fields", { data: { fields: [{ entity: "user", path: "has_cdl", key: "has_cdl", type: "boolean", label: "Has a CDL" }] } });
    for (const [id, name, fields, roles] of [["ana", "Ana", { has_cdl: true }, ["crew_foreman"]], ["ben", "Ben", {}, null], ["cy", "Cy", {}, null], ["eve", "Eve", {}, null], ["dan", "Dan", { has_cdl: true }, null], ["fay", "Fay", {}, null], ["gus", "Gus", {}, null]] as const)
      await s.upsertDocument(ORG, "users", { id, data: { name, email: `${id}@example.test`, status: "active", custom_field_values: fields, ...(roles ? { access_role_ids: [...roles] } : {}) } });
    const workforce = await import("../workforce/storage.js");
    const crewA = String((await workforce.createResourceGroup(ORG, { name: "Crew A", kind_id: "crew", members: [{ user_id: "ana", is_lead: true }, { user_id: "ben" }, { user_id: "cy" }] })).id);
    const crewB = String((await workforce.createResourceGroup(ORG, { name: "Crew B", kind_id: "crew", member_user_ids: ["cy", "eve"] })).id);
    const crewC = String((await workforce.createResourceGroup(ORG, { name: "Crew C", kind_id: "crew", member_user_ids: ["fay", "gus"] })).id);
    // Gus has left the company; his membership was never ended.
    await s.upsertDocument(ORG, "users", { id: "gus", data: { name: "Gus", email: "gus@example.test", status: "inactive" } });
    const base = await import("../assignees/base.js");
    await base.setGroupStaffingRequirements(ORG, { assignee: { type: "resource_group", id: crewA }, staffing_requirements: [{ id: "cdl", label: "CDL driver", count: 1, where: { rules: [{ field: "fields.has_cdl", operator: "equals", value: true }] } }] }, owner);
    await (await import("../assignees/time-off.js")).saveTimeOff(ORG, { assignee: { type: "organization_user", id: "ana" }, from: DAY.from, until: "2026-10-20T12:00:00.000Z", reason: "Dentist" }, owner);
    await s.upsertDocument(ORG, "projects", { id: "oak", data: { title: "12 Oak St", events: [
      { id: "roof", title: "Roof", status: "scheduled", start_at: DAY.from, end_at: DAY.until, resource_refs: [crewRef(crewA, "Crew A"), crewRef(crewB, "Crew B")] },
      { id: "roof_cleanup", title: "Cleanup", status: "scheduled", parent_event_id: "roof", placement: { anchor: "span" }, start_at: DAY.from, end_at: DAY.until, resource_refs: [crewRef(crewC, "Crew C")] }
    ] } });
    await s.upsertDocument(ORG, "projects", { id: "elm", data: { title: "9 Elm St", events: [
      // Eve herself, on other work that afternoon: she is on Roof through crew B.
      { id: "gutters", title: "Gutters", status: "scheduled", start_at: "2026-10-20T13:00:00.000Z", end_at: "2026-10-20T15:00:00.000Z", resource_refs: [userRef("eve", "Eve")] }
    ] } });
    await s.upsertDocument(ORG, "projects", { id: "ash", data: { title: "3 Ash St", events: [
      // Crew A itself, also booked: one overlap for the crew, not one per member.
      { id: "inspection", title: "Inspection", status: "scheduled", start_at: "2026-10-20T15:00:00.000Z", end_at: "2026-10-20T16:00:00.000Z", resource_refs: [crewRef(crewA, "Crew A")] }
    ] } });
    return { crewA, crewB, crewC };
  })();
}

async function read(ctx: any, args: unknown, organizationId = ORG) {
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const result = await readPublishedData(ctx, { provider: "schedule-roster", export: "events", target: { scope: "organization", organizationId }, args } as any);
  if (result.status !== "ready") throw Error(JSON.stringify(result));
  return result.value as any;
}
const userCtx = async (auth: any) => (await import("../platform/publication/context.js")).userPublicationContext(auth);

test("an event read carries its roster and its warnings, derived from the roster and the check", async () => {
  const { crewA, crewB } = await setup();
  const value = await read(await userCtx(owner), { events: [{ project_id: "oak", event_id: "roof" }] });
  assert.equal(value.timezone, "UTC");
  assert.deepEqual(value.events.map((entry: any) => [entry.event_id, entry.parent_event_id, entry.draft]), [["roof", "", false], ["roof_cleanup", "roof", false]], "its children come with it");
  const roof = value.events[0];
  assert.deepEqual(roof.window, DAY);
  // A person in two groups is one person: Cy is on through crew A and crew B.
  assert.deepEqual(roof.roster.people.map((person: any) => [person.name, person.via.length]), [["Ana", 1], ["Ben", 1], ["Cy", 2], ["Eve", 1]]);
  assert.deepEqual(roof.roster.people.find((person: any) => person.name === "Cy").via.sort(), [`resource_group:${crewA}`, `resource_group:${crewB}`].sort());
  assert.equal(roof.roster.count, 4);
  assert.deepEqual([roof.roster.min_count, roof.roster.max_count], [3, 4], "Ana is off for the morning");
  assert.deepEqual(roof.roster.days, [{ date: "2026-10-20", person_ids: ["organization_user:ana", "organization_user:ben", "organization_user:cy", "organization_user:eve"], party_ids: [] }]);

  const kinds = roof.warnings.map((warning: any) => warning.kind).sort();
  assert.deepEqual(kinds, ["assignee_overlap", "double_booked", "staffing_requirement_unmet", "unavailable"]);
  const unmet = roof.warnings.find((warning: any) => warning.kind === "staffing_requirement_unmet");
  assert.match(unmet.message, /Crew A and Crew B are assigned, but the only CDL driver \(Ana\) is off/);
  assert.deepEqual(unmet.intervals, [{ from: DAY.from, until: "2026-10-20T12:00:00.000Z" }]);
  assert.equal(roof.staffing_requirements[0].met, false);
  // Eve reaches Gutters herself and Roof through crew B: only the roster sees it, and it is reported once.
  const booked = roof.warnings.filter((warning: any) => warning.kind === "double_booked");
  assert.deepEqual(booked.map((warning: any) => [warning.person_id, warning.mode]), [["organization_user:eve", "warn"]]);
  assert.match(booked[0].message, /Eve is also on Gutters/);
  // Crew A on Inspection is the assignee check's answer, once, and its members are not repeated as people conflicts.
  const overlap = roof.warnings.filter((warning: any) => warning.kind === "assignee_overlap");
  assert.deepEqual(overlap.map((warning: any) => [warning.assignee_id, warning.mode]), [[`resource_group:${crewA}`, "warn"]]);
  assert.deepEqual(roof.assignee_conflicts.map((conflict: any) => [conflict.reason, conflict.assignee.name || conflict.assignee.id]).sort(), [["overlap", "Crew A"], ["person", "Eve"]]);
  assert.deepEqual(roof.assignee_conflicts.find((conflict: any) => conflict.reason === "person").via, [`resource_group:${crewB}`]);

  // A member who has left is reported, not counted.
  const cleanup = value.events[1];
  assert.deepEqual(cleanup.roster.people.map((person: any) => person.name), ["Fay"]);
  assert.deepEqual(cleanup.warnings.map((warning: any) => warning.kind), ["missing_member"]);
  assert.match(cleanup.warnings[0].message, /Gus is in Crew C but is no longer active/);

  // Nothing derived is written to the stored events.
  const stored = (await (await import("../platform/storage.js")).readDocument(ORG, "projects", "oak")).data as any;
  for (const event of stored.events) for (const field of ["roster", "warnings", "roster_warnings", "assignee_conflicts", "staffing_requirement_results"]) assert.equal(field in event, false, `${event.id} has no ${field}`);
});

test("the placement preview answers for the draft and the children it would move", async () => {
  await setup();
  const value = await read(await userCtx(owner), { draft: { project_id: "oak", event: { id: "roof", start_at: "2026-10-21T08:00:00.000Z", end_at: "2026-10-21T17:00:00.000Z" } } });
  assert.deepEqual(value.events.map((entry: any) => [entry.event_id, entry.draft, entry.window?.from]), [["roof", true, "2026-10-21T08:00:00.000Z"], ["roof_cleanup", true, "2026-10-21T08:00:00.000Z"]]);
  assert.deepEqual(value.events[0].warnings, [], "the next day Ana is in, nobody is booked twice and crew A is free");
  assert.deepEqual(value.events[0].roster.days.map((day: any) => day.date), ["2026-10-21"]);
  const stored = (await (await import("../platform/storage.js")).readDocument(ORG, "projects", "oak")).data as any;
  assert.equal(stored.events[0].start_at, DAY.from, "a preview saves nothing");
});

test("an unmet staffing requirement warns, and saving the event still succeeds", async () => {
  const { crewB } = await setup();
  const { saveProjectScheduleEvent } = await import("../platform/api.js");
  const event = {
    id: "survey", title: "Survey", type_id: "project_work", status: "scheduled", start_at: "2026-10-22T08:00:00.000Z", end_at: "2026-10-22T10:00:00.000Z",
    resource_refs: [crewRef(crewB, "Crew B")],
    staffing_requirements: [{ id: "foreman", label: "foreman", count: 1, where: { rules: [{ field: "type_ids", operator: "contains", value: "crew_foreman" }] } }]
  };
  const saved: any = await saveProjectScheduleEvent(ORG, "elm", owner, { event });
  assert.equal(saved.event?.id || saved.document?.data?.events?.find((entry: any) => entry.id === "survey")?.id, "survey", "the save is not refused");
  const value = await read(await userCtx(owner), { events: [{ project_id: "elm", event_id: "survey" }] });
  const unmet = value.events[0].warnings.filter((warning: any) => warning.kind === "staffing_requirement_unmet");
  assert.equal(unmet.length, 1, JSON.stringify(value.events[0]));
  assert.equal(unmet[0].mode, "warn");
  assert.match(unmet[0].message, /foreman/);
});

test("rosters and checks consider only the assignees in the reader's branches", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: BRANCHED, name: "Branched" });
  await enableExpandedPlatformFixture(BRANCHED, { [FEATURE]: true });
  for (const [id, name] of [["north", "North"], ["south", "South"]]) await s.upsertDocument(BRANCHED, "branch", { id, data: { name } });
  for (const [id, branch] of [["nora", "north"], ["sam", "south"], ["viewer", "north"]] as const) await s.upsertDocument(BRANCHED, "users", { id, data: { name: id[0]!.toUpperCase() + id.slice(1), email: `${id}@example.test`, status: "active", branch_id: branch } });
  const workforce = await import("../workforce/storage.js");
  const north = String((await workforce.createResourceGroup(BRANCHED, { name: "North team", kind_id: "crew", branch_id: "north", members: [{ user_id: "nora" }] })).id);
  const south = String((await workforce.createResourceGroup(BRANCHED, { name: "South team", kind_id: "crew", branch_id: "south", members: [{ user_id: "sam" }] })).id);
  await s.upsertDocument(BRANCHED, "projects", { id: "p", data: { title: "Shared job", events: [
    { id: "both", title: "Both teams", status: "scheduled", start_at: DAY.from, end_at: DAY.until, resource_refs: [crewRef(north, "North team"), crewRef(south, "South team")] }
  ] } });
  await s.upsertDocument(BRANCHED, "projects", { id: "q", data: { title: "South job", events: [
    { id: "south_only", title: "South work", status: "scheduled", start_at: DAY.from, end_at: DAY.until, resource_refs: [crewRef(south, "South team")] }
  ] } });
  const document = await s.readDocument(BRANCHED, "users", "viewer");
  const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(BRANCHED);
  const viewer = {
    orgId: BRANCHED, userId: "viewer", role: "member", permissions: { view_schedule: true }, user: document.data, userDocument: document, branchId: "north",
    identity: {}, organization: {}, identityId: "", csrfToken: "", accessProfile: { roles: [] },
    capabilities: { effectiveByKey: { [FEATURE]: true, "platform.expanded_access": true } },
    applicationAccess: { management: { enabled: true, role_id: "", permissions: { view_schedule: true } } }, organizationStructure: structure, scopedAccessGrants: []
  } as any;
  const asked = { events: [{ project_id: "p", event_id: "both" }] };
  const limited = (await read(await userCtx(viewer), asked, BRANCHED)).events[0];
  assert.deepEqual(limited.roster.people.map((person: any) => person.name), ["Nora"], "the south team is outside the reader's branches");
  assert.deepEqual(limited.warnings, [], "and so is its other work");
  const everyone = (await read(await userCtx({ ...owner, orgId: BRANCHED }), asked, BRANCHED)).events[0];
  assert.deepEqual(everyone.roster.people.map((person: any) => person.name), ["Nora", "Sam"]);
  assert.deepEqual(everyone.warnings.map((warning: any) => warning.kind), ["assignee_overlap"], "an unrestricted reader sees the south team booked twice");
});

test("a person booked through another assignee blocks a save where their setting is block, unless the warning is accepted", async () => {
  const { crewB } = await setup();
  const { saveProjectScheduleEvent } = await import("../platform/api.js");
  const { saveAssigneeSchedulingSetting } = await import("../scheduling/occupancy.js");
  // Eve is on Gutters herself that afternoon; Fascia names only crew B, which she is in. The assignee check cannot see her.
  await saveAssigneeSchedulingSetting(ORG, { assignee: { type: "organization_user", id: "eve" }, overlap: "block" }, owner);
  const event = { id: "fascia", title: "Fascia", type_id: "project_work", status: "scheduled", start_at: "2026-10-20T13:30:00.000Z", end_at: "2026-10-20T14:30:00.000Z", resource_refs: [crewRef(crewB, "Crew B")] };
  const refused: any = await saveProjectScheduleEvent(ORG, "ash", owner, { event }).then(() => null, (error) => error);
  assert.equal(refused?.code, "assignee_conflict", "the save is refused");
  const warning = refused.details.roster_warnings[0];
  assert.deepEqual([warning.kind, warning.person_id, warning.mode, warning.accepted], ["double_booked", "organization_user:eve", "block", false]);
  // Accepting that warning lets it through, and the save says what it accepted.
  const saved: any = await saveProjectScheduleEvent(ORG, "ash", owner, { event: { ...event, accepted_roster_warnings: [warning.id] } });
  assert.ok(saved.roster_warnings.some((entry: any) => entry.id === warning.id && entry.accepted === true));
  assert.ok(saved.assignee_conflicts.some((conflict: any) => conflict.reason === "person"), "the person conflict is reported beside the save");
  await saveAssigneeSchedulingSetting(ORG, { assignee: { type: "organization_user", id: "eve" }, overlap: "warn" }, owner);
});
