// The stats analyst, declared as a framework agent. The tool implementations
// are unchanged from the original service — what moved to the shared runtime
// is the loop, trace, report_result contract, thread storage, and the failure
// epilogue. View saves record pre-run baselines in run.scratch; failed runs
// revert every touched view to its pre-run definition via the revert hook.

import { env } from "../../src/config/env.js";
import { readOrganization } from "../../platform/storage.js";
import { executeMetricSpec, executeStatsQueries, validateMetricSpec } from "../metrics.js";
import { createViewFromPreset, statsSchema, validateViewDefinition, WIDGET_TYPES } from "../service.js";
import { ensureStatsFreshness, statsSyncStatus } from "../sync.js";
import {
  deleteViewRecord,
  listViewRecords,
  readViewRecord,
  saveViewRecord
} from "../storage.js";
import { registerAgent } from "../../agents/registry.js";
import { normalizeCommonCore } from "../../agents/settings.js";
import type { AgentRun, AgentTool } from "../../agents/types.js";
import {
  asArray,
  asObject,
  cleanText,
  errorMessage,
  parseJsonArg,
  toolError,
  truncateJson,
  type JsonObject
} from "../../agents/util.js";
import { buildStatsManifest } from "./manifest.js";

const MAX_RENDERS_PER_TURN = 8;

const READ_PERMISSION = "view_stats";
const WRITE_PERMISSION = "manage_stats";

// ── Baseline / revert bookkeeping (kept in run.scratch: plain JSON only) ────

// Pre-run definitions per touched view for revert. null = did not exist.
function viewBaselines(run: AgentRun): Record<string, JsonObject | null> {
  if (!run.scratch.viewBaselines || typeof run.scratch.viewBaselines !== "object") {
    run.scratch.viewBaselines = {};
  }
  return run.scratch.viewBaselines as Record<string, JsonObject | null>;
}

function touchedViewIds(run: AgentRun): string[] {
  if (!Array.isArray(run.scratch.touchedViewIds)) run.scratch.touchedViewIds = [];
  return run.scratch.touchedViewIds as string[];
}

function touchView(run: AgentRun, viewId: string) {
  const ids = touchedViewIds(run);
  if (!ids.includes(viewId)) ids.push(viewId);
}

async function recordViewBaseline(run: AgentRun, viewId: string) {
  const baselines = viewBaselines(run);
  if (Object.prototype.hasOwnProperty.call(baselines, viewId)) return;
  const current = (await readViewRecord(run.orgId, viewId));
  baselines[viewId] = current ? (JSON.parse(JSON.stringify(current)) as JsonObject) : null;
}

function recordViewBaselineAsNew(run: AgentRun, viewId: string) {
  const baselines = viewBaselines(run);
  if (!Object.prototype.hasOwnProperty.call(baselines, viewId)) baselines[viewId] = null;
}

// ── Tools (implementations verbatim from the pre-framework service) ────────

