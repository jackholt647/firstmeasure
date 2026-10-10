import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { scopeItemPriceResult } from "../proposals/scope.js";
import { generatePieceScope } from "../pricebook/scope-generation.js";
import { DEFAULT_PRICEBOOK_TEMPLATE } from "../pricebook/default_template.js";

// The sales documents a roofing organization starts with: what a new
// organization gets, what an existing one loses, and that every price a
// salesperson or a customer sees adds up.

type Line = Record<string, any>;
const book = DEFAULT_PRICEBOOK_TEMPLATE.catalog;
const measurements = { roofSquares: 29.6, wastePercent: 10, eavesLf: 197.25, rakesLf: 208.6, ridgesLf: 93.4, hipsLf: 0, valleyLf: 16.2, sideWallLf: 82.8, headWallLf: 4.5 };
const refId = (line: Line) => String(line.pricebook_ref?.item_id || "");
const ifChosen = (line: Line) => scopeItemPriceResult({ ...line, selection: { ...line.selection, selected: true } }).amount_cents;
const own = (line: Line) => Math.round(Number(line.quantity) * Number(line.unit_price) * 100);

test("gutters are optional lines on a roof proposal, off by default and priced from the gutter measurements", () => {
  const root = generatePieceScope(book, "roof_replacement", { ...measurements, gutterLf: 150, downspoutLf: 40 }) as Line;
  const children = root.children as Line[];
  const gutter = children.find((line) => refId(line) === "gutter_replace")!;
  const downspout = children.find((line) => refId(line) === "downspout")!;
  for (const line of [gutter, downspout]) {
    assert.equal(line.selection.mode, "optional");
    assert.equal(line.selection.selected, false, "an optional line is not in the price until chosen");
    assert.ok(line.selection.selectable_by.includes("customer"));
  }
  assert.equal(gutter.quantity, "150");
  assert.equal(downspout.quantity, "40");
  const before = scopeItemPriceResult(root).amount_cents;
  gutter.selection.selected = true;
  assert.equal(scopeItemPriceResult(root).amount_cents - before, own(gutter), "choosing gutters adds exactly the gutter line");

  // An unmeasured gutter run follows the eaves; unmeasured downspouts are not offered at all.
  const unmeasured = (generatePieceScope(book, "roof_replacement", measurements) as Line).children as Line[];
  assert.equal(unmeasured.find((line) => refId(line) === "gutter_replace")!.quantity, "198", "197.25 ft of eaves, bought as 198");
  assert.ok(!unmeasured.some((line) => refId(line) === "downspout"));
  // Nothing prints at no quantity: this roof has no hips, skylights or chimneys.
  assert.ok(unmeasured.every((line) => line.selection?.mode === "choice" || Number(line.quantity) > 0), "fixed and optional lines measured at zero are left out");
});

test("Good / Better / Best are three complete roofs generated from one set of measurements", () => {
  const root = generatePieceScope(book, "roof_replacement", measurements, "options") as Line;
  const packages = (root.children as Line[]).filter((line) => line.selection?.mode === "choice");
  assert.deepEqual(packages.map((line) => line.name), ["Good", "Better", "Best"]);
  assert.deepEqual([...new Set(packages.map((line) => line.selection.group_id))], ["roof_package"], "one choice group: the customer picks one roof");
  assert.deepEqual(packages.map((line) => line.selection.selected), [false, true, false], "Better is the recommendation");
  assert.deepEqual(packages.map((line) => refId((line.children as Line[])[0]!)), ["gaf_ns", "gaf_hd", "gaf_uhdz"], "each option leads with its shingle");
  assert.deepEqual(packages[2]!.highlights, ["GAF Timberline UHDZ", "GAF Tiger Paw", "GAF WeatherWatch", "Lifetime pipe boots", "GAF Silver Pledge warranty"]);
  for (const option of packages) {
    const lines = option.children as Line[];
    assert.ok(lines.every((line) => line.selection.mode === "fixed" && Number(line.quantity) > 0), `${option.name} is a fixed set of real lines`);
    assert.equal(ifChosen(option), lines.reduce((sum, line) => sum + own(line), 0), `${option.name} costs the sum of its lines`);
    // The same roof under every option: same tear-off, same perimeter.
    assert.equal(lines.find((line) => refId(line) === "tearoff")!.quantity, "30");
    assert.equal(lines.find((line) => refId(line) === "starter")!.quantity, "406");
    assert.equal(lines.filter((line) => ["gaf_ns", "gaf_hd", "gaf_uhdz"].includes(refId(line)))[0]!.quantity, "33", "29.6 squares plus 10% waste, bought as 33");
  }
  const prices = packages.map(ifChosen);
  assert.ok(prices[0]! < prices[1]! && prices[1]! < prices[2]!, "the options climb in price");
  assert.equal(scopeItemPriceResult(root).amount_cents, prices[1], "the proposal prices the selected option only");
  // Picking another option moves the total by the difference between the two.
  packages[1]!.selection.selected = false;
  packages[2]!.selection.selected = true;
  assert.equal(scopeItemPriceResult(root).amount_cents, prices[2]);
  assert.throws(() => generatePieceScope(book, "roof_replacement", measurements, "platinum"), /not available/);
});

