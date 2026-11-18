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
  readDocumentThemeVersion, readDocumentWorkflow, readDocumentWorkflowVersion
} from "./storage.js";
import { FMDocModel } from "./schemas.js";
import { ensureDefaultDocumentAssets, libraryAssetDefinition } from "./library-copies.js";
import { DEFAULT_PINNED_TEMPLATE_IDS, DOCUMENT_SETUP_MODULE, readPinnedTemplateIds, savePinnedTemplateIds } from "./settings.js";
import { MEASUREMENT_FIELDS, PRICEBOOK_FORMULA_TOKEN_TYPES, PRICEBOOK_OPERATORS, PRICEBOOK_PARENS } from "../pricebook/constants.js";

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
 * kept in the default branch's `document_setup` module, apart from the templates. The first proposal style chosen there
 * is also the organization's style for new documents (`default_theme_id`, FM-612; settings.ts readDefaultDocumentThemeId).
 *
 * After the style, the person reads the template's own wording and may change it (FM-614): its copy is every text node of
 * fixed words on its pages (the title, the opening, the headings and the terms; `copyFields`), and what they change goes
 * in as `copy` ({ node id: text }) over the template the answers make. "Advanced" publishes the template and opens it in
 * the template editor; what they publish there is kept (`keep_edits`): the finish then starts from it, not the library's.
 */
export { DOCUMENT_SETUP_MODULE };
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

// ── The template's wording (FM-614) ─────────────────────────────────────
/** A text node of fixed words: every run plain text, none bound to data. */
const runsOf = (node: JsonObject) => list(object(node.props).blocks).flatMap((block) => list(object(block).runs).map(object));
const plainText = (node: JsonObject) => list(object(node.props).blocks).map((block) => list(object(block).runs).map((run) => String(object(run).text ?? "")).join("")).join("\n\n");
const HEADINGS = new Set(["h1", "h2", "h3", "title", "heading"]);
const isHeading = (node: JsonObject) => list(object(node.props).blocks).some((block) => HEADINGS.has(text(object(block).style_ref)));
function isCopy(node: JsonObject) {
  if (text(node.type) !== "text") return false;
  const runs = runsOf(node);
  if (!runs.length || runs.some((run) => run.bind !== undefined && run.bind !== null && run.bind !== "" || typeof run.text !== "string")) return false;
  const words = plainText(node).trim();
  // A heading, or a sentence or more: short fixed labels ("TOTAL", "Prepared for") are part of the layout, not the copy.
  return !!words && (isHeading(node) || words.length >= 40);
}
function eachPageNode(definition: JsonObject, visit: (node: JsonObject) => void) {
  const walk = (value: unknown) => { for (const node of list(value).map(object)) { visit(node); walk(node.children); } };
  for (const page of list(definition.pages).map(object)) walk(page.children);
}
export type CopyField = { node_id: string; role: "title" | "heading" | "text"; text: string };
/** The template's copy, top to bottom: its first heading is the title; the rest are headings and the text under them. */
export function copyFields(definition: JsonObject): CopyField[] {
  const fields: CopyField[] = [];
  eachPageNode(definition, (node) => {
    if (!isCopy(node) || !text(node.id)) return;
    const heading = isHeading(node);
    fields.push({ node_id: text(node.id), role: heading ? (fields.some((field) => field.role === "title") ? "heading" : "title") : "text", text: plainText(node) });
  });
  return fields;
}
/**
 * The person's wording over a definition's copy: each node named gets the text given, a paragraph per blank-line
 * separated part, each in its first block's style and its first run's font. Only copy nodes change. The setup's step
 * applies the same to its preview as the person types (documents-setup.js applyCopy).
 */
export function applyCopy(definition: JsonObject, copy: Record<string, string>) {
  if (!Object.keys(copy).length) return definition;
  eachPageNode(definition, (node) => {
    const value = copy[text(node.id)];
    if (typeof value !== "string" || !isCopy(node) || value === plainText(node)) return;
    const props = object(node.props), blocks = list(props.blocks).map(object);
    const parts = value.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    props.blocks = (parts.length ? parts : [""]).map((part, at) => {
      const like = blocks[Math.min(at, blocks.length - 1)] || {};
      const { text: _text, ...run } = object(list(like.runs)[0]);
      return { ...like, id: text(blocks[at]?.id) || `${text(blocks[0]?.id) || "blk"}_${at}`, runs: [{ ...run, text: part }] };
    });
    node.props = props;
  });
  return definition;
}
const copySchema = z.record(z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/), z.string().max(6000)).refine((value) => Object.keys(value).length <= 80, "Too many copy changes.");

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

