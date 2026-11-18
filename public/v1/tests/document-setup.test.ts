import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// FM-582: the document setup. The first New document asks which kind of document; a proposal asks the company steps
// still unanswered (type, work, who sells), how proposals are presented, whether the customer may change them, how much
// detail and whether a written scope goes with them, then prices (optional) and one of three styles, previewed. The
// finish makes the kind's own template (tpl_setup_<kind>), its default and its pin. The library entry is the one put on
// dev (tests/fixtures/document-setup-library.json).
const dir = await mkdtemp(path.join(os.tmpdir(), "document-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_document_setup";
const flags = { "platform.documents": true, "platform.materials": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const owner = person("owner");
const library = JSON.parse(await readFile(new URL("./fixtures/document-setup-library.json", import.meta.url), "utf8"));

let ready: Promise<any> | null = null;
function setup() {
  return ready ||= (async () => {
    const storage = await import("../platform/storage.js");
    await storage.createOrganization({ id: ORG, name: "Document setup" }).catch(() => {});
    await enableExpandedPlatformFixture(ORG, flags);
    const { initializePublication } = await import("../platform/publication/bootstrap.js");
    initializePublication();
    const { registerSetupStepForTests } = await import("../guided-experiences/setup-steps.js");
    for (const step of library.setup_step) registerSetupStepForTests(step);
    const { registerExperienceForTests } = await import("../guided-experiences/registry.js");
    for (const experience of library.guided_experience) registerExperienceForTests(experience);
    const service = await import("../guided-experiences/service.js");
    service.ensureGuidedDefinitions();
    return service;
  })();
}
const target = { scope: "organization", organizationId: ORG } as const;
const invoke = async (auth: any, action: string, input: Record<string, unknown>, key: string) => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return ((await invokeAction(userPublicationContext(auth, { mode: "command" }), { action, target }, input, { idempotencyKey: key })) as any).value;
};
const value = async (auth: any, provider: string, exported: string, args?: Record<string, unknown>) => {
  const { readPublishedData } = await import("../platform/publication/providers.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const result = await readPublishedData(userPublicationContext(auth), { provider, export: exported, target, ...(args ? { args } : {}) }) as any;
  assert.equal(result.status ?? "ready", "ready", JSON.stringify(result).slice(0, 400));
  return result.value ?? result;
};
const ids = (experience: any) => experience.steps.map((step: any) => step.id);
const proposal = { document_kind: "proposal", presentation: "single", customer_changes: "ask", detail: "itemized", scope_write_up: false };

test("the library entry parses, and its checks pass against the running code", async () => {
  await setup();
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const { guidedExperienceKind } = await import("../config-library/kinds/guided_experience.js");
  const { registryChecks } = await import("../config-library/registries.js");
  const registries = registryChecks();
  const notInSnapshot = (error: string) => !/which is not a setup step/.test(error);
  for (const experience of library.guided_experience) {
    assert.equal(experienceSchema.safeParse(experience).success, true, experience.id);
    assert.deepEqual(guidedExperienceKind.validate!(experienceSchema.parse(experience), { id: experience.id, registries } as any).filter(notInSnapshot), [], experience.id);
  }
  const experience = library.guided_experience.find((entry: any) => entry.id === "documents.setup");
  assert.deepEqual(experience.triggers.map((trigger: any) => trigger.kind), ["before_action", "manual"]);
  for (const selector of ['[data-gallery-toolbar-action="new_document"]', "[data-fmdx-new]", "[data-fmdx-empty-new]"]) assert.ok(experience.triggers[0].selector.includes(selector), `New document ${selector} plays it`);
  assert.deepEqual(experience.completion.then, [{ resume: true }], "the New document dialog opens after it");
  assert.equal(experience.completion.action.id, "documents.setup.apply");
});

test("a proposal asks the unanswered company steps first; another kind goes straight to its style", async () => {
  const service = await setup();
  const setupOf = async () => (await service.availableExperiences(owner, { tab: "project.docs" })).experiences.find((entry: any) => entry.id === "documents.setup");
  assert.deepEqual(ids(await setupOf()), ["kind", "company.type", "company.services", "company.sales_team", "presentation", "changes", "detail", "scope", "prices", "style", "copy", "first"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement"], sales_team: "just_me" }, "profile-1");
  assert.deepEqual(ids(await setupOf()), ["kind", "presentation", "changes", "detail", "scope", "prices", "style", "copy", "first"], "answered by scheduling or another setup: not asked again");
  const definition = library.guided_experience.find((entry: any) => entry.id === "documents.setup");
  const variant = definition.variants[0];
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const parsed = experienceSchema.parse(definition);
  assert.equal(service.nextStep(parsed, variant, "kind", { document_kind: "proposal" }), "presentation");
  for (const kind of ["invoice", "change_order", "completion_certificate"]) assert.equal(service.nextStep(parsed, variant, "kind", { document_kind: kind }), "style", kind);
  assert.equal(service.nextStep(parsed, variant, "style", { document_kind: "invoice" }), "copy", "every kind reads its wording after its style");
  assert.equal(service.nextStep(parsed, variant, "copy", { document_kind: "invoice" }), "first", "the first proposal step finishes at once for another kind");
  const member = person("member", { role: "member", permissions: { view_projects: true } });
  assert.equal((await service.availableExperiences(member, { tab: "project.docs" })).experiences.some((entry: any) => entry.id === "documents.setup"), false, "only someone who manages company settings sets it up");
});

test("the answers choose and adapt a template", async () => {
  const { planDocument } = await import("../documents/setup.js");
  assert.equal(planDocument({ ...proposal, presentation: "options", customer_changes: "pick" } as any).base, "tpl_instant_roofing_options");
  const itemized = planDocument(proposal as any);
  assert.deepEqual([itemized.base, itemized.params, itemized.drop_steps], ["tpl_instant_roofing_detailed", { show_line_prices: true }, ["details", "choose"]]);
  const broadWithScope = planDocument({ ...proposal, detail: "rough", scope_write_up: true, customer_changes: "mix" } as any);
  assert.deepEqual([broadWithScope.base, broadWithScope.params, broadWithScope.drop_steps], ["tpl_instant_roofing_detailed", { show_line_prices: false }, []], "a broad estimate with a written scope: the lines without their prices, and the photos step");
  assert.equal(planDocument({ ...proposal, detail: "rough" } as any).base, "tpl_instant_roofing_onepage", "a broad estimate on its own: one page");
  assert.equal(planDocument({ document_kind: "invoice" } as any).base, "tpl_invoice_default");
});

test("the style step previews what the answers make in three styles, saving nothing", async () => {
  await setup();
  const { listDocumentTemplates } = await import("../documents/storage.js");
  // The organization's copies of the library's defaults are made as on any documents read; past that nothing is saved.
  await (await import("../documents/library-copies.js")).ensureDefaultDocumentAssets(ORG);
  const before = (await listDocumentTemplates(ORG)).map((template: any) => template.id).sort();
  const previews = await value(owner, "document-setup", "previews", { ...proposal, presentation: "options", customer_changes: "pick" });
  assert.equal(previews.base, "tpl_instant_roofing_options");
  assert.deepEqual(previews.previews.map((entry: any) => entry.theme_id), ["thm_clean", "thm_margin", "thm_triangles"]);
  for (const entry of previews.previews) {
    assert.ok(Array.isArray(entry.resolved_definition.pages) && entry.resolved_definition.pages.length > 0, entry.theme_id);
    assert.ok(Object.keys(entry.theme).length > 0, `${entry.theme_id} has its theme`);
  }
  const text = JSON.stringify(previews.previews[0].resolved_definition);
  assert.ok(text.includes("Jordan Sample"), "the sample customer is in the preview");
  assert.ok(text.includes("Good") && text.includes("Better") && text.includes("Architectural shingles"), "the sample options and the chosen one's lines are in the preview");
  assert.ok(!/\{\{\s*params\.(customer|project)/.test(text), "the sample customer's bindings are resolved");
  assert.notDeepEqual(previews.previews[0].theme, previews.previews[2].theme, "the styles differ");
  const invoice = await value(owner, "document-setup", "previews", { document_kind: "invoice" });
  assert.equal(invoice.previews.length, 3);
  assert.deepEqual((await listDocumentTemplates(ORG)).map((template: any) => template.id).sort(), before, "a preview saves nothing");
});

test("the finish makes the kind's own default template, its workflow, its pin and the prices", async () => {
  await setup();
  const sheet = await value(owner, "document-setup", "price_sheet");
  assert.ok(sheet.items.some((item: any) => item.id === "tearoff"), "the price step asks for the roof's parts");
  const applied = await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_triangles", prices: [{ item_id: "tearoff", unit_price: 95 }, { item_id: "gaf_hd", unit_price: 150 }] }, "apply-1");
  assert.equal(applied.template_id, "tpl_setup_proposal");
  assert.equal(applied.prices_updated, 2);
  const storage = await import("../documents/storage.js");
  const template: any = await storage.readDocumentTemplate(ORG, "tpl_setup_proposal");
  assert.equal(template.document_type, "proposal");
  assert.equal(template.status, "active");
  assert.equal(template.metadata.default_for_type, true);
  assert.equal(template.metadata.preset, false, "the organization's own, never upgraded or retired by the library");
  assert.equal(template.metadata.library, undefined);
  assert.equal(template.metadata.default_workflow_id, "wfl_setup_proposal");
  const version: any = await storage.readDocumentTemplateVersion(ORG, "tpl_setup_proposal");
  assert.deepEqual(version!.definition.theme_ref, { theme_id: "thm_triangles" });
  assert.equal(version!.definition.params.show_line_prices.default, true);
  const workflow: any = await storage.readDocumentWorkflowVersion(ORG, "wfl_setup_proposal");
  const steps = workflow!.definition.steps.map((step: any) => step.id);
  assert.ok(!steps.includes("details") && !steps.includes("choose"), `no written scope and no customer changes: ${steps}`);
  assert.ok(!JSON.stringify(workflow!.definition).includes("\"tpl_instant_roofing_detailed\""), "the workflow previews the organization's template");
  const { getOrganizationPricebook } = await import("../pricebook/storage.js");
  const items = new Map((await getOrganizationPricebook(ORG)).catalog.items.map((item: any) => [item.id, item]));
  assert.equal(items.get("tearoff")!.unit_price, 95);
  assert.equal(items.get("gaf_hd")!.unit_price, 150);
  const { readPinnedTemplateIds } = await import("../documents/settings.js");
  const pins = (await readPinnedTemplateIds(ORG))!;
  assert.ok(pins.includes("tpl_setup_proposal"), `pinned: ${pins}`);
  const typeOf = new Map((await storage.listDocumentTemplates(ORG)).map((entry: any) => [entry.id, entry.document_type]));
  assert.equal(pins.filter((id) => typeOf.get(id) === "proposal").length, 1, "it replaces the proposal pin");
  // New document with no template named starts from it.
  const others = (await storage.listDocumentTemplates(ORG, { document_type: "proposal" })).filter((entry: any) => entry.id !== "tpl_setup_proposal");
  assert.ok(others.every((entry: any) => entry.metadata.default_for_type !== true));
  const status = await value(owner, "document-setup", "status");
  assert.equal(status.answered.proposal, true);
  assert.equal(status.kinds.proposal.theme_id, "thm_triangles");
  // The first proposal style is the organization's style for new documents (FM-612).
  const { readDefaultDocumentThemeId } = await import("../documents/settings.js");
  assert.equal(status.default_theme_id, "thm_triangles");
  assert.equal(await readDefaultDocumentThemeId(ORG), "thm_triangles");

  // Again with other answers: the same template, a new version; options to choose from.
  await invoke(owner, "documents.setup.apply", { ...proposal, presentation: "options", customer_changes: "mix", theme_id: "thm_clean" }, "apply-2");
  const again: any = await storage.readDocumentTemplate(ORG, "tpl_setup_proposal");
  assert.equal(Number(again.current_version), 2);
  assert.equal(again.metadata.document_setup.based_on, "tpl_instant_roofing_options");
  assert.equal((await storage.listDocumentTemplates(ORG, { document_type: "proposal" })).filter((entry: any) => entry.id.startsWith("tpl_setup_")).length, 1);
  assert.equal(await readDefaultDocumentThemeId(ORG), "thm_triangles", "only the first proposal style sets the style for new documents");

  // Another kind takes only a style.
  const invoice = await invoke(owner, "documents.setup.apply", { document_kind: "invoice", theme_id: "thm_margin" }, "apply-invoice");
  assert.equal(invoice.template_id, "tpl_setup_invoice");
  assert.deepEqual(((await storage.readDocumentTemplateVersion(ORG, "tpl_setup_invoice")) as any).definition.theme_ref, { theme_id: "thm_margin" });
  assert.equal((await value(owner, "document-setup", "status")).default_theme_id, "thm_triangles", "another kind's style leaves it");

  await assert.rejects(() => invoke(owner, "documents.setup.apply", { document_kind: "proposal", theme_id: "thm_clean" }, "apply-bad"), /how you write proposals/);
  const member = person("member", { role: "member", permissions: { view_projects: true } });
  await assert.rejects(() => invoke(member, "documents.setup.apply", { document_kind: "invoice", theme_id: "thm_clean" }, "apply-member"));
});

test("the price step's lines: the proposal's assembly, turned off, added from the price book and new (FM-610)", async () => {
  await setup();
  const sheet = await value(owner, "document-setup", "price_sheet");
  assert.equal(sheet.editable, true);
  const on = sheet.items.filter((item: any) => item.on).map((item: any) => item.id);
  assert.ok(on.includes("tearoff") && on.includes("laminated_shingles"), `the roof replacement's lines are on: ${on}`);
  assert.ok(sheet.items.some((item: any) => item.id === "ice_water" && !item.on), "a main item the proposal lacks is listed, off");
  assert.equal(sheet.items.find((item: any) => item.id === "starter").formula.includes("Eaves"), true, "each line says what its quantity comes from");
  assert.ok(sheet.catalog.some((item: any) => item.id === "chimney_flashing"), "the rest of the price book is offered");
  assert.ok(!sheet.catalog.some((item: any) => item.id === "tearoff" || item.id === "roof_replacement"), "but not the lines or the assembly");
  assert.ok(sheet.measurements.some((field: any) => field.key === "eavesLf") && !sheet.measurements.some((field: any) => field.key === "wastePercent"));

  // Off: tear-off and architectural shingles (the shingle choice's picked one); on: ice & water, chimney flashing and a new line.
  const keep = on.filter((id: string) => id !== "tearoff" && id !== "laminated_shingles");
  const lines = { on: [...keep, "ice_water", "chimney_flashing", "new_a"], new_items: [{ key: "new_a", name: "Haul-away fee", unit: "sq", unit_price: 12.5, formula: [{ type: "measurement", value: "roofSquares" }, { type: "operator", value: "*" }, { type: "number", value: "1.1" }], include_waste: false }] };
  const applied = await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_clean", lines }, "lines-1");
  assert.equal(applied.lines_added, 1);
  assert.equal(applied.lines_changed, true);
  const { getOrganizationPricebook } = await import("../pricebook/storage.js");
  const items = new Map((await getOrganizationPricebook(ORG)).catalog.items.map((item: any) => [item.id, item]));
  const assembly: any = items.get("roof_replacement");
  const refs = assembly.components.map((component: any) => component.item_ref);
  assert.ok(!refs.includes("tearoff") && !refs.includes("laminated_shingles"), `turned off: ${refs}`);
  assert.ok(refs.includes("ice_water") && refs.includes("chimney_flashing"), `turned on: ${refs}`);
  const added: any = [...items.values()].find((item: any) => item.name === "Haul-away fee");
  assert.ok(added && refs.includes(added.id), "the new line is an item and on the proposal");
  assert.equal(added.unit, "sq");
  assert.equal(added.unit_price, 12.5);
  assert.deepEqual(added.formulaConfig.tokens.map((token: any) => token.value), ["roofSquares", "*", "1.1"]);
  const shingles = assembly.components.filter((component: any) => component.selection?.group_id === "shingle_profile");
  assert.ok(shingles.length && shingles[0].selection.selected === true, "the shingle choice still has one picked");
  const again = await value(owner, "document-setup", "price_sheet");
  assert.ok(again.items.find((item: any) => item.id === "tearoff" && !item.on), "a line turned off stays listed, off");

  await assert.rejects(() => invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_clean", lines: { on: ["new_b"], new_items: [{ key: "new_b", name: "Bad", unit: "ea", unit_price: 1, formula: [{ type: "measurement", value: "roofSquares" }, { type: "operator", value: "+" }] }] } }, "lines-bad"), /complete expression/);
  await assert.rejects(() => invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_clean", lines: { on: ["no_such_item"] } }, "lines-unknown"), /not in the price book/);
});

test("an estimate's lines are kept to known items, sound formulas and one line each (FM-610)", async () => {
  const { cleanLines } = await import("../documents/setup-estimate.js");
  const lines = cleanLines([
    { name: "Tear off", unit: "sq", unit_price: 90, item_id: "tearoff", formula: null },
    { name: "Tear off again", unit: "sq", unit_price: 91, item_id: "tearoff", formula: null },
    { name: "Invented", unit: "lf", unit_price: 3.333, item_id: "made_up", formula: [{ type: "measurement", value: "eavesLf" }] },
    { name: "Broken formula", unit: "furlong", unit_price: 5, item_id: null, formula: [{ type: "measurement", value: "nope" }] },
    { name: "", unit: "ea", unit_price: 5, item_id: null, formula: null },
    { name: "Negative", unit: "ea", unit_price: -5, item_id: null, formula: null }
  ], new Set(["tearoff"]));
  assert.deepEqual(lines, [
    { name: "Tear off", unit: "sq", unit_price: 90, item_id: "tearoff", formula: null },
    { name: "Invented", unit: "lf", unit_price: 3.33, item_id: null, formula: [{ type: "measurement", value: "eavesLf" }] },
    { name: "Broken formula", unit: "ea", unit_price: 5, item_id: null, formula: null }
  ]);
});

test("the copy step reads the template's wording, the finish saves the changes, and Advanced edits are kept (FM-614)", async () => {
  await setup();
  const storage = await import("../documents/storage.js");
  const before = (await storage.listDocumentTemplates(ORG)).map((template: any) => template.id).sort();
  const copy = await value(owner, "document-setup", "copy", { ...proposal, theme_id: "thm_margin" });
  assert.equal(copy.template_id, "tpl_setup_proposal");
  assert.deepEqual((await storage.listDocumentTemplates(ORG)).map((template: any) => template.id).sort(), before, "reading the copy saves nothing");
  const fields = copy.fields;
  assert.equal(fields[0].role, "title", "the first heading is the title");
  assert.ok(fields.some((field: any) => field.role === "text" && field.text.length >= 40), "the opening and the terms are there");
  assert.ok(fields.every((field: any) => !/Jordan Sample|\{\{/.test(field.text)), "nothing filled in per customer is copy");
  assert.ok(JSON.stringify(copy.preview.resolved_definition).includes("Jordan Sample"), "the preview is the sample document");
  const terms = fields.filter((field: any) => field.role === "text").at(-1);

  // The finish saves the wording into the template; a paragraph break makes two paragraphs in the same style.
  await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_margin", copy: { [fields[0].node_id]: "Your new roof", [terms.node_id]: "Valid for 60 days.\n\nDeposit due at signing." } }, "copy-apply-1");
  const node = (definition: any, id: string) => { let found: any = null; const walk = (list: any[]) => { for (const entry of list || []) { if (entry.id === id) found = entry; walk(entry.children); } }; for (const page of definition.pages) walk(page.children); return found; };
  let version: any = await storage.readDocumentTemplateVersion(ORG, "tpl_setup_proposal");
  assert.equal(node(version.definition, fields[0].node_id).props.blocks[0].runs[0].text, "Your new roof");
  assert.ok(/^h[1-3]$/.test(node(version.definition, fields[0].node_id).props.blocks[0].style_ref), "the title keeps its heading style");
  assert.deepEqual(node(version.definition, terms.node_id).props.blocks.map((block: any) => block.runs[0].text), ["Valid for 60 days.", "Deposit due at signing."]);
  const published = Number((await storage.readDocumentTemplate(ORG, "tpl_setup_proposal") as any).current_version);

  // Finishing again with the same answers and wording (the first proposal step saved it first) adds no version.
  await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_margin", copy: { [fields[0].node_id]: "Your new roof", [terms.node_id]: "Valid for 60 days.\n\nDeposit due at signing." } }, "copy-apply-2");
  assert.equal(Number((await storage.readDocumentTemplate(ORG, "tpl_setup_proposal") as any).current_version), published);

  // Advanced: they publish their own change in the template editor; the copy step and the finish start from it.
  const edited = structuredClone(version.definition);
  node(edited, terms.node_id).props.blocks = [{ ...node(edited, terms.node_id).props.blocks[0], runs: [{ text: "Terms written in the template editor, long enough to be copy." }] }];
  await storage.publishDocumentTemplate(ORG, "tpl_setup_proposal", { definition: edited, expected_version: published }, owner);
  const again = await value(owner, "document-setup", "copy", { ...proposal, theme_id: "thm_margin", keep_edits: true });
  assert.equal(again.edited, true);
  assert.equal(again.fields.find((field: any) => field.node_id === terms.node_id).text, "Terms written in the template editor, long enough to be copy.");
  assert.equal(again.fields[0].text, "Your new roof");
  await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_clean", keep_edits: true, copy: { [fields[0].node_id]: "Our roof proposal" } }, "copy-apply-3");
  version = await storage.readDocumentTemplateVersion(ORG, "tpl_setup_proposal");
  assert.equal(node(version.definition, terms.node_id).props.blocks[0].runs[0].text, "Terms written in the template editor, long enough to be copy.", "the editor's change is kept");
  assert.equal(node(version.definition, fields[0].node_id).props.blocks[0].runs[0].text, "Our roof proposal");
  assert.deepEqual(version.definition.theme_ref, { theme_id: "thm_clean" }, "a style chosen after is applied over it");
  // Without keep_edits the answers make the template again from the library.
  await invoke(owner, "documents.setup.apply", { ...proposal, theme_id: "thm_clean" }, "copy-apply-4");
  version = await storage.readDocumentTemplateVersion(ORG, "tpl_setup_proposal");
  assert.equal(node(version.definition, terms.node_id).props.blocks[0].runs[0].text, terms.text.split("\n\n")[0]);
});
