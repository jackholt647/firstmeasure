import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// The roofing price book setup (pricebook/setups/roofing.ts, docs/architecture/guided-experiences.md).
const dir = await mkdtemp(path.join(os.tmpdir(), "pricebook-roofing-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_roofing_setup";
const owner = { orgId: ORG, userId: "owner", role: "owner", permissions: { "*": true }, branchId: "default", capabilities: { effectiveByKey: { "platform.materials": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as any;
const crew = { ...owner, userId: "crew", role: "member", permissions: { view_projects: true }, accessProfile: { roles: [], app_restrictions: [] } } as any;

const keysOf = (item: any) => (item.formulaConfig?.tokens || []).filter((token: any) => token.type === "measurement").map((token: any) => token.value);
const formulaOf = (item: any) => item.formulaConfig.tokens.map((token: any) => token.value).join(" ");

test("the research catalog is read in its own schema, with the library as the fallback", async () => {
  const roofing = await import("../pricebook/setups/roofing.js");
  const research = roofing.readResearchCatalog();
  assert.ok(research, "the research catalog is in the checkout");
  // Every manufacturer in the catalog file is offered, whatever the research adds.
  const raw = JSON.parse(await readFile(path.resolve(process.cwd(), "materials/roofing-research/roofing-catalog-2026.json"), "utf8"));
  const expected = raw.manufacturers.map((maker: any) => String(maker.pricebook_manufacturer || maker.id)).sort();
  assert.deepEqual(research!.brands.map((brand) => brand.id).sort(), expected);
  for (const id of ["certainteed", "gaf", "malarkey", "owens_corning"]) assert.ok(expected.includes(id));
  for (const maker of raw.manufacturers.filter((entry: any) => entry.logo)) {
    const brandId = String(maker.pricebook_manufacturer || maker.id);
    const brand: { id: string; logo?: string } = research!.brands.find((entry) => entry.id === brandId)!;
    assert.equal(brand.logo, roofing.logoPath(maker.logo), `${brand.id} carries its logo`);
    assert.ok(existsSync(path.resolve(process.cwd(), "..", brand.logo!.slice(1))), `${brand.logo} is in public/`);
  }
  assert.ok(research!.brands.every((brand) => brand.lines.length >= 3), "each brand has its lines");
  assert.ok(research!.brands.every((brand) => brand.lines.filter((line) => line.flagship).length === 1), "each brand names one flagship line");
  const duration = research!.brands.find((brand) => brand.id === "owens_corning")!.lines.find((line) => line.id === "lib-shingle-oc-duration")!;
  assert.equal(Math.round(duration.coverage * 1000) / 1000, 0.328, "an Owens Corning bundle covers 32.8 sq ft, not a flat third of a square");
  const weatherwatch = research!.brands.find((brand) => brand.id === "gaf")!.accessories.find((entry) => entry.id === "lib-iws-gaf-weatherwatch")!;
  assert.equal(weatherwatch.coverage, 2, "a WeatherWatch roll's own coverage, 200 sq ft");
  // Additions without a listing behind them are marked provisional, with a note.
  const added = [...research!.brands.flatMap((brand) => brand.accessories), ...research!.generic].filter((entry) => ["pipe_boot", "intake_vent", "box_vent", "low_slope_membrane", "low_slope_base", "low_slope_cap"].includes(entry.role) || ["intake_vent", "box_vents"].includes(entry.rule));
  assert.ok(added.length >= 15 && added.every((entry) => entry.provisional && entry.note), "new categories are provisional");
  assert.equal(research!.brands.find((brand) => brand.id === "gaf")!.accessories.find((entry) => entry.id === "lib-intake-gaf-cobra-intakepro")!.coverage, 4, "intake pieces cover 4 ft");
  assert.equal(research!.brands.find((brand) => brand.id === "gaf")!.accessories.find((entry) => entry.id === "lib-lowslope-gaf-everguard-tpo-60")!.coverage, 10, "a TPO roll covers 10 squares");
  assert.deepEqual(research!.roof_types.map((type) => type.id), ["shingle", "shake", "metal", "tile", "slate", "tpo", "pvc", "epdm", "mod_bit"], "PVC is its own membrane");
  assert.ok(research!.regions.some((region) => region.id === "northeast" && region.states.includes("NY")));
  // Logos are site paths under public/images; anything else is dropped and the card shows the wordmark.
  assert.equal(roofing.logoPath("public/images/brands/roofing/gaf.svg"), "/images/brands/roofing/gaf.svg");
  assert.equal(roofing.logoPath({ src: "images/brands/roofing/iko.png" }), "/images/brands/roofing/iko.png");
  assert.equal(roofing.logoPath("javascript:alert(1)"), "");
  assert.equal(roofing.logoPath("images/brands/roofing/gaf.exe"), "");
  const options = roofing.roofingSetupOptions("TX");
  assert.deepEqual(options.brands.slice(0, 4).map((brand: any) => brand.id), ["gaf", "owens_corning", "malarkey", "certainteed"], "the four most installed first, any others after");
  assert.deepEqual(options.roof_types.find((type: any) => type.id === "metal")!.systems.map((system: any) => system.id), ["metal_standing_seam", "metal_exposed_fastener", "stone_coated_steel"]);
  assert.equal((options.low_slope as any).tpo.cap.id, "rtc-tpo-membrane", "a generic TPO membrane from the roof-type components");
  assert.deepEqual([(options.low_slope as any).mod_bit.cap.id, (options.low_slope as any).mod_bit.base.id], ["rtc-modified-bitumen-cap-sheet", "rtc-modified-bitumen-base-sheet"]);
  const library = roofing.readResearchCatalog(path.join(dir, "missing.json"));
  assert.equal(library, null);
  assert.ok(roofing.libraryCatalog().brands.length >= 3, "without the research file the library still offers brands");
});

test("the roof-type components are read whole: every component, in dictionary measurements of one unit", async () => {
  const roofing = await import("../pricebook/setups/roofing.js"), d = await import("../materials/measurement-defaults.js");
  const raw = JSON.parse(await readFile(path.resolve(process.cwd(), "materials/roofing-research/roof-type-components-2026.json"), "utf8"));
  assert.equal(raw.status, "provisional");
  const systems = roofing.roofTypeComponents();
  for (const type of raw.types) assert.equal(systems.get(type.id)?.components.length, type.components.length, `${type.id}: no component is dropped`);
  // Every system can be a default material, and its rules pass the measurement defaults' own checks.
  const catalog = roofing.roofingCatalog();
  for (const type of catalog.roof_types.filter((entry) => !entry.catalog)) for (const system of type.systems) {
    const built = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: [type.id], default_material: system }), d.industryMeasurementDefaults());
    const settings = d.parseMeasurementDefaults(built.settings);
    const on = settings.materials.rules.filter((rule) => rule.enabled);
    const standard = systems.get(system)!.components.filter((entry) => entry.component!.standard && !entry.component!.by_hand);
    assert.deepEqual(on.map((rule) => rule.product_id), standard.map((entry) => entry.id), `${system}: one rule per standard, measured component`);
    for (const rule of on) assert.ok(built.items.some((item) => item.id === rule.product_id), `${rule.key} names a written item`);
  }
});

test("shingle: every product of the picked brands is written, and the defaults start from the first picked brand that makes each", async () => {
  const roofing = await import("../pricebook/setups/roofing.js"), { definitionForKey, listMeasurementDefinitions } = await import("../platform/publication/measurement-schemas.js");
  const d = await import("../materials/measurement-defaults.js");
  const selections = roofing.roofingSelectionsSchema.parse({ roof_types: ["shingle", "metal"], brands: ["owens_corning", "gaf"], defaults: { ice_coverage: "eaves_36_valleys" }, waste: 15, state: "NY", prices: { "lib-shingle-gaf-hdz": 60 } });
  const built = roofing.buildRoofingSetup(selections, d.industryMeasurementDefaults());
  const ids = built.items.map((item) => item.id);
  const research = roofing.readResearchCatalog()!;
  for (const brand of research.brands.filter((entry) => ["owens_corning", "gaf"].includes(entry.id))) for (const product of [...brand.lines, ...brand.accessories]) assert.ok(ids.includes(product.id), `${product.id} is in the price book`);
  assert.ok(!ids.some((id) => id.startsWith("lib-shingle-iko")), "a brand not picked is not");
  assert.ok(ids.includes("rtc-metal-standing-seam-panels") && ids.includes("rtc-stone-coated-steel-panels"), "the other kinds of roof picked get their components");
  assert.equal(new Set(ids).size, ids.length, "each item once");
  assert.equal(built.region.id, "northeast");
  assert.deepEqual(built.defaults, {
    shingle: "lib-shingle-oc-duration", underlayment: "lib-underlay-oc-proarmor", ice_water: "lib-iws-oc-weatherlock-g", ice_coverage: "eaves_36_valleys",
    pipe_boot: "lib-pipe-boot-lead-3", ridge_vent: "lib-ridge-vent-oc-ventsure", intake_vent: "lib-intake-oc-ventsure-inflow", box_vent: "lib-boxvent-oc-ventsure-slantback",
    low_slope_system: "tpo", low_slope: "lib-lowslope-gaf-everguard-tpo-60", low_slope_base: null
  }, "Owens Corning first; GAF fills what it does not make (TPO); pipe boots are lead");
  for (const item of built.items) for (const key of keysOf(item)) assert.ok(definitionForKey(key), `${item.id} reads ${key}, a dictionary key`);
  assert.ok(built.items.every((item) => !keysOf(item).includes("shingleSquares")), "shingleSquares is not a dictionary key");
  const item = (id: string) => built.items.find((entry) => entry.id === id)! as any;
  assert.equal(formulaOf(item("lib-shingle-oc-duration")), "( roofSquares - flatRoofSquares ) / 0.328");
  assert.equal(item("lib-shingle-oc-duration").formulaConfig.includeWaste, true);
  assert.equal(formulaOf(item("lib-iws-oc-weatherlock-g")), "( ( eavesLf * 3 + valleyLf * 3 ) / 100 + pitch2to4Squares ) / 2", "the company's coverage; the roll's own coverage");
  assert.equal(formulaOf(item("lib-intake-oc-ventsure-inflow")), "( eavesLf ) / 4", "intake runs along the eaves in 4 ft pieces");
  assert.equal(formulaOf(item("rtc-metal-standing-seam-panels")), "( roofSquares ) * 1.08", "a component's own waste, in its unit");
  assert.equal(item("lib-pipe-boot-lead-3").formulaConfig, undefined, "pipe boots are not in the dictionary, so they are entered by hand");
  assert.equal(item("lib-pipe-boot-lead-3").metadata.quantity, "entered_by_hand");
  assert.equal(item("lib-pipe-boot-lead-3").metadata.default_for, "pipe_boots", "the default is recorded on the item");
  assert.equal(item("lib-boxvent-oc-ventsure-slantback").metadata.default_for, "box_vents");
  assert.equal(item("lib-boxvent-oc-ventsure-slantback").metadata.provisional, true);
  assert.equal(item("lib-shingle-gaf-hdz").unit_price, 60, "a typed price wins");
  assert.equal(item("lib-shingle-oc-oakridge").internal_cost, Math.round(40 * 1.03 * 100) / 100, "the Northeast's material cost, no markup");
  assert.equal(item("lib-shingle-oc-oakridge").unit_price, item("lib-shingle-oc-oakridge").internal_cost, "no markup is assumed: the sell price is the cost");
  assert.equal(item("lib-lowslope-gaf-everguard-tpo-60").category, "flat_roofs");
  assert.equal(item("rtc-metal-standing-seam-panels").type, "Standing seam metal");

  const settings = d.parseMeasurementDefaults(built.settings);
  const known = new Set(listMeasurementDefinitions().map((definition) => definition.id));
  for (const rule of settings.materials.rules) for (const term of rule.terms) assert.ok(known.has(term.measurement), `${rule.key} reads ${term.measurement}`);
  const rule = (key: string) => settings.materials.rules.find((entry) => entry.key === key)!;
  assert.equal(rule("shingles").product_id, "lib-shingle-oc-duration");
  assert.equal(rule("shingles").waste, 15);
  assert.deepEqual(rule("shingles").package, { unit: "bundle", coverage: 0.328 });
  assert.equal(rule("starter").product_id, "lib-starter-oc-starter-strip", "starter follows the shingle's maker");
  assert.equal(rule("starter").package?.coverage, 105, "Owens Corning starter runs 105 ft a bundle");
  // A product's coverage in another unit than the rule's line is not copied onto it: cap nails were written as one pail
  // a square, and step flashing as 100 ft a bundle (its 100 pieces).
  assert.deepEqual(rule("cap_nails").package, { unit: "pail", coverage: 20 }, "a pail does about 20 squares");
  assert.deepEqual(rule("step_flashing").package, { unit: "bundle", coverage: 46 }, "a bundle of 100 pieces runs about 46 ft of wall");
  assert.deepEqual(rule("coil_nails").package, { unit: "box", coverage: 22.5 }, "the research's 7,200 box at 320 nails a square");
  assert.equal(formulaOf(item("lib-cap-nails-1")), "( roofSquares - flatRoofSquares ) / 20", "the price book item counts the same pails");
  assert.deepEqual(rule("ice_water").terms, [{ measurement: "roof.eave_length", factor: 1 }, { measurement: "roof.valley_length", factor: 1 }], "one 3 ft row at the eaves and one down each valley");
  assert.equal(rule("ridge_vent").product_id, "lib-ridge-vent-oc-ventsure");
  assert.deepEqual([rule("intake_vent").product_id, rule("intake_vent").terms, rule("intake_vent").package], ["lib-intake-oc-ventsure-inflow", [{ measurement: "roof.eave_length", factor: 1 }], { unit: "pc", coverage: 4 }], "an intake rule is added beside the ridge vent");
  assert.deepEqual([rule("low_slope_cap").product_id, rule("low_slope_cap").label, rule("low_slope_cap").package], ["lib-lowslope-gaf-everguard-tpo-60", "Low-slope membrane", { unit: "roll", coverage: 10 }]);
  assert.equal(rule("low_slope_base").enabled, false, "a single-ply membrane has no base sheet");
  assert.ok(!settings.materials.rules.some((entry) => entry.key.startsWith("metal_")), "with shingle, metal components are price book items only");
  for (const entry of settings.materials.rules.filter((r) => r.enabled && r.product_id)) assert.ok(ids.includes(entry.product_id) || !entry.product_id.startsWith("lib-"), `${entry.key} names a written product`);

  // The default coverage: 18 in around the eaves and rakes, plus valleys.
  const plain = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], include_labor: false }), d.industryMeasurementDefaults());
  assert.deepEqual(plain.roof_types, ["shingle"], "shingle when nobody said");
  const plainRules = d.parseMeasurementDefaults(plain.settings).materials.rules;
  assert.deepEqual(plainRules.find((entry) => entry.key === "ice_water")!.terms, [{ measurement: "roof.eave_length", factor: 0.5 }, { measurement: "roof.rake_length", factor: 0.5 }, { measurement: "roof.valley_length", factor: 1 }], "half a 3 ft course along eaves and rakes");
  assert.equal(formulaOf(plain.items.find((entry) => entry.id === "lib-iws-gaf-weatherwatch")), "( ( eavesLf * 1.5 + rakesLf * 1.5 + valleyLf * 3 ) / 100 + pitch2to4Squares ) / 2");
  assert.equal(plain.defaults!.underlayment, "lib-underlay-gaf-tiger-paw", "GAF's default underlayment is Tiger Paw");
  assert.equal(plain.defaults!.shingle, "lib-shingle-gaf-hdz", "GAF's flagship");
  assert.ok(!plain.items.some((entry) => entry.id.startsWith("labor-")), "labor can be left out");
  const none = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], defaults: { ice_coverage: "none", low_slope_system: "none" } }), d.industryMeasurementDefaults());
  const noneRules = d.parseMeasurementDefaults(none.settings).materials.rules;
  assert.equal(noneRules.find((entry) => entry.key === "ice_water")!.enabled, false, "no ice and water");
  assert.ok(noneRules.filter((entry) => entry.key.startsWith("low_slope")).every((entry) => !entry.enabled), "no low-slope system");
  // A chosen product wins where it is offered; one from a brand not picked falls back to the default.
  const chosen = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf", "iko"], defaults: { shingle: "lib-shingle-gaf-uhdz", underlayment: "lib-underlay-gaf-feltbuster", ridge_vent: "lib-ridge-vent-oc-ventsure" } }), d.industryMeasurementDefaults());
  assert.deepEqual([chosen.defaults!.shingle, chosen.defaults!.underlayment, chosen.defaults!.ridge_vent], ["lib-shingle-gaf-uhdz", "lib-underlay-gaf-feltbuster", "lib-ridge-vent-cobra-rigid"]);
  // Modified bitumen: a base and a cap from the same company, else the generic pair.
  const torch = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: ["shingle", "mod_bit"], brands: ["certainteed"] }), d.industryMeasurementDefaults());
  assert.deepEqual([torch.defaults!.low_slope_system, torch.defaults!.low_slope, torch.defaults!.low_slope_base], ["mod_bit", "lib-lowslope-ct-flintlastic-sa-cap", "lib-lowslope-ct-flintlastic-nailbase"], "they install torch-down and not TPO");
  const generic = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["owens_corning"], defaults: { low_slope_system: "mod_bit" } }), d.industryMeasurementDefaults());
  assert.deepEqual([generic.defaults!.low_slope, generic.defaults!.low_slope_base], ["rtc-modified-bitumen-cap-sheet", "rtc-modified-bitumen-base-sheet"]);
  assert.ok(generic.items.some((entry) => entry.id === "rtc-modified-bitumen-base-sheet"), "a generic low-slope default is written so its rule has a product");
  assert.throws(() => roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: ["shingle"] }), d.industryMeasurementDefaults()), /roofing manufacturer/);
  assert.throws(() => roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: ["thatch"] }), d.industryMeasurementDefaults()), /kind of roof/);
});