/** A style's definition: the organization's copy, else the library's adapted to it. */
async function themeDefinition(orgId: string, themeId: string): Promise<JsonObject | null> {
  const version = await readDocumentThemeVersion(orgId, themeId).catch(() => null);
  if (version && Object.keys(object(version.definition)).length) return object(version.definition);
  return (await libraryAssetDefinition("theme", orgId, themeId))?.definition || null;
}

/** The kind's current default (never the setup's own template), for a kind other than a proposal. */
async function currentDefault(orgId: string, kind: DocumentSetupKind) {
  const own = setupTemplateId(kind);
  const active = (await listDocumentTemplates(orgId, { document_type: kind })).filter((template) => text(template.status) === "active" && Number(template.current_version || 0) > 0 && text(template.id) !== own && object(template.metadata).system !== true);
  return active.find((template) => object(template.metadata).default_for_type === true)
    || active.find((template) => object(template.metadata).default === true)
    || null;
}

/** Their own setup template's published definition, when it was made from this base (Advanced, FM-614). */
async function editedDefinition(orgId: string, kind: DocumentSetupKind, base: string) {
  const own = await readDocumentTemplate(orgId, setupTemplateId(kind)).catch(() => null);
  if (!own || text(object(object(own.metadata).document_setup).based_on) !== base || !(Number(own.current_version) > 0)) return null;
  const version = await readDocumentTemplateVersion(orgId, setupTemplateId(kind), Number(own.current_version)).catch(() => null);
  return version && Object.keys(object(version.definition)).length ? clone(object(version.definition)) : null;
}

/**
 * The template the answers make, not saved: its definition with the theme and the person's wording, and its workflow's.
 * With `keepEdits`, a template they edited in the template editor (Advanced) is the start, not the library's.
 */
async function buildDocument(orgId: string, answers: Answers, themeId: string, options: { copy?: Record<string, string>; keepEdits?: boolean } = {}) {
  const plan = planDocument(answers);
  if (plan.kind !== "proposal") {
    // Their own setup's template keeps its base; otherwise their current default, else the library's.
    const own = await readDocumentTemplate(orgId, setupTemplateId(plan.kind)).catch(() => null);
    const base = text(object(object(own?.metadata).document_setup).based_on) || text((await currentDefault(orgId, plan.kind))?.id);
    if (base) plan.base = base;
  }
  const template = await source("template", orgId, plan.base);
  if (!template) throw badRequest("document_setup_template", `There is no ${KIND_NAME[plan.kind].toLowerCase()} template to start from.`);
  const edited = options.keepEdits ? await editedDefinition(orgId, plan.kind, plan.base) : null;
  let definition = edited || template.definition;
  definition.theme_ref = { theme_id: themeId };
  if (!edited) setParamDefaults(object(definition.params), plan.params);
  // The template's page regions were placed for its own style (the itemized proposal's body clears the Margin rail):
  // they move to the margins of the style chosen, as choosing a style in the editor does.
  const theme = await themeDefinition(orgId, themeId);
  const ops = theme ? FMDocModel.pageSetupOverrides(definition, theme) : [];
  if (ops.length) definition = FMDocModel.applyOverrides(definition, ops).document as JsonObject;
  applyCopy(definition, options.copy || {});
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
  return { plan, template, definition, edited: !!edited, workflow: workflow ? { id: workflowId, data: workflow.data, definition: workflowDefinition! } : null };
}

