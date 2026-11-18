import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { readCompanyProfile } from "../company-profile/profile.js";
import {
  createDocumentTemplate, createDocumentWorkflow, listDocumentTemplates, listDocumentThemes, patchDocumentTemplate,
  publishDocumentTemplate, publishDocumentWorkflow, readDocumentTemplate, readDocumentTemplateVersion,
  readDocumentWorkflow, readDocumentWorkflowVersion
} from "./storage.js";
import { ensureDefaultDocumentAssets, libraryAssetDefinition } from "./library-copies.js";
import { DEFAULT_PINNED_TEMPLATE_IDS, readPinnedTemplateIds, savePinnedTemplateIds } from "./settings.js";

/**
 * The document setup (FM-582, docs/architecture/guided-experiences.md, "Document setup"): the first time someone makes
 * a document they say which kind (a proposal, an invoice, a change order or a completion certificate), and for a
 * proposal how they present one (options to choose from or a single option), whether the customer may change it, how
 * much detail it carries and whether a written scope of work goes with it; then, optionally, their prices, and one of
 * three styles. The answers choose a library template and adapt it (its parameter defaults, its workflow's steps, its
 * theme) into the organization's own template for that kind, which becomes the kind's default and its pin in New
 * document. Running the setup again for a kind republishes the same template (`tpl_setup_<kind>`), so there is one.
 *
 * Nothing here prices anything: prices are the price book's (the optional price step writes them with
 * `pricebook.prices.update`), and each proposal's prices can still be changed on that proposal. What was answered is
 * kept in the default branch's `document_setup` module, apart from the templates.
 */
export const DOCUMENT_SETUP_MODULE = "document_setup";
export const DOCUMENT_SETUP_KINDS = ["proposal", "invoice", "change_order", "completion_certificate"] as const;
export const DOCUMENT_SETUP_THEMES = ["thm_clean", "thm_margin", "thm_triangles"] as const;
export type DocumentSetupKind = typeof DOCUMENT_SETUP_KINDS[number];

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => String(value ?? "").trim();
const clone = <T>(value: T): T => structuredClone(value);

// ── The answers ─────────────────────────────────────────────────────────
const proposalAnswers = {
  /** Several options to choose from (good, better, best) or one primary option. */
  presentation: z.enum(["options", "single"]),
  /** The customer mixes and matches line items, picks one of the options given, or asks us for a new estimate. */
  customer_changes: z.enum(["mix", "pick", "ask"]),
  /** Every line item priced, or a broad breakdown (squares, the main products and a few add-ons). */
  detail: z.enum(["itemized", "rough"]),
  /** A written scope of work with photos and descriptions from the estimate goes with the proposal. */
  scope_write_up: z.boolean()
};
const answersSchema = z.object({
  document_kind: z.enum(DOCUMENT_SETUP_KINDS),
  presentation: proposalAnswers.presentation.optional(),
  customer_changes: proposalAnswers.customer_changes.optional(),
  detail: proposalAnswers.detail.optional(),
  scope_write_up: proposalAnswers.scope_write_up.optional()
});
type Answers = z.infer<typeof answersSchema>;
function checkedAnswers(value: unknown): Answers {
  const answers = answersSchema.parse(value);
  if (answers.document_kind !== "proposal") return { document_kind: answers.document_kind };
  const missing = (["presentation", "customer_changes", "detail", "scope_write_up"] as const).filter((key) => answers[key] === undefined);
  if (missing.length) throw badRequest("document_setup_answers", `Answer how you write proposals first (${missing.join(", ")}).`);
  // Picking one of the options given only exists when options are given; with one option the alternative is asking us.
  if (answers.presentation === "single" && answers.customer_changes === "pick") answers.customer_changes = "ask";
  if (answers.presentation === "options" && answers.customer_changes === "ask") answers.customer_changes = "pick";
  return answers;
}

