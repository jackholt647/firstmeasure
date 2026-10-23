import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { FMDocModel } from "../documents/schemas.js";
import { scopeItemPriceResult } from "../proposals/scope.js";

// Editing a document as sent (docs/architecture/document-as-sent-editing.md):
// the rendered document's values come from data and can be typed into, the
// rest of its text is overridden on the document with its bindings kept live,
// and the PDF is rendered from the same resolution.

type Line = Record<string, any>;
const measurements = { roofSquares: 29.6, wastePercent: 10, eavesLf: 197.25, rakesLf: 208.6, ridgesLf: 93.4, hipsLf: 0, valleyLf: 16.2, sideWallLf: 82.8, headWallLf: 4.5 };

let storageRoot = "";
let fixture: Promise<Record<string, any>> | null = null;
before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "doc-as-sent-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: storageRoot, PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(storageRoot, "sandbox"), FIRSTMEASURE_DATA_ENVIRONMENT: "development", EMAIL_OUTBOUND_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", V1_LOG_LEVEL: "error" });
});
after(async () => {
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

function organization() {
  fixture ||= (async () => {
    const signup = await import("../signup-sandbox/service.js");
    await signup.ensureSeedData();
    const { authContext: ctx } = await signup.createTestInstance("swf_instant_full_org");
    const project = await (await import("./helpers/project-contacts.js")).upsertProjectWithContacts(ctx.orgId, { id: "project_as_sent", data: { title: "Whitfield residence", branch_id: "default", address: "68 Northfield Rd", contacts: [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }] } });
    const publication = await import("../platform/publication/context.js");
    (await import("../platform/publication/bootstrap.js")).initializePublication();
    return { ctx, projectId: String(project.id), service: await import("../documents/service.js"), store: await import("../documents/storage.js"), pctx: publication.userPublicationContext(ctx, { executionKind: "api" }) };
  })();
  return fixture;
}

async function generatedScope(pctx: any, orgId: string) {
  const actions = await import("../platform/publication/actions.js");
  return (await actions.invokeAction(pctx, { action: "pricebook.scope.generate", target: { scope: "organization" as const, organizationId: orgId } }, { templateId: "roof_replacement", measurements })).value as Line;
}

/** Every run in a resolved definition with the node it sits in. */
function runs(definition: Line) {
  const found: Array<{ node: Line; run: Line; block: number; index: number }> = [];
  FMDocModel.walkNodes(definition, (node: Line) => {
    (node.props?.blocks || []).forEach((block: Line, blockIndex: number) => (block.runs || []).forEach((run: Line, index: number) => found.push({ node, run, block: blockIndex, index })));
  });
  return found;
}
const textOf = (definition: Line) => runs(definition).map((entry) => String(entry.run.text || "")).join(" ");
const money = (cents: number) => FMDocModel.formatters.money(cents) as string;
const total = (resolved: Line) => Number(resolved.resolved_definition.computed_values.total_cents);

test("a quantity typed into the rendered estimate updates the line, every total and the PDF", async () => {
  const { ctx, projectId, service, store, pctx } = await organization();
  const root = await generatedScope(pctx, ctx.orgId);
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_detailed", params: { scope_items: [root] } }, ctx) as Line;
  const id = String(document.id);
  const traced = await service.resolveDocumentInstance(ctx.orgId, document, { trace: true }) as Line;
  const plain = await service.resolveDocumentInstance(ctx.orgId, document) as Line;
  assert.equal(textOf(traced.resolved_definition), textOf(plain.resolved_definition), "tracing never changes what the document says");

  // Every repeated line row points at the scope item it shows.
  const quantities = runs(traced.resolved_definition).filter((entry) => /^params\.scope_items\.0\.children\.\d+\.quantity$/.test(String(entry.run.binding?.path || "")));
  assert.ok(quantities.length >= 5, "each line's quantity is an input");
  assert.ok(quantities.every((entry) => entry.run.binding.kind === "input" && entry.node.generated === true));
  const totals = runs(traced.resolved_definition).filter((entry) => entry.run.binding?.path === "computed.total_cents");
  assert.ok(totals.length && totals.every((entry) => entry.run.binding.kind === "derived"), "the total is calculated, not typed");
  const groupAmount = runs(traced.resolved_definition).find((entry) => entry.run.binding?.path === "params.scope_items.0.amount_cents");
  if (groupAmount) assert.equal(groupAmount.run.binding.kind, "derived", "a group line's amount is the sum of its lines");

  const target = quantities[0]!;
  const path = String(target.run.binding.path);
  const lineIndex = Number(path.split(".")[4]);
  const line = root.children[lineIndex] as Line;
  const before = total(traced);
  const oldOwn = scopeItemPriceResult(line).own_amount_cents;
  const nextQuantity = Number(line.quantity) + 4;
  const written = await service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path, text: `${nextQuantity} sq` }] }, ctx) as Line;

  const saved = await store.readDocumentInstance(ctx.orgId, id) as Line;
  const savedLine = saved.params.scope_items[0].children[lineIndex];
  assert.equal(savedLine.quantity, nextQuantity, "the scope item itself changed");
  const newOwn = scopeItemPriceResult(savedLine).own_amount_cents;
  assert.equal(newOwn, Math.round(nextQuantity * Math.round(Number(line.unit_price) * 100)));
  assert.equal(total(written.resolved), before + newOwn - oldOwn, "the totals follow the line");
  assert.ok(Number(saved.revision) > Number(document.revision), "the write is a document revision");

  // The PDF is rendered from the static resolution through this harness.
  const pdfResolution = await service.resolveDocumentInstance(ctx.orgId, saved, { target: "static" }) as Line;
  const { buildRenderHarnessHtml } = await import("../documents/render.js");
  const html = await buildRenderHarnessHtml({ resolved_definition: pdfResolution.resolved_definition, theme: pdfResolution.theme, themeContext: pdfResolution.theme_context, widgetData: pdfResolution.widget_data, scope: pdfResolution.scope });
  assert.ok(html.includes(JSON.stringify(money(total(written.resolved))).slice(1, -1)), "the PDF prints the new total");

  // A line's amount is stored as its price; the total moves by exactly the difference.
  const amountPath = path.replace(/quantity$/, "amount_cents");
  const amounts = runs(written.resolved.resolved_definition).filter((entry) => entry.run.binding?.path === amountPath);
  assert.ok(amounts.length, "the line prints its amount");
  {
    assert.equal(amounts[0]!.run.binding.kind, "input");
    const typed = 123457;
    const repriced = await service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path: amountPath, text: "$1,234.57" }] }, ctx) as Line;
    const repricedLine = (await store.readDocumentInstance(ctx.orgId, id) as Line).params.scope_items[0].children[lineIndex];
    assert.equal(scopeItemPriceResult(repricedLine).own_amount_cents, typed, "the line now costs what was typed");
    assert.equal(total(repriced.resolved), total(written.resolved) + typed - newOwn);
  }

  // Calculated values and projections are not inputs.
  await assert.rejects(service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path: "computed.total_cents", text: "1" }] }, ctx), /not an input/);
  await assert.rejects(service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path: "params.scope_rows.1.quantity", text: "1" }] }, ctx), /not an input/);
  await assert.rejects(service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path, text: "lots" }] }, ctx), /number/);
});