test("no shingle: the default material's standard components are the defaults, and no shingle products are written", async () => {
  const roofing = await import("../pricebook/setups/roofing.js"), d = await import("../materials/measurement-defaults.js");
  const before = d.parseMeasurementDefaults(roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"] }), d.industryMeasurementDefaults()).settings);
  const built = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: ["metal", "tile"], default_material: "metal_exposed_fastener", brands: ["gaf"] }), before);
  assert.equal(built.default_material, "metal_exposed_fastener");
  assert.equal(built.defaults, null);
  assert.ok(built.items.every((item) => item.id.startsWith("rtc-")), "only components: no shingles, even with a brand left over");
  assert.ok(built.items.some((item) => item.id.startsWith("rtc-tile-concrete-clay-")), "every picked kind is in the price book");
  const systems = roofing.roofTypeComponents();
  const optional = systems.get("metal_exposed_fastener")!.components.find((entry) => !entry.component!.standard)!;
  assert.ok(built.items.some((item) => item.id === optional.id), "optional components are searchable items");
  const settings = d.parseMeasurementDefaults(built.settings);
  const on = settings.materials.rules.filter((rule) => rule.enabled);
  assert.ok(on.length > 5 && on.every((rule) => rule.key.startsWith("metal_exposed_fastener_")), "only the default material generates");
  assert.ok(!on.some((rule) => rule.product_id === optional.id), "optional components are not generated");
  const panels = on.find((rule) => rule.key === "metal_exposed_fastener_panels")!;
  assert.deepEqual(panels.terms, [{ measurement: "roof.squares", factor: 1 }], "the roof's total squares");
  assert.equal(settings.materials.rules.find((rule) => rule.key === "shingles")!.enabled, false, "shingle rules stay, switched off");
  // The calculation names each line from its component item.
  const items = built.items.map((item: any) => ({ id: item.id, name: item.name, type: item.type, unit: item.unit, cost: item.internal_cost, attributes: {} }));
  const calculus = d.measurementDefaultsCalculus(settings, items);
  assert.ok(calculus.defaults.rules.every((rule: any) => rule.product?.id?.startsWith("rtc-metal-exposed-fastener-")));
  // Another default material replaces the component rules; going back to shingle restores the shingle rules.
  const again = d.parseMeasurementDefaults(roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ roof_types: ["metal"] }), settings).settings);
  assert.ok(again.materials.rules.filter((rule) => rule.enabled).every((rule) => rule.key.startsWith("metal_standing_seam_")), "the first system when none is named");
  assert.ok(!again.materials.rules.some((rule) => rule.key.startsWith("metal_exposed_fastener_")));
  const back = d.parseMeasurementDefaults(roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"] }), again).settings);
  assert.ok(!back.materials.rules.some((rule) => rule.key.startsWith("metal_")));
  assert.ok(["shingles", "starter", "hip_ridge", "underlayment", "ice_water", "ridge_vent", "intake_vent"].every((key) => back.materials.rules.find((rule) => rule.key === key)?.enabled));
});

