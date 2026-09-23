import { randomBytes } from "node:crypto";

import { badRequest, conflict, notFound } from "../platform/errors.js";
import { getWorkforceDatabase, readCompensationProfile } from "./storage.js";

export type JsonObject = Record<string, unknown>;
export type AccessDevice = "desktop" | "mobile";
export type AccessSurface = "portal_tab" | "project_modal";
export type PermissionMap = Record<string, boolean>;

export const ACCESS_SCHEMA_VERSION = 1;
export const MANAGEMENT_APPLICATION_ID = "management";
export const FIELD_APPLICATION_ID = "field";

export const DEFAULT_ACCESS_ROLE_IDS = Object.freeze({
  management: Object.freeze({
    viewer: "viewer",
    manager: "manager",
    admin: "admin",
    super_admin: "super_admin"
  }),
  field: Object.freeze({
    crew_member: "crew_member",
    crew_foreman: "crew_foreman",
    supervisor: "supervisor",
    repairman: "repairman",
    salesperson: "salesperson"
  })
});

export const CREW_PERMISSION_KEYS = Object.freeze({
  dashboard_view: "crew.dashboard.view",
  projects_view: "crew.projects.view",
  projects_view_all_production: "crew.projects.view_all_production",
  schedule_view: "crew.schedule.view",
  time_clock_use: "crew.time_clock.use",
  receipts_upload: "crew.receipts.upload",
  reimbursements_request: "crew.reimbursements.request",
  materials_view: "crew.materials.view",
  materials_append: "crew.materials.append",
  payouts_view: "crew.payouts.view",
  checklists_view: "crew.checklists.view",
  checklists_complete: "crew.checklists.complete",
  payments_view: "crew.payments.view",
  payments_take: "crew.payments.take",
  signatures_present: "crew.signatures.present",
  workflows_add: "crew.workflows.add",
  change_orders_view: "crew.change_orders.view",
  change_orders_manage: "crew.change_orders.manage",
  checklists_manage: "crew.checklists.manage",
  checklists_supervise: "crew.checklists.supervise"
});

export const SALES_PERMISSION_KEYS = Object.freeze({
  dashboard_view: "sales.dashboard.view",
  schedule_view: "sales.schedule.view",
  followups_manage: "sales.followups.manage",
  earnings_view: "sales.earnings.view",
  documents_view_status: "sales.documents.view_status",
  money_view_status: "sales.money.view_status",
  stats_view_own: "sales.stats.view_own",
  stats_view_team: "sales.stats.view_team"
});

export type AccessRoleAppDefault = {
  enabled: boolean;
  params: JsonObject;
  layout: JsonObject;
};

export type AccessRole = {
  id: string;
  organization_id: string;
  application_id: string;
  application_ids: string[];
  name: string;
  description: string;
  status: "active" | "archived";
  is_system: boolean;
  system_key: string;
  permissions: PermissionMap;
  app_defaults: Record<string, AccessRoleAppDefault>;
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string;
};

export type AccessRoleCreateInput = {
  id?: string;
  application_id?: string;
  application_ids?: unknown;
  application?: string;
  name: string;
  description?: string;
  permissions?: unknown;
  permission_defaults?: unknown;
  app_defaults?: unknown;
  apps?: unknown;
  metadata?: unknown;
};

export type AccessRolePatchInput = Partial<AccessRoleCreateInput> & {
  expected_revision: number;
  status?: "active" | "archived";
};

export type AccessCatalogEntry = {
  id: string;
  runtime_app_id?: string;
  application_id: typeof MANAGEMENT_APPLICATION_ID | typeof FIELD_APPLICATION_ID;
  application?: typeof MANAGEMENT_APPLICATION_ID | typeof FIELD_APPLICATION_ID;
  title: string;
  label?: string;
  description: string;
  icon: string;
  surface: AccessSurface;
  kind: "portal_tab" | "project_modal_app";
  order: number;
  devices: AccessDevice[];
  required_permissions: string[];
  permission_mode: "all" | "any";
  default_params: JsonObject;
  parameter_permissions: Record<string, string>;
  layout: JsonObject;
  portal_tab_id?: string;
  default_home?: boolean;
  default_enabled?: boolean;
};

export type EffectiveAppEntitlement = AccessCatalogEntry & {
  allowed: boolean;
  enabled: boolean;
  application_enabled: boolean;
  permission_allowed: boolean;
  device_allowed: boolean;
  source: "catalog_default" | "role_default" | "user_override";
  sources: {
    application: string;
    visibility: "catalog_default" | "role_default" | "user_override";
    role_ids: string[];
  };
  params: JsonObject;
  layout: JsonObject;
  reasons: string[];
};

export type ResolvedApplicationAccess = {
  enabled: boolean;
  role_id: string;
  role_ids: string[];
  permissions: PermissionMap;
  app_overrides: Record<string, AccessRoleAppDefault>;
};

