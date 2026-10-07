import { randomUUID } from "node:crypto";
import type { PublicationContext } from "../../platform/publication/contracts.js";
import type { PlatformAuthContext } from "../../platform/auth.js";
import { authorizePublication } from "../../platform/publication/context.js";
import { contentHash, jsonClone, readPointer, validateJson } from "../../platform/publication/validation.js";
import { badRequest, conflict, forbidden, notFound, PlatformError } from "../../platform/errors.js";
import { readDocument, type JsonObject } from "../../platform/storage.js";
import { FMDocModel } from "../schemas.js";
import { validateModuleDefinition, validateModuleView, type ModuleDefinition } from "./schemas.js";
import { presentationSpecSchema, workflowCompletionSchema, type PresentationAudience, type PresentationSpec } from "./presentation-schema.js";
import { applyVariantChoices, lockChoices, normalizeChoices, offeredChoices, publicRow, selectionChoice, variantChoice, type ScopeChoices } from "./presentation-choices.js";
import { getRecord, saveRecord, records, MODULES, VERSIONS, INSTANCES, EXECUTIONS } from "./storage.js";
import { runModuleCode } from "./runtime.js";
import { getModuleExports, publishModule, storeModuleVersion, type ModuleInstance } from "./service.js";
import { createPublicLink, resolvePublicLink, revokePublicLink } from "../../public-links/service.js";
import { normalizeScheduleRows, resolveScheduleItems } from "../../payments/schedule_terms.js";
import { documentWidgetResolver, type WidgetResolveContext } from "../widgets/registry.js";
import { choiceKey, registerPresentationWidgetResolvers, PRESENTATION_STATE_KEY, PRESENTATION_WIDGETS } from "./presentation-widgets.js";

registerPresentationWidgetResolvers();

/**
 * Presentation modules: the customer-facing, re-evaluated surface between a
 * workflow and the contract it produces. State is a module instance; pricing,
 * selection write-through, sending and signing stay with the documents domain.
 * See docs/architecture/presentation-modules.md.
 */
export type PresentationActor =
  | { kind: "user"; ctx: PublicationContext }
  | { kind: "customer"; organizationId: string; shareId: string; access: "view" | "choose"; audit: JsonObject };
export type PresentationChange = { input: string; value?: unknown };
type Level = "read" | "write" | "issue";
type Meta = { source: JsonObject | null; shares: JsonObject[]; contract: JsonObject | null; submitted: JsonObject | null; missing: string[]; ready: boolean; createdBy: string };
type Definition = ModuleDefinition & { presentation: PresentationSpec };
type Computed = { outputs: JsonObject; view: JsonObject | null; customerView: JsonObject | null; missing: string[]; ready: boolean; items: unknown[] };

/** Where a shared link lands. The token rides in the fragment, never in a request line. */
export const PRESENTATION_PORTAL_PATH = "/customer_portal/presentation.html#{token}";
const MAX_ALTERNATIVES = 240, MAX_SHARES = 20, SHARE_DAYS = 30;
const PERMISSIONS: Record<Level, string> = { read: "view_projects", write: "manage_documents|manage_projects|manage_company_settings", issue: "issue_documents" };
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const missingRecord = <T>(error: unknown): T | null => { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; };
const documents = () => import("../service.js");
const documentStore = () => import("../storage.js");

async function allowed(ctx: PublicationContext, projectId: string | undefined, level: Level) {
  await authorizePublication(ctx, { scope: projectId ? "project" : "organization", organizationId: ctx.organizationId, ...(projectId ? { projectId } : {}) }, {
    scopes: ["organization", "project"], permissions: [PERMISSIONS[level]], systemKinds: ["module", "work", "agent"], capabilities: ["platform.documents"]
  }, `document-modules.presentation.${level}`);
}
function userAuth(ctx: PublicationContext): PlatformAuthContext {
  if (!ctx.auth) throw forbidden("presentation_user_required", "A signed-in user must perform this step.");
  return ctx.auth;
}
/** The identity automations already use to issue documents without a session. */
const systemAuth = (organizationId: string) => ({ orgId: organizationId, branchId: "default", userId: "system_automation", identityId: "system_automation", permissions: {}, role: "system" }) as unknown as PlatformAuthContext;
const meta = (instance: JsonObject): Meta => ({ source: null, shares: [], contract: null, submitted: null, missing: [], ready: false, createdBy: "", ...object(instance.presentation) }) as Meta;

async function definitionFor(organizationId: string, moduleId: string, version: string): Promise<Definition> {
  const definition = validateModuleDefinition((await getRecord(organizationId, VERSIONS, `${moduleId}_${version}`)).definition);
  if (definition.kind !== "presentation") throw badRequest("presentation_module_required", "Choose a presentation module.");
  return { ...definition, presentation: presentationSpecSchema.parse(definition.presentation || {}) };
}
async function load(organizationId: string, instanceId: string) {
  const instance = await getRecord(organizationId, INSTANCES, instanceId).catch(error => missingRecord<JsonObject>(error)) as ModuleInstance | null;
  if (!instance || instance.kind !== "presentation") throw notFound("presentation_not_found", "Presentation not found.");
  return { instance, definition: await definitionFor(organizationId, instance.moduleId, instance.version) };
}

// ---------------------------------------------------------------------------
// Evaluation: host pricing over the captured scope, optional sandboxed code,
// then one resolved view per audience. Pure: no bindings, no effects.
// ---------------------------------------------------------------------------

