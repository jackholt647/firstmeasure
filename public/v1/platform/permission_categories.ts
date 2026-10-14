/**
 * How permissions are grouped for people who grant them.
 *
 * Every permission node in the capability registry names one subcategory
 * (`permission_group`); the subcategory belongs to one top-level category.
 * This is presentation only: a category grants nothing, and moving a
 * permission between subcategories changes no key, meaning or availability.
 * Availability still comes from the node's `parent` and `requires` edges.
 *
 * Categories and subcategories are listed in the order they are shown. Ids
 * are stable; labels may be reworded. Subcategory ids are unique across all
 * categories so a node names only its subcategory.
 */

export type PermissionSubcategoryDefinition = {
  id: string;
  label: string;
  description: string;
  /** The app or feature node this subcategory stands for, when there is one. */
  capability?: string;
  /** Shown folded at the end of its category until opened (for rarely used entries). */
  collapsed?: boolean;
};

export type PermissionCategoryDefinition = {
  id: string;
  label: string;
  description: string;
  /** FontAwesome icon class. */
  icon: string;
  subcategories: PermissionSubcategoryDefinition[];
};

/** The wildcard grant. It is not a permission node; the catalog lists it first under Full access. */
export const WILDCARD_PERMISSION = {
  key: "*",
  label: "Everything",
  description: "Every current and future permission, unless one is denied.",
  group: "full_access"
} as const;

