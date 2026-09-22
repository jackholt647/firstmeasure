// The knowledge base baked into the stats agent's system prompt: what the
// warehouse contains, how the metric DSL works, and the preset library. The
// static prose is combined with dynamically generated catalogs so new fields
// and presets appear automatically.

import { describeStatsFields } from "../metrics.js";
import { METRIC_PRESETS, VIEW_PRESETS } from "../presets.js";

const STATS_OVERVIEW = `
## What you are working with
FirstMate keeps a live "stats warehouse": one compact row per project with
dimensions (lifecycle status, pipeline stage, project type/template, lead
source, branch, owner/rep) and money measures (contract value, collected,
outstanding, expenses, profit — all integer CENTS), plus a mirrored activity
event log. It updates within seconds of changes and is indexed, so any query
you run is fast even for companies with 100,000+ projects. You never read raw
project documents; you ask the warehouse questions with the metric DSL below.

## The metric DSL
A metric spec is a JSON object:
{
  "source": "projects" | "events",          // default "projects"
  "agg": "count" | "count_distinct" | "sum" | "avg" | "min" | "max",
  "measure": "<measure field>",             // omit for plain count
  "filters": [{ "field": "...", "op": "eq|neq|in|not_in|gt|gte|lt|lte|between|contains|is_set|not_set", "value": ..., "values": [...] }],
  "group_by": "<dimension field>",          // optional, one dimension
  "time": {
    "field": "<date field>",                // default created_at
    "preset": "this_month" | ... ,          // OR from/through as YYYY-MM-DD
    "bucket": "day" | "week" | "month" | "quarter" | "year"   // optional time series
  },
  "sort": "value_desc" | "value_asc" | "group_asc" | "bucket_asc",
  "limit": 50
}

Derived-ratio metrics use a formula over named sub-queries (which must share
the same group_by and bucket):
{
  "formula": "sold / leads * 100",
  "inputs": { "sold": { ...spec... }, "leads": { ...spec... } }
}

Rules of thumb:
- "How many leads" → count over created_at. "How many sold" → filter sold_at is_set, time over sold_at.
- Money fields are integer cents; divide by 100 before speaking dollars.
- Custom project fields are addressable as "attr:<name>" (e.g. attr:roof_squares).
- Time-series need time.bucket; leaderboards/breakdowns need group_by.
- The events source supports project dimensions (project_template_id, project_status, project_source, project_user_id) for questions like "calls logged on roofing projects".

## Dashboards (views)
A dashboard view definition:
{
  "title": "...", "icon": "fa-...", "color": "#hex", "description": "...",
  "time_default": "this_month",
  "widgets": [
    { "id": "stable_id", "type": "kpi|line|bar|donut|table|leaderboard|funnel",
      "size": "sm|md|lg|xl", "title": "...", "format": "number|money|percent|days",
      "metric": { ...spec... } }
  ]
}
Multi-series charts may use "metrics": [{ "key": "Sold", "spec": {...} }, ...]
instead of "metric". Widgets inherit the view's time_default when their spec
has an empty or preset-less time; explicit presets/ranges in a widget win.
Layout flows in widget order: "sm" cards (KPIs) share a row and wrap to fit,
"md" cards sit about two per row, "lg"/"xl" take a full row. Keep related KPIs
adjacent (they form a stat row) and put full-width charts after them.
`;

function fieldCatalogText() {
  const fields = describeStatsFields();
  const line = (field: { key: string; kind: string; label: string; description: string }) =>
    `- ${field.key} (${field.kind}): ${field.label} — ${field.description}`;
  return [
    "## Project fields",
    ...fields.projects.map(line),
    "",
    "## Event fields",
    ...fields.events.map(line),
    "",
    `Time presets: ${fields.time_presets.join(", ")}`
  ].join("\n");
}

function presetCatalogText() {
  return [
    "## Metric presets (reusable specs you can adapt)",
    ...METRIC_PRESETS.map((preset) => `- ${preset.id}: ${preset.label} (${preset.format}) — ${preset.description}`),
    "",
    "## View presets (ready-made dashboards)",
    ...VIEW_PRESETS.map((preset) => `- ${preset.id}: ${preset.title} — ${preset.description}`)
  ].join("\n");
}

export function buildStatsManifest() {
  return [STATS_OVERVIEW.trim(), fieldCatalogText(), presetCatalogText()].join("\n\n");
}