// ── What the answers make ───────────────────────────────────────────────
/** The library template each kind starts from when the organization has no default of its own. */
const KIND_BASE: Record<Exclude<DocumentSetupKind, "proposal">, string> = {
  invoice: "tpl_invoice_default",
  change_order: "tpl_change_order_default",
  completion_certificate: "tpl_roofing_completion_certificate"
};
const KIND_NAME: Record<DocumentSetupKind, string> = { proposal: "Proposal", invoice: "Invoice", change_order: "Change order", completion_certificate: "Completion certificate" };
export const setupTemplateId = (kind: DocumentSetupKind) => `tpl_setup_${kind}`;
export const setupWorkflowId = (kind: DocumentSetupKind) => `wfl_setup_${kind}`;

export type DocumentPlan = {
  kind: DocumentSetupKind;
  /** The library template it starts from; for a kind other than a proposal, the organization's default when it has one. */
  base: string;
  name: string;
  description: string;
  /** Parameter defaults set on the template. */
  params: Record<string, unknown>;
  /** Workflow steps left out. */
  drop_steps: string[];
};

/**
 * The proposal the answers describe. Options to choose from: the Good / Better / Best proposal, whose customer picks a
 * package. One option, itemized: every line priced. One option, a broad breakdown: the lines without their prices
 * (the total and the main products), or the one-page proposal when no written scope goes with it. No written scope:
 * no Photos & description step. A customer who cannot change it: no customer's choosing step, so a change is a new
 * estimate.
 */
export function planDocument(answers: Answers): DocumentPlan {
  if (answers.document_kind !== "proposal") {
    const kind = answers.document_kind;
    return { kind, base: KIND_BASE[kind], name: KIND_NAME[kind], description: "", params: {}, drop_steps: [] };
  }
  const writeUp = answers.scope_write_up === true;
  if (answers.presentation === "options") {
    return {
      kind: "proposal", base: "tpl_instant_roofing_options", name: "Proposal · Good / Better / Best",
      description: answers.customer_changes === "mix"
        ? "Three complete options from one set of measurements. The customer compares them and can mix and match line items before signing."
        : "Three complete options from one set of measurements. The customer picks one, signs and pays the deposit.",
      params: {}, drop_steps: []
    };
  }
  const itemized = answers.detail === "itemized";
  const base = itemized || writeUp ? "tpl_instant_roofing_detailed" : "tpl_instant_roofing_onepage";
  const changes = answers.customer_changes === "mix"
    ? " The customer can add or remove optional lines before signing."
    : " Changes are a new estimate.";
  return {
    kind: "proposal", base,
    name: itemized ? "Proposal · Itemized" : "Proposal · Summary",
    description: (itemized ? "Every line priced from the measurements and your price book." : "The main products and add-ons with one total.")
      + (writeUp ? " A written scope of work with photos comes first." : "") + changes,
    params: base === "tpl_instant_roofing_detailed" ? { show_line_prices: itemized } : {},
    drop_steps: [...(base === "tpl_instant_roofing_detailed" && !writeUp ? ["details"] : []), ...(answers.customer_changes === "mix" ? [] : ["choose"])]
  };
}

/** Sets a parameter's default in a definition's `params` (a template's) or `contract.params` (a workflow's). */
function setParamDefaults(params: JsonObject, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) if (params[key] && typeof params[key] === "object") params[key] = { ...object(params[key]), default: value };
}
/** Every `template_ref` naming `from` names `to`: a workflow's live preview shows the organization's template. */
function retarget(value: unknown, from: string, to: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => retarget(entry, from, to));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).map(([key, entry]) => [key, key === "template_ref" && entry === from ? to : retarget(entry, from, to)]));
}