function setPointer(root: JsonObject, pointer: string, value: unknown) {
  const parts = pointer.slice("/inputs/".length).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!pointer.startsWith("/inputs/") || parts.some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw badRequest("module_export_path", "Invalid writable export path.");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    if (parent[part] === undefined || parent[part] === null) parent[part] = {};
    if (typeof parent[part] !== "object" || Array.isArray(parent[part])) throw badRequest("module_export_path", "Writable export parent must be an object.");
    parent = parent[part] as JsonObject;
  }
  parent[parts.at(-1)!] = jsonClone(value);
}
const inputNamed = (definition: Definition, kind: string) => Object.entries(definition.presentation.inputs).find(([, input]) => input.kind === kind)?.[0];
function choicesOf(definition: Definition, inputs: JsonObject): ScopeChoices {
  const at = (kind: string) => { const name = inputNamed(definition, kind); return name ? readPointer({ inputs }, definition.exports[name]!.path) : undefined; };
  return normalizeChoices({ selections: at("scope_selections"), variants: at("variant") });
}
async function sourceDocument(organizationId: string, source: JsonObject | null) {
  if (source?.kind !== "document") return null;
  return (await documentStore()).readDocumentInstance(organizationId, text(source.documentId)).catch(error => missingRecord<JsonObject>(error));
}
/** Both audiences see only declared exports; customers only what the module lists for them. */
function exportsFor(definition: Definition, values: { inputs: JsonObject; outputs: JsonObject }, audience: PresentationAudience) {
  const spec = definition.presentation, out: JsonObject = {};
  for (const [name, field] of Object.entries(definition.exports)) {
    if (field.access === "private") continue;
    if (audience === "customer" && !spec.customer.exports.includes(name) && !spec.inputs[name]?.audience.includes("customer")) continue;
    const value = readPointer(values, field.path);
    if (value === undefined) continue;
    validateJson(field.schema, value, `module export ${name}`);
    out[name] = jsonClone(value);
  }
  return out;
}
async function compute(organizationId: string, definition: Definition, projectId: string, source: JsonObject | null, inputs: JsonObject): Promise<Computed> {
  const spec = definition.presentation;
  // Interactive surfaces fill in over time: present values must be valid, absent ones are reported.
  const { required: _required, ...partial } = definition.inputSchema as JsonObject;
  validateJson(partial, inputs, "presentation inputs");
  const missing = list(definition.inputSchema.required).map(text).filter(key => inputs[key] === undefined || inputs[key] === null);
  const { applyScopeSelections, documentCheckoutPricing, documentScopeEntities, organizationLogoUrl } = await documents();
  const document = await sourceDocument(organizationId, source) || { project_id: projectId, outputs: {}, delivery: {} };
  const entities = await documentScopeEntities(organizationId, document, inputs);
  const branding = object(entities.org.branding);
  const org = { name: text(entities.org.name), logo_url: await organizationLogoUrl(organizationId, branding, entities.org, false).catch(() => ""), colors: object(branding.colors) };
  let outputs: JsonObject = { org }, items: unknown[] = [];
  if (spec.pricing === "scope") {
    const price = async (choices: ScopeChoices) => {
      const applied = applyVariantChoices(applyScopeSelections(list(inputs.scope_items), { selections: choices.selections }), choices.variants);
      return { applied, priced: await documentCheckoutPricing(organizationId, document, { ...inputs, scope_items: applied }, {}, entities) };
    };
    const choices = choicesOf(definition, inputs), current = await price(choices);
    items = current.applied;
    const totals = current.priced.totals, { offered, alternatives } = offeredChoices(items, choices);
    // Each alternative is repriced whole, so its difference is exact under formulas and tax.
    const differences = new Map<string, number>();
    for (const alternative of alternatives.slice(0, MAX_ALTERNATIVES)) differences.set(alternative.path, (await price(alternative.choices)).priced.totals.total_cents);
    const annotate = (entry: JsonObject, path: string) => { const total = differences.get(path); if (total !== undefined) Object.assign(entry, { total_cents: total, delta_cents: total - totals.total_cents }); };
    for (const group of offered.groups) for (const option of group.options as JsonObject[]) annotate(option, `group:${group.id}:${option.id}`);
    for (const option of offered.optional) annotate(option, `optional:${option.id}`);
    for (const line of offered.variants) for (const dimension of line.dimensions as JsonObject[]) for (const value of dimension.values as JsonObject[]) annotate(value, `variant:${line.item_id}:${dimension.id}:${value.id}`);
    // Same basis signing mints receivables from: percentages divide the contract value.
    const rows = normalizeScheduleRows(inputs.payment_schedule);
    const scopeSubtotal = Math.max(0, totals.subtotal_cents - totals.adjustments_cents);
    const basis = rows.length ? scopeSubtotal + Math.round(scopeSubtotal * Math.max(0, Number(inputs.tax_percent) || 0) / 100) : Math.max(0, totals.total_cents);
    const schedule = resolveScheduleItems(rows, { total_cents: basis }).map(item => ({ ...(item.id ? { id: item.id } : {}), label: item.label, amount_cents: item.amount_cents, payment_kind: item.payment_kind, due_rule: item.due_rule }));
    outputs = { org, pricing: { currency: "USD", rows: current.priced.rows.map(publicRow), totals, schedule }, offered };
  }
  let authoredView: JsonObject | undefined;
  if (definition.source.trim()) {
    const denied = async () => { throw badRequest("module_binding_undeclared", "Presentations cannot read data or invoke actions."); };
    const result = await runModuleCode({ source: definition.source, inputs, state: { ...outputs, missing }, mode: "evaluate" }, { read: denied, invoke: denied });
    validateJson({ type: "object", required: ["outputs"], properties: { outputs: { type: "object" }, view: { type: "object" } }, additionalProperties: false }, result, "module result");
    // Code adds its own outputs; the host-priced values are not its to replace.
    outputs = { ...result.outputs, ...outputs };
    authoredView = result.view;
  }
  validateJson(definition.outputSchema, outputs, "module outputs");
  const resolve = (audience: PresentationAudience) => {
    const raw = authoredView || definition.renderer;
    if (!raw) return null;
    const scope = { ...exportsFor(definition, { inputs, outputs }, audience), org };
    // Slides bind the way documents do: {{org.logo_url}}, {{customer.name}}, {{project.address}}.
    return validateModuleView(FMDocModel.resolveBindings(validateModuleView(raw), { params: scope, outputs: scope, computed: scope, org, customer: object((scope as JsonObject).customer), project: object((scope as JsonObject).project) }));
  };
  const ready = !missing.length && (spec.pricing !== "scope" || list(inputs.scope_items).length > 0);
  return { outputs, view: resolve("internal"), customerView: resolve("customer"), missing, ready, items };
}

type WidgetNode = { id: string; widget: string; config: JsonObject; pageId: string };
function widgetNodes(layout: JsonObject | null): WidgetNode[] {
  const found: WidgetNode[] = [];
  const visit = (value: unknown, pageId: string) => {
    const node = object(value), props = object(node.props);
    if (node.type === "widget" && typeof props.widget === "string") found.push({ id: text(node.id), widget: props.widget.split("@")[0]!.toLowerCase(), config: object(props.config), pageId });
    list(node.children).forEach(child => visit(child, pageId));
  };
  if (layout?.kind === "view") visit(layout.root, "");
  else for (const page of list(layout?.pages).map(object)) list(page.children).forEach(child => visit(child, text(page.id)));
  return found;
}
/** Widget data keyed by node id, from the same customer-safe state the response carries. */
async function widgetData(organizationId: string, instance: ModuleInstance, definition: Definition, layout: JsonObject | null, writable: boolean) {
  const nodes = widgetNodes(layout), outputs = object(instance.outputs), data: Record<string, unknown> = {};
  const targets = Object.fromEntries(nodes.filter(node => node.widget === "doc.choice_selection").map(node => [choiceKey(node.config), { page_id: node.pageId, node_id: node.id }]));
  const context = { organizationId, document: {}, project: null, target: "interactive", services: {}, params: { [PRESENTATION_STATE_KEY]: { pricing: outputs.pricing, offered: outputs.offered, targets, writable,
    inputs: { scope_selections: inputNamed(definition, "scope_selections") || "", variant: inputNamed(definition, "variant") || "" } } } } as unknown as WidgetResolveContext;
  for (const node of nodes) if ((PRESENTATION_WIDGETS as readonly string[]).includes(node.widget)) data[node.id] = await documentWidgetResolver(node.widget)!(context, node.config).catch(() => null) ?? null;
  return data;
}