const TOOLS: AgentTool[] = [
  {
    name: "get_stats_schema",
    description: "Read the full stats schema: every field, the org's project types (templates), users (id → name), sources, stages, branches, metric presets, view presets, and warehouse sync status. Call this first when you need ids or labels.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      return { schema: await statsSchema(run.orgId), sync: (await statsSyncStatus(run.orgId)) };
    }
  },
  {
    name: "run_stats_queries",
    description: "Run one or more metric-DSL queries against the warehouse. Results are cached automatically. Returns rows of {bucket?, group?, group_label?, value, row_count}.",
    parameters: { type: "object", properties: { queries: { type: "string", description: "JSON object mapping names to metric specs, e.g. {\"sold\": {\"source\":\"projects\",\"agg\":\"count\", ...}}" } }, required: ["queries"], additionalProperties: false },
    async execute(run, args) {
      const queries = parseJsonArg(args.queries, "queries");
      if (!Object.keys(queries).length) return toolError("queries must be a JSON object of {name: metric spec}.");
      try {
        return (await executeStatsQueries(run.orgId, queries)) as unknown as JsonObject;
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "render_widget",
    description: "Show the customer a chart or table inline in this conversation (kpi, line, bar, donut, table, leaderboard, funnel). Provide a widget object with title, type, format, and metric (or metrics for multi-series). The data is executed and displayed; you also get it back to narrate.",
    parameters: { type: "object", properties: { widget: { type: "string", description: "The widget as a JSON string: {type, title, format, metric | metrics}." } }, required: ["widget"], additionalProperties: false },
    async execute(run, args) {
      const widget = parseJsonArg(args.widget, "widget");
      const type = cleanText(widget.type);
      if (!WIDGET_TYPES.includes(type as never)) {
        return toolError(`Unknown widget type '${type}'. Use: ${WIDGET_TYPES.join(", ")}.`);
      }
      if (run.renders.length >= MAX_RENDERS_PER_TURN) {
        return toolError("Too many rendered widgets in one reply; consolidate.");
      }
      const series = asArray(widget.metrics);
      const specs = series.length
        ? series.map((entry) => ({ key: cleanText(asObject(entry).key) || "Series", spec: asObject(entry).spec }))
        : [{ key: cleanText(widget.title) || "Value", spec: widget.metric }];
      const data: JsonObject = {};
      try {
        for (const { key, spec } of specs.slice(0, 6)) {
          validateMetricSpec(spec);
          data[key] = (await executeMetricSpec(run.orgId, spec));
        }
      } catch (error) {
        return toolError(errorMessage(error));
      }
      run.renders.push({ widget: { ...widget, type }, data });
      return { ok: true, rendered: true, data: JSON.parse(truncateJson(data, 20_000)) };
    }
  },
  {
    name: "list_views",
    description: "List the organization's stats dashboard views.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      return {
        views: (await listViewRecords(run.orgId)).map((view) => ({
          id: view.id,
          title: view.title,
          icon: view.icon,
          color: view.color,
          description: view.description,
          widget_count: asArray(asObject(view.definition).widgets).length,
          is_current_focus: view.id === run.subjectId
        }))
      };
    }
  },
  {
    name: "read_view",
    description: "Read one dashboard view's full definition (defaults to the view in focus).",
    parameters: { type: "object", properties: { view_id: { type: "string" } }, additionalProperties: false },
    async execute(run, args) {
      const view = (await readViewRecord(run.orgId, cleanText(args.view_id) || run.subjectId));
      if (!view) return toolError("That view was not found.");
      return { id: view.id, title: view.title, definition: view.definition };
    }
  },
  {
    name: "save_view",
    description: "Validate and save a COMPLETE dashboard view definition. Omit view_id to create a new view; pass it to replace an existing one. Always read the current definition first and submit the whole thing, not a fragment. Returns {ok:false, errors:[...]} on validation failure — fix and retry.",
    parameters: { type: "object", properties: { view_id: { type: "string" }, definition: { type: "string", description: "The full view definition as a JSON string." }, change_note: { type: "string", description: "One plain-language sentence describing the change." } }, required: ["definition"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const definition = parseJsonArg(args.definition, "definition");
      const viewId = cleanText(args.view_id);
      const validation = validateViewDefinition(definition);
      if (!validation.ok) return { ok: false, errors: validation.errors };
      if (viewId) (await recordViewBaseline(run, viewId));
      const saved = (await saveViewRecord(run.orgId, {
        id: viewId,
        title: definition.title,
        icon: definition.icon,
        color: definition.color,
        description: definition.description,
        definition,
        created_by_user_id: run.userId
      }));
      const savedId = cleanText(saved?.id);
      if (!viewId) recordViewBaselineAsNew(run, savedId);
      touchView(run, savedId);
      run.changeLog.push(cleanText(args.change_note) || `Updated dashboard view '${cleanText(definition.title)}'.`);
      return { ok: true, view_id: savedId };
    }
  },
  {
    name: "create_view_from_preset",
    description: "Instantiate one of the ready-made view presets as a new dashboard view.",
    parameters: { type: "object", properties: { preset_id: { type: "string" } }, required: ["preset_id"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const created = (await createViewFromPreset(run.orgId, cleanText(args.preset_id), run.userId));
      const createdId = cleanText(created?.id);
      recordViewBaselineAsNew(run, createdId);
      touchView(run, createdId);
      run.changeLog.push(`Added the '${cleanText(created?.title)}' dashboard.`);
      return { ok: true, view_id: createdId, title: created?.title };
    }
  },
  {
    name: "delete_view",
    description: "Delete a dashboard view.",
    parameters: { type: "object", properties: { view_id: { type: "string" } }, required: ["view_id"], additionalProperties: false },
    permission: WRITE_PERMISSION,
    async execute(run, args) {
      const viewId = cleanText(args.view_id);
      if (!viewId) return toolError("view_id is required.");
      const existing = (await readViewRecord(run.orgId, viewId));
      if (!existing) return toolError("That view was not found.");
      (await recordViewBaseline(run, viewId));
      (await deleteViewRecord(run.orgId, viewId));
      touchView(run, viewId);
      run.changeLog.push(`Removed dashboard view '${existing.title}'.`);
      return { ok: true };
    }
  }
];

// ── Registration ───────────────────────────────────────────────────────────

export const STATS_AGENT_ID = "stats";

registerAgent({
  id: STATS_AGENT_ID,
  title: "Stats Analyst",
  description: "The conversational stats analyst: answers business questions with live warehouse queries, renders charts inline, and curates stats dashboard views.",
  capability: "platform.stats_agent",
  usePermission: READ_PERMISSION,
  threadScope: "org",
  model: () => ({
    model: env.openaiStatsAgentModel,
    effort: env.openaiStatsAgentEffort,
    timeoutMs: env.openaiStatsAgentTimeoutMs
  }),
  loop: { maxRounds: 16 },
  settings: {
    defaults: () => ({ enabled: true, display_name: "Stats Analyst", custom_instructions: "" }),
    normalize: (raw) => ({ ...normalizeCommonCore(raw, { display_name: "Stats Analyst" }) })
  },
  async prepare(run) {
    await ensureStatsFreshness(run.orgId).catch(() => null);
  },
  async systemPrompt(run) {
    let orgName = "";
    try {
      const record = asObject(await readOrganization(run.orgId));
      orgName = cleanText(asObject(record.data).name || record.name);
    } catch {}

    let focusSummary = "General stats conversation (no specific dashboard in focus).";
    if (run.subjectId) {
      const view = (await readViewRecord(run.orgId, run.subjectId));
      if (view) {
        const widgets = asArray(asObject(view.definition).widgets).map((raw) => cleanText(asObject(raw).title)).filter(Boolean);
        focusSummary = `You are editing the dashboard view "${view.title}" (id ${view.id}). Its current widgets: ${widgets.join(", ") || "(none yet)"}.`;
      }
    }
    const sync = (await statsSyncStatus(run.orgId));
    const syncNote = sync.backfill_done
      ? `The warehouse currently tracks ${sync.project_count} projects.`
      : "NOTE: the stats warehouse is building its first snapshot right now — tell the customer numbers may be incomplete for a minute.";
    const customInstructions = cleanText(asObject(run.settings).custom_instructions);

    return `You are the stats analyst for "${orgName || "this company"}" on the FirstMate platform — the expert who answers business questions with live numbers and curates their stats dashboards. You are talking to a business owner or manager, not a developer.

${buildStatsManifest()}

## Current focus
${focusSummary}
${syncNote}

## Working rules
- Answer questions by RUNNING QUERIES (run_stats_queries) — never estimate or invent numbers. If a question needs ids (users, project types), call get_stats_schema first and translate ids to names in your reply.
- When numbers deserve a visual (trends, comparisons, breakdowns), show them with render_widget right in the conversation — a chart or table beats prose.
- Money values come back in integer cents: divide by 100 and speak in dollars.
- When you answer something that is NOT already on one of their dashboards, offer at the end of your reply to add it ("Want me to add this to your dashboard so you can track it going forward?"). Only save after they say yes.
- When editing views: read the current definition first, keep existing widgets unless asked to remove them, give widgets stable ids, and submit the COMPLETE definition to save_view. Validation errors tell you exactly what to fix — iterate until the save succeeds. If you cannot succeed after a few attempts, call report_result with status "failed" (your changes will be reverted) and explain simply.
- ALWAYS finish by calling report_result, then give a short, friendly reply in plain language: the answer or what changed. No JSON, no field names, no jargon.
- If the warehouse is still building its first snapshot, say numbers may be incomplete for another minute or two.${customInstructions ? `\n\n## Company instructions\n${customInstructions}` : ""}`;
  },
  tools: TOOLS,
  async revert(run) {
    const reverted: string[] = [];
    const baselines = viewBaselines(run);
    for (const viewId of touchedViewIds(run)) {
      const baseline = baselines[viewId];
      try {
        if (baseline === null) {
          (await deleteViewRecord(run.orgId, viewId));
        } else if (baseline) {
          (await saveViewRecord(run.orgId, {
            id: viewId,
            title: baseline.title,
            icon: baseline.icon,
            color: baseline.color,
            description: baseline.description,
            sort_order: baseline.sort_order,
            preset_id: baseline.preset_id,
            definition: asObject(baseline.definition)
          }));
        }
        reverted.push(viewId);
      } catch {
        // Best effort — report whatever state remains.
      }
    }
    return reverted;
  }
});