export type ResolvedAccessProfile = {
  schema_version: number;
  organization_id: string;
  user_id: string;
  access_role_ids: string[];
  unresolved_access_role_ids: string[];
  roles: AccessRole[];
  permissions: PermissionMap;
  effective_permissions: PermissionMap;
  application_access: Record<string, ResolvedApplicationAccess>;
  app_entitlements: EffectiveAppEntitlement[];
  app_entitlements_by_id: Record<string, EffectiveAppEntitlement>;
  app_catalog: EffectiveAppEntitlement[];
  allowed_app_ids: string[];
  user_revision: number;
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

const MANAGEMENT_APP_CATALOG_SOURCE: AccessCatalogEntry[] = [
  {
    id: "portal.viewer",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "My Projects",
    description: "The primary management project workspace.",
    icon: "fa-briefcase",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "viewer",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.contacts",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "My Contacts",
    description: "Organization contacts and customer records.",
    icon: "fa-address-book",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "contacts",
    order: 20,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.photos_feed",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Feed",
    description: "Recent project photos across the organization.",
    icon: "fa-images",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "photos_feed",
    order: 30,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.proposals",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Proposals",
    description: "Organization-wide proposal workspace.",
    icon: "fa-file-signature",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "proposals",
    order: 40,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.scheduling",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Scheduling",
    description: "Organization scheduling and resource planning.",
    icon: "fa-calendar-days",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "scheduling",
    order: 50,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.invoices",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Invoices",
    description: "Outstanding invoices, aging, projects that still need billing, and one-click invoice send.",
    icon: "fa-file-invoice-dollar",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "invoices",
    order: 51,
    devices: ["mobile", "desktop"],
    required_permissions: ["manage_projects", "manage_payroll", "manage_company_settings"],
    permission_mode: "any",
    default_params: { invoicesView: "outstanding" },
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.financials",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Financials",
    description: "Project profitability, revenue history, obligations, and schedule-aware cash flow forecasts.",
    icon: "fa-chart-line",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "financials",
    order: 52,
    devices: ["mobile", "desktop"],
    required_permissions: ["manage_projects", "manage_payroll", "manage_company_settings"],
    permission_mode: "any",
    default_params: { financialView: "projects", financialGrain: "month" },
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.payroll",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Payroll",
    description: "Upcoming payroll, projections, pay runs, commissions, and payment history.",
    icon: "fa-money-check-dollar",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "payroll",
    order: 55,
    devices: ["mobile", "desktop"],
    required_permissions: ["manage_payroll", "manage_company_settings"],
    permission_mode: "any",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.calls",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Calls",
    description: "Calling activity and communication workflows.",
    icon: "fa-phone",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "calls",
    order: 60,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.canvassing",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Canvassing",
    description: "Canvassing maps and field-sales activity.",
    icon: "fa-map-location-dot",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "canvassing",
    order: 70,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "portal.company_settings",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Settings",
    description: "Company configuration, users, roles, and integrations.",
    icon: "fa-gear",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "company_settings",
    order: 80,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.map",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Project Overview",
    description: "Project overview, property, and map details.",
    icon: "fa-map-location-dot",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.photos",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Project Photos",
    description: "Photos associated with the project.",
    icon: "fa-images",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 20,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.proposal",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Project Proposals",
    description: "Proposals and customer approvals for the project.",
    icon: "fa-file-signature",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 30,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.docs",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Project Docs",
    description: "Documents associated with the project.",
    icon: "fa-folder-open",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 40,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.materials",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Scope",
    description: "Project scope, materials, and expense projections.",
    icon: "fa-clipboard-list",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 50,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.money",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Money",
    description: "Project financials, payments, expenses, and profitability.",
    icon: "fa-dollar-sign",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 60,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.customer_portal",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Customer Portal",
    description: "Customer-facing project portal configuration and preview.",
    icon: "fa-user-lock",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 70,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.schedule",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Project Schedule",
    description: "Scheduling and assigned work for this project.",
    icon: "fa-calendar-days",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 80,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.measurements",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Reports",
    description: "Measurements and report ordering for this project.",
    icon: "fa-ruler-combined",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 90,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  },
  {
    id: "project.checklists",
    application_id: MANAGEMENT_APPLICATION_ID,
    title: "Checklists",
    description: "Review and manage every field checklist for this project, including who completed each item.",
    icon: "fa-list-check",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 95,
    devices: ["mobile", "desktop"],
    required_permissions: [],
    permission_mode: "all",
    default_params: { mode: "manage" },
    parameter_permissions: {},
    layout: {},
    default_enabled: true
  }
];

const CREW_APP_CATALOG_SOURCE: AccessCatalogEntry[] = [
  {
    id: "portal.crew_overview",
    application_id: FIELD_APPLICATION_ID,
    title: "Today",
    description: "Today's assigned work, overdue work, and shift controls.",
    icon: "fa-house",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "crew_overview",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.dashboard_view],
    permission_mode: "all",
    default_params: { mode: "crew", variant: "crew", time_clock_enabled: false },
    parameter_permissions: { time_clock_enabled: CREW_PERMISSION_KEYS.time_clock_use },
    layout: PORTAL_LAYOUT
  },
  {
    id: "portal.crew_schedule",
    application_id: FIELD_APPLICATION_ID,
    title: "Schedule",
    description: "List and calendar views of past and upcoming assigned projects.",
    icon: "fa-calendar-days",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "crew_schedule",
    order: 30,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.schedule_view],
    permission_mode: "all",
    default_params: { mode: "crew", variant: "mobile_crew", assignment_scope: "mine" },
    parameter_permissions: {},
    layout: PORTAL_LAYOUT
  },
  {
    id: "portal.crew_payouts",
    application_id: FIELD_APPLICATION_ID,
    title: "Earnings",
    description: "Personal payroll owed, projected, and paid earnings by project.",
    icon: "fa-wallet",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "crew_payouts",
    order: 50,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.payouts_view],
    permission_mode: "all",
    default_params: { mode: "crew", subject_scope: "mine" },
    parameter_permissions: {},
    layout: PORTAL_LAYOUT
  },
  {
    id: "portal.crew_receipts",
    application_id: FIELD_APPLICATION_ID,
    title: "Receipts",
    description: "Upload job receipts and review their extraction status.",
    icon: "fa-receipt",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "crew_receipts",
    order: 40,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.receipts_upload],
    permission_mode: "all",
    default_params: { mode: "crew", assignment_scope: "mine", can_upload: false, can_request_reimbursement: false },
    parameter_permissions: {
      can_upload: CREW_PERMISSION_KEYS.receipts_upload,
      can_request_reimbursement: CREW_PERMISSION_KEYS.reimbursements_request
    },
    layout: PORTAL_LAYOUT
  },
  {
    id: "project.crew_overview",
    application_id: FIELD_APPLICATION_ID,
    title: "Visit",
    description: "Scope-driven appointment workflow with a useful default flow for every scheduled visit.",
    icon: "fa-house",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.projects_view],
    permission_mode: "all",
    default_params: { mode: "crew" },
    parameter_permissions: {},
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_materials",
    application_id: FIELD_APPLICATION_ID,
    title: "Materials",
    description: "View deliveries and append manually entered or receipt-derived materials.",
    icon: "fa-boxes-stacked",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 20,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.materials_view],
    permission_mode: "all",
    default_params: { mode: "crew", can_append: false, can_upload_receipt: false },
    parameter_permissions: {
      can_append: CREW_PERMISSION_KEYS.materials_append,
      can_upload_receipt: CREW_PERMISSION_KEYS.receipts_upload
    },
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_payouts",
    application_id: FIELD_APPLICATION_ID,
    title: "Earnings",
    description: "Personal payroll earnings for this project.",
    icon: "fa-wallet",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 30,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.payouts_view],
    permission_mode: "all",
    default_params: { mode: "crew", subject_scope: "mine" },
    parameter_permissions: {},
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_payments",
    application_id: FIELD_APPLICATION_ID,
    title: "Payments",
    description: "Review project balances and optionally take an on-site payment.",
    icon: "fa-credit-card",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 40,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.payments_view],
    permission_mode: "all",
    default_params: { mode: "crew", can_take_payment: false },
    parameter_permissions: { can_take_payment: CREW_PERMISSION_KEYS.payments_take },
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_change_orders",
    application_id: FIELD_APPLICATION_ID,
    title: "Change Orders",
    description: "Review and optionally prepare, sign, and collect change orders.",
    icon: "fa-file-signature",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 50,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.change_orders_view],
    permission_mode: "all",
    default_params: { mode: "crew", can_manage: false },
    parameter_permissions: { can_manage: CREW_PERMISSION_KEYS.change_orders_manage },
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_checklists",
    application_id: FIELD_APPLICATION_ID,
    title: "Checklists",
    description: "Complete assigned checklists, rate supervisor quality reviews, or manage checklists when authorized.",
    icon: "fa-list-check",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 60,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.checklists_view, CREW_PERMISSION_KEYS.checklists_supervise],
    permission_mode: "any",
    default_params: { mode: "complete", can_complete: false, can_manage: false, can_supervise: false },
    parameter_permissions: {
      can_complete: CREW_PERMISSION_KEYS.checklists_complete,
      can_manage: CREW_PERMISSION_KEYS.checklists_manage,
      can_supervise: CREW_PERMISSION_KEYS.checklists_supervise
    },
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.field_customer",
    application_id: FIELD_APPLICATION_ID,
    title: "Customer",
    description: "Customer contact information, property address, and project notes for field users.",
    icon: "fa-address-card",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 15,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.projects_view],
    permission_mode: "all",
    default_params: {},
    parameter_permissions: {},
    layout: PROJECT_LAYOUT
  },
  {
    id: "project.crew_signatures",
    application_id: FIELD_APPLICATION_ID,
    title: "Workflows",
    description: "Review project workflows, complete customer actions, and add authorized field work.",
    icon: "fa-diagram-project",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 70,
    devices: ["mobile", "desktop"],
    required_permissions: [CREW_PERMISSION_KEYS.signatures_present],
    permission_mode: "all",
    default_params: { mode: "present" },
    parameter_permissions: {},
    layout: PROJECT_LAYOUT
  }
];

const SALES_APP_CATALOG_SOURCE: AccessCatalogEntry[] = [
  {
    id: "portal.sales_overview",
    application_id: FIELD_APPLICATION_ID,
    title: "Today",
    description: "Today's sales appointments, follow-ups, and pipeline pulse.",
    icon: "fa-house",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "sales_overview",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [SALES_PERMISSION_KEYS.dashboard_view],
    permission_mode: "all",
    default_params: { mode: "sales", show_pipeline_pulse: true, can_manage_followups: false },
    parameter_permissions: { can_manage_followups: SALES_PERMISSION_KEYS.followups_manage },
    default_home: true,
    layout: PORTAL_LAYOUT
  },
  {
    id: "portal.sales_schedule",
    application_id: FIELD_APPLICATION_ID,
    title: "Schedule",
    description: "List and calendar views of past and upcoming sales appointments.",
    icon: "fa-calendar-days",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "sales_schedule",
    order: 20,
    devices: ["mobile", "desktop"],
    required_permissions: [SALES_PERMISSION_KEYS.schedule_view],
    permission_mode: "all",
    default_params: { mode: "sales", assignment_scope: "mine" },
    parameter_permissions: {},
    layout: PORTAL_LAYOUT
  },
  {
    id: "portal.sales_earnings",
    application_id: FIELD_APPLICATION_ID,
    title: "Earnings",
    description: "Personal commission earnings: pending, paid, and per-deal breakdown.",
    icon: "fa-wallet",
    surface: "portal_tab",
    kind: "portal_tab",
    portal_tab_id: "sales_earnings",
    order: 30,
    devices: ["mobile", "desktop"],
    required_permissions: [SALES_PERMISSION_KEYS.earnings_view],
    permission_mode: "all",
    default_params: { mode: "sales", subject_scope: "mine", presentation: "commissions" },
    parameter_permissions: {},
    layout: PORTAL_LAYOUT
  },
  {
    id: "project.sales_overview",
    application_id: FIELD_APPLICATION_ID,
    title: "Visit",
    description: "Sales-focused project summary: customer, appointments, follow-ups, and notes.",
    icon: "fa-house",
    surface: "project_modal",
    kind: "project_modal_app",
    order: 10,
    devices: ["mobile", "desktop"],
    required_permissions: [SALES_PERMISSION_KEYS.dashboard_view],
    permission_mode: "all",
    default_params: { mode: "sales" },
    parameter_permissions: {},
    default_home: true,
    layout: PROJECT_LAYOUT
  }
];

