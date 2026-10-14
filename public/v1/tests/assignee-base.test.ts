import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "assignee-base-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_assignees", OTHER = "org_assignees_other", JOIN = "org_assignees_join";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: {} }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any;
const member = (permissions: Record<string, boolean>) => ({ ...owner, userId: "member", role: "member", permissions, accessProfile: { roles: [] } });
const user = (id: string) => ({ type: "organization_user" as const, id });
let ready: Promise<{ crew: string; second: string; sub: string }> | null = null;
/** Five people, two groups that share one of them, and an outside company, each in its own store. */
function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    for (const [id, name] of [[ORG, "Assignees"], [OTHER, "Other"], [JOIN, "Joining"]]) {
      await s.createOrganization({ id, name });
      await s.saveGlobal(id!, { data: { timezone: "UTC", app_flags: { platform: { expanded_access: true } } } }, { replace: false });
      await enableExpandedPlatformFixture(id!, {});
    }
    await s.saveBranchModule(ORG, "default", "custom_fields", { data: { fields: [
      { entity: "user", path: "has_cdl", key: "has_cdl", type: "boolean", label: "Has a CDL" },
      { entity: "user", path: "years", key: "years", type: "integer", label: "Years" },
      { entity: "user", path: "pay_grade", key: "pay_grade", type: "text", label: "Pay grade", private: true }
    ] } });
    // Ana and Dan have roles saved; the others have none saved. A person's roles are their types.
    for (const [id, name, fields, roles] of [["ana", "Ana", { has_cdl: true, years: 9, pay_grade: "C" }, ["crew_foreman"]], ["ben", "Ben", { has_cdl: false, years: 2 }, null], ["cy", "Cy", { years: 4 }, null], ["dan", "Dan", { has_cdl: true }, ["crew_member", "salesperson"]], ["eve", "Eve", {}, null]] as const)
      await s.upsertDocument(ORG, "users", { id, data: { name, email: `${id}@example.test`, status: "active", custom_field_values: fields, ...(roles ? { access_role_ids: [...roles] } : {}) } });
    await s.upsertDocument(ORG, "users", { id: "old", data: { name: "Old", status: "archived" } });
    await s.upsertDocument(OTHER, "users", { id: "zed", data: { name: "Zed", status: "active" } });
    const workforce = await import("../workforce/storage.js");
    const config = await workforce.readWorkforceConfiguration(ORG);
    await workforce.saveWorkforceConfiguration(ORG, { assignment_tags: [{ id: "roofing", name: "Roofing" }, { id: "lead", name: "Lead" }], expected_revision: config.revision });
    const crew = await workforce.createResourceGroup(ORG, { name: "Crew A", kind_id: "crew", members: [{ user_id: "ana", is_lead: true }, { user_id: "ben" }, { user_id: "cy" }] });
    const second = await workforce.createResourceGroup(ORG, { name: "Crew B", kind_id: "crew", member_user_ids: ["cy", "eve"] });
    const sub = await (await import("../connections/storage.js")).createOrganizationConnection(ORG, { name: "Summit Roofing", relationship_type_ids: ["work_provider"] });
    await s.upsertDocument(ORG, "organization_departments", { id: "catalog", data: { groups: [], divisions: [], departments: [
      { id: "production", label: "Production", subject_keys: [`organization_connection:${sub.id}`, "organization_user:dan"], group_kind_ids: ["crew"] },
      { id: "office", label: "Office", subject_keys: ["organization_user:eve"] }
    ] } });
    return { crew: String(crew.id), second: String(second.id), sub: String(sub.id) };
  })();
}

test("one contract covers a person, a group of users and an outside company", async () => {
  const { crew, sub } = await setup();
  const base = await import("../assignees/base.js");
  const ana = (await base.readAssigneeRecord(ORG, user("ana")))!;
  const group = (await base.readAssigneeRecord(ORG, { type: "resource_group", id: crew }))!;
  const company = (await base.readAssigneeRecord(ORG, { type: "organization_connection", id: sub }))!;
  // Every assignee has the same things, whichever store it lives in.
  for (const record of [ana, group, company]) assert.deepEqual(Object.keys(record).sort(), ["branch_ids", "department_ids", "key", "kind", "link", "members", "name", "record", "ref", "role_ids", "status", "store_revision", "tag_ids", "traits", "type_ids"]);
  assert.deepEqual([ana.key, ana.name, ana.status, ana.type_ids, ana.role_ids, ana.members], ["organization_user:ana", "Ana", "active", ["crew_foreman"], ["crew_foreman"], []], "a person's types are their roles");
  assert.deepEqual([group.key, group.name, group.type_ids, group.role_ids, group.members.map((entry) => [entry.user_id, entry.is_lead])], [`resource_group:${crew}`, "Crew A", ["crew"], [], [["ana", true], ["ben", false], ["cy", false]]], "a group has exactly one type, its kind");
  assert.deepEqual([company.key, company.name, company.type_ids, company.link], [`organization_connection:${sub}`, "Summit Roofing", [], { status: "unlinked", organization_id: "" }], "an outside company has no type until it is given some");
  // The kinds differ by structural trait, not by class.
  assert.deepEqual(ana.traits, { has_members: false, has_login: true, external_link: false, splits_pay: false });
  assert.deepEqual(group.traits, { has_members: true, has_login: false, external_link: false, splits_pay: true });
  assert.deepEqual(company.traits, { has_members: false, has_login: false, external_link: true, splits_pay: false }, "an outside company has a login only through an organization it is linked to");
  // Departments come from the one catalog for all three kinds: directly, by the group's type, and for a person by their groups.
  assert.deepEqual([ana.department_ids, group.department_ids, company.department_ids], [["production"], ["production"], ["production"]]);
  assert.deepEqual((await base.readAssigneeRecord(ORG, user("eve")))!.department_ids, ["office", "production"]);

  assert.equal(await base.readAssigneeRecord(ORG, user("nobody")), null);
  assert.equal(await base.readAssigneeRecord(ORG, { type: "resource_group", id: "resource_group_gone" }), null);
  assert.equal(await base.readAssigneeRecord(ORG, { type: "organization_connection", id: "organization_connection_gone" }), null);
  assert.equal(await base.readAssigneeRecord(OTHER, user("ana")), null, "an assignee belongs to its organization");
  assert.equal((await base.readAssigneeRecord(ORG, user("old")))!.status, "archived");
  await assert.rejects(() => base.requireAssigneeRecord(ORG, user("old")), /not available in this organization/);
  const all = await base.listAssigneeRecords(ORG);
  assert.deepEqual(all.map((record) => record.kind).reduce<Record<string, number>>((count, kind) => ({ ...count, [kind]: (count[kind] || 0) + 1 }), {}), { organization_user: 5, resource_group: 2, organization_connection: 1 }, "archived assignees are not listed");

  // Labor, payroll and scheduling keep the names they import; the lookup is the same one.
  const labor = await import("../labor/assignees.js");
  assert.deepEqual(labor.ASSIGNEE_TYPES, ["organization_user", "resource_group", "organization_connection"]);
  assert.equal((await labor.readAssignee(ORG, user("ana")))!.name, "Ana");
  assert.equal((await labor.readAssignee(ORG, { type: "resource_group", id: crew }))!.record.kind_id, "crew");
  assert.equal(await labor.readAssignee(ORG, user("old")), null);
  await assert.rejects(() => labor.requireAssignee(ORG, user("nobody")), /not available in this organization/);
});