test("a gutter job stands on its own", () => {
  const root = generatePieceScope(book, "gutters", { gutterLf: 180, downspoutLf: 60 }) as Line;
  const children = root.children as Line[];
  assert.deepEqual(children.map((line) => [refId(line), line.selection?.mode || "fixed", line.quantity]), [["gutter_removal", "fixed", "180"], ["gutter_replace", "fixed", "180"], ["downspout", "fixed", "60"], ["gutter_guard", "optional", "180"]]);
  assert.equal(scopeItemPriceResult(root).amount_cents, 180 * 225 + 180 * 1425 + 60 * 1150, "removal, gutters and downspouts; guards only if chosen");
});

let storageRoot = "";
let fixture: Promise<Record<string, any>> | null = null;
before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "roofing-sales-docs-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: storageRoot, PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(storageRoot, "sandbox"), FIRSTMEASURE_DATA_ENVIRONMENT: "development", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", V1_LOG_LEVEL: "error" });
});
after(async () => {
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});
/** One sandbox organization with a project, shared by the tests below. */
function organization() {
  fixture ||= (async () => {
    const storage = await import("../platform/storage.js");
    const signup = await import("../signup-sandbox/service.js");
    await signup.ensureSeedData();
    const { authContext: ctx } = await signup.createTestInstance("swf_instant_full_org");
    const project = await storage.upsertDocument(ctx.orgId, "projects", { id: "project_sales_docs", data: { title: "Whitfield residence", branch_id: "default", address: "68 Northfield Rd", contacts: [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }] } });
    const publication = await import("../platform/publication/context.js");
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    return { ctx, projectId: String(project.id), service: await import("../documents/service.js"), store: await import("../documents/storage.js"), pctx: publication.userPublicationContext(ctx, { executionKind: "api" }) };
  })();
  return fixture;
}
/** The scope as the documents app builds it: generated by the published action, groups named per piece. */
async function generated(pctx: any, orgId: string, variant = "", templateId = "roof_replacement", input: Record<string, number> = measurements) {
  const actions = await import("../platform/publication/actions.js");
  const root: Line = (await actions.invokeAction(pctx, { action: "pricebook.scope.generate", target: { scope: "organization" as const, organizationId: orgId } }, { templateId, measurements: input, ...(variant ? { variant } : {}) })).value as Line;
  const pieceId = `piece_${templateId}`;
  const prefix = (line: Line) => { if (line.selection?.group_id) line.selection.group_id = `${pieceId}:${line.selection.group_id}`; (line.children || []).forEach(prefix); };
  prefix(root);
  return Object.assign(root, { scope_piece_id: pieceId, scope_template_id: templateId });
}
const total = (resolved: any) => (resolved.scope.params.scope_items as Line[]).reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);

