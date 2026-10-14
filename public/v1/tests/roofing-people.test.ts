import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "roofing-people-"));
Object.assign(process.env, {
  NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(root, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(root, "pricebook"),
  SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"), MESSAGING_STORAGE_ROOT: path.join(root, "messaging"), CHANNELS_STORAGE_ROOT: path.join(root, "channels"),
  CALLS_STORAGE_ROOT: path.join(root, "calls"), FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "index.sqlite"),
  FIRSTMEASURE_DATA_ENVIRONMENT: "development", PLATFORM_HEARTBEAT_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1",
  PLATFORM_SESSION_SECRET: "roofing-people-test-secret", V1_LOG_LEVEL: "error"
});
after(async () => {
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

const FIELD_ROLES = ["crew_member", "crew_foreman", "repairman", "warehouse_lead", "delivery_driver", "project_manager", "production_manager"];
const SALES_ROLES = ["salesperson", "estimator", "sales_manager", "canvasser"];
const OFFICE_ROLES = ["super_admin", "admin", "office_manager", "csr", "bookkeeper", "production_coordinator", "project_manager", "production_manager", "sales_manager", "estimator", "call_center_rep"];

test("an Instant Full Org starts with a roofing company's people, and running the generator again changes nothing someone made", async () => {
  const storage = await import("../platform/storage.js");
  const signup = await import("../signup-sandbox/service.js");
  const people = await import("../development/roofing-people.js");
  const access = await import("../workforce/access.js");
  const workforce = await import("../workforce/storage.js");
  const base = await import("../assignees/base.js");
  const payroll = await import("../payroll/pay-rules.js");
  const { resolveOrganizationStructure } = await import("../workforce/organization-structure.js");
  await signup.ensureSeedData();
  const { authContext: ctx } = await signup.createTestInstance("swf_instant_full_org");
  const org = ctx.orgId;

  // ---- Everyone has roles, and the apps that go with them.
  const synthetic = async () => (await storage.listDocuments(org, "users")).filter((doc) => (doc.metadata as any)?.source === people.PEOPLE_SOURCE);
  const users = await synthetic();
  assert.equal(users.length, people.ROOFING_PEOPLE.length);
  assert.ok(users.length >= 25 && users.length <= 40);
  const structure = await resolveOrganizationStructure(org);
  for (const doc of users) {
    const data = doc.data as any;
    const profile = await access.resolveAccessProfile(org, doc);
    const roles = profile.access_role_ids;
    assert.ok(roles.length >= 1, `${data.name} has a role`);
    assert.deepEqual(profile.unresolved_access_role_ids, [], `${data.name}'s roles exist`);
    assert.ok(profile.allowed_app_ids.length >= 3, `${data.name} has apps`);
    if (roles.some((role) => FIELD_ROLES.includes(role) && role !== "production_manager" && role !== "project_manager")) assert.ok(profile.allowed_app_ids.includes("portal.crew_overview"), `${data.name} has the field app`);
    if (roles.some((role) => SALES_ROLES.includes(role))) assert.ok(profile.allowed_app_ids.includes("portal.sales_overview"), `${data.name} has the sales app`);
    if (roles.some((role) => OFFICE_ROLES.includes(role))) assert.ok(profile.allowed_app_ids.includes("portal.viewer"), `${data.name} has the office app`);
    else assert.ok(!profile.allowed_app_ids.includes("portal.viewer"), `${data.name} has no office app`);
    assert.match(String(data.email), /@example\.test$/);
    assert.match(String(data.phone), /^\(413\) 555-01\d\d$/);
    assert.deepEqual(data.roles, [], "no notification roles");
    assert.equal(data.identity_id, undefined, "nobody can sign in or was invited");
    assert.ok(structure.users.find((entry) => entry.id === doc.id)?.department_ids.length, `${data.name} is in a department`);
  }
  const byKey = (key: string) => users.find((doc) => doc.id === people.stableId(org, `person:${key}`))!;
  const bookkeeper = await access.resolveAccessProfile(org, byKey("tom"));
  assert.ok(bookkeeper.allowed_app_ids.includes("portal.payroll") && bookkeeper.allowed_app_ids.includes("portal.invoices"));
  assert.ok(!(await access.resolveAccessProfile(org, byKey("priya"))).allowed_app_ids.includes("portal.payroll"), "a CSR does not see payroll");
  assert.ok(!(await access.resolveAccessProfile(org, byKey("jamie"))).allowed_app_ids.includes("portal.viewer"), "an installer has only the field app");
  assert.equal((byKey("sergio").data as any).worker_classification, "independent_contractor");
  assert.equal((byKey("chris").data as any).worker_classification, "employee");
  // The tester who owns the sandbox shows a role too; their own permissions are untouched.
  const tester = (await storage.readDocument(org, "users", ctx.userId)).data as any;
  assert.deepEqual(tester.access_role_ids, ["super_admin"]);
  assert.deepEqual(tester.permissions, { "*": true });

  // ---- Roles: the seeded ones where they fit, and the company's own.
  const roleIds = new Set((await access.listAccessRoles(org)).map((role) => role.id));
  for (const role of people.ROOFING_ROLES) assert.ok(roleIds.has(role.id), role.id);
  // A user's types are their roles; a group type gives its roles on joining.
  assert.ok((await base.assigneeTypeIds(org, { type: "organization_user", id: byKey("derek").id })).includes("salesperson"), "the sales manager joined the sales team and was given its role");
  assert.ok(((await storage.readDocument(org, "users", byKey("derek").id)).data as any).scoped_access_assignments.some((entry: any) => entry.role_id === "department_manager" && entry.scope.id === "sales"));

  // ---- Groups have a type that gives roles, a lead and members; install crews have staffing requirements.
  // Group types are kinds of group: Crew, Sales team, Canvassing team. What a crew does is its capabilities.
  const types = await base.listGroupTypes(org);
  assert.deepEqual(types.filter((type) => type.status === "active").map((type) => type.id).sort(), ["canvass_team", "crew", "sales_team"]);
  const groups = await workforce.listResourceGroups(org);
  for (const spec of people.ROOFING_GROUPS) {
    const group = groups.find((row) => row.name === spec.name)!;
    assert.ok(group, spec.name);
    assert.equal(group.kind_id, spec.type);
    assert.ok(types.find((type) => type.id === spec.type)!.member_role_ids.length, `${spec.type} gives roles`);
    assert.ok(group.primary_member_user_id, `${spec.name} has a lead`);
    assert.ok(group.members.length >= 2, `${spec.name} has members`);
  }
  // Crew A, B and C, made by the sample pay sheets, became Crews 1, 2 and the low-slope crew, keeping their pay sheets.
  assert.equal(groups.filter((row) => /\(sample\)$/.test(row.name)).length, 0);
  const crewA = groups.find((row) => row.name === "Crew 1 – Bennett")!;
  const sheets = await (await import("../labor/pay-sheets.js")).listPaySheets(org);
  assert.ok(sheets.some((sheet) => sheet.subject.id === crewA.id && /Crew A/.test(sheet.name)), "Crew 1 keeps Crew A's pay sheet");
  const { capabilitiesFor } = await import("../labor/capabilities.js");
  const crews = people.ROOFING_GROUPS.filter((spec) => spec.type === "crew").map((spec) => ({ spec, group: groups.find((row) => row.name === spec.name)! }));
  const can = await capabilitiesFor(org, crews.map(({ group }) => ({ type: "resource_group" as const, id: group.id })));
  for (const { spec, group } of crews) {
    const found = can.get(`resource_group:${group.id}`)!;
    assert.ok(found.known, spec.name);
    assert.deepEqual(found.schema_ids, spec.kinds, `${spec.name} declares what it does`);
  }
  assert.ok(can.get(`resource_group:${crewA.id}`)!.items.includes("roofing.install"));
  assert.ok(crewA.capability_scope_ids.includes("roof_replacement") && crewA.capability_scope_ids.includes("repairs"));
  // Repair technicians are people with the seeded Repairman role in Service & Repair, not a group.
  const service = structure.catalog.departments.find((row) => row.id === "service")!;
  for (const key of ["frank", "carlos"]) {
    assert.ok(((byKey(key).data as any).access_role_ids as string[]).includes("repairman"));
    assert.ok(!groups.some((group) => group.members.some((member: any) => member.user_id === byKey(key).id && member.status === "active")), `${key} is in no group`);
    assert.ok(structure.users.find((entry) => entry.id === byKey(key).id)!.department_ids.includes(service.id));
  }
  for (const { spec, group } of crews) {
    const staffing = (await base.readAssigneeBase(org, { type: "resource_group", id: group.id })).staffing_requirements.map((entry) => entry.id);
    assert.ok(staffing.includes("lead") && staffing.includes("cdl"), spec.name);
  }
  const { checkAssignment } = await import("../assignees/roster.js");
  for (const { spec, group } of crews) {
    const check = await checkAssignment(org, { assignment: [{ op: "add", assignee: { type: "resource_group", id: group.id } }], from: "2026-11-02T13:00:00.000Z", until: "2026-11-02T21:00:00.000Z" });
    assert.ok(check.staffing_requirements.length >= 2 && check.staffing_requirements.every((entry: any) => entry.met), `${spec.name}: ${JSON.stringify(check.staffing_requirements)}`);
  }

  // ---- Departments have members, icons and colours; outside companies have types.
  for (const spec of people.ROOFING_DEPARTMENTS) {
    const department = structure.catalog.departments.find((row) => row.id === spec.id || row.label === spec.label)!;
    assert.ok(department?.icon && department.color, spec.label);
    const members = [...structure.users, ...structure.groups, ...structure.connections].filter((entry) => entry.department_ids.includes(department.id));
    assert.ok(members.length, `${spec.label} has members`);
  }
  const companies = await (await import("../connections/storage.js")).listOrganizationConnections(org);
  for (const spec of people.ROOFING_COMPANIES) {
    const company = companies.find((row) => row.name === spec.name)!;
    assert.ok(company, spec.name);
    assert.deepEqual((await base.assigneeTypeIds(org, { type: "organization_connection", id: String(company.id) })).sort(), [...spec.types].sort());
  }

  // ---- Fields live on roles and types and hold sample values.
  const homes = await import("../custom_fields/homes.js");
  assert.ok((await homes.homeDefinitions(org, "role", "crew_foreman")).fields.some((field: any) => field.path === "has_cdl"));
  assert.ok((await homes.homeDefinitions(org, "company_type", "install_subcontractor")).fields.some((field: any) => field.path === "coi_expires"));
  assert.equal((byKey("chris").data as any).custom_field_values.has_cdl, true);

  // ---- Pay: hourly for installers, salary for the office, commission for sales, each from a pay default.
  const slots = async (key: string) => {
    const payee = { type: "organization_user" as const, id: byKey(key).id };
    const plans = new Map((await payroll.listPayPlans(org)).map((plan) => [plan.id, plan]));
    return payroll.effectiveRuleSlots(await payroll.payLayersFor(org, payee), plans, "2026-11-02");
  };
  for (const role of Object.keys(people.ROLE_PAY)) assert.ok((await payroll.readPayDefault(org, { type: "role", id: role })).entries.length, `${role} has a pay default`);
  assert.equal((await slots("jamie")).get("hourly_time_clock")?.params.rate_cents, 2400);
  assert.equal((await slots("chris")).get("hourly_time_clock")?.params.rate_cents, 3200, "a lead's own rate is on top of the role's");
  assert.equal((await slots("morgan")).get("salary")?.params.annual_cents, 6_200_000);
  assert.ok((await slots("kyle")).has("estimator_commission_sold"));
  assert.ok((await slots("sam")).has("salary") && (await slots("sam")).get("estimator_commission_sold")?.params.rate_bps === 150);
  assert.equal((await payroll.readPayDefault(org, { type: "group_type", id: "crew" })).distribution?.[0]?.mode, "split");
  // Every crew member's pay resolves: the Crew member role's hourly plan, with a lead's own rate on top.
  for (const { group } of crews) for (const member of group.members) {
    const key = people.ROOFING_PEOPLE.find((person) => byKey(person.key).id === member.user_id)!.key;
    assert.ok(((await slots(key)).get("hourly_time_clock")?.params.rate_cents as number) > 0, `${key} is paid by the hour`);
  }
  assert.ok((await payroll.readPayDefault(org, { type: "company_type", id: "install_subcontractor" })).entries.some((entry) => entry.kind === "plan"));

  // ---- What someone did by hand survives a second and third run.
  const handRole = await access.createAccessRole(org, { name: "Roof Inspector", application_ids: ["management"] });
  await storage.upsertDocument(org, "users", { id: "user_hand_made", data: { name: "Hand Made", email: "hand@example.test", access_role_ids: [handRole.id], status: "active" } });
  const crewNow = await workforce.readResourceGroup(org, crewA.id);
  await workforce.patchResourceGroup(org, crewA.id, { members: [...crewNow.members.map((m: any) => ({ user_id: m.user_id, role: m.role, is_lead: m.is_lead })), { user_id: "user_hand_made" }], expected_revision: crewNow.revision });
  const chris = await storage.readDocument(org, "users", byKey("chris").id);
  await storage.upsertDocument(org, "users", { id: chris.id, data: { custom_field_values: { ...(chris.data as any).custom_field_values, shirt_size: "M" } } });
  // Suspending someone restamps their document's metadata; they stay the generator's, keep their roles and stay in their group, inactive.
  await storage.upsertDocument(org, "users", { id: byKey("jamie").id, data: { status: "disabled", disabled: true }, metadata: { source: "org_users_set_disabled" } });
  const csr = await payroll.readPayDefault(org, { type: "role", id: "csr" });
  await payroll.savePayDefault(org, { subject: { type: "role", id: "csr" }, entries: [{ kind: "plan", plan_id: "hourly_staff", effective_from: "2026-01-01" }, { kind: "override", rule_id: "hourly_time_clock", params: { rate_cents: 2250 }, effective_from: "2026-06-01" }], expected_revision: csr.revision }, { userId: ctx.userId });

  // ---- An organization with the earlier structure converges: crews move to Crew, the generated types and repair group are archived.
  const departmentsModule = await import("../workforce/departments.js");
  await workforce.saveWorkforceConfiguration(org, { resource_group_kinds: people.RETIRED_GROUP_TYPES.map(([id, name]) => ({ id, name })), expected_revision: (await workforce.readWorkforceConfiguration(org)).revision });
  const crewBefore = await workforce.readResourceGroup(org, crewA.id);
  await workforce.patchResourceGroup(org, crewA.id, { name: "Crew A (sample)", kind_id: "shingle_crew", expected_revision: crewBefore.revision });
  const oldService = await workforce.createResourceGroup(org, { id: people.stableId(org, "group:service"), name: "Service & Repair (sample)", kind_id: "service_crew", members: [{ user_id: byKey("frank").id, is_lead: true, role: "lead" }, { user_id: byKey("carlos").id }], metadata: { synthetic: true, source: people.PEOPLE_SOURCE } });
  await payroll.savePayDefault(org, { subject: { type: "group_type", id: "shingle_crew" }, entries: [], distribution: [{ effective_from: "2026-01-01", mode: "split", method: "rule", split_rule_id: "by_hours_on_the_job" }] }, { userId: ctx.userId });
  await homes.saveHomeDefinitions(org, { kind: "group_type", id: "shingle_crew", fields: [{ path: "crew_truck", type: "text", label: "Crew truck", entity: "team" }], expectedRevision: (await homes.homeDefinitions(org, "group_type", "shingle_crew")).revision });
  const catalog = await departmentsModule.readOrganizationDepartments(org);
  await departmentsModule.saveDepartmentSettings(ctx, { departments: catalog.departments.map((row) => row.id === "production" ? { ...row, group_kind_ids: [...row.group_kind_ids, "shingle_crew", "low_slope_crew"] } : row), terminology: catalog.terminology, revision: catalog.revision });
  // A group someone made on one of the old types keeps it, and so that type stays.
  const handTeam = await workforce.createResourceGroup(org, { name: "Hand-made flat roof team", kind_id: "low_slope_crew" });

  const tools = await import("../development/synthetic-data.js");
  const only = { company: "roofing", categories: Object.fromEntries(tools.CATEGORIES.map((category) => [category.id, category.id === "users"])) };
  const migrated = await tools.generateSyntheticData(ctx, only);
  assert.equal((migrated.results.users as any).status, "complete", JSON.stringify(migrated.results.users));
  const crewAfter = await workforce.readResourceGroup(org, crewA.id);
  assert.equal(crewAfter.name, "Crew 1 – Bennett"); assert.equal(crewAfter.kind_id, "crew");
  assert.equal((await workforce.readResourceGroup(org, oldService.id)).status, "archived");
  const kinds = (await workforce.readWorkforceConfiguration(org)).resource_group_kinds as any[];
  for (const id of ["shingle_crew", "service_crew", "gutter_crew"]) assert.equal(kinds.find((kind) => kind.id === id).status, "archived", id);
  assert.equal(kinds.find((kind) => kind.id === "low_slope_crew").status, "active", "a type someone still uses is kept");
  assert.equal((await workforce.readResourceGroup(org, handTeam.id)).kind_id, "low_slope_crew");
  const oldPay = await payroll.readPayDefault(org, { type: "group_type", id: "shingle_crew" });
  assert.ok(!oldPay.entries.length && !oldPay.distribution?.length, "the old type's pay default is cleared");
  const production = (await departmentsModule.readOrganizationDepartments(org)).departments.find((row) => row.id === "production")!;
  assert.ok(!production.group_kind_ids.includes("shingle_crew") && production.group_kind_ids.includes("low_slope_crew") && production.group_kind_ids.includes("crew"));
  assert.equal((await workforce.listResourceGroups(org)).filter((group) => people.ROOFING_GROUPS.some((spec) => spec.name === group.name)).length, people.ROOFING_GROUPS.length, "no crew is doubled");

  const snapshot = async () => ({
    users: (await storage.listDocuments(org, "users")).length, groups: (await workforce.listResourceGroups(org)).length,
    companies: (await (await import("../connections/storage.js")).listOrganizationConnections(org, { relationship_scope: "all" })).length,
    roles: (await access.listAccessRoles(org)).length, departments: (await resolveOrganizationStructure(org)).catalog.departments.length,
    defaults: (await payroll.listPayDefaults(org)).length, setups: (await payroll.listPaySetups(org)).length,
    channels: (await (await import("../channels/storage.js")).listChannelRecords(org, { includeArchived: true })).length,
    fields: ((await storage.readBranchModule(org, "default", "custom_fields")).data.fields as unknown[]).length
  });
  const before = await snapshot();
  for (let run = 0; run < 2; run++) {
    const result = await tools.generateSyntheticData(ctx, only);
    assert.equal((result.results.users as any).status, "complete", JSON.stringify(result.results.users));
    assert.equal((result.results.users as any).created, 0);
    assert.deepEqual({ ...(result.results.users as any), status: undefined }, { created: 0, updated: 0, roles: {}, groups: {}, companies: {}, departments: {}, fields: {}, pay: { kept: 1 }, status: undefined }, "a repeat run changes nothing; the CSR pay default edited by hand is kept");
  }
  assert.deepEqual(await snapshot(), before, "nothing is duplicated");
  assert.ok((await workforce.readResourceGroup(org, crewA.id)).members.some((member: any) => member.user_id === "user_hand_made"), "a member added by hand stays");
  const jamie = (await storage.readDocument(org, "users", byKey("jamie").id)).data as any;
  assert.equal(jamie.status, "disabled"); assert.ok(jamie.access_role_ids.includes("crew_member"));
  assert.equal((await workforce.readResourceGroup(org, crewA.id)).members.find((member: any) => member.user_id === byKey("jamie").id)?.status, "inactive");
  assert.equal(((await storage.readDocument(org, "users", byKey("chris").id)).data as any).custom_field_values.shirt_size, "M", "an edited value stays");
  assert.ok((await payroll.readPayDefault(org, { type: "role", id: "csr" })).entries.some((entry) => entry.effective_from === "2026-06-01"), "an edited pay default stays");
  assert.ok((await access.listAccessRoles(org)).some((role) => role.id === handRole.id));
  assert.equal(((await storage.readDocument(org, "users", "user_hand_made")).data as any).name, "Hand Made");

  // ---- Only development sandboxes.
  const real = await storage.createOrganization({ name: "Not a sandbox" });
  await assert.rejects(people.seedRoofingPeople({ ...ctx, orgId: String(real.id) }), /sandbox/);
  const { env } = await import("../src/config/env.js");
  const original = env.dataEnvironment;
  (env as any).dataEnvironment = "production";
  try { await assert.rejects(people.seedRoofingPeople(ctx), /Not found/); } finally { (env as any).dataEnvironment = original; }
});