/** The organization's published copy of a template or workflow, else the library's entry adapted to it. */
async function source(asset: "template" | "workflow", orgId: string, id: string): Promise<{ data: JsonObject; definition: JsonObject } | null> {
  const read = asset === "template" ? readDocumentTemplate : readDocumentWorkflow;
  const readVersion = asset === "template" ? readDocumentTemplateVersion : readDocumentWorkflowVersion;
  const copy = await read(orgId, id).catch(() => null);
  if (copy && text(copy.status) !== "archived" && Number(copy.current_version || 0) > 0) {
    const version = await readVersion(orgId, id, Number(copy.current_version)).catch(() => null);
    if (version && Object.keys(object(version.definition)).length) return { data: copy as JsonObject, definition: clone(object(version.definition)) };
  }
  const entry = await libraryAssetDefinition(asset, orgId, id);
  return entry ? { data: entry.data, definition: clone(entry.definition) } : null;
}

/** The kind's current default (never the setup's own template), for a kind other than a proposal. */
async function currentDefault(orgId: string, kind: DocumentSetupKind) {
  const own = setupTemplateId(kind);
  const active = (await listDocumentTemplates(orgId, { document_type: kind })).filter((template) => text(template.status) === "active" && Number(template.current_version || 0) > 0 && text(template.id) !== own && object(template.metadata).system !== true);
  return active.find((template) => object(template.metadata).default_for_type === true)
    || active.find((template) => object(template.metadata).default === true)
    || null;
}

/** The template the answers make, not saved: its definition with the theme, and its workflow's. */
async function buildDocument(orgId: string, answers: Answers, themeId: string) {
  const plan = planDocument(answers);
  if (plan.kind !== "proposal") {
    // Their own setup's template keeps its base; otherwise their current default, else the library's.
    const own = await readDocumentTemplate(orgId, setupTemplateId(plan.kind)).catch(() => null);
    const base = text(object(object(own?.metadata).document_setup).based_on) || text((await currentDefault(orgId, plan.kind))?.id);
    if (base) plan.base = base;
  }
  const template = await source("template", orgId, plan.base);
  if (!template) throw badRequest("document_setup_template", `There is no ${KIND_NAME[plan.kind].toLowerCase()} template to start from.`);
  const definition = template.definition;
  definition.theme_ref = { theme_id: themeId };
  setParamDefaults(object(definition.params), plan.params);
  const metadata = object(template.data.metadata);
  const workflowId = text(metadata.default_workflow_id || object(template.data.initial_metadata).default_workflow_id);
  const workflow = workflowId ? await source("workflow", orgId, workflowId) : null;
  let workflowDefinition: JsonObject | null = null;
  if (workflow) {
    workflowDefinition = retarget(workflow.definition, plan.base, setupTemplateId(plan.kind)) as JsonObject;
    workflowDefinition.steps = list(workflowDefinition.steps).filter((step) => !plan.drop_steps.includes(text(object(step).id)));
    setParamDefaults(object(object(workflowDefinition.contract).params), plan.params);
    workflowDefinition.name = plan.name;
  }
  return { plan, template, definition, workflow: workflow ? { id: workflowId, data: workflow.data, definition: workflowDefinition! } : null };
}