test("the published action writes through the price book and defaults writers, as the person", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Setup Roofing" });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const { invokeAction, describeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  assert.ok(describeAction("pricebook.setup.apply")?.executionKinds.includes("agent"));
  assert.ok(describeAction("pricebook.items.add")?.executionKinds.includes("agent"));
  assert.ok(describeAction("materials.project.generate")?.executionKinds.includes("agent"), "an agent can press Generate");
  const target = { scope: "organization" as const, organizationId: ORG };
  const input = { trade: "roofing", roof_types: ["shingle"], brands: ["gaf"], defaults: { shingle: "lib-shingle-gaf-uhdz" } };
  await assert.rejects(async () => invokeAction(userPublicationContext(crew, { mode: "command" }), { action: "pricebook.setup.apply", target }, input, { idempotencyKey: "denied" }), /not permitted|permission/i);
  const done = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.setup.apply", target }, input, { idempotencyKey: "setup-1" }) as any;
  assert.equal(done.value.default_line, "lib-shingle-gaf-uhdz");
  assert.ok(done.value.item_ids.includes("lib-shingle-gaf-grand-sequoia"), "every GAF line, so the price book view can show them");
  const book = await (await import("../pricebook/storage.js")).getOrganizationPricebook(ORG);
  const uhdz = book.catalog.items.find((item: any) => item.id === "lib-shingle-gaf-uhdz") as any;
  assert.ok(uhdz?.formulaConfig?.tokens?.length, "the line is in the price book with its formula");
  assert.equal(uhdz.metadata.setup, "pricebook.roofing");
  assert.ok(book.catalog.items.some((item: any) => item.id === "roof_replacement"), "items the organization already had are kept");
  const defaults = await (await import("../materials/measurement-defaults.js")).readMeasurementDefaults(ORG);
  assert.equal(defaults.stored, true);
  assert.equal(defaults.settings.materials.rules.find((rule) => rule.key === "shingles")!.product_id, "lib-shingle-gaf-uhdz");

  // A supplier price sheet: the agent lists the prices, then applies a checked list of cost changes.
  const listed = await invokeAction(userPublicationContext(owner, { mode: "evaluate" }), { action: "pricebook.prices.list", target }, { query: "UHDZ" }) as any;
  assert.ok(listed.value.items.some((item: any) => item.id === "lib-shingle-gaf-uhdz"));
  await assert.rejects(async () => invokeAction(userPublicationContext(crew, { mode: "command" }), { action: "pricebook.prices.update", target }, { changes: [{ item_id: "lib-shingle-gaf-uhdz", internal_cost: 1 }] }, { idempotencyKey: "denied-prices" }), /not permitted|permission/i);
  const updated = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.prices.update", target }, { changes: [{ item_id: "lib-shingle-gaf-uhdz", internal_cost: 51.25, source: "ABC Supply sheet line 12" }, { item_id: "nope", internal_cost: 2 }] }, { idempotencyKey: "prices-1" }) as any;
  assert.deepEqual(updated.value.missing, ["nope"]);
  assert.equal(updated.value.applied[0].after.internal_cost, 51.25);
  const after = (await (await import("../pricebook/storage.js")).getOrganizationPricebook(ORG)).catalog.items.find((item: any) => item.id === "lib-shingle-gaf-uhdz") as any;
  assert.equal(after.internal_cost, 51.25);
  assert.equal(after.formulaConfig.tokens.length > 0, true, "only the price changed");

  // A metal supplier's sheet: what the price book does not have is added (no catalog to match), what it has is priced.
  const sheet = { items: [{ name: "26 ga standing seam panel, Charcoal", unit: "sq", internal_cost: 412, category: "misc" as const, type: "Standing seam metal", source: "Metal Depot sheet line 3" }, { name: uhdz.name, unit: "bundle", internal_cost: 50 }] };
  await assert.rejects(async () => invokeAction(userPublicationContext(crew, { mode: "command" }), { action: "pricebook.items.add", target }, sheet, { idempotencyKey: "denied-add" }), /not permitted|permission/i);
  const addedItems = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.items.add", target }, sheet, { idempotencyKey: "add-1" }) as any;
  assert.deepEqual(addedItems.value.added.map((entry: any) => entry.item_id), ["ps-26-ga-standing-seam-panel-charcoal"]);
  assert.deepEqual(addedItems.value.matched.map((entry: any) => [entry.item_id, entry.after]), [["lib-shingle-gaf-uhdz", 50]], "matched by name, not added twice");
  const panel = (await (await import("../pricebook/storage.js")).getOrganizationPricebook(ORG)).catalog.items.find((item: any) => item.id === "ps-26-ga-standing-seam-panel-charcoal") as any;
  assert.deepEqual([panel.internal_cost, panel.unit_price, panel.unit, panel.type, panel.metadata.quantity, keysOf(panel).length], [412, 412, "sq", "Standing seam metal", "entered_by_hand", 0], "a cost, never a markup, entered by hand on each job");
  const rerun = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.setup.apply", target }, { trade: "roofing", roof_types: ["metal"], default_material: "metal_standing_seam" }, { idempotencyKey: "setup-metal" }) as any;
  assert.ok(rerun.value.item_ids.includes("ps-26-ga-standing-seam-panel-charcoal"), "items added from a sheet are part of what was set up");
  assert.ok(!rerun.value.item_ids.some((id: string) => id.startsWith("lib-shingle")), "a metal-only setup lists no shingles");
  assert.equal(rerun.value.default_material, "metal_standing_seam");
});

