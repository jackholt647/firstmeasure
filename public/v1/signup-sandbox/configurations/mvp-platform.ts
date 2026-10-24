// The MVP platform configuration: the FirstMeasure signup plus a small, explicit
// set of platform apps, with every project a simple roof job. Everything that
// makes this configuration what it is lives in this file: the workflow, its
// flags and placements, and the setup script that installs its scope. The
// platform never checks for it; the sandbox only runs the setup scripts a
// workflow names (configurations/index.ts).
import { valueCapabilities } from "../../platform/capabilities.js";
import { saveIntakeRouting, readIntakeRouting } from "../../scopes/router.js";
import { listScopeTemplates, patchScopeFlags, readScopeFlagState, saveScopeTemplate } from "../../scopes/storage.js";
import { DEFAULT_SCOPE_TEMPLATES } from "../../scopes/presets/index.js";
import type { JsonObject } from "../storage.js";

export const MVP_PLATFORM_WORKFLOW_ID = "swf_mvp_platform";
export const GENERIC_ROOFING_TEMPLATE_ID = "generic_roofing";

// Main view: My Projects (stages, boards, project map), My Contacts, Feed.
// Project window: Photos, Customer Portal, Materials, Documents and Reports tabs;
// Agent, Notes, Activity and To Do trays. No Scheduling. Every other capability
// that needs expanded access is off; FirstMeasure's own keep their signup defaults.
const ENABLED = [
  "platform.expanded_access",
  "apps.projects",
  "apps.project_map",
  "platform.project_assignments",
  "platform.project_boards",
  "platform.project_stages_view",
  "platform.manual_project_stage_movement",
  "platform.contacts",
  "platform.project_photos",
  "photos.markup",
  "platform.photos_feed",
  "platform.customer_portal",
  "platform.customer_portal_media",
  "platform.materials",
  "platform.pricebook",
  "materials.ordering",
  "platform.documents",
  "documents.esign",
  "documents.agent",
  // Agent tray.
  "apps.assistant",
  // Notes tray: project notes run on channels. The Channels and Assistant
  // main-view tabs are hidden by placement below; the Messages tray stays off.
  "apps.channels",
  "channels.project_notes",
  "channels.separate_project_notes",
  "channels.threads",
  "channels.reactions",
  "channels.attachments",
  "channels.rich_messages",
  "channels.pins",
  "channels.search",
  // Full-house exterior FirstMeasure reports, and the 3D roof model for roof-only reports.
  "firstmeasure.exteriors",
  "firstmeasure.roof_model_viewer",
  // Top bar: global search and notifications (no header to-do list).
  "apps.notifications",
  "platform.top_bar",
  "topbar.global_search",
  "topbar.notifications"
];

export function appFlags(): JsonObject {
  const overrides: JsonObject = {};
  for (const capability of valueCapabilities()) {
    if (capability.type === "boolean" && capability.requires.includes("platform.expanded_access")) overrides[capability.key] = false;
  }
  for (const key of ENABLED) overrides[key] = true;
  return overrides;
}

export const workflow: JsonObject = {
  id: MVP_PLATFORM_WORKFLOW_ID,
  title: "MVP platform",
  description: "The FirstMeasure default signup plus the MVP platform: My Projects (with the project map), My Contacts and Feed; project Photos, Customer Portal, Materials, Documents and Reports; Agent, Notes, Activity and To Do trays. No Scheduling or calendar. Every project is a generic roof job.",
  entry_mode: "landing_first",
  // Raise when this file changes: the saved workflow is replaced with it on the next seed.
  configuration_revision: 4,
  sample_data: true,
  dev_bar: false,
  setup_scripts: ["mvp-platform"],
  stages: [
    { id: "stg_mvp_landing", page_id: "spg_firstmate_landing", notes: "Optional marketing front door." },
    { id: "stg_mvp_signup", page_id: "spg_firstmate_signup", notes: "Skipped by sandbox test instances." },
    { id: "stg_mvp_branding", page_id: "spg_firstmate_branding", notes: "" },
    { id: "stg_mvp_users", page_id: "spg_firstmate_users", notes: "Skipped on mobile in the real wizard." },
    { id: "stg_mvp_account_load", page_id: "spg_firstmate_account_load", notes: "" }
  ],
  tags: ["template", "firstmate", "mvp"]
};

