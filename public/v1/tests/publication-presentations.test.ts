import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlatformAuthContext } from "../platform/auth.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";

// Workflow -> presentation -> contract over the seeded roofing itemized proposal.
let root = "", app: any = null;
let auth: PlatformAuthContext, ctx: PublicationContext, orgId = "", moduleId = "";
let presentations: typeof import("../documents/modules/presentation-service.js");
let modules: typeof import("../documents/modules/service.js");
let documents: typeof import("../documents/service.js");
let documentStore: typeof import("../documents/storage.js");
let storage: typeof import("../platform/storage.js");
let signup: typeof import("../signup-sandbox/service.js");
let model: any, generated: any;
const projectId = "project_presentation";
const any = (value: unknown) => value as any;
const code = (expected: string) => (error: any) => { assert.equal(error?.code, expected, `expected ${expected}, got ${error?.code}: ${error?.message}`); return true; };

/** A two-slide 16:9 deck carrying the editor's own fields, which the server must return untouched. */
function slides(computed: Record<string, string> = {}) {
  const doc = model.createDocument({ kind: "document", paper: { w_pt: 960, h_pt: 540 } });
  const widget = (id: string, name: string, config: object, extra: object = {}) => model.createNode("widget", { id, frame: { x: 40, y: 40, w: 400, h: 200 }, props: { widget: `${name}@1`, config, ...extra } });
  doc.pages = [
    model.createPage("body", { id: "slide_choose", transition: { kind: "fade", ms: 300 }, steps: [{ id: "step_1", nodes: ["w_shingle"] }], notes: "Ask about the neighbours' roofs.", children: [
      widget("w_shingle", "doc.choice_selection", { kind: "group", group_id: "shingle_profile" }, { animations: [{ kind: "rise", step: "step_1" }], part: { widget: "doc.choice_selection", role: "option", key: "title", required: true } }),
      widget("w_total", "doc.price_display", { of: "total" })] }),
    model.createPage("body", { id: "slide_review", children: [widget("w_review", "doc.selection_review", {}), widget("w_group_price", "doc.price_display", { of: "group", group_id: "shingle_profile" })] })
  ];
  doc.metadata = { ...doc.metadata, presentation: { aspect: "16:9", autoplay: false } };
  doc.computed = computed;
  return doc;
}
async function draft() {
  return any(await documents.createDocumentInstance(orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_detailed", params: { scope_items: [generated] } }, auth)).document;
}
const documentTotal = async (documentId: string) => {
  const document = await documentStore.readDocumentInstance(orgId, documentId);
  return (await documents.documentCheckoutPricing(orgId, document, any(document.params), {})).totals.total_cents;
};
const shingles = (state: any) => state.offered.groups.find((group: any) => group.id === "shingle_profile");

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "presentation-modules-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: root, PRICEBOOK_STORAGE_ROOT: path.join(root, "pricebook"), PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"),
    FIRSTMEASURE_DATA_ENVIRONMENT: "development", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", CRM_STORAGE_ROOT: path.join(root, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure", "projects_index.sqlite"), V1_LOG_LEVEL: "error" });
  storage = await import("../platform/storage.js");
  signup = await import("../signup-sandbox/service.js");
  await signup.ensureSeedData();
  const instance = await signup.createTestInstance("swf_instant_full_org");
  auth = instance.authContext as PlatformAuthContext; orgId = auth.orgId;
  await (await import("../signup-sandbox/roofing-documents.js")).seedInstantRoofingDocuments(orgId, auth);
  documents = await import("../documents/service.js");
  documentStore = await import("../documents/storage.js");
  // The seeded proposal names the roofing presentation; these tests start from a workflow that names none.
  {
    const seeded = await documentStore.readDocumentWorkflow(orgId, "wfl_instant_roofing_detailed");
    const { completion: _seededCompletion, ...definition } = any(await documentStore.readDocumentWorkflowVersion(orgId, "wfl_instant_roofing_detailed", Number(seeded.current_version))).definition;
    await documentStore.publishDocumentWorkflow(orgId, "wfl_instant_roofing_detailed", { definition, expected_version: Number(seeded.current_version) }, auth);
  }
  modules = await import("../documents/modules/service.js");
  presentations = await import("../documents/modules/presentation-service.js");
  model = (await import("../documents/schemas.js")).FMDocModel;
  const publication = await import("../platform/publication/context.js");
  (await import("../platform/publication/bootstrap.js")).initializePublication();
  (await import("../documents/modules/provider.js")).registerModuleDataProvider();
  ctx = publication.userPublicationContext(auth, { executionKind: "module" });
  await storage.upsertDocument(orgId, "projects", { id: projectId, data: { title: "Presentation test", branch_id: "default", address: "1 Ridge Road", contacts: [{ name: "Pat Homeowner", email: "pat@example.test", primary: true }] } });
  generated = (await (await import("../platform/publication/actions.js")).invokeAction(publication.userPublicationContext(auth, { executionKind: "api" }),
    { action: "pricebook.scope.generate", target: { scope: "organization", organizationId: orgId } }, { templateId: "roof_replacement", measurements: { roofSquares: 25.5, wastePercent: 10, eavesLf: 120.4, rakesLf: 80 } })).value;
  moduleId = String((await presentations.publishPresentation(ctx, presentations.scopePresentationDefinition({ name: "Roof presentation", layout: slides({ total: "outputs.pricing.totals.total_cents", raw_lines: "params.scope_items", prepared_for: "params.customer.name" }), contract: { params: { customer_choice_count: 0 } } }))).id);
});
after(async () => {
  if (app) await app.close();
  await (await import("../platform/publication/bindings.js")).closeBindingStoreForTests();
  await (await import("../platform/publication/actions.js")).closeActionDatabase();
  await (await import("../documents/signing/store.js")).closeSigningStore();
  await closePlatformFixtureStores();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

test("a presentation is a third module kind with its own publish rules", async () => {
  const base = presentations.scopePresentationDefinition({ name: "Rules", layout: slides() });
  assert.equal((await presentations.listPresentationModules(ctx)).some(module => module.id === moduleId && module.kind === "presentation"), true);
  await assert.rejects(modules.publishModule(ctx, { ...base, bindings: { products: { kind: "data", policy: "live", source: { provider: "pricebook", export: "items", target: { scope: "organization", organizationId: orgId } } } } }), code("module_presentation_bindings"));
  const { renderer: _layout, ...withoutLayout } = base;
  await assert.rejects(modules.publishModule(ctx, withoutLayout), code("module_presentation_layout"));
  await assert.rejects(modules.publishModule(ctx, { ...base, renderer: { ...base.renderer, pages: "none" } }), code("module_view_invalid"));
  // A fluid view is as valid a layout as a paged deck.
  assert.equal((await modules.publishModule(ctx, { ...base, name: "Fluid", renderer: model.createDocument({ kind: "view" }) })).kind, "presentation");
  await assert.rejects(modules.publishModule(ctx, { ...base, presentation: { ...base.presentation, inputs: { pricing: { kind: "value" } } } }), code("module_presentation_input"));
  await assert.rejects(modules.publishModule(ctx, { ...base, presentation: { ...base.presentation, customer: { exports: ["scope_items"] } } }), code("module_presentation_customer_export"));
  await assert.rejects(modules.publishModule(ctx, { ...base, kind: "document", source: "return {outputs:{}}" }), code("module_presentation_kind"));
  const { presentation: _spec, ...plain } = base;
  await assert.rejects(modules.publishModule(ctx, { ...plain, kind: "document", source: "" }), code("module_source_required"));
  // Presets: published once per revision at a stable id, and left alone once the organization edits them.
  const preset = { id: "roofing", name: "Roofing deck", layout: slides(), preset_revision: 1 };
  const seeded = await presentations.ensurePresentationPreset(orgId, preset);
  assert.deepEqual([seeded.moduleId, seeded.published], ["preset_presentation_roofing", true]);
  assert.equal((await presentations.ensurePresentationPreset(orgId, preset)).published, false);
  const upgraded = await presentations.ensurePresentationPreset(orgId, { ...preset, name: "Roofing deck 2", preset_revision: 2 });
  assert.equal(upgraded.published, true); assert.notEqual(upgraded.version, seeded.version);
  await presentations.publishPresentation(ctx, presentations.scopePresentationDefinition({ name: "Edited by the organization", layout: slides() }), seeded.moduleId);
  assert.equal((await presentations.ensurePresentationPreset(orgId, { ...preset, preset_revision: 3 })).published, false);
  // The generic module lifecycle cannot create or drive a presentation instance.
  await assert.rejects(modules.createModuleInstance(ctx, { moduleId, projectId }), code("module_presentation_route"));
  // A view template whose program carries a presentation contract publishes through the builder path.
  const { publishAssetProgram } = await import("../documents/modules/authoring.js");
  const stamped = any(await publishAssetProgram(orgId, "tpl_roof_presentation", "Roof presentation", "document", { ...slides(), program: { enabled: true, inputSchema: base.inputSchema, outputSchema: base.outputSchema, exports: base.exports, presentation: base.presentation } }, auth));
  assert.equal(stamped.program.moduleId, "builder_presentation_tpl_roof_presentation");
  assert.equal(any(await modules.moduleDefinition(ctx, stamped.program.moduleId)).definition.kind, "presentation");
});

test("a workflow declares what its final step offers, validated at publish", async () => {
  const workflowId = "wfl_instant_roofing_detailed";
  const publish = async (completion: unknown) => {
    const current = await documentStore.readDocumentWorkflow(orgId, workflowId);
    const version = await documentStore.readDocumentWorkflowVersion(orgId, workflowId, Number(current.current_version));
    return documentStore.publishDocumentWorkflow(orgId, workflowId, { definition: { ...any(version).definition, completion }, expected_version: Number(current.current_version) }, auth);
  };
  await assert.rejects(publish({ offers: ["present"] }), code("workflow_completion_invalid"));
  await assert.rejects(publish({ offers: ["send_estimate"], default: "present" }), code("workflow_completion_invalid"));
  await assert.rejects(publish({ offers: ["present", "send_estimate"], presentation: { module_id: "module_missing" } }), code("workflow_completion_presentation"));
  const document = await draft();
  // Before the hook: nothing names a presentation, so the workflow goes straight to the document.
  assert.deepEqual(any(await presentations.documentPresentationOptions(ctx, document.id)).offers, ["send_estimate"]);
  await assert.rejects(presentations.createPresentation(ctx, { documentId: document.id }), code("presentation_module_required"));
  await publish({ offers: ["present", "send_estimate", "send_presentation"], default: "present", presentation: { module_id: moduleId } });
  const options = any(await presentations.documentPresentationOptions(ctx, document.id));
  assert.deepEqual(options.offers, ["present", "send_estimate", "send_presentation"]);
  assert.equal(options.default, "present");
  assert.equal(options.presentation.moduleId, moduleId);
  assert.equal(options.sharePresentationWithEstimate, "ask");
});

test("partial inputs evaluate one change at a time, in the sandbox, with revision checks", async () => {
  const number = { type: "number", minimum: 1 }, color = { enum: ["charcoal", "slate"] };
  const published = await presentations.publishPresentation(ctx, {
    name: "Financing", kind: "presentation", renderer: slides({ label: "outputs.summary.label" }),
    inputSchema: { type: "object", required: ["color", "months"], properties: { color, months: number, note: { type: "string" } } }, outputSchema: { type: "object" },
    exports: { color: { path: "/inputs/color", schema: color, access: "write" }, months: { path: "/inputs/months", schema: number, access: "write" }, note: { path: "/inputs/note", schema: { type: "string" }, access: "write" }, summary: { path: "/outputs/summary", schema: { type: "object" }, access: "read" } },
    source: "return { outputs: { summary: { label: (inputs.color || 'no color') + ' / ' + (inputs.months || '?'), missing: state.missing } } };",
    presentation: { pricing: "none", inputs: { color: { kind: "value", audience: ["internal", "customer"] }, months: { kind: "value", audience: ["internal", "customer"] }, note: { kind: "value" } }, customer: { exports: ["summary"] } }
  });
  let state = any(await presentations.createPresentation(ctx, { projectId, moduleId: String(published.id) }));
  assert.equal(state.ready, false);
  assert.deepEqual(state.missing, ["color", "months"]);
  assert.equal(state.exports.summary.label, "no color / ?");
  assert.equal(state.layout.computed_values.label, "no color / ?");
  await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "color", value: "purple" }] }), code("publication_schema_invalid"));
  await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "summary", value: {} }] }), code("presentation_input_unknown"));
  await assert.rejects(presentations.producePresentationContract(ctx, state.id, { expectedRevision: state.revision }), code("presentation_incomplete"));
  const first = state.revision;
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: first, changes: [{ input: "color", value: "slate" }] }));
  assert.deepEqual(state.missing, ["months"]);
  assert.equal(state.inputs.color.value, "slate");
  await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: first, changes: [{ input: "months", value: 12 }] }), code("module_revision"));
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "months", value: 12 }] }));
  assert.equal(state.ready, true);
  assert.equal(state.exports.summary.label, "slate / 12");
  // Presentation code runs evaluate-only with no capabilities at all.
  const reaching = await presentations.publishPresentation(ctx, { name: "Reaching", kind: "presentation", renderer: slides(), inputSchema: { type: "object" }, outputSchema: { type: "object" }, exports: {}, source: "await api.data.read('products'); return { outputs: {} };", presentation: { pricing: "none" } });
  await assert.rejects(presentations.createPresentation(ctx, { projectId, moduleId: String(reaching.id) }), /cannot read data/);
});

