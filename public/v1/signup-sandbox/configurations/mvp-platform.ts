// The MVP platform configuration: the FirstMeasure signup plus a small, explicit
// set of platform apps, with every project a simple roof job. Everything that
// makes this configuration what it is lives in this file: the workflow, its
// flags and placements, and the setup script that installs its scope. The
// platform never checks for it; the sandbox only runs the setup scripts a
// workflow names (configurations/index.ts).
import { valueCapabilities } from "../../platform/capabilities.js";
// Capabilities that modules register as a side effect. appFlags() turns off every expanded-access capability it can
// see, so these must be registered first whichever process seeds the workflow; without them Communications (apps.comms
// defaults on) and the assistant's actions were left on in revision 14.
import "../../platform/capability_defs.js";
import "../../assistant/capabilities.js";
import "../../comms/capabilities.js";
import "../../chat/capabilities.js";
import { readBranchModule, saveBranchModule } from "../../platform/storage.js";
import { listAccessRoles, patchAccessRole } from "../../workforce/access.js";
import { saveIntakeRouting, readIntakeRouting } from "../../scopes/router.js";
import { listScopeTemplates, patchScopeFlags, readScopeFlagState, readScopeTemplate, saveScopeTemplate } from "../../scopes/storage.js";
import { libraryCopy } from "../../config-library/library.js";
import type { JsonObject } from "../storage.js";

export const MVP_PLATFORM_WORKFLOW_ID = "swf_mvp_platform";
export const GENERIC_ROOFING_TEMPLATE_ID = "generic_roofing";

// Main view: My Projects (stages, boards, project map), My Contacts, Feed, and Financials (offered).
// Project window: Photos, Docs, Operations and Customer Portal tabs, with Money and Checklists offered; no Overview or
// Reports tab (the project details tray holds the project and its measurements). Agent, Notes, Activity and To Do
// trays. No Scheduling. Every other capability that needs expanded access is off; FirstMeasure's own keep their
// signup defaults.
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
  "apps.equipment",
  "platform.pricebook",
  "materials.ordering",
  "platform.documents",
  "documents.esign",
  "documents.agent",
  // Money and Checklists are configured on and start as offers (APP_OFFERS below): each tab shows its advertisement
  // until someone chooses Get Started. Money's Get Started continues into its setup, which begins with payments
  // onboarding. Merchant processing stays off (DISABLED) until that setup starts it, so no payments onboarding banner
  // or notification appears before then (payments/onboarding_attention.ts).
  "platform.money",
  "money.profitability",
  "money.payment_schedules",
  "money.take_payment",
  "money.expenses",
  "apps.checklists",
  "checklists.templates",
  "checklists.supervision",
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
  "topbar.notifications",
  // Temporarily on for testing (Jack, 2026-10-25): groups of users and outside companies (People, and the price book
  // setup's "Who does your labor?" step, which needs them). Turn these off again for the real MVP.
  "apps.crew",
  "platform.people_access"
];

// Off for the MVP although on by default: Materials settings has no Resource categories sub-tab (Jack, 2026-10-25).
// Report follow-up (the Reports tab's Support view) is off by default too; it is named here so the MVP keeps it off
// whatever the default becomes, as the FirstMeasure signup does (Jack, 2026-10-26).
const DISABLED = [
  "money.merchant_processing",
  "topbar.messages",
  "materials.resource_categories",
  "firstmeasure.report_followup"
];

export function appFlags(): JsonObject {
  const overrides: JsonObject = {};
  for (const capability of valueCapabilities()) {
    if (capability.type === "boolean" && capability.requires.includes("platform.expanded_access")) overrides[capability.key] = false;
  }
  for (const key of ENABLED) overrides[key] = true;
  for (const key of DISABLED) overrides[key] = false;
  // The New button opens a menu: Report first, then Project and Contact.
  overrides["platform.new_button_mode"] = "selector";
  overrides["platform.new_button_items"] = "report,project,contact";
  // The account sits on its own row at the bottom of the left column, the other launchers above it (Jack, 2026-10-26).
  overrides["platform.sidebar_footer_layout"] = "stacked";
  return overrides;
}

export const workflow: JsonObject = {
  id: MVP_PLATFORM_WORKFLOW_ID,
  title: "MVP platform",
  description: "The FirstMeasure default signup plus the MVP platform: My Projects (with the project map), My Contacts, Feed and Financials (offered); project tabs Photos, Docs, Operations and Customer Portal, with Money and Checklists offered (no Overview or Reports tab: the project details tray holds them); Agent, Notes, Activity and To Do trays. No Scheduling or calendar. Every project is a generic roof job.",
  entry_mode: "landing_first",
  // Raise when this file changes: the saved workflow is replaced with it on the next seed.
  configuration_revision: 22,
  sample_data: true,
  // A launched test instance starts empty: sample projects and customers come only from "Add sample data" in the
  // development tools (Jack, 2026-10-26). An empty list, not a missing one, so the revision replaces a saved list.
  launch_sample_data: [],
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
// (docs/architecture/project-tab-guides.md). The window opens on the first tab, Photos. Overview and Reports are not
// tabs here (ROLE_APP_OPTIONS); offered apps show "New" while offered.
export const PROJECT_TABS = {
  order: ["project.photos", "project.docs", "project.materials", "project.customer_portal", "project.money", "project.checklists"],
  pills: { "project.photos": "new", "project.docs": "new", "project.materials": "new", "project.customer_portal": "new" }
};
// The Project tab (scope.project_tab) is called Operations here, and the Customer Portal tab Portal.
export const TERMINOLOGY = { scope: { project_tab: "Operations" }, customer_portal: { project_tab: "Portal" } };

// The apps this configuration starts as offers: the platform's own new-organization offers plus Money (its project tab
// and Financials page, one app) and Checklists. Written after the demo content is seeded (signup-sandbox/service.ts).
export const APP_OFFERS = [
  "project.photos", "project.docs", "project.customer_portal", "project.materials", "portal.equipment",
  "project.money", "portal.financials", "project.checklists"
];

export function defaults(): JsonObject {
  return {
    app_flags: appFlags(),
    // Channels and the Assistant are on for the Notes and Agent trays only.
    settings: { app_placements: { "portal.channels": "hidden", "portal.assistant": "hidden" }, project_tabs: PROJECT_TABS, app_offers: APP_OFFERS }
  };
}

// App options every role gets here: My Projects opens on the map, with Map first among its views; Overview and Reports
// are not project window tabs (the project details tray holds the project and its measurements, and Overview's map is
// still where a report order's pins are placed).
export const ROLE_APP_OPTIONS: Record<string, Record<string, boolean>> = {
  "portal.viewer": { map_first: true },
  "project.map": { tab: false },
  "project.measurements": { tab: false }
};

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
  // The scope library's Roof Replacement, without its place in the library list.
  const { sort_order: _sortOrder, ...copy } = libraryCopy<JsonObject>("scope_template", "roof_replacement") || {};
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
