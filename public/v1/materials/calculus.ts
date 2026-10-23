import { newGenerationId, recordGeneration, recordProjectChange } from "../history/storage.js";
import { lineDiff, lineDiffSummary, lineFacts } from "../history/diff.js";
import { currentChangeSource } from "../history/source.js";
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
import { calculusDefinitionSchema, calculationOutputSchema, commandSchema, requirementSchema, type CalculusDefinition, type CalculusCommand, type Requirement, type ScopeWork } from "./calculus-contract.js";
import { workItem } from "../platform/publication/work-items.js";

export const CALCULUS_LEDGER = "materials_calculus_ledgers";
const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
const identity = (prefix: string, value: unknown) => `${prefix}_${contentHash(value).slice(0, 32)}`;
/** Domain builders use optional properties; publications omit absent keys. */
function scopeJson(value:JsonObject):JsonObject{
  const prune=(item:unknown,depth=0):unknown=>{
    if(depth>64)throw badRequest('materials_value_limit','Material provenance exceeds the structural limit.');
    if(Array.isArray(item))return item.map(child=>prune(child,depth+1));
    if(item && typeof item==='object')return Object.fromEntries(Object.entries(item).filter(([,child])=>child!==undefined).map(([key,child])=>[key,prune(child,depth+1)]));
    return item;
  };
  return jsonClone(prune(value)) as JsonObject;
}
type Line = Requirement & { id: string; order_quantity: number; order_unit: string; lineage: string[] };
type Evaluation = { id: string; base_revision: number; inputs: JsonObject; lines: Requirement[]; work?: ScopeWork[]; warnings: string[]; evidence: JsonObject; at: string; definition_hash: string };
type SetRecord = { id: string; title: string; presentation?: JsonObject; definition: CalculusDefinition; document: JsonObject; origin: JsonObject; revision: number; lines: Line[]; work?: ScopeWork[]; evaluations: Evaluation[]; history: JsonObject[]; applied_evaluation?: string };
type Allocation = { id: string; set_id: string; line_id: string; line: Line; quantity: number; cancelled: number; received: number; returned: number; unit_cost?: number; currency: string };
type Order = { presentation?: JsonObject; id: string; supplier: string; reference: string; at: string; lines: Allocation[] };
type Delivery = { id: string; title: string; date: string; allocations: string[] };
type RetiredSet = SetRecord & { retired: { at: string; actor?: string; reason: string } };
/** A set someone deleted leaves `sets` for `retired_sets`: it no longer counts toward requirements and is never published again under the same identity. Its orders stay. */
export type MaterialsLedger = { revision: number; project_id: string; sets: SetRecord[]; retired_sets?: RetiredSet[]; orders: Order[]; deliveries: Delivery[]; events: JsonObject[]; receipts: Record<string, { hash: string; result: JsonObject }> };
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
/**
 * The project's scope artifacts as its requirements read them: each set's material lines and the work items and
 * functions it says the job includes. A set a document published that has not been generated yet is pending. Reads only.
 */