/** The stable response shape for both audiences. Private state never appears in it. */
async function state(instance: ModuleInstance, definition: Definition, audience: PresentationAudience, access: "view" | "choose") {
  const spec = definition.presentation, info = meta(instance), frozen = !!instance.frozen;
  const visible = exportsFor(definition, { inputs: instance.inputs, outputs: instance.outputs }, audience);
  const outputs = object(instance.outputs);
  const inputs: JsonObject = {};
  for (const [name, input] of Object.entries(spec.inputs)) {
    if (!input.audience.includes(audience)) continue;
    inputs[name] = { kind: input.kind, ...(input.label ? { label: input.label } : {}), ...(input.description ? { description: input.description } : {}), writable: !frozen && access === "choose", value: visible[name] ?? null };
  }
  const contract = info.contract;
  const layout = ((audience === "customer" ? instance.customerView : instance.view) || null) as JsonObject | null;
  const base = {
    id: instance.id, revision: instance.revision, kind: "presentation" as const, name: definition.name, audience, access: frozen ? "view" as const : access,
    status: frozen ? "contracted" : info.submitted && info.submitted.stateHash === contentHash(instance.inputs) ? "submitted" : "open",
    frozen, ready: info.ready, missing: info.missing,
    layout, widgetData: await widgetData(text(instance.organizationId), instance, definition, layout, !frozen && access === "choose"),
    exports: visible, inputs, pricing: outputs.pricing || null, offered: outputs.offered || null,
    org: outputs.org || null, customer: visible.customer ?? null, project: visible.project ?? null, measurements: visible.measurements ?? null,
    settings: { customerContract: spec.customer.contract }
  };
  if (audience === "customer") return { ...base, contract: contract ? { state: frozen ? "sent" : "draft" } : null };
  return {
    ...base, projectId: instance.projectId, moduleId: instance.moduleId, version: instance.version, source: info.source,
    submitted: info.submitted, contract: contract ? { ...contract, current: contract.stateHash === contentHash(instance.inputs) } : null,
    shares: info.shares.map(share => ({ ...share, active: !share.revokedAt && (!share.expiresAt || Date.parse(text(share.expiresAt)) > Date.now()) }))
  };
}
const record = (organizationId: string, instance: ModuleInstance, actor: PresentationActor, type: string, payload: JsonObject) =>
  saveRecord(organizationId, EXECUTIONS, id("presentation_change"), {
    instanceId: instance.id, kind: `presentation.${type}`, mode: "evaluate", status: "complete", inputRevision: instance.revision, definitionVersion: instance.version,
    actor: actor.kind === "user" ? { kind: "user", userId: actor.ctx.auth?.userId || actor.ctx.system?.kind || "system" } : { kind: "customer", shareId: actor.shareId, ...actor.audit },
    at: new Date().toISOString(), ...payload
  }, undefined, true);
async function documentEvent(organizationId: string, instance: ModuleInstance, type: string, payload: JsonObject, auth: PlatformAuthContext | null) {
  const document = await sourceDocument(organizationId, meta(instance).source);
  if (document) await (await documentStore()).recordDocumentEvent(organizationId, document, `document.presentation.${type}`, { presentation_id: instance.id, ...payload }, auth, { emit: false }).catch(() => null);
}
/** What the viewer was shown for one pick, taken from the state they were looking at. */
function presentedFor(outputs: JsonObject, kind: string, value: unknown) {
  const offered = object(outputs.offered), pick = object(value), brief = (entry: JsonObject) => ({ id: entry.id, title: entry.title ?? entry.label, ...(entry.price_cents !== undefined ? { price_cents: entry.price_cents } : {}), ...(entry.delta_cents !== undefined ? { delta_cents: entry.delta_cents } : {}), selected: entry.selected === true });
  if (kind === "variant") {
    const dimension = list(object(list(offered.variants).map(object).find(line => text(line.item_id) === text(pick.item_id))).dimensions).map(object).find(entry => text(entry.id) === text(pick.dimension_id));
    return { key: choiceKey({ kind: "variant", ...pick }), presented: list(object(dimension).values).map(object).filter(entry => entry.available !== false).map(brief), chosen: text(pick.value_id) };
  }
  const group = list(offered.groups).map(object).find(entry => list(entry.options).map(object).some(option => text(option.id) === text(pick.item_id)));
  if (group) return { key: `group:${group.id}`, label: group.label, presented: list(group.options).map(object).map(brief), chosen: text(pick.item_id) };
  return { key: `optional:${text(pick.item_id)}`, presented: list(offered.optional).map(object).filter(entry => text(entry.id) === text(pick.item_id)).map(brief), chosen: pick.selected === true };
}
/** The contract's record: every choice presented, what stands chosen, and who last chose it. */
async function choiceRecord(organizationId: string, instance: ModuleInstance, outputs: JsonObject) {
  const last = new Map<string, JsonObject>();
  for (const receipt of (await records(organizationId, EXECUTIONS)).filter(entry => entry.instanceId === instance.id && entry.kind === "presentation.changed").sort((a, b) => text(a.at).localeCompare(text(b.at))))
    for (const entry of list(receipt.changes).map(object)) if (text(entry.key)) last.set(text(entry.key), { chosen_by: receipt.actor, chosen_at: receipt.at });
  const by = (key: string) => last.get(key) || { chosen_by: { kind: "default" }, chosen_at: null };
  const offered = object(outputs.offered), brief = (entry: JsonObject) => ({ id: entry.id, title: entry.title ?? entry.label, ...(entry.price_cents !== undefined ? { price_cents: entry.price_cents } : {}) });
  return [
    ...list(offered.groups).map(object).map(group => ({ key: `group:${group.id}`, kind: "group", label: group.label, presented: list(group.options).map(object).map(brief), chosen: group.selected, ...by(`group:${group.id}`) })),
    ...list(offered.optional).map(object).map(option => ({ key: `optional:${option.id}`, kind: "optional", label: option.title, presented: [brief(option)], chosen: option.selected === true, ...by(`optional:${option.id}`) })),
    ...list(offered.variants).map(object).flatMap(line => list(line.dimensions).map(object).map(dimension => ({ key: `variant:${line.item_id}:${dimension.id}`, kind: "variant", label: `${line.name} \u00b7 ${dimension.label}`, presented: list(dimension.values).map(object).map(brief), chosen: dimension.selected, ...by(`variant:${line.item_id}:${dimension.id}`) })))
  ];
}
const total = (outputs: unknown) => Number(object(object(object(outputs).pricing).totals).total_cents ?? 0);
async function save(organizationId: string, instance: ModuleInstance, patch: JsonObject, computed?: Computed) {
  return await saveRecord(organizationId, INSTANCES, instance.id, {
    ...instance, ...(computed ? { outputs: computed.outputs, view: computed.view, customerView: computed.customerView } : {}), ...patch,
    presentation: { ...meta(instance), ...(computed ? { missing: computed.missing, ready: computed.ready } : {}), ...object(patch.presentation) }
  }, instance.revision) as ModuleInstance;
}

// ---------------------------------------------------------------------------
// Definitions and the workflow hook
// ---------------------------------------------------------------------------

