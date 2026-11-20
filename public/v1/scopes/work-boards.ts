import { libraryCopy } from "../config-library/library.js";
import { PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { SERVICES, serviceOf } from "../company-profile/catalog.js";
import type { CompanyProfile } from "../company-profile/profile.js";
import { PRODUCTION_CATEGORY, ensureProductionCategory } from "./flow-setup.js";
import { patchScopeFlags, readScopeFlagState, readScopeTemplate, saveScopeTemplate } from "./storage.js";

/**
 * One production board per kind of work (GP-141, docs/architecture/automations-hub.md "A board per kind of work"). The
 * company profile's answer to "What kind of work do you do?" is what boards it has: a roofer that does re-roofs, roof
 * repairs and gutters gets a Roof Replacement, a Roof repairs and a Gutters board, each on and in the Production lane,
 * so Settings › Project Scopes and Projects show them. A kind of work whose board the scope library already gives every
 * organization (re-roofs, gutters, siding, kitchens) uses the organization's own copy; any other gets a board of its
 * own, `work_<service>`, named after it and copied once from the library board closest to it. Nothing is ever deleted
 * or rewritten: a board already there is only turned on, and a board this turned on is turned off again when its kind
 * of work is no longer picked. What this turned on is kept in the branch's `work_boards` module.
 */
export const WORK_BOARDS_MODULE = "work_boards";
/** Kinds of work whose board is the organization's own copy of a library board. */
const OWN_BOARD: Record<string, string> = { roof_replacement: "roof_replacement", gutters: "gutters", siding: "siding_replacement", kitchen_remodeling: "kitchen_remodel" };
/** The library board a kind of work's own board starts from; any other starts from `manual`, a flexible board. */
const START_FROM: Record<string, string> = {
  storm_insurance: "roof_replacement", commercial_low_slope: "roof_replacement", gutter_guards: "gutters", soffit_fascia: "siding_replacement",
  roof_repair: "repairs", siding_repair: "repairs", hvac_repair: "repairs", plumbing_repair: "repairs", electrical_repair: "repairs", foundation_repair: "repairs", drains: "repairs",
  roof_inspection: "maintenance", gutter_cleaning: "maintenance", hvac_maintenance: "maintenance", lawn_care: "maintenance", pressure_washing: "maintenance", snow_removal: "maintenance", irrigation: "maintenance"
};
const ANY_WORK_BOARD = "manual";
for (const id of [...Object.keys(OWN_BOARD), ...Object.keys(START_FROM)]) if (!serviceOf(id)) throw new Error(`Work boards name ${id}, which is not a kind of work in the company profile catalog.`);

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** The board a kind of work's own board would be: its id, and the library board it starts from. */
export function workBoardFor(serviceId: string) {
  return OWN_BOARD[serviceId] ? { id: OWN_BOARD[serviceId]!, from: OWN_BOARD[serviceId]!, own: true } : { id: `work_${serviceId}`, from: START_FROM[serviceId] || ANY_WORK_BOARD, own: false };
}

type Record_ = { boards: Record<string, { template_id: string; turned_on: boolean }> };
async function stored(orgId: string, branchId: string) {
  try { return await readBranchModule(orgId, branchId, WORK_BOARDS_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}
function recordOf(data: unknown): Record_ {
  const boards: Record_["boards"] = {};
  for (const [service, entry] of Object.entries(object(object(data).boards))) if (text(object(entry).template_id)) boards[service] = { template_id: text(object(entry).template_id), turned_on: object(entry).turned_on === true };
  return { boards };
}
/** The boards of the work the company does, by kind of work, as this branch has them. */
export async function readWorkBoards(orgId: string, branchId = "default") {
  return recordOf((await stored(orgId, branchId))?.data).boards;
}

const read = (orgId: string, branchId: string, id: string) => readScopeTemplate(orgId, branchId, id).then((found) => found as unknown as JsonObject).catch((error) => {
  if (error instanceof PlatformError && error.statusCode === 404) return null;
  throw error;
});

/** A kind of work's own board, copied from its library board, named after the work and in the Production lane. */
function newBoard(id: string, serviceId: string, from: string): JsonObject | null {
  const service = serviceOf(serviceId), source = libraryCopy<JsonObject>("scope_template", from) || libraryCopy<JsonObject>("scope_template", ANY_WORK_BOARD);
  if (!service || !source) return null;
  const metadata = { ...object(source.metadata) };
  delete metadata.preset; delete metadata.library_stamp; delete metadata.industry_preset;
  // The top phase is the board's own name, as each library board's is.
  const roots = Array.isArray(object(source.work_plan).root_nodes) ? object(source.work_plan).root_nodes as JsonObject[] : [];
  if (roots[0]) roots[0].title = service.label.text;
  return { ...source, id, name: service.label.text, category_ids: [PRODUCTION_CATEGORY], status: "active",
    metadata: { ...metadata, work_board: { service: serviceId, from } } };
}

/**
 * Gives each kind of work the profile names its board in this branch, on and in the Production lane, and turns off
 * again the boards this turned on for work no longer picked (unless another kind of work, or the Automations Hub's
 * hand-off, still uses it). Returns the boards by kind of work.
 */
export async function syncWorkBoards(orgId: string, branchId: string, profile: Pick<CompanyProfile, "services" | "lead_flow">, authorUserId: string) {
  const current = await stored(orgId, branchId);
  const record = recordOf(current?.data);
  const picked = profile.services.map((entry) => entry.id).filter((id) => SERVICES.some((service) => service.id === id));
  if (!picked.length && !Object.keys(record.boards).length) return record.boards;
  if (picked.length) await ensureProductionCategory(orgId);
  const flags = await readScopeFlagState(orgId, branchId);
  const toggles: Record<string, boolean> = {};
  const boards: Record_["boards"] = {};
  for (const serviceId of picked) {
    const board = workBoardFor(serviceId);
    let id = board.id;
    let template = await read(orgId, branchId, id);
    // An organization that threw its copy of a library board away gets a board of its own for the work.
    if (template && text(template.status) === "archived" && board.own) { id = `work_${serviceId}`; template = await read(orgId, branchId, id); }
    if (template && text(template.status) === "archived") continue;
    let made = false;
    if (!template) {
      const definition = newBoard(id, serviceId, board.from);
      if (!definition) continue;
      await saveScopeTemplate(orgId, branchId, definition, { publicationAuthorId: authorUserId });
      made = true;
    }
    const before = record.boards[serviceId];
    const on = !made && (toggles[id] ?? flags.flags[id] !== false);
    if (!on) toggles[id] = true;
    boards[serviceId] = { template_id: id, turned_on: !on || (before?.template_id === id && before.turned_on) };
  }
  const kept = new Set(Object.values(boards).map((entry) => entry.template_id));
  for (const [serviceId, entry] of Object.entries(record.boards)) {
    if (boards[serviceId] || !entry.turned_on || kept.has(entry.template_id)) continue;
    // The production board a sold job is handed to stays on while the Automations Hub hands jobs off to it.
    if (entry.template_id === "roof_replacement" && profile.lead_flow?.handoff === "separate") continue;
    toggles[entry.template_id] = false;
  }
  if (Object.keys(toggles).length) await patchScopeFlags(orgId, { expected_revision: flags.revision, flags: toggles }, branchId);
  await saveBranchModule(orgId, branchId, WORK_BOARDS_MODULE, { data: { boards, updated_by: authorUserId } as unknown as JsonObject, expected_revision: Number(current?.revision || 0) }, { replace: true });
  return boards;
}
