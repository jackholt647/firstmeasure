import { createOrganizationConnection, listOrganizationConnections } from "../connections/storage.js";
import { createResourceGroup, listResourceGroups } from "../workforce/storage.js";
import type { Actor } from "./assignees.js";
import { listPaySheets, savePaySheet } from "./pay-sheets.js";

const text = (value: unknown) => String(value ?? "").trim();
const measurement = (definition: string, per_structure = false) => ({ kind: "measurement" as const, definition, ...(per_structure ? { per_structure } : {}) });
const squares = { name: "squares", label: "Roof squares", source: measurement("roof.squares", true), required: true };
const DUMP_TRUCK = { name: "Dump truck", included: true };

/**
 * Four assignees paid four different ways for the same roof, so pay sheets, generated labor lists and comparing
 * assignees have something to show. Two are in-house groups and two are outside companies; one of each brings its
 * own dump truck and one of each does not. Names and rates are placeholders. Safe to run again: groups, companies
 * and sheets are matched by name, and a sheet that already exists is brought up to this definition.
 */
export async function seedInstantPaySheets(orgId: string, actor: Actor) {
  // Capability scopes must exist in the organization; without the roofing scope an assignee is created uncommitted to any.
  const create = async <T>(withScopes: () => Promise<T>, without: () => Promise<T>) => { try { return await withScopes(); } catch { return without(); } };
  const scopes = ["roof_replacement", "repairs"];
  const groups = await listResourceGroups(orgId, {}), connections = await listOrganizationConnections(orgId, {});
  const group = async (name: string) => groups.find((row) => text(row.name) === name) || await create(() => createResourceGroup(orgId, { name, kind_id: "crew", capability_scope_ids: scopes }), () => createResourceGroup(orgId, { name, kind_id: "crew" }));
  const company = async (name: string) => connections.find((row) => text(row.name) === name) || await create(() => createOrganizationConnection(orgId, { name, relationship_type_ids: ["work_provider"], capability_scope_ids: scopes }), () => createOrganizationConnection(orgId, { name, relationship_type_ids: ["work_provider"] }));
  const crewA = await group("Crew A (sample)"), crewB = await group("Crew B (sample)");
  const summit = await company("Summit Roofing (sample subcontractor)"), ridgeline = await company("Ridgeline Exteriors (sample subcontractor)");
  const sheets = [
    // An in-house group paid by the hour, with no truck of its own. It cannot be priced until hours are entered.
    {
      subject: { type: "resource_group" as const, id: text(crewA.id) }, name: "Crew A hourly (sample)", schema_ids: ["roofing"],
      inputs: [{ name: "hours", label: "Hours", source: { kind: "manual" as const }, required: true }, { name: "squares", label: "Roof squares", source: measurement("roof.squares"), required: false }],
      entries: [{ label: "Hourly labor", kind: "hourly" as const, unit: "hour", rate_cents: 12800, input: "hours" }],
      equipment: [], duration: { input: "squares", units_per_day: 18 }
    },
    // An in-house group paid by the square, which brings its own dump truck.
    {
      subject: { type: "resource_group" as const, id: text(crewB.id) }, name: "Crew B production pay (sample)", schema_ids: ["roofing"],
      inputs: [squares, { name: "steep_squares", label: "Squares over 8/12 up to 12/12", source: measurement("roof.squares_9_to_12"), required: false }],
      entries: [{ label: "Tear off and install", kind: "piece_rate" as const, unit: "sq", rate_cents: 6500, input: "squares" }, { label: "Steep pay", kind: "piece_rate" as const, unit: "sq", rate_cents: 1000, input: "steep_squares" }],
      equipment: [DUMP_TRUCK], duration: { input: "squares", units_per_day: 22 }
    },
    // An outside company on piece rates with adders, which brings its own dump truck.
    {
      subject: { type: "organization_connection" as const, id: text(summit.id) }, name: "Summit Roofing piece rates (sample)", schema_ids: ["roofing"],
      inputs: [
        squares,
        { name: "steep_squares", label: "Squares over 8/12 up to 12/12", source: measurement("roof.squares_9_to_12"), required: false },
        { name: "very_steep_squares", label: "Squares over 12/12", source: measurement("roof.squares_13_plus"), required: false },
        { name: "ridge_bundles", label: "Hip & ridge bundles", source: { kind: "material" as const, item_type: "Hip & Ridge" }, required: false },
        { name: "pack_out_feet", label: "Pack-out distance (ft)", source: { kind: "field" as const, key: "pack_out_feet" }, required: false, default: 0 },
        { name: "extra_layers", label: "Extra layers to tear off", source: { kind: "manual" as const }, required: false, default: 0 }
      ],
      entries: [
        { label: "Tear off and install", kind: "piece_rate" as const, unit: "sq", rate_cents: 9500, input: "squares" },
        { label: "Steep charge", kind: "piece_rate" as const, unit: "sq", rate_cents: 1500, input: "steep_squares" },
        { label: "Very steep charge", kind: "piece_rate" as const, unit: "sq", rate_cents: 3000, input: "very_steep_squares" },
        { label: "Hip & ridge cap", kind: "piece_rate" as const, unit: "bundle", rate_cents: 800, input: "ridge_bundles" },
        { label: "Pack out", kind: "piece_rate" as const, unit: "ft", rate_cents: 100, input: "pack_out_feet", minimum_cents: 5000, when: "pack_out_feet" },
        { label: "Extra layer tear off", kind: "piece_rate" as const, unit: "layer", rate_cents: 25000, input: "extra_layers", when: "extra_layers" }
      ],
      equipment: [DUMP_TRUCK], duration: { input: "squares", units_per_day: 25 }
    },
    // An outside company that charges by the bundle laid rather than by the square, with a job minimum and no truck.
    {
      subject: { type: "organization_connection" as const, id: text(ridgeline.id) }, name: "Ridgeline Exteriors per bundle (sample)", schema_ids: ["roofing"],
      inputs: [
        { name: "shingle_bundles", label: "Shingle bundles", source: { kind: "material" as const, item_type: "Shingles" }, required: true },
        { name: "squares", label: "Roof squares", source: measurement("roof.squares"), required: false },
        { name: "eave_feet", label: "Eaves", source: measurement("roof.eave_length"), required: false }
      ],
      entries: [
        { label: "Shingles laid", kind: "piece_rate" as const, unit: "bundle", rate_cents: 2900, input: "shingle_bundles", minimum_cents: 150000 },
        { label: "Tear off", kind: "piece_rate" as const, unit: "sq", rate_cents: 2500, input: "squares" },
        { label: "Drip edge", kind: "piece_rate" as const, unit: "ft", rate_cents: 75, input: "eave_feet" }
      ],
      equipment: [], duration: { input: "squares", units_per_day: 20 }
    }
  ];
  const existing = await listPaySheets(orgId);
  for (const sheet of sheets) {
    const match = existing.find((row) => row.name === sheet.name) || existing.find((row) => row.subject.type === sheet.subject.type && row.subject.id === sheet.subject.id);
    await savePaySheet(orgId, match ? { ...sheet, id: match.id, expected_revision: match.revision } : sheet, actor);
  }
  return { assignees: 4, sheets: sheets.length };
}