test("text edited as sent is an override that keeps its values live and is flagged when the template changes", async () => {
  const { ctx, projectId, service, store } = await organization();
  const template = await store.createDocumentTemplate(ctx.orgId, {
    name: "Service summary", document_type: "work_order", status: "active",
    definition: summaryTemplate("Labor for this visit")
  }, ctx) as Line;
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "work_order", template_id: template.id, params: { hours: 3, rate_cents: 9500, note: "Bring the tall ladder" } }, ctx) as Line;
  const id = String(document.id);
  const first = await service.resolveDocumentInstance(ctx.orgId, document, { trace: true }) as Line;
  const node = FMDocModel.findNode(first.resolved_definition, "summary")!.node as Line;
  assert.deepEqual(node.as_sent, { fingerprint: node.as_sent.fingerprint, edited: false, conflict: false });
  // "Labor: {{params.hours}} hours ..." is split into literal and bound runs.
  const kinds = node.props.blocks[0].runs.map((run: Line) => run.binding?.kind || "text");
  assert.deepEqual(kinds, ["text", "input", "text", "input", "text", "derived"]);
  assert.equal(node.props.blocks[0].runs.map((run: Line) => run.text).join(""), `Labor: 3 hours at ${money(9500)} = ${money(28500)}`);

  // Edit the words around the values, as the editor does, and save the override.
  const edited = FMDocModel.deepClone(node.props.blocks) as Line[];
  edited[0]!.runs[0].text = "Time on site: ";
  edited[0]!.runs[4].text = " total ";
  const blocks = FMDocModel.boundBlocksToTemplate(edited);
  assert.equal(blocks[0]!.runs[1].bind, "params.hours", "the value stays a binding");
  await service.patchDocumentInstance(ctx.orgId, id, { overrides: [{ op: "node.set", node_id: "summary", prop: "props.blocks", value: blocks, base: node.as_sent.fingerprint }] }, ctx);

  // Data changes later: the edited text shows the new values.
  await service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path: "params.hours", text: "5" }] }, ctx);
  const later = await service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, id), { trace: true }) as Line;
  const laterNode = FMDocModel.findNode(later.resolved_definition, "summary")!.node as Line;
  assert.equal(laterNode.props.blocks[0].runs.map((run: Line) => run.text).join(""), `Time on site: 5 hours at ${money(9500)} total ${money(47500)}`);
  assert.equal(laterNode.as_sent.edited, true);
  assert.equal(laterNode.as_sent.conflict, false);

  // The template's own text changes: the edit is kept, and flagged.
  await store.publishDocumentTemplate(ctx.orgId, String(template.id), { definition: summaryTemplate("Labor today", "Work"), expected_version: 1 }, ctx);
  const changed = await service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, id), { trace: true }) as Line;
  const changedNode = FMDocModel.findNode(changed.resolved_definition, "summary")!.node as Line;
  assert.match(changedNode.props.blocks[0].runs[0].text, /^Time on site/, "an edit is never silently dropped");
  assert.equal(changedNode.as_sent.conflict, true);
  assert.equal(FMDocModel.findNode(changed.resolved_definition, "heading")!.node.props.blocks[0].runs[0].text, "Labor today", "untouched text follows the template");
});