test("a new organization gets the roofing sales documents and none of the retired ones", async () => {
  const { ctx, store } = await organization();
  const { RETIRED_TEMPLATE_IDS, RETIRED_WORKFLOW_IDS, ensureDefaultDocumentAssets } = await import("../documents/seeds.js");
  await ensureDefaultDocumentAssets(ctx.orgId, ctx);
  const templates = (await store.listDocumentTemplates(ctx.orgId)) as Line[];
  const proposals = templates.filter((template) => template.document_type === "proposal").map((template) => template.id).sort();
  assert.deepEqual(proposals, ["tpl_instant_roofing_detailed", "tpl_instant_roofing_gutters", "tpl_instant_roofing_onepage", "tpl_instant_roofing_options", "tpl_instant_roofing_package", "tpl_instant_roofing_quick"]);
  for (const id of ["tpl_proposal_default", "tpl_one_page_legal", "tpl_three_option_proposal", "tpl_roofing_good_better_best_workflow", "tpl_kitchen_selections", "tpl_kitchen_estimate", "tpl_same_day_service_authorization"]) {
    assert.ok(RETIRED_TEMPLATE_IDS.includes(id), `${id} is retired`);
    assert.equal(await store.readDocumentTemplate(ctx.orgId, id).catch(() => null), null, `${id} was never created for a new organization`);
  }
  const workflows = (await store.listDocumentWorkflows(ctx.orgId)).map((workflow: Line) => workflow.id);
  assert.ok(!RETIRED_WORKFLOW_IDS.some((id: string) => workflows.includes(id)), "their workflows are not seeded either");
  // Every sales proposal names a deck; the Good / Better / Best one has the comparison slide.
  const presentations = await import("../documents/modules/presentation-service.js");
  const decks: Record<string, string> = { detailed: "preset_presentation_roofing_itemized", onepage: "preset_presentation_roofing_itemized", options: "preset_presentation_roofing_options", gutters: "preset_presentation_roofing_gutters" };
  for (const [key, moduleId] of Object.entries(decks)) {
    const workflow: Line = await store.readDocumentWorkflow(ctx.orgId, `wfl_instant_roofing_${key}`);
    const definition = (await store.readDocumentWorkflowVersion(ctx.orgId, workflow.id, Number(workflow.current_version))).definition as Line;
    assert.deepEqual(definition.completion, { offers: ["present", "send_estimate", "send_presentation"], default: "present", presentation: { module_id: moduleId } });
    assert.deepEqual(definition.steps.filter((step: Line) => step.audience.includes("customer")).map((step: Line) => step.id), ["choose", "sign", "pay"]);
    assert.ok((await presentations.listPresentationModules((await organization()).pctx)).some((module: Line) => module.id === moduleId), `${moduleId} is published`);
  }
});

test("an existing organization's unedited retired presets are archived; edited ones are left alone", async () => {
  const { ctx, store } = await organization();
  const { ensureDefaultDocumentAssets } = await import("../documents/seeds.js");
  const { FMDocModel } = await import("../documents/schemas.js");
  const definition = FMDocModel.createDocument({ first_page_role: "body" });
  // Stand in for an organization seeded before the retirement.
  await store.createDocumentTemplate(ctx.orgId, { id: "tpl_proposal_default", name: "Standard Proposal", document_type: "proposal", status: "active", definition, metadata: { preset: true, preset_id: "tpl_proposal_default", preset_revision: 1 } }, ctx, { systemPreset: true });
  await store.createDocumentTemplate(ctx.orgId, { id: "tpl_one_page_legal", name: "Our agreement", document_type: "contract", status: "active", definition, metadata: { preset: false } }, ctx);
  await store.createDocumentWorkflow(ctx.orgId, { id: "wfl_roofing_proposal_intake", name: "Roofing proposal intake", status: "active", definition: { schema_version: 1, name: "Roofing proposal intake", contract: { params: {}, outputs: {} }, steps: [] }, metadata: { preset: true } }, ctx, { systemPreset: true });
  const organizationId = `${ctx.orgId}`;
  // The seeding pass is throttled per organization; a later pass is what an existing organization sees.
  const realNow = Date.now;
  Date.now = () => realNow() + 120_000;
  try { await ensureDefaultDocumentAssets(organizationId, ctx); } finally { Date.now = realNow; }
  assert.equal((await store.readDocumentTemplate(ctx.orgId, "tpl_proposal_default")).status, "archived");
  assert.equal((await store.readDocumentWorkflow(ctx.orgId, "wfl_roofing_proposal_intake")).status, "archived");
  assert.equal((await store.readDocumentTemplate(ctx.orgId, "tpl_one_page_legal")).status, "active", "a template the organization made its own stays");
  assert.ok(!(await store.listDocumentTemplates(ctx.orgId)).some((template: Line) => template.id === "tpl_proposal_default"), "an archived preset leaves the picker");
});

