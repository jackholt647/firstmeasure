import { z } from "zod";
import { Ajv } from "ajv";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { authorizePublication } from "../platform/publication/context.js";
import { authorizeSource, authorizeSourceSnapshot } from "../platform/publication/providers.js";
import { createBindingSession } from "../platform/publication/bindings.js";
import { instantiateBindings } from "../platform/publication/instantiate.js";
import { contentHash, jsonClone, validateJson } from "../platform/publication/validation.js";
import { assertSafeTenantSchema } from "../platform/publication/tenant-schema.js";
import type { PublicationContext, DataBinding, DataResult } from "../platform/publication/contracts.js";
import { moduleBindingSchema } from "../documents/modules/schemas.js";
import { runModuleCode } from "../documents/modules/runtime.js";
import { calculusDefinitionSchema, calculationOutputSchema, commandSchema, requirementSchema, type CalculusDefinition, type CalculusCommand, type Requirement } from "./calculus-contract.js";

export const CALCULUS_LEDGER = "materials_calculus_ledgers";
const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const identity = (prefix: string, value: unknown) => `${prefix}_${contentHash(value).slice(0, 32)}`;
type Line = Requirement & { id: string; order_quantity: number; order_unit: string; lineage: string[] };
type Evaluation = { id: string; base_revision: number; inputs: JsonObject; lines: Requirement[]; warnings: string[]; evidence: JsonObject; at: string; definition_hash: string };
type SetRecord = { id: string; title: string; presentation?: JsonObject; definition: CalculusDefinition; document: JsonObject; origin: JsonObject; revision: number; lines: Line[]; evaluations: Evaluation[]; history: JsonObject[]; applied_evaluation?: string };
type Allocation = { id: string; set_id: string; line_id: string; line: Line; quantity: number; cancelled: number; received: number; returned: number; unit_cost?: number; currency: string };
type Order = { presentation?: JsonObject; id: string; supplier: string; reference: string; at: string; lines: Allocation[] };
type Delivery = { id: string; title: string; date: string; allocations: string[] };
export type MaterialsLedger = { revision: number; project_id: string; sets: SetRecord[]; orders: Order[]; deliveries: Delivery[]; events: JsonObject[]; receipts: Record<string, { hash: string; result: JsonObject }> };
const empty = (project: string): MaterialsLedger => ({ revision: 0, project_id: project, sets: [], orders: [], deliveries: [], events: [], receipts: {} });

