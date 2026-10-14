import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

/** Branches and regions, and branch scope on the People data. See docs/architecture/branches.md. */
const dir = await mkdtemp(path.join(os.tmpdir(), "branches-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), CHANNELS_STORAGE_ROOT: path.join(dir, "channels"), MESSAGING_STORAGE_ROOT: path.join(dir, "messaging") });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_branches", SOLO = "org_branches_solo";
const FEATURE = "platform.multiple_branches";
type Ctx = import("../platform/auth.js").PlatformAuthContext;
let ready: Promise<{ crewS: string; crewP: string; everywhere: string; subP: string }> | null = null;

function setup() {
  return ready ||= (async () => {
    const s = await import("../platform/storage.js");
    for (const id of [ORG, SOLO]) {
      await s.createOrganization({ id, name: id });
      await enableExpandedPlatformFixture(id, { [FEATURE]: true });
    }
    for (const [id, name] of [["scranton", "Scranton"], ["erie", "Erie"], ["portland", "Portland"]]) await s.upsertDocument(ORG, "branch", { id, data: { name } });
    const people: Array<[string, string, string[]]> = [["admin", "default", []], ["ann", "scranton", []], ["erin", "erie", []], ["pat", "portland", []], ["multi", "scranton", ["erie"]]];
    for (const [id, branch, more] of people) await s.upsertDocument(ORG, "users", { id, data: { name: id, email: `${id}@example.test`, status: "active", branch_id: branch, ...(more.length ? { branch_ids: [branch, ...more] } : {}) } });
    await s.upsertDocument(SOLO, "users", { id: "owner", data: { name: "Owner", status: "active" } });
    await s.upsertDocument(SOLO, "users", { id: "worker", data: { name: "Worker", status: "active" } });
    const workforce = await import("../workforce/storage.js");
    const crewS = await workforce.createResourceGroup(ORG, { name: "Scranton crew", kind_id: "crew", branch_id: "scranton", members: [{ user_id: "ann" }] });
    const crewP = await workforce.createResourceGroup(ORG, { name: "Portland crew", kind_id: "crew", branch_id: "portland", members: [{ user_id: "pat" }] });
    const connections = await import("../connections/storage.js");
    const everywhere = await connections.createOrganizationConnection(ORG, { name: "Everywhere Supply", relationship_type_ids: ["work_provider"] });
    const subP = await connections.createOrganizationConnection(ORG, { name: "Portland Gutters", relationship_type_ids: ["work_provider"], branch_ids: ["portland"] });
    return { crewS: String(crewS.id), crewP: String(crewP.id), everywhere: String(everywhere.id), subP: String(subP.id) };
  })();
}

/** A signed-in person with these permissions, as the auth layer would build them (expanded access, feature on unless said). */
async function as(userId: string, permissions: Record<string, boolean>, options: { org?: string; feature?: boolean } = {}): Promise<Ctx> {
  const orgId = options.org || ORG;
  const s = await import("../platform/storage.js");
  const document = await s.readDocument(orgId, "users", userId);
  const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(orgId);
  return {
    orgId, userId, role: "member", permissions, user: document.data, userDocument: document as any, branchId: String(document.data.branch_id || "default"),
    identity: {}, organization: {}, identityId: "", csrfToken: "", accessProfile: { roles: [] } as any,
    capabilities: { effectiveByKey: { [FEATURE]: options.feature !== false, "platform.expanded_access": true } } as any,
    applicationAccess: { management: { enabled: true, role_id: "", permissions } } as any,
    organizationStructure: structure, scopedAccessGrants: []
  } as unknown as Ctx;
}
const admin = () => as("admin", { "*": true });
const ids = (rows: Array<{ id?: unknown }>) => rows.map((row) => String(row.id)).sort();

test("an organization with one branch shows no branch structure and restricts nothing", async () => {
  await setup();
  const { readBranchStructure } = await import("../workforce/branches.js");
  const { branchScope } = await import("../workforce/branch-scope.js");
  const { scopeUsers } = await import("../workforce/branch-guards.js");
  const s = await import("../platform/storage.js");
  const worker = await as("worker", { manage_company_users: true }, { org: SOLO });
  const structure = await readBranchStructure(worker);
  assert.equal(structure.feature_enabled, true);
  assert.equal(structure.multiple, false, "one branch: nothing about branches is shown");
  assert.deepEqual(structure.branches.map((b) => [b.id, b.name, b.is_mine]), [["default", "", true]], "the default branch is used implicitly and needs no name");
  assert.equal(structure.access.restricted, false);
  assert.equal(branchScope(worker).restricted_view, false);
  assert.deepEqual(ids(scopeUsers(worker, await s.listDocuments(SOLO, "users"), {})), ["owner", "worker"]);
  // Several branches but the feature off is also one implicit branch.
  const off = await as("ann", { manage_company_users: true }, { feature: false });
  assert.equal(branchScope(off).multiple, false);
  assert.equal(scopeUsers(off, await s.listDocuments(ORG, "users"), {}).length, 5);
  const offStructure = await readBranchStructure(off);
  assert.equal(offStructure.feature_enabled, false);
  assert.equal(offStructure.access.can_add_branch, false);
});

test("administrators organize branches into flat regions; the structure read says what is mine", async () => {
  await setup();
  const branches = await import("../workforce/branches.js");
  const owner = await admin();
  const east = await branches.saveRegion(owner, { label: "East" });
  assert.ok(east.region_id);
  await branches.setBranchRegion(owner, { branch_id: "scranton", region_id: east.region_id });
  await branches.setBranchRegion(owner, { branch_id: "erie", region_id: east.region_id });
  await branches.saveRegion(owner, { label: "West" }).then((west) => branches.setBranchRegion(owner, { branch_id: "portland", region_id: west.region_id }));
  await assert.rejects(async () => branches.saveRegion(owner, { label: "east" }), /already has that name/);
  // Moving a branch to another region takes it out of the first: a branch is in at most one region.
  const structure = await branches.readBranchStructure(owner);
  assert.equal(structure.multiple, true);
  const byId = Object.fromEntries(structure.branches.map((b) => [b.id, b]));
  assert.equal(byId.scranton!.region_id, east.region_id);
  assert.equal(byId.default!.region_id, "", "a branch need not be in a region");
  assert.deepEqual(byId.scranton!.counts, { users: 2, groups: 1, companies: 0, departments: 0 });
  assert.equal(structure.companies_in_every_branch, 1);
  assert.deepEqual(structure.regions.find((r) => r.id === east.region_id)?.branch_ids, ["erie", "scranton"]);
  assert.equal(structure.access.can_add_branch, true);
  // Ann's own view: her branch, her region, nothing she may not see.
  const ann = await branches.readBranchStructure(await as("ann", { manage_company_settings: true }));
  assert.equal(ann.my_branch_id, "scranton");
  assert.deepEqual(ann.my_region_ids, [east.region_id]);
  assert.deepEqual(ann.branches.map((b) => b.id), ["scranton"]);
  assert.deepEqual(ann.regions.map((r) => [r.id, r.branch_ids]), [[east.region_id, ["scranton"]]]);
  assert.equal(ann.access.restricted, true);
  assert.equal(ann.access.can_add_branch, false, "adding branches needs manage_all_branches");
  assert.deepEqual(ann.access.can_rename_branch_ids, ["scranton"]);
});

test("adding, renaming and archiving branches", async () => {
  await setup();
  const branches = await import("../workforce/branches.js");
  const owner = await admin();
  const added = await branches.addBranch(owner, { name: "Akron" });
  const akron = added.branches.find((b) => b.name === "Akron")!;
  assert.ok(akron.id.startsWith("branch_"));
  await assert.rejects(async () => branches.addBranch(owner, { name: "akron" }), /already has that name/);
  // The default branch can be named once there are others; only it may stay unnamed.
  const named = await branches.renameBranch(owner, { branch_id: "default", name: "Headquarters" });
  assert.equal(named.branches.find((b) => b.id === "default")!.name, "Headquarters");
  await assert.rejects(async () => branches.renameBranch(owner, { branch_id: akron.id, name: "" }), /needs a name/);
  await assert.rejects(async () => branches.renameBranch(await as("ann", { manage_company_settings: true }), { branch_id: "erie", name: "Mine now" }), /cannot rename/);
  await assert.rejects(async () => branches.archiveBranch(owner, { branch_id: "default" }), /cannot be archived/);
  await assert.rejects(async () => branches.archiveBranch(owner, { branch_id: "portland" }), /Move its people/);
  const archived = await branches.archiveBranch(owner, { branch_id: akron.id });
  assert.equal(archived.branches.find((b) => b.id === akron.id)!.status, "archived");
  await assert.rejects(async () => branches.addBranch(await as("ann", { manage_company_settings: true, manage_region_branches: true }), { name: "Nope" }), /every branch/);
  await branches.archiveBranch(owner, { branch_id: akron.id, archived: false });
  await branches.archiveBranch(owner, { branch_id: akron.id });
});

test("people see their own branches; region and company-wide permissions widen it", async () => {
  const { crewS, crewP, everywhere, subP } = await setup();
  const s = await import("../platform/storage.js");
  const guards = await import("../workforce/branch-guards.js");
  const workforce = await import("../workforce/storage.js");
  const connections = await import("../connections/storage.js");
  const users = await s.listDocuments(ORG, "users");
  const groups = await workforce.listResourceGroups(ORG);
  const companies = await connections.listOrganizationConnections(ORG);
  const own = await as("ann", { manage_company_users: true, manage_company_settings: true });
  assert.deepEqual(ids(guards.scopeUsers(own, users)), ["ann", "multi"], "own branch only");
  assert.deepEqual(ids(guards.scopeGroups(own, groups)), [crewS]);
  assert.deepEqual(ids(guards.scopeConnections(own, companies)), [everywhere], "a company with no branch works in every branch");
  const region = await as("ann", { manage_company_users: true, view_region_branches: true });
  assert.deepEqual(ids(guards.scopeUsers(region, users)), ["ann", "erin", "multi"]);
  const all = await as("ann", { manage_company_users: true, view_all_branches: true });
  assert.deepEqual(ids(guards.scopeUsers(all, users)), ["admin", "ann", "erin", "multi", "pat"]);
  assert.deepEqual(ids(guards.scopeConnections(all, companies)), [everywhere, subP].sort());
  // The branch filter narrows, never widens.
  assert.deepEqual(ids(guards.scopeUsers(all, users, { branch_ids: "portland" })), ["ann", "pat"], "viewers always see themselves");
  assert.deepEqual(ids(guards.scopeUsers(own, users, { branch_ids: "portland,scranton" })), ["ann", "multi"]);
  assert.deepEqual(ids(guards.scopeUsers(region, users, { branch_ids: "region" })), ["ann", "erin", "multi"]);
  assert.deepEqual(ids(guards.scopeUsers(region, users, { branch_ids: "mine" })), ["ann", "multi"]);
  assert.deepEqual(ids(guards.scopeGroups(all, groups, { branch_ids: "portland" })), [crewP]);
  assert.throws(() => guards.assertGroupVisible(own, groups.find((g) => g.id === crewP)!), /cannot see/);
  assert.throws(() => guards.assertUserVisible(own, users.find((u) => u.id === "pat")!), /cannot see/);
  await assert.rejects(async () => guards.guardUserCollection(own, "read", "pat"), /cannot see/);
  await guards.guardUserCollection(own, "read", "multi");
  // The published directory carries the same scope.
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const directory = await readPublishedData(userPublicationContext({ ...own, permissions: { ...own.permissions, view_schedule: true } }), { provider: "assignee-directory", export: "assignees", target: { scope: "organization", organizationId: ORG } });
  if (directory.status !== "ready") throw Error(JSON.stringify(directory));
  assert.deepEqual((directory.value as Array<{ id: string }>).map((row) => row.id).sort(), ["organization_user:ann", "organization_user:multi", `organization_connection:${everywhere}`, `resource_group:${crewS}`].sort());
});

test("writes need the record and every branch changed to be ones the writer manages", async () => {
  const { crewP } = await setup();
  const branches = await import("../workforce/branches.js");
  const guards = await import("../workforce/branch-guards.js");
  const workforce = await import("../workforce/storage.js");
  const own = await as("ann", { manage_company_users: true, manage_company_settings: true });
  await assert.rejects(async () => branches.setAssigneeBranches(own, { assignee: "organization_user:erin", branch_ids: ["erie", "scranton"] }), /cannot manage/);
  await assert.rejects(async () => branches.setAssigneeBranches(own, { assignee: "organization_user:multi", branch_ids: ["scranton"] }), /only add or remove branches you manage/);
  await assert.rejects(async () => guards.guardUserCollection(own, "write", "pat", { data: { name: "Pat" } }), /cannot manage/);
  await assert.rejects(async () => guards.guardUserCollection(own, "create", "", { data: { name: "New", branch_id: "erie" } }), /branches you manage/);
  const created = { data: { name: "New" } as Record<string, unknown> };
  await guards.guardUserCollection(own, "create", "", created);
  assert.equal(created.data.branch_id, "scranton", "a restricted maker's new person lands in their own branch");
  const portlandCrew = await workforce.readResourceGroup(ORG, crewP);
  assert.throws(() => guards.assertGroupManageable(own, portlandCrew), /cannot manage/);
  assert.throws(() => guards.assertConnectionWrite(own, null, { branch_ids: [] }), /branches you manage/);
  const regional = await as("ann", { manage_company_users: true, manage_region_branches: true });
  const moved = await branches.setAssigneeBranches(regional, { assignee: { type: "organization_user", id: "multi" }, branch_ids: ["erie", "scranton"], primary_branch_id: "erie" });
  assert.deepEqual(moved, { assignee: "organization_user:multi", branch_ids: ["erie", "scranton"], primary_branch_id: "erie" });
  await assert.rejects(async () => branches.setAssigneeBranches(regional, { assignee: "organization_user:multi", branch_ids: ["portland"] }), /only add or remove/);
  await assert.rejects(async () => branches.setAssigneeBranches(regional, { assignee: "organization_user:multi", branch_ids: [] }), /at least one branch/);
  // A group in two branches is listed and resolved in both.
  const owner = await admin();
  await branches.setAssigneeBranches(owner, { assignee: { type: "resource_group", id: crewP }, branch_ids: ["portland", "erie"] });
  const group = await workforce.readResourceGroup(ORG, crewP);
  assert.deepEqual([group.branch_id, group.branch_ids], ["portland", ["portland", "erie"]]);
  assert.ok((await workforce.listResourceGroups(ORG, { branch_id: "erie" })).some((g) => g.id === crewP));
  const record = await (await import("../assignees/base.js")).readAssigneeRecord(ORG, { type: "resource_group", id: crewP });
  assert.deepEqual(record!.branch_ids, ["portland", "erie"]);
  await branches.setAssigneeBranches(owner, { assignee: { type: "resource_group", id: crewP }, branch_ids: ["portland"] });
  // Without the feature, membership is not set here at all.
  await assert.rejects(async () => branches.setAssigneeBranches(await as("admin", { "*": true }, { feature: false }), { assignee: "organization_user:pat", branch_ids: ["portland"] }), /not turned on/);
});

test("each branch configures its own departments, and a restricted manager changes only theirs", async () => {
  await setup();
  const departments = await import("../workforce/departments.js");
  const owner = await admin();
  const start = await departments.readOrganizationDepartments(ORG);
  const saved = await departments.saveDepartmentSettings(owner, { departments: [...start.departments, { id: "scranton-sales", label: "Sales", branch_id: "scranton", role_ids: [] }, { id: "erie-sales", label: "Sales", branch_id: "erie" }, { id: "hq", label: "Office" }], revision: start.revision, legacy_token: start.legacy_token || undefined });
  assert.deepEqual(saved.departments.map((d: { id: string; branch_id: string }) => [d.id, d.branch_id]), [["scranton-sales", "scranton"], ["erie-sales", "erie"], ["hq", "default"]]);
  const ann = await as("ann", { manage_company_settings: true });
  const mine = await departments.departmentSettings(ann);
  assert.deepEqual(mine.departments.map((d) => d.id), ["scranton-sales"], "only the departments of branches she may see");
  assert.equal(mine.users?.some((u) => u.id === "pat"), false);
  // She saves what she was shown; the other branches' departments are kept as they were.
  const renamed = await departments.saveDepartmentSettings(ann, { departments: mine.departments.map((d) => ({ ...d, label: "Scranton Sales" })), revision: mine.revision });
  const all = await departments.readOrganizationDepartments(ORG);
  assert.deepEqual(all.departments.map((d) => [d.id, d.label]), [["scranton-sales", "Scranton Sales"], ["erie-sales", "Sales"], ["hq", "Office"]]);
  await assert.rejects(async () => departments.saveDepartmentSettings(ann, { departments: [...renamed.departments, { id: "erie-new", label: "New", branch_id: "erie" }], revision: renamed.revision }), /cannot manage/);
  const added = await departments.saveDepartmentSettings(ann, { departments: [...renamed.departments, { id: "scranton-service", label: "Service" }], revision: renamed.revision });
  assert.equal(added.departments.find((d) => d.id === "scranton-service")?.branch_id, "scranton", "a new department goes to the saver's branch");
  await assert.rejects(async () => departments.saveDepartmentAssignment(await as("ann", { manage_company_users: true }), { kind: "user", id: "erin", department_ids: ["erie-sales"], revision: added.revision }), /cannot manage/);
  // A role puts someone only in the departments of their branches.
  const s = await import("../platform/storage.js");
  await s.upsertDocument(ORG, "users", { id: "ann", data: { roles: ["seller"] } });
  await s.upsertDocument(ORG, "users", { id: "erin", data: { roles: ["seller"] } });
  const current = await departments.readOrganizationDepartments(ORG);
  await s.upsertDocument(ORG, "organization_departments", { id: "catalog", data: { regions: current.regions, terminology: current.terminology, departments: current.departments.map((d) => d.id.endsWith("-sales") ? { ...d, role_ids: ["seller"] } : d) }, expected_revision: current.revision }, { replace: true });
  const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(ORG);
  assert.deepEqual(structure.users.find((u) => u.id === "ann")?.department_ids, ["scranton-sales"]);
  assert.deepEqual(structure.users.find((u) => u.id === "erin")?.department_ids, ["erie-sales"]);
});

test("a role given in a region covers its branches; restricted administrators give scoped roles only where they manage", async () => {
  await setup();
  const access = await import("../workforce/department-access.js");
  const { assertGrantScopesManageable } = await import("../workforce/branch-scope.js");
  const owner = await admin();
  const structure = owner.organizationStructure!;
  const east = structure.catalog.regions!.find((r) => r.label === "East")!;
  const roles = [{ id: "lead", status: "active", permissions: { view_comms: true } }] as any;
  const ctx = { ...(await as("erin", {})), scopedAccessGrants: access.resolveScopedAccessGrants([{ role_id: "lead", scope: { kind: "region", id: east.id } }], roles, structure) } as Ctx;
  assert.equal(access.hasResourcePermission(ctx, "view_comms", { branch_id: "scranton" }), true);
  assert.equal(access.hasResourcePermission(ctx, "view_comms", { department_id: "erie-sales" }), true);
  assert.equal(access.hasResourcePermission(ctx, "view_comms", { branch_id: "portland" }), false);
  assert.equal(access.hasResourcePermission(ctx, "view_comms", { department_id: "hq" }), false);
  const ann = await as("ann", { manage_company_user_permissions: true });
  assert.throws(() => assertGrantScopesManageable(ann, structure as any, [{ kind: "region", id: east.id }]), /branches you manage/, "a region needs every branch in it");
  assertGrantScopesManageable(ann, structure as any, [{ kind: "department", id: "scranton-sales" }, { kind: "branch", id: "scranton" }]);
  assert.throws(() => assertGrantScopesManageable(ann, structure as any, [{ kind: "department", id: "erie-sales" }]), /branches you manage/);
});

test("the published structure and actions are behind the feature and the permissions", async () => {
  await setup();
  const { userPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { invokeAction, describeAction } = await import("../platform/publication/actions.js");
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const target = { scope: "organization" as const, organizationId: ORG };
  const read = await readPublishedData(userPublicationContext(await as("pat", {})), { provider: "organization-branches", export: "structure", target });
  if (read.status !== "ready") throw Error(JSON.stringify(read));
  assert.equal((read.value as any).my_branch_id, "portland", "any member may know their own branch");
  for (const id of ["organization-branches.branch.add", "organization-branches.branch.rename", "organization-branches.branch.archive", "organization-branches.region.save", "organization-branches.branch.region.set", "organization-branches.membership.set"]) {
    assert.ok(describeAction(id)?.policy.capabilities?.includes(FEATURE), `${id} needs the feature`);
  }
  await assert.rejects(async () => invokeAction(userPublicationContext(await as("ann", { manage_company_users: true }), { mode: "command" }), { action: "organization-branches.branch.add", target }, { name: "Denied" }, { idempotencyKey: "branch-add-denied" }), /not permitted/);
  const created = await invokeAction(userPublicationContext(await admin(), { mode: "command" }), { action: "organization-branches.branch.add", target }, { name: "Published" }, { idempotencyKey: "branch-add-ok" });
  assert.ok(JSON.stringify(created).includes("Published"));
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(SOLO, { [FEATURE]: false, "platform.expanded_access": true });
  const soloTarget = { scope: "organization" as const, organizationId: SOLO };
  await assert.rejects(async () => invokeAction(userPublicationContext(await as("owner", { "*": true }, { org: SOLO, feature: false }), { mode: "command" }), { action: "organization-branches.branch.add", target: soloTarget }, { name: "Off" }, { idempotencyKey: "branch-add-off" }), /not available|not turned on/);
});

test("a stored catalog with units and categories migrates on read and is written in the new shape on its first save", async () => {
  await setup();
  const LEGACY = "org_branches_legacy";
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: LEGACY, name: LEGACY });
  await enableExpandedPlatformFixture(LEGACY, { [FEATURE]: true });
  await s.upsertDocument(LEGACY, "branch", { id: "north", data: { name: "North" } });
  await s.upsertDocument(LEGACY, "users", { id: "boss", data: { name: "Boss", status: "active", scoped_access_assignments: [{ permissions: { view_comms: true }, scope: { kind: "division", id: "north-unit" } }] } });
  await s.upsertDocument(LEGACY, "organization_departments", { id: "catalog", data: {
    groups: [{ id: "field", label: "Field" }],
    divisions: [{ id: "all", label: "All" }, { id: "north-unit", label: "North", parent_id: "all", branch_id: "north" }, { id: "empty", label: "Empty" }],
    departments: [{ id: "crew", label: "Crew", group_id: "field", division_id: "north-unit" }, { id: "office", label: "Office", group_id: "field" }]
  } });
  const departments = await import("../workforce/departments.js");
  const read = await departments.readOrganizationDepartments(LEGACY);
  assert.deepEqual(read.departments.map((d) => [d.id, d.branch_id]), [["crew", "north"], ["office", "default"]]);
  assert.deepEqual(read.regions.map((r) => [r.id, r.branch_ids]), [["all", ["north"]]]);
  const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(LEGACY);
  const grants = (await import("../workforce/department-access.js")).resolveScopedAccessGrants([{ permissions: { view_comms: true }, scope: { kind: "division", id: "north-unit" } }], [], structure);
  assert.deepEqual(grants.map((g) => g.scope), [{ kind: "branch", id: "north" }], "a unit that stood for one branch is that branch");
  const owner = { ...(await as("boss", { "*": true }, { org: LEGACY })) };
  await departments.saveDepartmentSettings(owner, { departments: read.departments, revision: read.revision });
  const stored = (await s.readDocument(LEGACY, "organization_departments", "catalog")).data as Record<string, unknown>;
  assert.equal("divisions" in stored || "groups" in stored, false);
  assert.deepEqual((stored.unit_migration as any).scopes["north-unit"], [{ kind: "branch", id: "north" }]);
  assert.deepEqual((stored.unit_migration as any).dropped_unit_ids, ["empty"]);
  // After the save the record of what each unit became still resolves older grants.
  const after = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(LEGACY);
  assert.deepEqual((await import("../workforce/department-access.js")).resolveScopedAccessGrants([{ permissions: { view_comms: true }, scope: { kind: "division", id: "all" } }], [], after).map((g) => g.scope), [{ kind: "region", id: "all" }]);
  // Saving a person's scoped roles writes today's scope kinds.
  const service = await import("../workforce/service.js");
  await s.upsertDocument(LEGACY, "users", { id: "lead", data: { name: "Lead", status: "active" } });
  const patched = await service.patchWorkforceUserProfile(LEGACY, "lead", { scoped_access_assignments: [{ permissions: { view_comms: true }, scope: { kind: "division", id: "all" } }] }, owner);
  assert.deepEqual(patched.scoped_access_assignments, [{ permissions: { view_comms: true }, scope: { kind: "region", id: "all" } }]);
});

test("a branch-restricted administrator cannot put someone directly in a department of a branch they are not in", async () => {
  await setup();
  const departments = await import("../workforce/departments.js");
  const s = await import("../platform/storage.js");
  // Mo manages two branches of his own; Erin is only in Erie.
  await s.upsertDocument(ORG, "users", { id: "mo", data: { name: "mo", status: "active", branch_id: "scranton", branch_ids: ["scranton", "erie"] } });
  let current = await departments.readOrganizationDepartments(ORG);
  if (!current.departments.some((d) => d.id === "scranton-desk")) {
    await departments.saveDepartmentSettings(await admin(), { departments: [...current.departments, { id: "scranton-desk", label: "Desk", branch_id: "scranton" }], revision: current.revision });
    current = await departments.readOrganizationDepartments(ORG);
  }
  const mo = await as("mo", { manage_company_users: true });
  await assert.rejects(async () => departments.saveDepartmentAssignment(mo, { kind: "user", id: "erin", department_ids: ["scranton-desk"], revision: current.revision }), (e: any) => e.code === "department_branch_mismatch");
  await assert.rejects(async () => departments.saveDepartmentSettings(await as("mo", { manage_company_settings: true }), { departments: current.departments.filter((d) => ["scranton", "erie"].includes(d.branch_id)).map((d) => d.id === "scranton-desk" ? { ...d, subject_keys: [...d.subject_keys, "organization_user:erin"] } : d), revision: current.revision }), (e: any) => e.code === "department_branch_mismatch");
  // Someone in the department's branch is fine.
  const ok = await departments.saveDepartmentAssignment(mo, { kind: "user", id: "ann", department_ids: ["scranton-desk"], revision: current.revision });
  // manage_region_branches lifts it inside the region; manage_all_branches lifts it everywhere.
  const regional = await departments.saveDepartmentAssignment(await as("ann", { manage_company_users: true, manage_region_branches: true }), { kind: "user", id: "erin", department_ids: ["scranton-desk"], revision: ok.revision });
  assert.ok(regional.departments.find((d) => d.id === "scranton-desk")!.subject_keys.includes("organization_user:erin"));
  await departments.saveDepartmentAssignment(await admin(), { kind: "user", id: "pat", department_ids: ["scranton-desk"], revision: regional.revision });
});
