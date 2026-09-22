// Built-in metric and dashboard-view presets. Metric presets are reusable,
// named specs in the stats DSL (namespace.name.v1 ids, mirroring the work
// automation registry convention); view presets are ready-made dashboards
// built from them. Both are enumerated to the settings UI and into the stats
// agent's manifest so it can cite and instantiate them.

import type { JsonObject } from "./storage.js";

export type MetricPreset = {
  id: string;
  label: string;
  description: string;
  format: "number" | "money" | "percent" | "days";
  spec: JsonObject;
};

export type ViewPreset = {
  id: string;
  title: string;
  icon: string;
  color: string;
  description: string;
  definition: JsonObject;
};

const money = (spec: JsonObject) => spec;

export const METRIC_PRESETS: MetricPreset[] = [
  {
    id: "sales.leadsCreated.v1",
    label: "Leads created",
    description: "Projects created in the period.",
    format: "number",
    spec: { source: "projects", agg: "count", time: { field: "created_at", preset: "this_month" } }
  },
  {
    id: "sales.jobsSold.v1",
    label: "Jobs sold",
    description: "Projects sold in the period (sold_at inside the range).",
    format: "number",
    spec: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_month" } }
  },
  {
    id: "sales.revenueSold.v1",
    label: "Revenue sold",
    description: "Total contract value of projects sold in the period.",
    format: "money",
    spec: money({ source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_month" } })
  },
  {
    id: "sales.closeRate.v1",
    label: "Close rate",
    description: "Sold projects divided by projects created, as a percentage.",
    format: "percent",
    spec: {
      formula: "sold / leads * 100",
      inputs: {
        sold: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "created_at", preset: "this_month" } },
        leads: { source: "projects", agg: "count", time: { field: "created_at", preset: "this_month" } }
      }
    }
  },
  {
    id: "sales.averageJobSize.v1",
    label: "Average job size",
    description: "Average contract value of projects sold in the period.",
    format: "money",
    spec: money({ source: "projects", agg: "avg", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_month" } })
  },
  {
    id: "sales.daysToSale.v1",
    label: "Speed to sale",
    description: "Average days from lead creation to sale.",
    format: "days",
    spec: { source: "projects", agg: "avg", measure: "days_to_sale", time: { field: "sold_at", preset: "this_quarter" } }
  },
  {
    id: "sales.repLeaderboard.v1",
    label: "Sales by rep",
    description: "Revenue sold per rep for the period.",
    format: "money",
    spec: money({ source: "projects", agg: "sum", measure: "contract_cents", group_by: "primary_user_id", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_month" }, limit: 15 })
  },
  {
    id: "sales.bySource.v1",
    label: "Leads by source",
    description: "Lead volume per source for the period.",
    format: "number",
    spec: { source: "projects", agg: "count", group_by: "source", time: { field: "created_at", preset: "this_month" }, limit: 12 }
  },
  {
    id: "pipeline.openByStage.v1",
    label: "Pipeline by stage",
    description: "Open projects per active stage.",
    format: "number",
    spec: { source: "projects", agg: "count", group_by: "stage_title", filters: [{ field: "status", op: "eq", value: "open" }], limit: 20 }
  },
  {
    id: "pipeline.openValue.v1",
    label: "Open pipeline value",
    description: "Contract value of open projects.",
    format: "money",
    spec: money({ source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "status", op: "eq", value: "open" }] })
  },
  {
    id: "ops.activeProjects.v1",
    label: "Active projects",
    description: "Open projects right now.",
    format: "number",
    spec: { source: "projects", agg: "count", filters: [{ field: "status", op: "eq", value: "open" }] }
  },
  {
    id: "ops.completed.v1",
    label: "Jobs completed",
    description: "Projects completed in the period.",
    format: "number",
    spec: { source: "projects", agg: "count", filters: [{ field: "completed_at", op: "is_set" }], time: { field: "completed_at", preset: "this_month" } }
  },
  {
    id: "ops.cycleTime.v1",
    label: "Cycle time",
    description: "Average days from sale to completion.",
    format: "days",
    spec: { source: "projects", agg: "avg", measure: "days_to_complete", time: { field: "completed_at", preset: "this_quarter" } }
  },
  {
    id: "money.collected.v1",
    label: "Cash collected",
    description: "Payments collected across projects (project lifetime totals, filtered by creation period).",
    format: "money",
    spec: money({ source: "projects", agg: "sum", measure: "collected_cents" })
  },
  {
    id: "money.outstanding.v1",
    label: "Outstanding balance",
    description: "Contract value not yet collected across open and completed projects.",
    format: "money",
    spec: money({ source: "projects", agg: "sum", measure: "outstanding_cents", filters: [{ field: "status", op: "in", values: ["open", "completed"] }] })
  },
  {
    id: "money.profitMargin.v1",
    label: "Profit margin",
    description: "Projected profit as a percentage of contract value for sold projects.",
    format: "percent",
    spec: {
      formula: "profit / contract * 100",
      inputs: {
        profit: { source: "projects", agg: "sum", measure: "projected_profit_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_quarter" } },
        contract: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_quarter" } }
      }
    }
  },
  {
    id: "feedback.averageRating.v1",
    label: "Average customer rating",
    description: "Average feedback rating across projects with a recorded rating (custom_fields.feedback_rating).",
    format: "number",
    spec: { source: "projects", agg: "avg", measure: "attr:feedback_rating", filters: [{ field: "attr:feedback_rating", op: "is_set" }] }
  },
  {
    id: "feedback.requestsSent.v1",
    label: "Feedback requests sent",
    description: "Feedback / review invitations sent to customers in the period.",
    format: "number",
    spec: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "feedback.request.sent" }], time: { preset: "this_month" } }
  },
  {
    id: "feedback.ratingsReceived.v1",
    label: "Ratings received",
    description: "Customer ratings submitted in the period.",
    format: "number",
    spec: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "feedback.rating.recorded" }], time: { preset: "this_month" } }
  },
  {
    id: "feedback.reviewClicks.v1",
    label: "Review link clicks",
    description: "Customers who clicked through to a public review site in the period.",
    format: "number",
    spec: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "feedback.review.link_clicked" }], time: { preset: "this_month" } }
  },
  {
    id: "feedback.responseRate.v1",
    label: "Feedback response rate",
    description: "Ratings received divided by feedback requests sent, as a percentage.",
    format: "percent",
    spec: {
      formula: "rated / sent * 100",
      inputs: {
        rated: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "feedback.rating.recorded" }], time: { preset: "this_month" } },
        sent: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "feedback.request.sent" }], time: { preset: "this_month" } }
      }
    }
  },
  {
    id: "activity.byUser.v1",
    label: "Activity by user",
    description: "Customer-meaningful activity events per user in the period.",
    format: "number",
    spec: { source: "events", agg: "count", group_by: "actor_user_id", filters: [{ field: "visibility", op: "eq", value: "activity" }], time: { preset: "this_week" }, limit: 15 }
  }
];