export function validateCalculus(value: unknown): CalculusDefinition {
  const definition = calculusDefinitionSchema.parse(value);
  assertSafeTenantSchema(definition.inputSchema);
  try { new Ajv({ strict: false }).compile(definition.inputSchema); } catch { throw badRequest("calculus_schema", "Invalid materials input schema."); }
  if (Object.keys(definition.bindings).length > 40) throw badRequest("calculus_bindings", "At most 40 data bindings are supported.");
  for (const [name, raw] of Object.entries(definition.bindings)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(name)) throw badRequest("calculus_binding_name", "Use a stable named input binding.");
    const binding = moduleBindingSchema.parse(raw);
    if (binding.kind !== "data") throw badRequest("calculus_pure", "Materials calculations accept only data bindings.");
    // Prevent recursive ledger evidence graphs. Documents provide their own accepted values directly.
    if (binding.source.provider === "materials-calculus") throw badRequest("calculus_cycle", "Reference amendment targets explicitly rather than binding another materials ledger.");
    definition.bindings[name] = binding;
  }
  return definition;
}
export function validateDeliverables(value: unknown): CalculusDefinition[] {
  const values = z.array(z.unknown()).max(40).parse(value || []).map(validateCalculus);
  if (new Set(values.map(v => v.key)).size !== values.length) throw badRequest("deliverable_key", "Deliverable keys must be unique within a document.");
  return values;
}
async function rawLedger(org: string, project: string): Promise<MaterialsLedger> {
  const row = await readDocument(org, CALCULUS_LEDGER, identity("materials", project)).catch(error => { if (error.statusCode === 404) return null; throw error; });
  return row ? { ...row.data, revision: row.revision } as MaterialsLedger : empty(project);
}
async function saveLedger(org: string, ledger: MaterialsLedger, previous: number) {
  if (Buffer.byteLength(JSON.stringify(ledger)) > 16 * 1024 * 1024) throw badRequest("materials_ledger_capacity", "This project's retained materials history has reached its storage limit.");
  const saved = await upsertDocument(org, CALCULUS_LEDGER, { id: identity("materials", ledger.project_id), data: ledger as unknown as JsonObject, ...(previous ? { expected_revision: previous } : {}) }, { replace: true, createOnly: previous === 0 });
  return { ...ledger, revision: saved.revision };
}
async function authorize(ctx: PublicationContext, project: string, write: boolean) {
  await authorizePublication(ctx, { scope: "project", organizationId: ctx.organizationId, projectId: project }, { scopes: ["project"], permissions: [write ? "manage_projects" : "view_materials"], capabilities: ["platform.materials"], systemKinds: [] }, write ? "materials.calculus.command" : "materials.calculus.read");
  if (!(await readDocument(ctx.organizationId, "projects", project))) throw notFound("project_missing", "Project not found.");
}
async function evidenceAccess(ctx: PublicationContext, ledger: MaterialsLedger) {
  for (const set of ledger.sets) {
    for (const raw of Object.values(set.definition.bindings)) await authorizeSource(ctx, (raw as DataBinding).source);
    for (const evaluation of set.evaluations) for (const [name, raw] of Object.entries(evaluation.evidence)) {
      const result = object(raw).result as DataResult;
      if (result?.status === "ready") await authorizeSourceSnapshot(ctx, (set.definition.bindings[name] as DataBinding).source, result);
    }
    if (set.origin.document_id) await authorizeSource(ctx, { provider: "documents", export: "params", target: { scope: "project", organizationId: ctx.organizationId, projectId: ledger.project_id, id: String(set.origin.document_id) } });
  }
}
export async function readMaterialsLedger(ctx: PublicationContext, project: string) {
  await authorize(ctx, project, false);
  const ledger = await rawLedger(ctx.organizationId, project);
  await evidenceAccess({ ...ctx, projectId: project }, ledger);
  return ledgerView(ledger);
}
function compatible(a: Line, b: Line) { return a.product_id === b.product_id && a.variant === b.variant && a.order_unit === b.order_unit; }
export function lineBalance(ledger: MaterialsLedger, set: SetRecord, line: Line) {
  const allocations = ledger.orders.flatMap(o => o.lines).filter(a => a.set_id === set.id && line.lineage.includes(a.line_id) && compatible(line, a.line));
  const committed = allocations.reduce((n, a) => n + a.quantity - a.cancelled - a.returned, 0);
  const received = allocations.reduce((n, a) => n + a.received - a.returned, 0);
  return { committed, received, outstanding: Math.max(0, line.order_quantity - committed), excess: Math.max(0, committed - line.order_quantity) };
}
function ledgerView(ledger: MaterialsLedger) {
  const { receipts: _receipts, ...view } = ledger;
  const unallocated = ledger.orders.flatMap(o => o.lines).filter(a => !ledger.sets.some(s => s.id === a.set_id && s.lines.some(l => l.lineage.includes(a.line_id) && compatible(l, a.line)))).map(a => ({ ...a, excess: a.quantity - a.cancelled - a.returned }));
  return { ...view, sets: ledger.sets.map(s => ({ ...s, lines: s.lines.map(l => ({ ...l, balance: lineBalance(ledger, s, l) })) })), unallocated };
}
function findSet(ledger: MaterialsLedger, id: unknown) { const set = ledger.sets.find(s => s.id === id); if (!set) throw notFound("material_set_missing", "Material set not found in this project."); return set; }
function makeLines(set: SetRecord, requirements: Requirement[], removed: Line[], command: string): Line[] {
  if (new Set(requirements.map(l => l.key)).size !== requirements.length) throw badRequest("material_line_key", "Line keys must be unique within a set.");
  const replaced = new Set<string>();
  return requirements.map(line => {
    const prior = line.replaces ? removed.find(l => l.id === line.replaces) : undefined;
    if (line.replaces && (!prior || replaced.has(line.replaces))) throw badRequest("amendment_reference", "Each replacement must reference one removed line, at most once.");
    if (prior) replaced.add(prior.id);
    const id = identity("line", [set.id, command, line.key]);
    const packages = line.packaging ? line.quantity / line.packaging.coverage : 0;
    // Absorb only representational noise at integer package boundaries.
    const order_quantity = line.packaging ? (line.quantity === 0 ? 0 : Math.max(1, Math.ceil(packages - Math.min(1e-9, Number.EPSILON * Math.max(1, packages) * 4)))) : line.quantity;
    if (!Number.isFinite(order_quantity) || order_quantity > 1e12) throw badRequest("material_quantity", "Order quantity exceeds the supported range.");
    return { ...line, id, order_quantity, order_unit: line.packaging?.unit || line.unit, lineage: [...(prior?.lineage || []), id] };
  });
}
function amend(ledger: MaterialsLedger, set: SetRecord, input: JsonObject, command: string, at: string, source: JsonObject = { type: "manual" }) {
  if (input.set_revision !== set.revision) throw conflict("material_set_revision", "The material set changed. Review its latest revision before applying this amendment.");
  const remove = z.array(z.string()).max(1000).parse(input.remove || []);
  if (new Set(remove).size !== remove.length || remove.some(id => !set.lines.some(l => l.id === id))) throw badRequest("amendment_reference", "Removal references must name distinct active lines in this set.");
  const removed = set.lines.filter(l => remove.includes(l.id));
  const added = makeLines(set, z.array(requirementSchema).max(1000).parse(input.add || []), removed, command);
  const lines = [...set.lines.filter(l => !remove.includes(l.id)), ...added];
  if (lines.length > 1000 || new Set(lines.map(l => l.key)).size !== lines.length) throw badRequest("material_line_key", "Active line keys must be unique within this set; replace the old line when reusing its key.");
  set.history.push({ id: identity("amendment", command), revision: set.revision + 1, based_on: set.revision, removed: jsonClone(removed), added: jsonClone(added), reason: z.string().min(1).max(2000).parse(input.reason), source: jsonClone(source), at });
  set.lines = lines; set.revision++;
  return { set_id: set.id, set_revision: set.revision };
}
function setFromDefinition(project: string, definition: CalculusDefinition, id: string, document: JsonObject, origin: JsonObject, org: string, branch?: string): SetRecord {
  const bindings = instantiateBindings(definition.bindings as Record<string, DataBinding>, { organizationId: org, projectId: project, branchId: branch });
  return { id, title: definition.title, definition: { ...definition, bindings }, document: jsonClone(document), origin, revision: 0, lines: [], evaluations: [], history: [] };
}