export async function projectScopeSets(org: string, project: string) {
  const sets = (await rawLedger(org, project)).sets;
  // A document that has published a scope overrides the organization's measurement defaults completely.
  const documented = sets.some(set => set.origin.type === "document");
  return sets.filter(set => !(documented && set.origin.type === "defaults")).map(set => ({
    id: set.id, title: set.title, key: set.definition.key, origin: String(set.origin.type || ""), document_id: String(set.origin.document_id || ""),
    work: jsonClone(set.work || []), lines: set.lines.map(line => ({ id: line.id, name: line.name, quantity: line.quantity, unit: line.unit, group: line.group })),
    pending: !set.applied_evaluation && !set.lines.length && !(set.work || []).length && set.origin.type === "document"
  }));
}
function assertScopeWork(work: ScopeWork[]) {
  const seen = new Set<string>();
  for (const entry of work) {
    if (!workItem(entry.item)) throw badRequest("scope_work_unknown", `${entry.item} is not in the work item dictionary.`);
    if (seen.has(entry.item)) throw badRequest("scope_work_duplicate", `${entry.item} is listed twice. State each work item once.`);
    seen.add(entry.item);
  }
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

/** Trusted scope publication uses the same persisted artifact contract as
 * accepted documents. Stable owner/key identity prevents reference duplicates.
 * Existing sets are never regenerated over user edits or commitments. */
export async function publishScopeMaterialArtifact(org: string, project: string, owner: string, raw: unknown, origin: JsonObject, initialLines?: unknown[], presentation?: JsonObject) {
  const definition = validateCalculus(raw);
  await readDocument(org, "projects", project);
  const id = identity("set", ["scope", owner, definition.key]);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ledger = await rawLedger(org, project), revision = ledger.revision;
    const retired = (ledger.retired_sets || []).find(set => set.id === id);
    if (retired) return { ...retired.presentation,...retired, project_id:project, resource_type:"material", current_items:[], created:false, retired:true };
    const existing = ledger.sets.find(set => set.id === id);
    if (existing) return { ...existing.presentation,...existing, project_id:project, resource_type:"material", current_items:existing.lines.map(line=>({...line.presentation,...line})),created:false };
    const set = setFromDefinition(project,definition,id,{}, scopeJson({ ...origin,type:"scope",owner,key:definition.key }),org,String(origin.branch_id || "default"));
    if (initialLines) {
      set.lines = makeLines(set,z.array(requirementSchema).max(1000).parse(initialLines),[],id);
      set.revision = 1;
      set.history.push({ revision:1,source:jsonClone(set.origin),at:new Date().toISOString(),added:jsonClone(set.lines),removed:[] });
    }
    if(presentation)set.presentation = scopeJson(presentation);
    ledger.sets.push(set);
    try { await saveLedger(org,ledger,revision); return {...set.presentation,...set,project_id:project,resource_type:"material",current_items:set.lines.map(line=>({...line.presentation,...line})),created:true}; }
    catch (error) { if ((error as {statusCode?:number}).statusCode !== 409 || attempt === 7) throw error; }
  }
  throw conflict("materials_publication_contention","Material publication could not acquire the current revision.");
}

/** The organization's measurement defaults as this project's artifact (materials/measurement-defaults.ts): one set,
 * whose calculation follows the defaults as they now stand. Its lines change only when it is applied again. */
export async function publishDefaultsMaterialArtifact(org: string, project: string, raw: unknown, origin: JsonObject) {
  const definition = validateCalculus(raw);
  const id = identity("set", ["defaults", definition.key]);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ledger = await rawLedger(org, project), revision = ledger.revision;
    const next = setFromDefinition(project, definition, id, {}, scopeJson({ ...origin, type: "defaults", key: definition.key }), org, String(origin.branch_id || "default"));
    const existing = ledger.sets.find(set => set.id === id);
    if (existing && contentHash(existing.definition) === contentHash(next.definition)) return { set_id: id, created: false };
    if (existing) { existing.definition = next.definition; existing.origin = { ...next.origin, at: new Date().toISOString() }; }
    else ledger.sets.push({ ...next, origin: { ...next.origin, at: new Date().toISOString() } });
    try { await saveLedger(org, ledger, revision); return { set_id: id, created: !existing }; }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 409 || attempt === 7) throw error; }
  }
  throw conflict("materials_publication_contention", "Material publication could not acquire the current revision.");
}

export function scopeMaterialRequirements(items: JsonObject[]) {
  return items.map((item,index) => {
    const packaging = object(item.order_packaging), ref=object(item.pricebook_ref);
    return requirementSchema.parse({
      key:String(item.id || `item_${index}`),product_id:String(ref.item_id || item.id || `item_${index}`),
      name:String(item.name || "Material"),quantity:item.quantity,unit:String(item.unit || "each"),
      group:String(item.section || "materials"),structure:String(item.structure_name || ""),
      variant:String(object(item.selected_options).color || ""),
      ...(Number(packaging.units_per_package)>0 ? {packaging:{unit:String(packaging.order_unit || "package"),coverage:Number(packaging.units_per_package)}}:{}),
      ...(item.projected_unit_price != null ? {unit_cost:item.projected_unit_price}:{}),currency:String(item.currency || "USD"),
      presentation:scopeJson(item)
    });
  });
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
      if (ledger.sets.some(s => s.id === id) || (ledger.retired_sets || []).some(s => s.id === id)) continue;
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
  const before = new Map(ledger.sets.map((set) => [set.id, { lines: jsonClone(set.lines), work: jsonClone(set.work || []) }]));
  const result = await execute(ctx, ledger, command, at);
  ledger.events.push({ id: identity("event", command.key), operation: command.operation, actor: ctx.auth?.userId, at, result, input: command.operation === "evaluate" ? { set_id: command.input.set_id } : command.input });
  ledger.receipts[command.key] = { hash, result };
  const saved = await saveLedger(ctx.organizationId, ledger, ledger.revision);
  await recordCalculusHistory(ctx, ledger, command, before);
  return { ledger: ledgerView(saved), result, duplicate: false };
}

