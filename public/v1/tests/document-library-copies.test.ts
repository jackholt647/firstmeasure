import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Organizations' copies of the config library's document defaults (documents/library-copies.ts): how each copy
// stands, an untouched copy following the library, an edited one left alone until it is reset, copies from before the
// library, decks, retirement, price book rates, and the kinds' checks on a broken edit.

type Json = Record<string, any>;
let storageRoot = "";
before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "document-library-copies-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: storageRoot, PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(storageRoot, "sandbox"), FIRSTMEASURE_DATA_ENVIRONMENT: "development", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", V1_LOG_LEVEL: "error", CONFIG_LIBRARY_SOURCE: "snapshot" });
});
after(async () => {
  (await import("../config-library/library.js")).resetLibraryForTests();
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

let fixture: Promise<Json> | null = null;
function organization() {
  fixture ||= (async () => {
    const signup = await import("../signup-sandbox/service.js");
    await signup.ensureSeedData();
    const { authContext } = await signup.createTestInstance("swf_instant_full_org");
    await (await import("../platform/app-experience/activation.js")).startOfferedApp(authContext, "project.docs");
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    const ctx = await (await import("../platform/auth.js")).buildAuthContext(authContext.sessionId, authContext.session);
    const library = await import("../config-library/library.js");
    (await import("../config-library/kinds/index.js")).registerAllLibraryKinds();
    return { ctx, library, copies: await import("../documents/library-copies.js"), store: await import("../documents/storage.js"), kinds: await import("../config-library/kinds.js") };
  })();
  return fixture;
}
/** A newer library revision of an entry, as an edit on dev would make it (in this process only). */
function revise(library: Json, kind: string, id: string, change: (data: Json) => void) {
  const entry = library.libraryEntry(kind, id);
  const data = structuredClone(entry.data);
  change(data);
  library.applyLibraryChange({ ...entry, data, revision: entry.revision + 1, sha256: `${entry.sha256.slice(0, 56)}${String(entry.revision + 1).padStart(8, "0")}` });
  return library.libraryEntry(kind, id);
}
const state = async (kind: Json, orgId: string, id: string) => (await kind.orgCopies.status(orgId, [id]))[0];

test("a new organization's copies are the library's, with the price book's rate and the deck its workflow presents", async () => {
  const { ctx, kinds, store } = await organization();
  const template = kinds.libraryKind("document_template");
  const status = await template.orgCopies.status(ctx.orgId);
  assert.ok(status.filter((row: Json) => !["tpl_kitchen_estimate", "tpl_kitchen_selections", "tpl_same_day_service_authorization", "tpl_operations_scope_v1", "tpl_operations_proposal_v1"].includes(row.id)).every((row: Json) => row.state === "library"), JSON.stringify(status));
  assert.equal(status.find((row: Json) => row.id === "tpl_kitchen_estimate").state, "missing", "a scope's own template waits until the scope issues it");
  for (const name of ["document_theme", "document_workflow", "presentation_deck"]) {
    const rows = await kinds.libraryKind(name).orgCopies.status(ctx.orgId);
    assert.ok(rows.some((row: Json) => row.state === "library"), `${name} copies are made`);
  }
  // The per-square rate comes from the organization's price book (GAF Timberline HDZ at $398), not the library.
  const quick = await store.readDocumentTemplate(ctx.orgId, "tpl_instant_roofing_quick");
  const version = await store.readDocumentTemplateVersion(ctx.orgId, "tpl_instant_roofing_quick", Number(quick.current_version));
  assert.equal(version.definition.params.rate_cents.default, 39800);
  const workflow = await store.readDocumentWorkflow(ctx.orgId, "wfl_instant_roofing_quick");
  assert.equal((await store.readDocumentWorkflowVersion(ctx.orgId, workflow.id, Number(workflow.current_version))).definition.contract.params.rate_cents.default, 39800);
  assert.equal(quick.metadata.preset, true);
  assert.deepEqual(Object.keys(quick.metadata.library).sort(), ["id", "kind", "revision", "sha256"]);
});

test("an untouched copy follows a newer library revision; an edited one is left alone until it is reset", async () => {
  const { ctx, copies, library, kinds, store } = await organization();
  const template = kinds.libraryKind("document_template");
  const before = await store.readDocumentTemplate(ctx.orgId, "tpl_invoice_default");
  // Edited by the organization: a publish of its own.
  const own = await store.readDocumentTemplate(ctx.orgId, "tpl_change_order_default");
  const ownVersion = await store.readDocumentTemplateVersion(ctx.orgId, own.id, Number(own.current_version));
  await store.publishDocumentTemplate(ctx.orgId, own.id, { definition: ownVersion.definition, expected_version: Number(own.current_version) }, ctx);
  assert.equal((await state(template, ctx.orgId, own.id)).state, "changed");

  const invoice = revise(library, "document_template", "tpl_invoice_default", (data) => { data.description = "Bill a payment."; });
  revise(library, "document_template", "tpl_change_order_default", (data) => { data.description = "Changed work."; });
  assert.equal((await state(template, ctx.orgId, "tpl_invoice_default")).state, "behind");
  await copies.ensureDefaultDocumentAssets(ctx.orgId, ctx, { refresh: true });
  const upgraded = await store.readDocumentTemplate(ctx.orgId, "tpl_invoice_default");
  assert.equal(Number(upgraded.current_version), Number(before.current_version) + 1, "republished once");
  assert.equal(upgraded.metadata.library.revision, invoice.revision);
  assert.equal((await state(template, ctx.orgId, "tpl_invoice_default")).state, "library");
  await copies.ensureDefaultDocumentAssets(ctx.orgId, ctx, { refresh: true });
  assert.equal(Number((await store.readDocumentTemplate(ctx.orgId, "tpl_invoice_default")).current_version), Number(upgraded.current_version), "a current copy is not republished");

  const edited = await store.readDocumentTemplate(ctx.orgId, own.id);
  assert.equal(edited.current_version, Number(own.current_version) + 1, "the organization's edit is kept");
  assert.equal(edited.metadata.preset, false);
  // Reset puts the library version back, as an upgrade would, and the copy follows the library again.
  await template.orgCopies.reset(ctx, own.id);
  const reset = await store.readDocumentTemplate(ctx.orgId, own.id);
  assert.equal(reset.metadata.preset, true);
  assert.equal((await state(template, ctx.orgId, own.id)).state, "library");
});

test("a copy from before the library is stamped, not republished; an older one is upgraded", async () => {
  const { ctx, copies, kinds, store } = await organization();
  const workflow = kinds.libraryKind("document_workflow");
  const current = await store.readDocumentWorkflow(ctx.orgId, "wfl_invoice");
  // As documents/seeds.ts left it at DOCUMENT_PRESET_REVISION 38.
  await store.patchDocumentWorkflow(ctx.orgId, "wfl_invoice", { metadata: { library: null, preset_revision: 38 } }, ctx);
  const older = await store.readDocumentWorkflow(ctx.orgId, "wfl_change_order");
  await store.patchDocumentWorkflow(ctx.orgId, "wfl_change_order", { metadata: { library: null, preset_revision: 30 } }, ctx);
  assert.equal((await state(workflow, ctx.orgId, "wfl_invoice")).state, "library");
  assert.equal((await state(workflow, ctx.orgId, "wfl_change_order")).state, "behind");
  await copies.ensureDefaultDocumentAssets(ctx.orgId, ctx, { refresh: true });
  const stamped = await store.readDocumentWorkflow(ctx.orgId, "wfl_invoice");
  assert.equal(stamped.current_version, current.current_version);
  assert.ok(stamped.metadata.library?.sha256);
  assert.equal(Number((await store.readDocumentWorkflow(ctx.orgId, "wfl_change_order")).current_version), Number(older.current_version) + 1);
});

test("a deck the organization published itself is its own until reset; a newer library deck reaches an untouched copy", async () => {
  const { ctx, copies, library, kinds } = await organization();
  const deck = kinds.libraryKind("presentation_deck");
  const presentations = await import("../documents/modules/presentation-service.js");
  const publication = await import("../platform/publication/context.js");
  const pctx = publication.userPublicationContext(ctx, { executionKind: "module" });
  assert.equal((await state(deck, ctx.orgId, "roofing_gutters")).state, "library");
  const entry = library.libraryEntry("presentation_deck", "roofing_gutters");
  await presentations.publishPresentation(pctx, presentations.scopePresentationDefinition({ name: "Our gutter deck", layout: structuredClone(entry.data.layout) }), "preset_presentation_roofing_gutters");
  assert.equal((await state(deck, ctx.orgId, "roofing_gutters")).state, "changed");
  revise(library, "presentation_deck", "roofing_gutters", (data) => { data.name = "Gutters"; });
  assert.equal((await copies.ensureLibraryDeck(ctx.orgId, "roofing_gutters"))?.published, false, "an edited deck is never overwritten");
  await deck.orgCopies.reset(ctx, "roofing_gutters");
  assert.equal((await state(deck, ctx.orgId, "roofing_gutters")).state, "library");
  revise(library, "presentation_deck", "roofing_options", (data) => { data.name = "Three roofs"; });
  assert.equal((await state(deck, ctx.orgId, "roofing_options")).state, "behind");
  assert.equal((await copies.ensureLibraryDeck(ctx.orgId, "roofing_options"))?.published, true);
  assert.equal((await state(deck, ctx.orgId, "roofing_options")).state, "library");
});

test("an entry deleted from the library retires its untouched copies", async () => {
  const { ctx, copies, library, store } = await organization();
  const entry = library.libraryEntry("document_template", "tpl_money_report_default");
  library.applyLibraryChange({ kind: "document_template", id: entry.id, revision: entry.revision + 1, deleted: true });
  try {
    await copies.ensureDefaultDocumentAssets(ctx.orgId, ctx, { refresh: true });
    assert.equal((await store.readDocumentTemplate(ctx.orgId, "tpl_money_report_default")).status, "archived");
  } finally {
    library.resetLibraryForTests();
  }
});

test("the document kinds refuse a broken edit, cheaply", async () => {
  const { library } = await organization();
  (await import("../config-library/kinds/index.js")).registerAllLibraryKinds();
  const { checkEntry } = await import("../config-library/writes.js");
  const template = structuredClone(library.libraryEntry("document_template", "tpl_invoice_default").data);
  assert.deepEqual(checkEntry("document_template", "tpl_invoice_default", template).errors, []);
  const broken = structuredClone(template);
  broken.definition.theme_ref.theme_id = "thm_missing";
  broken.metadata.default_workflow_id = "wfl_missing";
  broken.pricebook_defaults = [{ param: "no_such_param", item_id: "gaf_hd" }];
  const errors = checkEntry("document_template", "tpl_invoice_default", broken).errors.join("\n");
  assert.match(errors, /no document theme thm_missing/);
  assert.match(errors, /no document workflow wfl_missing/);
  assert.match(errors, /no parameter no_such_param/);
  assert.ok(checkEntry("document_template", "x", { ...template, typo: 1 }).errors.length, "unknown fields are refused");
  const workflow = structuredClone(library.libraryEntry("document_workflow", "wfl_instant_roofing_detailed").data);
  workflow.definition.completion.presentation.module_id = "preset_presentation_roofing_missing";
  workflow.definition.steps[0].items[0].kind = "no_such_item";
  const workflowErrors = checkEntry("document_workflow", "wfl_instant_roofing_detailed", workflow).errors.join("\n");
  assert.match(workflowErrors, /no presentation deck roofing_missing/);
  assert.match(workflowErrors, /Unknown workflow item kind/);
  // Saves stay fast: the largest entry (a deck) is checked in well under a few hundred milliseconds.
  const deck = structuredClone(library.libraryEntry("presentation_deck", "roofing_itemized").data);
  const started = performance.now();
  assert.deepEqual(checkEntry("presentation_deck", "roofing_itemized", deck).errors, []);
  assert.ok(performance.now() - started < 300, `a deck check took ${Math.round(performance.now() - started)} ms`);
});
