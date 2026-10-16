/**
 * Every app a person can be given, and the devices each one exists on
 * (docs/architecture/app-experience.md).
 *
 * An app here is something a person opens: a tab in the portal, a view in a
 * project window or a view in a contact window. Whether a person sees it, and
 * on which device, is decided by App experience: the app's default, then their
 * roles, groups and departments, then their own setting. What they may do
 * inside it is decided by permissions, which the app reads for itself.
 *
 * An app is off for everyone while its organization switch (`capability`) is
 * off. `devices` lists where a version of the app exists; a person can never
 * be shown an app on a device it does not list.
 */
import { CREW_PERMISSION_KEYS, PAYROLL_PERMISSION_KEYS, SALES_PERMISSION_KEYS } from "../../workforce/permission-keys.js";
import { deviceTypeIds, type DeviceId } from "./devices.js";

export type AppSurface = "portal_tab" | "project_modal" | "contact_modal";
export type JsonObject = Record<string, unknown>;

/** A setting of an app that is not a permission, such as whether Today shows a time clock. */
export type AppOptionDefinition = {
  key: string;
  label: string;
  description: string;
  default: boolean;
  /** The app parameter the resolved value is passed to the app as. */
  param: string;
};

export type AppDefinition = {
  id: string;
  title: string;
  terminology_key?: string;
  description: string;
  icon: string;
  surface: AppSurface;
  order: number;
  /** Device types a version of this app exists on. */
  devices: DeviceId[];
  /** Shown to a person whose roles, groups, departments and own settings say nothing. */
  default_visible: boolean;
  /** The organization switch this app belongs to; any one being on is enough. */
  capabilities: string[];
  options: AppOptionDefinition[];
  default_params: JsonObject;
  /** App parameters that carry a permission of the viewer: param -> permission key. */
  parameter_permissions: Record<string, string>;
  layout: JsonObject;
  portal_tab_id?: string;
  default_home?: boolean;
};

const PROJECT_LAYOUT: JsonObject = {
  uses_left_column: false,
  left_column: "none",
  desktop_context_column: "standard",
  mobile_fullscreen: true,
  mobile_navigation: "icon_tabs"
};

const PORTAL_LAYOUT: JsonObject = {
  uses_left_column: false,
  left_column: "none",
  mobile_fullscreen: true,
  mobile_navigation: "icon_tabs"
};

const EVERY_DEVICE = "every";
const DESKTOP_ONLY = ["desktop"];

type AppSource = Omit<AppDefinition, "devices" | "capabilities" | "options" | "default_params" | "parameter_permissions" | "layout"> & {
  devices?: DeviceId[] | typeof EVERY_DEVICE;
  capabilities?: string[];
  options?: AppOptionDefinition[];
  default_params?: JsonObject;
  parameter_permissions?: Record<string, string>;
  layout?: JsonObject;
};

const tab = (id: string, title: string, icon: string, order: number, source: Partial<AppSource> = {}): AppSource => ({
  id, title, icon, order, surface: "portal_tab", description: "", default_visible: true,
  portal_tab_id: id.replace(/^portal\./, "").replace(/^documents\.studio$/, "documents_studio"), ...source
});
const projectView = (id: string, title: string, icon: string, order: number, source: Partial<AppSource> = {}): AppSource => ({
  id, title, icon, order, surface: "project_modal", description: "", default_visible: true, ...source
});
const contactView = (id: string, title: string, icon: string, order: number, source: Partial<AppSource> = {}): AppSource => ({
  id, title, icon, order, surface: "contact_modal", description: "", default_visible: true, ...source
});