test("internal, customer and other-organization access", async () => {
  const document = await draft();
  let state = any(await presentations.createPresentation(ctx, { documentId: document.id }));
  assert.equal(state.source.documentId, document.id);
  assert.equal(state.pricing.totals.total_cents, await documentTotal(document.id), "the presentation prices with the document's own pricing");
  assert.equal(state.exports.customer.name, "Pat Homeowner");
  // Internal viewers also see only declared exports; raw lines are private.
  assert.equal(state.exports.scope_items, undefined);
  assert.equal(state.layout.computed_values.total, state.pricing.totals.total_cents);
  assert.equal(state.layout.computed_values.raw_lines, undefined);
  // The deck comes back as authored: paper, slide transitions, steps, notes, animations and parts.
  const authored = slides(), slide = state.layout.pages[0], node = slide.children[0];
  assert.deepEqual(state.layout.settings.paper.size, { w_pt: 960, h_pt: 540 });
  assert.deepEqual([slide.transition, slide.steps, slide.notes], [authored.pages[0].transition, authored.pages[0].steps, authored.pages[0].notes]);
  assert.deepEqual([node.props.animations, node.props.part], [authored.pages[0].children[0].props.animations, authored.pages[0].children[0].props.part]);
  assert.deepEqual(state.layout.metadata.presentation, authored.metadata.presentation);
  // Widget data, keyed by node id, for the three presentation widgets.
  assert.equal(state.widgetData.w_total.amount_cents, state.pricing.totals.total_cents);
  assert.equal(state.widgetData.w_shingle.input, "selections"); assert.equal(state.widgetData.w_shingle.writable, true);
  assert.deepEqual(state.widgetData.w_shingle.group, shingles(state));
  const selected = shingles(state).options.find((entry: any) => entry.selected);
  assert.ok(selected.title && selected.price_cents > 0 && selected.offered === true && Array.isArray(selected.media_refs));
  assert.equal(state.widgetData.w_group_price.amount_cents, selected.price_cents);
  assert.deepEqual(state.widgetData.w_review.groups.find((group: any) => group.id === "shingle_profile").target, { page_id: "slide_choose", node_id: "w_shingle" });
  assert.equal(state.widgetData.w_review.groups.find((group: any) => group.id === "shingle_profile").chosen.id, selected.id);
  assert.ok(state.org.name); assert.equal(state.customer.name, "Pat Homeowner");

  const outsider = { ...ctx, auth: { ...auth, userId: "user_without_access", role: "member", permissions: {} } as any };
  await assert.rejects(presentations.readPresentation(outsider, state.id), code("publication_permission_denied"));
  const viewer = { ...ctx, auth: { ...auth, userId: "viewer", role: "member", permissions: { view_projects: true } } as any };
  assert.equal(any(await presentations.readPresentation(viewer, state.id)).id, state.id);
  await assert.rejects(presentations.changePresentation(viewer, state.id, { expectedRevision: state.revision, changes: [{ input: "selections", value: {} }] }), code("publication_permission_denied"));
  await assert.rejects(presentations.sharePresentation(viewer, state.id, { expectedRevision: state.revision, access: "view" }), code("publication_permission_denied"));
  const other = await signup.createTestInstance("swf_instant_full_org");
  const otherCtx = { ...ctx, auth: other.authContext as PlatformAuthContext, organizationId: (other.authContext as PlatformAuthContext).orgId };
  await assert.rejects(presentations.readPresentation(otherCtx, state.id), code("presentation_not_found"));
  await assert.rejects(presentations.createPresentation(otherCtx, { documentId: document.id }));
  await assert.rejects(presentations.readPresentation({ ...ctx, organizationId: otherCtx.organizationId }, state.id), code("presentation_not_found"));

  const viewOnly = any(await presentations.sharePresentation(ctx, state.id, { expectedRevision: state.revision, access: "view", recipients: [{ name: "Pat", email: "pat@example.test" }] }));
  const choose = any(await presentations.sharePresentation(ctx, state.id, { expectedRevision: viewOnly.presentation.revision, access: "choose", recipients: [{ name: "Pat", email: "pat@example.test" }] }));
  assert.match(viewOnly.url, /\/l\/pl1\./);
  assert.equal(JSON.stringify(await storage.listDocuments(orgId, "public_links")).includes(choose.token), false, "only the token hash is stored");
  const customer = any(await presentations.publicPresentation(choose.token));
  assert.equal(customer.audience, "customer"); assert.equal(customer.access, "choose");
  assert.equal(customer.pricing.totals.total_cents, state.pricing.totals.total_cents);
  assert.equal(customer.layout.computed_values.prepared_for, "Pat Homeowner");
  for (const hidden of ["internal_cost", "pricebook_snapshot", "internal_description", "projectId", "moduleId", "shares", "source", choose.share.id]) assert.equal(JSON.stringify(customer).includes(hidden), false, `customer state must not carry ${hidden}`);
  assert.equal(any(await presentations.publicPresentation(viewOnly.token)).access, "view");
  const option = shingles(customer).options.find((entry: any) => !entry.selected);
  const pick = { expectedRevision: customer.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: option.id } }] };
  await assert.rejects(presentations.publicPresentationChange(viewOnly.token, pick), code("public_link_action_forbidden"));
  await assert.rejects(presentations.publicPresentationChange(`${choose.token}x`, pick), code("public_link_not_found"));
  await assert.rejects(presentations.publicPresentation(choose.token.replace(/\.[^.]+\./, `.${Buffer.from(otherCtx.organizationId).toString("base64url")}.`)), code("public_link_not_found"));
  state = any(await presentations.revokePresentationShare(ctx, state.id, viewOnly.share.id));
  await assert.rejects(presentations.publicPresentation(viewOnly.token), code("public_link_revoked"));
  assert.equal(state.shares.find((share: any) => share.id === viewOnly.share.id).active, false);
});