// ── What was answered ───────────────────────────────────────────────────
async function stored(orgId: string) {
  try { return await readBranchModule(orgId, "default", DOCUMENT_SETUP_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}

/** Whether the document setup has made this kind's template, without reading the rest of what it answered. */
export async function documentSetupApplied(orgId: string, kind: DocumentSetupKind) {
  return !!text(object(object(object((await stored(orgId))?.data).kinds)[kind]).applied_at);
}

export async function readDocumentSetup(orgId: string) {
  const [record, themes, profile] = await Promise.all([stored(orgId), listDocumentThemes(orgId).catch(() => []), readCompanyProfile(orgId)]);
  const kinds = object(object(record?.data).kinds);
  const byId = new Map(themes.map((theme) => [text(theme.id), theme]));
  return {
    answered: Object.fromEntries(DOCUMENT_SETUP_KINDS.map((kind) => [kind, !!text(object(kinds[kind]).applied_at)])) as Record<DocumentSetupKind, boolean>,
    kinds: Object.fromEntries(DOCUMENT_SETUP_KINDS.filter((kind) => kinds[kind]).map((kind) => [kind, object(kinds[kind])])),
    themes: DOCUMENT_SETUP_THEMES.map((id) => ({ id, name: text(byId.get(id)?.name) || id.replace(/^thm_/, ""), description: text(byId.get(id)?.description) })),
    default_theme_id: text(object(record?.data).default_theme_id || object(kinds.proposal).theme_id) || null,
    company_type: profile.company_type, sales_team: profile.sales_team, sales_is_team: profile.sales_is_team,
    revision: Number(record?.revision || 0)
  };
}

// ── The price step ──────────────────────────────────────────────────────
/** The price book items a roofing proposal is priced from, in the order the price step asks for them. */
export const PRICE_SHEET_ITEMS = ["tearoff", "gaf_hd", "laminated_shingles", "underlayment", "ice_water", "starter", "ridge_cap", "drip_edge", "valley_metal", "ridge_vent", "pipe_boot", "gutter_replace", "downspout"] as const;
/**
 * The price book assembly a proposal's lines come from (every instant roofing template's `scope_pieces`): its
 * components are the lines. The price step turns them on and off and adds lines to it (FM-610).
 */
export const PROPOSAL_ASSEMBLY = "roof_replacement";
/** The units a line added in the price step is sold in. */
export const PRICE_LINE_UNITS = ["sq", "lf", "ea"] as const;
const measurementFields = () => MEASUREMENT_FIELDS.filter((field) => field.key !== "wastePercent");
const itemPrice = (item: JsonObject) => { const price = Number(item.unit_price ?? item.unitPrice ?? 0); return Number.isFinite(price) && price > 0 ? price : null; };
const componentRef = (component: unknown) => text(object(component).item_ref || object(component).itemRef || object(component).item_id || object(component).itemId);
/** A quantity formula in words ("Eaves + Rakes"), from its tokens. */
export function formulaText(config: unknown) {
  const labels = new Map<string, string>(MEASUREMENT_FIELDS.map((field) => [field.key, field.label]));
  const tokens = list(object(config).tokens).map(object);
  if (!tokens.length || (tokens.length === 1 && tokens[0]!.type === "number")) return "";
  return tokens.map((token) => token.type === "measurement" ? labels.get(text(token.value)) || text(token.value) : token.type === "operator" && token.value === "*" ? "×" : text(token.value)).join(" ").replace(/\( /g, "(").replace(/ \)/g, ")");
}
const sheetItem = (item: JsonObject, on: boolean) => ({
  id: text(item.id), name: text(item.name), unit: text(item.unit), category: text(item.category), unit_price: itemPrice(item), on,
  formula: formulaText(item.formulaConfig || item.formula_config)
});
export async function readPriceSheet(orgId: string) {
  const { getOrganizationPricebook } = await import("../pricebook/storage.js");
  const book = await getOrganizationPricebook(orgId);
  const all = (book.catalog.items as JsonObject[]).filter((item) => text(item.id) && text(item.status) !== "archived");
  const items = new Map(all.map((item) => [text(item.id), item]));
  const assembly = items.get(PROPOSAL_ASSEMBLY) || null;
  // The proposal's lines first, as the assembly orders them; then the main roofing items it does not have, off.
  const lines = [...new Set(list(assembly?.components).map(componentRef))].filter((id) => id !== PROPOSAL_ASSEMBLY && items.has(id));
  const extra = PRICE_SHEET_ITEMS.filter((id) => items.has(id) && !lines.includes(id));
  return {
    editable: !!assembly,
    items: [...lines.map((id) => sheetItem(items.get(id)!, true)), ...extra.map((id) => sheetItem(items.get(id)!, !assembly))],
    // The rest of the price book, for a line added by name (the price book is bigger than the step's list).
    catalog: all.filter((item) => text(item.kind) !== "assembly" && !lines.includes(text(item.id)) && !extra.includes(text(item.id) as never)).slice(0, 800).map((item) => {
      const { on: _on, ...entry } = sheetItem(item, false);
      return entry;
    }),
    measurements: measurementFields().map((field) => ({ key: field.key, label: field.label }))
  };
}

const formulaToken = z.object({ type: z.enum(PRICEBOOK_FORMULA_TOKEN_TYPES), value: z.string().trim().min(1).max(40) }).strict();
/** A line the person added that the price book does not have: what it is called, sold in and costs, and its quantity. */
const newLineSchema = z.object({
  key: z.string().regex(/^new_[a-z0-9]{1,24}$/),
  name: z.string().trim().min(1).max(120),
  unit: z.enum(PRICE_LINE_UNITS),
  unit_price: z.number().finite().min(0).max(1e6),
  formula: z.array(formulaToken).min(1).max(24),
  include_waste: z.boolean().default(false)
}).strict();
const linesSchema = z.object({
  /** The lines the proposal has, in order: price book item ids, and the keys of `new_items`. */
  on: z.array(z.string().min(1).max(160)).max(80),
  new_items: z.array(newLineSchema).max(20).default([])
}).strict();
type LinesInput = z.infer<typeof linesSchema>;

/** A formula's tokens are measurements, numbers, operators and brackets that pair up, and it reads as one expression. */
export function checkFormula(tokens: { type: string; value: string }[]) {
  const keys = new Set<string>(measurementFields().map((field) => field.key));
  let depth = 0, expectValue = true;
  for (const token of tokens) {
    if (token.type === "measurement" && !keys.has(token.value)) throw badRequest("document_setup_formula", `${token.value} is not a measurement.`);
    if (token.type === "number" && !(Number.isFinite(Number(token.value)) && Number(token.value) >= 0)) throw badRequest("document_setup_formula", `${token.value} is not a number.`);
    if (token.type === "operator" && !(PRICEBOOK_OPERATORS as readonly string[]).includes(token.value)) throw badRequest("document_setup_formula", `${token.value} is not an operator.`);
    if (token.type === "paren" && !(PRICEBOOK_PARENS as readonly string[]).includes(token.value)) throw badRequest("document_setup_formula", `${token.value} is not a bracket.`);
    if (token.type === "paren" && token.value === "(") { if (!expectValue) throw badRequest("document_setup_formula", "A bracket opens where an operator belongs."); depth += 1; continue; }
    if (token.type === "paren") { if (expectValue || depth === 0) throw badRequest("document_setup_formula", "A bracket closes where it cannot."); depth -= 1; continue; }
    const value = token.type !== "operator";
    if (value !== expectValue) throw badRequest("document_setup_formula", "The formula is not a complete expression.");
    expectValue = !value;
  }
  if (expectValue || depth !== 0) throw badRequest("document_setup_formula", "The formula is not a complete expression.");
}

/**
 * The price step's lines, written to the price book: lines added by name that it does not have become items (sold in
 * their unit, their quantity from the measurements), and the proposal's assembly has exactly the lines left on, in
 * their order. A line kept keeps how it is offered (a choice between shingles, an optional upgrade); a choice left
 * with nothing picked picks its first.
 */
async function applyLines(orgId: string, lines: LinesInput) {
  const { getOrganizationPricebook, saveOrganizationCatalog } = await import("../pricebook/storage.js");
  const book = await getOrganizationPricebook(orgId);
  const items = [...(book.catalog.items as JsonObject[])];
  const at = items.findIndex((item) => text(item.id) === PROPOSAL_ASSEMBLY);
  if (at < 0) throw badRequest("document_setup_lines_unavailable", "This price book has no roof replacement to put lines on.");
  const byName = new Map(items.map((item) => [text(item.name).toLowerCase(), text(item.id)]));
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "line";
  const added = new Map<string, string>();
  for (const entry of lines.new_items) {
    checkFormula(entry.formula);
    // A name the price book already has is that item.
    const same = byName.get(entry.name.toLowerCase());
    if (same) { added.set(entry.key, same); continue; }
    let id = `setup-${slug(entry.name)}`;
    for (let n = 2; items.some((item) => text(item.id) === id); n += 1) id = `setup-${slug(entry.name)}-${n}`;
    items.push({ id, kind: "atomic", name: entry.name, code: "", type: "", category: "misc", segment: "sloped", manufacturer: "", unit: entry.unit,
      internal_cost: 0, unit_price: entry.unit_price, unitPrice: entry.unit_price, base_price: entry.unit_price, description: "", external_description: "",
      formulaConfig: { tokens: entry.formula, includeWaste: entry.include_waste }, autoAdd: false,
      metadata: { source: "document_setup", added_from: "document_setup", price_source: "document_setup" } });
    byName.set(entry.name.toLowerCase(), id);
    added.set(entry.key, id);
  }
  const on = [...new Set(lines.on.map((id) => added.get(id) || id))];
  const known = new Set(items.map((item) => text(item.id)));
  const missing = on.filter((id) => id.startsWith("new_") || !known.has(id) || id === PROPOSAL_ASSEMBLY);
  if (missing.length) throw badRequest("document_setup_line_unknown", `These lines are not in the price book: ${missing.join(", ")}.`);
  const assembly = items[at]!;
  const kept = list(assembly.components).map(object).filter((component) => on.includes(componentRef(component)));
  const have = new Set(kept.map(componentRef));
  const ids = new Set(kept.map((component) => text(component.id)));
  for (const id of on) {
    if (have.has(id)) continue;
    let componentId = `setup_${id.replace(/[^a-zA-Z0-9_]+/g, "_")}`.slice(0, 80);
    for (let n = 2; ids.has(componentId); n += 1) componentId = `setup_${id.replace(/[^a-zA-Z0-9_]+/g, "_")}_${n}`.slice(0, 80);
    ids.add(componentId);
    kept.push({ id: componentId, item_ref: id, included: false, price_driving: true });
  }
  const groups = new Map<string, JsonObject[]>();
  for (const component of kept) {
    const selection = object(component.selection);
    if (selection.mode === "choice" && text(selection.group_id)) groups.set(text(selection.group_id), [...(groups.get(text(selection.group_id)) || []), component]);
  }
  for (const members of groups.values()) {
    if (members.some((component) => object(component.selection).selected === true)) continue;
    members[0]!.selection = { ...object(members[0]!.selection), selected: true, default_selected: true };
  }
  const before = list(assembly.components).map(componentRef).join("\n");
  items[at] = { ...assembly, components: kept };
  if (!added.size && before === kept.map(componentRef).join("\n")) return { added: 0, changed: false };
  await saveOrganizationCatalog(orgId, { ...book.catalog, items }, Number(book.manifest.revision));
  return { added: [...new Set(added.values())].length, changed: true };
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

/** A sample draft of the document the answers make: the sample customer and roof (or account) in its params. */
async function sampleDocument(orgId: string, answers: Answers, plan: DocumentPlan, definition: JsonObject): Promise<JsonObject> {
  const { resolveDocumentParams } = await import("./service.js");
  const explicit: JsonObject = { customer: SAMPLE_CUSTOMER, project: { title: SAMPLE_CUSTOMER.address, address: SAMPLE_CUSTOMER.address } };
  if (plan.kind === "proposal") explicit.scope_items = await sampleScope(orgId, plan, answers);
  if (plan.kind === "proposal" && answers.scope_write_up && object(definition.params).content_blocks) explicit.content_blocks = [{ id: "cb_sample", title: "Your roof today", body: "We found lifted and missing shingles on the south slope, worn pipe boots and soft decking near the chimney. Here is what we will do about each.", layout: "auto", display: "inline" }];
  else Object.assign(explicit, sampleAccountParams(plan.kind));
  const params = resolveDocumentParams(object(definition.params), explicit, {});
  return { id: `preview_${plan.kind}`, document_type: plan.kind, status: "draft", branch_id: "default", params, outputs: {} };
}
async function preview(orgId: string, document: JsonObject, definition: JsonObject, theme: { id: string; name: string; description: string }) {
  const { resolveDocumentInstance } = await import("./service.js");
  const resolved = await resolveDocumentInstance(orgId, document, { definition, themeRef: { theme_id: theme.id }, target: "static" });
  return { theme_id: theme.id, name: theme.name, description: theme.description, resolved_definition: resolved.resolved_definition, widget_data: resolved.widget_data, theme: resolved.theme, theme_vars: resolved.theme_vars };
}

/** The document the answers make, in each of the three styles, resolved as a draft with a sample customer and roof. */
export async function documentSetupPreviews(orgId: string, args: unknown) {
  const answers = checkedAnswers(args);
  await ensureDefaultDocumentAssets(orgId);
  const { definition, plan } = await buildDocument(orgId, answers, DOCUMENT_SETUP_THEMES[0]);
  const document = await sampleDocument(orgId, answers, plan, definition);
  const { themes } = await readDocumentSetup(orgId);
  const previews = [];
  for (const theme of themes) {
    const styled = theme.id === DOCUMENT_SETUP_THEMES[0] ? definition : (await buildDocument(orgId, answers, theme.id)).definition;
    previews.push(await preview(orgId, document, styled, theme));
  }
  return { kind: plan.kind, name: plan.name, description: plan.description, base: plan.base, previews };
}

const copyArgsSchema = answersSchema.extend({ theme_id: z.enum(DOCUMENT_SETUP_THEMES), keep_edits: z.boolean().optional() });
/**
 * The copy step (FM-614): the wording of the template the answers make in the style chosen (`fields`, top to bottom,
 * as the template has it), and that document as a sample (`preview`). The person's changes are not sent: the step
 * lays them over both as they type (`applyCopy`), and the finish saves them. With `keep_edits`, the template they
 * edited in the template editor. Nothing is saved.
 */
export async function documentSetupCopy(orgId: string, args: unknown) {
  const parsed = copyArgsSchema.parse(args);
  const answers = checkedAnswers(parsed);
  await ensureDefaultDocumentAssets(orgId);
  const { definition, plan, edited } = await buildDocument(orgId, answers, parsed.theme_id, { keepEdits: parsed.keep_edits === true });
  const document = await sampleDocument(orgId, answers, plan, definition);
  const theme = (await readDocumentSetup(orgId)).themes.find((entry) => entry.id === parsed.theme_id)!;
  return { kind: plan.kind, name: plan.name, base: plan.base, edited, template_id: setupTemplateId(plan.kind), fields: copyFields(definition), preview: await preview(orgId, document, definition, theme) };
}

// ── The finish ──────────────────────────────────────────────────────────
const priceSchema = z.object({ item_id: z.string().min(1).max(160), unit_price: z.number().finite().min(0).max(1e6) }).strict();
const applySchema = answersSchema.extend({
  theme_id: z.enum(DOCUMENT_SETUP_THEMES),
  /** The price step's prices (sell prices, per unit), written to the price book; none when it was skipped. */
  prices: z.array(priceSchema).max(120).default([]),
  /** The price step's lines (FM-610): which are on the proposal, and lines added that the price book does not have. */
  lines: linesSchema.optional(),
  /** The person's wording, { text node id: text } over the template's copy (the copy step, FM-614). */
  copy: copySchema.default({}),
  /** Start from the template they published in the template editor (Advanced), not the library's. */
  keep_edits: z.boolean().default(false)
});

/** Two definitions the same, whatever order their keys were written in. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, at) => same(entry, b[at]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => same((a as JsonObject)[key], (b as JsonObject)[key]));
  }
  return a === b;
}

async function saveAsset(kind: "template" | "workflow", orgId: string, id: string, input: JsonObject, ctx: PlatformAuthContext) {
  const read = kind === "template" ? readDocumentTemplate : readDocumentWorkflow;
  const existing = await read(orgId, id).catch(() => null);
  if (!existing) return kind === "template" ? createDocumentTemplate(orgId, { ...input, id, status: "active" }, ctx) : createDocumentWorkflow(orgId, { ...input, id, status: "active" }, ctx);
  const publish = kind === "template" ? publishDocumentTemplate : publishDocumentWorkflow;
  if (kind === "template" && text(existing.status) === "archived") await patchDocumentTemplate(orgId, id, { status: "active" }, ctx);
  // Finishing again with nothing changed (the first proposal step saved it a moment ago, FM-614) adds no version.
  const readVersion = kind === "template" ? readDocumentTemplateVersion : readDocumentWorkflowVersion;
  const current = Number(existing.current_version || 0) > 0 ? await readVersion(orgId, id, Number(existing.current_version)).catch(() => null) : null;
  if (current && text(existing.status) !== "archived" && same(current.definition, input.definition)) {
    const { applied_at: _at, applied_by: _by, ...setup } = object(object(input.metadata).document_setup);
    const { applied_at: _was, applied_by: _wasBy, ...had } = object(object(existing.metadata).document_setup);
    if (same(setup, had)) return existing;
  }
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
  const lines = parsed.lines ? await applyLines(orgId, parsed.lines) : { added: 0, changed: false };
  // Only prices that differ from the price book's: finishing after the first proposal step saved them changes nothing.
  const sheet = parsed.prices.length ? await readPriceSheet(orgId).catch(() => ({ items: [] as { id: string; unit_price: number | null }[] })) : { items: [] };
  const prices = parsed.prices.filter((entry) => sheet.items.find((item) => item.id === entry.item_id)?.unit_price !== entry.unit_price);
  if (prices.length) {
    const { invokeAction } = await import("../platform/publication/actions.js");
    await invokeAction({ ...ctx, mode: "command" as const }, { action: "pricebook.prices.update", target: { scope: "organization", organizationId: orgId } },
      { changes: prices.map((entry) => ({ item_id: entry.item_id, unit_price: entry.unit_price, source: "document setup" })), note: "Prices from the document setup" },
      { idempotencyKey: `document-setup:prices:${orgId}:${Date.now()}` });
  }
  await ensureDefaultDocumentAssets(orgId, auth, { refresh: prices.length > 0 || lines.changed });
  const built = await buildDocument(orgId, answers, parsed.theme_id, { copy: parsed.copy, keepEdits: parsed.keep_edits });
  const { plan } = built;
  const templateId = setupTemplateId(plan.kind);
  const setup = { ...answers, theme_id: parsed.theme_id, based_on: plan.base, ...(built.edited ? { edited: true } : {}), applied_at: new Date().toISOString(), applied_by: auth.userId };
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
  // The first proposal style chosen becomes the style for new documents; choosing another later changes only proposals.
  const defaultThemeId = text(data.default_theme_id) || (plan.kind === "proposal" ? parsed.theme_id : "");
  await saveBranchModule(orgId, "default", DOCUMENT_SETUP_MODULE, { data: { ...data, ...(defaultThemeId ? { default_theme_id: defaultThemeId } : {}), kinds: { ...object(data.kinds), [plan.kind]: { ...setup, template_id: templateId, workflow_id: workflowId || null } } } as JsonObject, expected_revision: Number(record?.revision || 0) }, { replace: true });
  return { kind: plan.kind, template_id: templateId, workflow_id: workflowId || null, name: plan.name, theme_id: parsed.theme_id, pinned_template_ids: pins, prices_updated: prices.length, lines_added: lines.added, lines_changed: lines.changed };
}

// ── Publication ─────────────────────────────────────────────────────────
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const statusSchema = z.object({
  answered: z.record(z.boolean()),
  kinds: z.record(z.record(z.unknown())),
  themes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  default_theme_id: z.string().nullable(),
  company_type: z.string().nullable(), sales_team: z.string().nullable(), sales_is_team: z.boolean(),
  revision: z.number().int()
}).strict();
const sheetEntry = { id: z.string(), name: z.string(), unit: z.string(), category: z.string(), unit_price: z.number().nullable(), formula: z.string() };
const priceSheetSchema = z.object({
  editable: z.boolean(),
  items: z.array(z.object({ ...sheetEntry, on: z.boolean() }).strict()),
  catalog: z.array(z.object(sheetEntry).strict()),
  measurements: z.array(z.object({ key: z.string(), label: z.string() }).strict())
}).strict();
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], capabilities: ["platform.documents"], systemKinds: ["work", "module", "agent"] };
const setupAccess: AccessPolicy = { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.documents"], systemKinds: ["module", "agent"] };
const person = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("document_setup_person", "The document setup is answered by a person."); return ctx.auth; };

let registered = false;
export function registerDocumentSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "document-setup", version: "1", apps: ["documents"], exports: {
    status: { description: "What the organization said about its documents in the document setup: for each kind set up (proposal, invoice, change_order, completion_certificate) its answers, style (theme_id) and the template made (template_id, the kind's default); the three styles offered; the style for new documents (default_theme_id: the first proposal style chosen, null before); who sells.",
      schema: json(statusSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readDocumentSetup(ctx.organizationId); return { value, revision: String(value.revision) }; } },
    price_sheet: { description: "The document setup's price step: the lines a roofing proposal is made of (items; on = on the proposal, from the roof_replacement assembly; editable = that assembly exists), each with its sell price per unit (null when not set) and quantity formula in words; the rest of the price book (catalog), to add a line from; and the measurements a new line's quantity can be worked out from.",
      schema: json(priceSheetSchema), schemaVersion: "2", access: setupAccess,
      read: async (ctx) => ({ value: await readPriceSheet(ctx.organizationId) }) },
    previews: { description: "The document the setup's answers (args: document_kind and, for a proposal, presentation, customer_changes, detail, scope_write_up) would make, resolved with a sample customer and roof in each of the three styles. Nothing is saved.",
      schema: { type: "object" } as JsonSchema, argsSchema: json(answersSchema.strict()), schemaVersion: "1", access: setupAccess,
      read: async (ctx, ref) => ({ value: await documentSetupPreviews(ctx.organizationId, ref.args || {}) }) },
    copy: { description: "The copy step: the wording of the template the setup's answers make in the style chosen (args: the previews' answers, theme_id and keep_edits to start from the template published in the template editor), as fields top to bottom ({ node_id, role: title | heading | text, text }), and that document resolved with a sample customer (preview). The finish (documents.setup.apply) takes changes as copy { node_id: text }. Nothing is saved.",
      schema: { type: "object" } as JsonSchema, argsSchema: json(copyArgsSchema.strict()), schemaVersion: "1", access: setupAccess,
      read: async (ctx, ref) => ({ value: await documentSetupCopy(ctx.organizationId, ref.args || {}) }) }
  } });
  registerAction({ id: "documents.setup.apply", version: "1", domain: "documents", implementation: backendImplementationDigest(),
    description: "Finish the document setup for one kind of document (document_kind: proposal, invoice, change_order or completion_certificate) in a style (theme_id: thm_clean, thm_margin or thm_triangles). For a proposal also: presentation (options | single), customer_changes (mix | pick | ask), detail (itemized | rough), scope_write_up (boolean), and optionally prices ([{ item_id, unit_price }] sell prices written to the price book) and lines ({ on: the item ids the proposal's roof_replacement has, in order, with the keys of new_items; new_items: [{ key: new_<x>, name, unit: sq|lf|ea, unit_price, formula: price book formula tokens over measurements, include_waste }] for lines the price book lacks }). Optionally copy ({ text node id: text }, the template's wording changed, from document-setup.copy) and keep_edits (start from the template published in the template editor). Makes or republishes the organization's own template for that kind (tpl_setup_<kind>) and its workflow, makes it the kind's default and pins it in New document.",
    inputSchema: json(applySchema) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.documents"] },
    validateInput: (value) => { checkedAnswers(applySchema.parse(value)); },
    execute: (ctx, _target, value) => applyDocumentSetup(ctx, person(ctx), value) });
  // The price step's "Upload an existing estimate" (FM-610): reads it and returns its lines matched to the price book.
  const estimateInput = z.object({ files: z.array(z.object({ file_name: z.string().max(200), content_type: z.string().max(120).optional(), data_base64: z.string().min(1).max(28_000_000) }).strict()).min(1).max(3) }).strict();
  registerAction({ id: "documents.setup.read_estimate", version: "1", domain: "documents", implementation: backendImplementationDigest(),
    description: "Read an estimate or proposal the company already sends (files: up to three PDFs or photos, base64) for the document setup's price step: its priced lines, each with its unit (sq, lf or ea), price per unit, the price book item it matches (item_id, or null) and, for a line the price book does not have, a quantity formula over the measurements. Writes nothing; documents.setup.apply writes what the person keeps.",
    inputSchema: json(estimateInput) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "compute", idempotency: "none", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.documents"] },
    validateInput: (value) => { estimateInput.parse(value); },
    execute: async (ctx, _target, value) => { person(ctx); return (await import("./setup-estimate.js")).readEstimate(ctx.organizationId, value); } });
}
