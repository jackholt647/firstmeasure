// The knowledge base baked into the global assistant's system prompt: what
// FirstMate is, how the platform's data model fits together, and the metric
// DSL for stats questions. Static prose is combined with dynamically
// generated catalogs (stats fields, automation event types) so new fields and
// events appear automatically.

import { describeStatsFields } from "../../stats/metrics.js";
import { listWorkEventDefinitions } from "../../work/events.js";

const PLATFORM_OVERVIEW = `
## The platform you operate
FirstMate is an all-in-one platform for home-services and construction
companies: sales pipeline, project delivery, scheduling, customer
communication, documents (proposals/invoices), payments, and stats. The
things you can touch:

- **Projects** are the center of everything. A project has a title, address,
  contacts (customers), custom fields, documents, schedule events, and one or
  more scope instances (work plans). There is no "stage" column on the
  project — pipeline/production stage and lifecycle (open, sold, completed,
  canceled/lost) are derived from its work plans. get_project returns all of
  this in one call.
- **Contacts/customers** live on projects and in the customer directory.
  search_platform finds both projects and contacts by name, phone, email, or
  address fragment.
- **Tasks (to-dos / action items)** are work nodes: manual to-dos, follow-ups,
  and workflow tasks from scope templates. Pipeline stages are ALSO work
  nodes — update_task_status can complete a task or advance a stage node.
- **Schedule** = org calendar events plus per-project schedule requirements
  (project.events). schedule_project_event creates or books a project event.
- **Automations** listen to work events (catalog below). trigger_automation_event
  fires an event through the same engine that real activity uses — matching
  org automation rules and scope bindings WILL run, so only fire events the
  user actually wants.
- **Documents** are proposals, invoices, contracts, and reports generated from
  templates. read_document gives you one document's state.
- **Stats** come from a live warehouse (one indexed row per project + an event
  mirror). Never estimate numbers — run queries.

## Working with money and ids
- All money values in stats and payments are integer CENTS; divide by 100
  before speaking dollars.
- Users, templates, and stages are referenced by id in the data but the
  customer thinks in names. get_workspace_context gives you the id → name
  catalogs; always translate ids to names in replies.
`;

const STATS_DSL = `
## The stats metric DSL (for run_stats_queries)
A metric spec is a JSON object:
{
  "source": "projects" | "events",          // default "projects"
  "agg": "count" | "count_distinct" | "sum" | "avg" | "min" | "max",
  "measure": "<measure field>",             // omit for plain count
  "filters": [{ "field": "...", "op": "eq|neq|in|not_in|gt|gte|lt|lte|between|contains|is_set|not_set", "value": ..., "values": [...] }],
  "group_by": "<dimension field>",          // optional, one dimension
  "time": { "field": "<date field>", "preset": "this_month" | ..., "bucket": "day|week|month|quarter|year" },
  "sort": "value_desc" | "value_asc" | "group_asc" | "bucket_asc",
  "limit": 50
}
Derived ratios use { "formula": "sold / leads * 100", "inputs": { "sold": {...}, "leads": {...} } }.
Rules of thumb: "how many leads" → count over created_at; "how many sold" →
filter sold_at is_set with time over sold_at; custom project fields are
addressable as "attr:<name>".
`;

function statsFieldCatalogText() {
  const fields = describeStatsFields();
  const line = (field: { key: string; kind: string; label: string; description: string }) =>
    `- ${field.key} (${field.kind}): ${field.label} — ${field.description}`;
  return [
    "## Stats project fields",
    ...fields.projects.map(line),
    "",
    "## Stats event fields",
    ...fields.events.map(line),
    "",
    `Time presets: ${fields.time_presets.join(", ")}`
  ].join("\n");
}

function eventCatalogText() {
  const definitions = listWorkEventDefinitions();
  return [
    "## Automation event catalog (for trigger_automation_event and list_activity type filters)",
    ...definitions.map((definition) => `- ${definition.name}${definition.description ? `: ${definition.description}` : ""}`)
  ].join("\n");
}

export function buildAssistantManifest() {
  return [PLATFORM_OVERVIEW.trim(), STATS_DSL.trim(), statsFieldCatalogText(), eventCatalogText()].join("\n\n");
}