test("a customer choice moves the price by the stated amount, with evidence, and reaches the signed contract", async () => {
  const document = await draft();
  const before = await documentTotal(document.id);
  let state = any(await presentations.createPresentation(ctx, { documentId: document.id }));
  const share = any(await presentations.sharePresentation(ctx, state.id, { expectedRevision: state.revision, access: "choose", recipients: [{ name: "Pat Homeowner", email: "pat@example.test" }] }));
  let customer = any(await presentations.publicPresentation(share.token));
  const lines = generated.children, line = (id: string) => lines.find((entry: any) => entry.id === id);
  const hasPricedVariant = (id: string) => (line(id).variant_dimensions || []).some((dimension: any) => dimension.values.some((value: any) => value.adjustment));
  const group = shingles(customer), chosen = group.options.find((entry: any) => entry.selected), option = group.options.find((entry: any) => !entry.selected && entry.delta_cents !== 0 && hasPricedVariant(entry.id));
  const expected = Math.round(Number(line(option.id).quantity) * line(option.id).unit_price * 100) - Math.round(Number(line(chosen.id).quantity) * line(chosen.id).unit_price * 100);
  assert.equal(option.delta_cents, expected, "each alternative states the exact difference it makes");

  // Server-side validation of customer writes.
  const reject = (value: unknown, expectedCode: string, input = "selections") => assert.rejects(presentations.publicPresentationChange(share.token, { expectedRevision: customer.revision, changes: [{ input, value }] }), code(expectedCode));
  const internalOnly = lines.find((entry: any) => entry.selection?.mode === "choice" && !entry.selection.selectable_by.includes("customer"));
  if (internalOnly) await reject({ group_id: internalOnly.selection.group_id, item_id: internalOnly.id }, "presentation_choice_invalid");
  await reject({ group_id: "shingle_profile", item_id: "not_a_line" }, "presentation_choice_invalid");
  await reject({ group_id: "another_group", item_id: option.id }, "presentation_choice_invalid");
  await reject({ selections: { shingle_profile: option.id }, unit_price: 1 }, "presentation_choice_invalid");
  await reject([{ id: option.id, unit_price: 1 }], "presentation_input_unknown", "scope_items");
  await assert.rejects(presentations.publicPresentationChange(share.token, { expectedRevision: customer.revision + 5, changes: [{ input: "selections", value: { item_id: option.id } }] }), code("module_revision"));

  customer = any(await presentations.publicPresentationChange(share.token, { expectedRevision: customer.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: option.id } }] }, { ip: "203.0.113.9" }));
  assert.equal(customer.pricing.totals.total_cents - before, expected, "the customer pick changes the total by the price difference");
  assert.equal(shingles(customer).selected, option.id);
  assert.equal(customer.pricing.rows.some((row: any) => row.id === chosen.id), false, "the deselected alternative is no longer priced");
  assert.equal(await documentTotal(document.id), before, "choosing in a presentation does not touch the draft");

  // The salesperson picks a variant on the presented line: finish first, which rules out the default color.
  state = any(await presentations.readPresentation(ctx, state.id));
  const variants = state.offered.variants.find((entry: any) => entry.item_id === option.id);
  const priced = variants.dimensions.flatMap((dimension: any) => dimension.values.map((value: any) => ({ dimension, value }))).find((entry: any) => entry.value.available && !entry.value.selected && entry.value.delta_cents > 0);
  assert.ok(priced, "a priced variant is offered");
  const totalBeforeVariant = state.pricing.totals.total_cents;
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "variants", value: { item_id: variants.item_id, dimension_id: priced.dimension.id, value_id: priced.value.id } }] }));
  assert.equal(state.pricing.totals.total_cents - totalBeforeVariant, priced.value.delta_cents, "a variant moves the total by its stated difference");
  const after = state.offered.variants.find((entry: any) => entry.item_id === variants.item_id);
  assert.equal(after.dimensions.find((dimension: any) => dimension.id === priced.dimension.id).selected, priced.value.id);
  const excluded = after.dimensions.flatMap((dimension: any) => dimension.values.map((value: any) => ({ dimension, value }))).find((entry: any) => !entry.value.available);
  if (excluded) await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "variants", value: { item_id: variants.item_id, dimension_id: excluded.dimension.id, value_id: excluded.value.id } }] }), code("presentation_choice_invalid"));
  await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "variants", value: { item_id: variants.item_id, dimension_id: priced.dimension.id, value_id: "not_offered" } }] }), code("presentation_choice_invalid"));

  const changes = any(await presentations.presentationChanges(ctx, state.id));
  const byCustomer = changes.find((entry: any) => entry.type === "changed" && entry.actor.kind === "customer");
  assert.equal(byCustomer.actor.shareId, share.share.id); assert.equal(byCustomer.actor.ip, "203.0.113.9");
  assert.equal(byCustomer.totalAfterCents - byCustomer.totalBeforeCents, expected);
  // Evidence: what was presented, what was chosen, by whom and when.
  const evidence = byCustomer.changes[0];
  assert.deepEqual([evidence.input, evidence.key, evidence.chosen], ["selections", "group:shingle_profile", option.id]);
  assert.deepEqual(evidence.presented.map((entry: any) => entry.id).sort(), group.options.map((entry: any) => entry.id).sort());
  assert.equal(evidence.presented.find((entry: any) => entry.id === option.id).delta_cents, expected);
  assert.equal(evidence.presented.find((entry: any) => entry.id === chosen.id).selected, true, "the set is recorded as it stood when shown");
  assert.ok(Date.parse(byCustomer.at) > 0);
  assert.equal(changes.find((entry: any) => entry.type === "changed" && entry.actor.kind === "user").actor.userId, auth.userId);
  assert.deepEqual(changes.map((entry: any) => entry.type), ["created", "shared", "changed", "changed"]);

  // Customer finishes; by default staff produce the contract (review).
  const submitted = any(await presentations.publicPresentationSubmit(share.token, { expectedRevision: state.revision }));
  assert.equal(submitted.signing, null); assert.equal(submitted.presentation.status, "submitted");
  state = any(await presentations.readPresentation(ctx, state.id));
  assert.equal(state.submitted.totalCents, state.pricing.totals.total_cents);

  // Contract: the draft takes exactly the presented choices, priced by the document's own code.
  const produced = any(await presentations.producePresentationContract(ctx, state.id, { expectedRevision: state.revision }));
  assert.equal(produced.document.id, document.id); assert.equal(produced.document.status, "draft");
  assert.equal(await documentTotal(document.id), state.pricing.totals.total_cents);
  let contract = any(await documentStore.readDocumentInstance(orgId, document.id));
  const contractLines = contract.params.scope_items[0].children;
  assert.equal(contractLines.find((entry: any) => entry.id === option.id).selection.selected, true);
  assert.equal(contractLines.find((entry: any) => entry.id === chosen.id).selection.selected, false);
  assert.equal(contractLines.find((entry: any) => entry.id === variants.item_id).selected_variants[priced.dimension.id], priced.value.id);
  assert.equal(contractLines.some((entry: any) => entry.selection?.selectable_by?.includes("customer")), false, "the contract's lines are no longer open to customer choice");
  assert.equal(contract.params.customer_choice_count, 0);
  const frozenChoice = contract.params.presented_choices.find((entry: any) => entry.key === "group:shingle_profile");
  assert.equal(frozenChoice.chosen, option.id); assert.equal(frozenChoice.chosen_by.kind, "customer"); assert.equal(frozenChoice.chosen_by.shareId, share.share.id);
  assert.deepEqual(frozenChoice.presented.map((entry: any) => entry.id).sort(), group.options.map((entry: any) => entry.id).sort());
  assert.equal(contract.params.presented_choices.find((entry: any) => entry.key === `variant:${variants.item_id}:${priced.dimension.id}`).chosen_by.userId, auth.userId);
  assert.deepEqual(contract.metadata.presentation_ref.choices, contract.params.presented_choices);
  assert.equal(contract.metadata.presentation_ref.instance_id, state.id);
  assert.equal(contract.metadata.presentation_ref.total_cents, state.pricing.totals.total_cents);
  assert.equal(produced.presentation.contract.current, true);
  // A later choice makes the produced contract stale until it is produced again.
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: produced.presentation.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: chosen.id } }] }));
  assert.equal(state.contract.current, false);
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: option.id } }] }));

  // Send: produce if stale, issue for signature, freeze the presentation, optionally share it alongside.
  const sent = any(await presentations.sendPresentationContract(ctx, state.id, { expectedRevision: state.revision, recipients: [{ name: "Pat Homeowner", email: "pat@example.test", role: "customer" }], consentContact: "support@example.test", sharePresentation: true }));
  assert.equal(sent.document.status, "sent"); assert.equal(sent.presentation.frozen, true); assert.equal(sent.presentation.status, "contracted");
  assert.equal(sent.presentationShare.share.access, "view");
  // One call gives the last slide its signing target for the existing signature widget.
  assert.equal(sent.signTarget.documentId, document.id); assert.deepEqual(sent.signTarget.outputKeys, ["sig_customer"]);
  assert.equal(sent.signTarget.signers[0].token, sent.signing.invitations[0].token);
  assert.equal(sent.presentation.widgetData.w_shingle.writable, false);
  const total = sent.presentation.pricing.totals.total_cents;
  assert.equal(any(await presentations.publicPresentation(sent.presentationShare.token)).pricing.totals.total_cents, total);
  await assert.rejects(presentations.changePresentation(ctx, state.id, { expectedRevision: sent.presentation.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: chosen.id } }] }), code("presentation_frozen"));
  await assert.rejects(presentations.publicPresentationChange(share.token, { expectedRevision: sent.presentation.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: chosen.id } }] }), code("presentation_frozen"));
  await assert.rejects(presentations.producePresentationContract(ctx, state.id, { expectedRevision: sent.presentation.revision }), code("presentation_frozen"));
  await assert.rejects(presentations.sharePresentation(ctx, state.id, { expectedRevision: sent.presentation.revision, access: "choose" }), code("presentation_frozen"));

  // Signing keeps its guarantees: the accepted record is the sent snapshot, and the contract locks.
  const signing = await import("../documents/signing/service.js");
  const access = await signing.publicSigningAccess(sent.signing.invitations[0].token);
  const review = await signing.prepareSigning(access);
  await signing.acceptSigning(access, "sig_customer", { value: { type: "typed", signer_name: "Pat Homeowner" }, challenge: review.challenge, content_hash: review.content_hash, consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: review.disclosure.hash } });
  contract = any(await documentStore.readDocumentInstance(orgId, document.id));
  assert.ok(["signed", "completed"].includes(contract.status) || Object.keys(contract.outputs).includes("sig_customer"));
  const snapshot = any(await documentStore.readDocumentSnapshot(orgId, contract.delivery.current_snapshot_id));
  assert.equal(snapshot.params.scope_items[0].children.find((entry: any) => entry.id === option.id).selection.selected, true);
  assert.equal(snapshot.params.presented_choices.find((entry: any) => entry.key === "group:shingle_profile").chosen, option.id, "the signed snapshot carries what was presented and chosen");
  assert.equal((await documents.documentCheckoutPricing(orgId, contract, snapshot.params, {})).totals.total_cents, total, "the signed snapshot totals what was presented");
  await assert.rejects(documents.patchDocumentInstance(orgId, document.id, { params: { scope_items: [generated] } }, auth), code("document_locked_signed"));
  assert.equal(any(await presentations.readPresentation(ctx, state.id)).pricing.totals.total_cents, total, "the frozen presentation still shows what was signed");
});