test("a shingle that shows its starter course makes the starter rule buy the coloured starter", async () => {
  const roofing = await import("../pricebook/setups/roofing.js"), d = await import("../materials/measurement-defaults.js");
  const research = roofing.readResearchCatalog()!;
  const gaf = research.brands.find((brand) => brand.id === "gaf")!;
  assert.equal(gaf.lines.find((line) => line.id === "lib-shingle-gaf-grand-sequoia")!.reveals_starter, true);
  assert.equal(gaf.lines.find((line) => line.id === "lib-shingle-gaf-hdz")!.reveals_starter, false);
  assert.deepEqual([...new Set(research.brands.flatMap((brand) => brand.lines).map((line) => line.visibility))].sort(), ["default", "more", "visible"], "every line has a tier");
  const built = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], defaults: { shingle: "lib-shingle-gaf-grand-sequoia" },
    rules: { coil_nails: { source: "hand" }, starter: { waste: 0, coverage: 100 } } }), d.industryMeasurementDefaults());
  const ids = built.items.map((item) => item.id);
  assert.ok(ids.includes("lib-starter-gaf-startermatch"), "the coloured starter is in the price book");
  assert.deepEqual((built.items.find((item) => item.id === "lib-shingle-gaf-grand-sequoia") as any).attributes, { reveals_starter: true });
  const settings = d.parseMeasurementDefaults(built.settings);
  const starter = settings.materials.rules.find((rule) => rule.key === "starter")!;
  assert.equal(starter.product_id, "lib-starter-gaf-prostart");
  assert.deepEqual(starter.alternatives.map((entry) => [entry.when, entry.product_id]), [[{ rule: "shingles", attribute: "reveals_starter", equals: true }, "lib-starter-gaf-startermatch"]]);
  assert.equal(starter.waste, 0); assert.equal(starter.package?.coverage, 100, "the person's coverage");
  assert.equal(settings.materials.rules.find((rule) => rule.key === "coil_nails")!.enabled, false, "entered by hand");
  // The calculation reads the shingle's attribute: Grand Sequoia buys StarterMatch; HDZ buys Pro-Start.
  const items = built.items.map((item: any) => ({ id: item.id, name: item.name, type: item.type, unit: item.unit, cost: item.internal_cost, attributes: item.attributes || {} }));
  const pick = (defaultLine: string) => { const copy = structuredClone(settings); copy.materials.rules.find((rule) => rule.key === "shingles")!.product_id = defaultLine; return d.measurementDefaultsCalculus(copy, items).defaults.rules.find((rule: any) => rule.key === "starter")!.product!.id; };
  assert.equal(pick("lib-shingle-gaf-grand-sequoia"), "lib-starter-gaf-startermatch");
  assert.equal(pick("lib-shingle-gaf-hdz"), "lib-starter-gaf-prostart");
  const broken = structuredClone(settings); broken.materials.rules.find((rule) => rule.key === "starter")!.alternatives[0]!.when.rule = "nothing";
  assert.throws(() => d.parseMeasurementDefaults(broken), /not another rule/);
});

