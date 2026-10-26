import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// "Who does your labor?" in the price book setup (labor/labor-setup.ts, docs/architecture/guided-experiences.md) and
// the Materials tab's Labor column following the organization's data (materials/resource-types.ts laborColumnShown).
const dir = await mkdtemp(path.join(os.tmpdir(), "labor-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_labor_setup", PLAIN = "org_labor_plain";
const flags = { "platform.materials": true, "platform.pricebook": true, "apps.crew": true, "platform.people_access": true, "platform.expanded_access": true };
const owner = (orgId = ORG, capabilities: Record<string, boolean> = flags) => ({ orgId, userId: "owner", role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: { address: { state: "TX" } } }, capabilities: { effectiveByKey: capabilities }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } }) as any;
const member = { ...owner(), userId: "crew", role: "member", permissions: { view_projects: true }, accessProfile: { roles: [], app_restrictions: [] } } as any;
const laborShown = async (orgId: string) => (await (await import("../materials/resource-types.js")).listResourceTypes(orgId)).some((row) => row.id === "labor");

test("skipped, the Labor column is off; adding a group or a subcontractor with its pay brings it back", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Labor Setup Roofing" });
  await enableExpandedPlatformFixture(ORG, flags);
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const { invokeAction, describeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  assert.ok(describeAction("labor.setup.apply")?.executionKinds.includes("agent"));
  const target = { scope: "organization" as const, organizationId: ORG };

  // Nothing saved: the column shows, as it always has.
  assert.equal(await laborShown(ORG), true);
  // Skipped (the setup saves "with assignees"): nobody does labor yet, so no Labor column.
  const types = await import("../materials/resource-types.js");
  await types.saveResourceType(ORG, { id: "labor", name: "Labor", icon: "fa-helmet-safety", color: "#2563eb", shown: "with_assignees", expected_revision: 0 }, owner());
  assert.equal(await laborShown(ORG), false, "groups are on and nobody does labor yet");
  const labor = await import("../labor/labor-setup.js");
  const empty = await labor.laborSetupOptions(ORG);
  assert.deepEqual(empty.assignees, []);
  assert.ok(empty.measurements.some((entry) => entry.id === "roof.squares"));

  // Add one of each, with how each is paid.
  const input = { assignees: [
    { kind: "resource_group", name: "North crew", pay: { method: "hourly", rate: 45 } },
    { kind: "organization_connection", name: "Summit Roofing", pay: { method: "per_measurement", rate: 65, measurement: "roof.squares" } },
    { kind: "organization_connection", name: "Ridge Co", pay: null }
  ] };
  await assert.rejects(async () => invokeAction(userPublicationContext(member, { mode: "command" }), { action: "labor.setup.apply", target }, input, { idempotencyKey: "denied" }), /not permitted|permission/i);
  const done = await invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "labor.setup.apply", target }, input, { idempotencyKey: "labor-1" }) as any;
  assert.deepEqual(done.value.assignees.map((row: any) => [row.kind, row.name, row.created, row.pay]), [["resource_group", "North crew", true, "saved"], ["organization_connection", "Summit Roofing", true, "saved"], ["organization_connection", "Ridge Co", true, "none"]]);
  const sheets = await (await import("../labor/pay-sheets.js")).listPaySheets(ORG);
  const north = sheets.find((sheet) => sheet.subject.type === "resource_group")!;
  assert.deepEqual(north.entries.map((entry) => [entry.kind, entry.rate_cents, entry.input]), [["hourly", 4500, "hours"]]);
  const summit = sheets.find((sheet) => sheet.subject.type === "organization_connection")!;
  assert.deepEqual(summit.entries.map((entry) => [entry.kind, entry.rate_cents]), [["piece_rate", 6500]]);
  assert.deepEqual(summit.inputs[0]!.source, { kind: "measurement", definition: "roof.squares", per_structure: true });
  assert.deepEqual(summit.schema_ids, ["roofing"]);
  assert.equal(await laborShown(ORG), true, "someone does labor now");

  // The step shows them with their pay; running it again matches by name and changes the rate on the same sheet.
  const options = await labor.laborSetupOptions(ORG);
  assert.deepEqual(options.assignees.map((row: any) => [row.name, row.pay?.simple?.method ?? null]), [["North crew", "hourly"], ["Ridge Co", null], ["Summit Roofing", "per_measurement"]]);
  await invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "labor.setup.apply", target }, { assignees: [{ kind: "resource_group", name: "North crew", pay: { method: "hourly", rate: 50 } }] }, { idempotencyKey: "labor-2" });
  const after = (await (await import("../labor/pay-sheets.js")).listPaySheets(ORG)).filter((sheet) => sheet.subject.type === "resource_group");
  assert.equal(after.length, 1, "the same sheet, not a second");
  assert.equal(after[0]!.entries[0]!.rate_cents, 5000);
  assert.equal((await (await import("../workforce/storage.js")).listResourceGroups(ORG, {})).length, 1, "not added twice");

  // A pay sheet written elsewhere with more than one line is left alone.
  const rich = { ...labor.laborPaySheet({ type: "organization_connection", id: summit.subject.id }, "Summit Roofing", { method: "per_measurement", rate: 65 }), id: summit.id, expected_revision: summit.revision };
  rich.entries = [...rich.entries, { label: "Steep", kind: "piece_rate" as const, unit: "sq", rate_cents: 1000, input: "amount", covers: [] }] as any;
  await invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "pay-sheets.sheet.save", target }, rich, { idempotencyKey: "rich" });
  const kept = await invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "labor.setup.apply", target }, { assignees: [{ ref: { type: "organization_connection", id: summit.subject.id }, kind: "organization_connection", name: "Summit Roofing", pay: { method: "per_job", rate: 900 } }] }, { idempotencyKey: "labor-3" }) as any;
  assert.equal(kept.value.assignees[0].pay, "kept");
});