test("the presentation is optional: straight to the document, or a presentation the customer completes alone", async () => {
  // Send estimate, skipping the presentation: the existing path, untouched.
  const skipped = await draft();
  const sentDirectly = any(await documents.sendDocument(orgId, skipped.id, { recipients: [{ name: "Pat Homeowner", email: "pat@example.test", role: "customer" }], consent_contact: "support@example.test" }, auth));
  assert.equal(sentDirectly.document.status, "sent");
  assert.deepEqual(any(await presentations.documentPresentationOptions(ctx, skipped.id)).presentations, []);
  await assert.rejects(presentations.createPresentation(ctx, { documentId: skipped.id }), code("presentation_source_not_draft"));

  // Send presentation, direct contract: the customer chooses and continues into signing.
  const direct = await presentations.publishPresentation(ctx, presentations.scopePresentationDefinition({ name: "Self-serve roof", layout: slides(), customerContract: "direct" }));
  const document = await draft();
  let state = any(await presentations.createPresentation(ctx, { documentId: document.id, moduleId: String(direct.id) }));
  await assert.rejects(presentations.sharePresentation(ctx, state.id, { expectedRevision: state.revision, access: "choose", recipients: [], contract: { consentContact: "support@example.test" } }), code("signature_recipient_required"));
  const share = any(await presentations.sharePresentation(ctx, state.id, { expectedRevision: state.revision, access: "choose", deliver: true, recipients: [{ name: "Pat Homeowner", email: "pat@example.test", role: "customer" }], contract: { consentContact: "support@example.test" } }));
  assert.equal(share.share.contract.mode, "direct");
  let customer = any(await presentations.publicPresentation(share.token));
  const option = shingles(customer).options.find((entry: any) => !entry.selected && entry.delta_cents !== 0);
  customer = any(await presentations.publicPresentationChange(share.token, { expectedRevision: customer.revision, changes: [{ input: "selections", value: { group_id: "shingle_profile", item_id: option.id } }] }));
  const submitted = any(await presentations.publicPresentationSubmit(share.token, { expectedRevision: customer.revision }));
  assert.match(submitted.signing.portalUrl, /\/v1\/documents\/public\//);
  assert.equal(submitted.signTarget.documentId, document.id);
  assert.equal(submitted.presentation.frozen, true); assert.equal(submitted.presentation.contract.state, "sent");
  const contract = any(await documentStore.readDocumentInstance(orgId, document.id));
  assert.equal(contract.status, "sent");
  assert.equal(await documentTotal(document.id), customer.pricing.totals.total_cents);
  state = any(await presentations.readPresentation(ctx, state.id));
  assert.deepEqual(any(await presentations.presentationChanges(ctx, state.id)).map((entry: any) => [entry.type, entry.actor.kind]), [["created", "user"], ["shared", "user"], ["changed", "customer"], ["contract_produced", "customer"], ["contract_sent", "customer"]]);

  // A voided contract reopens its presentation; a source edited in the workflow is recaptured on refresh.
  const reopened = await draft();
  state = any(await presentations.createPresentation(ctx, { documentId: reopened.id }));
  const first = shingles(state).options.find((entry: any) => !entry.selected);
  state = any(await presentations.changePresentation(ctx, state.id, { expectedRevision: state.revision, changes: [{ input: "selections", value: { item_id: first.id } }] }));
  const trimmed = { ...generated, children: generated.children.filter((entry: any) => entry.id !== first.id) };
  await documents.patchDocumentInstance(orgId, reopened.id, { params: { scope_items: [trimmed] } }, auth);
  state = any(await presentations.evaluatePresentation(ctx, state.id, { expectedRevision: state.revision, refresh: true }));
  assert.equal(shingles(state)?.options.some((entry: any) => entry.id === first.id) || false, false);
  assert.equal(state.exports.selections.shingle_profile, undefined, "a pick the source no longer offers is dropped");
  assert.equal(state.pricing.totals.total_cents, await documentTotal(reopened.id));
});

test("a module workflow's export can seed a presentation that produces a new contract", async () => {
  const workflow = await modules.publishModule(ctx, { name: "Estimate workflow", kind: "workflow", inputSchema: { type: "object" }, outputSchema: { type: "object" }, exports: { estimate: { path: "/outputs/estimate", schema: { type: "object" }, access: "read" } },
    source: "return { outputs: { estimate: { scope_items: inputs.scope_items, tax_percent: 0 } } };" });
  let instance = await modules.createModuleInstance(ctx, { moduleId: String(workflow.id), projectId, inputs: { scope_items: [generated] } });
  instance = (await modules.evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision })).instance as typeof instance;
  const presentation = await presentations.publishPresentation(ctx, presentations.scopePresentationDefinition({ name: "From workflow", layout: slides(), contract: { template_id: "tpl_instant_roofing_detailed", document_type: "proposal" } }));
  const state = any(await presentations.createPresentation(ctx, { projectId, source: { instanceId: instance.id, exportName: "estimate" }, moduleId: String(presentation.id) }));
  assert.equal(state.source.kind, "module"); assert.equal(state.ready, true);
  const produced = any(await presentations.producePresentationContract(ctx, state.id, { expectedRevision: state.revision }));
  assert.equal(produced.document.status, "draft");
  assert.equal(await documentTotal(produced.document.id), state.pricing.totals.total_cents);
  // Presentation state is typed data for other consumers through the existing provider.
  const exported = any(await modules.getModuleExports(ctx, state.id, "pricing"));
  assert.equal(exported.value.totals.total_cents, state.pricing.totals.total_cents);
  assert.equal(exported.provenance.kind, "presentation");
  await assert.rejects(modules.getModuleExports(ctx, state.id, "scope_items"), code("module_export_private"));
  await assert.rejects(modules.updateModuleInputs(ctx, state.id, { scope_items: [] }, produced.presentation.revision), code("module_presentation_route"));
  await assert.rejects(modules.evaluateModuleInstance(ctx, state.id, { expectedRevision: produced.presentation.revision }), code("module_presentation_route"));
});