const APP_SOURCE: AppSource[] = [
  // Portal tabs.
  tab("portal.viewer", "My Projects", "fa-briefcase", 10, { terminology_key: "projects.portal_tab", description: "The project workspace.", capabilities: ["apps.projects"] }),
  tab("portal.contacts", "My Contacts", "fa-address-book", 20, { terminology_key: "contacts.portal_tab", description: "Organization contacts and customer records.", capabilities: ["platform.contacts"] }),
  tab("portal.photos_feed", "Feed", "fa-images", 30, { terminology_key: "photos.portal_tab", description: "Recent project photos across the organization.", capabilities: ["platform.photos_feed"] }),
  tab("portal.proposals", "Proposals", "fa-file-signature", 40, { terminology_key: "proposals.portal_tab", description: "Organization-wide proposal workspace.", capabilities: ["platform.proposals"] }),
  tab("portal.channels", "Channels", "fa-comments", 44, { terminology_key: "channels.portal_tab", description: "Team channels and conversations.", capabilities: ["apps.channels"] }),
  tab("portal.assistant", "FirstMate Assistant", "fa-wand-magic-sparkles", 45, { terminology_key: "assistant.portal_tab", description: "The FirstMate assistant.", capabilities: ["apps.assistant"] }),
  tab("portal.chat", "Communications", "fa-inbox", 46, { terminology_key: "chat.portal_tab", description: "Calls, texts and live chat in one inbox.", capabilities: ["apps.comms"] }),
  tab("portal.scheduling", "Scheduling", "fa-calendar-days", 50, { terminology_key: "scheduling.portal_tab", description: "Organization scheduling and resource planning.", capabilities: ["platform.scheduling"] }),
  tab("portal.invoices", "Invoices", "fa-file-invoice-dollar", 51, { terminology_key: "invoices.portal_tab", description: "Outstanding invoices, aging, projects that still need billing, and invoice sending.", capabilities: ["money.invoices"], default_visible: false, default_params: { invoicesView: "outstanding" } }),
  tab("portal.financials", "Financials", "fa-chart-line", 52, { terminology_key: "financials.portal_tab", description: "Project profitability, revenue history, obligations, and cash flow forecasts.", capabilities: ["money.profitability"], default_visible: false, default_params: { financialView: "projects", financialGrain: "month" } }),
  tab("portal.stats", "Stats", "fa-chart-column", 53, { terminology_key: "stats.portal_tab", description: "Sales and production statistics.", capabilities: ["apps.stats"] }),
  tab("portal.payroll", "Payroll", "fa-money-check-dollar", 55, { terminology_key: "payroll.portal_tab", description: "Upcoming payroll, projections, pay runs, commissions, and payment history.", capabilities: ["apps.payroll"], default_visible: false }),
  tab("portal.feedback", "Feedback", "fa-star", 56, { terminology_key: "feedback.portal_tab", description: "Customer feedback and ratings.", capabilities: ["apps.feedback"] }),
  tab("portal.equipment", "Equipment", "fa-truck-pickup", 57, { terminology_key: "equipment.portal_tab", description: "Equipment, its use and its upkeep.", capabilities: ["apps.equipment"] }),
  tab("portal.training", "Training", "fa-graduation-cap", 58, { terminology_key: "training.portal_tab", description: "Courses assigned to you.", capabilities: ["apps.training"] }),
  tab("portal.training_studio", "Training Studio", "fa-chalkboard-user", 59, { terminology_key: "training.studio_portal_tab", description: "Build and assign training courses.", capabilities: ["training.studio"], devices: DESKTOP_ONLY }),
  tab("portal.partners", "Partners", "fa-handshake", 60, { terminology_key: "partners.partners", description: "Partner companies and shared work.", capabilities: ["platform.collaboration"] }),
  tab("portal.canvassing", "Canvassing", "fa-map-location-dot", 70, { terminology_key: "canvassing.portal_tab", description: "Canvassing maps and door-to-door activity.", capabilities: ["canvassing.app"] }),
  tab("documents.studio", "Doc Studio", "fa-pen-ruler", 72, { terminology_key: "document_engine.studio_tab", description: "Design document templates.", capabilities: ["documents.templates_studio"], devices: DESKTOP_ONLY }),
  tab("portal.web_editor", "Web Editor", "fa-globe", 74, { terminology_key: "web_editor.tab", description: "Edit the company website.", capabilities: ["apps.web_editor"], devices: DESKTOP_ONLY }),
  tab("portal.receipts", "Receipts", "fa-receipt", 76, { terminology_key: "receipts.portal_tab", description: "Upload job receipts.", capabilities: ["crew.receipts"], default_visible: false }),
  tab("portal.company_settings", "Settings", "fa-gear", 80, { terminology_key: "settings.portal_tab", description: "Company configuration, people and integrations." }),
  tab("portal.crew_overview", "Today", "fa-house", 10, {
    terminology_key: "crew.today_portal_tab", description: "Today's assigned work, overdue work, and shift controls.", capabilities: ["apps.crew"], default_visible: false, default_home: true,
    default_params: { mode: "crew", variant: "crew" },
    options: [{ key: "time_clock", label: "Time clock", description: "Clock in and out from Today. For people paid by the hour.", default: false, param: "time_clock_enabled" }],
    layout: PORTAL_LAYOUT
  }),
  tab("portal.crew_schedule", "Schedule", "fa-calendar-days", 20, { terminology_key: "scheduling.crew_portal_tab", description: "Past and upcoming work assigned to you.", capabilities: ["apps.crew"], default_visible: false, default_params: { mode: "crew", variant: "mobile_crew", assignment_scope: "mine" }, layout: PORTAL_LAYOUT }),
  tab("portal.crew_receipts", "Receipts", "fa-receipt", 30, {
    terminology_key: "receipts.crew_portal_tab", description: "Upload job receipts and review their extraction status.", capabilities: ["crew.receipts"], default_visible: false,
    default_params: { mode: "crew", assignment_scope: "mine", can_upload: false, can_request_reimbursement: false },
    parameter_permissions: { can_upload: CREW_PERMISSION_KEYS.receipts_upload, can_request_reimbursement: CREW_PERMISSION_KEYS.reimbursements_request },
    layout: PORTAL_LAYOUT
  }),
  tab("portal.crew_payouts", "Earnings", "fa-wallet", 40, {
    terminology_key: "earnings.crew_portal_tab", description: "Your owed, projected and paid earnings by project.", capabilities: ["payroll.self_service_earnings"], default_visible: false,
    default_params: { mode: "crew", subject_scope: "mine", projected_enabled: false },
    parameter_permissions: { projected_enabled: PAYROLL_PERMISSION_KEYS.view_own_projected_earnings },
    layout: PORTAL_LAYOUT
  }),
  tab("portal.sales_overview", "Today", "fa-house", 10, {
    terminology_key: "sales.today_portal_tab", description: "Today's sales appointments, follow-ups, and pipeline pulse.", capabilities: ["apps.sales"], default_visible: false, default_home: true,
    default_params: { mode: "sales", show_pipeline_pulse: true, can_manage_followups: false },
    parameter_permissions: { can_manage_followups: SALES_PERMISSION_KEYS.followups_manage },
    layout: PORTAL_LAYOUT
  }),
  tab("portal.sales_schedule", "Schedule", "fa-calendar-days", 20, { terminology_key: "scheduling.sales_portal_tab", description: "Past and upcoming sales appointments.", capabilities: ["apps.sales"], default_visible: false, default_params: { mode: "sales", assignment_scope: "mine" }, layout: PORTAL_LAYOUT }),
  tab("portal.sales_earnings", "Earnings", "fa-wallet", 30, { terminology_key: "earnings.sales_portal_tab", description: "Your commission earnings: pending, paid, and per deal.", capabilities: ["payroll.self_service_earnings"], default_visible: false, default_params: { mode: "sales", subject_scope: "mine", presentation: "commissions", projected_enabled: false }, parameter_permissions: { projected_enabled: PAYROLL_PERMISSION_KEYS.view_own_projected_earnings }, layout: PORTAL_LAYOUT }),

  // Project window views.
  projectView("project.map", "Project Overview", "fa-map-location-dot", 10, { terminology_key: "projects.overview_tab", description: "Project overview, property, and map details.", capabilities: ["apps.project_map"] }),
  projectView("project.photos", "Project Photos", "fa-images", 20, { terminology_key: "photos.project_tab", description: "Photos associated with the project.", capabilities: ["platform.project_photos"] }),
  projectView("project.proposal", "Project Proposals", "fa-file-signature", 30, { terminology_key: "proposals.project_tab", description: "Proposals and customer approvals for the project.", capabilities: ["platform.proposals"] }),
  projectView("project.docs", "Project Docs", "fa-folder-open", 40, { terminology_key: "documents.project_tab", description: "Documents associated with the project.", capabilities: ["platform.project_docs", "platform.documents"] }),
  projectView("project.documents", "Documents", "fa-file-signature", 42, { terminology_key: "document_engine.project_tab", description: "Documents built from templates for the project.", capabilities: ["platform.documents"] }),
  projectView("project.materials", "Scope", "fa-clipboard-list", 50, { terminology_key: "scope.project_tab", description: "Project scope, materials, and expense projections.", capabilities: ["platform.materials"] }),
  projectView("project.money", "Money", "fa-dollar-sign", 60, { terminology_key: "money.project_tab", description: "Project financials, payments, expenses, and profitability.", capabilities: ["platform.money"] }),
  projectView("project.comms", "Comms", "fa-comments", 65, { terminology_key: "comms.project_tab", description: "Calls, texts and email with the customer.", capabilities: ["apps.comms"] }),
  projectView("project.customer_portal", "Customer Portal", "fa-user-lock", 70, { terminology_key: "customer_portal.project_tab", description: "Customer-facing project portal configuration and preview.", capabilities: ["platform.customer_portal"] }),
  projectView("project.schedule", "Project Schedule", "fa-calendar-days", 80, { terminology_key: "scheduling.project_tab", description: "Scheduling and assigned work for this project.", capabilities: ["platform.scheduling"] }),
  projectView("project.measurements", "Reports", "fa-ruler-combined", 90, { terminology_key: "reports.project_tab", description: "Measurements and report ordering for this project.", capabilities: ["apps.firstmeasure"] }),
  projectView("project.checklists", "Checklists", "fa-list-check", 95, { terminology_key: "checklists.project_tab", description: "Review and manage every checklist for this project, including who completed each item.", capabilities: ["apps.checklists"], default_params: { mode: "manage" } }),
  projectView("project.crew_overview", "Visit", "fa-house", 10, { terminology_key: "crew.overview_tab", description: "The workflow for a scheduled visit.", capabilities: ["apps.crew"], default_visible: false, default_home: true, default_params: { mode: "crew" }, layout: PROJECT_LAYOUT }),
  projectView("project.sales_overview", "Sales Visit", "fa-house", 11, { terminology_key: "sales.overview_tab", description: "Customer, appointments, follow-ups, and notes for a sale.", capabilities: ["apps.sales"], default_visible: false, default_home: true, default_params: { mode: "sales" }, layout: PROJECT_LAYOUT }),
  projectView("project.field_customer", "Customer", "fa-address-card", 15, { terminology_key: "contacts.field_customer_tab", description: "Customer contact information, property address, and project notes.", default_visible: false, layout: PROJECT_LAYOUT }),
  projectView("project.crew_materials", "Materials", "fa-boxes-stacked", 20, {
    terminology_key: "materials.crew_project_tab", description: "View deliveries and add materials by hand or from a receipt.", capabilities: ["platform.materials"], default_visible: false,
    default_params: { mode: "crew", can_append: false, can_upload_receipt: false },
    parameter_permissions: { can_append: CREW_PERMISSION_KEYS.materials_append, can_upload_receipt: CREW_PERMISSION_KEYS.receipts_upload },
    layout: PROJECT_LAYOUT
  }),
  projectView("project.crew_payouts", "Earnings", "fa-wallet", 30, {
    terminology_key: "earnings.crew_project_tab", description: "Your earnings for this project.", capabilities: ["payroll.self_service_earnings"], default_visible: false,
    default_params: { mode: "crew", subject_scope: "mine", projected_enabled: false },
    parameter_permissions: { projected_enabled: PAYROLL_PERMISSION_KEYS.view_own_projected_earnings },
    layout: PROJECT_LAYOUT
  }),
  projectView("project.crew_payments", "Payments", "fa-credit-card", 40, {
    terminology_key: "payments.crew_project_tab", description: "Project balances and on-site payments.", capabilities: ["crew.field_payments"], default_visible: false,
    default_params: { mode: "crew", can_take_payment: false },
    parameter_permissions: { can_take_payment: CREW_PERMISSION_KEYS.payments_take },
    layout: PROJECT_LAYOUT
  }),
  projectView("project.crew_change_orders", "Change Orders", "fa-file-signature", 50, {
    terminology_key: "change_orders.crew_project_tab", description: "Review, prepare, sign and collect change orders.", capabilities: ["crew.change_orders"], default_visible: false,
    default_params: { mode: "crew", can_manage: false },
    parameter_permissions: { can_manage: CREW_PERMISSION_KEYS.change_orders_manage },
    layout: PROJECT_LAYOUT
  }),
  projectView("project.crew_checklists", "My Checklists", "fa-list-check", 60, {
    terminology_key: "checklists.crew_project_tab", description: "Complete assigned checklists and quality reviews.", capabilities: ["apps.checklists"], default_visible: false,
    default_params: { mode: "complete", can_complete: false, can_manage: false, can_supervise: false },
    parameter_permissions: { can_complete: CREW_PERMISSION_KEYS.checklists_complete, can_manage: CREW_PERMISSION_KEYS.checklists_manage, can_supervise: CREW_PERMISSION_KEYS.checklists_supervise },
    layout: PROJECT_LAYOUT
  }),
  projectView("project.crew_signatures", "Work", "fa-diagram-project", 70, { terminology_key: "signatures.crew_project_tab", description: "Project workflows, customer actions, and added work.", default_visible: false, default_params: { mode: "present" }, layout: PROJECT_LAYOUT }),

  // Contact window views.
  contactView("contact.projects", "Contact Projects", "fa-briefcase", 10, { description: "The contact's projects.", capabilities: ["platform.contacts"] }),
  contactView("contact.media", "Contact Photos & Media", "fa-images", 20, { description: "Photos and media across the contact's projects.", capabilities: ["platform.contacts"] }),
  contactView("contact.docs", "Contact Docs", "fa-folder-open", 30, { description: "Documents across the contact's projects.", capabilities: ["platform.contacts"] })
];

function buildDefinition(source: AppSource): AppDefinition {
  const devices = source.devices === EVERY_DEVICE || !source.devices ? deviceTypeIds() : [...source.devices];
  return {
    ...source,
    devices,
    capabilities: [...(source.capabilities || [])],
    options: (source.options || []).map((option) => ({ ...option })),
    default_params: { ...(source.default_params || {}) },
    parameter_permissions: { ...(source.parameter_permissions || {}) },
    layout: { ...(source.layout || {}) }
  };
}

/** Every app, as a fresh copy the caller may change. */
export function appDefinitions(): AppDefinition[] {
  return APP_SOURCE.map(buildDefinition);
}

export function appDefinition(id: string): AppDefinition | undefined {
  const source = APP_SOURCE.find((entry) => entry.id === id);
  return source ? buildDefinition(source) : undefined;
}

export function appIds() {
  return APP_SOURCE.map((entry) => entry.id);
}

export function canonicalAppId(value: unknown) {
  const id = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return id;
}