const APP_ID_ALIASES: Record<string, string> = {
  "crew.overview": "portal.crew_overview",
  "crew.dashboard": "portal.crew_overview",
  "field.overview": "portal.crew_overview",
  "crew.projects": "portal.crew_schedule",
  "field.projects": "portal.crew_schedule",
  "crew.schedule": "portal.crew_schedule",
  "field.schedule": "portal.crew_schedule",
  "crew.payouts": "portal.crew_payouts",
  "field.payouts": "portal.crew_payouts",
  "crew.receipts": "portal.crew_receipts",
  "field.receipts": "portal.crew_receipts",
  "crew.project.overview": "project.crew_overview",
  "crew.project.materials": "project.crew_materials",
  "crew.project.payouts": "project.crew_payouts",
  "crew.project.payments": "project.crew_payments",
  "crew.project.change_orders": "project.crew_change_orders",
  "crew.project.checklists": "project.crew_checklists"
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return cleanText(value) ? [value] : [];
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function cleanOrganizationId(value: unknown) {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest("invalid_organization_id", "organization_id must contain at least one letter or number.");
  return id;
}

function cleanRoleId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}

function canonicalApplicationId(value: unknown) {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  if (["main", "portal", "management_app"].includes(id)) return MANAGEMENT_APPLICATION_ID;
  if (["crew", "workforce", "crew_app"].includes(id)) return FIELD_APPLICATION_ID;
  return id;
}

export function normalizeApplicationIds(value: unknown, fallback: unknown = []) {
  const values = asArray(value).length ? asArray(value) : asArray(fallback);
  return [...new Set(values.map(canonicalApplicationId).filter(Boolean))];
}

function canonicalAppId(value: unknown) {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return APP_ID_ALIASES[id] || id;
}

function boolValue(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (["1", "true", "yes", "on", "enabled", "allow", "allowed"].includes(text)) return true;
  if (["0", "false", "no", "off", "disabled", "deny", "denied"].includes(text)) return false;
  return fallback;
}

export function normalizePermissionMap(value: unknown): PermissionMap {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(cleanText).filter(Boolean).map((permission) => [permission, true]));
  }
  const input = asObject(value);
  const result: PermissionMap = {};
  for (const [permissionValue, allowedValue] of Object.entries(input)) {
    const permission = cleanText(permissionValue);
    if (!permission) continue;
    result[permission] = boolValue(allowedValue, false);
  }
  return result;
}

function normalizeAppDefault(value: unknown): AccessRoleAppDefault {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return { enabled: boolValue(value, false), params: {}, layout: {} };
  }
  const input = asObject(value);
  return {
    enabled: boolValue(input.enabled ?? input.allowed ?? input.visible ?? input.access, false),
    params: asObject(input.params ?? input.parameters ?? input.options),
    layout: asObject(input.layout)
  };
}

export function normalizeAppDefaults(value: unknown): Record<string, AccessRoleAppDefault> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(canonicalAppId).filter(Boolean).map((id) => [id, { enabled: true, params: {}, layout: {} }]));
  }
  const result: Record<string, AccessRoleAppDefault> = {};
  for (const [appIdValue, defaultValue] of Object.entries(asObject(value))) {
    const appId = canonicalAppId(appIdValue);
    if (appId) result[appId] = normalizeAppDefault(defaultValue);
  }
  return result;
}

function normalizeAppOverride(value: unknown): AccessRoleAppDefault | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const state = cleanText(value).toLowerCase();
    if (["inherit", "default", "role_default", "unset"].includes(state)) return null;
    if (["show", "shown", "visible"].includes(state)) return { enabled: true, params: {}, layout: {} };
    if (["hide", "hidden"].includes(state)) return { enabled: false, params: {}, layout: {} };
  }
  const input = asObject(value);
  const state = cleanText(input.state ?? input.visibility ?? input.override).toLowerCase();
  if (["inherit", "default", "role_default", "unset"].includes(state)) return null;
  if (["show", "shown", "visible"].includes(state)) {
    return { enabled: true, params: asObject(input.params ?? input.parameters ?? input.options), layout: asObject(input.layout) };
  }
  if (["hide", "hidden"].includes(state)) {
    return { enabled: false, params: asObject(input.params ?? input.parameters ?? input.options), layout: asObject(input.layout) };
  }
  if (Object.prototype.hasOwnProperty.call(input, "show")) {
    return { enabled: boolValue(input.show, false), params: asObject(input.params), layout: asObject(input.layout) };
  }
  if (Object.prototype.hasOwnProperty.call(input, "hide")) {
    return { enabled: !boolValue(input.hide, false), params: asObject(input.params), layout: asObject(input.layout) };
  }
  return normalizeAppDefault(value);
}

function mergeAppOverrideLayers(...layers: unknown[]): Record<string, AccessRoleAppDefault> {
  const result: Record<string, AccessRoleAppDefault> = {};
  for (const layer of layers) {
    if (Array.isArray(layer)) {
      for (const appIdValue of layer) {
        const appId = canonicalAppId(appIdValue);
        if (appId) result[appId] = { enabled: true, params: {}, layout: {} };
      }
      continue;
    }
    for (const [appIdValue, overrideValue] of Object.entries(asObject(layer))) {
      const appId = canonicalAppId(appIdValue);
      if (!appId) continue;
      const override = normalizeAppOverride(overrideValue);
      if (override === null) delete result[appId];
      else result[appId] = override;
    }
  }
  return result;
}

function mergeJson(leftValue: unknown, rightValue: unknown): JsonObject {
  const left = asObject(leftValue);
  const right = asObject(rightValue);
  const result: JsonObject = { ...left, ...right };
  for (const key of Object.keys(right)) {
    if (Object.keys(asObject(left[key])).length && Object.keys(asObject(right[key])).length) {
      result[key] = mergeJson(left[key], right[key]);
    }
  }
  return result;
}

function cloneCatalogEntry(entry: AccessCatalogEntry): AccessCatalogEntry {
  return {
    ...entry,
    application: entry.application || entry.application_id,
    label: entry.label || entry.title,
    default_enabled: entry.default_enabled === true,
    default_home: entry.default_home === true
      || entry.id === "portal.crew_overview"
      || entry.id === "project.crew_overview",
    devices: [...entry.devices],
    required_permissions: [...entry.required_permissions],
    default_params: mergeJson({}, entry.default_params),
    parameter_permissions: { ...entry.parameter_permissions },
    layout: mergeJson({}, entry.layout)
  };
}

const ACCESS_APP_CATALOG_SOURCE: AccessCatalogEntry[] = [
  ...MANAGEMENT_APP_CATALOG_SOURCE,
  ...CREW_APP_CATALOG_SOURCE,
  ...SALES_APP_CATALOG_SOURCE
];

export const CANONICAL_ACCESS_APP_CATALOG: readonly AccessCatalogEntry[] = Object.freeze(
  ACCESS_APP_CATALOG_SOURCE.map((entry) => Object.freeze(cloneCatalogEntry(entry)))
);

export const CANONICAL_CREW_APP_CATALOG: readonly AccessCatalogEntry[] = Object.freeze(
  CREW_APP_CATALOG_SOURCE.map((entry) => Object.freeze(cloneCatalogEntry(entry)))
);

export function accessCatalog(options: {
  application_id?: string;
  surface?: AccessSurface;
  device?: AccessDevice;
} = {}) {
  const applicationId = canonicalApplicationId(options.application_id);
  return ACCESS_APP_CATALOG_SOURCE
    .filter((entry) => !applicationId || entry.application_id === applicationId)
    .filter((entry) => !options.surface || entry.surface === options.surface)
    .filter((entry) => !options.device || entry.devices.includes(options.device))
    .map(cloneCatalogEntry);
}

function hiddenFieldAppDefaults() {
  return Object.fromEntries(accessCatalog({ application_id: FIELD_APPLICATION_ID })
    .map((entry) => [entry.id, { enabled: false, params: {}, layout: {} }]));
}