test("a person's types are their roles, a group has one type and an outside company can have several", async () => {
  const { crew, sub } = await setup();
  const base = await import("../assignees/base.js");
  const s = await import("../platform/storage.js");
  const group = { type: "resource_group" as const, id: crew }, company = { type: "organization_connection" as const, id: sub };
  assert.deepEqual((await base.listAssigneeTypes(OTHER)), { types: [{ id: "crew", name: "Crew", description: "An internal production team that can be assigned work as a unit.", status: "active", kind: "resource_group", member_role_ids: [] }], revision: 0 }, "reading the lists writes nothing, and there is no user type list");

  // The organization defines group types and company types. Both lists have the same shape.
  await assert.rejects(() => base.saveAssigneeType(ORG, { kind: "organization_connection", name: "Subcontractor" }, member({})), /company settings access/);
  assert.deepEqual(await base.saveAssigneeType(ORG, { kind: "organization_connection", name: "Subcontractor" }, owner), { id: "subcontractor", name: "Subcontractor", description: "", status: "active", kind: "organization_connection", member_role_ids: [] });
  await base.saveAssigneeType(ORG, { kind: "organization_connection", id: "labor-supplier", name: "Supplier of labor" }, owner);
  await base.saveAssigneeType(ORG, { kind: "resource_group", id: "service-team", name: "Service team" }, owner);
  assert.deepEqual((await base.listAssigneeTypes(ORG)).types.map((type) => [type.kind, type.id]), [["resource_group", "crew"], ["resource_group", "service-team"], ["organization_connection", "subcontractor"], ["organization_connection", "labor-supplier"]]);
  assert.deepEqual([(await base.listGroupTypes(ORG)).map((type) => type.id), (await base.listCompanyTypes(ORG)).map((type) => type.id)], [["crew", "service-team"], ["subcontractor", "labor-supplier"]]);
  await assert.rejects(() => base.saveAssigneeType(ORG, { kind: "organization_user", name: "Foreman" }, owner), /Invalid enum value/, "a user type cannot be defined");

  // A person: their types follow their roles, and are changed only by changing roles.
  assert.deepEqual(await base.assigneeTypeIds(ORG, user("ana")), ["crew_foreman"]);
  assert.deepEqual(await base.assigneeTypeIds(ORG, user("dan")), ["crew_member", "salesperson"]);
  // Ben has no roles saved. He still has the role the permission system resolves for him, and that is his type.
  assert.deepEqual([await base.assigneeTypeIds(ORG, user("ben")), (await (await import("../workforce/access.js")).resolveAccessProfile(ORG, await s.readDocument(ORG, "users", "ben"))).access_role_ids], [["viewer"], ["viewer"]], "an inferred role is a type too");
  assert.deepEqual([(await base.readAssigneeRecord(ORG, user("ben")))!.role_ids, (await base.listAssigneeRecords(ORG, ["organization_user"])).find((record) => record.ref.id === "ben")!.type_ids], [["viewer"], ["viewer"]]);
  assert.equal("access_role_ids" in (await s.readDocument(ORG, "users", "ben")).data, false, "and reading it saves nothing to him");
  await (await import("../workforce/service.js")).patchWorkforceUserProfile(ORG, "ana", { access_role_ids: ["crew_foreman", "supervisor"] });
  assert.deepEqual([(await base.readAssigneeRecord(ORG, user("ana")))!.type_ids, (await base.readAssigneeRecord(ORG, user("ana")))!.role_ids], [["crew_foreman", "supervisor"], ["crew_foreman", "supervisor"]]);
  await (await import("../workforce/service.js")).patchWorkforceUserProfile(ORG, "ana", { access_role_ids: ["crew_foreman"] });
  assert.deepEqual(await base.assigneeTypeIds(ORG, user("ana")), ["crew_foreman"]);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: user("ana"), type_ids: ["crew"] }, owner), /types are their roles/);
  assert.deepEqual(await base.setAssigneeProfile(ORG, { assignee: user("ana"), tag_ids: ["lead", "roofing"] }, owner), { assignee: user("ana"), id: "organization_user:ana", name: "Ana", type_ids: ["crew_foreman"], tag_ids: ["lead", "roofing"] });
  assert.equal((await base.readAssigneeBase(ORG, user("ana"))).revision, 0, "nothing about a person's types is kept in the base record");

  // An outside company: zero or more company types, kept in its base record.
  const typed = await base.setAssigneeProfile(ORG, { assignee: company, type_ids: ["subcontractor", "labor-supplier"], tag_ids: ["roofing"] }, owner);
  assert.deepEqual([typed.type_ids, typed.tag_ids], [["subcontractor", "labor-supplier"], ["roofing"]], "one company with two functions");
  assert.deepEqual([await base.assigneeTypeIds(ORG, company), (await base.readAssigneeBase(ORG, company)).type_ids], [["subcontractor", "labor-supplier"], ["subcontractor", "labor-supplier"]]);
  assert.deepEqual((await base.setAssigneeProfile(ORG, { assignee: company, type_ids: [] }, owner)).type_ids, [], "and it can have none");
  await base.setAssigneeProfile(ORG, { assignee: company, type_ids: ["subcontractor", "labor-supplier"] }, owner);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: company, type_ids: ["crew"] }, owner), /no company type called crew/, "a group type is not a company type");
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: company, type_ids: ["ghost"] }, owner), /no company type/);

  // A group: exactly one group type, which is its kind.
  assert.deepEqual([(await base.setAssigneeProfile(ORG, { assignee: group, type_ids: ["service-team"], tag_ids: ["roofing"] }, owner)).type_ids, (await (await import("../workforce/storage.js")).readResourceGroup(ORG, crew)).kind_id], [["service-team"], "service-team"], "a group's type is written to its kind, not to a second field");
  await base.setAssigneeProfile(ORG, { assignee: group, type_ids: ["crew"] }, owner);
  assert.deepEqual([await base.assigneeTypeIds(ORG, group), (await base.readAssigneeBase(ORG, group)).type_ids], [["crew"], []]);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: group, type_ids: ["crew", "service-team"] }, owner), /exactly one type/);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: group, type_ids: [] }, owner), /exactly one type/);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: group, type_ids: ["subcontractor"] }, owner), /no group type called subcontractor/);

  // Each kind keeps its tags where they already lived.
  assert.deepEqual((await s.readDocument(ORG, "users", "ana")).data.assignment_tag_ids, ["lead", "roofing"]);
  assert.deepEqual((await (await import("../connections/storage.js")).readOrganizationConnection(ORG, sub)).metadata.assignment_tag_ids, ["roofing"]);
  assert.deepEqual((await base.readAssigneeRecord(ORG, user("ana")))!.tag_ids, ["lead", "roofing"]);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: user("ben"), tag_ids: ["ghost"] }, owner), /Assignment tags must reference/);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: user("nobody"), tag_ids: [] }, owner), /not available/);
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: user("ben"), tag_ids: [] }, member({ manage_company_settings: false })), /company settings access/);

  // A type that is still in use cannot be archived.
  await assert.rejects(() => base.saveAssigneeType(ORG, { kind: "organization_connection", id: "subcontractor", name: "Subcontractor", status: "archived" }, owner), /Summit Roofing still has this type/);
  await assert.rejects(() => base.saveAssigneeType(ORG, { kind: "resource_group", id: "crew", name: "Crew", status: "archived" }, owner), /2 assignees still have this type/);
  assert.equal((await base.saveAssigneeType(ORG, { kind: "resource_group", id: "service-team", name: "Service team", status: "archived" }, owner)).status, "archived");
  await assert.rejects(() => base.setAssigneeProfile(ORG, { assignee: group, type_ids: ["service-team"] }, owner), /no group type/);
  assert.deepEqual(await base.assigneeTypeIds(ORG, user("nobody")), []);
});

