import type { PlatformAuthContext } from "../platform/auth.js";
import { createOrganizationConnection, listOrganizationConnections } from "../connections/storage.js";
import { createResourceGroup, listResourceGroups } from "../workforce/storage.js";
import { listPaySheets, savePaySheet } from "./pay-sheets.js";

const text = (value: unknown) => String(value ?? "").trim();
const SUB = "Summit Roofing (sample subcontractor)";
const CREW = "Crew A (sample)";

/**
 * Gives a development test organization two ways of being paid for the same roof, so pay sheets, their published
 * requirements and crew comparison have something to show: a subcontractor on piece rates and an in-house crew on
 * hourly. Rates are placeholders. Safe to run again: the subcontractor, the crew and each sheet are matched by name.
 */
export async function seedInstantPaySheets(orgId: string, auth: PlatformAuthContext) {
  // Capability scopes must exist in the organization; without the roofing scope the two are created uncommitted to any.
  const create = async <T>(withScopes: () => Promise<T>, without: () => Promise<T>) => { try { return await withScopes(); } catch { return without(); } };
  const scopes = ["roof_replacement", "repairs"];
  const connections = await listOrganizationConnections(orgId, {});
  const sub = connections.find((row) => text(row.name) === SUB)
    || await create(() => createOrganizationConnection(orgId, { name: SUB, relationship_type_ids: ["work_provider"], capability_scope_ids: scopes }), () => createOrganizationConnection(orgId, { name: SUB, relationship_type_ids: ["work_provider"] }));
  const groups = await listResourceGroups(orgId, {});
  const crew = groups.find((row) => text(row.name) === CREW)
    || await create(() => createResourceGroup(orgId, { name: CREW, kind_id: "crew", capability_scope_ids: scopes }), () => createResourceGroup(orgId, { name: CREW, kind_id: "crew" }));
  const existing = await listPaySheets(orgId);
  const sheets = [
    {
      subject: { type: "organization_connection" as const, id: text(sub.id) }, name: "Summit Roofing piece rates (sample)", schema_ids: ["roofing"],
      inputs: [
        { name: "squares", label: "Roof squares", source: { kind: "measurement" as const, definition: "roof.squares", per_structure: true }, required: true },
        { name: "steep_squares", label: "Squares over 8/12 up to 12/12", source: { kind: "measurement" as const, definition: "roof.squares_9_to_12" }, required: false },
        { name: "very_steep_squares", label: "Squares over 12/12", source: { kind: "measurement" as const, definition: "roof.squares_13_plus" }, required: false },
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
      equipment: [{ name: "Dump trailer", included: true }],
      duration: { input: "squares", units_per_day: 25 }
    },
    {
      subject: { type: "resource_group" as const, id: text(crew.id) }, name: "Crew A hourly (sample)", schema_ids: ["roofing"],
      inputs: [
        { name: "hours", label: "Crew hours", source: { kind: "manual" as const }, required: true },
        { name: "squares", label: "Roof squares", source: { kind: "measurement" as const, definition: "roof.squares" }, required: false }
      ],
      entries: [{ label: "Crew labor", kind: "hourly" as const, unit: "hour", rate_cents: 12800, input: "hours" }],
      equipment: [],
      duration: { input: "squares", units_per_day: 18 }
    }
  ];
  for (const sheet of sheets) if (!existing.some((row) => row.name === sheet.name)) await savePaySheet(orgId, sheet, auth);
  return { subcontractor_id: text(sub.id), crew_id: text(crew.id), sheets: sheets.length };
}
