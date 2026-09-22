// Stats service: the schema catalog (what the UI builder and the agent can
// see), dashboard-view validation and CRUD, and preset instantiation.

import { badRequest, notFound } from "../platform/errors.js";
import { listDocuments } from "../platform/storage.js";
import { getWorkDatabase } from "../work/storage.js";
import { describeStatsFields, validateMetricSpec, TIME_PRESETS } from "./metrics.js";
import { METRIC_PRESETS, VIEW_PRESETS, viewPreset } from "./presets.js";
import {
  deleteViewRecord,
  ensureSyncState,
  getStatsDatabase,
  listViewRecords,
  readViewRecord,
  saveViewRecord,
  updateSyncState,
  type JsonObject
} from "./storage.js";

export const WIDGET_TYPES = ["kpi", "line", "bar", "donut", "table", "leaderboard", "funnel"] as const;
export const WIDGET_SIZES = ["sm", "md", "lg", "xl"] as const;
export const WIDGET_FORMATS = ["number", "money", "percent", "days"] as const;
const MAX_WIDGETS = 24;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// ── Schema catalog ─────────────────────────────────────────────────────────

async function distinctColumn(orgId: string, column: string, where = "") {
  return (await getStatsDatabase()
    .prepare(`SELECT DISTINCT ${column} AS value FROM stats_projects WHERE organization_id = ?${where ? ` AND ${where}` : ""} ORDER BY 1 LIMIT 200`)
    .all(orgId))
    .map((row) => cleanText(asObject(row).value))
    .filter(Boolean);
}

export async function statsSchema(orgId: string) {
  const templates = (await getWorkDatabase()
    .prepare("SELECT id, name, color, icon, status FROM scope_templates WHERE organization_id = ? ORDER BY sort_order, name LIMIT 200")
    .all(orgId))
    .map((row) => {
      const value = asObject(row);
      return { id: cleanText(value.id), name: cleanText(value.name), color: cleanText(value.color), icon: cleanText(value.icon), status: cleanText(value.status) };
    });
  let users: JsonObject[] = [];
  try {
    users = (await listDocuments(orgId, "users")).map((doc) => {
      const record = asObject(doc);
      const data = asObject(record.data);
      return {
        id: cleanText(record.id),
        name: cleanText(data.name || `${cleanText(data.first_name)} ${cleanText(data.last_name)}` || data.email),
        email: cleanText(data.email)
      };
    }).filter((user) => cleanText(user.id));
  } catch {}
  return {
    fields: describeStatsFields(),
    widget_types: [...WIDGET_TYPES],
    widget_sizes: [...WIDGET_SIZES],
    widget_formats: [...WIDGET_FORMATS],
    time_presets: [...TIME_PRESETS],
    templates,
    users,
    sources: (await distinctColumn(orgId, "source", "source <> ''")),
    stages: (await distinctColumn(orgId, "stage_title", "stage_title <> ''")),
    branches: (await distinctColumn(orgId, "branch_id")),
    metric_presets: METRIC_PRESETS.map((preset) => ({ id: preset.id, label: preset.label, description: preset.description, format: preset.format, spec: preset.spec })),
    view_presets: VIEW_PRESETS.map((preset) => ({ id: preset.id, title: preset.title, icon: preset.icon, color: preset.color, description: preset.description }))
  };
}

// ── View validation ────────────────────────────────────────────────────────