test("an outside company keeps its own permission set, and a group's standing staffing requirements attach to its base record", async () => {
  const { crew, sub } = await setup();
  const base = await import("../assignees/base.js");
  const group = { type: "resource_group" as const, id: crew }, company = { type: "organization_connection" as const, id: sub };
  const before = (await (await import("../platform/storage.js")).readDocument(ORG, "users", "ben")).data;
  const saved = await base.setPermissionDefaults(ORG, { assignee: company, access_role_ids: ["viewer"], permission_overrides: { view_projects: true } }, owner);
  assert.deepEqual([saved.applies_to, saved.access_role_ids, saved.permission_overrides], ["external_people", ["viewer"], { view_projects: true }]);
  assert.deepEqual((await base.readAssigneeBase(ORG, company)).type_ids, ["subcontractor", "labor-supplier"], "one part of the base record is saved without losing another");
  assert.deepEqual(await base.carriedPermissions(ORG, (await base.readAssigneeRecord(ORG, company))!), { applies_to: "external_people", access_role_ids: ["viewer"], permission_overrides: { view_projects: true } });
  assert.deepEqual((await (await import("../platform/storage.js")).readDocument(ORG, "users", "ben")).data, before, "no one's own permissions are touched");
  const own = await base.carriedPermissions(ORG, (await base.readAssigneeRecord(ORG, user("ana")))!);
  assert.deepEqual([own.applies_to, own.access_role_ids], ["self", ["crew_foreman"]], "a person carries their own roles, read from the user record");
  assert.deepEqual(await base.carriedPermissions(ORG, (await base.readAssigneeRecord(ORG, group))!), { applies_to: "members_on_join", access_role_ids: [], permission_overrides: {} }, "a group carries what its type gives on joining");
  // Permission defaults are not kept per group: they belong to the group type.
  await assert.rejects(() => base.setPermissionDefaults(ORG, { assignee: group, access_role_ids: ["viewer"] }, owner), /roles its type gives members/);
  await assert.rejects(() => base.setPermissionDefaults(ORG, { assignee: user("ben"), access_role_ids: ["viewer"] }, owner), /their own roles/);
  await assert.rejects(() => base.setPermissionDefaults(ORG, { assignee: company, access_role_ids: ["ghost_role"] }, owner), /no role called ghost_role/);
  await assert.rejects(() => base.setPermissionDefaults(ORG, { assignee: company, access_role_ids: [] }, member({ manage_company_settings: true, manage_company_user_permissions: false })), /permission administration/);
  await assert.rejects(() => base.setPermissionDefaults(ORG, { assignee: company, access_role_ids: [], expected_revision: 99 }, owner), /changed elsewhere/);

  const cdl = { id: "cdl", label: "CDL driver", count: 1, where: { match: "all", rules: [{ field: "fields.has_cdl", operator: "equals", value: true }] } };
  const kept = await base.setGroupStaffingRequirements(ORG, { assignee: group, staffing_requirements: [cdl] }, owner);
  assert.deepEqual([kept.staffing_requirements, kept.revision], [[cdl], 1]);
  assert.deepEqual((await base.readAssigneeBase(ORG, group)).staffing_requirements, [cdl]);
  await assert.rejects(() => base.setGroupStaffingRequirements(ORG, { assignee: user("ana"), staffing_requirements: [cdl] }, owner), /Only a group of people/);
  await assert.rejects(() => base.setGroupStaffingRequirements(ORG, { assignee: group, staffing_requirements: [cdl, cdl] }, owner), /own id/);
  await assert.rejects(() => base.setGroupStaffingRequirements(ORG, { assignee: group, staffing_requirements: [{ ...cdl, where: { rules: [{ field: "fields.has_cdl", operator: "sounds_like", value: 1 }] } }] }, owner), /not supported/);
  await assert.rejects(() => base.setGroupStaffingRequirements(ORG, { assignee: group, staffing_requirements: [] }, member({ manage_company_settings: false })), /company settings access/);
});

