import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import type { LibraryEntry, OrgCopyStatus } from "../config-library/contracts.js";
import { libraryEntries, libraryEntry, libraryStamp, type LibraryStamp } from "../config-library/library.js";
import { DOCUMENT_TEMPLATE_KIND, DOCUMENT_THEME_KIND, DOCUMENT_WORKFLOW_KIND, PRESENTATION_DECK_KIND } from "../config-library/kinds/document-shared.js";
import type { DocumentThemeEntry } from "../config-library/kinds/document-theme.js";
import type { DocumentTemplateEntry } from "../config-library/kinds/document-template.js";
import { workflowDeckId, type DocumentWorkflowEntry } from "../config-library/kinds/document-workflow.js";
import { repairIncorrectCompanyAccent, themeDefinitionWithOrganizationDefaults } from "./theme-defaults.js";
import {
  archiveDocumentTemplate, archiveDocumentWorkflow,
  createDocumentTemplate, createDocumentTheme, createDocumentWorkflow,
  listDocumentTemplates, listDocumentThemes, listDocumentWorkflows,
  patchDocumentTemplate, patchDocumentTheme, patchDocumentWorkflow,
  publishDocumentTemplate, publishDocumentTheme, publishDocumentWorkflow,
  readDocumentTemplate, readDocumentTheme, readDocumentThemeVersion, readDocumentWorkflow
} from "./storage.js";

/**
 * Organizations' copies of the library's document defaults (docs/architecture/config-library.md, "Organizations'
 * copies"): themes, templates and workflows are library entries (`document_theme`, `document_template`,
 * `document_workflow`); every organization gets its own copy through the documents writer, and its documents are
 * made from that copy. A copy records the `libraryStamp` it was made from in `metadata.library` with
 * `metadata.preset: true`. A copy the organization edits (any publish of its own, documents/storage.ts) loses
 * `preset` and is never touched again until it is reset; an untouched copy of an older revision is republished.
 *
 * What adapts a default to an organization runs here, when the copy is made: the company's brand colors and fonts
 * into a theme, price book rates into a template's and workflow's parameter defaults, and the presentation deck a
 * workflow presents is copied first. An entry the library no longer has retires: its untouched copies are archived
 * (documents made from them keep their pinned version).
 */

type Asset = "theme" | "template" | "workflow";
type AnyEntry = LibraryEntry<DocumentThemeEntry> | LibraryEntry<DocumentTemplateEntry> | LibraryEntry<DocumentWorkflowEntry>;
const KIND: Record<Asset, string> = { theme: DOCUMENT_THEME_KIND, template: DOCUMENT_TEMPLATE_KIND, workflow: DOCUMENT_WORKFLOW_KIND };
const STORE = {
  theme: { read: readDocumentTheme, create: createDocumentTheme, publish: publishDocumentTheme, patch: patchDocumentTheme, list: listDocumentThemes, archive: null },
  template: { read: readDocumentTemplate, create: createDocumentTemplate, publish: publishDocumentTemplate, patch: patchDocumentTemplate, list: listDocumentTemplates, archive: archiveDocumentTemplate },
  workflow: { read: readDocumentWorkflow, create: createDocumentWorkflow, publish: publishDocumentWorkflow, patch: patchDocumentWorkflow, list: listDocumentWorkflows, archive: archiveDocumentWorkflow }
};

const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});
const text = (value: unknown) => String(value ?? "").trim();
const clone = <T>(value: T): T => structuredClone(value) as T;

async function readCopy(asset: Asset, orgId: string, id: string): Promise<JsonObject | null> {
  return await (STORE[asset].read as (org: string, id: string) => Promise<JsonObject>)(orgId, id).catch((error: { statusCode?: number }) => {
    if (error?.statusCode === 404) return null;
    throw error;
  });
}

/**
 * Copies made by the code seeds before the library: the last code revision (document presets 38, the roofing pack
 * 17, Operations 1) made what the library's first revision holds, so such a copy is taken as an untouched copy of
 * the current entry and only stamped. The roofing pack and Operations never marked their copies as presets, so an
 * edit made before the library cannot be told apart; the pack would have overwritten it on its next revision anyway.
 * An older revision is upgraded, as its seed would have done.
 */
function legacyState(copy: JsonObject): "current" | "older" | null {
  const metadata = obj(copy.metadata);
  if (metadata.library) return null;
  if (metadata.preset === true && metadata.preset_revision !== undefined) return Number(metadata.preset_revision) >= 38 ? "current" : "older";
  if (metadata.instant_roofing_pack !== undefined) return Number(metadata.instant_roofing_pack) >= 17 ? "current" : "older";
  if (metadata.operations_revision !== undefined) return "current";
  return null;
}