test("a scope-owned template is created, hidden, the first time its scope issues it", async () => {
  const { ctx, projectId, service, store } = await organization();
  assert.equal(await store.readDocumentTemplate(ctx.orgId, "tpl_kitchen_selections").catch(() => null), null);
  const created = await service.issueDocumentFromAutomation(ctx.orgId, { template_id: "tpl_kitchen_selections", workflow_id: "wfl_kitchen_selections", project_id: projectId, params: {}, deliver: "none", source: { type: "automation", automation_id: "documents.issue.v1", idempotency_key: "sales-docs-kitchen" } } as any);
  assert.equal((created as Line).document.document_type, "change_order", "the document takes its type from the template");
  assert.equal((created as Line).document.workflow_ref.workflow_id, "wfl_kitchen_selections");
  assert.equal((await store.readDocumentTemplate(ctx.orgId, "tpl_kitchen_selections")).status, "archived");
  assert.ok(!(await store.listDocumentTemplates(ctx.orgId)).some((template: Line) => template.id === "tpl_kitchen_selections"), "it never appears in the library");
});

test("the itemized proposal: lines add up, gutters and options move the total by their price, and the description pages appear only when used", async () => {
  const { ctx, projectId, service, store, pctx } = await organization();
  const root = await generated(pctx, ctx.orgId);
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", params: { scope_items: [root] } }, ctx) as Line;
  assert.equal(document.template_ref.template_id, "tpl_instant_roofing_detailed", "a proposal made by type alone is the itemized one");
  const resolve = async () => service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, String(document.id)), { target: "static" }) as Promise<Line>;
  const plain = await resolve();
  const rows = plain.scope.params.scope_rows as Line[];
  assert.equal(rows.filter((row) => row.depth > 0).reduce((sum, row) => sum + row.amount_cents, 0), total(plain), "printed lines add up to the total");
  assert.ok(rows.every((row) => row.depth === 0 || Number(row.quantity) > 0), "no line prints at zero quantity");
  assert.ok(!rows.some((row) => /gutter|downspout/i.test(row.name)), "gutters are not in the proposal until chosen");

  // Skipping "Photos & description" leaves the pricing where it was; using it puts its pages first.
  const texts = (resolved: Line) => JSON.stringify(resolved.resolved_definition);
  const breaks = (resolved: Line) => (texts(resolved).match(/"type":"page_break"/g) || []).length;
  assert.ok(!texts(plain).includes("About this project") && breaks(plain) === 0, "no description section, no extra page");
  await service.patchDocumentInstance(ctx.orgId, String(document.id), { params: { content_blocks: [{ id: "cb_1", title: "Your roof today", body: "Granule loss on the south slope.", layout: "auto", display: "inline" }] }, expected_revision: Number((await store.readDocumentInstance(ctx.orgId, String(document.id))).revision) }, ctx);
  const described = await resolve();
  assert.ok(texts(described).includes("About this project") && texts(described).includes("Granule loss on the south slope."));
  assert.equal(breaks(described), 1, "the pricing starts on a fresh page after the description");
  assert.equal(total(described), total(plain), "describing the work does not change the price");

  // The customer adds gutters, then switches shingle: each moves the total by exactly its price.
  const gutter = (root.children as Line[]).find((line) => refId(line) === "gutter_replace")!;
  await service.recordDocumentOutput(ctx.orgId, String(document.id), "selections", { value: { selections: { [gutter.id]: true } } } as any, ctx as any);
  const withGutters = await resolve();
  assert.equal(total(withGutters) - total(plain), own(gutter));
  const shingles = (root.children as Line[]).filter((line) => line.selection?.group_id?.endsWith(":shingle_profile"));
  const chosen = shingles.find((line) => line.selection.selected)!, other = shingles.find((line) => !line.selection.selected)!;
  await service.recordDocumentOutput(ctx.orgId, String(document.id), "selections", { value: { selections: { [other.selection.group_id]: other.id } } } as any, ctx as any);
  assert.equal(total(await resolve()) - total(withGutters), own(other) - own(chosen));
});

