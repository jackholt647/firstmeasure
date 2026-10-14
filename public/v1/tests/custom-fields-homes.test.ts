import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "field-homes-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
// Storage reads its roots when first imported, so the modules under test load only after the roots are set.
const { normalizeDefinitions, validateField, types } = await import("../custom_fields/contracts.js");
const { FIELD_HOMES, FIELD_OWNERS, fieldHome } = await import("../custom_fields/owners.js");
const { resolveHomedFields } = await import("../custom_fields/homes.js");
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); });

const ORG = "org_field_homes";
const auth = (permissions: Record<string, boolean>) => ({ orgId: ORG, userId: "admin", role: "member", permissions, branchId: "default", identity: {}, organization: {}, user: {}, capabilities: { effectiveByKey: {} }, accessProfile: { roles: [] }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }) as any;
const target = (id?: string) => ({ scope: "organization" as const, organizationId: ORG, ...(id ? { id } : {}) });
const role = (id: string) => ({ kind: "role", id }), field = (path: string, more: Record<string, unknown> = {}) => ({ path, type: "text", label: path, ...more });

test("a home is a role, a group type, a company type or one department, and a path keeps one type across homes", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(FIELD_HOMES).map(([kind, home]) => [kind, home.entity])), { role: "user", group_type: "team", company_type: "company", department: "department" });
  assert.ok(Object.hasOwn(FIELD_OWNERS, "company"));
  assert.deepEqual(fieldHome({ kind: "role", id: "driver" }, "user"), { kind: "role", id: "driver" });
  assert.equal(fieldHome(undefined, "user"), null);
  assert.throws(() => fieldHome({ kind: "user", id: "ada" }, "user"), /role, a group type/);
  assert.throws(() => fieldHome({ kind: "role", id: "driver" }, "team"), /holds user fields/);
  assert.throws(() => fieldHome({ kind: "role", id: "" }, "user"));

  // Two roles may share a path when it is the same kind of value.
  const shared = normalizeDefinitions([{ entity: "user", ...field("license"), home: role("driver") }, { entity: "user", ...field("license", { label: "Licence no." }), home: role("foreman") }]);
  assert.deepEqual(shared.map(f => (f.home as any).id), ["driver", "foreman"]);
  // The same path with another type, or twice in one home, or both with and without a home, is refused.
  assert.throws(() => normalizeDefinitions([{ entity: "user", ...field("license"), home: role("driver") }, { entity: "user", path: "license", type: "integer", home: role("foreman") }]), (error: any) => error.code === "custom_field_home_conflict" && /already a text field in role driver/.test(error.message));
  assert.throws(() => normalizeDefinitions([{ entity: "user", ...field("tools", { type: "tags" }), home: role("driver") }, { entity: "user", path: "tools", type: "organization_user", cardinality: "many", home: role("foreman") }]), (error: any) => error.code === "custom_field_home_conflict");
  assert.throws(() => normalizeDefinitions([{ entity: "user", ...field("license"), home: role("driver") }, { entity: "user", ...field("license"), home: role("driver") }]), (error: any) => error.code === "custom_field_conflict");
  assert.throws(() => normalizeDefinitions([{ entity: "user", ...field("license") }, { entity: "user", ...field("license"), home: role("driver") }]), (error: any) => error.code === "custom_field_conflict");
  assert.throws(() => normalizeDefinitions([{ entity: "user", ...field("license"), home: role("driver") }, { entity: "user", ...field("license.state"), home: role("foreman") }]), (error: any) => error.code === "custom_field_conflict");
  assert.throws(() => normalizeDefinitions([{ entity: "department", ...field("budget"), home: role("driver") }]), /holds user fields/);
  // A different owner is a different variable.
  assert.equal(normalizeDefinitions([{ entity: "user", ...field("license"), home: role("driver") }, { entity: "team", path: "license", type: "integer", home: { kind: "group_type", id: "crew" } }]).length, 2);
});