export async function listPresentationModules(ctx: PublicationContext) {
  await allowed(ctx, undefined, "read");
  return (await records(ctx.organizationId, MODULES)).filter(module => module.kind === "presentation");
}
/** The standard contract for presenting a priced scope: document param names in, priced rows and offers out. */
export function scopePresentationDefinition(input: { name: string; layout: JsonObject; tags?: string[]; source?: string; customerContract?: "review" | "direct"; contract?: JsonObject; inputs?: Record<string, { schema: JsonObject; audience?: PresentationAudience[]; label?: string; contract_param?: string }> }) {
  const extra = input.inputs || {}, any = {}, map = { type: "object" };
  return {
    name: input.name, kind: "presentation", tags: input.tags || [], source: input.source || "", renderer: input.layout,
    inputSchema: { type: "object", required: ["scope_items"], properties: { scope_items: { type: "array" }, pricing_adjustments: { type: "array" }, payment_schedule: any, tax_percent: { type: "number" }, customer: map, project: map, measurements: map, choices: { type: "object", properties: { selections: map, variants: map } }, ...Object.fromEntries(Object.entries(extra).map(([name, field]) => [name, field.schema])) } },
    outputSchema: map,
    exports: {
      pricing: { path: "/outputs/pricing", schema: map, access: "read" }, offered: { path: "/outputs/offered", schema: map, access: "read" },
      customer: { path: "/inputs/customer", schema: map, access: "read" }, project: { path: "/inputs/project", schema: map, access: "read" }, measurements: { path: "/inputs/measurements", schema: map, access: "read" },
      selections: { path: "/inputs/choices/selections", schema: map, access: "write" }, variants: { path: "/inputs/choices/variants", schema: map, access: "write" },
      // Raw lines carry costs and price book snapshots; only the priced projection is public.
      scope_items: { path: "/inputs/scope_items", schema: { type: "array" }, access: "private" },
      ...Object.fromEntries(Object.entries(extra).map(([name, field]) => [name, { path: `/inputs/${name}`, schema: field.schema, access: "write" }]))
    },
    presentation: {
      pricing: "scope", customer: { exports: ["pricing", "offered", "customer", "project", "measurements"], contract: input.customerContract || "review" }, contract: input.contract || {},
      inputs: {
        selections: { kind: "scope_selections", audience: ["internal", "customer"] }, variants: { kind: "variant", audience: ["internal", "customer"] },
        ...Object.fromEntries(Object.entries(extra).map(([name, field]) => [name, { kind: "value", audience: field.audience || ["internal"], ...(field.label ? { label: field.label } : {}), ...(field.contract_param ? { contract_param: field.contract_param } : {}) }]))
      }
    }
  };
}
export async function publishPresentation(ctx: PublicationContext, definition: unknown, moduleId = "") {
  if (object(definition).kind !== "presentation") throw badRequest("presentation_module_required", "Publish a presentation definition here.");
  return publishModule(ctx, definition, moduleId);
}
/**
 * Seed hook for presentation presets, called from trusted seed code (the caller
 * owns authorization). Publishes `layout` as the standard scope presentation at
 * a stable module id, and republishes when `preset_revision` rises unless the
 * organization has since published its own version. Returns the module id to
 * name in a workflow's `completion.presentation` or a template's metadata.
 */