/** How one copy stands against its entry (config-library/contracts.ts OrgCopyStatus). */
export function copyState(entry: Pick<LibraryEntry, "sha256">, copy: JsonObject | null): OrgCopyStatus["state"] {
  if (!copy) return "missing";
  const legacy = legacyState(copy);
  if (legacy) return legacy === "current" ? "library" : "behind";
  const metadata = obj(copy.metadata);
  if (metadata.preset !== true) return "changed";
  const stamp = obj(metadata.library) as Partial<LibraryStamp>;
  return stamp.sha256 === entry.sha256 && Number(copy.current_version || 0) > 0 ? "library" : "behind";
}

let pricebook: { orgId: string; at: number; prices: Map<string, number> } | null = null;
async function pricebookPrices(orgId: string) {
  if (pricebook?.orgId === orgId && Date.now() - pricebook.at < 5_000) return pricebook.prices;
  const { getOrganizationPricebook } = await import("../pricebook/storage.js");
  const book = await getOrganizationPricebook(orgId);
  const prices = new Map(book.catalog.items.map((item) => [String(item.id), Number(item.unitPrice || 0)]));
  pricebook = { orgId, at: Date.now(), prices };
  return prices;
}
/** An entry that needs price book items is made only for an organization whose price book prices them. */
async function pricebookReady(orgId: string, items: string[]) {
  if (!items.length) return true;
  const prices = await pricebookPrices(orgId);
  return items.every((id) => (prices.get(id) || 0) > 0);
}
/** Price book rates into parameter defaults, in cents (the rate is never in the library). */
async function withPricebookDefaults(orgId: string, params: JsonObject, fills: Array<{ param: string; item_id: string }>) {
  if (!fills.length) return;
  const prices = await pricebookPrices(orgId);
  for (const fill of fills) {
    const param = obj(params[fill.param]);
    if (Object.keys(param).length) params[fill.param] = { ...param, default: Math.round((prices.get(fill.item_id) || 0) * 100) };
  }
}

/** The definition an organization's copy gets: the entry adapted to the organization. */
async function copyDefinition(asset: Asset, orgId: string, entry: AnyEntry) {
  if (asset === "theme") return await themeDefinitionWithOrganizationDefaults(orgId, clone((entry as LibraryEntry<DocumentThemeEntry>).data.definition) as unknown as JsonObject, "default");
  if (asset === "template") {
    const data = (entry as LibraryEntry<DocumentTemplateEntry>).data;
    const definition = clone(data.definition) as unknown as JsonObject;
    await withPricebookDefaults(orgId, obj(definition.params), data.pricebook_defaults);
    return definition;
  }
  const data = (entry as LibraryEntry<DocumentWorkflowEntry>).data;
  const definition = clone(data.definition) as unknown as JsonObject;
  await withPricebookDefaults(orgId, obj(obj(definition.contract).params), data.pricebook_defaults);
  // The deck the last step presents is the organization's copy of it, published before the workflow names it.
  const deck = workflowDeckId(definition);
  if (deck) await ensureLibraryDeck(orgId, deck);
  return definition;
}

/**
 * Makes or republishes an organization's copy of one entry, as a system preset (it stays untouched). Used for a new
 * copy, an upgrade of an untouched one, and a reset (which overwrites an edited copy too).
 */
async function writeCopy(asset: Asset, orgId: string, entry: AnyEntry, existing: JsonObject | null, ctx: PlatformAuthContext | null) {
  const data = entry.data as DocumentTemplateEntry & DocumentWorkflowEntry & DocumentThemeEntry;
  const definition = await copyDefinition(asset, orgId, entry);
  const metadata: JsonObject = { ...obj(clone(data.metadata || {})), preset: true, preset_id: entry.id, library: libraryStamp(entry as LibraryEntry) as unknown as JsonObject };
  const store = STORE[asset] as unknown as {
    create(org: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean }): Promise<JsonObject>;
    publish(org: string, id: string, input: JsonObject, ctx: PlatformAuthContext | null, options: { systemPreset?: boolean }): Promise<JsonObject>;
  };
  if (!existing) {
    return await store.create(orgId, {
      id: entry.id, name: data.name, description: data.description || "",
      ...(asset === "template" ? { document_type: data.document_type } : {}),
      status: asset === "theme" ? "active" : data.status || "active",
      definition, metadata: { ...obj(clone(data.initial_metadata || {})), ...metadata }
    }, ctx, { systemPreset: true });
  }
  return await store.publish(orgId, entry.id, { definition, expected_version: Number(existing.current_version || 0), metadata }, ctx, { systemPreset: true });
}

