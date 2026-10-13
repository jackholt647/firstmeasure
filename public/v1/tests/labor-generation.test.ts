import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "labor-generation-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_generate";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: {}, branchId: "default" } as any;

test("a labor list is generated from its assignee's pay sheet, and reassigning it reprices the same job", async () => {
  const s = await import("../platform/storage.js"), lists = await import("../materials/storage.js"), d = await import("../platform/publication/datasets.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const sheets = await import("../labor/pay-sheets.js"), g = await import("../labor/generation.js"), c = await import("../labor/commitments.js");
  await s.createOrganization({ id: ORG, name: "Generate" });
  await s.saveGlobal(ORG, { data: { app_flags: { platform: { expanded_access: true, materials: true } } } }, { replace: false });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  await s.upsertDocument(ORG, "projects", { id: "project", data: { title: "12 Oak St" } });
  // The job: 32 squares, 6 of them steep, 180 ft of eaves, and the material lists a signed estimate would have produced.
  const writer = systemPublicationContext({ kind: "module", organizationId: ORG, projectId: "project", operations: ["datasets.save", "datasets.select", "datasets.value"], mode: "command" });
  const target = { scope: "project" as const, organizationId: ORG, projectId: "project" };
  const unit = (value: number, of: string) => ({ value, unit: of, source: "manual" });
  const dataset = await d.importMeasurementDataset(writer, target, { name: "Manual", value: { measurements: { roofSquares: unit(32, "roofing_square"), pitch10Squares: unit(6, "roofing_square"), pitch6Squares: unit(26, "roofing_square"), eavesLf: unit(180, "ft") } } });
  await d.selectProjectDataset(writer, target, "measurements", dataset.id, Number((await s.readDocument(ORG, "projects", "project")).revision));
  const pricebook = await import("../pricebook/storage.js");
  const book = await pricebook.getOrganizationPricebook(ORG);
  await pricebook.saveOrganizationCatalog(ORG, { ...book.catalog, items: [...book.catalog.items, { id: "shingle", kind: "atomic", name: "Shingles", type: "Shingles", category: "shingle_roofs", unit: "bundle", unit_price: 40 }, { id: "ridge", kind: "atomic", name: "Ridge cap", type: "Hip & Ridge", category: "shingle_roofs", unit: "bundle", unit_price: 60 }] }, Number(book.manifest.revision));
  await lists.createMaterialList(ORG, "project", { title: "Materials", resource_type: "material", items: [{ id: "m1", name: "Shingles", quantity: 96, unit: "bundle", pricebook_ref: { item_id: "shingle" } }, { id: "m2", name: "Ridge cap", quantity: 5, unit: "bundle", pricebook_ref: { item_id: "ridge" } }] }, owner);

  const seeded = await (await import("../labor/sample-pay-sheets.js")).seedInstantPaySheets(ORG, owner);
  assert.deepEqual(seeded, { assignees: 5, sheets: 5 });
  await (await import("../labor/sample-pay-sheets.js")).seedInstantPaySheets(ORG, owner);
  const all = await sheets.listPaySheets(ORG);
  assert.equal(all.length, 5, "seeding again adds nothing");
  const subject = (name: string) => all.find((sheet) => sheet.name.startsWith(name))!.subject;
  const kind = (type: string) => (type === "resource_group" ? "resource_group" : "organization_connection");
  const reference = (name: string, label: string) => ({ id: subject(name).id, kind: kind(subject(name).type), name: label });

  // Before anyone is chosen: what each assignee would be paid for this job.
  const list = await lists.createMaterialList(ORG, "project", { title: "Roof labor", resource_type: "labor", items: [] }, owner);
  const compared = await g.compareAssigneesForList(ORG, { list_id: String(list.id) });
  const row = (name: string) => compared.find((entry) => entry.sheet?.name.startsWith(name))!;
  assert.equal(row("Crew B").total_cents, 32 * 6500 + 6 * 1000); assert.equal(row("Crew B").complete, true); assert.equal(row("Crew B").duration_days, 1.5);
  assert.equal(row("Summit").total_cents, 32 * 9500 + 6 * 1500 + 5 * 800); assert.deepEqual(row("Summit").equipment.map((entry) => [entry.name, entry.included]), [["Dump truck", true]]);
  assert.equal(row("Ridgeline").total_cents, 96 * 2900 + 32 * 2500 + 180 * 75, "paid on bundles from the material list, squares and eaves"); assert.deepEqual(row("Ridgeline").equipment, []);
  // Crew A is paid by the hour, and its hours are estimated from the work: 32 squares torn off, dried in and laid,
  // 180 ft of edge metal and the clean-up, at the hours its sheet gives each, to the nearest quarter hour.
  assert.deepEqual([row("Crew A").complete, row("Crew A").estimated_hours, row("Crew A").total_cents, row("Crew A").duration_days], [true, 14.5, 14.5 * 12800, 2], "an hourly assignee is priced on the hours the work is estimated to take");
  assert.deepEqual(compared.filter((entry) => entry.complete).map((entry) => entry.sheet!.name.split(" ")[0]), ["Crew", "Crew", "Summit", "Ridgeline"], "complete prices first, cheapest first");
  // What each would leave for someone else: only two of them take the debris away.
  assert.deepEqual(row("Crew A").not_covered.map((entry) => entry.item), ["disposal.debris"]); assert.deepEqual(row("Summit").not_covered, []); assert.deepEqual(row("Ridgeline").not_covered.map((entry) => entry.item), ["disposal.debris"]);
  assert.deepEqual(row("Crew B").not_capable, [], "the sample assignees are marked as doing roofing, which grants every roofing item");
  assert.equal((await g.compareAssigneesForList(ORG, { list_id: String(list.id), manual: { hours: 60 } })).find((entry) => entry.sheet?.name.startsWith("Crew A"))!.total_cents, 60 * 12800);

  await assert.rejects(() => g.generateLaborList(ORG, { list_id: String(list.id) }, owner), /Assign this list/);
  const assign = async (name: string, label: string) => { const current = await lists.readMaterialList(ORG, String(list.id)); await lists.patchMaterialList(ORG, String(list.id), { expected_revision: Number(current.revision), assignment: { work_resource_ref: reference(name, label) } }, owner); };
  const items = async () => (await lists.readMaterialList(ORG, String(list.id))).current_items as any[];

  // Assigned to the in-house group that is paid by the square and brings its own dump truck.
  await assign("Crew B", "Crew B");
  await assert.rejects(() => g.generateLaborList(ORG, { list_id: String(list.id) }, { ...owner, role: "member", permissions: {}, accessProfile: { roles: [] } }), /project management access/);
  const first = await g.generateLaborList(ORG, { list_id: String(list.id) }, owner);
  assert.equal(first.evaluation.complete, true);
  assert.deepEqual((await items()).map((item) => [item.name, item.quantity, item.unit, Math.round(Number(item.projected_total) * 100)]), [["Tear off and install", 32, "sq", 208000], ["Steep pay", 6, "sq", 6000], ["Dump truck", 1, "job", 0]]);
  assert.deepEqual((await items()).at(-1).metadata.equipment, true); assert.equal((await items()).at(-1).metadata.equipment_included, true);
  // Each line says what it accounts for: the roof price pays for the roof work, the steep line only adjusts it, and the truck takes the debris.
  assert.deepEqual((await items()).map((item) => [item.metadata.covers || null, item.metadata.adjusts || null, (item.metadata.provides || []).map((entry: any) => entry.item)]), [[["roofing.tear_off", "roofing.dry_in", "roofing.install"], null, []], [null, ["roofing.tear_off", "roofing.dry_in", "roofing.install"], []], [null, null, ["disposal.debris"]]]);
  const generation = (await lists.readMaterialList(ORG, String(list.id))).metadata as any;
  assert.equal(generation.labor_generation.pay_sheet_name, "Crew B production pay (sample)"); assert.equal(generation.labor_generation.duration_days, 1.5); assert.equal(generation.labor_generation.complete, true);

  // A line someone added by hand survives regeneration; reassigning reprices the same job on the new assignee's sheet.
  const current = await lists.readMaterialList(ORG, String(list.id));
  await lists.createMaterialVersion(ORG, String(list.id), { expected_revision: Number(current.revision), reason: "supplement", add_items: [{ id: "manual_1", section: "labor", name: "Replace two sheets of decking", quantity: 2, unit: "sheet", projected_unit_price: 45 }] }, owner);
  await assign("Ridgeline", "Ridgeline Exteriors");
  const second = await g.generateLaborList(ORG, { list_id: String(list.id) }, owner);
  assert.equal(second.kept, 1);
  assert.deepEqual((await items()).map((item) => item.name), ["Shingles laid", "Tear off", "Drip edge", "Replace two sheets of decking"], "the previous assignee's lines and its dump truck are gone; the hand-added line stays");
  assert.equal(second.evaluation.total_cents, 96 * 2900 + 32 * 2500 + 180 * 75);

  // An hourly assignee's list is one line at the hourly rate, with the hours estimated from the work. Nothing is asked first.
  await assign("Crew A", "Crew A");
  const estimated = await g.generateLaborList(ORG, { list_id: String(list.id) }, owner);
  assert.equal(estimated.evaluation.complete, true);
  const hourly = (await items()).find((item) => item.name === "Hourly labor");
  assert.deepEqual([hourly.quantity, hourly.unit, hourly.projected_unit_price, hourly.metadata.quantity_estimated, hourly.metadata.estimated_quantity, hourly.metadata.compensation_kind], [14.5, "hour", 128, true, 14.5, "hourly"]);
  assert.equal((await items()).some((item) => item.metadata?.unresolved === true), false);
  assert.deepEqual((await g.previewLaborList(ORG, { list_id: String(list.id) })).ask, [], "hours are estimated or typed in the list, so there is nothing to ask up front");
  // An estimate left alone is worked out again; it is not mistaken for something a person typed.
  assert.equal((await g.previewLaborList(ORG, { list_id: String(list.id), legacy_measurements: {} })).evaluation.work.hours, 14.5);
  const preview = await g.previewLaborList(ORG, { list_id: String(list.id), manual: { hours: 60 } });
  assert.equal(preview.evaluation.total_cents, 60 * 12800); assert.equal((await items()).find((item) => item.name === "Hourly labor").quantity, 14.5, "a preview writes nothing");
  // Someone types 60 hours into the line and adds a bonus that is not on the pay sheet. Regenerating keeps both.
  const typedList = await lists.readMaterialList(ORG, String(list.id));
  await lists.createMaterialVersion(ORG, String(list.id), { expected_revision: Number(typedList.revision), reason: "revision", items: [...(typedList.current_items as any[]).map((item) => (item.name === "Hourly labor" ? { ...item, quantity: 60, projected_total: 7680 } : item)), { id: "bonus", section: "labor", name: "Finish-early bonus", quantity: 1, unit: "ea", projected_unit_price: 20 }] }, owner);
  const priced = await g.generateLaborList(ORG, { list_id: String(list.id) }, owner);
  assert.equal(priced.evaluation.complete, true); assert.equal(priced.evaluation.total_cents, 60 * 12800);
  assert.deepEqual((await items()).map((item) => [item.name, item.quantity]), [["Hourly labor", 60], ["Replace two sheets of decking", 2], ["Finish-early bonus", 1]], "the typed hours and the hand-added lines survive");
  const rowA = (await g.compareAssigneesForList(ORG, { list_id: String((await lists.createMaterialList(ORG, "project", { title: "Other labor", resource_type: "labor", items: [] }, owner)).id) })).find((entry) => entry.sheet?.name.startsWith("Crew A"))!;
  assert.deepEqual([rowA.awaiting_hours, rowA.hourly_rate_cents, rowA.complete], [false, 12800, true], "an hourly assignee whose hours can be estimated has a price");
  assert.deepEqual((await g.compareAssigneesForList(ORG, { list_id: String(list.id) })).find((entry) => entry.sheet?.name.startsWith("Crew B"))!.duration_basis, { label: "Roof squares", value: 32, units_per_day: 22 }, "an estimate of days says what it rests on");

  // A project with no measurement dataset is priced from what the Project tab holds, in dictionary keys and units only.
  await s.upsertDocument(ORG, "projects", { id: "bare", data: { title: "4 Pine St" } });
  const bare = await lists.createMaterialList(ORG, "bare", { title: "Roof labor", resource_type: "labor", items: [], assignment: { work_resource_ref: reference("Crew B", "Crew B") } }, owner);
  assert.equal((await g.previewLaborList(ORG, { list_id: String(bare.id) })).evaluation.complete, false, "nothing to price from");
  const held = { roofSquares: { value: 20, unit: "roofing_square" }, pitch9to12Squares: { value: 4, unit: "roofing_square" }, eavesLf: { value: 100, unit: "inches" }, madeUp: { value: 9, unit: "ft" } };
  const fromTab = await g.previewLaborList(ORG, { list_id: String(bare.id), legacy_measurements: held });
  assert.equal(fromTab.measurement_source, "project"); assert.equal(fromTab.evaluation.total_cents, 20 * 6500 + 4 * 1000);
  const { legacyMeasurements } = await import("../labor/pay-sheet-publication.js");
  assert.deepEqual(Object.keys(legacyMeasurements(held)), ["roofSquares", "pitch9to12Squares"], "a wrong unit or an unknown key is left out");
  // Once the project has a selected dataset, what the tab holds is ignored.
  const ignored = await g.previewLaborList(ORG, { list_id: String(list.id), manual: { hours: 60 }, legacy_measurements: { roofSquares: { value: 999, unit: "roofing_square" } } });
  assert.equal(ignored.measurement_source, "dataset");

  // A salaried group is priced at a cost rate: hours at what that time costs the business. It projects the job and is
  // marked as never paid out, because their pay is their salary.
  const salaried = await lists.createMaterialList(ORG, "project", { title: "Salaried labor", resource_type: "labor", items: [], assignment: { work_resource_ref: reference("Crew C", "Crew C") } }, owner);
  const rowC = (await g.compareAssigneesForList(ORG, { list_id: String(salaried.id) })).find((entry) => entry.sheet?.name.startsWith("Crew C"))!;
  assert.deepEqual([rowC.awaiting_hours, rowC.cost_rate_cents, rowC.hourly_rate_cents], [true, 9500, null]);
  await g.generateLaborList(ORG, { list_id: String(salaried.id) }, owner);
  const costLine = ((await lists.readMaterialList(ORG, String(salaried.id))).current_items as any[])[0];
  assert.deepEqual([costLine.name, costLine.quantity, costLine.unit, costLine.projected_unit_price, costLine.metadata.compensation_kind, costLine.metadata.projection_only], ["Salaried time", 0, "hour", 95, "cost_rate", true]);
  const costed = await g.previewLaborList(ORG, { list_id: String(salaried.id), manual: { hours: 40 } });
  assert.equal(costed.evaluation.total_cents, 40 * 9500); assert.equal(costed.evaluation.projection_only_cents, 40 * 9500, "all of it is projection, none of it is payable");
  assert.equal((await g.previewLaborList(ORG, { list_id: String(list.id) })).evaluation.projection_only_cents, 0, "hourly pay is payable, not projection only");

  // What was generated is what gets committed.
  const committed = await c.commitLaborList(ORG, { list_id: String(list.id) }, owner, { todo: async () => null, email: async () => null, run: async () => [] });
  assert.equal(committed.total_cents, 60 * 12800 + 9000 + 2000); assert.equal(committed.unpriced_lines, 0); assert.equal(committed.pay_sheets.length, 1);
});