export const PERMISSION_CATEGORIES: readonly PermissionCategoryDefinition[] = [
  {
    id: "company", label: "Company & administration", icon: "fa-building",
    description: "Company settings, billing, notifications and the assistant.",
    subcategories: [
      { id: "full_access", label: "Full access", description: "Grant everything at once." },
      { id: "company_settings", label: "Company settings", description: "Company-wide settings and configuration." },
      { id: "billing", label: "Billing & subscription", description: "Report credits, payment methods and the platform subscription.", capability: "apps.billing" },
      { id: "notifications", label: "Notifications", description: "Personal notifications and company defaults.", capability: "apps.notifications" },
      { id: "assistant", label: "AI assistant", description: "The assistant in the portal.", capability: "apps.assistant" },
      { id: "older_names", label: "Older permission names", description: "Earlier names some screens still accept. Prefer the current permission.", collapsed: true }
    ]
  },
  {
    id: "people", label: "People & access", icon: "fa-users",
    description: "Users, roles, permissions and training.",
    subcategories: [
      { id: "users", label: "Users", description: "Inviting, editing and suspending users." },
      { id: "roles", label: "Roles & permissions", description: "Who can do what." },
      { id: "branches", label: "Branches", description: "Seeing and managing branches other than your own.", capability: "platform.multiple_branches" },
      { id: "training", label: "Training", description: "Courses and training assignments.", capability: "apps.training" }
    ]
  },
  {
    id: "sales", label: "Sales & customers", icon: "fa-handshake",
    description: "Contacts, the pipeline, canvassing, customer portals, websites and the sales app.",
    subcategories: [
      { id: "contacts", label: "Contacts", description: "Customer and contact records." },
      { id: "pipeline", label: "Sales pipeline", description: "Pipeline records and sales workflows.", capability: "apps.crm" },
      { id: "canvassing", label: "Canvassing", description: "Door-to-door canvassing pins.", capability: "canvassing.app" },
      { id: "customer_portals", label: "Customer portals", description: "The pages customers use to follow their project.", capability: "platform.customer_portal" },
      { id: "feedback", label: "Customer feedback", description: "Feedback requests and results.", capability: "apps.feedback" },
      { id: "websites", label: "Websites", description: "The company website.", capability: "apps.web_editor" },
      { id: "sales_app", label: "Sales app", description: "What salespeople see in the mobile sales app.", capability: "apps.sales" },
      { id: "proposals", label: "Proposals (legacy)", description: "The retired proposal builder, kept so signed proposals stay readable.", capability: "platform.proposals" }
    ]
  },
  {
    id: "projects", label: "Projects & production", icon: "fa-briefcase",
    description: "Projects, project data, photos and the photo feed.",
    subcategories: [
      { id: "projects", label: "Projects", description: "Project records.", capability: "apps.projects" },
      { id: "project_data", label: "Project data", description: "Published project datasets." },
      { id: "photos", label: "Photos & media", description: "Project photos and files.", capability: "platform.photos_feed" },
      { id: "photo_feed", label: "Photo feed", description: "The company photo feed and its views.", capability: "platform.photos_feed" }
    ]
  },
  {
    id: "scheduling", label: "Scheduling", icon: "fa-calendar-days",
    description: "Calendars, appointments and confirmations.",
    subcategories: [
      { id: "calendar", label: "Calendar & appointments", description: "Project calendars, availability and appointments.", capability: "platform.scheduling" },
      { id: "confirmations", label: "Appointment confirmations", description: "Whether customers have confirmed.", capability: "scheduling.appointment_confirmations" }
    ]
  },
  {
    id: "field", label: "Field work", icon: "fa-helmet-safety",
    description: "What assignees can see and do in the field app.",
    subcategories: [
      { id: "field_app", label: "Field app", description: "The field app's dashboard, projects and schedule.", capability: "apps.crew" },
      { id: "checklists", label: "Checklists", description: "Checklists on assigned work.", capability: "apps.checklists" },
      { id: "time_expenses", label: "Time & expenses", description: "Time clock, receipts, reimbursements and payouts." },
      { id: "field_payments", label: "Payments & signatures", description: "Collecting payments and signatures on site." },
      { id: "field_materials", label: "Materials & change orders", description: "Material lists and change orders on assigned projects." }
    ]
  },
  {
    id: "materials", label: "Materials & equipment", icon: "fa-boxes-stacked",
    description: "Material lists, the price book and equipment.",
    subcategories: [
      { id: "materials", label: "Materials", description: "Project material lists and orders.", capability: "platform.materials" },
      { id: "pricebook", label: "Price book", description: "Published price book items.", capability: "platform.pricebook" },
      { id: "equipment", label: "Equipment", description: "Equipment, units and maintenance.", capability: "apps.equipment" }
    ]
  },
  {
    id: "money", label: "Money & payroll", icon: "fa-money-check-dollar",
    description: "Financials, invoices, refunds, partner payments and payroll.",
    subcategories: [
      { id: "financials", label: "Financials", description: "Project finances and the company ledger.", capability: "platform.money" },
      { id: "invoices", label: "Invoices & payments", description: "Customer invoices, payments and refunds.", capability: "platform.money" },
      { id: "partner_payments", label: "Partner payments", description: "Paying partner invoices.", capability: "platform.collaboration" },
      { id: "payroll", label: "Payroll", description: "Pay runs and pay settings.", capability: "apps.payroll" }
    ]
  },
  {
    id: "communications", label: "Communications", icon: "fa-comments",
    description: "Customer messages and calls, team channels and website chat.",
    subcategories: [
      { id: "messages", label: "Customer messages", description: "Email and text conversations with customers." },
      { id: "calls", label: "Customer calls", description: "Placing, recording and reviewing calls.", capability: "apps.messaging" },
      { id: "call_coaching", label: "Call coaching", description: "Listening in on and helping with live calls.", capability: "apps.messaging" },
      { id: "call_center", label: "Call center setup", description: "Call lists, scripts, routing and assignments.", capability: "apps.messaging" },
      { id: "team_channels", label: "Team channels", description: "Internal messaging channels.", capability: "apps.channels" },
      { id: "website_chat", label: "Website chat", description: "Live chat with website visitors.", capability: "apps.live_chat" }
    ]
  },
  {
    id: "documents", label: "Documents & reports", icon: "fa-file-signature",
    description: "Documents, signatures, measurement reports and stats.",
    subcategories: [
      { id: "documents", label: "Documents", description: "Project documents and document workflows.", capability: "platform.documents" },
      { id: "signatures", label: "Signatures", description: "Signing and recording signatures.", capability: "platform.documents" },
      { id: "measurement_reports", label: "Measurement reports", description: "Ordering and viewing measurement reports.", capability: "apps.firstmeasure" },
      { id: "stats", label: "Stats & dashboards", description: "Statistics and dashboards.", capability: "apps.stats" }
    ]
  },
  {
    id: "partners", label: "Partners & sharing", icon: "fa-people-arrows",
    description: "Partner companies, what is shared with them and shared channels.",
    subcategories: [
      { id: "partners", label: "Partners", description: "Partner companies and connections.", capability: "platform.collaboration" },
      { id: "sharing", label: "Sharing", description: "Work shared with and by partners.", capability: "platform.collaboration" },
      { id: "shared_channels", label: "Shared channels", description: "Channels shared with partners.", capability: "platform.collaboration" }
    ]
  }
];

export const OTHER_PERMISSION_CATEGORY = {
  id: "other", label: "Other", icon: "fa-key",
  description: "Permissions the catalog does not describe yet."
} as const;

const subcategoryIndex = new Map<string, { category: PermissionCategoryDefinition; subcategory: PermissionSubcategoryDefinition }>();
for (const category of PERMISSION_CATEGORIES) {
  for (const subcategory of category.subcategories) {
    if (subcategoryIndex.has(subcategory.id)) throw new Error(`Permission subcategory "${subcategory.id}" is declared twice.`);
    subcategoryIndex.set(subcategory.id, { category, subcategory });
  }
}

/** The category and subcategory for a subcategory id, or null when it is not declared. */
export function permissionSubcategory(id: string) {
  return subcategoryIndex.get(String(id || "").trim()) || null;
}