// ── What was answered ───────────────────────────────────────────────────
async function stored(orgId: string) {
  try { return await readBranchModule(orgId, "default", DOCUMENT_SETUP_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}

export async function readDocumentSetup(orgId: string) {
  const [record, themes, profile] = await Promise.all([stored(orgId), listDocumentThemes(orgId).catch(() => []), readCompanyProfile(orgId)]);
  const kinds = object(object(record?.data).kinds);
  const byId = new Map(themes.map((theme) => [text(theme.id), theme]));
  return {
    answered: Object.fromEntries(DOCUMENT_SETUP_KINDS.map((kind) => [kind, !!text(object(kinds[kind]).applied_at)])) as Record<DocumentSetupKind, boolean>,
    kinds: Object.fromEntries(DOCUMENT_SETUP_KINDS.filter((kind) => kinds[kind]).map((kind) => [kind, object(kinds[kind])])),
    themes: DOCUMENT_SETUP_THEMES.map((id) => ({ id, name: text(byId.get(id)?.name) || id.replace(/^thm_/, ""), description: text(byId.get(id)?.description) })),
    company_type: profile.company_type, sales_team: profile.sales_team, sales_is_team: profile.sales_is_team,
    revision: Number(record?.revision || 0)
  };
}

// ── The price step ──────────────────────────────────────────────────────
/** The price book items a roofing proposal is priced from, in the order the price step asks for them. */
export const PRICE_SHEET_ITEMS = ["tearoff", "gaf_hd", "laminated_shingles", "underlayment", "ice_water", "starter", "ridge_cap", "drip_edge", "valley_metal", "ridge_vent", "pipe_boot", "gutter_replace", "downspout"] as const;
export async function readPriceSheet(orgId: string) {
  const { getOrganizationPricebook } = await import("../pricebook/storage.js");
  const book = await getOrganizationPricebook(orgId);
  const items = new Map((book.catalog.items as JsonObject[]).map((item) => [text(item.id), item]));
  return {
    items: PRICE_SHEET_ITEMS.filter((id) => items.has(id)).map((id) => {
      const item = items.get(id)!;
      const price = Number(item.unit_price ?? item.unitPrice ?? 0);
      return { id, name: text(item.name), unit: text(item.unit), category: text(item.category), unit_price: Number.isFinite(price) && price > 0 ? price : null };
    })
  };
}

// ── Previews ────────────────────────────────────────────────────────────
const line = (id: string, name: string, quantity: number, unit: string, unit_price: number, extra: JsonObject = {}): JsonObject => ({ id, name, quantity, unit, unit_price, ...extra });
/** A sample roof for the previews, priced from the organization's price book where it has prices. */
async function sampleScope(orgId: string, plan: DocumentPlan, answers: Answers) {
  const sheet = await readPriceSheet(orgId).catch(() => ({ items: [] as { id: string; unit_price: number | null }[] }));
  const price = (id: string, fallback: number) => sheet.items.find((item) => item.id === id)?.unit_price || fallback;
  const roof = (shingle: string, shingleId: string, shinglePrice: number, prefix = "") => [
    line(`${prefix}tearoff`, "Remove existing roofing", 24, "sq", price("tearoff", 85)),
    line(`${prefix}underlayment`, "Synthetic underlayment", 24, "sq", price("underlayment", 32)),
    line(`${prefix}ice_water`, "Ice & water shield", 4, "sq", price("ice_water", 110)),
    line(`${prefix}shingles`, shingle, 26, "sq", price(shingleId, shinglePrice)),
    line(`${prefix}drip_edge`, "Drip edge", 180, "ft", price("drip_edge", 3.5)),
    line(`${prefix}ridge_vent`, "Ridge vent", 40, "ft", price("ridge_vent", 9))
  ];
  if (plan.base === "tpl_instant_roofing_options") {
    const tier = (id: string, name: string, shingle: string, shingleId: string, shinglePrice: number, selected: boolean, highlights: string[]): JsonObject => ({
      id, name, quantity: 1, unit: "job", highlights, selection: { mode: "choice", group_id: "package", group_title: "Your roof", selected },
      children: roof(shingle, shingleId, shinglePrice, `${id}_`)
    });
    return [
      tier("good", "Good", "Three-tab shingles", "three_tab_shingles", 120, false, ["25-year shingles", "Standard warranty"]),
      tier("better", "Better", "Architectural shingles", "gaf_hd", 145, true, ["Lifetime shingles", "Enhanced warranty"]),
      tier("best", "Best", "Designer shingles", "gaf_uhdz", 190, false, ["Thicker designer shingles", "Best warranty"])
    ];
  }
  const lines = roof("Architectural shingles", "gaf_hd", 145);
  if (answers.customer_changes === "mix") lines.push(line("gutters", "Seamless gutters", 140, "ft", price("gutter_replace", 12), { selection: { mode: "optional", selected: false } }));
  return lines;
}
const SAMPLE_CUSTOMER = { name: "Jordan Sample", email: "jordan@example.com", phone: "(555) 010-0199", address: "1200 Example Ave, Springfield" };

/** A sample signed roof and what has been paid, for an invoice, a change order or a completion certificate. */
function sampleAccountParams(kind: DocumentSetupKind): JsonObject {
  const today = new Date().toISOString().slice(0, 10);
  const account = { has_contract: true, contract_title: "Roof replacement", contract_cents: 1459300, change_orders_cents: kind === "change_order" ? 0 : 64000, total_cents: 1523300, paid_cents: 437790, balance_cents: 1085510 };
  if (kind === "invoice") return { account, invoice_number: "1001", issue_date: today, due_date: today, amount_due_cents: 1085510,
    billing: { lines: [{ label: "Roof replacement", detail: "Remaining balance", amount_cents: 1021510 }, { label: "Change order 1", detail: "Replace rotted decking", amount_cents: 64000 }] } };
  if (kind === "change_order") return { account, change_date: today, reason: "Rotted decking found during tear-off.", change_cents: 64000, new_total_cents: 1523300, due_now_cents: 0,
    scope_items: [line("decking", "Replace decking", 8, "sheets", 80)] };
  return { account, completed_at: today, warranty_start: today, amount_due_cents: 1085510, work_summary: "Tear-off and replacement of the main house roof with architectural shingles, new underlayment, ice & water shield, drip edge and ridge vent.", warranty_summary: "Lifetime manufacturer warranty on the shingles and ten years on workmanship." };
}

/** The document the answers make, in each of the three styles, resolved as a draft with a sample customer and roof. */
export async function documentSetupPreviews(orgId: string, args: unknown) {
  const answers = checkedAnswers(args);
  await ensureDefaultDocumentAssets(orgId);
  const { resolveDocumentInstance, resolveDocumentParams } = await import("./service.js");
  const { definition, plan } = await buildDocument(orgId, answers, DOCUMENT_SETUP_THEMES[0]);
  const explicit: JsonObject = { customer: SAMPLE_CUSTOMER, project: { title: SAMPLE_CUSTOMER.address, address: SAMPLE_CUSTOMER.address } };
  if (plan.kind === "proposal") explicit.scope_items = await sampleScope(orgId, plan, answers);
  if (plan.kind === "proposal" && answers.scope_write_up && object(definition.params).content_blocks) explicit.content_blocks = [{ id: "cb_sample", title: "Your roof today", body: "We found lifted and missing shingles on the south slope, worn pipe boots and soft decking near the chimney. Here is what we will do about each.", layout: "auto", display: "inline" }];
  else Object.assign(explicit, sampleAccountParams(plan.kind));
  const params = resolveDocumentParams(object(definition.params), explicit, {});
  const document: JsonObject = { id: `preview_${plan.kind}`, document_type: plan.kind, status: "draft", branch_id: "default", params, outputs: {} };
  const { themes } = await readDocumentSetup(orgId);
  const previews = [];
  for (const theme of themes) {
    const resolved = await resolveDocumentInstance(orgId, document, { definition: { ...definition, theme_ref: { theme_id: theme.id } }, themeRef: { theme_id: theme.id }, target: "static" });
    previews.push({ theme_id: theme.id, name: theme.name, description: theme.description, resolved_definition: resolved.resolved_definition, widget_data: resolved.widget_data, theme: resolved.theme, theme_vars: resolved.theme_vars });
  }
  return { kind: plan.kind, name: plan.name, description: plan.description, base: plan.base, previews };
}

// ── The finish ──────────────────────────────────────────────────────────
const priceSchema = z.object({ item_id: z.string().min(1).max(160), unit_price: z.number().finite().min(0).max(1e6) }).strict();
const applySchema = answersSchema.extend({
  theme_id: z.enum(DOCUMENT_SETUP_THEMES),
  /** The price step's prices (sell prices, per unit), written to the price book; none when it was skipped. */
  prices: z.array(priceSchema).max(40).default([])
});

async function saveAsset(kind: "template" | "workflow", orgId: string, id: string, input: JsonObject, ctx: PlatformAuthContext) {
  const read = kind === "template" ? readDocumentTemplate : readDocumentWorkflow;
  const existing = await read(orgId, id).catch(() => null);
  if (!existing) return kind === "template" ? createDocumentTemplate(orgId, { ...input, id, status: "active" }, ctx) : createDocumentWorkflow(orgId, { ...input, id, status: "active" }, ctx);
  const publish = kind === "template" ? publishDocumentTemplate : publishDocumentWorkflow;
  if (kind === "template" && text(existing.status) === "archived") await patchDocumentTemplate(orgId, id, { status: "active" }, ctx);
  return publish(orgId, id, { definition: input.definition, metadata: input.metadata, expected_version: Number(existing.current_version || 0) }, ctx);
}

/** The organization's pins in New document, with this kind's first pinned template replaced by its own. */
async function pinTemplate(orgId: string, kind: DocumentSetupKind, templateId: string) {
  const templates = await listDocumentTemplates(orgId);
  const typeOf = new Map(templates.filter((template) => text(template.status) === "active").map((template) => [text(template.id), text(template.document_type)]));
  const pins = ((await readPinnedTemplateIds(orgId)) ?? DEFAULT_PINNED_TEMPLATE_IDS).filter((id) => typeOf.has(id) && id !== templateId);
  const at = pins.findIndex((id) => typeOf.get(id) === kind);
  if (at >= 0) pins[at] = templateId; else pins.unshift(templateId);
  return savePinnedTemplateIds(orgId, pins);
}

export async function applyDocumentSetup(ctx: PublicationContext, auth: PlatformAuthContext, input: unknown) {
  const parsed = applySchema.parse(input);
  const answers = checkedAnswers(parsed);
  const orgId = auth.orgId;
  if (parsed.prices.length) {
    const { invokeAction } = await import("../platform/publication/actions.js");
    await invokeAction({ ...ctx, mode: "command" as const }, { action: "pricebook.prices.update", target: { scope: "organization", organizationId: orgId } },
      { changes: parsed.prices.map((entry) => ({ item_id: entry.item_id, unit_price: entry.unit_price, source: "document setup" })), note: "Prices from the document setup" },
      { idempotencyKey: `document-setup:prices:${orgId}:${Date.now()}` });
  }
  await ensureDefaultDocumentAssets(orgId, auth, { refresh: parsed.prices.length > 0 });
  const built = await buildDocument(orgId, answers, parsed.theme_id);
  const { plan } = built;
  const templateId = setupTemplateId(plan.kind);
  const setup = { ...answers, theme_id: parsed.theme_id, based_on: plan.base, applied_at: new Date().toISOString(), applied_by: auth.userId };
  let workflowId = "";
  if (built.workflow) {
    workflowId = setupWorkflowId(plan.kind);
    const base = built.workflow.data;
    await saveAsset("workflow", orgId, workflowId, {
      name: plan.name, description: plan.description || text(base.description), tags: base.tags,
      definition: built.workflow.definition, metadata: { document_setup: setup, based_on_workflow: built.workflow.id }
    }, auth);
  }
  // The base's metadata minus what marks a library copy (an untouched copy is upgraded or retired by the library).
  const { preset: _preset, preset_id: _presetId, library: _library, based_on_preset: _basedOn, default: _default, ...baseMetadata } = object(built.template.data.metadata);
  await saveAsset("template", orgId, templateId, {
    name: plan.name, description: plan.description || text(built.template.data.description), document_type: plan.kind, tags: built.template.data.tags,
    definition: built.definition,
    metadata: { ...baseMetadata, ...(workflowId ? { default_workflow_id: workflowId } : {}), default_for_type: true, document_setup: setup }
  }, auth);
  // The new template is the kind's default: no other keeps the mark.
  for (const template of await listDocumentTemplates(orgId, { document_type: plan.kind })) {
    if (text(template.id) !== templateId && object(template.metadata).default_for_type === true) await patchDocumentTemplate(orgId, text(template.id), { metadata: { default_for_type: false } }, auth);
  }
  const pins = await pinTemplate(orgId, plan.kind, templateId);
  const record = await stored(orgId);
  const data = object(record?.data);
  await saveBranchModule(orgId, "default", DOCUMENT_SETUP_MODULE, { data: { ...data, kinds: { ...object(data.kinds), [plan.kind]: { ...setup, template_id: templateId, workflow_id: workflowId || null } } } as JsonObject, expected_revision: Number(record?.revision || 0) }, { replace: true });
  return { kind: plan.kind, template_id: templateId, workflow_id: workflowId || null, name: plan.name, theme_id: parsed.theme_id, pinned_template_ids: pins, prices_updated: parsed.prices.length };
}

// ── Publication ─────────────────────────────────────────────────────────
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const statusSchema = z.object({
  answered: z.record(z.boolean()),
  kinds: z.record(z.record(z.unknown())),
  themes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  company_type: z.string().nullable(), sales_team: z.string().nullable(), sales_is_team: z.boolean(),
  revision: z.number().int()
}).strict();
const priceSheetSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string(), unit: z.string(), category: z.string(), unit_price: z.number().nullable() }).strict()) }).strict();
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], capabilities: ["platform.documents"], systemKinds: ["work", "module", "agent"] };
const setupAccess: AccessPolicy = { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.documents"], systemKinds: ["module", "agent"] };
const person = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("document_setup_person", "The document setup is answered by a person."); return ctx.auth; };