// The base set of field apps every field persona starts from. Change orders are
// visible to every field role; write access is governed by
// crew.change_orders.manage so members get a read-only view.
const FIELD_PERSONA_BASE_APP_IDS = [
  "portal.crew_overview",
  "portal.crew_schedule",
  "portal.crew_payouts",
  "portal.crew_receipts",
  "project.crew_overview",
  "project.field_customer",
  "project.crew_materials",
  "project.crew_payouts",
  "project.crew_checklists",
  "project.crew_change_orders"
];

function fieldPersonaAppDefaults(options: {
  checklists_mode: string;
  overrides?: Record<string, AccessRoleAppDefault>;
}) {
  const defaults = hiddenFieldAppDefaults();
  for (const id of FIELD_PERSONA_BASE_APP_IDS) {
    defaults[id] = { enabled: true, params: {}, layout: {} };
  }
  defaults["project.crew_checklists"] = {
    enabled: true,
    params: { mode: options.checklists_mode },
    layout: {}
  };
  for (const [appId, override] of Object.entries(options.overrides || {})) {
    defaults[appId] = override;
  }
  return defaults;
}

export type FactoryPersonaDefinition = {
  id: string;
  name: string;
  description: string;
  application_ids: string[];
  level: number;
  permissions: PermissionMap;
  app_defaults: Record<string, AccessRoleAppDefault>;
  metadata: JsonObject;
  capability_requirements: string[];
};

