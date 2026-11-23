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

// GP-162: a piece rate is items. Pitch ranges are one rate for each range, instead of each other, and between them take
// in every pitch; a bonus over a pitch and a rate per foot of a roof line are added on top.
test("a piece rate is one rate for each pitch range with bonuses on top, read back item by item and priced", async () => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const sheets = await import("../labor/pay-sheets.js"), labor = await import("../labor/labor-setup.js");
  const target = { scope: "organization" as const, organizationId: ORG };
  const run = (assignees: unknown[], key: string) => invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "labor.setup.apply", target }, { assignees }, { idempotencyKey: key }) as Promise<any>;
  const ranges = [[0, 2, 90], [2, 8, 65], [8, 12, 80], [12, null, 100]].map(([above, up_to, rate]) => ({ type: "pitch_range", above, up_to, rate }));
  const items = [...ranges, { type: "pitch_bonus", above: 8, up_to: null, rate: 2 }, { type: "measurement", measurement: "roof.ridge_length", rate: 1.5 }];
  // The status offers every roofing measurement and the pitch bands ranges start and end at.
  const options = await labor.laborSetupOptions(ORG);
  assert.deepEqual(options.pitch_bands.map((band) => [band.above, band.up_to]), [[0, 2], [2, 4], [4, 6], [6, 8], [8, 12], [12, null]]);
  for (const id of ["roof.squares", "roof.ridge_length", "roof.chimney_step_length", "roof.squares_hand_carried"]) assert.ok(options.measurements.some((entry) => entry.id === id), id);
  assert.ok(!options.measurements.some((entry) => entry.id === "roof.squares_9_to_12"), "pitch bands are read as ranges, not listed one by one");

  // Ranges that leave pitches out, or overlap, are refused: a square at a pitch no range takes in would be paid nothing.
  await assert.rejects(run([{ kind: "resource_group", name: "Gap crew", pay: { method: "per_measurement", items: [ranges[0], ranges[2], ranges[3]] } }], "gap"), /follow on from each other/);
  await assert.rejects(run([{ kind: "resource_group", name: "Gap crew", pay: { method: "per_measurement", items: [ranges[0], ranges[1]] } }], "open"), /every pitch above it/);
  await assert.rejects(run([{ kind: "resource_group", name: "Gap crew", pay: { method: "per_measurement", items: [{ type: "pitch_bonus", above: 7, up_to: null, rate: 2 }] } }], "edge"), /starts and ends/);

  const done = await run([{ kind: "resource_group", name: "Pitch crew", pay: { method: "per_measurement", items } }], "pitch");
  assert.equal(done.value.assignees[0].pay, "saved");
  const sheet = (await sheets.listPaySheets(ORG)).find((row) => row.subject.id === done.value.assignees[0].ref.id)!;
  assert.deepEqual(sheet.entries.map((entry) => [entry.label, entry.rate_cents, entry.role ?? ""]), [
    ["Squares up to 2/12", 9000, ""], ["Squares over 2/12 up to 8/12", 6500, ""], ["Squares over 8/12 up to 12/12", 8000, ""], ["Squares over 12/12", 10000, ""],
    ["Bonus: squares over 8/12", 200, "adjusts"], ["Ridges", 150, ""]
  ]);
  // A range is its pitch bands read as one input.
  assert.deepEqual(sheet.inputs.find((input) => input.name === "pitch_2_8")!.source, { kind: "measurement", definition: "roof.squares_2_to_4", also: ["roof.squares_4_to_6", "roof.squares_6_to_8"], per_structure: true });
  // The ranges are all of the roof's squares, so they pay for it; the bonus only adjusts that price; ridges pay for ridge cap.
  assert.deepEqual(Object.fromEntries(sheets.paySheetWork(sheet)), { "roofing.tear_off": "paid", "roofing.dry_in": "paid", "roofing.install": "paid", "roofing.ridge_cap": "paid", "roofing.edge_metal": "included", "roofing.valleys": "included", "roofing.wall_flashing": "included", "roofing.cleanup": "included" });

  // A 6/12 and 10/12 roof: each square at its range's rate, the steep ones $2 more, ridges on top. Nothing over 12/12.
  const v = (value: number, unit = "roofing_square") => ({ value, unit });
  const priced = sheets.evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: v(30), pitch6Squares: v(20), pitch10Squares: v(10), ridgesLf: v(40, "ft") } } });
  assert.deepEqual(priced.lines.map((line) => [line.label, line.quantity, line.total_cents]), [["Squares over 2/12 up to 8/12", 20, 130000], ["Squares over 8/12 up to 12/12", 10, 80000], ["Bonus: squares over 8/12", 10, 2000], ["Ridges", 40, 6000]]);
  assert.equal(priced.complete, true);
  // The issue's two ways of paying more for steep squares come to the same: $65 and $80 by range, or $65 for every
  // square and a $15 bonus on the steep ones. One replaces the rate, the other adds to it.
  const sheetOf = (pay: unknown) => ({ ...sheets.paySheetInputSchema.parse(labor.laborPaySheet({ type: "resource_group", id: "x" }, "x", pay as never)), id: "x", revision: 1 });
  const roof = { measurements: { measurements: { roofSquares: v(30), pitch6Squares: v(20), pitch10Squares: v(10) } } };
  const byRange = sheets.evaluatePaySheet(sheetOf({ method: "per_measurement", items: [{ type: "pitch_range", above: 0, up_to: 8, rate: 65 }, { type: "pitch_range", above: 8, up_to: null, rate: 80 }] }), roof);
  const withBonus = sheets.evaluatePaySheet(sheetOf({ method: "per_measurement", items: [{ type: "measurement", measurement: "roof.squares", rate: 65 }, { type: "pitch_bonus", above: 8, up_to: null, rate: 15 }] }), roof);
  assert.equal(byRange.total_cents, 210000);
  assert.equal(withBonus.total_cents, byRange.total_cents);
  // A roof measured with no pitches at all cannot be priced by pitch: unresolved, never paid as nothing.
  const unpitched = sheets.evaluatePaySheet(sheet, { measurements: { measurements: { roofSquares: v(30), ridgesLf: v(40, "ft") } } });
  assert.equal(unpitched.complete, false);
  assert.deepEqual(unpitched.unresolved.map((row) => row.label).slice(0, 2), ["Squares up to 2/12", "Squares over 2/12 up to 8/12"]);

  // The status gives the setup its items back, so it shows the same ranges; the price book's one-line view does not.
  const shown = (await labor.laborSetupOptions(ORG)).assignees.find((row) => row.name === "Pitch crew")!;
  assert.deepEqual(shown.pay?.items, items);
  assert.equal(shown.pay?.simple, null);
  // Saved again with new rates, it is the same sheet.
  await run([{ ref: done.value.assignees[0].ref, kind: "resource_group", name: "Pitch crew", pay: { method: "per_measurement", items: items.map((item) => ({ ...item, rate: item.rate + 1 })) } }], "pitch-2");
  const again = (await sheets.listPaySheets(ORG)).filter((row) => row.subject.id === done.value.assignees[0].ref.id);
  assert.equal(again.length, 1);
  assert.equal(again[0]!.entries[0]!.rate_cents, 9100);

  // A sheet with more than the setup writes (a truck it brings, a line that pays for other work) is left to People.
  const truck = { ...again[0]!, equipment: [{ name: "Dump truck", included: true, provides: [] }], expected_revision: again[0]!.revision } as any;
  delete truck.revision;
  await invokeAction(userPublicationContext(owner(), { mode: "command" }), { action: "pay-sheets.sheet.save", target }, truck, { idempotencyKey: "truck" });
  assert.equal(labor.simplePay((await sheets.listPaySheets(ORG)).find((row) => row.id === again[0]!.id)!), null);
  const kept = await run([{ ref: done.value.assignees[0].ref, kind: "resource_group", name: "Pitch crew", pay: { method: "per_measurement", items } }], "pitch-3");
  assert.equal(kept.value.assignees[0].pay, "kept");
});