test("the suppliers step saves each supplier through its own writer, and a price sheet sets that supplier's costs", async () => {
  const roofing = await import("../pricebook/setups/roofing.js");
  const presets = roofing.roofingSupplierPresets();
  for (const id of ["abc_supply", "srs", "beacon", "home_depot", "lowes", "gulfeagle", "convoy_supply"]) assert.ok(presets.some((preset) => preset.id === id), `${id} is offered`);
  const depot = presets.find((preset) => preset.id === "home_depot")!;
  assert.equal(depot.color, "#F96302");
  assert.equal(depot.line_scope, "retail_core");
  assert.ok(Object.keys(depot.prices).length > 0, "observed shelf prices come with it");
  assert.ok(roofing.roofingSetupOptions("TX").suppliers.length >= 7);

  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const { listSuppliers } = await import("../materials/suppliers.js");
  const target = { scope: "organization" as const, organizationId: ORG };
  const base = { trade: "roofing", brands: ["gaf"], defaults: { shingle: "lib-shingle-gaf-uhdz" } };
  const done = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.setup.apply", target }, { ...base,
    suppliers: [{ preset: "home_depot", name: "The Home Depot", item_ids: ["lib-shingle-gaf-hdz", "lib-shingle-gaf-uhdz"], prices: { "lib-shingle-gaf-hdz": 40.5 } }, { name: "Smith Roofing Supply", item_ids: [] }] }, { idempotencyKey: "setup-suppliers-1" }) as any;
  assert.equal(done.value.suppliers.length, 2);
  let suppliers = await listSuppliers(ORG);
  const homeDepot = suppliers.find((supplier) => supplier.name === "The Home Depot")!;
  assert.deepEqual(homeDepot.offerings.map((row) => row.item_id).sort(), ["lib-shingle-gaf-hdz", "lib-shingle-gaf-uhdz"]);
  assert.equal(homeDepot.offerings.find((row) => row.item_id === "lib-shingle-gaf-hdz")!.price_cents, 4050, "a typed cost, in cents, not marked up");
  assert.deepEqual(suppliers.find((supplier) => supplier.name === "Smith Roofing Supply")!.offerings, [], "a typed supplier starts empty");
  // The cost typed in a supplier's column is the price book cost (the prices step is gone): cost and sell, no markup.
  const book = (await (await import("../pricebook/storage.js")).getOrganizationPricebook(ORG)).catalog.items.find((item: any) => item.id === "lib-shingle-gaf-hdz") as any;
  assert.equal(book.internal_cost, 40.5);
  assert.equal(book.unit_price, 40.5);
  // Typed beats the price seen at a supplier, the first chosen supplier wins, and an item price typed on its own wins over both.
  const costs = roofing.supplierItemCosts(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], suppliers: [
    { preset: "p1", name: "One", item_ids: ["a", "b", "c"], prices: { a: 10 } }, { preset: "p2", name: "Two", item_ids: ["a", "b", "d"], prices: { b: 20 } }] }),
    [{ id: "p1", name: "One", kind: "distributor", color: "#000", manufacturers: [], line_scope: "full_range", regions: "", prices: { b: 15, c: 30 } }, { id: "p2", name: "Two", kind: "distributor", color: "#000", manufacturers: [], line_scope: "full_range", regions: "", prices: { d: 40, a: 1 } }]);
  assert.deepEqual(costs, { a: 10, b: 20, c: 30, d: 40 });

  // The agent reads the Home Depot sheet: that supplier's costs only.
  const sheet = { supplier_id: homeDepot.id, prices: [{ item_id: "lib-shingle-gaf-uhdz", price_cents: 5555, sku: "HD-UHDZ" }] };
  await assert.rejects(async () => invokeAction(userPublicationContext(crew, { mode: "command" }), { action: "suppliers.prices.update", target }, sheet, { idempotencyKey: "denied-supplier-prices" }), /not permitted|permission/i);
  const updated = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "suppliers.prices.update", target }, sheet, { idempotencyKey: "supplier-prices-1" }) as any;
  assert.deepEqual(updated.value.changed[0].after, 5555);

  // Finishing the setup again keeps the sheet's cost, and an unticked item leaves that supplier.
  await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.setup.apply", target }, { ...base,
    suppliers: [{ preset: "home_depot", name: "The Home Depot", item_ids: ["lib-shingle-gaf-uhdz"], prices: {} }] }, { idempotencyKey: "setup-suppliers-2" });
  suppliers = await listSuppliers(ORG);
  const again = suppliers.filter((supplier) => supplier.name === "The Home Depot");
  assert.equal(again.length, 1, "merged with the saved supplier, not duplicated");
  assert.deepEqual(again[0]!.offerings.map((row) => [row.item_id, row.price_cents, row.sku]), [["lib-shingle-gaf-uhdz", 5555, "HD-UHDZ"]]);
});