/** Called only with the retained completed signing package, never client-provided acceptance. */
export async function publishAcceptedMaterials(org: string, project: string, documentId: string, snapshotId: string) {
  const { packageForSnapshot } = await import("../documents/signing/store.js");
  const pkg = await packageForSnapshot(org, snapshotId);
  if (!pkg || pkg.status !== "completed" || pkg.document_id !== documentId || pkg.organization_id !== org) throw forbidden("materials_acceptance", "A completed signing package is required.");
  const doc = await readDocument(org, "documents", documentId);
  if (!doc || doc.data.project_id !== project) throw forbidden("materials_project", "The accepted document belongs to a different project.");
  const definitions = validateDeliverables(pkg.content.materials_deliverables);
  if (!definitions.length) return;
  for (let attempt = 0; attempt < 8; attempt++) {
    const ledger = await rawLedger(org, project); const revision = ledger.revision;
    let changed = false;
    for (const definition of definitions) {
      const id = identity("set", [documentId, snapshotId, definition.key]);
      if (ledger.sets.some(s => s.id === id)) continue;
      changed = true;
      ledger.sets.push(setFromDefinition(project, definition, id, { params: object(pkg.content.params), outputs: object(pkg.content.outputs) }, { type: "document", document_id: documentId, snapshot_id: snapshotId, content_hash: pkg.content_hash, title: pkg.content.title, at: pkg.completed_at }, org, String(doc.data.branch_id || "default")));
    }
    if (!changed) return;
    try { await saveLedger(org, ledger, revision); return; } catch (e) { if ((e as { statusCode?: number }).statusCode !== 409 || attempt === 7) throw e; }
  }
}