export async function ensurePresentationPreset(organizationId: string, preset: { id: string; name: string; layout: JsonObject; preset_revision: number; tags?: string[]; customerContract?: "review" | "direct"; contract?: JsonObject; definition?: JsonObject }) {
  const moduleId = `preset_presentation_${preset.id}`;
  const current = await getRecord(organizationId, MODULES, moduleId).catch(error => missingRecord<JsonObject>(error));
  if (current && (Number(current.preset_revision || 0) >= preset.preset_revision || current.version !== current.preset_version)) return { moduleId, version: text(current.version), published: false };
  const stored = await storeModuleVersion(organizationId, { ...scopePresentationDefinition({ name: preset.name, layout: preset.layout, tags: preset.tags, customerContract: preset.customerContract, contract: preset.contract }), ...preset.definition }, moduleId);
  await saveRecord(organizationId, MODULES, moduleId, { name: stored.name, kind: stored.kind, tags: stored.tags, version: stored.version, preset_revision: preset.preset_revision, preset_version: stored.version });
  return { moduleId, version: text(stored.version), published: true };
}
/** What a draft's final step offers. Skipping the presentation is always possible. */
export async function documentCompletion(organizationId: string, document: JsonObject) {
  const store = await documentStore();
  const workflowRef = object(document.workflow_ref), templateRef = object(document.template_ref);
  const workflow = text(workflowRef.workflow_id) ? await store.readDocumentWorkflowVersion(organizationId, text(workflowRef.workflow_id), text(document.status) === "draft" ? undefined : Number(workflowRef.version) || undefined).catch(() => null) : null;
  const declared = workflowCompletionSchema.safeParse(object(object(workflow).definition).completion);
  const template = text(templateRef.template_id) ? await store.readDocumentTemplate(organizationId, text(templateRef.template_id)).catch(() => null) : null;
  const named = object(object(document.metadata).presentation).module_id ? object(object(document.metadata).presentation)
    : declared.success && declared.data.presentation ? declared.data.presentation : object(object(object(template).metadata).presentation);
  const presentation = text(named.module_id) ? { moduleId: text(named.module_id), ...(text(named.version) ? { version: text(named.version) } : {}) } : null;
  const offers = declared.success ? declared.data.offers : presentation ? ["present", "send_estimate", "send_presentation"] : ["send_estimate"];
  return { offers, default: declared.success && declared.data.default || offers[0], presentation, sharePresentationWithEstimate: declared.success ? declared.data.share_presentation_with_estimate : "ask" };
}
export async function documentPresentationOptions(ctx: PublicationContext, documentId: string) {
  const document = await (await documentStore()).readDocumentInstance(ctx.organizationId, documentId);
  await allowed(ctx, text(document.project_id), "read");
  const instances = (await records(ctx.organizationId, INSTANCES)).filter(entry => entry.kind === "presentation" && meta(entry).source?.documentId === documentId);
  return { ...await documentCompletion(ctx.organizationId, document), presentations: instances.map(entry => ({ id: entry.id, revision: entry.revision, frozen: !!entry.frozen, ready: meta(entry).ready, createdAt: entry.createdAt })) };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Capture what the presentation declares from its source; later source edits arrive only through refresh. */
async function capture(ctx: PublicationContext, definition: Definition, source: JsonObject, projectId: string) {
  const writable = new Set(Object.values(definition.exports).filter(field => field.access === "write").map(field => field.path.split("/")[2]));
  const keys = Object.keys(object(definition.inputSchema.properties)).filter(key => !writable.has(key));
  const seed: JsonObject = {};
  if (source.kind === "document") {
    const document = await (await documentStore()).readDocumentInstance(ctx.organizationId, text(source.documentId));
    if (text(document.project_id) !== projectId) throw badRequest("presentation_source_project", "The source document belongs to another project.");
    const params = object(document.params), entities = await (await documents()).documentScopeEntities(ctx.organizationId, document, params);
    const summary: Record<string, JsonObject> = {
      customer: { name: text(entities.customer.name), email: text(entities.customer.email), phone: text(entities.customer.phone) },
      project: { id: projectId, title: text(entities.project.title), address: text(entities.project.address) }
    };
    for (const key of keys) { const value = summary[key] ?? params[key]; if (value !== undefined && value !== null) seed[key] = jsonClone(value); }
    return { seed, source: { kind: "document", documentId: document.id, documentRevision: document.revision } };
  }
  const exported = await getModuleExports({ ...ctx, projectId }, text(source.instanceId), text(source.exportName));
  if (exported.status !== "ready" || !exported.value || typeof exported.value !== "object" || Array.isArray(exported.value)) throw conflict("module_export_pending", "The source export is not a ready object.");
  if (exported.provenance.kind === "presentation") throw badRequest("presentation_source_kind", "A presentation is produced by a workflow or document.");
  for (const key of keys) { const value = (exported.value as JsonObject)[key]; if (value !== undefined && value !== null) seed[key] = jsonClone(value); }
  return { seed, source: { kind: "module", instanceId: text(source.instanceId), exportName: text(source.exportName), revision: exported.revision } };
}
export async function createPresentation(ctx: PublicationContext, input: { projectId?: string; documentId?: string; source?: { instanceId: string; exportName: string }; moduleId?: string; version?: string; inputs?: JsonObject }) {
  const document = input.documentId ? await (await documentStore()).readDocumentInstance(ctx.organizationId, input.documentId) : null;
  const projectId = text(input.projectId || document?.project_id);
  if (!projectId || !(await readDocument(ctx.organizationId, "projects", projectId).catch(error => missingRecord(error)))) throw badRequest("module_project_missing", "An existing project is required.");
  await allowed(ctx, projectId, "write");
  if (document && text(document.status) !== "draft") throw conflict("presentation_source_not_draft", "Present a draft; this document has already been issued.");
  const named = input.moduleId ? { moduleId: input.moduleId, version: input.version } : document ? (await documentCompletion(ctx.organizationId, document)).presentation : null;
  if (!named) throw badRequest("presentation_module_required", "This workflow does not name a presentation; choose a presentation module.");
  const module = await getRecord(ctx.organizationId, MODULES, named.moduleId);
  const version = text(named.version || module.version), definition = await definitionFor(ctx.organizationId, named.moduleId, version);
  const captured = document ? await capture(ctx, definition, { kind: "document", documentId: document.id }, projectId)
    : input.source ? await capture(ctx, definition, { kind: "module", ...input.source }, projectId) : { seed: {}, source: null };
  const inputs = { ...captured.seed, ...jsonClone(input.inputs || {}) };
  const computed = await compute(ctx.organizationId, definition, projectId, captured.source, inputs);
  const instance = await saveRecord(ctx.organizationId, INSTANCES, id("presentation"), {
    organizationId: ctx.organizationId, projectId, moduleId: named.moduleId, version, codePolicy: "frozen", kind: "presentation", tags: definition.tags, inputs,
    outputs: computed.outputs, view: computed.view, customerView: computed.customerView, privateState: {}, bindings: {}, bindingManifest: {}, frozen: false, createdAt: new Date().toISOString(),
    presentation: { source: captured.source, shares: [], contract: null, submitted: null, missing: computed.missing, ready: computed.ready, createdBy: ctx.auth?.userId || "" }
  }, undefined, true) as ModuleInstance;
  const receipt = await record(ctx.organizationId, instance, { kind: "user", ctx }, "created", { resultRevision: instance.revision, totalAfterCents: total(computed.outputs) });
  const saved = await save(ctx.organizationId, instance, { lastExecutionId: receipt.id, lastAttemptId: receipt.id });
  await documentEvent(ctx.organizationId, saved, "created", { module_id: named.moduleId, version }, ctx.auth);
  return state(saved, definition, "internal", "choose");
}
export async function readPresentation(ctx: PublicationContext, instanceId: string) {
  const { instance, definition } = await load(ctx.organizationId, instanceId);
  await allowed(ctx, instance.projectId, "read");
  return state(instance, definition, "internal", "choose");
}
export async function listPresentations(ctx: PublicationContext, projectId: string) {
  await allowed(ctx, projectId, "read");
  return (await records(ctx.organizationId, INSTANCES)).filter(entry => entry.kind === "presentation" && entry.projectId === projectId)
    .map(entry => ({ id: entry.id, revision: entry.revision, moduleId: entry.moduleId, version: entry.version, frozen: !!entry.frozen, ready: meta(entry).ready, source: meta(entry).source, createdAt: entry.createdAt }));
}
/** Evidence of who changed what, oldest first. Internal only. */
export async function presentationChanges(ctx: PublicationContext, instanceId: string) {
  const { instance } = await load(ctx.organizationId, instanceId);
  await allowed(ctx, instance.projectId, "read");
  return (await records(ctx.organizationId, EXECUTIONS)).filter(entry => entry.instanceId === instanceId && text(entry.kind).startsWith("presentation.")).sort((a, b) => text(a.at).localeCompare(text(b.at)))
    .map(entry => ({ id: entry.id, type: text(entry.kind).slice("presentation.".length), at: entry.at, actor: entry.actor, changes: entry.changes || [], inputRevision: entry.inputRevision, resultRevision: entry.resultRevision ?? null, totalBeforeCents: entry.totalBeforeCents ?? null, totalAfterCents: entry.totalAfterCents ?? null }));
}

/** Once the contract is out for signature the presentation is the record of what was chosen. */
async function editable(organizationId: string, instance: ModuleInstance, expectedRevision: number) {
  if (instance.frozen) throw conflict("presentation_frozen", "This presentation was sent as a contract and can no longer change.");
  if (!expectedRevision || expectedRevision !== instance.revision) throw conflict("module_revision", "The current revision is required.");
  const contract = meta(instance).contract;
  if (!contract) return instance;
  const document = await (await documentStore()).readDocumentInstance(organizationId, text(contract.documentId)).catch(error => missingRecord<JsonObject>(error));
  const status = text(document?.status) || "void";
  if (status === "draft") return instance;
  if (["void", "declined", "expired"].includes(status)) return save(organizationId, instance, { presentation: { contract: null } });
  await save(organizationId, instance, { frozen: true, frozenAt: new Date().toISOString() });
  throw conflict("presentation_frozen", "This presentation was sent as a contract and can no longer change.");
}
async function change(actor: PresentationActor, organizationId: string, instanceId: string, input: { expectedRevision: number; changes: PresentationChange[] }) {
  const loaded = await load(organizationId, instanceId), definition = loaded.definition, spec = definition.presentation;
  const audience: PresentationAudience = actor.kind === "user" ? "internal" : "customer";
  if (actor.kind === "user") await allowed(actor.ctx, loaded.instance.projectId, "write");
  else if (actor.access !== "choose") throw forbidden("presentation_read_only", "This link can view the presentation but not change it.");
  const instance = await editable(organizationId, loaded.instance, input.expectedRevision);
  if (!input.changes.length || input.changes.length > 20) throw badRequest("presentation_changes_invalid", "Send between one and twenty changes.");
  const inputs = jsonClone(instance.inputs), accepted: JsonObject[] = [];
  const { applyScopeSelections } = await documents();
  for (const entry of input.changes) {
    const declared = spec.inputs[entry.input], field = definition.exports[entry.input];
    if (!declared || !field) throw badRequest("presentation_input_unknown", `'${entry.input}' is not an interactive input of this presentation.`);
    if (!declared.audience.includes(audience)) throw forbidden("presentation_input_forbidden", "This input cannot be changed here.");
    let next: unknown = entry.value;
    if (declared.kind !== "value") {
      // Validate each pick against the lines as they stand after earlier picks.
      const choices = choicesOf(definition, inputs);
      const applied = applyVariantChoices(applyScopeSelections(list(inputs.scope_items), { selections: choices.selections }), choices.variants);
      if (declared.kind === "scope_selections") next = { ...choices.selections, ...selectionChoice(applied, entry.value) };
      else { const pick = variantChoice(applied, choices.variants, entry.value); next = { ...choices.variants, [pick.itemId]: { ...choices.variants[pick.itemId], [pick.dimensionId]: pick.valueId } }; }
    }
    validateJson(field.schema, next, entry.input);
    setPointer(inputs, field.path, next);
    accepted.push({ input: entry.input, value: jsonClone(entry.value), ...(declared.kind !== "value" ? presentedFor(object(instance.outputs), declared.kind, entry.value) : {}) });
  }
  const computed = await compute(organizationId, definition, instance.projectId, meta(instance).source, inputs);
  const receiptId = id("presentation_change");
  const saved = await save(organizationId, instance, { inputs, lastExecutionId: receiptId, lastAttemptId: receiptId }, computed);
  await saveRecord(organizationId, EXECUTIONS, receiptId, {
    instanceId, kind: "presentation.changed", mode: "evaluate", status: "complete", inputRevision: instance.revision, resultRevision: saved.revision, definitionVersion: instance.version,
    actor: actor.kind === "user" ? { kind: "user", userId: actor.ctx.auth?.userId || "system" } : { kind: "customer", shareId: actor.shareId, ...actor.audit },
    at: new Date().toISOString(), changes: accepted, totalBeforeCents: total(instance.outputs), totalAfterCents: total(computed.outputs)
  }, undefined, true);
  return state(saved, definition, audience, "choose");
}
export const changePresentation = (ctx: PublicationContext, instanceId: string, input: { expectedRevision: number; changes: PresentationChange[] }) => change({ kind: "user", ctx }, ctx.organizationId, instanceId, input);

/** Re-evaluate; with refresh, recapture the source the salesperson has since edited and keep the picks that still apply. */
export async function evaluatePresentation(ctx: PublicationContext, instanceId: string, input: { expectedRevision: number; refresh?: boolean }) {
  const loaded = await load(ctx.organizationId, instanceId), definition = loaded.definition;
  await allowed(ctx, loaded.instance.projectId, "write");
  const instance = await editable(ctx.organizationId, loaded.instance, input.expectedRevision), info = meta(instance);
  let inputs = jsonClone(instance.inputs), source = info.source;
  if (input.refresh && source) {
    const captured = await capture(ctx, definition, source, instance.projectId);
    inputs = { ...inputs, ...captured.seed }; source = captured.source;
    const choices = choicesOf(definition, inputs), { applyScopeSelections } = await documents();
    const applied = applyScopeSelections(list(inputs.scope_items), { selections: choices.selections });
    const keep = <T>(check: () => T) => { try { check(); return true; } catch { return false; } };
    const selections = Object.fromEntries(Object.entries(choices.selections).filter(([key, value]) => keep(() => selectionChoice(applied, typeof value === "boolean" ? { item_id: key, selected: value } : { group_id: key, item_id: value }))));
    const variants = Object.fromEntries(Object.entries(choices.variants).map(([itemId, picks]) => [itemId, Object.fromEntries(Object.entries(picks).filter(([dimensionId, valueId]) => keep(() => variantChoice(applied, {}, { item_id: itemId, dimension_id: dimensionId, value_id: valueId }))))]).filter(([, picks]) => Object.keys(picks as JsonObject).length));
    for (const [kind, value] of [["scope_selections", selections], ["variant", variants]] as const) { const name = inputNamed(definition, kind); if (name) setPointer(inputs, definition.exports[name]!.path, value); }
  }
  const computed = await compute(ctx.organizationId, definition, instance.projectId, source, inputs);
  const receipt = await record(ctx.organizationId, instance, { kind: "user", ctx }, input.refresh ? "refreshed" : "evaluated", { totalBeforeCents: total(instance.outputs), totalAfterCents: total(computed.outputs) });
  return state(await save(ctx.organizationId, instance, { inputs, lastExecutionId: receipt.id, lastAttemptId: receipt.id, presentation: { source } }, computed), definition, "internal", "choose");
}

// ---------------------------------------------------------------------------
// Contract: write the presented choices onto a draft through the documents
// writer. Sending and signing stay the documents domain's, with its guarantees.
// ---------------------------------------------------------------------------

async function produce(organizationId: string, instance: ModuleInstance, definition: Definition, auth: PlatformAuthContext, actor: PresentationActor, documentId?: string) {
  const spec = definition.presentation, info = meta(instance), service = await documents(), store = await documentStore();
  const computed = await compute(organizationId, definition, instance.projectId, info.source, instance.inputs);
  if (!computed.ready) throw conflict("presentation_incomplete", "Complete the presentation before producing its contract.", { missing: computed.missing });
  const exported = exportsFor(definition, { inputs: instance.inputs, outputs: computed.outputs }, "internal");
  const params: JsonObject = { ...jsonClone(spec.contract.params) };
  if (spec.pricing === "scope") params.scope_items = jsonClone(spec.contract.lock_choices ? lockChoices(computed.items) : computed.items);
  for (const [name, input] of Object.entries(spec.inputs)) if (input.contract_param && exported[name] !== undefined) params[input.contract_param] = exported[name];
  const targetId = text(documentId || info.contract?.documentId || (info.source?.kind === "document" ? info.source.documentId : ""));
  let document = targetId ? await store.readDocumentInstance(organizationId, targetId) : null;
  if (!document) {
    if (!spec.contract.template_id && !spec.contract.document_type) throw badRequest("presentation_contract_target", "Name the draft to update, or give the presentation a contract template.");
    document = (await service.createDocumentInstance(organizationId, instance.projectId, { document_type: spec.contract.document_type || "proposal", ...(spec.contract.template_id ? { template_id: spec.contract.template_id } : {}), workflow_id: null, params: { ...instance.inputs, ...params } }, auth)).document;
  }
  if (text(document.project_id) !== instance.projectId) throw badRequest("presentation_contract_project", "The contract must belong to the presentation's project.");
  if (text(document.status) !== "draft") throw conflict("presentation_contract_not_draft", "Only a draft can take the presentation's choices. Void the issued document first.");
  const merged = { ...object(document.params), ...params };
  if (spec.pricing === "scope") {
    // The contract must total what was shown, priced by the same code on the real document.
    const priced = await service.documentCheckoutPricing(organizationId, { ...document, params: merged }, merged, {});
    if (priced.totals.total_cents !== total(computed.outputs)) throw conflict("presentation_contract_total_mismatch", "The contract would not total what the presentation shows. Refresh the presentation from its source.", { presentation_total_cents: total(computed.outputs), contract_total_cents: priced.totals.total_cents });
  }
  const stateHash = contentHash(instance.inputs), now = new Date().toISOString();
  const choices = await choiceRecord(organizationId, instance, computed.outputs);
  // In params so the sent snapshot, and so the signed record, carries what was presented and chosen.
  if (choices.length) params.presented_choices = jsonClone(choices);
  const reference = { instance_id: instance.id, module_id: instance.moduleId, version: instance.version, revision: instance.revision, state_hash: stateHash, total_cents: total(computed.outputs), produced_at: now, choices };
  const updated = await service.patchDocumentInstance(organizationId, text(document.id), { params, metadata: { presentation_ref: reference }, expected_revision: Number(document.revision) }, auth);
  const receipt = await record(organizationId, instance, actor, "contract_produced", { documentId: updated.id, documentRevision: updated.revision, stateHash, totalAfterCents: reference.total_cents });
  const saved = await save(organizationId, instance, { lastAttemptId: receipt.id, presentation: { contract: { documentId: updated.id, documentRevision: updated.revision, instanceRevision: instance.revision, stateHash, totalCents: reference.total_cents, producedAt: now, producedBy: auth.userId } } }, computed);
  await documentEvent(organizationId, saved, "contract_produced", { document_id: updated.id, state_hash: stateHash, total_cents: reference.total_cents }, auth);
  return { instance: saved, document: updated };
}
/** Where the existing signature widget signs: the issued snapshot through each signer's invitation. */
async function signTarget(sent: { document: JsonObject; snapshot: JsonObject; portal_url: string; signing: { package_id: string; invitations: Array<JsonObject & { portal_url: string }> } | null }) {
  const { signatureDefinitions } = await import("../signing/model.js");
  return { documentId: sent.document.id, snapshotId: sent.snapshot.id, packageId: sent.signing?.package_id || null, outputKeys: Object.keys(signatureDefinitions(sent.document.output_defs)),
    signers: (sent.signing?.invitations || []).map(invitation => ({ signerId: invitation.signer_id, token: invitation.token, portalUrl: invitation.portal_url })) };
}
const documentSummary = (document: JsonObject) => ({ id: document.id, revision: document.revision, status: document.status, title: document.title, documentType: document.document_type });
export async function producePresentationContract(ctx: PublicationContext, instanceId: string, input: { expectedRevision: number; documentId?: string }) {
  const loaded = await load(ctx.organizationId, instanceId);
  await allowed(ctx, loaded.instance.projectId, "write");
  const instance = await editable(ctx.organizationId, loaded.instance, input.expectedRevision);
  const result = await produce(ctx.organizationId, instance, loaded.definition, userAuth(ctx), { kind: "user", ctx }, input.documentId);
  return { presentation: await state(result.instance, loaded.definition, "internal", "choose"), document: documentSummary(result.document) };
}
async function freeze(organizationId: string, instance: ModuleInstance) {
  return save(organizationId, instance, { frozen: true, frozenAt: new Date().toISOString() });
}
/** Send estimate after presenting: produce if stale, issue for signature, then freeze what was chosen. */
export async function sendPresentationContract(ctx: PublicationContext, instanceId: string, input: { expectedRevision: number; documentId?: string; recipients?: JsonObject[]; consentContact?: string; message?: string; includePdf?: boolean; sharePresentation?: boolean }) {
  const loaded = await load(ctx.organizationId, instanceId), auth = userAuth(ctx);
  await allowed(ctx, loaded.instance.projectId, "issue");
  let instance = await editable(ctx.organizationId, loaded.instance, input.expectedRevision);
  const contract = meta(instance).contract;
  if (!contract || contract.stateHash !== contentHash(instance.inputs) || (input.documentId && input.documentId !== contract.documentId)) instance = (await produce(ctx.organizationId, instance, loaded.definition, auth, { kind: "user", ctx }, input.documentId)).instance;
  const sent = await (await documents()).sendDocument(ctx.organizationId, text(meta(instance).contract!.documentId), {
    ...(input.recipients ? { recipients: input.recipients } : {}), ...(input.consentContact ? { consent_contact: input.consentContact } : {}), ...(input.message ? { message: input.message } : {}), ...(input.includePdf !== undefined ? { include_pdf: input.includePdf } : {})
  }, auth);
  instance = await freeze(ctx.organizationId, instance);
  await record(ctx.organizationId, instance, { kind: "user", ctx }, "contract_sent", { documentId: sent.document.id, snapshotId: sent.snapshot.id });
  const share = input.sharePresentation ? await share_(ctx, instance, loaded.definition, { access: "view", recipients: input.recipients || list(object(sent.document.delivery).recipients).map(object), deliver: true }) : null;
  return { presentation: await state(share?.instance || instance, loaded.definition, "internal", "choose"), document: documentSummary(sent.document), portalUrl: sent.portal_url, signing: sent.signing, signTarget: await signTarget(sent), emailed: sent.emailed, texted: sent.texted, presentationShare: share ? share.result : null };
}

// ---------------------------------------------------------------------------
// Sharing: a revocable public link per share, hashed at rest. The link grants
// view or choose on this one presentation and nothing else.
// ---------------------------------------------------------------------------

type ShareInput = { access?: "view" | "choose"; recipients?: JsonObject[]; expiresAt?: string; deliver?: boolean; message?: string; contract?: { mode?: "review" | "direct"; consentContact?: string; includePdf?: boolean } };
async function share_(ctx: PublicationContext, instance: ModuleInstance, definition: Definition, input: ShareInput) {
  const auth = userAuth(ctx), info = meta(instance), access = input.access || "view";
  if (access === "choose" && instance.frozen) throw conflict("presentation_frozen", "A sent presentation can only be shared for viewing.");
  if (info.shares.length >= MAX_SHARES) throw conflict("presentation_share_limit", "Revoke an existing link before creating another.");
  const recipients = (input.recipients || []).map(object).map(recipient => ({ name: text(recipient.name), email: text(recipient.email).toLowerCase(), phone: text(recipient.phone), ...(text(recipient.signer_id || recipient.role) ? { signer_id: text(recipient.signer_id || recipient.role) } : {}) })).filter(recipient => recipient.name || recipient.email || recipient.phone).slice(0, 10);
  const mode = access === "choose" && definition.presentation.customer.contract === "direct" && input.contract?.mode !== "review" ? "direct" : "review";
  if (mode === "direct") {
    // The sender authorizes the later issue now, against the draft it will issue.
    const document = await sourceDocument(ctx.organizationId, info.source);
    if (!document) throw badRequest("presentation_direct_source", "Direct contracts need a source draft and its signer.");
    await (await import("../signing/service.js")).validateSigningIssue(ctx.organizationId, document, recipients, { consent_contact: input.contract?.consentContact });
  }
  const expiresAt = input.expiresAt || new Date(Date.now() + SHARE_DAYS * 86_400_000).toISOString();
  const link = await createPublicLink(ctx.organizationId, { kind: "presentation", resource_type: "document_module_instance", resource_id: instance.id, destination_path: PRESENTATION_PORTAL_PATH,
    allowed_actions: access === "choose" ? ["view", "choose", "submit"] : ["view"], expires_at: expiresAt, created_by: auth.userId, metadata: { project_id: instance.projectId } });
  const share = { id: link.document.id, access, contract: { mode, ...(input.contract?.consentContact ? { consentContact: input.contract.consentContact } : {}), includePdf: input.contract?.includePdf === true }, recipients, expiresAt, createdBy: auth.userId, createdAt: new Date().toISOString() };
  const saved = await save(ctx.organizationId, instance, { presentation: { shares: [...info.shares, share] } });
  await record(ctx.organizationId, saved, { kind: "user", ctx }, "shared", { shareId: share.id, access, recipients: recipients.map(recipient => recipient.email || recipient.phone) });
  await documentEvent(ctx.organizationId, saved, "shared", { share_id: share.id, access }, auth);
  const emailed: JsonObject[] = [];
  if (input.deliver) {
    const { sendOrganizationTransactionalEmail } = await import("../../email/organization_outbound.js");
    for (const recipient of recipients.filter(entry => entry.email)) {
      const result = await sendOrganizationTransactionalEmail({ organizationId: ctx.organizationId, branchId: ctx.branchId || "default", to: recipient.email, subject: definition.name,
        textBody: [`Hi ${recipient.name || "there"},`, "", input.message || (access === "choose" ? "Your presentation is ready. Choose your options here:" : "Here is the presentation we went through:"), "", link.url].join("\n"),
        purpose: "transactional", projectId: instance.projectId, tags: ["presentation-share"], source: { type: "user", id: "presentation_share", user_id: auth.userId }, metadata: { presentation_id: instance.id, share_id: share.id }, idempotencyKey: `presentation_share:${share.id}:${recipient.email}`
      }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : "email_failed" }));
      emailed.push({ email: recipient.email, ...object(result) });
    }
  }
  // The token is returned once to the authorized sender; only its hash is stored.
  return { instance: saved, result: { share, token: link.token, url: link.url, emailed } };
}
export async function sharePresentation(ctx: PublicationContext, instanceId: string, input: ShareInput & { expectedRevision: number }) {
  const loaded = await load(ctx.organizationId, instanceId);
  await allowed(ctx, loaded.instance.projectId, "issue");
  if (input.expectedRevision !== loaded.instance.revision) throw conflict("module_revision", "The current revision is required.");
  const shared = await share_(ctx, loaded.instance, loaded.definition, input);
  return { presentation: await state(shared.instance, loaded.definition, "internal", "choose"), ...shared.result };
}
export async function revokePresentationShare(ctx: PublicationContext, instanceId: string, shareId: string) {
  const { instance, definition } = await load(ctx.organizationId, instanceId), info = meta(instance);
  await allowed(ctx, instance.projectId, "issue");
  if (!info.shares.some(share => share.id === shareId)) throw notFound("presentation_share_not_found", "Share not found.");
  await revokePublicLink(ctx.organizationId, shareId, userAuth(ctx).userId);
  const saved = await save(ctx.organizationId, instance, { presentation: { shares: info.shares.map(share => share.id === shareId ? { ...share, revokedAt: new Date().toISOString() } : share) } });
  await record(ctx.organizationId, saved, { kind: "user", ctx }, "share_revoked", { shareId });
  return state(saved, definition, "internal", "choose");
}

