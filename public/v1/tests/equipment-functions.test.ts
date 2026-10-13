import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture, operatorFixtureClient } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "equipment-functions-"));
Object.assign(process.env, {
  NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
  MESSAGING_STORAGE_ROOT: path.join(dir, "messaging"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"),
  PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error"
});

const ORG = "org_equipment_functions";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;
let app: any = null;
let client: Awaited<ReturnType<typeof operatorFixtureClient>>;
const base = `/v1/equipment/organizations/${ORG}`;

before(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Equipment functions" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true, "apps.equipment": true });
  client = await operatorFixtureClient(app, ORG);
});
after(async () => {
  if (app) await app.close();
  await (await import("../equipment/storage.js")).closeEquipmentDatabase();
  await closePlatformFixtureStores();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

test("an equipment type provides functions only, validated like a pay sheet's equipment, and a unit may hold a different amount", async () => {
  const f = await import("../equipment/functions.js");
  const issues = (schema: { safeParse: (value: unknown) => any }, value: unknown) => { const result = schema.safeParse(value); return result.success ? "" : result.error.issues.map((issue: any) => issue.message).join(" "); };
  assert.deepEqual(f.equipmentProvidesSchema.parse([{ item: "disposal.debris", capacity: 6 }]), [{ item: "disposal.debris", capacity: 6, per_load: false }], "per load is off unless said");
  assert.deepEqual(f.equipmentProvidesSchema.parse([{ item: "disposal.debris", per_load: true }]), [{ item: "disposal.debris", per_load: true }], "no capacity is not zero capacity");
  assert.match(issues(f.equipmentProvidesSchema, [{ item: "disposal.nope" }]), /not in the work item dictionary/);
  assert.match(issues(f.equipmentProvidesSchema, [{ item: "roofing.install" }]), /can only provide a function, and roofing.install is work/);
  assert.match(issues(f.equipmentProvidesSchema, [{ item: "disposal.debris" }, { item: "disposal.debris", capacity: 2 }]), /listed twice/);
  assert.ok(issues(f.equipmentProvidesSchema, [{ item: "disposal.debris", capacity: -1 }]));
  assert.ok(issues(f.equipmentProvidesSchema, [{ item: "disposal.debris", loads: 2 }]), "the shape is closed");

  // Over the API: a type saves and reads back what it provides; a type that says nothing provides nothing.
  const plain = (await client.request("POST", `${base}/types`, { name: "Skid steer", kind: "other" })).type;
  assert.deepEqual(plain.provides, []);
  const refused = await client.raw("POST", `${base}/types`, { name: "Truck", provides: [{ item: "roofing.tear_off", capacity: 3 }] });
  assert.equal(refused.statusCode, 400); assert.match(refused.body, /can only provide a function/);
  assert.equal((await client.raw("POST", `${base}/types`, { name: "Truck", provides: [{ item: "disposal.unknown" }] })).statusCode, 400);
  const dumpster = (await client.request("POST", `${base}/types`, { name: "Dumpster", kind: "other", provides: [{ item: "disposal.debris", capacity: 6 }] })).type;
  assert.deepEqual(dumpster.provides, [{ item: "disposal.debris", capacity: 6, per_load: false }]);
  // Renaming a type keeps what it provides; setting it again replaces it.
  const renamed = (await client.request("PATCH", `${base}/types/${dumpster.id}`, { name: "6 yard dumpster" })).type;
  assert.deepEqual([renamed.name, renamed.provides], ["6 yard dumpster", [{ item: "disposal.debris", capacity: 6, per_load: false }]]);
  const trailer = (await client.request("POST", `${base}/types`, { name: "Dump trailer", kind: "trailer", provides: [{ item: "disposal.debris", capacity: 10, per_load: true }] })).type;

  // A unit holds what its type holds unless it says otherwise, and can only speak for functions its type provides.
  const standard = (await client.request("POST", `${base}/units`, { name: "Dumpster 1", type_id: dumpster.id })).unit;
  const big = (await client.request("POST", `${base}/units`, { name: "Dumpster 2", type_id: dumpster.id, provides: [{ item: "disposal.debris", capacity: 8 }] })).unit;
  assert.deepEqual(big.provides, [{ item: "disposal.debris", capacity: 8 }]);
  const stray = await client.raw("POST", `${base}/units`, { name: "Skid 1", type_id: plain.id, provides: [{ item: "disposal.debris", capacity: 4 }] });
  assert.equal(stray.statusCode, 400); assert.equal(stray.json().error, "equipment_unit_provides_invalid");
  assert.equal((await client.raw("PATCH", `${base}/units/${standard.id}`, { provides: [{ item: "roofing.install", capacity: 4 }] })).statusCode, 400, "a unit cannot provide work either");
  assert.equal((await client.raw("POST", `${base}/units`, { name: "Loose", provides: [{ item: "disposal.debris", capacity: 4 }] })).statusCode, 400, "a unit with no type provides nothing");
  const hauler = (await client.request("POST", `${base}/units`, { name: "Trailer 1", type_id: trailer.id })).unit;

  // The fleet list the Project tab reads carries what each unit provides in effect.
  const fleet = new Map<string, any>((await client.request("GET", `${base}/units`)).units.map((unit: any) => [unit.id, unit]));
  assert.deepEqual(fleet.get(standard.id).effective_provides, [{ item: "disposal.debris", capacity: 6, per_load: false }]);
  assert.deepEqual(fleet.get(big.id).effective_provides, [{ item: "disposal.debris", capacity: 8, per_load: false }], "the unit's own capacity replaces the type's");
  assert.deepEqual(fleet.get(big.id).type_provides, [{ item: "disposal.debris", capacity: 6, per_load: false }]);
  assert.deepEqual(fleet.get(hauler.id).effective_provides, [{ item: "disposal.debris", capacity: 10, per_load: true }]);
  // Other edits to a unit leave its capacity alone, and an override for something the type stopped providing is ignored.
  assert.deepEqual((await client.request("PATCH", `${base}/units/${big.id}`, { notes: "Rented" })).unit.provides, [{ item: "disposal.debris", capacity: 8 }]);
  assert.deepEqual(f.effectiveProvides({ provides: [] }, { provides: [{ item: "disposal.debris", capacity: 8 }] }), []);
  assert.deepEqual(f.effectiveProvides({}, {}), []);
});

test("an organization sees the functions its enabled scopes' kinds of work need, and no others", async () => {
  const f = await import("../equipment/functions.js"), scopes = await import("../scopes/storage.js");
  const { measurementSchemaIdsForScope } = await import("../platform/publication/measurement-schemas.js");
  assert.deepEqual(f.functionsForSchemas(["roofing"]).map((row) => [row.id, row.label, row.unit, row.schemas]), [["disposal.debris", "Debris disposal", "yd3", [{ id: "roofing", title: "Roofing" }]]]);
  assert.match(f.functionsForSchemas(["roofing"])[0]!.description, /dumpster/);
  assert.deepEqual(f.functionsForSchemas(["gutters", "siding"]), [], "a kind of work that needs no function offers none");
  assert.deepEqual(f.functionsForSchemas([]), []);

  // The sample scopes include roofing ones, so debris disposal is offered.
  const first = await client.request("GET", `${base}/functions`);
  assert.ok(first.schema_ids.includes("roofing"));
  assert.deepEqual(first.functions.map((row: any) => row.id), ["disposal.debris"]);
  // Turn off every scope that works in roofing: nothing needs the function any more, so it is not offered.
  const all = await scopes.listScopeTemplates(ORG, "default", { include_disabled: true });
  const roofing = all.filter((scope) => measurementSchemaIdsForScope(scope.definition).includes("roofing")).map((scope) => String(scope.id));
  assert.ok(roofing.length > 0 && roofing.length < all.length);
  const flag = async (enabled: boolean, ids: string[]) => scopes.patchScopeFlags(ORG, { expected_revision: Number((await scopes.readScopeFlagState(ORG)).revision), flags: Object.fromEntries(ids.map((id) => [id, enabled])) });
  await flag(false, roofing);
  const none = await client.request("GET", `${base}/functions`);
  assert.deepEqual([none.schema_ids.includes("roofing"), none.functions], [false, []]);
  // One roofing scope back on is enough.
  await flag(true, roofing.slice(0, 1));
  assert.deepEqual((await f.availableEquipmentFunctions(ORG)).functions.map((row) => row.id), ["disposal.debris"]);

  // Published for modules and agents, under the equipment view bundle.
  const { registerDomainActions } = await import("../platform/publication/action-adapters.js"); registerDomainActions();
  const { listActions } = await import("../platform/publication/actions.js");
  assert.ok(listActions().some((action: any) => action.id === "equipment.functions.available"));
  assert.equal((await import("../platform/publication/permission-bundles.js")).publishedActionPermission("equipment.functions.available"), "equipment.view");
});

test("an equipment line stamped from a unit covers the function, and says when what it holds is short", async () => {
  const s = await import("../platform/storage.js"), lists = await import("../materials/storage.js"), r = await import("../labor/requirements.js");
  await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Oak St" } });
  // The job includes a tear-off and its debris, said by an artifact added by hand.
  const { saveManualScope } = await import("../labor/scope-artifacts.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  await saveManualScope(userPublicationContext({ ...owner, permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }, { projectId: "project" }), "project", { work: [{ item: "roofing.tear_off" }, { item: "disposal.debris" }] });
  // 20 squares of one layer: 8 cubic yards of debris.
  const held = { roofSquares: { value: 20, unit: "roofing_square" } };
  const read = async () => (await r.projectRequirements(ORG, "project", { scope_template_ids: ["roof_replacement"], legacy_measurements: held })).requirements.find((row) => row.id === "disposal.debris")!;
  assert.deepEqual([(await read()).quantity, (await read()).status], [8, "open"]);

  const fleet: any[] = (await client.request("GET", `${base}/units`)).units;
  const unit = (name: string) => fleet.find((entry) => entry.name === name)!;
  // What the Project tab writes when a unit is picked for a line: the unit, its type, and what it provides in effect.
  const line = (name: string, quantity: number) => ({ id: "eq1", name, quantity, unit: "day", metadata: { equipment_unit_id: unit(name).id, equipment_type_id: unit(name).type_id, provides: unit(name).effective_provides } });
  const list = await lists.createMaterialList(ORG, "project", { title: "Equipment", resource_type: "equipment", items: [line("Dumpster 1", 1)] }, owner);
  const revise = async (items: object[]) => { const current = await lists.readMaterialList(ORG, String(list.id)); await lists.createMaterialVersion(ORG, String(list.id), { expected_revision: Number(current.revision), reason: "revision", items }, owner); };

  const short = await read();
  assert.deepEqual([short.status, short.covered_by[0]!.mode, short.covered_by[0]!.lines[0]!.name], ["warning", "provided", "Dumpster 1"]);
  assert.deepEqual(short.warnings.map((warning) => [warning.code, warning.message]), [["short", "What is on the work order holds 6 cubic yards of the 8 needed."]]);
  // Two of them hold enough.
  await revise([line("Dumpster 1", 2)]);
  assert.deepEqual([(await read()).status, (await read()).warnings], ["covered", []]);
  // The unit that holds eight is enough on its own.
  await revise([line("Dumpster 2", 1)]);
  assert.equal((await read()).status, "covered");
  // Something emptied and used again is never short, whatever it holds.
  await revise([line("Trailer 1", 1)]);
  assert.deepEqual([(await read()).status, (await read()).warnings], ["covered", []]);
});