function widget(input: JsonObject): JsonObject {
  return { id: String(input.id), size: "md", ...input };
}

export const VIEW_PRESETS: ViewPreset[] = [
  {
    id: "sales_overview",
    title: "Sales Overview",
    icon: "fa-chart-line",
    color: "#175cd3",
    description: "Lead flow, closes, and revenue for the current period.",
    definition: {
      time_default: "this_month",
      widgets: [
        widget({ id: "leads", type: "kpi", size: "sm", title: "Leads created", format: "number", metric: { source: "projects", agg: "count", time: { field: "created_at" } } }),
        widget({ id: "sold", type: "kpi", size: "sm", title: "Jobs sold", format: "number", metric: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" } } }),
        widget({ id: "revenue", type: "kpi", size: "sm", title: "Revenue sold", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" } } }),
        widget({
          id: "close_rate", type: "kpi", size: "sm", title: "Close rate", format: "percent",
          metric: {
            formula: "sold / leads * 100",
            inputs: {
              sold: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "created_at" } },
              leads: { source: "projects", agg: "count", time: { field: "created_at" } }
            }
          }
        }),
        widget({ id: "lead_trend", type: "line", size: "lg", title: "Leads over time", format: "number", metric: { source: "projects", agg: "count", time: { field: "created_at", bucket: "week" } } }),
        widget({ id: "revenue_trend", type: "line", size: "lg", title: "Revenue sold over time", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", bucket: "week" } } }),
        widget({ id: "reps", type: "leaderboard", size: "md", title: "Sales by rep", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", group_by: "primary_user_id", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" }, limit: 10 } }),
        widget({ id: "sources", type: "donut", size: "md", title: "Leads by source", format: "number", metric: { source: "projects", agg: "count", group_by: "source", time: { field: "created_at" }, limit: 8 } })
      ]
    }
  },
  {
    id: "operations_overview",
    title: "Operations",
    icon: "fa-helmet-safety",
    color: "#067647",
    description: "Active work, throughput, and cycle time.",
    definition: {
      time_default: "this_quarter",
      widgets: [
        widget({ id: "active", type: "kpi", size: "sm", title: "Active projects", format: "number", metric: { source: "projects", agg: "count", filters: [{ field: "status", op: "eq", value: "open" }], time: {} } }),
        widget({ id: "completed", type: "kpi", size: "sm", title: "Completed", format: "number", metric: { source: "projects", agg: "count", filters: [{ field: "completed_at", op: "is_set" }], time: { field: "completed_at" } } }),
        widget({ id: "cycle", type: "kpi", size: "sm", title: "Avg days sale → done", format: "days", metric: { source: "projects", agg: "avg", measure: "days_to_complete", time: { field: "completed_at" } } }),
        widget({ id: "backlog_value", type: "kpi", size: "sm", title: "Open pipeline value", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "status", op: "eq", value: "open" }], time: {} } }),
        widget({ id: "stages", type: "bar", size: "lg", title: "Open projects by stage", format: "number", metric: { source: "projects", agg: "count", group_by: "stage_title", filters: [{ field: "status", op: "eq", value: "open" }], time: {}, limit: 14 } }),
        widget({ id: "completed_trend", type: "line", size: "lg", title: "Completions over time", format: "number", metric: { source: "projects", agg: "count", time: { field: "completed_at", bucket: "week" } } }),
        widget({ id: "by_type", type: "table", size: "md", title: "Projects by type", format: "number", metric: { source: "projects", agg: "count", group_by: "template_id", time: { field: "created_at" }, limit: 12 } })
      ]
    }
  },
  {
    id: "financial_snapshot",
    title: "Financial Snapshot",
    icon: "fa-sack-dollar",
    color: "#6941c6",
    description: "Collected cash, outstanding balances, and margins.",
    definition: {
      time_default: "this_quarter",
      widgets: [
        widget({ id: "collected", type: "kpi", size: "sm", title: "Collected", format: "money", metric: { source: "projects", agg: "sum", measure: "collected_cents", time: { field: "sold_at" } } }),
        widget({ id: "outstanding", type: "kpi", size: "sm", title: "Outstanding", format: "money", metric: { source: "projects", agg: "sum", measure: "outstanding_cents", filters: [{ field: "status", op: "in", values: ["open", "completed"] }], time: {} } }),
        widget({ id: "expenses", type: "kpi", size: "sm", title: "Expenses to date", format: "money", metric: { source: "projects", agg: "sum", measure: "expenses_cents", time: { field: "sold_at" } } }),
        widget({
          id: "margin", type: "kpi", size: "sm", title: "Projected margin", format: "percent",
          metric: {
            formula: "profit / contract * 100",
            inputs: {
              profit: { source: "projects", agg: "sum", measure: "projected_profit_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" } },
              contract: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" } }
            }
          }
        }),
        widget({ id: "collected_trend", type: "line", size: "lg", title: "Contract value sold vs collected", format: "money", metrics: [
          { key: "Sold", spec: { source: "projects", agg: "sum", measure: "contract_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", bucket: "month" } } },
          { key: "Collected", spec: { source: "projects", agg: "sum", measure: "collected_cents", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", bucket: "month" } } }
        ] }),
        widget({ id: "value_by_type", type: "bar", size: "lg", title: "Contract value by project type", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", group_by: "template_id", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" }, limit: 12 } })
      ]
    }
  },
  {
    id: "team_leaderboard",
    title: "Team Leaderboard",
    icon: "fa-trophy",
    color: "#b54708",
    description: "Rep production and activity rankings.",
    definition: {
      time_default: "this_month",
      widgets: [
        widget({ id: "revenue_by_rep", type: "leaderboard", size: "lg", title: "Revenue sold", format: "money", metric: { source: "projects", agg: "sum", measure: "contract_cents", group_by: "primary_user_id", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" }, limit: 15 } }),
        widget({ id: "sold_by_rep", type: "leaderboard", size: "md", title: "Jobs sold", format: "number", metric: { source: "projects", agg: "count", group_by: "primary_user_id", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" }, limit: 15 } }),
        widget({ id: "activity_by_user", type: "leaderboard", size: "md", title: "Activity events", format: "number", metric: { source: "events", agg: "count", group_by: "actor_user_id", filters: [{ field: "visibility", op: "eq", value: "activity" }], time: {}, limit: 15 } })
      ]
    }
  }
];

export function metricPreset(id: string) {
  return METRIC_PRESETS.find((preset) => preset.id === id) || null;
}

export function viewPreset(id: string) {
  return VIEW_PRESETS.find((preset) => preset.id === id) || null;
}