test("the one-page proposal prices the same scope and fits its template's single page", async () => {
  const { ctx, projectId, service, pctx } = await organization();
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_onepage", params: { scope_items: [await generated(pctx, ctx.orgId)] } }, ctx) as Line;
  assert.equal(document.workflow_ref.workflow_id, "wfl_instant_roofing_onepage");
  const resolved = await service.resolveDocumentInstance(ctx.orgId, document, { target: "static" }) as Line;
  assert.equal(resolved.resolved_definition.pages.length, 1);
  const text = JSON.stringify(resolved.resolved_definition);
  for (const expected of ["Dana Whitfield", "Scope of work", "GAF Timberline HDZ", "Payment terms", "doc.signature@1", "doc.pay_now@1"]) assert.ok(text.includes(expected), `the page carries ${expected}`);
  assert.equal(total(resolved), scopeItemPriceResult((await generated(pctx, ctx.orgId))).amount_cents, "same measurements, same price as the itemized proposal");
});

test("the Good / Better / Best proposal: document, customer choice and presentation agree on every price", async () => {
  const { ctx, projectId, service, store, pctx } = await organization();
  const root = await generated(pctx, ctx.orgId, "options");
  const packages = (root.children as Line[]).filter((line) => line.selection?.mode === "choice");
  const [good, better, best] = packages as [Line, Line, Line];
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_options", params: { scope_items: [root] } }, ctx) as Line;
  const documentId = String(document.id);
  const resolve = async () => service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, documentId), { target: "static" }) as Promise<Line>;
  const first = await resolve();
  // The document compares all three and itemizes the selected one.
  const compared = first.scope.params.scope_packages as Line[];
  assert.deepEqual(compared.map((option) => [option.name, option.price_cents, option.selected]), [["Good", ifChosen(good), false], ["Better", ifChosen(better), true], ["Best", ifChosen(best), false]]);
  assert.equal(total(first), ifChosen(better));
  const rows = first.scope.params.scope_rows as Line[];
  assert.ok(rows.some((row) => row.name === "Better") && !rows.some((row) => row.name === "Good" || row.name === "Best"), "only the selected option is itemized");
  assert.ok(!rows.some((row) => /UHDZ|Timberline NS/.test(row.name)), "the other options' lines stay out of the proposal");

  // The presentation offers the same three, each with the price and deposit it would bring.
  const presentations = await import("../documents/modules/presentation-service.js");
  const parts: any = createRequire(import.meta.url)("../../libraries/doc-parts/firstmate-doc-parts.js");
  const completion: Line = await presentations.documentPresentationOptions(pctx, documentId);
  assert.equal(completion.presentation.moduleId, "preset_presentation_roofing_options");
  let shown: Line = await presentations.createPresentation(pctx, { documentId });
  assert.deepEqual(shown.layout.pages.map((page: Line) => page.id), ["cover", "about", "good_roof", "anatomy", "compare", "addons", "estimate", "sign"]);
  const comparison = Object.values(shown.layout.assemblies as Record<string, Line>).find((entry) => entry.type === "option_compare")!;
  assert.equal(comparison.config.source.id, "roof_package");
  let live = parts.stateFromPresentation(shown);
  const group = live.groups.find((entry: Line) => entry.id.split(":").pop() === "roof_package");
  assert.deepEqual(group.options.map((option: Line) => [option.title, option.price_cents, option.selected]), [["Good", ifChosen(good), false], ["Better", ifChosen(better), true], ["Best", ifChosen(best), false]]);
  assert.ok(group.options.every((option: Line) => option.highlights.length >= 3), "each column lists what sets the option apart");
  assert.equal(live.totals.total_cents, ifChosen(better));
  assert.equal(live.totals.deposit_cents, Math.round(ifChosen(better) * 0.3), "30% is due at signing");
  const bestOption = group.options[2];
  assert.equal(bestOption.delta_cents, ifChosen(best) - ifChosen(better));
  assert.equal(bestOption.deposit_cents, Math.round(ifChosen(best) * 0.3), "the Best column shows the deposit Best would need");
  assert.ok(live.addons.some((addon: Line) => /gutter/i.test(addon.title)), "gutters are offered as an add-on");
  assert.equal(live.variants.length, 1, "only the selected option's shingle is open to a color choice");

  // Picking Best on the slide moves the total by the stated difference.
  shown = await presentations.changePresentation(pctx, shown.id, { expectedRevision: shown.revision, changes: [parts.inputWrite({ type: "choice", group_id: group.id, option: bestOption.id })] });
  live = parts.stateFromPresentation(shown);
  assert.equal(live.totals.total_cents, ifChosen(best));
  assert.equal(live.totals.deposit_cents, bestOption.deposit_cents);
  // The contract it produces totals what the slide showed.
  const produced: Line = await presentations.producePresentationContract(pctx, shown.id, { expectedRevision: shown.revision });
  assert.equal(produced.document.id, documentId);
  assert.equal(total(await resolve()), ifChosen(best), "the document now prices Best");

  // The customer changes their mind in the portal: Good, with gutters.
  const gutter = (root.children as Line[]).find((line) => refId(line) === "gutter_replace")!;
  await service.recordDocumentOutput(ctx.orgId, documentId, "selections", { value: { selections: { [good.selection.group_id]: good.id, [gutter.id]: true } } } as any, ctx as any);
  const last = await resolve();
  assert.equal(total(last), ifChosen(good) + own(gutter));
  assert.deepEqual((last.scope.params.scope_packages as Line[]).map((option) => option.selected), [true, false, false]);
});

