import { createOrganizationConnection, listOrganizationConnections } from "../connections/storage.js";
import { createResourceGroup, listResourceGroups } from "../workforce/storage.js";
import type { Actor } from "./assignees.js";
import { listPaySheets, savePaySheet } from "./pay-sheets.js";

const text = (value: unknown) => String(value ?? "").trim();
const measurement = (definition: string, per_structure = false) => ({ kind: "measurement" as const, definition, ...(per_structure ? { per_structure } : {}) });
const squares = { name: "squares", label: "Roof squares", source: measurement("roof.squares", true), required: true };
// Their own truck takes the debris away, as many loads as it needs.
const DUMP_TRUCK = { name: "Dump truck", included: true, provides: [{ item: "disposal.debris", capacity: 12, per_load: true }] };
const ROOF_WORK = ["roofing.tear_off", "roofing.dry_in", "roofing.install"];
const TRIM = ["roofing.edge_metal", "roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"];
const included = (items: string[]) => items.map((item) => ({ item, included: true }));
// Hours for each unit of work, for one group working together. They follow the shape of the job; they are not a promise.
const HOURS = [["roofing.tear_off", 0.14], ["roofing.dry_in", 0.05], ["roofing.install", 0.22], ["roofing.edge_metal", 0.004], ["roofing.ridge_cap", 0.008], ["roofing.valleys", 0.02], ["roofing.wall_flashing", 0.03], ["roofing.cleanup", 0.75]].map(([item, hours_per_unit]) => ({ item: item as string, hours_per_unit: hours_per_unit as number }));

/**
 * Five assignees paid five different ways for the same roof, so pay sheets, generated labor lists and comparing
 * assignees have something to show. Three are in-house groups (hourly, by the square, and salaried at a cost rate) and two are outside companies; one
 * in-house group and one company bring their own dump truck. Names and rates are placeholders. Safe to run again: groups, companies
 * and sheets are matched by name, and a sheet that already exists is brought up to this definition.
 */