export async function materialsCommand(ctx: PublicationContext, project: string, raw: unknown) {
  const command = commandSchema.parse(raw);
  await authorize(ctx, project, true);
  const ledger = await rawLedger(ctx.organizationId, project);
  await evidenceAccess({ ...ctx, projectId: project }, ledger);
  const hash = contentHash(command);
  const prior = ledger.receipts[command.key];
  if (prior) { if (prior.hash !== hash) throw conflict("materials_request_reused", "This request key belongs to a different operation."); return { ledger: ledgerView(ledger), result: prior.result, duplicate: true }; }
  if (ledger.revision !== command.expected_revision) throw conflict("materials_revision", "Materials changed. Refresh and review before trying again.");
  const at = new Date().toISOString();
  const result = await execute(ctx, ledger, command, at);
  ledger.events.push({ id: identity("event", command.key), operation: command.operation, actor: ctx.auth?.userId, at, result, input: command.operation === "evaluate" ? { set_id: command.input.set_id } : command.input });
  ledger.receipts[command.key] = { hash, result };
  const saved = await saveLedger(ctx.organizationId, ledger, ledger.revision);
  return { ledger: ledgerView(saved), result, duplicate: false };
}
async function execute(ctx: PublicationContext, ledger: MaterialsLedger, command: CalculusCommand, at: string): Promise<JsonObject> {
  const input = command.input; const key = command.key;
  if (command.operation === 'configure') {
    const parsed = z.object({set_id:z.string(),set_revision:z.number().int().nonnegative(),title:z.string().min(1).max(200).optional(),presentation:z.record(z.unknown()).optional()}).strict().parse(input);
    const set = findSet(ledger,parsed.set_id);
    if(set.revision !== parsed.set_revision) throw conflict('material_set_revision','The material set changed. Refresh and try again.');
    const previous = {title:set.title,presentation:set.presentation};
    if(parsed.title)set.title=parsed.title;
    if(parsed.presentation)set.presentation={...set.presentation,...parsed.presentation};
    set.revision++;
    return {set_id:set.id,previous,set_revision:set.revision};
  }
  if (command.operation === "create") {
    const definition = validateCalculus(input.definition);
    const id = identity("set", key);
    const set = setFromDefinition(ledger.project_id, definition, id, {}, { type: "manual", actor: ctx.auth?.userId, at }, ctx.organizationId, ctx.branchId);
    for (const binding of Object.values(set.definition.bindings)) await authorizeSource({ ...ctx, projectId: ledger.project_id }, (binding as DataBinding).source);
    ledger.sets.push(set);
    return { set_id: id };
  }
  if (command.operation === "evaluate") {
    const set = findSet(ledger, input.set_id);
    const manual = { ...set.definition.defaults, ...object(input.values) };
    validateJson(set.definition.inputSchema, manual, "materials inputs");
    const session = createBindingSession({ ...ctx, projectId: ledger.project_id, mode: "evaluate" }, set.id, set.definition.bindings as Record<string, DataBinding>);
    const result = await runModuleCode({ source: set.definition.source, inputs: { document: set.document, values: manual }, state: {}, mode: "evaluate", now: at }, { read: name => session.read(name), invoke: async () => { throw forbidden("calculus_pure", "Materials calculation cannot invoke actions."); } });
    const output = calculationOutputSchema.parse(result.outputs);
    const evaluation: Evaluation = { id: identity("evaluation", key), base_revision: set.revision, inputs: manual, ...output, evidence: session.manifest(), at, definition_hash: contentHash(set.definition) };
    // Validate stable keys and package arithmetic before saving a preview.
    makeLines(set, output.lines.map(l => ({ ...l, replaces: undefined })), [], key);
    set.evaluations.push(evaluation);
    return { set_id: set.id, evaluation_id: evaluation.id };
  }
  if (command.operation === "apply") {
    const producer = findSet(ledger, input.set_id);
    const evaluation = producer.evaluations.find(e => e.id === input.evaluation_id);
    if (!evaluation) throw notFound("evaluation_missing", "Evaluation not found.");
    if (producer.applied_evaluation === evaluation.id) throw conflict("evaluation_applied", "This evaluation has already been applied.");
    if (evaluation.base_revision !== producer.revision) throw conflict("evaluation_stale", "This preview predates the current requirements. Evaluate and review again.");
    const target = producer.definition.amendment;
    const set = target ? findSet(ledger, target.set_id) : producer;
    const removed = target ? (target.replace_all ? set.lines.map(l => l.id) : target.remove) : set.lines.map(l => l.id);
    const additions = evaluation.lines.map(line => { const replaces = line.replaces || set.lines.find(l => l.key === line.key && removed.includes(l.id))?.id; return { ...line, ...(replaces ? { replaces } : {}) }; });
    const result = amend(ledger, set, { set_revision: target?.revision ?? evaluation.base_revision, remove: removed, add: additions, reason: input.reason || "Apply calculated requirements" }, key, at, { ...producer.origin, calculus_id: producer.id, evaluation_id: evaluation.id });
    producer.applied_evaluation = evaluation.id;
    if (target) producer.revision++;
    return result;
  }
  if (command.operation === "amend") return amend(ledger, findSet(ledger, input.set_id), input, key, at);
  if (command.operation === "order") {
    const parsed = z.object({ presentation: z.record(z.unknown()).optional(), supplier: z.string().min(1).max(300), reference: z.string().max(300).default(""), lines: z.array(z.object({ set_id: z.string(), line_id: z.string(), quantity: z.number().finite().positive().max(1e12), unit_cost: z.number().finite().nonnegative().max(1e12).optional() }).strict()).min(1).max(1000) }).strict().parse(input);
    const seen = new Set<string>();
    const lines = parsed.lines.map((item, index): Allocation => {
      const set = findSet(ledger, item.set_id); const line = set.lines.find(l => l.id === item.line_id);
      if (!line || seen.has(line.id)) throw badRequest("order_line", "Select distinct active material lines in this project."); seen.add(line.id);
      if (line.packaging && !Number.isInteger(item.quantity)) throw badRequest("order_package", "Order whole packages.");
      if (item.quantity > lineBalance(ledger, set, line).outstanding + 1e-9) throw conflict("order_excess", "The requested quantity exceeds the uncommitted requirement.");
      const unitCost = item.unit_cost ?? line.unit_cost;
      return { id: identity("allocation", [key, index]), set_id: set.id, line_id: line.id, line: jsonClone(line), quantity: item.quantity, cancelled: 0, received: 0, returned: 0, ...(unitCost !== undefined ? { unit_cost: unitCost } : {}), currency: line.currency };
    });
    const order = { presentation: parsed.presentation, id: identity("order", key), supplier: parsed.supplier, reference: parsed.reference, at, lines };
    ledger.orders.push(order); return { order_id: order.id };
  }
  if (command.operation === "delivery") {
    const parsed = z.object({ title: z.string().min(1).max(300), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), allocations: z.array(z.string()).min(1).max(1000) }).strict().parse(input);
    if (!Number.isFinite(Date.parse(parsed.date)) || new Date(parsed.date).toISOString().slice(0,10) !== parsed.date || new Set(parsed.allocations).size !== parsed.allocations.length) throw badRequest("delivery_invalid", "Select a valid date and distinct order lines.");
    for (const id of parsed.allocations) if (!ledger.orders.some(o => o.lines.some(a => a.id === id)) || ledger.deliveries.some(d => d.allocations.includes(id))) throw conflict("delivery_allocation", "An order line is missing or already assigned to a delivery.");
    const delivery = { id: identity("delivery", key), ...parsed }; ledger.deliveries.push(delivery); return { delivery_id: delivery.id };
  }
  if (command.operation === "reschedule") {
    const parsed = z.object({ delivery_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().min(1).max(2000) }).strict().parse(input);
    const delivery = ledger.deliveries.find(d => d.id === parsed.delivery_id);
    if (!delivery) throw notFound("delivery_missing", "Delivery not found in this project.");
    if (!Number.isFinite(Date.parse(parsed.date)) || new Date(parsed.date).toISOString().slice(0,10) !== parsed.date) throw badRequest("delivery_date", "Choose a valid calendar date.");
    const previous_date = delivery.date; delivery.date = parsed.date;
    return { delivery_id: delivery.id, previous_date, date: parsed.date };
  }
  if (command.operation === "price") {
    const parsed = z.object({ allocation_id: z.string(), unit_cost: z.number().finite().nonnegative().max(1e12), currency: z.string().regex(/^[A-Z]{3}$/), reason: z.string().min(1).max(2000) }).strict().parse(input);
    const allocation = ledger.orders.flatMap(o => o.lines).find(a => a.id === parsed.allocation_id);
    if (!allocation) throw notFound("allocation_missing", "Order allocation not found in this project.");
    const previous = { unit_cost: allocation.unit_cost ?? null, currency: allocation.currency };
    allocation.unit_cost = parsed.unit_cost; allocation.currency = parsed.currency;
    return { allocation_id: allocation.id, previous, unit_cost: allocation.unit_cost, currency: allocation.currency };
  }
  const parsed = z.object({ allocation_id: z.string(), quantity: z.number().finite().positive().max(1e12), reason: z.string().min(1).max(2000), delivery_id: z.string().optional() }).strict().parse(input);
  const allocation = ledger.orders.flatMap(o => o.lines).find(a => a.id === parsed.allocation_id);
  if (!allocation) throw notFound("allocation_missing", "Order allocation not found in this project.");
  if (allocation.line.packaging && !Number.isInteger(parsed.quantity)) throw badRequest("order_package", "Record whole packages.");
  if (command.operation === "cancel") {
    if (parsed.quantity > allocation.quantity - allocation.cancelled - allocation.received) throw conflict("cancel_quantity", "Only unreceived, uncancelled quantities can be cancelled.");
    allocation.cancelled += parsed.quantity;
  } else if (command.operation === "return") {
    if (parsed.quantity > allocation.received - allocation.returned) throw conflict("return_quantity", "Return quantity exceeds the quantity received and not yet returned.");
    allocation.returned += parsed.quantity;
  } else {
    if (!parsed.delivery_id || !ledger.deliveries.some(d => d.id === parsed.delivery_id && d.allocations.includes(allocation.id))) throw badRequest("delivery_allocation", "Receipt must reference this order line's delivery.");
    if (parsed.quantity > allocation.quantity - allocation.cancelled - allocation.received) throw conflict("receive_quantity", "Receipt exceeds the remaining order quantity.");
    allocation.received += parsed.quantity;
  }
  return { allocation_id: allocation.id, operation: command.operation, quantity: parsed.quantity };
}
