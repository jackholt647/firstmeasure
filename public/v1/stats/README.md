# Stats API (`/v1/stats`)

The Stats tab's backend: a per-organization **fact warehouse** in SQLite
(`storage/platform/stats.sqlite`) plus a safe **metric DSL** that compiles to
indexed SQL, a version-keyed **query cache**, dashboard **views**, and the
conversational **stats agent** (GPT-5.6 Sol, same loop shape as the scope
agent).

## Why a warehouse

Project documents live in the unindexed JSON platform store, so any aggregate
over them is a full scan — untenable at 100k+ projects. Instead the stats
module maintains:

- `stats_projects` — one compact row per project: dimensions (status, stage,
  template/project type, source, branch, owner) + money measures in integer
  cents (contract, collected, outstanding, expenses, profit) + custom fields
  (`attrs_json`). Heavily indexed per org.
- `stats_events` — a slim mirror of `work_events` for activity metrics,
  joinable to project dimensions.

Freshness (see `sync.ts`):
1. **Backfill** once per org on first use (chunked).
2. **Incremental**: tail `work_events` by rowid cursor → mark dirty project
   ids → rebuild only those rows. Runs inline on reads (debounced to 5s) and
   from a 15s scheduler (`STATS_SCHEDULER_DISABLED=1` to turn off).
3. **Rolling reconcile**: rebuild the stalest rows every ~5 minutes to heal
   drift the event tail can't see (e.g. payment edits) and remove deleted
   projects.

Every successful sync bumps the org's `data_version`. Query-cache keys embed
that version plus concretely-resolved time ranges, so cache entries
self-invalidate — no explicit invalidation anywhere.

## The metric DSL (`metrics.ts`)

Specs are JSON; fields validate against a whitelist and compile to
parameterized SQL. No caller-supplied SQL ever runs.

```json
{
  "source": "projects",
  "agg": "sum",
  "measure": "contract_cents",
  "filters": [{ "field": "sold_at", "op": "is_set" }],
  "group_by": "primary_user_id",
  "time": { "field": "sold_at", "preset": "this_month", "bucket": "week" }
}
```

- Aggregations: `count`, `count_distinct`, `sum`, `avg`, `min`, `max`.
- Custom project fields: `attr:<name>` (from `data.custom_fields`).
- Formula metrics: `{ "formula": "sold / leads * 100", "inputs": { ... } }` —
  inputs must share `group_by`/`bucket`; combined per group+bucket with a
  safe arithmetic evaluator.
- Time presets resolve relative ranges (`this_month`, `last_30_days`, …) to
  concrete dates before hashing, so equivalent requests share cache entries.

## Endpoints

- `GET  /organizations/:orgId/schema` — field catalog, templates, users,
  sources, stages, presets (feeds the UI and the agent).
- `POST /organizations/:orgId/query` — `{queries: {name: spec}}`, batched +
  cached.
- `GET/POST/PUT/DELETE /organizations/:orgId/views[/:viewId]` — dashboard
  views (`presets.ts` ships ready-made ones; two are seeded on first list).
- `GET  /organizations/:orgId/presets`, `GET/POST .../sync`.
- `GET/POST /organizations/:orgId/agent/threads[...]` — the stats agent
  (threads/messages in `stats.sqlite`; tools: run queries, render widgets
  inline, view CRUD; failed runs revert view edits).

Reads need `view_projects|manage_projects|manage_company_settings`; writes
need `manage_projects|manage_company_settings`. Org gate: capability
`apps.stats` (registered in `platform/capability_defs.ts`).

## Frontend

- `public/libraries/stats-api/stats-api.js` — `window.StatsAPI`.
- `public/libraries/apps/stats/app.js` — the portal tab (`portal.stats`):
  view pills, widget grid (hand-rolled SVG: kpi/line/bar/donut/table/
  leaderboard/funnel), view editor modal, and the assistant chat drawer that
  renders the agent's inline widgets with the same renderer.

## Tests

`npm run test:stats` (see `tests/stats-api.test.ts`; the agent turn is tested
with a scripted OpenAI mock). `npm run test:stats:frontend` syntax-checks the
browser bundles.