test("a value typed over another record's data is kept and flagged when the record changes", async () => {
  const { ctx, projectId, service, store } = await organization();
  const template = await store.createDocumentTemplate(ctx.orgId, { name: "Visit card", document_type: "generic", status: "active", definition: summaryTemplate("Visit") }, ctx) as Line;
  const { document } = await service.createDocumentInstance(ctx.orgId, projectId, { document_type: "generic", template_id: template.id, params: { hours: 1, rate_cents: 100 } }, ctx) as Line;
  const id = String(document.id);
  const traced = await service.resolveDocumentInstance(ctx.orgId, document, { trace: true }) as Line;
  const site = FMDocModel.findNode(traced.resolved_definition, "site")!.node as Line;
  const bound = site.props.blocks[0].runs.find((run: Line) => run.binding);
  assert.equal(bound.binding.kind, "upstream", "the project title belongs to the project");
  await assert.rejects(service.writeDocumentInputs(ctx.orgId, id, { writes: [{ path: String(bound.binding.path), text: "x" }] }, ctx), /not an input/);
  // Typed over in this document only (as the editor's "Type over it here" saves it).
  const typed = FMDocModel.deepClone(site.props.blocks) as Line[];
  const runIndex = typed[0]!.runs.findIndex((run: Line) => run.binding);
  typed[0]!.runs[runIndex] = { text: "The Whitfields' house", binding: { kind: "pinned", expr: bound.binding.expr, value: bound.text } };
  await service.patchDocumentInstance(ctx.orgId, id, { overrides: [{ op: "node.set", node_id: "site", prop: "props.blocks", value: FMDocModel.boundBlocksToTemplate(typed), base: site.as_sent.fingerprint }] }, ctx);
  const pinned = async () => service.resolveDocumentInstance(ctx.orgId, await store.readDocumentInstance(ctx.orgId, id), { trace: true }).then((resolved: Line) => FMDocModel.findNode(resolved.resolved_definition, "site")!.node.props.blocks[0].runs[runIndex]);
  assert.deepEqual([(await pinned()).text, (await pinned()).binding.conflict], ["The Whitfields' house", false]);
  const { upsertProjectWithContacts } = await import("./helpers/project-contacts.js");
  await upsertProjectWithContacts(ctx.orgId, { id: projectId, data: { title: "Whitfield residence (rear)", branch_id: "default", address: "68 Northfield Rd", contacts: [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }] } });
  const after = await pinned();
  assert.equal(after.text, "The Whitfields' house", "the typed value stays");
  assert.equal(after.binding.conflict, true);
  assert.equal(after.binding.current, "Whitfield residence (rear)");
});