/**
 * The rule every default follows: a missing copy is made, an untouched copy of an older revision is upgraded, an
 * edited copy is left alone. A copy from before the library at the last code revision is stamped, not republished.
 */
async function ensureCopy(asset: Asset, orgId: string, entry: AnyEntry, ctx: PlatformAuthContext | null) {
  // A deck follows its own entry: kept current even while the workflow that presents it is.
  const deck = asset === "workflow" ? workflowDeckId((entry as LibraryEntry<DocumentWorkflowEntry>).data.definition) : "";
  if (deck) await ensureLibraryDeck(orgId, deck).catch(() => null);
  const existing = await readCopy(asset, orgId, entry.id);
  if (existing && legacyState(existing) === "current") {
    const patch = STORE[asset].patch as (org: string, id: string, patch: JsonObject, ctx: PlatformAuthContext | null) => Promise<JsonObject>;
    return await patch(orgId, entry.id, { metadata: { preset: true, preset_id: entry.id, library: libraryStamp(entry as LibraryEntry) as unknown as JsonObject } }, ctx);
  }
  const state = copyState(entry, existing);
  if (state === "missing") return await writeCopy(asset, orgId, entry, null, ctx);
  if (state === "behind") return await writeCopy(asset, orgId, entry, existing, ctx).catch(() => null);
  return existing;
}

/** The organization's copy of a presentation deck (documents/modules/presentation-service.ts). */
export async function ensureLibraryDeck(orgId: string, deckId: string, options: { reset?: boolean } = {}) {
  const entry = libraryEntry(PRESENTATION_DECK_KIND, deckId);
  if (!entry) return null;
  const { ensurePresentationPreset } = await import("./modules/presentation-service.js");
  return await ensurePresentationPreset(orgId, entry as never, options);
}

/** A template's own workflow arrives with it (`seeding: with_template`), before it. */
async function ensureTemplateWorkflow(orgId: string, template: LibraryEntry<DocumentTemplateEntry>, ctx: PlatformAuthContext | null) {
  const workflowId = text(template.data.metadata.default_workflow_id || template.data.initial_metadata.default_workflow_id);
  const workflow = workflowId ? libraryEntry<DocumentWorkflowEntry>(DOCUMENT_WORKFLOW_KIND, workflowId) : null;
  if (workflow && workflow.data.seeding === "with_template") await ensureCopy("workflow", orgId, workflow, ctx);
}

const ensuring = new Set<string>();
const ensured = new Map<string, number>();
const ENSURE_TTL_MS = 60_000;

/**
 * Brings an organization's document defaults up to the library: themes, the workflows and templates every
 * organization has, and their decks; retired presets are archived. Called lazily on the first template, theme or
 * catalog read and before a document is made. Safe to call repeatedly; a short TTL avoids re-reading collections on
 * every request (`refresh` skips it, after the organization's price book was just set up).
 */
export async function ensureDefaultDocumentAssets(orgId: string, ctx: PlatformAuthContext | null = null, options: { refresh?: boolean } = {}) {
  const key = text(orgId);
  if (!key || ensuring.has(key)) return;
  if (!options.refresh && Date.now() - (ensured.get(key) || 0) < ENSURE_TTL_MS) return;
  ensuring.add(key);
  try {
    for (const entry of libraryEntries<DocumentThemeEntry>(DOCUMENT_THEME_KIND)) await ensureCopy("theme", orgId, entry, ctx);
    await repairCompanyAccents(orgId, ctx);
    for (const entry of libraryEntries<DocumentWorkflowEntry>(DOCUMENT_WORKFLOW_KIND)) {
      if (entry.data.seeding === "every_organization") await ensureCopy("workflow", orgId, entry, ctx);
    }
    for (const entry of libraryEntries<DocumentTemplateEntry>(DOCUMENT_TEMPLATE_KIND)) {
      if (entry.data.seeding !== "every_organization") continue;
      const conditional = entry.data.requires_pricebook_items.length > 0;
      try {
        if (!(await pricebookReady(orgId, entry.data.requires_pricebook_items))) continue;
        await ensureTemplateWorkflow(orgId, entry, ctx);
        await ensureCopy("template", orgId, entry, ctx);
      } catch (error) {
        // A template that depends on the price book never blocks the rest (as the roofing pack never did).
        if (!conditional) throw error;
      }
    }
    await retireCopies(orgId, ctx);
    ensured.set(key, Date.now());
  } finally {
    ensuring.delete(key);
  }
}