test("a signed Good / Better / Best proposal bills the option that was chosen", async () => {
  const { ctx, projectId, service, pctx } = await organization();
  const root = await generated(pctx, ctx.orgId, "options");
  const better = (root.children as Line[]).find((line) => line.selection?.selected === true)!;
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_options", params: { scope_items: [root] } }, ctx) as Line;
  const sent: Line = await service.sendDocument(ctx.orgId, String(document.id), { recipients: [{ name: "Dana Whitfield", email: "dana@example.test", role: "customer" }], consent_contact: "support@example.test" }, ctx);
  const signing = await import("../documents/signing/service.js");
  const access = await signing.publicSigningAccess(sent.signing.invitations[0].token);
  const review: Line = await signing.prepareSigning(access);
  await signing.acceptSigning(access, "sig_customer", { value: { type: "typed", signer_name: "Dana Whitfield" }, challenge: review.challenge, content_hash: review.content_hash, consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: review.disclosure.hash } } as any);
  const { ensureReceivablesForSignedDocument } = await import("../documents/receivables.js");
  await ensureReceivablesForSignedDocument(ctx.orgId, String(document.id));
  const { listProjectObligations } = await import("../payments/storage.js");
  const amounts = (await listProjectObligations(ctx.orgId, projectId)).map((row: Line) => Number(row.amount_cents || 0));
  assert.ok(amounts.includes(Math.round(ifChosen(better) * 0.3)), "the deposit is 30% of the chosen option");
  assert.ok(amounts.includes(ifChosen(better) - Math.round(ifChosen(better) * 0.3)), "the balance is the rest");
});

test("the gutter estimate prices a gutter job and offers guards", async () => {
  const { ctx, projectId, service, store, pctx } = await organization();
  const root = await generated(pctx, ctx.orgId, "", "gutters", { gutterLf: 180, downspoutLf: 60 } as any);
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_gutters", params: { scope_items: [root] } }, ctx) as Line;
  const resolve = async () => service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, String(document.id)), { target: "static" }) as Promise<Line>;
  const first = await resolve();
  assert.equal(total(first), 366000);
  assert.deepEqual((first.scope.params.scope_rows as Line[]).filter((row) => row.depth > 0).map((row) => [row.name, row.amount_cents]), [["Remove Existing Gutters", 40500], ["K-Style Gutter", 256500], ["Downspout", 69000]]);
  const guards = (root.children as Line[]).find((line) => refId(line) === "gutter_guard")!;
  await service.recordDocumentOutput(ctx.orgId, String(document.id), "selections", { value: { selections: { [guards.id]: true } } } as any, ctx as any);
  assert.equal(total(await resolve()), 366000 + 171000);
  const presentations = await import("../documents/modules/presentation-service.js");
  assert.equal((await presentations.documentPresentationOptions(pctx, String(document.id)) as Line).presentation.moduleId, "preset_presentation_roofing_gutters");
});