export function validateViewDefinition(definitionValue: unknown) {
  const errors: string[] = [];
  const definition = asObject(definitionValue);
  if (!cleanText(definition.title)) errors.push("The view needs a title.");
  const timeDefault = cleanText(definition.time_default);
  if (timeDefault && !TIME_PRESETS.includes(timeDefault as never)) {
    errors.push(`Unknown time_default '${timeDefault}'. Use one of: ${TIME_PRESETS.join(", ")}.`);
  }
  // Zero widgets is allowed: views can start blank and be filled by the agent.
  const widgets = asArray(definition.widgets);
  if (widgets.length > MAX_WIDGETS) errors.push(`Views are limited to ${MAX_WIDGETS} widgets.`);
  const seenIds = new Set<string>();
  widgets.slice(0, MAX_WIDGETS).forEach((raw, index) => {
    const widget = asObject(raw);
    const label = cleanText(widget.title) || `widget ${index + 1}`;
    const id = cleanText(widget.id);
    if (!id) errors.push(`${label}: every widget needs a stable string id.`);
    else if (seenIds.has(id)) errors.push(`${label}: duplicate widget id '${id}'.`);
    seenIds.add(id);
    if (!WIDGET_TYPES.includes(cleanText(widget.type) as never)) {
      errors.push(`${label}: unknown widget type '${cleanText(widget.type)}'. Use: ${WIDGET_TYPES.join(", ")}.`);
    }
    if (widget.size !== undefined && !WIDGET_SIZES.includes(cleanText(widget.size) as never)) {
      errors.push(`${label}: unknown size '${cleanText(widget.size)}'.`);
    }
    if (widget.format !== undefined && !WIDGET_FORMATS.includes(cleanText(widget.format) as never)) {
      errors.push(`${label}: unknown format '${cleanText(widget.format)}'.`);
    }
    const series = asArray(widget.metrics);
    const specs = series.length ? series.map((entry) => asObject(entry).spec) : widget.metric !== undefined ? [widget.metric] : [];
    if (!specs.length) errors.push(`${label}: needs a 'metric' spec (or a 'metrics' array of {key, spec}).`);
    for (const spec of specs) {
      try {
        validateMetricSpec(spec);
      } catch (error) {
        errors.push(`${label}: ${String(asObject(error).message || error)}`);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

// ── View CRUD ──────────────────────────────────────────────────────────────

async function seedDefaultViews(orgId: string) {
  return (await getStatsDatabase().transaction(async () => {
  const state = (await ensureSyncState(orgId));
  if (Number(state.views_seeded)) return;
  if (!(await listViewRecords(orgId)).length) {
    for (const preset of VIEW_PRESETS.slice(0, 2)) {
      (await saveViewRecord(orgId, {
        title: preset.title,
        icon: preset.icon,
        color: preset.color,
        description: preset.description,
        preset_id: preset.id,
        definition: { ...preset.definition, title: preset.title, icon: preset.icon, color: preset.color }
      }));
    }
  }
  (await updateSyncState(orgId, { views_seeded: 1 }));

  }));
}

export async function listStatsViews(orgId: string) {
  (await seedDefaultViews(orgId));
  return (await listViewRecords(orgId));
}

export async function readStatsView(orgId: string, viewId: string) {
  const view = (await readViewRecord(orgId, viewId));
  if (!view) throw notFound("stats_view_not_found", "This stats view was not found.");
  return view;
}

export async function saveStatsView(orgId: string, input: JsonObject) {
  const definition = asObject(input.definition);
  const merged = {
    ...definition,
    title: cleanText(input.title || definition.title),
    icon: cleanText(input.icon ?? definition.icon),
    color: cleanText(input.color ?? definition.color),
    description: cleanText(input.description ?? definition.description)
  };
  const validation = validateViewDefinition(merged);
  if (!validation.ok) throw badRequest("stats_view_invalid", "The view definition is invalid.", { errors: validation.errors });
  return (await saveViewRecord(orgId, {
    id: cleanText(input.id),
    title: merged.title,
    icon: merged.icon,
    color: merged.color,
    description: merged.description,
    sort_order: input.sort_order,
    preset_id: cleanText(input.preset_id),
    definition: merged,
    created_by_user_id: cleanText(input.created_by_user_id)
  }));
}

export async function deleteStatsView(orgId: string, viewId: string) {
  if (!(await deleteViewRecord(orgId, viewId))) throw notFound("stats_view_not_found", "This stats view was not found.");
  return true;
}

export async function createViewFromPreset(orgId: string, presetId: string, actorUserId: string) {
  const preset = viewPreset(cleanText(presetId));
  if (!preset) throw notFound("stats_preset_not_found", `Unknown view preset '${cleanText(presetId)}'.`);
  return (await saveViewRecord(orgId, {
    title: preset.title,
    icon: preset.icon,
    color: preset.color,
    description: preset.description,
    preset_id: preset.id,
    definition: { ...preset.definition, title: preset.title, icon: preset.icon, color: preset.color },
    created_by_user_id: actorUserId
  }));
}