/**
 * A template something asks for by id (`seeding: on_request`: a scope that issues it, the Operations scope of
 * work): made the first time it is asked for, with its workflow, and brought up to date (untouched) every time.
 */
export async function ensureLibraryTemplate(orgId: string, templateId: string, ctx: PlatformAuthContext | null = null) {
  const entry = libraryEntry<DocumentTemplateEntry>(DOCUMENT_TEMPLATE_KIND, text(templateId));
  if (!entry || entry.data.seeding !== "on_request") return null;
  await ensureTemplateWorkflow(orgId, entry, ctx);
  return await ensureCopy("template", orgId, entry, ctx);
}

/** Repair user themes created at v1 by preset revision 23, which used the third palette swatch as Accent. */
async function repairCompanyAccents(orgId: string, ctx: PlatformAuthContext | null) {
  for (const theme of await listDocumentThemes(orgId)) {
    if (obj(theme.metadata).preset === true || Number(theme.current_version || 0) !== 1) continue;
    const version = await readDocumentThemeVersion(orgId, text(theme.id), 1).catch(() => null);
    const repaired = repairIncorrectCompanyAccent(obj(obj(version).definition));
    if (!repaired) continue;
    await publishDocumentTheme(orgId, text(theme.id), { definition: repaired, expected_version: 1, metadata: { company_accent_repaired: true } }, ctx, { systemPreset: true }).catch(() => null);
  }
}

/** Untouched preset templates and workflows the library no longer has leave the picker. */
async function retireCopies(orgId: string, ctx: PlatformAuthContext | null) {
  for (const asset of ["template", "workflow"] as const) {
    const ids = new Set(libraryEntries(KIND[asset]).map((entry) => entry.id));
    if (!ids.size) continue; // no library loaded: never archive on that account
    for (const copy of await (STORE[asset].list as (org: string) => Promise<JsonObject[]>)(orgId)) {
      const metadata = obj(copy.metadata);
      if (metadata.preset !== true || text(copy.status) === "archived" || ids.has(text(metadata.preset_id || copy.id))) continue;
      await STORE[asset].archive!(orgId, text(copy.id), ctx).catch(() => null);
    }
  }
}

/** `orgCopies.status` for a document kind: each entry's copy against the library. */
export async function documentCopyStatus(asset: Asset, orgId: string, ids?: string[]): Promise<OrgCopyStatus[]> {
  const result: OrgCopyStatus[] = [];
  for (const entry of libraryEntries(KIND[asset])) {
    if (ids && !ids.includes(entry.id)) continue;
    const copy = await readCopy(asset, orgId, entry.id);
    const state = copyState(entry, copy);
    const stamp = obj(obj(copy?.metadata).library);
    result.push({ id: entry.id, state, library_revision: entry.revision, ...(stamp.revision !== undefined ? { copy_revision: Number(stamp.revision) } : {}),
      ...(state === "changed" ? { detail: "The organization edited its copy; library changes reach it only after a reset." } : {}) });
  }
  return result;
}

/** `orgCopies.status` for presentation decks: the organization's preset module against each library deck. */
export async function deckCopyStatus(orgId: string, ids?: string[]): Promise<OrgCopyStatus[]> {
  const { presentationPresetRecord, presentationPresetState } = await import("./modules/presentation-service.js");
  const result: OrgCopyStatus[] = [];
  for (const entry of libraryEntries(PRESENTATION_DECK_KIND)) {
    if (ids && !ids.includes(entry.id)) continue;
    const current = await presentationPresetRecord(orgId, entry.id);
    const stamp = obj(current?.library);
    const state = presentationPresetState(current, entry);
    result.push({ id: entry.id, state, library_revision: entry.revision, ...(stamp.revision !== undefined ? { copy_revision: Number(stamp.revision) } : {}),
      ...(state === "changed" ? { detail: "The organization published its own version of this presentation." } : {}) });
  }
  return result;
}

/** `orgCopies.reset`: the library version republished as a system preset, as an upgrade would, even over edits. */
export async function resetDocumentCopy(asset: Asset, ctx: PlatformAuthContext, id: string) {
  const entry = libraryEntry(KIND[asset], id) as AnyEntry | null;
  if (!entry) return null;
  if (asset === "template") await ensureTemplateWorkflow(ctx.orgId, entry as LibraryEntry<DocumentTemplateEntry>, ctx);
  const copy = await writeCopy(asset, ctx.orgId, entry, await readCopy(asset, ctx.orgId, id), ctx);
  return { id, version: Number(obj(copy).current_version || 0) };
}