/**
 * The change history for a materials command (docs/architecture/project-history.md). Applying the calculation of a set
 * a document or a scope published is a generator run: it is recorded with what the calculation was given (the
 * document's parameters, the values, the data it read) and the lines it made, and the change it makes is the
 * generator's. Anything else that changes a set's lines or its work (an amendment, a set made by hand, an agent's set)
 * is recorded as whoever made it.
 */
async function recordCalculusHistory(ctx: PublicationContext, ledger: MaterialsLedger, command: CalculusCommand, before: Map<string, { lines: Line[]; work: ScopeWork[] }>) {
  const user = String(ctx.auth?.userId || "");
  let source = currentChangeSource(user);
  if (command.operation === "apply") {
    const producer = ledger.sets.find((set) => set.id === command.input.set_id);
    const evaluation = producer?.evaluations.find((entry) => entry.id === command.input.evaluation_id);
    const origin = String(producer?.origin.type || "");
    if (producer && evaluation && (origin === "document" || origin === "scope" || origin === "defaults")) {
      const generationId = newGenerationId();
      const target = producer.definition.amendment?.set_id || producer.id;
      await recordGeneration(ctx.organizationId, { id: generationId, project_id: ledger.project_id, generator: "materials.calculus", generator_version: evaluation.definition_hash, subject_type: "materials_set", subject_id: target, user_id: user,
        inputs: { set: { id: producer.id, key: producer.definition.key, title: producer.title }, origin: jsonClone(producer.origin), document: jsonClone(producer.document), values: jsonClone(evaluation.inputs), evidence: jsonClone(evaluation.evidence) },
        output: { lines: evaluation.lines.map(lineFacts), work: jsonClone(evaluation.work || []), warnings: evaluation.warnings } });
      source = { ...source, kind: "generator", generator: "materials.calculus", generator_version: evaluation.definition_hash, generation_id: generationId };
    }
  }
  for (const set of ledger.retired_sets || []) {
    const was = before.get(set.id);
    if (!was || ledger.sets.some(entry => entry.id === set.id)) continue;
    await recordProjectChange(ctx.organizationId, { project_id: ledger.project_id, domain: "materials", subject_type: "materials_set", subject_id: set.id, op: "archived", summary: `Deleted ${set.title}`, diff: { removed: was.lines.map(lineFacts) }, before: { title: set.title, lines: was.lines.map(lineFacts) }, after: { retired: set.retired }, source });
  }
  for (const set of ledger.sets) {
    const was = before.get(set.id) || { lines: [], work: [] };
    const lines = lineDiff(was.lines, set.lines), workChanged = JSON.stringify(was.work) !== JSON.stringify(set.work || []);
    if (!lines.empty) await recordProjectChange(ctx.organizationId, { project_id: ledger.project_id, domain: "materials", subject_type: "materials_set", subject_id: set.id, op: "lines", summary: `${lineDiffSummary(lines)} (${command.operation})`, diff: { added: lines.added, removed: lines.removed, changed: lines.changed }, after: set.lines.map(lineFacts), source });
    if (workChanged) await recordProjectChange(ctx.organizationId, { project_id: ledger.project_id, domain: "scope", subject_type: "materials_set", subject_id: set.id, op: "work", summary: `Work ${command.operation === "apply" ? "applied" : "changed"} on ${set.title}`, before: was.work, after: jsonClone(set.work || []), source });
  }
}
async function execute(ctx: PublicationContext, ledger: MaterialsLedger, command: CalculusCommand, at: string): Promise<JsonObject> {
  const input = command.input; const key = command.key;
  if (command.operation === "import_legacy") {
    const {readMaterialList,listMaterialOrders}=await import('./storage.js');
    let list=await readMaterialList(ctx.organizationId,z.string().min(1).parse(input.list_id));
    if(list.project_id!==ledger.project_id || list.resource_type!=='material')throw forbidden('material_import_target','Choose a material list from this project.');
    const reservation=object(object(list.metadata).artifact_import);
    if(reservation.key && reservation.key!==key)throw conflict('material_import_reserved','Another import has reserved this list. Resume its original request.');
    if(Number(reservation.original_revision || list.revision)!==input.list_revision)throw conflict('material_import_revision','The legacy list changed. Review it before importing.');
    if(list.status!=='planning' || list.locked_at || list.schedule_event_id)throw conflict('material_import_active','Only an unlocked, unscheduled planning list can be imported. Reconcile active work first.');
    if((await listMaterialOrders(ctx.organizationId,String(list.id))).length)throw conflict('material_import_commitments','This list has legacy orders. Preserve its order history and reconcile those commitments before importing; they cannot be inferred as new orders.');
    const id=identity('set',['legacy',list.id]);
    if(ledger.sets.some(set=>set.id===id))return {set_id:id,duplicate:true};
    if(reservation.key)list=object(reservation.snapshot);
    const lines=scopeMaterialRequirements((list.current_items || []) as JsonObject[]);
    const definition=validateCalculus({type:'materials_calculus',key:String(list.id).slice(0,120),title:list.title,source:'return {outputs:{lines:inputs.values.lines,warnings:[]}};',defaults:{lines},inputSchema:{type:'object',properties:{lines:{type:'array'}},required:['lines'],additionalProperties:false}});
    // Reserve the source with a compare-and-set before publishing. Domain
    // writers reject the reservation and use revision checks, so a concurrent
    // order cannot commit between the source snapshot and ledger publication.
    if(!reservation.key){
      await upsertDocument(ctx.organizationId,'material_lists',{id:String(list.id),expected_revision:Number(list.revision),data:{metadata:{...object(list.metadata),artifact_import:{key,original_revision:list.revision,snapshot:jsonClone(list)}}}});
    }
    if((await listMaterialOrders(ctx.organizationId,String(list.id))).length)throw conflict('material_import_commitments','An order was created during import. Reconcile it before publishing.');
    const set=setFromDefinition(ledger.project_id,definition,id,{}, scopeJson({type:'scope',legacy_list_id:list.id,legacy_revision:list.revision,source_key:object(list.metadata).source_key,at}),ctx.organizationId,ctx.branchId);
    set.lines=makeLines(set,lines,[],key);set.revision=1;set.presentation=jsonClone(list);
    set.history.push({source:jsonClone(set.origin),legacy_snapshot:jsonClone(list),revision:1,at});
    ledger.sets.push(set);return {set_id:id};
  }
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
  if (command.operation === "retire") {
    // Deleting a list: its lines stop being requirements. Orders placed against it are kept and show as unallocated.
    const parsed = z.object({ set_id: z.string(), set_revision: z.number().int().nonnegative(), reason: z.string().max(2000).default("") }).strict().parse(input);
    const set = findSet(ledger, parsed.set_id);
    if (set.revision !== parsed.set_revision) throw conflict("material_set_revision", "The material set changed. Refresh and try again.");
    ledger.sets = ledger.sets.filter(entry => entry !== set);
    (ledger.retired_sets ||= []).push({ ...set, retired: { at, ...(ctx.auth?.userId ? { actor: String(ctx.auth.userId) } : {}), reason: parsed.reason || "Removed in Project" } });
    return { set_id: set.id, retired: true };
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
    assertScopeWork(output.work);
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
    // What the job includes is replaced with the material it needs. An amendment that names no work leaves its target's alone.
    if (!target || evaluation.work?.length) set.work = jsonClone(evaluation.work || []);
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

/** Legacy records retained for audit cease being writable after explicit import. */
export async function assertLegacyMaterialWritable(org:string,project:string,listId:string){
  const source=await readDocument(org,'material_lists',listId);
  assertLegacyMaterialSnapshotWritable(object(source.data));
  if((await rawLedger(org,project)).sets.some(set=>set.origin.legacy_list_id===listId))throw conflict('material_list_published','This list was imported as a material artifact. Edit the artifact instead.');
}

export function assertLegacyMaterialSnapshotWritable(list:JsonObject){
  if(object(object(list.metadata).artifact_import).key)throw conflict('material_list_published','This list is reserved for publication as a material artifact. Edit the artifact or resume the original import.');
}
export async function importedLegacyMaterialArtifact(org:string,project:string,listId:string){
  const set=(await rawLedger(org,project)).sets.find(set=>set.origin.legacy_list_id===listId);
  return set?{...set.presentation,...set,project_id:project,resource_type:'material',current_items:set.lines.map(line=>({...line.presentation,...line})),created:false}:null;
}
