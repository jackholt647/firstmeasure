// The MVP platform configuration: the FirstMeasure signup plus a small, explicit
// set of platform apps, with every project a simple roof job. Everything that
// makes this configuration what it is lives in this file: the workflow, its
// flags and placements, and the setup script that installs its scope. The
// platform never checks for it; the sandbox only runs the setup scripts a
// workflow names (configurations/index.ts).
import { valueCapabilities } from "../../platform/capabilities.js";
import { readBranchModule, saveBranchModule } from "../../platform/storage.js";
import { listAccessRoles, patchAccessRole } from "../../workforce/access.js";
import { saveIntakeRouting, readIntakeRouting } from "../../scopes/router.js";
import { listScopeTemplates, patchScopeFlags, readScopeFlagState, readScopeTemplate, saveScopeTemplate } from "../../scopes/storage.js";
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
  // The Apps launcher, opening the apps overlay with pins, view roll-outs and drag-to-pin.
  "platform.more_apps",
  "platform.advanced_app_menu",
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
  // The New button opens a menu: Report first, then Project and Contact.
  overrides["platform.new_button_mode"] = "selector";
  overrides["platform.new_button_items"] = "report,project,contact";
  return overrides;
}

export const workflow: JsonObject = {
  id: MVP_PLATFORM_WORKFLOW_ID,
  title: "MVP platform",
  description: "The FirstMeasure default signup plus the MVP platform: My Projects (with the project map), My Contacts and Feed; project tabs Overview, Reports, Photos (New), Docs (New), Materials and Customer Portal; Agent, Notes, Activity and To Do trays. No Scheduling or calendar. Every project is a generic roof job.",
  entry_mode: "landing_first",
  // Raise when this file changes: the saved workflow is replaced with it on the next seed.
  configuration_revision: 12,
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

// The project window's tabs, in order; Photos and Docs carry a "New" pill until each person first opens them
// (docs/architecture/project-tab-guides.md).
export const PROJECT_TABS = {
  order: ["project.map", "project.measurements", "project.photos", "project.docs", "project.materials", "project.customer_portal"],
  pills: { "project.photos": "new", "project.docs": "new", "project.materials": "new", "project.customer_portal": "new" }
};
// The Project tab (scope.project_tab) is called Materials here, and the Customer Portal tab Portal.
export const TERMINOLOGY = { scope: { project_tab: "Materials" }, customer_portal: { project_tab: "Portal" } };

export function defaults(): JsonObject {
  return {
    app_flags: appFlags(),
    // Channels and the Assistant are on for the Notes and Agent trays only.
    settings: { app_placements: { "portal.channels": "hidden", "portal.assistant": "hidden" }, project_tabs: PROJECT_TABS }
  };
}

// App options every role gets here: My Projects opens on the map, with Map first among its views.
export const ROLE_APP_OPTIONS: Record<string, Record<string, boolean>> = { "portal.viewer": { map_first: true } };

/** Adds this configuration's app options to every active role, keeping anything a role already sets. */
async function applyRoleAppOptions(orgId: string) {
  for (const role of await listAccessRoles(orgId)) {
    if ((role as JsonObject).status === "archived") continue;
    const current = ((role as JsonObject).app_defaults || {}) as Record<string, JsonObject>;
    const next: Record<string, JsonObject> = { ...current };
    let changed = false;
    for (const [appId, options] of Object.entries(ROLE_APP_OPTIONS)) {
      const setting = (next[appId] || {}) as JsonObject;
      const existing = (setting.options || {}) as Record<string, boolean>;
      const missing = Object.entries(options).filter(([key]) => !(key in existing));
      if (!missing.length) continue;
      next[appId] = { ...setting, options: { ...existing, ...Object.fromEntries(missing) } };
      changed = true;
    }
    if (changed) await patchAccessRole(orgId, String((role as JsonObject).id), { expected_revision: (role as JsonObject).revision, app_defaults: next });
  }
}

/** Writes this configuration's terminology, keeping any label the organization already chose. */
async function applyTerminology(orgId: string, branchId: string) {
  const current = await readBranchModule(orgId, branchId, "variable_mappings").catch(() => null);
  const data = (current?.data && typeof current.data === "object" ? current.data : {}) as JsonObject;
  const labels = (data.labels && typeof data.labels === "object" ? data.labels : {}) as Record<string, Record<string, string>>;
  const next: Record<string, Record<string, string>> = { ...labels };
  let changed = false;
  for (const [namespace, terms] of Object.entries(TERMINOLOGY)) {
    for (const [key, label] of Object.entries(terms)) {
      if (next[namespace]?.[key]) continue;
      next[namespace] = { ...(next[namespace] || {}), [key]: label };
      changed = true;
    }
  }
  if (changed) await saveBranchModule(orgId, branchId, "variable_mappings", { data: { ...data, labels: next } }, { replace: false });
}

// What happens on a project, in order, as the platform publishes it (work/events.ts). Each milestone moves the project
// into the stage named after it.
const milestones = {
  report_ordered: [{ id: "report_ordered", event: "measurement.report.ordered" }],
  report_delivered: [{ id: "report_delivered", event: "measurement.report.completed" }],
  proposal_created: [
    { id: "proposal_document", event: "document.created", conditions: { "payload.document_type": "proposal" } },
    { id: "proposal", event: "proposal.created" }
  ],
  materials_created: [{ id: "materials_created", event: "material.lines.created" }]
};
type Milestone = keyof typeof milestones;
const ORDER: Milestone[] = ["report_ordered", "report_delivered", "proposal_created", "materials_created"];

/**
 * A stage with one to-do. The to-do is finished by the milestone that ends the stage or by any later one, so a
 * project that skips ahead (a proposal before the report) lands on the furthest stage it has reached; a finished
 * to-do is never reopened, so a milestone that comes late never moves a project back.
 */
const stage = (id: string, title: string, color: string, [taskId, taskTitle]: [string, string], endsWith?: Milestone, dependsOn?: string) => {
  const triggers = endsWith ? ORDER.slice(ORDER.indexOf(endsWith)).flatMap((milestone) => milestones[milestone].map((trigger) => ({
    ...trigger,
    transition: "completed",
    explainer: milestone === endsWith ? "Done when this happens on the project." : "A later step happened first, so this one is done too."
  }))) : [];
  return {
    id,
    title,
    terminology_key: "work.stage",
    completion_mode: "all_children",
    ...(dependsOn ? { depends_on: [dependsOn] } : {}),
    metadata: { color },
    children: [{ id: taskId, title: taskTitle, terminology_key: "work.task", actionable: true, ...(triggers.length ? { external_triggers: triggers } : {}) }]
  };
};

/**
 * A roof job whose board follows the report and the documents: New project, Measurements ordered, Measurements received,
 * Proposal created, Materials created. Each stage has one to-do that the next milestone finishes by itself (ordering
 * the report, its delivery, the first proposal, the first materials); ticking it by hand or moving the card does the
 * same. Sized from the roofing measurement schema. Lists, materials and proposal settings come from the Roof
 * Replacement preset so documents and materials work the same way.
 */
export function genericRoofingTemplate(): JsonObject {
  const base = DEFAULT_SCOPE_TEMPLATES.find((definition) => definition.id === "roof_replacement") as unknown as JsonObject;
  const copy = JSON.parse(JSON.stringify(base)) as JsonObject;
  return {
    ...copy,
    id: GENERIC_ROOFING_TEMPLATE_ID,
    name: "Roofing",
    description: "A roof job that moves through its stages as the report and documents are made.",
    details: "New project, Measurements ordered, Measurements received, Proposal created and Materials created. Each stage's to-do finishes itself when the next step happens; you can also tick it or move the card by hand. Measurements use the roofing schema.",
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
          stage("new_project", "New project", "#667085", ["order_report", "Order measurements"], "report_ordered"),
          stage("report_ordered", "Measurements ordered", "#0e7490", ["receive_report", "Receive the measurements"], "report_delivered", "new_project"),
          stage("report_delivered", "Measurements received", "#7c3aed", ["create_proposal", "Create the proposal"], "proposal_created", "report_ordered"),
          stage("proposal_created", "Proposal created", "#ea580c", ["create_materials", "Create the materials"], "materials_created", "report_delivered"),
          stage("materials_created", "Materials created", "#16a34a", ["review_materials", "Review the materials"], undefined, "proposal_created")
        ]
      }]
    },
    metadata: { configuration: "mvp-platform" }
  };
}

/**
 * Installs Generic Roofing, makes it every new project's scope and turns the other preset scopes off. An organization
 * that already has Generic Roofing (installed from an earlier revision, or edited since) keeps its own.
 */
export async function setup(orgId: string, branchId = "default") {
  const installed = await readScopeTemplate(orgId, branchId, GENERIC_ROOFING_TEMPLATE_ID).catch(() => null);
  if (!installed) await saveScopeTemplate(orgId, branchId, genericRoofingTemplate());
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
  await applyTerminology(orgId, branchId);
  await applyRoleAppOptions(orgId);
}