export function defaults(): JsonObject {
  return {
    app_flags: appFlags(),
    // Channels and the Assistant are on for the Notes and Agent trays only.
    settings: { app_placements: { "portal.channels": "hidden", "portal.assistant": "hidden" } }
  };
}

const stage = (id: string, title: string, color: string, tasks: Array<[string, string]>, dependsOn?: string) => ({
  id,
  title,
  terminology_key: "work.stage",
  completion_mode: "all_children",
  ...(dependsOn ? { depends_on: [dependsOn] } : {}),
  metadata: { color },
  children: tasks.map(([taskId, taskTitle]) => ({ id: taskId, title: taskTitle, terminology_key: "work.task", actionable: true }))
});

/**
 * A simple roof job from first contact to completion: plain stages and to-dos,
 * no automations, sized from the roofing measurement schema. Lists, materials
 * and proposal settings come from the Roof Replacement preset so documents and
 * materials work the same way.
 */
export function genericRoofingTemplate(): JsonObject {
  const base = DEFAULT_SCOPE_TEMPLATES.find((definition) => definition.id === "roof_replacement") as unknown as JsonObject;
  const copy = JSON.parse(JSON.stringify(base)) as JsonObject;
  return {
    ...copy,
    id: GENERIC_ROOFING_TEMPLATE_ID,
    name: "Roofing",
    description: "A simple roof job from first contact to completion.",
    details: "Plain stages and to-dos you can rename, reorder and build on. Measurements use the roofing schema.",
    color: "#dc2626",
    icon: "fa-house",
    category_ids: ["production"],
    measurement_schema_ids: ["roofing"],
    work_plan: {
      title: "Roofing",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#dc2626", canceled_column: { id: "cancelled", title: "Cancelled", color: "#667085" } },
      root_nodes: [{
        id: "roofing_phase",
        title: "Roofing",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        children: [
          stage("new_stage", "New", "#667085", [["contact_customer", "Contact the customer"]]),
          stage("inspection_stage", "Inspection", "#0e7490", [["inspect_roof", "Inspect the roof"], ["take_photos", "Take photos"], ["record_measurements", "Record measurements"]], "new_stage"),
          stage("estimate_stage", "Estimate", "#7c3aed", [["prepare_estimate", "Prepare the estimate"], ["send_estimate", "Send the estimate"]], "inspection_stage"),
          stage("sold_stage", "Sold", "#16a34a", [["confirm_sale", "Confirm the sale"]], "estimate_stage"),
          stage("production_stage", "In production", "#ea580c", [["order_materials", "Order materials"], ["install_roof", "Install the roof"]], "sold_stage"),
          stage("complete_stage", "Complete", "#2563eb", [["final_walkthrough", "Final walkthrough"]], "production_stage")
        ]
      }]
    },
    metadata: { configuration: "mvp-platform" }
  };
}

/** Installs Generic Roofing, makes it every new project's scope and turns the other preset scopes off. */
export async function setup(orgId: string, branchId = "default") {
  await saveScopeTemplate(orgId, branchId, genericRoofingTemplate());
  const routing = await readIntakeRouting(orgId, branchId);
  await saveIntakeRouting(orgId, branchId, {
    expected_revision: routing.revision,
    data: { ...routing, routing_mode: "default", rules: [], default_entry: "scope", default_template_id: GENERIC_ROOFING_TEMPLATE_ID, manual_template_id: GENERIC_ROOFING_TEMPLATE_ID }
  });
  const others = (await listScopeTemplates(orgId, branchId, { include_disabled: true }))
    .map((template) => String(template.id))
    .filter((id) => id && id !== GENERIC_ROOFING_TEMPLATE_ID);
  const state = await readScopeFlagState(orgId, branchId);
  await patchScopeFlags(orgId, { expected_revision: state.revision, flags: { ...Object.fromEntries(others.map((id) => [id, false])), [GENERIC_ROOFING_TEMPLATE_ID]: true } }, branchId);
}