test("published actions and HTTP routes share the service's contract", async () => {
  const { invokeAction } = await import("../platform/publication/actions.js");
  const api = (await import("../platform/publication/context.js")).userPublicationContext(auth, { executionKind: "api", mode: "command" });
  const document = await draft(), target = { scope: "project" as const, organizationId: orgId, projectId };
  const created = any((await invokeAction(api, { action: "document-modules.presentation.create", target }, { documentId: document.id }, { idempotencyKey: "create-1" })).value);
  assert.equal(created.ready, true);
  const denied = { ...api, auth: { ...auth, userId: "limited", role: "member", permissions: { view_projects: true } } as any };
  await assert.rejects(invokeAction(denied, { action: "document-modules.presentation.create", target }, { documentId: document.id }, { idempotencyKey: "create-2" }), code("publication_permission_denied"));
  const state = any(await presentations.readPresentation(ctx, created.id));
  const option = shingles(state).options.find((entry: any) => !entry.selected && entry.delta_cents !== 0);
  const written = any((await invokeAction(api, { action: "document-modules.presentation.input.write", target: { ...target, id: created.id } }, { expectedRevision: created.revision, changes: [{ input: "selections", value: { item_id: option.id } }] }, { idempotencyKey: "write-1" })).value);
  assert.equal(written.pricing.totals.total_cents - created.pricing.totals.total_cents, option.delta_cents);
  const shared = any((await invokeAction(api, { action: "document-modules.presentation.share", target: { ...target, id: created.id } }, { expectedRevision: written.revision, access: "choose", recipients: [{ name: "Pat", email: "pat@example.test" }] }, { idempotencyKey: "share-1" })).value);
  assert.equal(JSON.stringify(shared).includes("pl1."), false, "programmable callers never receive the bearer token");

  const { buildApp } = await import("../src/app.js");
  app = await buildApp(); await app.ready();
  const client = await operatorFixtureClient(app, orgId), base = `/v1/document-modules/organizations/${orgId}`;
  assert.equal((await app.inject({ method: "GET", url: `${base}/presentations/${created.id}` })).statusCode, 401);
  const read = (await client.request("GET", `${base}/presentations/${created.id}`)).presentation;
  assert.equal(read.revision, shared.revision);
  assert.equal((await client.request("GET", `${base}/documents/${document.id}/presentation`)).presentations[0].id, created.id);
  assert.equal((await client.request("GET", `${base}/presentation-modules`)).modules.some((module: any) => module.id === moduleId), true);
  const stale = await client.raw("PATCH", `${base}/presentations/${created.id}/inputs`, { expectedRevision: 1, input: "selections", value: { item_id: option.id } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().error, "module_revision");
  const link = await client.raw("POST", `${base}/presentations/${created.id}/shares`, { expectedRevision: read.revision, access: "choose" });
  assert.equal(link.statusCode, 201); assert.equal(link.headers["cache-control"], "no-store");
  const token = link.json().token, publicUrl = `/v1/document-modules/public/presentations/${encodeURIComponent(token)}`;
  const shown = await app.inject({ method: "GET", url: publicUrl });
  assert.equal(shown.statusCode, 200); assert.equal(shown.json().presentation.audience, "customer");
  const original = shingles(shown.json().presentation).options.find((entry: any) => !entry.selected);
  const picked = await app.inject({ method: "PATCH", url: `${publicUrl}/inputs`, payload: { expectedRevision: shown.json().presentation.revision, input: "selections", value: { item_id: original.id } } });
  assert.equal(picked.statusCode, 200); assert.equal(shingles(picked.json().presentation).selected, original.id);
  assert.equal((await app.inject({ method: "PATCH", url: `${publicUrl}/inputs`, payload: { expectedRevision: picked.json().presentation.revision, input: "selections", value: { item_id: "nope" } } })).json().error, "presentation_choice_invalid");
  assert.equal((await app.inject({ method: "GET", url: "/v1/document-modules/public/presentations/pl1.bad.token" })).statusCode, 404);
  const producedOverHttp = await client.request("POST", `${base}/presentations/${created.id}/contract`, { expectedRevision: picked.json().presentation.revision });
  assert.equal(producedOverHttp.document.id, document.id);
  assert.equal((await client.request("GET", `${base}/presentations/${created.id}/changes`)).changes.at(-1).type, "contract_produced");
});