export async function seedInstantPaySheets(orgId: string, actor: Actor) {
  // Capability scopes must exist in the organization; without the roofing scope an assignee is created uncommitted to any.
  const create = async <T>(withScopes: () => Promise<T>, without: () => Promise<T>) => { try { return await withScopes(); } catch { return without(); } };
  const scopes = ["roof_replacement", "repairs"];
  const groups = await listResourceGroups(orgId, {}), connections = await listOrganizationConnections(orgId, {});
  const group = async (name: string) => groups.find((row) => text(row.name) === name) || await create(() => createResourceGroup(orgId, { name, kind_id: "crew", capability_scope_ids: scopes }), () => createResourceGroup(orgId, { name, kind_id: "crew" }));
  const company = async (name: string) => connections.find((row) => text(row.name) === name) || await create(() => createOrganizationConnection(orgId, { name, relationship_type_ids: ["work_provider"], capability_scope_ids: scopes }), () => createOrganizationConnection(orgId, { name, relationship_type_ids: ["work_provider"] }));
  const crewA = await group("Crew A (sample)"), crewB = await group("Crew B (sample)"), crewC = await group("Crew C (sample)");
  const summit = await company("Summit Roofing (sample subcontractor)"), ridgeline = await company("Ridgeline Exteriors (sample subcontractor)");
  const sheets = [
    // An in-house group paid by the hour, with no truck of its own. Its hours are estimated from the work the job
    // requires, and a number typed on the list replaces the estimate. It does everything but take the debris away.
    {
      subject: { type: "resource_group" as const, id: text(crewA.id) }, name: "Crew A hourly (sample)", schema_ids: ["roofing"],
      inputs: [{ name: "hours", label: "Hours", source: { kind: "work_hours" as const }, required: true }],
      entries: [{ label: "Hourly labor", kind: "hourly" as const, unit: "hour", rate_cents: 12800, input: "hours", covers: [...ROOF_WORK, ...TRIM] }],
      equipment: [], work: HOURS, duration: { hours_per_day: 8 }
    },
    // A salaried in-house group. Its hours are priced at what that time costs the business, to project the job; nobody
    // is paid from this line, because their pay is their salary.
    {
      subject: { type: "resource_group" as const, id: text(crewC.id) }, name: "Crew C salaried cost rate (sample)", schema_ids: ["roofing"],
      inputs: [{ name: "hours", label: "Hours", source: { kind: "manual" as const }, required: true }, { name: "squares", label: "Roof squares", source: measurement("roof.squares"), required: false }],
      entries: [{ label: "Salaried time", kind: "cost_rate" as const, unit: "hour", rate_cents: 9500, input: "hours", covers: [...ROOF_WORK, ...TRIM] }],
      equipment: [], duration: { input: "squares", units_per_day: 20 }
    },
    // An in-house group paid by the square, which brings its own dump truck.
    {
      subject: { type: "resource_group" as const, id: text(crewB.id) }, name: "Crew B production pay (sample)", schema_ids: ["roofing"],
      inputs: [squares, { name: "steep_squares", label: "Squares over 8/12 up to 12/12", source: measurement("roof.squares_9_to_12"), required: false }],
      // One price for the whole roof. The steep line reads a part of the same squares, so it adjusts and does not count again.
      entries: [{ label: "Tear off and install", kind: "piece_rate" as const, unit: "sq", rate_cents: 6500, input: "squares", covers: ROOF_WORK }, { label: "Steep pay", kind: "piece_rate" as const, unit: "sq", rate_cents: 1000, input: "steep_squares", covers: ROOF_WORK }],
      equipment: [DUMP_TRUCK], work: included(TRIM), duration: { input: "squares", units_per_day: 22 }
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
        { label: "Tear off and install", kind: "piece_rate" as const, unit: "sq", rate_cents: 9500, input: "squares", covers: ROOF_WORK },
        { label: "Steep charge", kind: "piece_rate" as const, unit: "sq", rate_cents: 1500, input: "steep_squares", covers: ROOF_WORK },
        { label: "Very steep charge", kind: "piece_rate" as const, unit: "sq", rate_cents: 3000, input: "very_steep_squares", covers: ROOF_WORK },
        { label: "Hip & ridge cap", kind: "piece_rate" as const, unit: "bundle", rate_cents: 800, input: "ridge_bundles", covers: ["roofing.ridge_cap"] },
        { label: "Pack out", kind: "piece_rate" as const, unit: "ft", rate_cents: 100, input: "pack_out_feet", minimum_cents: 5000, when: "pack_out_feet" },
        { label: "Extra layer tear off", kind: "piece_rate" as const, unit: "layer", rate_cents: 25000, input: "extra_layers", when: "extra_layers" }
      ],
      equipment: [DUMP_TRUCK], work: included(["roofing.edge_metal", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"]), duration: { input: "squares", units_per_day: 25 }
    },
    // An outside company that charges by the bundle laid rather than by the square, with a job minimum and no truck.
    // Tear-off is its own line, so it can be given to someone else; the debris is left for someone else to take away.
    {
      subject: { type: "organization_connection" as const, id: text(ridgeline.id) }, name: "Ridgeline Exteriors per bundle (sample)", schema_ids: ["roofing"],
      inputs: [
        { name: "shingle_bundles", label: "Shingle bundles", source: { kind: "material" as const, item_type: "Shingles" }, required: true },
        { name: "squares", label: "Roof squares", source: measurement("roof.squares"), required: false },
        { name: "eave_feet", label: "Eaves", source: measurement("roof.eave_length"), required: false }
      ],
      entries: [
        { label: "Shingles laid", kind: "piece_rate" as const, unit: "bundle", rate_cents: 2900, input: "shingle_bundles", minimum_cents: 150000, covers: ["roofing.dry_in", "roofing.install"] },
        { label: "Tear off", kind: "piece_rate" as const, unit: "sq", rate_cents: 2500, input: "squares", covers: ["roofing.tear_off"] },
        { label: "Drip edge", kind: "piece_rate" as const, unit: "ft", rate_cents: 75, input: "eave_feet", covers: ["roofing.edge_metal"] }
      ],
      equipment: [], work: included(["roofing.ridge_cap", "roofing.valleys", "roofing.wall_flashing", "roofing.cleanup"]), duration: { input: "squares", units_per_day: 20 }
    }
  ];
  const existing = await listPaySheets(orgId);
  for (const sheet of sheets) {
    const match = existing.find((row) => row.name === sheet.name) || existing.find((row) => row.subject.type === sheet.subject.type && row.subject.id === sheet.subject.id);
    await savePaySheet(orgId, match ? { ...sheet, id: match.id, expected_revision: match.revision } : sheet, actor);
  }
  return { assignees: 5, sheets: sheets.length };
}