test("the directory is one selectable row per assignee, with people's fields and each group's members", async () => {
  const { crew, second, sub } = await setup();
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  const { userPublicationContext, systemPublicationContext } = await import("../platform/publication/context.js");
  const { selectPublishedData, selectionSupport } = await import("../platform/publication/select.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  initializePublication();
  const target = { scope: "organization" as const, organizationId: ORG };
  const ref = { provider: "assignee-directory", export: "assignees", target };
  const ctx = userPublicationContext(owner);
  assert.deepEqual(selectionSupport(ref), { selectable: true, indexed: false });

  const everyone = await selectPublishedData(ctx, ref, {});
  if (everyone.status !== "ready") throw Error(JSON.stringify(everyone));
  assert.deepEqual(everyone.rows.map((row) => row.key), [`organization_connection:${sub}`, "organization_user:ana", "organization_user:ben", "organization_user:cy", "organization_user:dan", "organization_user:eve", `resource_group:${crew}`, `resource_group:${second}`].sort());
  const row = (key: string) => everyone.rows.find((entry) => entry.key === key)!.value as any;
  const ana = row("organization_user:ana");
  assert.deepEqual([ana.kind, ana.assignee_id, ana.name, ana.status, ana.type_ids, ana.type_names, ana.role_ids, ana.tag_ids, ana.department_ids, ana.group_ids], ["organization_user", "ana", "Ana", "active", ["crew_foreman"], ["Crew Foreman"], ["crew_foreman"], ["lead", "roofing"], ["production"], [`resource_group:${crew}`]], "a person's types are their roles, named from the role store");
  assert.deepEqual([row("organization_user:dan").type_ids, row("organization_user:dan").type_names, row("organization_user:ben").type_ids, row("organization_user:ben").type_names, row("organization_user:ben").role_ids], [["crew_member", "salesperson"], ["Crew Member", "Salesperson"], ["viewer"], ["Viewer"], ["viewer"]], "someone with no roles saved has the role they resolve to");
  assert.deepEqual(ana.fields, { has_cdl: true, years: 9 }, "a private field is never in a row, whoever reads it");
  assert.equal(ana.fields_error, "");
  const group = row(`resource_group:${crew}`);
  assert.deepEqual([group.kind, group.type_ids, group.type_names, group.role_ids, group.member_count, group.member_ids, group.department_ids], ["resource_group", ["crew"], ["Crew"], [], 3, ["organization_user:ana", "organization_user:ben", "organization_user:cy"], ["production"]]);
  assert.deepEqual(group.members[0], { id: "organization_user:ana", user_id: "ana", name: "Ana", role: "member", is_lead: true, status: "active", type_ids: ["crew_foreman"], tag_ids: ["lead", "roofing"], fields: { has_cdl: true, years: 9 } });
  assert.deepEqual([group.member_fields, group.member_tag_ids, group.member_type_ids], [{ has_cdl: [true, false], years: [9, 2, 4] }, ["lead", "roofing"], ["crew_foreman", "viewer"]]);
  const company = row(`organization_connection:${sub}`);
  assert.deepEqual([company.kind, company.type_ids, company.type_names, company.role_ids, company.tag_ids, company.department_ids, company.member_count, company.fields, company.link_status, company.traits.external_link], ["organization_connection", ["labor-supplier", "subcontractor"], ["Supplier of labor", "Subcontractor"], [], ["roofing"], ["production"], 0, {}, "unlinked", true]);
  assert.equal(everyone.rows.every((entry) => entry.revision === (entry.value as any).revision && /^sha256:/.test(entry.revision)), true, "each row carries a revision of its own content");
  assert.equal(everyone.rows.some((entry) => "capabilities" in (entry.value as any) || "type_id" in (entry.value as any)), false);

  const select = async (where: unknown) => { const result = await selectPublishedData(ctx, ref, { where }); if (result.status !== "ready") throw Error(JSON.stringify(result)); return result.rows.map((entry) => entry.key); };
  // What is true of a person is an ordinary field on them.
  assert.deepEqual(await select({ rules: [{ field: "kind", operator: "equals", value: "organization_user" }, { field: "fields.has_cdl", operator: "equals", value: true }] }), ["organization_user:ana", "organization_user:dan"]);
  // And rolls up: groups that have a member for whom it holds, and groups by how many members they have.
  assert.deepEqual(await select({ rules: [{ field: "member_fields.has_cdl", operator: "contains", value: true }] }), [`resource_group:${crew}`]);
  assert.deepEqual(await select({ rules: [{ field: "kind", operator: "equals", value: "resource_group" }, { field: "member_count", operator: "less_than", value: 3 }] }), [`resource_group:${second}`]);
  assert.deepEqual(await select({ rules: [{ field: "member_ids", operator: "contains", value: "organization_user:cy" }] }), [`resource_group:${crew}`, `resource_group:${second}`].sort(), "the groups a person is in");
  // Shared fields select across kinds.
  assert.deepEqual(await select({ rules: [{ field: "tag_ids", operator: "contains", value: "roofing" }] }), [`organization_connection:${sub}`, "organization_user:ana", `resource_group:${crew}`].sort());
  assert.deepEqual(await select({ rules: [{ field: "department_ids", operator: "contains", value: "office" }] }), ["organization_user:eve"]);
  assert.deepEqual(await select({ rules: [{ field: "type_ids", operator: "contains", value: "subcontractor" }] }), [`organization_connection:${sub}`]);
  assert.deepEqual(await select({ rules: [{ field: "type_ids", operator: "contains", value: "crew_member" }] }), ["organization_user:dan"], "everyone with a role");
  assert.deepEqual(await select({ rules: [{ field: "member_type_ids", operator: "contains", value: "crew_foreman" }] }), [`resource_group:${crew}`], "groups with a member who has a role");
  assert.deepEqual(await select({ rules: [{ field: "traits.has_members", operator: "equals", value: true }] }), [`resource_group:${crew}`, `resource_group:${second}`].sort());

  // Unchanged data selects the same revisions; a change to one person changes their row and their group's, and nothing else.
  const again = await selectPublishedData(ctx, ref, {});
  if (again.status !== "ready") throw Error("expected rows");
  assert.equal(again.source.revision, everyone.source.revision);
  await (await import("../platform/storage.js")).upsertDocument(ORG, "users", { id: "ben", data: { custom_field_values: { has_cdl: true, years: 2 } } });
  const changed = await selectPublishedData(ctx, ref, {});
  if (changed.status !== "ready") throw Error("expected rows");
  const moved = changed.rows.filter((entry) => entry.revision !== everyone.rows.find((old) => old.key === entry.key)!.revision).map((entry) => entry.key);
  assert.deepEqual(moved, ["organization_user:ben", `resource_group:${crew}`]);
  await (await import("../platform/storage.js")).upsertDocument(ORG, "users", { id: "ben", data: { custom_field_values: { has_cdl: false, years: 2 } } });

  // Authorization: a person needs to see the schedule; another organization sees nothing of this one; the platform needs a grant.
  assert.equal((await selectPublishedData(userPublicationContext(member({ view_schedule: false }) as any), ref, {})).status, "denied");
  assert.equal((await selectPublishedData(userPublicationContext({ ...owner, orgId: OTHER } as any), ref, {})).status, "denied");
  const other = await selectPublishedData(userPublicationContext({ ...owner, orgId: OTHER } as any), { ...ref, target: { scope: "organization", organizationId: OTHER } }, {});
  assert.deepEqual(other.status === "ready" && other.rows.map((entry) => entry.key), ["organization_user:zed"]);
  assert.equal((await selectPublishedData(systemPublicationContext({ kind: "work", organizationId: ORG, operations: ["assignee-directory.types"] }), ref, {})).status, "denied");
  const granted = await selectPublishedData(systemPublicationContext({ kind: "work", organizationId: ORG, operations: ["assignee-directory.assignees"] }), ref, { where: { rules: [{ field: "fields.has_cdl", operator: "equals", value: true }] } });
  assert.deepEqual(granted.status === "ready" && granted.rows.map((entry) => entry.key), ["organization_user:ana", "organization_user:dan"], "pay rules and duration formulas select the same rows a person does");

  const types = await readPublishedData(ctx, { provider: "assignee-directory", export: "types", target });
  assert.deepEqual(types.status === "ready" && (types.value as any[]).map((type) => [type.kind, type.id, type.status]), [["resource_group", "crew", "active"], ["resource_group", "service-team", "archived"], ["organization_connection", "subcontractor", "active"], ["organization_connection", "labor-supplier", "active"]]);
  const staffing = await readPublishedData(ctx, { provider: "assignee-directory", export: "staffing-requirements", target });
  assert.deepEqual(staffing.status === "ready" && (staffing.value as any[]).map((entry) => [entry.id, entry.staffing_requirements.map((requirement: any) => requirement.id)]), [[`resource_group:${crew}`, ["cdl"]]]);
});

test("the roster and its check read time off, the schedule and the group's own staffing requirements, and only warn", async () => {
  const { crew, second, sub } = await setup();
  const s = await import("../platform/storage.js");
  const off = await import("../assignees/time-off.js");
  const roster = await import("../assignees/roster.js");
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  initializePublication();
  const target = { scope: "organization" as const, organizationId: ORG };
  const ctx = userPublicationContext(owner), command = userPublicationContext(owner, { mode: "command" });
  const window = { from: "2026-10-13T08:00:00.000Z", until: "2026-10-13T17:00:00.000Z" };
  const morning = { from: "2026-10-13T08:00:00.000Z", until: "2026-10-13T12:00:00.000Z" };
  const assignment = [{ op: "add", assignee: { type: "resource_group", id: crew } }];

  // Time off is an exact interval per person, recorded through the published action.
  const entry = (await invokeAction(command, { action: "assignees.time-off.save", target }, { assignee: user("ana"), ...morning, reason: "Dentist" }, { idempotencyKey: "time-off-ana-1" })).value as any;
  assert.deepEqual([entry.assignee_id, entry.from, entry.until, entry.reason, entry.revision], ["organization_user:ana", morning.from, morning.until, "Dentist", 1]);
  await assert.rejects(() => off.saveTimeOff(ORG, { assignee: { type: "resource_group", id: crew }, ...morning }, owner), /people in a group/);
  await assert.rejects(() => off.saveTimeOff(ORG, { assignee: user("ana"), from: morning.until, until: morning.from }, owner), /end after it starts/);
  await assert.rejects(() => off.saveTimeOff(ORG, { assignee: user("ana"), ...morning }, member({ manage_schedule: false })), /schedule management access/);
  assert.deepEqual((await off.listTimeOff(ORG, { from: "2026-10-13T12:00:00.000Z", until: "2026-10-14T00:00:00.000Z" })).length, 0, "an interval that ends when the range starts does not touch it");
  assert.deepEqual((await off.listTimeOff(ORG, { from: "2026-10-13T11:59:00.000Z", until: "2026-10-14T00:00:00.000Z" })).map((row) => row.id), [entry.id]);
  // The scheduling settings' older whole-day exception is read as that whole local day.
  await s.saveBranchModule(ORG, "default", "scheduling", { data: { resource_availability: { "organization_user:cy": { exceptions: [{ date: "2026-10-13", available: false, reason: "Holiday" }, { date: "2026-10-14", available: true }] } } } });
  // Other work on the schedule: crew B (Cy and Eve) is on another project that afternoon, and Ben has an appointment of his own.
  await s.upsertDocument(ORG, "projects", { id: "elm", data: { title: "9 Elm St", events: [
    { id: "ev_b", title: "Install", start_at: "2026-10-13T13:00:00.000Z", end_at: "2026-10-13T18:00:00.000Z", resource_refs: [{ kind: "resource_group", id: second, name: "Crew B", role: "crew" }] },
    { id: "ev_cancelled", title: "Cancelled", status: "cancelled", start_at: "2026-10-13T08:00:00.000Z", end_at: "2026-10-13T18:00:00.000Z", resource_refs: [{ kind: "resource_group", id: crew }] },
    { id: "ev_self", title: "This work", start_at: window.from, end_at: window.until, resource_refs: [{ kind: "resource_group", id: crew }] }
  ] } });
  await s.upsertDocument(ORG, "calendar_events", { id: "cal_ben", data: { title: "Sales call", start_at: "2026-10-13T09:00:00.000Z", duration_minutes: 30, assigned_user_ids: ["ben"] } });

  const read = await readPublishedData(ctx, { provider: "assignment-roster", export: "roster", target, args: { assignment, ...window, exclude_event_ids: ["ev_self"] } });
  if (read.status !== "ready") throw Error(JSON.stringify(read));
  const value = read.value as any;
  assert.deepEqual(value.people.map((person: any) => [person.name, person.present, person.fields, person.type_ids]), [
    ["Ana", [{ from: morning.until, until: window.until }], { has_cdl: true, years: 9 }, ["crew_foreman"]],
    ["Ben", [window], { has_cdl: false, years: 2 }, ["viewer"]]
  ]);
  assert.deepEqual(value.absent.map((person: any) => [person.name, person.reason, person.unavailable[0].source, person.unavailable[0].reason]), [["Cy", "unavailable", "schedule_exception", "Holiday"]]);
  assert.deepEqual(value.conflicts.map((conflict: any) => [conflict.name, conflict.work.id, conflict.work.title, conflict.work.project_id, conflict.intervals]), [["Ben", "cal_ben", "Sales call", "", [{ from: "2026-10-13T09:00:00.000Z", until: "2026-10-13T09:30:00.000Z" }]]], "Cy is off, so is not double booked; the work itself and a cancelled event hold no one");
  assert.deepEqual([value.facts.count, value.facts.min_count, value.facts.max_count, value.facts.person_hours, value.facts.fields, value.facts.type_ids], [2, 1, 2, 14, { has_cdl: [true, false], years: [9, 2] }, ["crew_foreman", "viewer"]]);
  assert.deepEqual(value.timeline.map((segment: any) => segment.person_ids.length), [1, 2]);

  // "What is wrong with this assignment": the group's standing CDL staffing requirement, and the work's own.
  const args = { assignment, ...window, exclude_event_ids: ["ev_self"], staffing_requirements: [{ id: "two", label: "experienced roofer", count: 2, where: { rules: [{ field: "fields.years", operator: "greater_or_equal", value: 4 }] } }] };
  const checked = await readPublishedData(ctx, { provider: "assignment-roster", export: "check", target, args });
  if (checked.status !== "ready") throw Error(JSON.stringify(checked));
  const check = checked.value as any;
  assert.equal(check.ok, false);
  assert.deepEqual(check.staffing_requirements.map((result: any) => [result.staffing_requirement_id, result.source.kind, result.met]), [["two", "work", false], ["cdl", "assignee", false]]);
  assert.deepEqual(check.warnings.map((warning: any) => [warning.kind, warning.message]), [
    ["staffing_requirement_unmet", "Crew A is assigned, but its experienced roofers (Ana and Cy) are off 8:00 AM-12:00 PM on Oct 13 and 8:00 AM-5:00 PM on Oct 13."],
    ["staffing_requirement_unmet", "Crew A is assigned, but its only CDL driver (Ana) is off 8:00 AM-12:00 PM on Oct 13."],
    ["double_booked", "Ben is also on Sales call 9:00 AM-9:30 AM on Oct 13."],
    ["unavailable", "Ana is off 8:00 AM-12:00 PM on Oct 13 (Dentist) and is not counted on the work then."],
    ["unavailable", "Cy is off 8:00 AM-5:00 PM on Oct 13 (Holiday) and is not counted on the work then."]
  ]);
  assert.deepEqual(check.warnings.slice(0, 2).map((warning: any) => [warning.staffing_requirement_id, /^staffing-requirement:/.test(warning.id)]), [["two", true], ["cdl", true]]);
  // A staffing requirement can name a role, because a person's types are their roles.
  const byRole = await roster.checkAssignment(ORG, { assignment, ...window, exclude_event_ids: ["ev_self"], staffing_requirements: [{ id: "foreman", label: "foreman", count: 1, where: { rules: [{ field: "type_ids", operator: "contains", value: "crew_foreman" }] } }], accepted: [] });
  assert.deepEqual(byRole.staffing_requirements.map((result) => [result.staffing_requirement_id, result.met, result.matching_ids]), [["foreman", false, ["organization_user:ana"]], ["cdl", false, ["organization_user:ana"]]]);
  // The remedies: add someone for that time, or accept the warning. Neither is forced, and nothing was refused.
  const covered = await roster.checkAssignment(ORG, { assignment: [...assignment, { op: "add", assignee: user("dan"), ...morning }], ...window, exclude_event_ids: ["ev_self"] });
  assert.deepEqual(covered.staffing_requirements.map((result) => [result.staffing_requirement_id, result.met]), [["cdl", true]]);
  const accepted = await roster.checkAssignment(ORG, { ...args, accepted: check.warnings.map((warning: any) => warning.id) });
  assert.deepEqual([accepted.ok, accepted.warnings.every((warning) => warning.accepted), accepted.warnings.length], [true, true, 5]);
  // An outside company is one party and an entry naming no one is said.
  const company = await roster.checkAssignment(ORG, { assignment: [{ op: "add", assignee: { type: "organization_connection", id: sub } }, { op: "add", assignee: user("nobody") }], ...window });
  assert.deepEqual([company.roster.parties.map((party) => [party.name, party.type_ids]), company.roster.facts.count, company.warnings.map((warning) => warning.kind)], [[["Summit Roofing", ["labor-supplier", "subcontractor"]]], 0, ["unknown_assignee"]]);
  // A caller that already holds the schedule as it will be passes it instead of having it read.
  const supplied = await roster.loadRoster(ORG, { assignment, ...window }, { other_work: [] });
  assert.deepEqual(supplied.roster.conflicts, []);

  assert.equal((await readPublishedData(userPublicationContext(member({ view_schedule: false }) as any), { provider: "assignment-roster", export: "check", target, args })).status, "denied");
  assert.equal((await readPublishedData(ctx, { provider: "assignment-roster", export: "roster", target, args: { assignment, from: window.until, until: window.from } })).status, "error", "a window that ends before it starts is refused, not answered");
  const timeOff = await readPublishedData(ctx, { provider: "assignee-directory", export: "time-off", target });
  assert.deepEqual(timeOff.status === "ready" && (timeOff.value as any[]).map((row) => [row.assignee_id, row.from, row.until]), [["organization_user:ana", morning.from, morning.until]]);
  assert.deepEqual((await invokeAction(command, { action: "assignees.time-off.remove", target }, { id: entry.id }, { idempotencyKey: "time-off-ana-remove" })).value, { id: entry.id, removed: true });
  assert.equal((await roster.checkAssignment(ORG, { assignment, ...window, exclude_event_ids: ["ev_self"] })).staffing_requirements[0]!.met, true);
});

test("the published actions set types, profiles and defaults with the permissions their bundles name", async () => {
  const { sub } = await setup();
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { publishedActionPermission, publishedDataPermission } = await import("../platform/publication/permission-bundles.js");
  initializePublication();
  const target = { scope: "organization" as const, organizationId: ORG };
  const command = userPublicationContext(owner, { mode: "command" });
  assert.deepEqual(["assignees.type.save", "assignees.type.member-roles.set", "assignees.profile.set", "assignees.staffing-requirements.set", "assignees.permission-defaults.set", "assignees.time-off.save", "assignees.time-off.remove"].map(publishedActionPermission),
    ["manage_company_settings", "manage_company_user_permissions", "manage_company_settings", "manage_company_settings", "manage_company_user_permissions", "manage_schedule", "manage_schedule"]);
  assert.deepEqual(["assignee-directory.assignees", "assignee-directory.types", "assignee-directory.time-off", "assignee-directory.staffing-requirements", "assignment-roster.roster", "assignment-roster.check"].map(publishedDataPermission), Array(6).fill("view_schedule"));
  // An outside company's permission set is read by permission administrators, by the company's key, and is not in the directory row.
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { selectPublishedData } = await import("../platform/publication/select.js");
  assert.equal(publishedDataPermission("assignee-directory.permission-defaults"), "manage_company_user_permissions");
  const defaults = (id: string) => ({ provider: "assignee-directory", export: "permission-defaults", target: { ...target, id } });
  const carried = await readPublishedData(userPublicationContext(owner), defaults(`organization_connection:${sub}`));
  if (carried.status !== "ready") throw Error(JSON.stringify(carried));
  assert.deepEqual(carried.value, { assignee: { type: "organization_connection", id: sub }, permission_defaults: { access_role_ids: ["viewer"], permission_overrides: { view_projects: true } }, revision: (await (await import("../assignees/base.js")).readAssigneeBase(ORG, { type: "organization_connection", id: sub })).revision });
  assert.equal((await readPublishedData(userPublicationContext(member({ view_schedule: true, manage_company_settings: true, manage_company_user_permissions: false }) as any), defaults(`organization_connection:${sub}`))).status, "denied", "seeing the schedule, or company settings, is not enough");
  assert.equal((await readPublishedData(userPublicationContext({ ...owner, orgId: OTHER } as any), defaults(`organization_connection:${sub}`))).status, "denied", "nor is being an administrator somewhere else");
  for (const id of ["organization_user:ana", "organization_connection:ghost", ""]) assert.equal((await readPublishedData(userPublicationContext(owner), defaults(id))).status, "error", `only an outside company has one: ${id}`);
  const rows = await selectPublishedData(userPublicationContext(owner), { provider: "assignee-directory", export: "assignees", target }, { where: { rules: [{ field: "kind", operator: "equals", value: "organization_connection" }] } });
  assert.deepEqual(rows.status === "ready" && rows.rows.map((entry) => [(entry.value as any).type_ids, "permission_defaults" in (entry.value as any)]), [[["labor-supplier", "subcontractor"], false]], "the row has the company's types and not its permissions");
  const type = (await invokeAction(command, { action: "assignees.type.save", target }, { kind: "organization_connection", name: "Inspector" }, { idempotencyKey: "type-inspector-1" })).value as any;
  assert.deepEqual([type.id, type.kind], ["inspector", "organization_connection"]);
  const profile = (await invokeAction(command, { action: "assignees.profile.set", target }, { assignee: { type: "organization_connection", id: sub }, type_ids: ["subcontractor", "inspector"], tag_ids: ["roofing"] }, { idempotencyKey: "profile-sub-1" })).value as any;
  assert.deepEqual([profile.id, profile.type_ids, profile.tag_ids], [`organization_connection:${sub}`, ["subcontractor", "inspector"], ["roofing"]]);
  await assert.rejects(() => invokeAction(command, { action: "assignees.profile.set", target }, { assignee: user("eve"), type_ids: ["inspector"] }, { idempotencyKey: "profile-eve-type" }), /types are their roles/, "the action no longer sets a type on a person");
  const tagged = (await invokeAction(command, { action: "assignees.profile.set", target }, { assignee: user("eve"), tag_ids: ["roofing"] }, { idempotencyKey: "profile-eve-1" })).value as any;
  assert.deepEqual([tagged.id, tagged.type_ids, tagged.tag_ids], ["organization_user:eve", ["viewer"], ["roofing"]]);
  await assert.rejects(() => invokeAction(userPublicationContext(member({ manage_company_settings: false, view_schedule: true }) as any, { mode: "command" }), { action: "assignees.profile.set", target }, { assignee: user("eve"), tag_ids: [] }, { idempotencyKey: "profile-eve-denied" }), /not permitted/);
  await assert.rejects(() => invokeAction(userPublicationContext(owner), { action: "assignees.profile.set", target }, { assignee: user("eve"), tag_ids: [] }, { idempotencyKey: "profile-eve-eval" }), /side effects/);
  // The roles a group type gives its members are permission administration, not company settings.
  await assert.rejects(() => invokeAction(userPublicationContext(member({ manage_company_settings: true, manage_company_user_permissions: false, view_schedule: true }) as any, { mode: "command" }), { action: "assignees.type.member-roles.set", target }, { id: "crew", member_role_ids: ["admin"] }, { idempotencyKey: "member-roles-denied" }), /not permitted/);
  const roles = (await invokeAction(command, { action: "assignees.type.member-roles.set", target }, { id: "crew", member_role_ids: ["crew_member"] }, { idempotencyKey: "member-roles-1" })).value as any;
  assert.deepEqual([roles.id, roles.kind, roles.member_role_ids], ["crew", "resource_group", ["crew_member"]]);
});

test("removing an assignee cleans up what was kept against it, and never strips one that is still active", async () => {
  const { second, sub } = await setup();
  const base = await import("../assignees/base.js");
  const off = await import("../assignees/time-off.js");
  const s = await import("../platform/storage.js");
  const group = { type: "resource_group" as const, id: second }, company = { type: "organization_connection" as const, id: sub };
  // The steps this module and labor own. Other modules (payroll) register their own and are tested there.
  const ours = ["assignee-base", "assignee-time-off", "labor-pay-sheets", "assignee-units", "assignee-capabilities", "labor-delivery-settings"];
  const own = <T extends { name: string }>(steps: T[]) => steps.filter((step) => ours.includes(step.name));
  assert.deepEqual((await base.assigneeCleanupNames()).filter((name) => ours.includes(name)), ours);
  await assert.rejects(() => base.cleanupAssignee(ORG, group, owner), /has not been removed/);
  await assert.rejects(() => base.cleanupAssignee(ORG, group, member({ manage_company_settings: false })), /company settings access/);

  // Things kept against the group and the company, in the base and in labor.
  await base.setGroupStaffingRequirements(ORG, { assignee: group, staffing_requirements: [{ id: "any", label: "person", count: 1, where: { rules: [{ field: "id", operator: "is_present" }] } }] }, owner);
  await off.saveTimeOff(ORG, { assignee: company, from: "2026-12-24T00:00:00.000Z", until: "2026-12-26T00:00:00.000Z", reason: "Closed" }, owner);
  const commitments = await import("../labor/commitments.js");
  const parent = await commitments.saveUnit(ORG, { assignee: group, name: "North" }, owner);
  await commitments.saveUnit(ORG, { assignee: group, name: "North 1", parent_unit_id: parent.id }, owner);
  await commitments.saveDeliverySetting(ORG, { subject: group, method: "share" }, owner);
  await commitments.saveDeliverySetting(ORG, { subject: company, method: "work_order_email", email: "office@summit.test" }, owner);
  await (await import("../labor/capabilities.js")).saveCapabilities(ORG, { assignee: group, schema_ids: [], item_ids: [], excluded_item_ids: [] }, owner);

  const workforce = await import("../workforce/storage.js");
  await workforce.archiveResourceGroup(ORG, second, Number((await workforce.readResourceGroup(ORG, second)).revision));
  const cleaned = await base.cleanupAssignee(ORG, group, owner);
  assert.deepEqual(own(cleaned.steps).map((step) => [step.name, step.removed, step.kept, step.error]), [["assignee-base", 1, 0, ""], ["assignee-time-off", 0, 0, ""], ["labor-pay-sheets", 0, 0, ""], ["assignee-units", 2, 0, ""], ["assignee-capabilities", 1, 0, ""], ["labor-delivery-settings", 1, 0, ""]]);
  assert.deepEqual([(await base.readAssigneeBase(ORG, group)).revision, (await commitments.listUnits(ORG, group)).length, (await commitments.listDeliverySettings(ORG)).map((setting) => setting.subject.type)], [0, 0, ["organization_connection"]], "another assignee's records are untouched");
  assert.deepEqual(own((await base.cleanupAssignee(ORG, group, owner)).steps).map((step) => [step.removed, step.error]), Array(6).fill([0, ""]), "running it again finds nothing and fails nothing");

  const connections = await import("../connections/storage.js");
  await connections.archiveOrganizationConnection(ORG, sub, Number((await connections.readOrganizationConnection(ORG, sub)).revision));
  const gone = await base.cleanupAssignee(ORG, company, owner);
  assert.deepEqual(own(gone.steps).filter((step) => step.removed).map((step) => [step.name, step.removed]), [["assignee-base", 1], ["assignee-time-off", 1], ["labor-delivery-settings", 1]]);
  assert.deepEqual([await off.listTimeOff(ORG, { assignee: company }), (await base.readAssigneeBase(ORG, company)).type_ids], [[], []], "its types and its permission set go with its base record");
  // An assignee that was never in a store at all can be cleaned up after too.
  assert.equal(own((await base.cleanupAssignee(ORG, user("never_was"), owner)).steps).every((step) => !step.error), true);
  assert.equal((await s.readDocument(ORG, "users", "ana")).data.name, "Ana");
});

test("a group type gives its members roles when they join, and leaving takes nothing away", async () => {
  await setup();
  const base = await import("../assignees/base.js");
  const s = await import("../platform/storage.js");
  const workforce = await import("../workforce/storage.js");
  const access = await import("../workforce/access.js");
  const admin = { ...owner, orgId: JOIN };
  // Fay has a role saved, Hal already has the role the type gives, Gus and Ivy have no roles saved at all.
  for (const [id, roles] of [["fay", ["viewer"]], ["hal", ["crew_member"]], ["gus", null], ["ivy", null], ["jo", ["manager"]]] as const)
    await s.upsertDocument(JOIN, "users", { id, data: { name: id, email: `${id}@example.test`, status: "active", ...(roles ? { access_role_ids: [...roles] } : {}) } });
  const roles = async (id: string) => (await s.readDocument(JOIN, "users", id)).data.access_role_ids;

  // The roles are set on the group TYPE, by someone who administers permissions.
  await assert.rejects(() => base.setGroupTypeMemberRoles(JOIN, { id: "crew", member_role_ids: ["crew_member"] }, { ...member({ manage_company_settings: true, manage_company_user_permissions: false }), orgId: JOIN }), /permission administration/);
  await assert.rejects(() => base.setGroupTypeMemberRoles(JOIN, { id: "crew", member_role_ids: ["ghost_role"] }, admin), /no role called ghost_role/);
  await assert.rejects(() => base.setGroupTypeMemberRoles(JOIN, { id: "ghost", member_role_ids: [] }, admin), /no group type/);
  const type = await base.setGroupTypeMemberRoles(JOIN, { id: "crew", member_role_ids: ["crew_member"] }, admin);
  assert.deepEqual([type.kind, type.member_role_ids], ["resource_group", ["crew_member"]]);
  // Saving the type list, or the type itself, with company settings access cannot change them.
  const config = await workforce.readWorkforceConfiguration(JOIN);
  await workforce.saveWorkforceConfiguration(JOIN, { resource_group_kinds: [{ id: "crew", name: "Crew", member_role_ids: ["admin"] }, { id: "office", name: "Office", member_role_ids: ["admin"] }], expected_revision: config.revision });
  assert.deepEqual((await base.saveAssigneeType(JOIN, { kind: "resource_group", id: "crew", name: "Field crew" }, admin)).member_role_ids, ["crew_member"]);
  assert.deepEqual((await base.listGroupTypes(JOIN)).map((entry) => [entry.id, entry.name, entry.member_role_ids]), [["crew", "Field crew", ["crew_member"]], ["office", "Office", []]]);

  // Created with members: each of them joins.
  const group = await workforce.createResourceGroup(JOIN, { name: "Team", kind_id: "crew", members: [{ user_id: "fay" }, { user_id: "hal" }] });
  const ref = { type: "resource_group" as const, id: String(group.id) };
  assert.deepEqual(group.member_role_grants, [{ user_id: "fay", role_ids: ["crew_member"], error: "" }, { user_id: "hal", role_ids: [], error: "" }]);
  assert.deepEqual([await roles("fay"), await roles("hal")], [["viewer", "crew_member"], ["crew_member"]], "the role is added to the user, and one they already have is left alone");
  assert.deepEqual(group.members.map((entry) => [entry.user_id, entry.joined_role_ids]), [["fay", ["crew_member"]], ["hal", []]], "the membership records which roles came from joining");
  assert.deepEqual(await base.assigneeTypeIds(JOIN, user("fay")), ["viewer", "crew_member"], "and a person's types follow their roles");
  assert.deepEqual(await base.carriedPermissions(JOIN, (await base.readAssigneeRecord(JOIN, ref))!), { applies_to: "members_on_join", access_role_ids: ["crew_member"], permission_overrides: {} });

  // Added one at a time. Gus had no roles saved: the ones he resolved to are kept beside the new one.
  const inferred = (await access.resolveAccessProfile(JOIN, await s.readDocument(JOIN, "users", "gus"))).access_role_ids;
  assert.deepEqual([await roles("gus"), inferred, await base.assigneeTypeIds(JOIN, user("gus"))], [undefined, ["viewer"], ["viewer"]]);
  const added = await workforce.putResourceGroupMember(JOIN, ref.id, "gus", { role: "member", expected_revision: Number(group.revision) });
  assert.deepEqual([added.member_role_grants, await roles("gus")], [[{ user_id: "gus", role_ids: ["crew_member"], error: "" }], ["viewer", "crew_member"]]);
  assert.deepEqual((await access.resolveAccessProfile(JOIN, await s.readDocument(JOIN, "users", "gus"))).access_role_ids.sort(), ["crew_member", "viewer"], "nothing he had is lost by saving the list");
  // Changing a member who is already active is not joining.
  const changed = await workforce.putResourceGroupMember(JOIN, ref.id, "hal", { role: "lead", is_lead: true, expected_revision: Number(added.revision) });
  assert.deepEqual(changed.member_role_grants, []);

  // A replaced member list: only the people who were not members before have joined.
  const replaced = await workforce.patchResourceGroup(JOIN, ref.id, { member_user_ids: ["fay", "gus", "ivy"], expected_revision: Number(changed.revision) });
  assert.deepEqual([replaced.member_role_grants, await roles("ivy")], [[{ user_id: "ivy", role_ids: ["crew_member"], error: "" }], ["viewer", "crew_member"]]);
  assert.deepEqual(replaced.members.map((entry) => [entry.user_id, entry.joined_role_ids]).sort(), [["fay", ["crew_member"]], ["gus", ["crew_member"]], ["ivy", ["crew_member"]]], "an earlier member's record of what joining gave them is kept");

  // Leaving removes nothing: Hal was dropped by the new list, Fay is removed outright.
  const left = await workforce.removeResourceGroupMember(JOIN, ref.id, "fay", Number(replaced.revision));
  assert.deepEqual([await roles("fay"), await roles("hal"), left.members.map((entry) => entry.user_id).sort()], [["viewer", "crew_member"], ["crew_member"], ["gus", "ivy"]]);
  // Changing what the type gives changes no one who is already a member, and a type with no roles gives none.
  await base.setGroupTypeMemberRoles(JOIN, { id: "crew", member_role_ids: ["crew_member", "crew_foreman"] }, admin);
  assert.deepEqual(await roles("gus"), ["viewer", "crew_member"]);
  const office = await workforce.createResourceGroup(JOIN, { name: "Front office", kind_id: "office", member_user_ids: ["jo"] });
  assert.deepEqual([office.member_role_grants, await roles("jo")], [[], ["manager"]]);
  // Joining again after the type changed gives what it names now, less what the person already has.
  const rejoined = await workforce.putResourceGroupMember(JOIN, ref.id, "fay", { expected_revision: Number(left.revision) });
  assert.deepEqual([rejoined.member_role_grants, await roles("fay")], [[{ user_id: "fay", role_ids: ["crew_foreman"], error: "" }], ["viewer", "crew_member", "crew_foreman"]]);
});

test("a department has an optional icon beside its color, kept through a save and published with the catalog", async () => {
  await setup();
  const departments = await import("../workforce/departments.js");
  const { departmentSchema } = await import("../workforce/department-contracts.js");
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  initializePublication();
  // The same kind of value scope templates and equipment types store: a Font Awesome class name.
  assert.equal(departmentSchema.parse({ id: "a", label: "A" }).icon, undefined, "it is optional");
  assert.equal(departmentSchema.parse({ id: "a", label: "A", icon: " fa-solid fa-truck " }).icon, "fa-solid fa-truck");
  for (const icon of ["truck", "fa-truck<script>", "FA-TRUCK", "fa-truck;", 7]) assert.equal(departmentSchema.safeParse({ id: "a", label: "A", icon }).success, false, String(icon));

  const current = await departments.readOrganizationDepartments(ORG);
  assert.equal(current.departments.every((department) => department.icon === undefined), true);
  const withIcon = current.departments.map((department) => (department.id === "production" ? { ...department, color: "#b45309", icon: "fa-helmet-safety" } : department));
  const saved = await departments.saveDepartmentSettings(owner, { departments: withIcon, groups: current.groups, divisions: current.divisions, terminology: current.terminology, revision: current.revision });
  assert.deepEqual(saved.departments.map((department) => [department.id, department.color, department.icon]), [["production", "#b45309", "fa-helmet-safety"], ["office", "#64748b", undefined]]);
  await assert.rejects(() => departments.saveDepartmentSettings(owner, { departments: saved.departments.map((department) => ({ ...department, icon: "not an icon" })), groups: saved.groups, divisions: saved.divisions, terminology: saved.terminology, revision: saved.revision }), /Font Awesome/);
  // A later save that only assigns someone keeps it.
  const assigned = await departments.saveDepartmentAssignment(owner, { kind: "user", id: "ben", department_ids: ["office"], revision: saved.revision });
  assert.deepEqual(assigned.departments.map((department) => [department.id, department.icon]), [["production", "fa-helmet-safety"], ["office", undefined]]);
  const published = await readPublishedData(userPublicationContext(owner), { provider: "workforce-departments", export: "catalog", target: { scope: "organization", organizationId: ORG } });
  if (published.status !== "ready") throw Error(JSON.stringify(published));
  assert.deepEqual((published.value as any).departments.map((department: any) => [department.id, department.color, department.icon]), [["production", "#b45309", "fa-helmet-safety"], ["office", "#64748b", undefined]], "wherever a department's color is published, its icon is beside it");
  // Clearing it is saving it empty.
  const cleared = await departments.saveDepartmentSettings(owner, { departments: assigned.departments.map((department) => ({ ...department, icon: "" })), groups: assigned.groups, divisions: assigned.divisions, terminology: assigned.terminology, revision: assigned.revision });
  assert.deepEqual(cleared.departments.map((department) => department.icon), ["", ""]);
});
