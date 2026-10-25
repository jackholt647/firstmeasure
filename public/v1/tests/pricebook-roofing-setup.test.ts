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
  const duration = research!.brands.find((brand) => brand.id === "owens_corning")!.lines.find((line) => line.id === "lib-shingle-oc-duration")!;
  assert.equal(Math.round(duration.coverage * 1000) / 1000, 0.328, "an Owens Corning bundle covers 32.8 sq ft, not a flat third of a square");
  const weatherwatch = research!.brands.find((brand) => brand.id === "gaf")!.accessories.find((entry) => entry.id === "lib-iws-gaf-weatherwatch")!;
  assert.equal(weatherwatch.coverage, 2, "a WeatherWatch roll's own coverage, 200 sq ft");
  assert.ok(research!.regions.some((region) => region.id === "northeast" && region.states.includes("NY")));
  // Logos are site paths under public/images; anything else is dropped and the card shows the wordmark.
  assert.equal(roofing.logoPath("public/images/brands/roofing/gaf.svg"), "/images/brands/roofing/gaf.svg");
  assert.equal(roofing.logoPath({ src: "images/brands/roofing/iko.png" }), "/images/brands/roofing/iko.png");
  assert.equal(roofing.logoPath("javascript:alert(1)"), "");
  assert.equal(roofing.logoPath("images/brands/roofing/gaf.exe"), "");
  const options = roofing.roofingSetupOptions("TX");
  assert.deepEqual(options.brands.slice(0, 4).map((brand: any) => brand.id), ["gaf", "owens_corning", "malarkey", "certainteed"], "the four most installed first, any others after");
  const library = roofing.readResearchCatalog(path.join(dir, "missing.json"));
  assert.equal(library, null);
  assert.ok(roofing.libraryCatalog().brands.length >= 3, "without the research file the library still offers brands");
});

test("selections become price book items whose formulas use only dictionary keys, and defaults that name them", async () => {
  const roofing = await import("../pricebook/setups/roofing.js"), { definitionForKey, listMeasurementDefinitions } = await import("../platform/publication/measurement-schemas.js");
  const d = await import("../materials/measurement-defaults.js");
  const selections = roofing.roofingSelectionsSchema.parse({ brands: ["owens_corning", "gaf"], lines: ["lib-shingle-oc-duration", "lib-shingle-gaf-hdz", "lib-shingle-oc-oakridge"], default_line: "lib-shingle-oc-duration", ice_eave_width: 3, waste: 15, state: "NY", prices: { "lib-shingle-gaf-hdz": 60 } });
  const built = roofing.buildRoofingSetup(selections, d.industryMeasurementDefaults());
  const ids = built.items.map((item) => item.id);
  assert.equal(built.primary_brand, "owens_corning", "accessories follow the default shingle's brand");
  assert.equal(built.region.id, "northeast");
  for (const id of ["lib-shingle-oc-duration", "lib-shingle-gaf-hdz", "lib-shingle-oc-oakridge", "lib-starter-oc-starter-strip", "lib-ridge-oc-proedge", "lib-iws-oc-weatherlock-g", "lib-drip-edge-alum-white", "lib-pipe-boot-1.5-3", "labor-tearoff-layer1"]) assert.ok(ids.includes(id), `${id} is written`);
  assert.ok(!ids.includes("lib-starter-gaf-prostart"), "the other brand's accessories are not");
  for (const item of built.items) for (const key of keysOf(item)) assert.ok(definitionForKey(key), `${item.id} reads ${key}, a dictionary key`);
  assert.ok(built.items.every((item) => !keysOf(item).includes("shingleSquares")), "shingleSquares is not a dictionary key");
  const duration = built.items.find((item) => item.id === "lib-shingle-oc-duration")! as any;
  assert.deepEqual(duration.formulaConfig.tokens.map((token: any) => token.value).join(" "), "( roofSquares - flatRoofSquares ) / 0.328");
  assert.equal(duration.formulaConfig.includeWaste, true);
  const ice = built.items.find((item) => item.id === "lib-iws-oc-weatherlock-g")! as any;
  assert.equal(ice.formulaConfig.tokens.map((token: any) => token.value).join(" "), "( ( eavesLf * 3 + valleyLf * 3 ) / 100 + pitch2to4Squares ) / 2", "the company's eave width; the roll's own coverage");
  const boots = built.items.find((item) => item.id === "lib-pipe-boot-1.5-3")! as any;
  assert.equal(boots.formulaConfig, undefined, "pipe boots are not in the dictionary, so they are entered by hand");
  assert.equal(boots.metadata.quantity, "entered_by_hand");
  assert.equal(built.items.find((item) => item.id === "lib-shingle-gaf-hdz")!.unit_price, 60, "a typed price wins");
  assert.ok(built.items.find((item) => item.id === "lib-shingle-oc-oakridge")!.unit_price > 40 * 1.35, "materials are priced for the Northeast");

  const settings = d.parseMeasurementDefaults(built.settings);
  const known = new Set(listMeasurementDefinitions().map((definition) => definition.id));
  for (const rule of settings.materials.rules) for (const term of rule.terms) assert.ok(known.has(term.measurement), `${rule.key} reads ${term.measurement}`);
  const rule = (key: string) => settings.materials.rules.find((entry) => entry.key === key)!;
  assert.equal(rule("shingles").product_id, "lib-shingle-oc-duration");
  assert.equal(rule("shingles").waste, 15);
  assert.deepEqual(rule("shingles").package, { unit: "bundle", coverage: 0.328 });
  assert.equal(rule("starter").product_id, "lib-starter-oc-starter-strip");
  assert.equal(rule("starter").package?.coverage, 105, "Owens Corning starter runs 105 ft a bundle");
  assert.deepEqual(rule("ice_water").terms, [{ measurement: "roof.eave_length", factor: 1 }, { measurement: "roof.valley_length", factor: 1 }], "one 3 ft row at the eaves");
  for (const entry of settings.materials.rules.filter((r) => r.enabled && r.product_id)) assert.ok(ids.includes(entry.product_id) || !entry.product_id.startsWith("lib-"), `${entry.key} names a written product`);

  const none = roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], lines: ["lib-shingle-gaf-hdz"], ice_eave_width: 0, include_labor: false }), d.industryMeasurementDefaults());
  assert.deepEqual(none.settings.materials.rules.find((entry) => entry.key === "ice_water")!.terms, [{ measurement: "roof.valley_length", factor: 1 }]);
  assert.ok(!none.items.some((item) => item.id.startsWith("labor-")), "labor can be left out");
  assert.throws(() => roofing.buildRoofingSetup(roofing.roofingSelectionsSchema.parse({ brands: ["gaf"], lines: ["lib-shingle-oc-duration"] }), d.industryMeasurementDefaults()), /at least one shingle line/);
});