// ---------------------------------------------------------------------------
// Token access. The link is the authority; it never widens past its share.
// ---------------------------------------------------------------------------

async function publicAccess(token: string, action: "view" | "choose" | "submit") {
  const link = await resolvePublicLink(token, { kind: "presentation", action });
  const loaded = await load(link.orgId, text(link.data.resource_id));
  const share = meta(loaded.instance).shares.find(entry => entry.id === link.document.id && !entry.revokedAt);
  if (!share) throw notFound("public_link_not_found", "This public link is invalid or no longer available.");
  const { isCapabilityEnabled } = await import("../../platform/capabilities.js");
  if (!(await isCapabilityEnabled(link.orgId, "platform.documents"))) throw forbidden("document_feature_disabled", "Documents are not available for this organization.");
  return { organizationId: link.orgId, ...loaded, share, access: (share.access === "choose" ? "choose" : "view") as "view" | "choose" };
}
export async function publicPresentation(token: string) {
  const found = await publicAccess(token, "view");
  return state(found.instance, found.definition, "customer", found.access);
}
export async function publicPresentationChange(token: string, input: { expectedRevision: number; changes: PresentationChange[] }, audit: JsonObject = {}) {
  const found = await publicAccess(token, "choose");
  const changed = await change({ kind: "customer", organizationId: found.organizationId, shareId: text(found.share.id), access: found.access, audit }, found.organizationId, found.instance.id, input);
  return { ...changed, access: found.access };
}
/** Customer finished choosing. review: staff take it from here. direct: the contract goes out for signature. */
export async function publicPresentationSubmit(token: string, input: { expectedRevision: number }, audit: JsonObject = {}) {
  const found = await publicAccess(token, "submit"), organizationId = found.organizationId, definition = found.definition;
  const actor: PresentationActor = { kind: "customer", organizationId, shareId: text(found.share.id), access: found.access, audit };
  let instance = await editable(organizationId, found.instance, input.expectedRevision);
  if (!meta(instance).ready) throw conflict("presentation_incomplete", "Complete the presentation before submitting it.", { missing: meta(instance).missing });
  const contract = object(found.share.contract), stateHash = contentHash(instance.inputs);
  if (contract.mode !== "direct" || definition.presentation.customer.contract !== "direct") {
    const receipt = await record(organizationId, instance, actor, "submitted", { stateHash, totalAfterCents: total(instance.outputs) });
    instance = await save(organizationId, instance, { lastAttemptId: receipt.id, presentation: { submitted: { at: new Date().toISOString(), shareId: found.share.id, stateHash, totalCents: total(instance.outputs) } } });
    await documentEvent(organizationId, instance, "submitted", { share_id: found.share.id, state_hash: stateHash, total_cents: total(instance.outputs) }, null);
    return { presentation: await state(instance, definition, "customer", found.access), signing: null, signTarget: null };
  }
  const auth = systemAuth(organizationId);
  instance = (await produce(organizationId, instance, definition, auth, actor)).instance;
  const recipients = list(found.share.recipients).map(object);
  const sent = await (await documents()).sendDocument(organizationId, text(meta(instance).contract!.documentId), { recipients, ...(contract.consentContact ? { consent_contact: contract.consentContact } : {}), include_pdf: contract.includePdf === true }, auth);
  instance = await freeze(organizationId, instance);
  await record(organizationId, instance, actor, "contract_sent", { documentId: sent.document.id, snapshotId: sent.snapshot.id });
  // The share was issued to these signers, so its holder continues straight into their signing invitation.
  return { presentation: await state(instance, definition, "customer", found.access), signing: { portalUrl: sent.signing?.invitations[0]?.portal_url || sent.portal_url }, signTarget: await signTarget(sent) };
}