let registered = false;
export function registerDocumentSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "document-setup", version: "1", apps: ["documents"], exports: {
    status: { description: "What the organization said about its documents in the document setup: for each kind set up (proposal, invoice, change_order, completion_certificate) its answers, style (theme_id) and the template made (template_id, the kind's default); the three styles offered; who sells.",
      schema: json(statusSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readDocumentSetup(ctx.organizationId); return { value, revision: String(value.revision) }; } },
    price_sheet: { description: "The price book items a roofing proposal is priced from, with their sell price per unit (null when not set), for the document setup's price step.",
      schema: json(priceSheetSchema), schemaVersion: "1", access: setupAccess,
      read: async (ctx) => ({ value: await readPriceSheet(ctx.organizationId) }) },
    previews: { description: "The document the setup's answers (args: document_kind and, for a proposal, presentation, customer_changes, detail, scope_write_up) would make, resolved with a sample customer and roof in each of the three styles. Nothing is saved.",
      schema: { type: "object" } as JsonSchema, argsSchema: json(answersSchema.strict()), schemaVersion: "1", access: setupAccess,
      read: async (ctx, ref) => ({ value: await documentSetupPreviews(ctx.organizationId, ref.args || {}) }) }
  } });
  registerAction({ id: "documents.setup.apply", version: "1", domain: "documents", implementation: backendImplementationDigest(),
    description: "Finish the document setup for one kind of document (document_kind: proposal, invoice, change_order or completion_certificate) in a style (theme_id: thm_clean, thm_margin or thm_triangles). For a proposal also: presentation (options | single), customer_changes (mix | pick | ask), detail (itemized | rough), scope_write_up (boolean), and optionally prices ([{ item_id, unit_price }] sell prices written to the price book). Makes or republishes the organization's own template for that kind (tpl_setup_<kind>) and its workflow, makes it the kind's default and pins it in New document.",
    inputSchema: json(applySchema) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.documents"] },
    validateInput: (value) => { checkedAnswers(applySchema.parse(value)); },
    execute: (ctx, _target, value) => applyDocumentSetup(ctx, person(ctx), value) });
}