test("the fields a record has are those of its homes, one per path, with the strictest rules", () => {
  const defs = [
    { entity: "company", path: "insurance", type: "date", home: { kind: "company_type", id: "subcontractor" }, required: true },
    { entity: "company", path: "insurance", type: "date", home: { kind: "company_type", id: "supplier" }, private: true, label: "Insurance (supplier)" },
    { entity: "company", path: "terms", type: "text", home: { kind: "company_type", id: "supplier" }, write_permission: "manage_payroll" },
    { entity: "company", path: "union", type: "text", home: { kind: "company_type", id: "labor_broker" } },
    { entity: "company", path: "notes", type: "text" }
  ];
  const both = resolveHomedFields(defs, { kind: "company_type", ids: ["supplier", "subcontractor"] });
  assert.deepEqual(both.fields.map(f => f.path).sort(), ["insurance", "notes", "terms"]);
  assert.deepEqual(both.hidden, ["union"]);
  const insurance = both.fields.find(f => f.path === "insurance")!;
  // The record's first home is the one shown; required and private hold if any home says so.
  assert.equal(insurance.label, "Insurance (supplier)");
  assert.equal(insurance.required, true); assert.equal(insurance.private, true);
  assert.deepEqual(insurance.homes, [{ kind: "company_type", id: "supplier", order: 0 }, { kind: "company_type", id: "subcontractor", order: 0 }]);
  assert.deepEqual(insurance.all_read_permissions, ["manage_company_settings"]);
  assert.equal(both.fields.find(f => f.path === "notes")!.homes, undefined);
  const one = resolveHomedFields(defs, { kind: "company_type", ids: ["subcontractor"] });
  assert.deepEqual(one.fields.map(f => f.path).sort(), ["insurance", "notes"]);
  assert.deepEqual(one.hidden.sort(), ["terms", "union"]);
  assert.deepEqual(resolveHomedFields(defs, { kind: "company_type", ids: [] }).fields.map(f => f.path), ["notes"]);
});

test("a department reference names departments in the catalog, one or many", () => {
  assert.ok(types.includes("department"));
  const [one, many] = normalizeDefinitions([{ entity: "project", path: "owning_department", type: "department" }, { entity: "project", path: "helping_departments", type: "department", cardinality: "many" }]);
  validateField(one!, { department_id: "sales" });
  validateField(many!, [{ department_id: "sales" }, { department_id: "service" }]);
  for (const bad of ["sales", { id: "sales" }, { department_id: "" }, { department_id: "sales", name: "Sales" }, [{ department_id: "sales" }]]) assert.throws(() => validateField(one!, bad), JSON.stringify(bad));
  assert.throws(() => validateField(many!, { department_id: "sales" }));
  assert.throws(() => normalizeDefinitions([{ entity: "project", path: "d", type: "department", schema: { properties: { other: { type: "string" } } } }]), /platform reference schema/);
  assert.throws(() => validateField({ ...one!, required: true }, null), /required/);
});