// Factory persona definitions are the single source for the system access-role
// seeds AND the factory persona templates copied into each organization
// (see persona_templates.ts). Role seeding derives from this data, so a
// factory template and its seeded system role are always content-identical.
export function factoryPersonaDefinitions(): FactoryPersonaDefinition[] {
  const managerReadPermissions: PermissionMap = Object.fromEntries([
    "view_contacts", "view_schedule", "view_financials", "view_documents",
    "view_materials", "view_proposals", "view_stats", "view_websites",
    "view_pricebook", "view_feedback", "view_canvassing", "view_media",
    "view_comms", "view_customer_portals", "view_project_data"
  ].map(key => [key, true]));
  const managerWritePermissions: PermissionMap = Object.fromEntries([
    "manage_project_billing", "manage_documents", "issue_documents",
    "manage_proposals", "send_proposals", "manage_stats", "manage_websites",
    "request_feedback", "manage_canvassing", "manage_media",
    "manage_customer_portals", "manage_project_data"
  ].map(key => [key, true]));
  const adminPermissions: PermissionMap = {
    "*": true,
    order_reports: true,
    view_reports: true,
    view_projects: true,
    manage_projects: true,
    manage_schedule: true,
    manage_billing: true,
    manage_company_settings: true,
    manage_report_settings: true,
    manage_company_users: true
  };
  const crewMemberPermissions: PermissionMap = Object.fromEntries([
    CREW_PERMISSION_KEYS.dashboard_view,
    CREW_PERMISSION_KEYS.projects_view,
    CREW_PERMISSION_KEYS.schedule_view,
    CREW_PERMISSION_KEYS.time_clock_use,
    CREW_PERMISSION_KEYS.receipts_upload,
    CREW_PERMISSION_KEYS.reimbursements_request,
    CREW_PERMISSION_KEYS.materials_view,
    CREW_PERMISSION_KEYS.materials_append,
    CREW_PERMISSION_KEYS.payouts_view,
    CREW_PERMISSION_KEYS.checklists_view,
    CREW_PERMISSION_KEYS.checklists_complete
  ].map((permission) => [permission, true]));
  // Crew members can review change orders (read-only) but not create or send
  // them, and never see customer payments by default.
  crewMemberPermissions[CREW_PERMISSION_KEYS.change_orders_view] = true;
  // Crew roles (member and foreman) stay production-focused: no customer
  // payments and no change-order issuing. The supervisor closes the job out.
  const crewForemanPermissions: PermissionMap = {
    ...crewMemberPermissions,
    [CREW_PERMISSION_KEYS.checklists_manage]: true
  };
  const repairmanPermissions: PermissionMap = {
    ...crewMemberPermissions,
    [CREW_PERMISSION_KEYS.checklists_manage]: true
  };
  const supervisorPermissions: PermissionMap = {
    ...crewForemanPermissions,
    [CREW_PERMISSION_KEYS.projects_view_all_production]: true,
    [CREW_PERMISSION_KEYS.payments_view]: true,
    [CREW_PERMISSION_KEYS.payments_take]: true,
    [CREW_PERMISSION_KEYS.change_orders_view]: true,
    [CREW_PERMISSION_KEYS.change_orders_manage]: true,
    [CREW_PERMISSION_KEYS.checklists_supervise]: true,
    [CREW_PERMISSION_KEYS.signatures_present]: true,
    [CREW_PERMISSION_KEYS.workflows_add]: true
  };
  return [
    {
      id: DEFAULT_ACCESS_ROLE_IDS.management.viewer,
      application_ids: [MANAGEMENT_APPLICATION_ID],
      name: "Viewer",
      description: "Read-only access to the management application.",
      permissions: { view_reports: true, view_projects: true, view_contacts: true, view_schedule: true, view_documents: true, view_materials: true, view_proposals: true, view_stats: true, view_pricebook: true, view_feedback: true, view_customer_portals: true, view_project_data: true },
      app_defaults: hiddenFieldAppDefaults(),
      level: 10,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.management.manager,
      application_ids: [MANAGEMENT_APPLICATION_ID],
      name: "Manager",
      description: "Operational management access without company administration.",
      permissions: { order_reports: true, view_reports: true, view_projects: true, manage_projects: true, manage_schedule: true, ...managerReadPermissions, ...managerWritePermissions },
      app_defaults: hiddenFieldAppDefaults(),
      level: 20,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.management.admin,
      application_ids: [MANAGEMENT_APPLICATION_ID],
      name: "Administrator",
      description: "Company administration and operational management access.",
      permissions: adminPermissions,
      app_defaults: hiddenFieldAppDefaults(),
      level: 30,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.management.super_admin,
      application_ids: [MANAGEMENT_APPLICATION_ID],
      name: "Super Administrator",
      description: "Unrestricted data permission without automatically showing role-irrelevant Crew apps.",
      permissions: { "*": true, ...adminPermissions, manage_company_user_permissions: true },
      app_defaults: hiddenFieldAppDefaults(),
      level: 40,
      metadata: {},
      capability_requirements: []
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
      application_ids: [FIELD_APPLICATION_ID],
      name: "Crew Member",
      description: "Assigned-work, time, receipt, material, payout, and checklist access with read-only change orders.",
      permissions: crewMemberPermissions,
      app_defaults: fieldPersonaAppDefaults({ checklists_mode: "complete" }),
      level: 10,
      metadata: { field_mode: "crew" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.field.repairman,
      application_ids: [FIELD_APPLICATION_ID],
      name: "Repairman",
      description: "Solo field technician assigned work directly: crew access plus managing their own job checklists.",
      permissions: repairmanPermissions,
      app_defaults: fieldPersonaAppDefaults({ checklists_mode: "manage" }),
      level: 15,
      metadata: { field_mode: "solo" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
      application_ids: [FIELD_APPLICATION_ID],
      name: "Crew Foreman",
      description: "Crew Member access plus managing crew checklists. Payments and change orders belong to the closing-out role.",
      permissions: crewForemanPermissions,
      app_defaults: fieldPersonaAppDefaults({ checklists_mode: "manage" }),
      level: 20,
      metadata: { field_mode: "crew" },
      capability_requirements: ["apps.crew"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
      application_ids: [FIELD_APPLICATION_ID],
      name: "Supervisor",
      description: "Sees every production project, reviews crew work with quality checklists, and closes out with payments and change orders.",
      permissions: supervisorPermissions,
      app_defaults: fieldPersonaAppDefaults({
        checklists_mode: "manage",
        // Only the closing-out role sees customer payments by default;
        // individual companies can re-enable the app per role from the
        // access matrix.
        overrides: {
          "project.crew_payments": { enabled: true, params: {}, layout: {} },
          "project.crew_signatures": { enabled: true, params: { mode: "present" }, layout: {} },
          "portal.crew_overview": { enabled: true, params: { variant: "supervisor" }, layout: {} }
        }
      }),
      level: 30,
      metadata: { field_mode: "supervisor" },
      capability_requirements: ["apps.crew", "platform.money"]
    },
    {
      id: DEFAULT_ACCESS_ROLE_IDS.field.salesperson,
      application_ids: [FIELD_APPLICATION_ID],
      name: "Salesperson",
      description: "Phone-first sales: today's appointments, follow-ups, commission earnings, and proposal status.",
      permissions: {
        [SALES_PERMISSION_KEYS.dashboard_view]: true,
        [SALES_PERMISSION_KEYS.schedule_view]: true,
        [SALES_PERMISSION_KEYS.followups_manage]: true,
        [SALES_PERMISSION_KEYS.earnings_view]: true,
        [SALES_PERMISSION_KEYS.documents_view_status]: true,
        [SALES_PERMISSION_KEYS.money_view_status]: true,
        [SALES_PERMISSION_KEYS.stats_view_own]: true,
        // Shared project tabs: salespeople can collect on-the-spot payments
        // and complete sales-facing checklists on their assigned projects.
        // Companies dial these per role from the access matrix.
        [CREW_PERMISSION_KEYS.projects_view]: true,
        [CREW_PERMISSION_KEYS.signatures_present]: true,
        [CREW_PERMISSION_KEYS.workflows_add]: true,
        [CREW_PERMISSION_KEYS.payments_view]: true,
        [CREW_PERMISSION_KEYS.payments_take]: true,
        [CREW_PERMISSION_KEYS.checklists_view]: true,
        [CREW_PERMISSION_KEYS.checklists_complete]: true
      },
      app_defaults: {
        ...hiddenFieldAppDefaults(),
        "portal.sales_overview": { enabled: true, params: {}, layout: {} },
        "portal.sales_schedule": { enabled: true, params: {}, layout: {} },
        "portal.sales_earnings": { enabled: true, params: {}, layout: {} },
        "project.sales_overview": { enabled: true, params: {}, layout: {} },
        "project.field_customer": { enabled: true, params: {}, layout: {} },
        "project.crew_signatures": { enabled: true, params: { mode: "present" }, layout: {} },
        "project.crew_payments": { enabled: true, params: {}, layout: {} },
        "project.crew_checklists": { enabled: true, params: { mode: "complete" }, layout: {} }
      },
      level: 20,
      metadata: { field_mode: "sales" },
      capability_requirements: ["apps.sales", "platform.scheduling"]
    }
  ];
}

type SeedRole = {
  id: string;
  application_id: string;
  name: string;
  description: string;
  permissions: PermissionMap;
  app_defaults: Record<string, AccessRoleAppDefault>;
  level: number;
  metadata?: JsonObject;
};

const initializedAccessDatabases = new WeakSet<object>();
const seededAccessOrganizations = new WeakMap<object, Set<string>>();

function defaultRoleSeeds(): SeedRole[] {
  return factoryPersonaDefinitions().map((definition) => ({
    id: definition.id,
    application_id: definition.application_ids[0] || MANAGEMENT_APPLICATION_ID,
    name: definition.name,
    description: definition.description,
    permissions: definition.permissions,
    app_defaults: definition.app_defaults,
    level: definition.level,
    metadata: definition.metadata
  }));
}

export async function initializeAccessSchema(orgIdValue?: string) {
  const db = getWorkforceDatabase();
  if (!initializedAccessDatabases.has(db)) {
  
    initializedAccessDatabases.add(db);
  }
  if (orgIdValue) (await seedDefaultAccessRoles(cleanOrganizationId(orgIdValue)));
  return { schema_version: ACCESS_SCHEMA_VERSION, initialized: true };
}

const ACCESS_ROLE_PRESET_REVISION = 7;

async function seedDefaultAccessRoles(orgId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  const db = getWorkforceDatabase();
  let seededOrganizations = seededAccessOrganizations.get(db);
  if (!seededOrganizations) {
    seededOrganizations = new Set<string>();
    seededAccessOrganizations.set(db, seededOrganizations);
  }
  if (seededOrganizations.has(orgId)) return;
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO workforce_access_roles
    (organization_id, id, application_id, application_ids_json, name, description, status, is_system, system_key,
     permissions_json, app_defaults_json, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`);
  const readExisting = db.prepare(`SELECT metadata_json, revision FROM workforce_access_roles
    WHERE organization_id=? AND id=? AND is_system=1`);
  const upgrade = db.prepare(`UPDATE workforce_access_roles
    SET description=?, permissions_json=?, app_defaults_json=?, metadata_json=?, revision=revision+1, updated_at=?
    WHERE organization_id=? AND id=? AND is_system=1`);
  for (const seed of defaultRoleSeeds()) {
    (await insert.run(
      orgId,
      seed.id,
      seed.application_id,
      json([seed.application_id]),
      seed.name,
      seed.description,
      `${seed.application_id}.${seed.id}`,
      json(seed.permissions),
      json(seed.app_defaults),
      json({ system_default: true, preset_revision: ACCESS_ROLE_PRESET_REVISION, level: seed.level, ...asObject(seed.metadata) }),
      now,
      now
    ));
    // Upgrade previously seeded system roles when the preset definition changes
    // (new permissions or app defaults) without touching custom roles.
    const existing = asObject((await readExisting.get(orgId, seed.id)));
    const metadata = asObject(parseJson(existing.metadata_json));
    const presetRevision = Number(metadata.preset_revision || 1);
    if (metadata.system_default === true && presetRevision < ACCESS_ROLE_PRESET_REVISION) {
      (await upgrade.run(
        seed.description,
        json(seed.permissions),
        json(seed.app_defaults),
        json({ ...metadata, preset_revision: ACCESS_ROLE_PRESET_REVISION, level: seed.level, ...asObject(seed.metadata) }),
        now,
        orgId,
        seed.id
      ));
    }
  }
  seededOrganizations.add(orgId);

  }));
}

export async function initializeAccessRoles(orgIdValue: string) {
  const orgId = cleanOrganizationId(orgIdValue);
  (await initializeAccessSchema());
  (await seedDefaultAccessRoles(orgId));
  return (await listAccessRoles(orgId, { include_archived: true }));
}

async function ensureAccessDefaults(orgIdValue: string) {
  const orgId = cleanOrganizationId(orgIdValue);
  (await initializeAccessSchema());
  (await seedDefaultAccessRoles(orgId));
  return orgId;
}

function roleView(rowValue: unknown): AccessRole {
  const row = asObject(rowValue);
  const status = cleanText(row.status) === "archived" ? "archived" : "active";
  const applicationId = canonicalApplicationId(row.application_id);
  const applicationIds = normalizeApplicationIds(parseJson(row.application_ids_json, []), applicationId);
  return {
    id: cleanRoleId(row.id),
    organization_id: cleanText(row.organization_id),
    application_id: applicationId || applicationIds[0] || "",
    application_ids: applicationIds,
    name: cleanText(row.name),
    description: cleanText(row.description),
    status,
    is_system: Number(row.is_system || 0) === 1,
    system_key: cleanText(row.system_key),
    permissions: normalizePermissionMap(parseJson(row.permissions_json)),
    app_defaults: normalizeAppDefaults(parseJson(row.app_defaults_json)),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

export async function listAccessRoles(orgIdValue: string, options: boolean | {
  include_archived?: boolean;
  application_id?: string;
} = {}) {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const normalizedOptions = typeof options === "boolean" ? { include_archived: options } : options;
  const clauses = ["organization_id=?"];
  const params: string[] = [orgId];
  if (!normalizedOptions.include_archived) clauses.push("status='active'");
  const applicationId = canonicalApplicationId(normalizedOptions.application_id);
  return (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_access_roles
    WHERE ${clauses.join(" AND ")} ORDER BY application_id ASC, name ASC, id ASC`)
    .all(...params)).map(roleView)
    .filter((role) => !applicationId || role.application_ids.includes(applicationId));
}

export async function readAccessRole(orgIdValue: string, roleIdValue: string) {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const roleId = cleanRoleId(roleIdValue);
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_access_roles
    WHERE organization_id=? AND id=?`).get(orgId, roleId));
  if (!row) throw notFound("access_role_not_found", "Access role was not found.");
  return roleView(row);
}

async function generatedRoleId(orgId: string, name: string) {
  const base = cleanRoleId(name) || "access_role";
  const db = getWorkforceDatabase();
  if (!(await db.prepare("SELECT 1 AS found FROM workforce_access_roles WHERE organization_id=? AND id=?").get(orgId, base))) return base;
  return `${base}_${randomBytes(4).toString("hex")}`;
}

export async function createAccessRole(orgIdValue: string, inputValue: AccessRoleCreateInput | JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const input = asObject(inputValue);
  const name = cleanText(input.name);
  if (!name) throw badRequest("access_role_name_required", "Access role name is required.");
  const applicationIds = normalizeApplicationIds(input.application_ids, input.application_id || input.application);
  const applicationId = applicationIds[0] || "";
  if (!applicationId) throw badRequest("access_role_application_required", "At least one application_id is required.");
  const explicitId = cleanRoleId(input.id);
  const roleId = explicitId || (await generatedRoleId(orgId, name));
  if (!roleId) throw badRequest("invalid_access_role_id", "Access role id must contain at least one letter or number.");
  const db = getWorkforceDatabase();
  if ((await db.prepare("SELECT 1 AS found FROM workforce_access_roles WHERE organization_id=? AND id=?").get(orgId, roleId))) {
    throw conflict("access_role_exists", `Access role '${roleId}' already exists.`);
  }
  const now = nowIso();
  (await db.prepare(`INSERT INTO workforce_access_roles
    (organization_id, id, application_id, application_ids_json, name, description, status, is_system, system_key,
     permissions_json, app_defaults_json, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, '', ?, ?, ?, 1, ?, ?)`)
    .run(
      orgId,
      roleId,
      applicationId,
      json(applicationIds),
      name,
      cleanText(input.description),
      json(normalizePermissionMap(input.permissions ?? input.permission_defaults)),
      json(normalizeAppDefaults(input.app_defaults ?? input.apps)),
      json(asObject(input.metadata)),
      now,
      now
    ));
  return (await readAccessRole(orgId, roleId));

  }));
}

function requiredRevision(value: unknown) {
  const revision = Number(value || 0);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw badRequest("expected_revision_required", "A positive expected_revision is required.");
  }
  return revision;
}

export async function patchAccessRole(orgIdValue: string, roleIdValue: string, inputValue: AccessRolePatchInput | JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const roleId = cleanRoleId(roleIdValue);
  const input = asObject(inputValue);
  const current = (await readAccessRole(orgId, roleId));
  const expectedRevision = requiredRevision(input.expected_revision);
  if (current.revision !== expectedRevision) {
    throw conflict("access_role_revision_conflict", "Access role revision does not match.", { current_revision: current.revision });
  }
  const hasApplicationPatch = Object.prototype.hasOwnProperty.call(input, "application_ids")
    || Object.prototype.hasOwnProperty.call(input, "application_id")
    || Object.prototype.hasOwnProperty.call(input, "application");
  const applicationIds = hasApplicationPatch
    ? normalizeApplicationIds(input.application_ids, input.application_id || input.application)
    : current.application_ids;
  const applicationId = applicationIds[0] || "";
  if (!applicationId) throw badRequest("access_role_application_required", "At least one application_id is required.");
  const name = Object.prototype.hasOwnProperty.call(input, "name") ? cleanText(input.name) : current.name;
  if (!name) throw badRequest("access_role_name_required", "Access role name is required.");
  const statusValue = Object.prototype.hasOwnProperty.call(input, "status") ? cleanText(input.status).toLowerCase() : current.status;
  if (!["active", "archived"].includes(statusValue)) throw badRequest("access_role_status_invalid", "Access role status must be active or archived.");
  const status = statusValue as "active" | "archived";
  const permissions = Object.prototype.hasOwnProperty.call(input, "permissions") || Object.prototype.hasOwnProperty.call(input, "permission_defaults")
    ? normalizePermissionMap(input.permissions ?? input.permission_defaults)
    : current.permissions;
  const appDefaults = Object.prototype.hasOwnProperty.call(input, "app_defaults") || Object.prototype.hasOwnProperty.call(input, "apps")
    ? normalizeAppDefaults(input.app_defaults ?? input.apps)
    : current.app_defaults;
  const metadata = Object.prototype.hasOwnProperty.call(input, "metadata") ? asObject(input.metadata) : current.metadata;
  const now = nowIso();
  const result = (await getWorkforceDatabase().prepare(`UPDATE workforce_access_roles SET
    application_id=?, application_ids_json=?, name=?, description=?, status=?, permissions_json=?, app_defaults_json=?, metadata_json=?,
    revision=revision+1, updated_at=?, archived_at=?
    WHERE organization_id=? AND id=? AND revision=?`)
    .run(
      applicationId,
      json(applicationIds),
      name,
      Object.prototype.hasOwnProperty.call(input, "description") ? cleanText(input.description) : current.description,
      status,
      json(permissions),
      json(appDefaults),
      json(metadata),
      now,
      status === "archived" ? (current.archived_at || now) : null,
      orgId,
      roleId,
      expectedRevision
    ));
  if (Number(result.changes || 0) !== 1) {
    const latest = (await readAccessRole(orgId, roleId));
    throw conflict("access_role_revision_conflict", "Access role revision does not match.", { current_revision: latest.revision });
  }
  return (await readAccessRole(orgId, roleId));

  }));
}

export async function archiveAccessRole(
  orgIdValue: string,
  roleIdValue: string,
  expectedRevisionValue: number | { expected_revision: number } | JsonObject
) {
  return (await getWorkforceDatabase().transaction(async () => {
  const expectedRevision = typeof expectedRevisionValue === "number"
    ? expectedRevisionValue
    : Number(asObject(expectedRevisionValue).expected_revision || 0);
  return (await patchAccessRole(orgIdValue, roleIdValue, { expected_revision: requiredRevision(expectedRevision), status: "archived" }));

  }));
}

const LEGACY_MANAGEMENT_ROLE_ALIASES: Record<string, string> = {
  owner: DEFAULT_ACCESS_ROLE_IDS.management.super_admin,
  superadmin: DEFAULT_ACCESS_ROLE_IDS.management.super_admin,
  super_admin: DEFAULT_ACCESS_ROLE_IDS.management.super_admin,
  "super-admin": DEFAULT_ACCESS_ROLE_IDS.management.super_admin,
  administrator: DEFAULT_ACCESS_ROLE_IDS.management.admin,
  admin: DEFAULT_ACCESS_ROLE_IDS.management.admin,
  manager: DEFAULT_ACCESS_ROLE_IDS.management.manager,
  member: DEFAULT_ACCESS_ROLE_IDS.management.viewer,
  user: DEFAULT_ACCESS_ROLE_IDS.management.viewer,
  viewer: DEFAULT_ACCESS_ROLE_IDS.management.viewer
};

const LEGACY_FIELD_ROLE_ALIASES: Record<string, string> = {
  crew: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  member: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  field: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  workforce: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  crew_member: DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  "crew-member": DEFAULT_ACCESS_ROLE_IDS.field.crew_member,
  foreman: DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
  lead: DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
  crew_lead: DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
  crew_foreman: DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
  "crew-foreman": DEFAULT_ACCESS_ROLE_IDS.field.crew_foreman,
  supervisor: DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
  site_supervisor: DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
  "site-supervisor": DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
  project_supervisor: DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
  superintendent: DEFAULT_ACCESS_ROLE_IDS.field.supervisor,
  repairman: DEFAULT_ACCESS_ROLE_IDS.field.repairman,
  repair_tech: DEFAULT_ACCESS_ROLE_IDS.field.repairman,
  service_tech: DEFAULT_ACCESS_ROLE_IDS.field.repairman,
  technician: DEFAULT_ACCESS_ROLE_IDS.field.repairman
};

function roleAlias(value: unknown, applicationId: string) {
  const raw = cleanText(value).toLowerCase().replace(/\s+/g, "_");
  if (!raw) return "";
  if (applicationId === MANAGEMENT_APPLICATION_ID) return LEGACY_MANAGEMENT_ROLE_ALIASES[raw] || cleanRoleId(raw);
  if (applicationId === FIELD_APPLICATION_ID) return LEGACY_FIELD_ROLE_ALIASES[raw] || cleanRoleId(raw);
  return cleanRoleId(raw);
}

function unwrappedUserData(value: unknown) {
  const outer = asObject(value);
  const data = asObject(outer.data);
  return Object.keys(data).length ? { ...outer, ...data } : outer;
}

function rawApplicationAccess(user: JsonObject) {
  const source = asObject(user.application_access ?? user.app_access);
  const result: Record<string, JsonObject> = {};
  for (const [applicationIdValue, entryValue] of Object.entries(source)) {
    const applicationId = canonicalApplicationId(applicationIdValue);
    if (!applicationId) continue;
    if (typeof entryValue === "boolean" || typeof entryValue === "number" || typeof entryValue === "string") {
      result[applicationId] = { enabled: boolValue(entryValue, false) };
    } else {
      result[applicationId] = asObject(entryValue);
    }
  }
  return { source, entries: result };
}

function explicitEnabled(entry: JsonObject) {
  for (const key of ["enabled", "access", "allowed"]) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) return boolValue(entry[key], false);
  }
  return undefined;
}

function assignedRoleIds(user: JsonObject) {
  const access = asObject(user.access ?? user.access_profile);
  const hasExplicit = Object.prototype.hasOwnProperty.call(user, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(access, "access_role_ids")
    || Object.prototype.hasOwnProperty.call(access, "role_ids")
    || Object.prototype.hasOwnProperty.call(access, "roles");
  const values = user.access_role_ids ?? access.access_role_ids ?? access.role_ids ?? access.roles;
  return {
    explicit: hasExplicit,
    ids: [...new Set(asArray(values).map((value) => cleanRoleId(asObject(value).id || value)).filter(Boolean))]
  };
}

function roleLevel(role: AccessRole) {
  return Number(asObject(role.metadata).level || 0);
}

function unionRolePermissions(roles: AccessRole[]) {
  const result: PermissionMap = {};
  for (const role of roles) {
    for (const [permission, allowed] of Object.entries(role.permissions)) {
      if (allowed === true) result[permission] = true;
      else if (!Object.prototype.hasOwnProperty.call(result, permission)) result[permission] = false;
    }
  }
  return result;
}

function userPermissionOverrides(user: JsonObject) {
  const access = asObject(user.access ?? user.access_profile);
  const orgPermissions = asObject(user.org_permissions);
  return {
    ...normalizePermissionMap(user.permissions),
    ...normalizePermissionMap(orgPermissions.items),
    ...normalizePermissionMap(access.permission_overrides),
    ...normalizePermissionMap(user.permission_overrides)
  };
}

function entryAppOverrides(entry: JsonObject) {
  return mergeAppOverrideLayers(
    entry.apps,
    entry.tabs,
    entry.app_entitlements,
    entry.app_overrides,
    entry.app_entitlement_overrides,
    entry.app_access_overrides
  );
}

function userAppOverrides(user: JsonObject, applicationId: string, entry: JsonObject) {
  const access = asObject(user.access ?? user.access_profile);
  const applicationOverridesContainer = asObject(access.application_app_overrides);
  const applicationOverrides = Object.entries(applicationOverridesContainer)
    .find(([key]) => canonicalApplicationId(key) === applicationId)?.[1];
  return mergeAppOverrideLayers(
    entryAppOverrides(entry),
    applicationOverrides,
    access.app_overrides,
    access.app_entitlement_overrides,
    access.app_access_overrides,
    user.app_overrides,
    user.app_entitlement_overrides,
    user.app_access_overrides
  );
}

function hasPermission(permissions: PermissionMap, permission: string) {
  if (permissions[permission] === false) return false;
  return permissions[permission] === true || permissions["*"] === true;
}

function applicationEnabledSource(explicitRoles: boolean, entry: JsonObject, hasRole: boolean, applicationId: string) {
  if (explicitRoles && hasRole) return "access_role";
  if (explicitEnabled(entry) !== undefined) return "user_override";
  if (explicitRoles) return "access_role";
  return applicationId === MANAGEMENT_APPLICATION_ID ? "legacy_default" : "legacy_opt_in";
}

function resolveApplicationEnabled(explicitRoles: boolean, entry: JsonObject, hasRole: boolean, applicationId: string) {
  // Assigning a modern role opts the user into that role's application even
  // when an older user document still contains the default `enabled: false`
  // application entry. Visibility remains independently overridable per app.
  if (explicitRoles && hasRole) return true;
  const explicit = explicitEnabled(entry);
  if (explicit !== undefined) return explicit;
  if (explicitRoles) return hasRole;
  if (hasRole) return true;
  return applicationId === MANAGEMENT_APPLICATION_ID;
}

function primaryRole(roles: AccessRole[]) {
  return [...roles].sort((left, right) => roleLevel(left) - roleLevel(right) || left.id.localeCompare(right.id)).at(-1);
}

/**
 * Whether a user's pay includes an hourly component -- either on their own
 * compensation profile or, when they have none, on an active resource group
 * they belong to. Drives time-clock availability: salaried and pure
 * piece-rate workers never see or use the clock.
 */
export async function hasHourlyCompensation(orgIdValue: string, userIdValue: string): Promise<boolean> {
  const orgId = cleanText(orgIdValue);
  const userId = cleanText(userIdValue);
  if (!orgId || !userId) return false;
  const hasHourly = (profile: unknown) => asArray(asObject(profile).components).map(asObject)
    .some((component) => cleanText(component.kind).toLowerCase() === "hourly");
  try {
    const direct = (await readCompensationProfile(orgId, "organization_user", userId));
    if (direct && asArray(asObject(direct).components).length) return hasHourly(direct);
    const groups = (await getWorkforceDatabase().prepare(`SELECT g.id FROM resource_groups g
      JOIN resource_group_memberships m ON m.organization_id = g.organization_id AND m.group_id = g.id
      WHERE g.organization_id = ? AND g.status = 'active' AND m.user_id = ? AND m.status = 'active'`)
      .all(orgId, userId));
    return (await Promise.all(groups.map(async row => hasHourly(await readCompensationProfile(orgId, "resource_group", cleanText(asObject(row).id)))))).some(Boolean);
  } catch {
    return false;
  }
}

/** Resolves the hourly component used by time-clock payroll. A direct user
 * profile wins; otherwise the first active crew-group profile with an hourly
 * component is used, matching the clock's existing applicability rules. */
export async function resolveHourlyCompensation(orgIdValue: string, userIdValue: string): Promise<JsonObject | null> {
  const orgId = cleanText(orgIdValue);
  const userId = cleanText(userIdValue);
  if (!orgId || !userId) return null;
  const hourlyFrom = (profileValue: unknown, source: string) => {
    const profile = asObject(profileValue);
    const component = asArray(profile.components).map(asObject)
      .find((entry) => cleanText(entry.kind).toLowerCase() === "hourly" && Number(entry.rate_cents || 0) > 0);
    return component ? {
      ...component,
      rate_cents: Math.round(Number(component.rate_cents || 0)),
      currency: cleanText(profile.currency || "USD").toUpperCase(),
      profile_id: cleanText(profile.id),
      profile_revision: Number(profile.revision || 0),
      source
    } : null;
  };
  try {
    const direct = (await readCompensationProfile(orgId, "organization_user", userId));
    if (direct && asArray(asObject(direct).components).length) return hourlyFrom(direct, "organization_user");
    const groups = (await getWorkforceDatabase().prepare(`SELECT g.id FROM resource_groups g
      JOIN resource_group_memberships m ON m.organization_id = g.organization_id AND m.group_id = g.id
      WHERE g.organization_id = ? AND g.status = 'active' AND m.user_id = ? AND m.status = 'active'
      ORDER BY m.is_lead DESC, g.name ASC, g.id ASC`).all(orgId, userId));
    for (const row of groups) {
      const groupId = cleanText(asObject(row).id);
      const resolved = hourlyFrom((await readCompensationProfile(orgId, "resource_group", groupId)), `resource_group:${groupId}`);
      if (resolved) return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

async function effectiveEntitlements(
  orgId: string,
  roles: AccessRole[],
  applications: Record<string, ResolvedApplicationAccess>,
  applicationSources: Record<string, string>,
  effectivePermissions: PermissionMap,
  user: JsonObject,
  device?: AccessDevice
) {
  return (await Promise.all(accessCatalog().map(async (catalog): Promise<EffectiveAppEntitlement> => {
    const application = applications[catalog.application_id] || {
      enabled: false,
      role_id: "",
      role_ids: [],
      permissions: {},
      app_overrides: {}
    };
    // App relevance is intentionally independent from the application that
    // owns a role. This is what lets a management role explicitly opt a user
    // into a field view without conflating that choice with data permission.
    const matchingRoles = roles.filter((role) => role.status === "active");
    let enabled = catalog.default_enabled === true;
    let source: EffectiveAppEntitlement["source"] = "catalog_default";
    let params = mergeJson({}, catalog.default_params);
    let layout = mergeJson({}, catalog.layout);
    const sourceRoleIds: string[] = [];
    let anyRoleDefault = false;
    let anyRoleEnabled = false;
    for (const role of matchingRoles) {
      const roleDefault = role.app_defaults[catalog.id];
      if (!roleDefault) continue;
      anyRoleDefault = true;
      sourceRoleIds.push(role.id);
      if (roleDefault.enabled) anyRoleEnabled = true;
      params = mergeJson(params, roleDefault.params);
      layout = mergeJson(layout, roleDefault.layout);
    }
    if (anyRoleDefault) {
      enabled = anyRoleEnabled;
      source = "role_default";
    }
    const override = application.app_overrides[catalog.id];
    if (override) {
      enabled = override.enabled;
      source = "user_override";
      params = mergeJson(params, override.params);
      layout = mergeJson(layout, override.layout);
    }
    for (const [param, permission] of Object.entries(catalog.parameter_permissions)) {
      params[param] = hasPermission(effectivePermissions, permission);
    }
    // The time clock is compensation-derived, not purely permission-derived:
    // it only appears for workers whose pay actually has an hourly component.
    if (Object.prototype.hasOwnProperty.call(params, "time_clock_enabled")) {
      params.time_clock_enabled = params.time_clock_enabled === true
        && (await hasHourlyCompensation(orgId, cleanText(user.id || user.user_id)));
    }
    const permissionChecks = catalog.required_permissions.map((permission) => hasPermission(effectivePermissions, permission));
    const permissionAllowed = catalog.required_permissions.length === 0
      || (catalog.permission_mode === "any" ? permissionChecks.some(Boolean) : permissionChecks.every(Boolean));
    const applicationEnabled = application.enabled === true;
    const deviceAllowed = !device || catalog.devices.includes(device);
    const allowed = enabled && applicationEnabled && permissionAllowed && deviceAllowed;
    const reasons: string[] = [];
    if (!enabled) reasons.push("app_not_selected");
    if (!applicationEnabled) reasons.push("application_disabled");
    if (!permissionAllowed) reasons.push("permission_denied");
    if (!deviceAllowed) reasons.push("device_ineligible");
    return {
      ...catalog,
      allowed,
      enabled,
      application_enabled: applicationEnabled,
      permission_allowed: permissionAllowed,
      device_allowed: deviceAllowed,
      source,
      sources: {
        application: applicationSources[catalog.application_id] || "default",
        visibility: source,
        role_ids: sourceRoleIds
      },
      params,
      layout,
      reasons
    };
  })));
}

/**
 * Resolve the complete synchronous access facade for an organization user.
 *
 * New user documents should store `access_role_ids` and optional
 * `application_access.<application>.{enabled,permissions,app_overrides}`. When
 * `access_role_ids` is absent, the legacy behavior is preserved: management is
 * enabled by default and field/Crew remains opt-in.
 */
export async function resolveAccessProfile(
  orgIdValue: string,
  userDataValue: unknown,
  options: { device?: AccessDevice } = {}
): Promise<ResolvedAccessProfile> {
  const orgId = (await ensureAccessDefaults(orgIdValue));
  const user = unwrappedUserData(userDataValue);
  const allRoles = (await listAccessRoles(orgId, { include_archived: true }));
  const activeRoles = allRoles.filter((role) => role.status === "active");
  const rolesById = new Map(activeRoles.map((role) => [role.id, role]));
  const assignment = assignedRoleIds(user);
  const requestedRoleIds = [...assignment.ids];
  const rawAccess = rawApplicationAccess(user);

  // Once access_role_ids is present it is authoritative, including an empty
  // array. Legacy application role labels then remain labels only; treating
  // them as modern role assignments would silently grant the seeded role's
  // permissions to existing custom users.
  if (!assignment.explicit) {
    for (const [applicationId, entry] of Object.entries(rawAccess.entries)) {
      const legacyRoleId = roleAlias(entry.role_id ?? entry.roleId ?? entry.role, applicationId);
      if (legacyRoleId && !requestedRoleIds.includes(legacyRoleId)) requestedRoleIds.push(legacyRoleId);
    }
  }

  if (!assignment.explicit) {
    const managementEntry = rawAccess.entries[MANAGEMENT_APPLICATION_ID] || {};
    const managementEnabled = explicitEnabled(managementEntry) ?? true;
    if (managementEnabled && !requestedRoleIds.some((id) => rolesById.get(id)?.application_ids.includes(MANAGEMENT_APPLICATION_ID))) {
      const legacyManagementRole = roleAlias(
        managementEntry.role_id ?? managementEntry.roleId ?? managementEntry.role
          ?? user.org_permission_level ?? user.permission_level ?? user.role ?? asObject(user.org_permissions).level,
        MANAGEMENT_APPLICATION_ID
      ) || DEFAULT_ACCESS_ROLE_IDS.management.viewer;
      requestedRoleIds.push(rolesById.has(legacyManagementRole) ? legacyManagementRole : DEFAULT_ACCESS_ROLE_IDS.management.viewer);
    }
    const fieldEntry = rawAccess.entries[FIELD_APPLICATION_ID] || {};
    const fieldEnabled = explicitEnabled(fieldEntry) ?? false;
    if (fieldEnabled && !requestedRoleIds.some((id) => rolesById.get(id)?.application_ids.includes(FIELD_APPLICATION_ID))) {
      const legacyFieldRole = roleAlias(fieldEntry.role_id ?? fieldEntry.roleId ?? fieldEntry.role, FIELD_APPLICATION_ID)
        || DEFAULT_ACCESS_ROLE_IDS.field.crew_member;
      requestedRoleIds.push(rolesById.has(legacyFieldRole) ? legacyFieldRole : DEFAULT_ACCESS_ROLE_IDS.field.crew_member);
    }
  }

  const uniqueRequestedRoleIds = [...new Set(requestedRoleIds)];
  const roles = uniqueRequestedRoleIds.map((id) => rolesById.get(id)).filter((role): role is AccessRole => Boolean(role));
  const unresolvedRoleIds = uniqueRequestedRoleIds.filter((id) => !rolesById.has(id));
  const applicationIds = new Set<string>([
    MANAGEMENT_APPLICATION_ID,
    FIELD_APPLICATION_ID,
    ...Object.keys(rawAccess.entries),
    ...roles.flatMap((role) => role.application_ids)
  ]);
  const globalPermissionOverrides = userPermissionOverrides(user);
  const applications: Record<string, ResolvedApplicationAccess> = {};
  const applicationSources: Record<string, string> = {};

  for (const applicationId of applicationIds) {
    const applicationRoles = roles.filter((role) => role.application_ids.includes(applicationId));
    const entry = rawAccess.entries[applicationId] || {};
    const enabled = resolveApplicationEnabled(assignment.explicit, entry, applicationRoles.length > 0, applicationId);
    const permissions = {
      ...unionRolePermissions(applicationRoles),
      ...normalizePermissionMap(entry.permissions ?? entry.permission_items ?? entry.items),
      ...globalPermissionOverrides
    };
    const primary = primaryRole(applicationRoles);
    applications[applicationId] = {
      enabled,
      role_id: primary?.id || cleanRoleId(entry.role_id ?? entry.roleId ?? entry.role),
      role_ids: applicationRoles.map((role) => role.id),
      permissions,
      app_overrides: userAppOverrides(user, applicationId, entry)
    };
    applicationSources[applicationId] = applicationEnabledSource(assignment.explicit, entry, applicationRoles.length > 0, applicationId);
  }

  const effectivePermissions: PermissionMap = {};
  for (const application of Object.values(applications)) {
    if (!application.enabled) continue;
    for (const [permission, allowed] of Object.entries(application.permissions)) {
      if (allowed === true) effectivePermissions[permission] = true;
      else if (!Object.prototype.hasOwnProperty.call(effectivePermissions, permission)) effectivePermissions[permission] = false;
    }
  }
  for (const [permission, allowed] of Object.entries(globalPermissionOverrides)) effectivePermissions[permission] = allowed;

  const entitlements = (await effectiveEntitlements(orgId, roles, applications, applicationSources, effectivePermissions, user, options.device));
  const byId = Object.fromEntries(entitlements.map((entitlement) => [entitlement.id, entitlement]));
  return {
    schema_version: ACCESS_SCHEMA_VERSION,
    organization_id: orgId,
    user_id: cleanText(user.id || user.user_id),
    access_role_ids: roles.map((role) => role.id),
    unresolved_access_role_ids: unresolvedRoleIds,
    roles,
    permissions: effectivePermissions,
    effective_permissions: effectivePermissions,
    application_access: applications,
    app_entitlements: entitlements,
    app_entitlements_by_id: byId,
    app_catalog: entitlements,
    allowed_app_ids: entitlements.filter((entitlement) => entitlement.allowed).map((entitlement) => entitlement.id),
    user_revision: Number(user.revision || 0)
  };
}

export async function effectiveAppEntitlements(
  orgIdValue: string,
  userDataValue: unknown,
  options: { device?: AccessDevice; surface?: AccessSurface } = {}
) {
  const entitlements = (await resolveAccessProfile(orgIdValue, userDataValue, { device: options.device })).app_entitlements;
  return options.surface ? entitlements.filter((entry) => entry.surface === options.surface) : entitlements;
}