test("doc-model: provenance through components, repeaters and typed text", () => {
  const doc = FMDocModel.createDocument() as Line;
  doc.components = { row: { params: { item: { type: "pricebook_line" } }, root: FMDocModel.createNode("text", { props: { blocks: [{ runs: [{ bind: "coalesce(item.display_name, item.name)" }, { bind: "(item.show ? (item.amount_cents | money) : 'Included')" }] }] } }) } };
  doc.pages[0].children.push(FMDocModel.createNode("repeater", { id: "rows", props: { source: "{{coalesce(params.rows, params.items)}}", component: "row", as: "row" } }));
  const resolved = FMDocModel.resolveBindings(doc, { params: { items: [{ name: "Ridge vent", show: true, amount_cents: 4200 }, { name: "Nails", display_name: "Coil nails", show: false }] } }, { trace: true }) as Line;
  const [first, second] = resolved.pages[0].children[0].children as Line[];
  assert.deepEqual(first!.props.blocks[0].runs.map((run: Line) => [run.text, run.binding.path, run.binding.format]), [["Ridge vent", "params.items.0.name", null], ["$42.00", "params.items.0.amount_cents", "money"]]);
  assert.deepEqual(second!.props.blocks[0].runs.map((run: Line) => [run.text, run.binding.path]), [["Coil nails", "params.items.1.display_name"], ["Included", null]]);
  assert.deepEqual(FMDocModel.parseBoundInput("$1,250.5", { format: "money" }), { ok: true, value: 125050 });
  assert.deepEqual(FMDocModel.parseBoundInput("12.5 sq", { format: "qty" }), { ok: true, value: 12.5 });
  assert.equal(FMDocModel.parseBoundInput("abc", { format: "qty" }).ok, false);
  // Text a person types is literal, never an expression.
  const back = FMDocModel.boundBlocksToTemplate([{ runs: [{ text: "Use {{params.secret}} here" }] }]) as Line[];
  assert.equal(back[0]!.runs[0].literal, true);
  const shown = FMDocModel.resolveBindings({ ...doc, pages: [{ ...doc.pages[0], children: [FMDocModel.createNode("text", { props: { blocks: back } })] }] } as Line, { params: { secret: "x" } }) as Line;
  assert.equal(shown.pages[0].children[0].props.blocks[0].runs[0].text, "Use {{params.secret}} here");
});

/** A small non-estimate template: a heading, a summary computed from params, the site. */
function summaryTemplate(heading: string, label = "Labor") {
  const doc = FMDocModel.createDocument({ metadata: { document_type: "work_order" } }) as Line;
  doc.params = { hours: { type: "number", label: "Hours" }, rate_cents: { type: "currency", label: "Rate" }, note: { type: "string", label: "Note" } };
  doc.computed = { labor_cents: "params.hours * params.rate_cents" };
  doc.pages[0].children.push(
    FMDocModel.createNode("text", { id: "heading", frame: { x: 72, y: 72, w: 468, h: 30 }, props: { blocks: [{ runs: [{ text: heading }] }] } }),
    FMDocModel.createNode("text", { id: "summary", frame: { x: 72, y: 110, w: 468, h: 30 }, props: { blocks: [{ runs: [{ text: label + ": {{params.hours}} hours at {{params.rate_cents | money}} = {{computed.labor_cents | money}}" }] }] } }),
    FMDocModel.createNode("text", { id: "site", frame: { x: 72, y: 150, w: 468, h: 30 }, props: { blocks: [{ runs: [{ text: "Site: " }, { bind: "project.title" }] }] } })
  );
  return doc;
}