test("the published action writes through the price book and defaults writers, as the person", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Setup Roofing" });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true, "platform.pricebook": true });
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const { invokeAction, describeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  assert.ok(describeAction("pricebook.setup.apply")?.executionKinds.includes("agent"));
  assert.ok(describeAction("materials.project.generate")?.executionKinds.includes("agent"), "an agent can press Generate");
  const target = { scope: "organization" as const, organizationId: ORG };
  const input = { trade: "roofing", brands: ["gaf"], lines: ["lib-shingle-gaf-hdz", "lib-shingle-gaf-uhdz"], default_line: "lib-shingle-gaf-uhdz" };
  await assert.rejects(async () => invokeAction(userPublicationContext(crew, { mode: "command" }), { action: "pricebook.setup.apply", target }, input, { idempotencyKey: "denied" }), /not permitted|permission/i);
  const done = await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "pricebook.setup.apply", target }, input, { idempotencyKey: "setup-1" }) as any;
  assert.equal(done.value.default_line, "lib-shingle-gaf-uhdz");
  const book = await (await import("../pricebook/storage.js")).getOrganizationPricebook(ORG);
  const uhdz = book.catalog.items.find((item: any) => item.id === "lib-shingle-gaf-uhdz") as any;
  assert.ok(uhdz?.formulaConfig?.tokens?.length, "the line is in the price book with its formula");
  assert.equal(uhdz.metadata.setup, "pricebook.roofing");
  assert.ok(book.catalog.items.some((item: any) => item.id === "roof_replacement"), "items the organization already had are kept");
  const defaults = await (await import("../materials/measurement-defaults.js")).readMeasurementDefaults(ORG);
  assert.equal(defaults.stored, true);
  assert.equal(defaults.settings.materials.rules.find((rule) => rule.key === "shingles")!.product_id, "lib-shingle-gaf-uhdz");
});