test("the price book setup saves the labor step through its action, and an explicit switch shows the column", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: PLAIN, name: "Plain Roofing" });
  await enableExpandedPlatformFixture(PLAIN, flags);
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const target = { scope: "organization" as const, organizationId: PLAIN };
  const base = { trade: "roofing", brands: ["gaf"], lines: ["lib-shingle-gaf-hdz"], default_line: "lib-shingle-gaf-hdz" };
  assert.equal(await laborShown(PLAIN), true, "before the setup, as always");
  // Skipped: the step's skip sets no labor and marks it skipped; the setup saves "with assignees" through the type's action.
  await invokeAction(userPublicationContext(owner(PLAIN), { mode: "command" }), { action: "pricebook.setup.apply", target }, { ...base, include_labor: false, labor: { assignees: [], skipped: true } }, { idempotencyKey: "skip" });
  assert.equal(await laborShown(PLAIN), false);
  const types = await import("../materials/resource-types.js");
  const saved = (await types.listResourceTypes(PLAIN, { includeHidden: true })).find((row) => row.id === "labor") as any;
  assert.equal(saved.shown, "with_assignees");
  // Turned on by hand: the column shows with nobody to do labor; and back.
  await types.saveResourceType(PLAIN, { id: "labor", name: "Labor", icon: "fa-helmet-safety", color: "#2563eb", shown: "always", expected_revision: saved.revision }, owner(PLAIN));
  assert.equal(await laborShown(PLAIN), true);
  await types.saveResourceType(PLAIN, { id: "labor", name: "Labor", icon: "fa-helmet-safety", color: "#2563eb", shown: "with_assignees", expected_revision: saved.revision + 1 }, owner(PLAIN));
  assert.equal(await laborShown(PLAIN), false);
  // A scope makes no labor list while it is off.
  // (Generation skips labor definitions the way it skips equipment with the Equipment app off: materials/storage.ts.)
  // Played: the setup adds them through labor.setup.apply, and labor comes back.
  const done = await invokeAction(userPublicationContext(owner(PLAIN), { mode: "command" }), { action: "pricebook.setup.apply", target }, { ...base, labor: { assignees: [{ kind: "resource_group", name: "South crew", pay: { method: "per_measurement", rate: 70 } }] } }, { idempotencyKey: "played" }) as any;
  assert.equal(done.value.labor.assignees[0].pay, "saved");
  assert.equal(await laborShown(PLAIN), true);
});

test("where groups are off, labor is plain lines: the column always shows and the step is not offered", async () => {
  const org = "org_labor_off";
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: org, name: "No Groups" });
  await enableExpandedPlatformFixture(org, { ...flags, "apps.crew": false });
  const types = await import("../materials/resource-types.js");
  await types.saveResourceType(org, { id: "labor", name: "Labor", icon: "fa-helmet-safety", color: "#2563eb", shown: "with_assignees", expected_revision: 0 }, owner(org));
  assert.equal(await laborShown(org), true, "with groups off, labor is plain lines and always shows");
  const service = await import("../guided-experiences/service.js");
  const stepsFor = async (ctx: any) => (await service.availableExperiences(ctx, { tab: "project.materials" })).experiences.find((entry: any) => entry.id === "materials.pricebook_setup.roofing")?.steps.map((step: any) => step.id);
  assert.deepEqual(await stepsFor(owner(org, { ...flags, "apps.crew": false })), ["roof_types", "brands", "defaults", "material", "suppliers"]);
  assert.deepEqual(await stepsFor(owner(ORG)), ["roof_types", "brands", "defaults", "material", "suppliers", "labor"]);
});