test("homes: definitions, resolution, kept values, required fields, references and authorization", async () => {
  const storage = await import("../platform/storage.js"), workforce = await import("../workforce/storage.js"), access = await import("../workforce/access.js");
  const records = await import("../custom_fields/records.js"), homes = await import("../custom_fields/homes.js");
  const { userPublicationContext, systemPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  (await import("../custom_fields/publication.js")).registerCustomFieldPublication();

  await storage.createOrganization({ id: ORG, name: "Field homes" });
  await storage.upsertDocument(ORG, "organization_departments", { id: "catalog", data: { departments: [{ id: "sales", label: "Sales", color: "#2563eb" }, { id: "service", label: "Service", color: "#16a34a" }], groups: [], divisions: [] } });
  for (const [id, name] of [["driver", "Driver"], ["foreman", "Foreman"]]) await access.createAccessRole(ORG, { id, name, application_id: "management" });
  await workforce.saveWorkforceConfiguration(ORG, { resource_group_kinds: [{ id: "install_team", name: "Install team" }], expected_revision: (await workforce.readWorkforceConfiguration(ORG)).revision });
  const crew = await workforce.createResourceGroup(ORG, { name: "Crew A", kind_id: "crew" });
  const installers = await workforce.createResourceGroup(ORG, { name: "Installers", kind_id: "install_team" });
  const company = await (await import("../connections/storage.js")).createOrganizationConnection(ORG, { name: "Acme Subs" });
  // Company types are a list of their own, kept by the assignee base.
  for (const [id, name] of [["subcontractor", "Subcontractor"], ["supplier", "Supplier"]]) await (await import("../assignees/base.js")).saveAssigneeType(ORG, { kind: "organization_connection", id, name }, auth({ manage_company_settings: true }));
  const companyTypes = new Map<string, string[]>([[String(company.id), ["subcontractor", "supplier"]]]);
  homes.useCompanyTypeReader(async (_org, id) => companyTypes.get(id) || []);
  // A definition made before homes existed: it has none, and keeps applying to every user.
  await storage.saveBranchModule(ORG, "default", "custom_fields", { data: { fields: [{ entity: "user", path: "shirt_size", type: "select", options: ["S", "M", "L"] }, { entity: "user", path: "legacy_badge", type: "text" }] } }, { replace: true });
  await storage.upsertDocument(ORG, "users", { id: "ada", data: { name: "Ada", access_role_ids: ["driver", "foreman"] } });
  await storage.upsertDocument(ORG, "users", { id: "ben", data: { name: "Ben", access_role_ids: ["foreman"] } });

  const admin = userPublicationContext(auth({ manage_company_settings: true, manage_company_users: true }), { mode: "command" });
  const usersOnly = userPublicationContext(auth({ manage_company_users: true }), { mode: "command" });
  let key = 0;
  const invoke = async (ctx: any, action: string, input: Record<string, unknown>, id?: string) => (await invokeAction(ctx, { action, target: target(id) }, input, { idempotencyKey: `homes-${++key}` })).value as any;
  const read = async (ctx: any, provider: string, name: string, id?: string, args?: Record<string, unknown>) => { const result = await readPublishedData(ctx, { provider, export: name, target: target(id), ...(args ? { args } : {}) }) as any; assert.equal(result.status, "ready", `${provider}.${name}: ${result.message || ""}`); return result.value; };
  const definitionsOf = (kind: string, id: string) => read(admin, "custom-fields-homes", "definitions", undefined, { kind, id });
  const save = async (kind: string, id: string, fields: unknown[], ctx: any = admin) => invoke(ctx, "custom-fields.definitions.save", { kind, id, fields, expectedRevision: (await definitionsOf(kind, id)).revision });

  // ---- Definitions are made on a home and read back from it.
  const empty = await definitionsOf("role", "driver");
  assert.deepEqual(empty.home, { kind: "role", id: "driver", name: "Driver", exists: true });
  assert.equal(empty.entity, "user"); assert.deepEqual(empty.fields, []);
  const saved = await save("role", "driver", [field("cdl_number", { label: "CDL number", required: true }), field("license_class", { type: "select", options: ["A", "B"], default_value: "B" }), field("wage_note", { private: true })]);
  assert.deepEqual({ kind: saved.kind, id: saved.id, count: saved.count }, { kind: "role", id: "driver", count: 3 });
  const driver = await definitionsOf("role", "driver");
  assert.equal(driver.revision, saved.revision);
  assert.deepEqual(driver.fields.map((f: any) => [f.path, f.entity, f.home, f.order]), [["cdl_number", "user", role("driver"), 0], ["license_class", "user", role("driver"), 1], ["wage_note", "user", role("driver"), 2]]);
  assert.equal(driver.fields[1].value_schema.enum.length, 2); assert.equal(driver.fields[1].schema, undefined, "schema is only what the author declared");
  // A stale revision is refused; so is a home that does not exist, and a definition that claims another home.
  await assert.rejects(async () => invoke(admin, "custom-fields.definitions.save", { kind: "role", id: "driver", fields: [], expectedRevision: empty.revision }), (error: any) => error.code === "revision_conflict");
  await assert.rejects(() => save("role", "no_such_role", [field("x")]), (error: any) => error.code === "custom_field_home_not_found");
  await assert.rejects(() => save("group_type", "no_such_kind", [field("x")]), (error: any) => error.code === "custom_field_home_not_found");
  await assert.rejects(() => save("department", "no_such_department", [field("x")]), (error: any) => error.code === "custom_field_home_not_found");
  await assert.rejects(() => save("role", "foreman", [field("x", { home: role("driver") })]), (error: any) => error.code === "custom_field_home_invalid");
  // Foreman shares cdl_number (same type) and may not redefine it as another type, nor take an unassigned path.
  await assert.rejects(() => save("role", "foreman", [field("cdl_number", { type: "integer" })]), (error: any) => error.code === "custom_field_home_conflict");
  await assert.rejects(() => save("role", "foreman", [field("shirt_size")]), (error: any) => error.code === "custom_field_unassigned_conflict");
  await save("role", "foreman", [field("crew_size", { type: "integer", label: "Crew size" }), field("cdl_number", { label: "CDL (foreman)" })]);
  await save("group_type", "crew", [field("truck", { label: "Truck" })]);
  await save("group_type", "install_team", [field("territory", { required: true })]);
  await assert.rejects(() => save("company_type", "no_such_type", [field("x")]), (error: any) => error.code === "custom_field_home_not_found");
  await save("company_type", "subcontractor", [field("insurance_expires", { type: "date", required: true })]);
  await save("company_type", "supplier", [field("insurance_expires", { type: "date" }), field("terms")]);
  await save("department", "sales", [field("quota", { type: "integer" }), field("partner", { type: "department", cardinality: "many" })]);
  await save("department", "service", [field("on_call", { type: "organization_user" })]);

  // ---- Authorization: definitions need company settings; a home's lists are not readable or writable without it.
  await assert.rejects(() => save("role", "driver", [], usersOnly));
  assert.notEqual((await readPublishedData(usersOnly, { provider: "custom-fields-homes", export: "definitions", target: target(), args: { kind: "role", id: "driver" } }).catch(error => ({ status: "denied", code: error.code })) as any).status, "ready");
  const nobody = userPublicationContext(auth({}), { mode: "command" });
  for (const [provider, id] of [["custom-fields-user", "ada"], ["custom-fields-team", crew.id], ["custom-fields-company", String(company.id)], ["custom-fields-department", "sales"]]) {
    assert.notEqual((await readPublishedData(nobody, { provider: provider!, export: "resolved", target: target(String(id)) }).catch(error => ({ status: "denied", code: error.code })) as any).status, "ready", provider);
  }
  // Company settings alone does not open user fields, and user management alone does not open group fields.
  const settingsOnly = userPublicationContext(auth({ manage_company_settings: true }), { mode: "command" });
  assert.notEqual((await readPublishedData(settingsOnly, { provider: "custom-fields-user", export: "resolved", target: target("ada") }).catch(error => ({ status: "denied" })) as any).status, "ready");
  assert.notEqual((await readPublishedData(usersOnly, { provider: "custom-fields-team", export: "resolved", target: target(crew.id) }).catch(error => ({ status: "denied" })) as any).status, "ready");
  await assert.rejects(async () => invoke(usersOnly, "custom-fields.company.write", { values: { terms: "Net 30" }, expectedRevision: 0 }, String(company.id)));
  // A module grant reads only what it was granted.
  const grant = systemPublicationContext({ kind: "module", organizationId: ORG, operations: ["custom-fields-user.resolved"] });
  assert.equal((await readPublishedData(grant, { provider: "custom-fields-user", export: "resolved", target: target("ada") }) as any).status, "ready");
  assert.notEqual((await readPublishedData(grant, { provider: "custom-fields-homes", export: "definitions", target: target(), args: { kind: "role", id: "driver" } }).catch(() => ({ status: "denied" })) as any).status, "ready");

  // ---- A user with two roles has every role's fields, once per path.
  const ada = await read(admin, "custom-fields-user", "resolved", "ada");
  assert.equal(ada.entity, "user"); assert.equal(ada.id, "ada");
  assert.deepEqual(ada.homes, [
    { kind: "role", id: "driver", name: "Driver", fields: ["cdl_number", "license_class", "wage_note"] },
    { kind: "role", id: "foreman", name: "Foreman", fields: ["crew_size", "cdl_number"] }
  ]);
  assert.deepEqual(ada.unassigned.sort(), ["legacy_badge", "shirt_size"]);
  assert.equal(ada.fields.filter((f: any) => f.path === "cdl_number").length, 1);
  const cdl = ada.fields.find((f: any) => f.path === "cdl_number");
  assert.equal(cdl.label, "CDL number"); assert.equal(cdl.required, true);
  assert.deepEqual(cdl.homes, [{ kind: "role", id: "driver", name: "Driver" }, { kind: "role", id: "foreman", name: "Foreman" }]);
  assert.deepEqual(ada.values, { license_class: "B" }, "defaults are read, nothing is stored yet");
  const ben = await read(admin, "custom-fields-user", "resolved", "ben");
  assert.deepEqual(ben.homes, [{ kind: "role", id: "foreman", name: "Foreman", fields: ["crew_size", "cdl_number"] }]);
  assert.equal(ben.fields.find((f: any) => f.path === "cdl_number").label, "CDL (foreman)");
  assert.equal(ben.fields.find((f: any) => f.path === "cdl_number").required, false);
  // Without company settings the private field is left out; the rest of the role's fields are still there.
  const adaForUsers = await read(usersOnly, "custom-fields-user", "resolved", "ada");
  assert.equal(adaForUsers.fields.some((f: any) => f.path === "wage_note"), false);
  assert.deepEqual(adaForUsers.homes[0].fields, ["cdl_number", "license_class"]);

  // ---- Required within the record's homes: a values write must leave Ada's CDL number filled; Ben has no such rule.
  const adaRevision = () => storage.readDocument(ORG, "users", "ada").then(row => row.revision);
  await assert.rejects(async () => invoke(admin, "custom-fields.user.write", { values: { crew_size: 4 }, expectedRevision: ada.recordRevision }, "ada"), (error: any) => error.code === "custom_field_required");
  await assert.rejects(async () => invoke(admin, "custom-fields.user.write", { values: { cdl_number: "" }, expectedRevision: ada.recordRevision }, "ada"), (error: any) => error.code === "custom_field_required");
  await invoke(admin, "custom-fields.user.write", { values: { crew_size: 4, cdl_number: "D-100", wage_note: "top band", shirt_size: "M" }, expectedRevision: ada.recordRevision }, "ada");
  await invoke(admin, "custom-fields.user.write", { values: { crew_size: 3 }, expectedRevision: ben.recordRevision }, "ben");
  await assert.rejects(async () => invoke(admin, "custom-fields.user.write", { values: { license_class: "B" }, expectedRevision: (await storage.readDocument(ORG, "users", "ben")).revision }, "ben"), (error: any) => error.code === "custom_field_unknown", "Ben is not a driver");
  await assert.rejects(async () => invoke(usersOnly, "custom-fields.user.write", { values: { wage_note: "x" }, expectedRevision: await adaRevision() }, "ada"), "private fields are not writable without their permission");
  await assert.rejects(async () => invoke(admin, "custom-fields.user.write", { values: { license_class: "Z" }, expectedRevision: await adaRevision() }, "ada"), "choices are still validated");
  // Giving someone a role with a required field does not block saving the user.
  await storage.upsertDocument(ORG, "users", { id: "ben", data: { name: "Ben", access_role_ids: ["foreman", "driver"] } });
  assert.equal((await read(admin, "custom-fields-user", "resolved", "ben")).fields.find((f: any) => f.path === "cdl_number").required, true);
  await storage.upsertDocument(ORG, "users", { id: "ben", data: { name: "Ben", access_role_ids: ["foreman"] } });

  // ---- A role removed: its values stay stored and are neither shown nor required.
  await storage.upsertDocument(ORG, "users", { id: "ada", data: { name: "Ada", access_role_ids: ["foreman"] } });
  const stored = () => storage.readDocument(ORG, "users", "ada").then(row => row.data.custom_field_values as any);
  assert.deepEqual(await stored(), { crew_size: 4, cdl_number: "D-100", wage_note: "top band", shirt_size: "M" });
  const demoted = await read(admin, "custom-fields-user", "resolved", "ada");
  assert.deepEqual(demoted.homes, [{ kind: "role", id: "foreman", name: "Foreman", fields: ["crew_size", "cdl_number"] }]);
  assert.deepEqual(demoted.values, { crew_size: 4, cdl_number: "D-100", shirt_size: "M" }, "cdl_number is still a foreman field; the driver-only values are hidden");
  assert.equal(demoted.fields.some((f: any) => ["wage_note", "license_class"].includes(f.path)), false, "hidden values are not inferred as fields either");
  assert.deepEqual(Object.keys(await read(admin, "custom-fields-user", "values", "ada")).sort(), ["cdl_number", "crew_size", "shirt_size"]);
  await assert.rejects(async () => invoke(admin, "custom-fields.user.write", { values: { wage_note: "y" }, expectedRevision: await adaRevision() }, "ada"), (error: any) => error.code === "custom_field_unknown");
  // Clearing the no-longer-required CDL number is allowed for a foreman, and hidden values survive the write.
  await invoke(admin, "custom-fields.user.write", { values: { cdl_number: "" }, expectedRevision: await adaRevision() }, "ada");
  assert.equal((await stored()).wage_note, "top band");
  // The role given back: the kept values return.
  await storage.upsertDocument(ORG, "users", { id: "ada", data: { name: "Ada", access_role_ids: ["driver", "foreman"] } });
  assert.equal((await read(admin, "custom-fields-user", "resolved", "ada")).values.wage_note, "top band");

  // ---- Retiring a definition keeps what was stored and stops publishing it.
  const afterRetire = await save("role", "driver", [field("cdl_number", { label: "CDL number", required: true }), field("license_class", { type: "select", options: ["A", "B"], default_value: "B" })]);
  assert.equal(afterRetire.count, 2);
  assert.deepEqual((await definitionsOf("role", "driver")).retired.map((f: any) => [f.path, f.retired, f.home]), [["wage_note", true, role("driver")]]);
  assert.equal((await stored()).wage_note, "top band");

  // ---- A group has its type's fields.
  const crewFields = await read(admin, "custom-fields-team", "resolved", crew.id);
  assert.deepEqual(crewFields.homes, [{ kind: "group_type", id: "crew", name: "Crew", fields: ["truck"] }]);
  const installerFields = await read(admin, "custom-fields-team", "resolved", installers.id);
  assert.deepEqual(installerFields.homes, [{ kind: "group_type", id: "install_team", name: "Install team", fields: ["territory"] }]);
  await assert.rejects(async () => invoke(admin, "custom-fields.team.write", { values: { territory: "North" }, expectedRevision: 0 }, crew.id), (error: any) => error.code === "custom_field_unknown");
  await invoke(admin, "custom-fields.team.write", { values: { territory: "North" }, expectedRevision: 0 }, installers.id);
  assert.deepEqual((await read(admin, "custom-fields-team", "resolved", installers.id)).values, { territory: "North" });

  // ---- An outside company has the fields of each of its types.
  const acme = await read(admin, "custom-fields-company", "resolved", String(company.id));
  assert.deepEqual(acme.homes, [
    { kind: "company_type", id: "subcontractor", name: "Subcontractor", fields: ["insurance_expires"] },
    { kind: "company_type", id: "supplier", name: "Supplier", fields: ["insurance_expires", "terms"] }
  ]);
  assert.equal(acme.fields.length, 2);
  assert.equal(acme.fields.find((f: any) => f.path === "insurance_expires").required, true, "required by one of its types");
  await assert.rejects(async () => invoke(admin, "custom-fields.company.write", { values: { terms: "Net 30" }, expectedRevision: 0 }, String(company.id)), (error: any) => error.code === "custom_field_required");
  await invoke(admin, "custom-fields.company.write", { values: { terms: "Net 30", insurance_expires: "2027-01-31" }, expectedRevision: 0 }, String(company.id));
  companyTypes.set(String(company.id), ["subcontractor"]);
  const narrowed = await read(admin, "custom-fields-company", "resolved", String(company.id));
  assert.deepEqual(narrowed.values, { insurance_expires: "2027-01-31" });
  assert.deepEqual(narrowed.fields.map((f: any) => f.path), ["insurance_expires"]);
  await assert.rejects(() => read(admin, "custom-fields-company", "resolved", "missing_company"));

  // ---- A department has its own fields, and only its own.
  const sales = await read(admin, "custom-fields-department", "resolved", "sales");
  assert.deepEqual(sales.homes, [{ kind: "department", id: "sales", name: "Sales", fields: ["quota", "partner"] }]);
  assert.deepEqual((await read(admin, "custom-fields-department", "resolved", "service")).homes, [{ kind: "department", id: "service", name: "Service", fields: ["on_call"] }]);
  await assert.rejects(async () => invoke(admin, "custom-fields.department.write", { values: { quota: 5 }, expectedRevision: 0 }, "service"), (error: any) => error.code === "custom_field_unknown");

  // ---- The department reference type: stored as ids, validated against the catalog.
  await invoke(admin, "custom-fields.department.write", { values: { quota: 5, partner: [{ department_id: "service" }] }, expectedRevision: 0 }, "sales");
  const salesAfter = await read(admin, "custom-fields-department", "resolved", "sales");
  assert.deepEqual(salesAfter.values, { quota: 5, partner: [{ department_id: "service" }] });
  assert.deepEqual(salesAfter.fields.find((f: any) => f.path === "partner").schema.items.required, ["department_id"]);
  for (const partner of [[{ department_id: "nowhere" }], [{ department_id: "service" }, { department_id: "service" }], { department_id: "service" }]) {
    await assert.rejects(async () => invoke(admin, "custom-fields.department.write", { values: { partner }, expectedRevision: salesAfter.recordRevision }, "sales"), JSON.stringify(partner));
  }
  // The same type is a project field type too.
  await storage.saveBranchModule(ORG, "default", "custom_fields", { data: { fields: [...((await storage.readBranchModule(ORG, "default", "custom_fields")).data.fields as any[]), { entity: "project", path: "owning_department", type: "department" }] } });
  await storage.upsertDocument(ORG, "projects", { id: "job", data: { name: "Job", custom_field_values: { owning_department: { department_id: "sales" } } } });
  await assert.rejects(() => storage.upsertDocument(ORG, "projects", { id: "job", data: { custom_field_values: { owning_department: { department_id: "nowhere" } } } }));
  assert.equal((await definitionsOf("department", "sales")).fields.length, 2, "saving the module from elsewhere keeps the homes");

  // ---- Definitions without a home are listed for an administrator to place.
  const unassigned = await read(admin, "custom-fields-homes", "unassigned");
  assert.deepEqual(unassigned.fields.map((f: any) => [f.entity, f.path, f.home_kind]), [["user", "shirt_size", "role"], ["user", "legacy_badge", "role"]]);
  assert.deepEqual((await read(admin, "custom-fields-homes", "unassigned", undefined, { entity: "team" })).fields, []);
  await assert.rejects(async () => invoke(admin, "custom-fields.definitions.place", { path: "shirt_size", kind: "group_type", id: "crew" }), (error: any) => error.code === "custom_field_unassigned_not_found");
  const placed = await invoke(admin, "custom-fields.definitions.place", { path: "shirt_size", kind: "role", id: "driver" });
  assert.equal(placed.count, 3);
  assert.deepEqual((await definitionsOf("role", "driver")).fields.map((f: any) => f.path), ["cdl_number", "license_class", "shirt_size"]);
  assert.equal((await read(admin, "custom-fields-user", "resolved", "ben")).fields.some((f: any) => f.path === "shirt_size"), false, "a placed field applies only to its home");
  assert.deepEqual((await read(admin, "custom-fields-user", "resolved", "ben")).unassigned, ["legacy_badge"]);

  // ---- The index lists every home with its count.
  const index = await read(admin, "custom-fields-homes", "index");
  const count = (kind: string, id: string) => index.homes.find((home: any) => home.kind === kind && home.id === id)?.fields;
  assert.deepEqual([count("role", "driver"), count("role", "foreman"), count("group_type", "crew"), count("group_type", "install_team"), count("company_type", "supplier"), count("department", "sales"), count("department", "service")], [3, 2, 1, 1, 2, 2, 1]);
  assert.equal(index.homes.find((home: any) => home.kind === "company_type" && home.id === "supplier").exists, true);
  assert.deepEqual(index.entities, { role: "user", group_type: "team", company_type: "company", department: "department" });

  // ---- Reads never write: no sidecar record exists for a group whose fields were only read.
  assert.equal((await storage.listDocuments(ORG, "resource_custom_fields")).some(row => (row.data as any).owner_id === crew.id), false);
  homes.useCompanyTypeReader(null);
  void records;
});
