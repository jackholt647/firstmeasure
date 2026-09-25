import { registerCapabilities, validateCapabilityRegistry, type CapabilityDefinition } from "./capabilities.js";
import { listDocumentTypes } from "../documents/types/registry.js";

/**
 * New-button vocabulary — data-driven from the document type registry: every
 * registered document type contributes a `doc:<type_id>` action ("start a new
 * document of that type"), alongside the built-in workflow actions. Used by
 * platform.new_button_mode (default action) and platform.new_button_items
 * (which actions the selector menu lists).
 */
const NEW_BUTTON_WORKFLOW_ITEMS: Array<[string, string]> = [
  ["project", "New Project"],
  ["contact", "New Contact"],
  ["report", "New Report"],
  ["document", "New Document"],
  ["payment", "New Payment"],
  ["appointment", "New Appointment"]
];
const NEW_BUTTON_DOC_TYPE_ITEMS: Array<[string, string]> = listDocumentTypes()
  .filter((type) => type.id !== "generic")
  .map((type) => [`doc:${type.id}`, `New ${type.label}`]);
const DOCUMENT_TYPE_OPTIONS: Array<[string, string]> = listDocumentTypes()
  .map((type) => [type.id, type.label]);
const NEW_BUTTON_ITEM_OPTIONS: Array<[string, string]> = [
  ...NEW_BUTTON_WORKFLOW_ITEMS,
  ...NEW_BUTTON_DOC_TYPE_ITEMS
];

/**
 * Built-in capability declarations.
 *
 * Every node the platform ships is declared here. Modules that add new
 * capabilities later can call registerCapabilities() from their own
 * `capabilities.ts` (imported for side effect before the API boots); the
 * settings UI, presets, and solver pick new nodes up automatically.
 *
 * Value-bearing nodes use two-segment `group.flag` keys because org overrides
 * are stored in the legacy `data.app_flags[group][flag]` document shape.
 * Keys of pre-existing flags MUST NOT change: they are referenced by 26+
 * frontend call sites and stored org documents.
 */

const definitions: CapabilityDefinition[] = [
  { key: "platform.platform_billing", kind: "feature", label: "Platform Billing", description: "Platform subscriptions, usage, storage charges and invoices.", default: true },
  { key: "permission.view_platform_billing", kind: "permission", parent: "platform.platform_billing", permission_key: "view_platform_billing", access: "read", label: "View Platform Billing", description: "View platform subscriptions, usage and invoices." },
  { key: "permission.manage_platform_billing", kind: "permission", parent: "platform.platform_billing", permission_key: "manage_platform_billing", access: "write", label: "Manage Platform Billing", description: "Accept platform pricing, cancel subscriptions and pay platform invoices." },
  { key: "mobile.app_download", kind: "feature", label: "App Download", description: "Show mobile app download links in Settings.", default: false },
  { key: "mobile.developer_downloads", kind: "feature", label: "Mobile Test Downloads", description: "Allow private test builds on development deployments only.", requires: ["mobile.app_download"], default: false },
  { key: "firstmeasure.metric_measurements", kind: "feature", label: "Metric Measurements", description: "Default new reports to metric measurements.", default: false },
  { key: "firstmeasure.report_localization", kind: "feature", label: "Platform Language and Units", description: "Allow Company settings to customize platform language, report language and measurement units, with optional personal interface language.", default: false },
  { key: "firstmeasure.exteriors", kind: "feature", label: "Full House Reports", description: "Allow customers to order full-house exterior measurements with mandatory reference photos.", default: false },
  { key: "firstmeasure.exteriors_photo_review_test", kind: "feature", label: "Full House Photo Review Test", description: "Non-production only: preview review without photos. Does not bypass order validation.", requires: ["firstmeasure.exteriors"], default: false },
  { key: "firstmeasure.exteriors_commercial", kind: "feature", label: "Commercial Full House Reports", description: "Allow full-house ordering for commercial properties.", requires: ["firstmeasure.exteriors"], default: false },
  { key: "firstmeasure.exteriors_multifamily", kind: "feature", label: "Multifamily Full House Reports", description: "Allow full-house ordering for multifamily properties.", requires: ["firstmeasure.exteriors"], default: false },
  { key: "firstmeasure.materials_promo", kind: "feature", label: "Materials Coming Soon Promo", description: "Pilot a Materials advertising tab in projects. Hidden when the real Materials app is enabled; does not grant platform access.", default: false },
  { key: "platform.expanded_access", kind: "feature", label: "Expanded Platform Access", description: "Operator-controlled access to platform apps beyond FirstMeasure.", default: false },
  { key: "platform.more_apps", kind: "feature", label: "More Apps", description: "Shows the app catalog and discovery controls.", requires: ["platform.expanded_access"], default: false },
  { key: "platform.my_settings", kind: "feature", label: "My Settings", description: "Personal language and appearance preferences in Settings.", requires: ["platform.expanded_access"], default: false },
  { key: "platform.company_extended_palette", kind: "feature", label: "Extended Company Palette", description: "Supporting brand colors and palette generation.", requires: ["platform.expanded_access"], default: false },
  { key: "platform.company_business_address", kind: "feature", label: "Company Business Address", description: "Business address fields in company settings.", requires: ["platform.expanded_access"], default: false },
  { key: "platform.company_advanced_logos", kind: "feature", label: "Advanced Company Logos", description: "Alternate logos and advanced logo appearance controls.", requires: ["platform.expanded_access"], default: false },
  { key: "platform.people_access", kind: "feature", label: "Platform People & Access", description: "Use the platform people, workforce and access management UI instead of the familiar FirstMeasure Users screen.", requires: ["platform.expanded_access"], default: false },
  // --- Apps: top-level product surfaces -----------------------------------
  {
    key: "apps.notifications",
    kind: "feature",
    icon: "fa-bell",
    category: "Platform & Appearance",
    label: "Notifications",
    description: "Personal notification preferences and delivery across the portal and phone apps.",
    default: true
  },
  {
    key: "apps.projects",
    kind: "app",
    icon: "fa-folder-open",
    category: "Project Delivery",
    label: "Projects",
    description: "Core project management: project records, viewer, and workflows. Most other apps build on it.",
    catalog_stub: "Projects, workflows, and job records.",
    default: true,
    runtime_app_id: "projects"
  },
  {
    key: "platform.project_stages_view",
    kind: "feature",
    parent: "apps.projects",
    label: "Project Stages View",
    description: "Enables the Stages view mode in the Projects tab.",
    default: false
  },
  {
    key: "platform.project_assignments",
    kind: "feature",
    parent: "apps.projects",
    label: "Project Assignments",
    description: "Shows scope-provided assignment fields, such as estimator and project manager, on projects.",
    default: true
  },
  {
    key: "apps.project_map",
    kind: "feature",
    parent: "apps.projects",
    label: "Project Map",
    description: "Map view of projects and territories.",
    default: true,
    runtime_app_id: "project-map"
  },
  {
    key: "apps.stats",
    kind: "app",
    icon: "fa-chart-column",
    category: "Project Delivery",
    label: "Stats",
    description: "The Stats tab: configurable metric dashboards backed by the cached stats warehouse, plus the conversational stats agent.",
    catalog_stub: "Dashboards, metrics, and insights.",
    default: true,
    runtime_app_id: "stats"
  },
  {
    key: "platform.stats_agent",
    kind: "feature",
    parent: "apps.stats",
    label: "Stats Agent",
    description: "The conversational stats analyst that answers questions, renders charts inline, and edits stats dashboards.",
    default: true
  },
  {
    // DEPRECATED (2026-08): the legacy proposals app is superseded by the
    // document engine (platform.documents) on the unified Docs tab. The key
    // stays for historical records + the scope-generation bridge; its tabs
    // are hidden regardless of this flag.
    key: "platform.proposals",
    kind: "app",
    category: "Sales & Customers",
    label: "Proposals (Legacy)",
    description: "Deprecated legacy proposal builder. Superseded by Documents — kept only so historical signed proposals stay readable.",
    default: false,
    discoverable: false,
    runtime_app_id: "proposals"
  },
  {
    // DEPRECATED with platform.proposals (see above).
    key: "platform.proposal_agent",
    kind: "feature",
    parent: "platform.proposals",
    label: "Proposal Agent (Legacy)",
    description: "Shows the AI prompt panel inside the legacy proposal builder.",
    default: false
  },
  {
    key: "platform.lead_import",
    kind: "app",
    icon: "fa-file-import",
    category: "Sales & Customers",
    label: "Lead Import",
    description: "Lead intake settings and lead import surfaces.",
    catalog_stub: "Import and organize incoming leads.",
    default: false
  },
  {
    key: "platform.website_embed_import",
    kind: "feature",
    parent: "platform.lead_import",
    label: "Website Forms",
    description: "The Forms settings tab and website lead intake APIs.",
    default: false
  },
  {
    key: "lead_forms.contact_form",
    kind: "feature",
    parent: "platform.website_embed_import",
    label: "Contact Form",
    description: "Basic website contact forms.",
    default: false
  },
  {
    key: "lead_forms.appointment_form",
    kind: "feature",
    parent: "platform.website_embed_import",
    requires: ["platform.scheduling"],
    label: "Appointment Form",
    description: "Website appointment forms that book against scheduling.",
    default: false
  },
  {
    key: "lead_forms.instant_estimate",
    kind: "feature",
    parent: "platform.website_embed_import",
    label: "Instant Estimate",
    description: "Website instant estimate forms.",
    default: false
  },
  {
    key: "email.inbound_lead_import",
    kind: "feature",
    parent: "platform.lead_import",
    label: "Email Inbox Leads",
    description: "Inbound email lead capture.",
    default: false
  },
  {
    key: "platform.scheduling",
    kind: "app",
    icon: "fa-calendar-days",
    category: "Sales & Customers",
    label: "Scheduling",
    description: "The Scheduling tab, scheduling settings, and appointment-slot features.",
    catalog_stub: "Appointments, calendars, and availability.",
    default: false,
    runtime_app_id: "scheduling"
  },
  {
    key: "platform.contacts",
    kind: "app",
    icon: "fa-address-book",
    category: "Sales & Customers",
    label: "My Contacts",
    description: "The My Contacts tab for contact and project lookup.",
    catalog_stub: "Customer and project contact lookup.",
    default: false,
    runtime_app_id: "contacts"
  },
  {
    key: "apps.crm",
    kind: "app",
    icon: "fa-filter",
    category: "Sales & Customers",
    label: "CRM",
    description: "CRM pipeline, intake routing, and CRM settings.",
    catalog_stub: "Lead pipelines and intake routing.",
    default: true,
    runtime_app_id: "crm"
  },
  {
    key: "platform.project_photos",
    kind: "app",
    icon: "fa-images",
    category: "Project Delivery",
    label: "Project Photos",
    description: "Project photo galleries and uploads in New Project and project viewer workflows.",
    catalog_stub: "Project photos, galleries, and uploads.",
    default: false,
    runtime_app_id: "photos"
  },
  {
    key: "platform.photos_feed",
    kind: "feature",
    parent: "platform.project_photos",
    label: "Feed",
    description: "The organization-wide media, document, and activity feed, including photo comments and markup review workflows.",
    default: false
  },
  {
    key: "platform.project_docs",
    kind: "app",
    icon: "fa-file-lines",
    category: "Project Delivery",
    label: "Project Docs",
    description: "Project document storage, required documents, and document markup workflows.",
    catalog_stub: "Project files, storage, and markup.",
    default: false,
    runtime_app_id: "docs"
  },
  {
    key: "platform.documents",
    kind: "app",
    icon: "fa-file-signature",
    category: "Project Delivery",
    label: "Documents",
    description: "The document engine: templated proposals, invoices, change orders, contracts, and other data-driven documents with print, PDF, and portal delivery.",
    catalog_stub: "Proposals, contracts, and invoices.",
    default: false,
    runtime_app_id: "documents"
  },
  {
    key: "documents.templates_studio",
    kind: "feature",
    parent: "platform.documents",
    label: "Template Studio",
    description: "Design and publish document templates and themes for the organization.",
    default: false
  },
  {
    key: "platform.manual_project_stage_movement",
    kind: "feature",
    parent: "apps.projects",
    label: "Manual Project Stage Movement",
    description: "Allows project managers to drag projects between board stages or choose a stage from inside a project.",
    default: false
  },
  {
    key: "documents.workflow_authoring",
    kind: "feature",
    parent: "documents.templates_studio",
    label: "Workflow Authoring",
    description: "Create, edit, and publish the guided workflows that collect document params and outputs. Published workflows can still run when authoring is off.",
    default: false
  },
  {
    key: "documents.theme_authoring",
    kind: "feature",
    parent: "documents.templates_studio",
    label: "Theme Authoring",
    description: "Create, edit, and publish document themes. Approved published themes remain available when authoring is off.",
    default: false
  },
  {
    key: "documents.advanced_definition_editing",
    kind: "feature",
    parent: "documents.templates_studio",
    label: "Advanced Document Definitions",
    description: "Edit raw workflow JSON, advanced conditions, bindings, sources, components, repeaters, and other definition-level controls.",
    default: false
  },
  {
    key: "documents.custom_folders",
    kind: "feature",
    parent: "documents.templates_studio",
    label: "Custom Studio Folders",
    description: "Create custom folder tabs (beyond the built-in Marketing folder) in Doc Studio.",
    default: true
  },
  {
    key: "documents.designer_profile",
    kind: "feature",
    parent: "platform.documents",
    label: "Designer Editor",
    description: "The full free-canvas editor tier (free transform, rotation, shapes, filters, page masters) in document editing surfaces.",
    default: false
  },
  {
    key: "documents.esign",
    kind: "feature",
    parent: "platform.documents",
    label: "Document E-Signatures",
    description: "Signature capture on documents delivered through the customer portal.",
    default: true
  },
  {
    key: "documents.payments",
    kind: "feature",
    parent: "platform.documents",
    requires: ["money.take_payment"],
    label: "Document Payments",
    description: "Payment collection widgets and payment schedule wiring on documents.",
    default: true
  },
  {
    key: "documents.agent",
    kind: "feature",
    parent: "platform.documents",
    label: "Document Designer Agent",
    description: "The AI copilot inside the document editors: builds and edits workflows, templates, and documents conversationally.",
    default: true
  },
  {
    key: "documents.ingestion",
    kind: "feature",
    parent: "platform.documents",
    label: "Document Ingestion",
    description: "Upload external files (PDF, images) and extract typed document data from them.",
    default: false
  },
  {
    key: "documents.enabled_types",
    kind: "setting",
    parent: "platform.documents",
    type: "multi_select",
    label: "Enabled Document Types",
    description: "Which document types can be created and configured. Leave empty to allow every registered type.",
    default: "",
    options: DOCUMENT_TYPE_OPTIONS
  },
  {
    key: "platform.money",
    kind: "app",
    icon: "fa-dollar-sign",
    category: "Project Delivery",
    label: "Money",
    description: "Project payment schedules, customer payment tracking, profitability, payables, and disbursements.",
    catalog_stub: "Payments, profitability, and payables.",
    default: false,
    runtime_app_id: "money"
  },
  {
    key: "platform.pricebook",
    kind: "app",
    icon: "fa-book",
    category: "Project Delivery",
    label: "Pricebook",
    description: "The Pricebook settings tab and editor.",
    catalog_stub: "Products, services, and pricing.",
    default: false,
    runtime_app_id: "pricebook"
  },
  {
    key: "platform.materials",
    kind: "app",
    icon: "fa-clipboard-list",
    category: "Project Delivery",
    requires: ["platform.pricebook"],
    label: "Materials",
    description: "Project material lists, ordering, delivery tracking, and material amendments.",
    catalog_stub: "Material lists, orders, and deliveries.",
    default: false,
    runtime_app_id: "materials"
  },
  {
    key: "platform.customer_portal",
    kind: "app",
    icon: "fa-door-open",
    category: "Sales & Customers",
    label: "Customer Portal",
    description: "Secure per-project customer portal links and portal sharing controls.",
    catalog_stub: "Secure project access for customers.",
    default: false,
    runtime_app_id: "customer-portal"
  },
  {
    key: "platform.customer_portal_media",
    kind: "feature",
    parent: "platform.customer_portal",
    requires: ["platform.project_photos"],
    label: "Customer Portal Media",
    description: "Allows project photos and videos to be shared with customer portal visitors.",
    default: false
  },
  {
    key: "canvassing.app",
    kind: "app",
    icon: "fa-map-location-dot",
    category: "Sales & Customers",
    label: "Canvassing",
    description: "Canvassing settings, canvassing APIs, and the Canvassing tab.",
    catalog_stub: "Territories, field leads, and canvassing.",
    default: false,
    runtime_app_id: "canvassing"
  },
  {
    key: "calls.app",
    kind: "app",
    icon: "fa-phone",
    category: "Sales & Customers",
    label: "Calls",
    description: "The Calls tab and call workflow settings.",
    catalog_stub: "Call workflows and phone settings.",
    default: false,
    runtime_app_id: "calls"
  },
  {
    key: "apps.messaging",
    kind: "app",
    icon: "fa-message",
    category: "Communications",
    label: "Messaging",
    description: "SMS and messaging workflows, conversations, and communications APIs.",
    catalog_stub: "Customer texts and conversations.",
    default: true
  },
  {
    key: "platform.sms_settings",
    kind: "feature",
    parent: "apps.messaging",
    label: "SMS Settings / 10DLC Registration",
    description: "Shows SMS settings and the 10DLC registration workflow.",
    default: false
  },
  {
    key: "apps.channels",
    kind: "app",
    icon: "fa-comments",
    category: "Communications",
    label: "Channels",
    description: "Internal team messaging: channels, threads, direct messages, and project messages.",
    catalog_stub: "Team channels, DMs, and project chat.",
    default: true,
    runtime_app_id: "channels"
  },
  {
    key: "channels.threads",
    kind: "feature",
    parent: "apps.channels",
    label: "Threads",
    description: "Reply to messages in Slack-style threads.",
    default: true
  },
  {
    key: "channels.reactions",
    kind: "feature",
    parent: "apps.channels",
    label: "Emoji Reactions",
    description: "React to messages with emoji.",
    default: true
  },
  {
    key: "channels.dms",
    kind: "feature",
    parent: "apps.channels",
    label: "Direct Messages",
    description: "One-on-one and small-group direct messages between teammates.",
    default: true
  },
  {
    key: "channels.attachments",
    kind: "feature",
    parent: "apps.channels",
    label: "Attachments",
    description: "Attach files and images to channel messages.",
    default: true
  },
  {
    key: "channels.pins",
    kind: "feature",
    parent: "apps.channels",
    label: "Pins & Saved Messages",
    description: "Pin messages to channels and save messages for yourself.",
    default: true
  },
  {
    key: "channels.search",
    kind: "feature",
    parent: "apps.channels",
    label: "Message Search",
    description: "Full-text search across channel messages.",
    default: true
  },
  {
    key: "channels.project_notes",
    kind: "feature",
    parent: "apps.channels",
    label: "Project Messages",
    description: "The project notes surfaces run on channels: per-project message threads with replies and history.",
    default: true
  },
  {
    key: "channels.sidebar_tab",
    kind: "feature",
    parent: "apps.channels",
    label: "Integrated Sidebar Tab",
    description: "Show channels as a tab in the portal left column instead of a standalone app; conversations open over whatever app is on screen.",
    default: false
  },
  {
    key: "apps.billing",
    kind: "app",
    category: "Billing & Credits",
    label: "Billing",
    description: "Organization billing, credits, and payment methods.",
    default: true,
    // System surface, not an optional product — never advertised in the
    // add-apps catalog.
    discoverable: false,
    runtime_app_id: "billing"
  },
  {
    key: "apps.payroll",
    kind: "app",
    icon: "fa-money-check-dollar",
    category: "Field & Workforce",
    label: "Payroll",
    description: "Payroll settings, pay runs, and compensation workflows.",
    catalog_stub: "Pay runs, compensation, and payroll.",
    default: true,
    runtime_app_id: "payroll"
  },
  {
    key: "apps.crew",
    kind: "app",
    icon: "fa-helmet-safety",
    category: "Field & Workforce",
    label: "Crew (Field App)",
    description: "The field application for crews: dashboards, assigned projects, receipts, and field workflows.",
    catalog_stub: "Field projects, receipts, and workflows.",
    default: true,
    audience: ["field"],
    runtime_app_id: "crew"
  },
  {
    key: "apps.sales",
    kind: "app",
    icon: "fa-handshake",
    category: "Field & Workforce",
    label: "Sales (Field App)",
    description: "The field application for salespeople: appointments, follow-ups, commissions, and proposal status.",
    catalog_stub: "Appointments, follow-ups, and commissions.",
    default: true,
    audience: ["field"],
    runtime_app_id: "sales"
  },
  {
    key: "apps.checklists",
    kind: "app",
    icon: "fa-list-check",
    category: "Field & Workforce",
    label: "Checklists",
    description: "Project and crew checklists, completion tracking, and supervision.",
    catalog_stub: "Project and crew task checklists.",
    default: true,
    runtime_app_id: "checklists"
  },
  {
    key: "apps.training",
    kind: "app",
    icon: "fa-graduation-cap",
    category: "Field & Workforce",
    label: "Training",
    description: "Training courses, the training studio, and role-based assignments.",
    catalog_stub: "Courses, assignments, and training tools.",
    default: true,
    runtime_app_id: "training"
  },
  {
    key: "apps.equipment",
    kind: "app",
    icon: "fa-truck-pickup",
    category: "Field & Workforce",
    label: "Equipment",
    description: "Equipment and fleet management: the equipment registry, unit records, and (with its features) scheduling, maintenance, and costing.",
    catalog_stub: "Fleet, equipment, and maintenance.",
    default: false,
    runtime_app_id: "equipment"
  },
  {
    key: "equipment.scheduling",
    kind: "feature",
    parent: "apps.equipment",
    label: "Equipment Scheduling",
    description: "Assign equipment to schedule events, generate scope equipment events, and surface availability conflicts.",
    default: true
  },
  {
    key: "equipment.requirements",
    kind: "feature",
    parent: "apps.equipment",
    requires: ["equipment.scheduling"],
    label: "Equipment Requirements",
    description: "Scope-driven equipment requirements with unit fulfillment on schedule events.",
    default: false
  },
  {
    key: "equipment.maintenance",
    kind: "feature",
    parent: "apps.equipment",
    label: "Equipment Maintenance",
    description: "Service programs, work orders, inspections, and downtime blocks for equipment units.",
    default: false
  },
  {
    key: "equipment.meters",
    kind: "feature",
    parent: "equipment.maintenance",
    label: "Equipment Meters",
    description: "Hour and mileage meter readings, fuel entries, and meter-based service intervals.",
    default: false
  },
  {
    key: "equipment.operators",
    kind: "feature",
    parent: "apps.equipment",
    label: "Operator Requirements",
    description: "Operator certification checks (CDL, certified operator) when equipment is assigned.",
    default: false
  },
  {
    key: "equipment.costing",
    kind: "feature",
    parent: "apps.equipment",
    label: "Equipment Costing",
    description: "Equipment rates, projected and actual equipment costs on projects, and utilization reporting.",
    default: false
  },
  {
    key: "equipment.custody",
    kind: "feature",
    parent: "apps.equipment",
    label: "Custody Tracking",
    description: "Check-out / check-in custody tracking and printable unit QR labels.",
    default: false
  },
  {
    key: "apps.feedback",
    kind: "app",
    icon: "fa-star",
    category: "Sales & Customers",
    label: "Feedback",
    description: "Customer feedback and review requests: branded rating pages, SMS/email invitations, review destinations, and rating capture for stats and automations.",
    catalog_stub: "Customer ratings and review requests.",
    default: false
  },
  {
    key: "feedback.review_requests",
    kind: "feature",
    parent: "apps.feedback",
    label: "Review Requests",
    description: "Sending feedback / review invitations by SMS and email.",
    default: true
  },
  {
    key: "feedback.portal_card",
    kind: "feature",
    parent: "apps.feedback",
    requires: ["platform.customer_portal"],
    label: "Customer Portal Feedback",
    description: "Shows the feedback card inside the customer portal.",
    default: false
  },
  {
    key: "feedback.portal_reviews",
    kind: "feature",
    parent: "apps.feedback",
    requires: ["platform.customer_portal", "web_editor.portal_pages"],
    label: "Customer Portal Reviews",
    description: "Shows collected customer ratings and review excerpts on designed customer portal pages.",
    default: false
  },
  {
    key: "apps.referrals",
    kind: "app",
    icon: "fa-gift",
    category: "Sales & Customers",
    label: "Referrals",
    description: "The referral program app and referral tracking.",
    catalog_stub: "Referral programs and tracking.",
    default: true,
    runtime_app_id: "referrals"
  },
  {
    key: "apps.firstmeasure",
    kind: "app",
    icon: "fa-ruler-combined",
    category: "Measurements & Reports",
    label: "FirstMeasure",
    description: "FirstMeasure roof measurement reports and related workflows.",
    catalog_stub: "Roof measurements and report workflows.",
    default: true,
    runtime_app_id: "measurements"
  },

  // --- FirstMeasure features ----------------------------------------------
  {
    key: "firstmeasure.report_orders",
    kind: "feature",
    parent: "apps.firstmeasure",
    label: "Report Orders",
    description: "Ordering FirstMeasure roof measurement reports.",
    default: true
  },
  {
    key: "firstmeasure.gutter_reports",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Gutter Reports",
    description: "Roof and gutter measurement report options.",
    default: true
  },
  {
    key: "firstmeasure.weather_reports",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Historical Weather Reports",
    description: "Historical severe-weather report ordering and project report tabs.",
    default: false
  },
  {
    key: "firstmeasure.measurement_report_summary",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Measurement Report Summary",
    description: "The gated roof report summary sub-tab in project reports.",
    default: true
  },
  {
    key: "firstmeasure.report_expedite_options",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Report Expedite Options",
    description: "Customer-facing turnaround choices for report orders.",
    default: true
  },
  {
    key: "firstmeasure.report_cancellations",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Report Cancellations",
    description: "Customer cancellation of report orders during the grace period.",
    default: true
  },
  {
    key: "firstmeasure.report_followup",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Report Follow-up",
    description: "Customer issue reports, correction requests, additional structure requests, and the Changes Pending tab.",
    default: false
  },
  {
    key: "firstmeasure.instant_reports",
    kind: "feature",
    parent: "firstmeasure.report_orders",
    label: "Instant Reports",
    description: "FirstMeasure instant report options.",
    default: false
  },
  {
    key: "firstmeasure.bonus_upfront_match",
    kind: "feature",
    parent: "apps.firstmeasure",
    label: "Bonus Upfront Match",
    description: "The upfront credit match offer.",
    default: false
  },
  {
    key: "firstmeasure.referral_program_banner",
    kind: "feature",
    parent: "apps.firstmeasure",
    label: "Referral Program Banner",
    description: "The customer referral banner.",
    default: false
  },

  // --- Sub-features of live apps (default on; presets can strip them) -------
  {
    key: "training.studio",
    kind: "feature",
    parent: "apps.training",
    label: "Training Studio",
    description: "Authoring: build and edit training courses. Viewing assigned training stays available without it.",
    default: true
  },
  {
    key: "training.assignments",
    kind: "feature",
    parent: "apps.training",
    label: "Training Assignments",
    description: "Assign courses to roles and track completion.",
    default: true
  },
  {
    key: "training.quizzes",
    kind: "feature",
    parent: "apps.training",
    label: "Training Quizzes",
    description: "Quizzes and scoring inside training courses.",
    default: true
  },
  {
    key: "payroll.pay_runs",
    kind: "feature",
    parent: "apps.payroll",
    label: "Pay Runs",
    description: "Payroll batches and pay-run history.",
    default: true
  },
  {
    key: "payroll.compensation_profiles",
    kind: "feature",
    parent: "apps.payroll",
    label: "Compensation Profiles",
    description: "Pay policies and per-user compensation setup.",
    default: true
  },
  {
    key: "payroll.commissions",
    kind: "feature",
    parent: "apps.payroll",
    label: "Commissions",
    description: "Commission events, overrides, and commission reporting.",
    default: true
  },
  {
    key: "payroll.self_service_earnings",
    kind: "feature",
    parent: "apps.payroll",
    label: "Self-Service Earnings",
    description: "Crew members can view their own payout history.",
    default: true,
    audience: ["field"]
  },
  {
    key: "crew.time_clock",
    kind: "feature",
    parent: "apps.crew",
    label: "Time Clock",
    description: "Field clock in/out. Only shown to users with an hourly pay component.",
    default: true,
    audience: ["field"],
    relevance: "hourly_compensation"
  },
  {
    key: "crew.receipts",
    kind: "feature",
    parent: "apps.crew",
    label: "Field Receipts",
    description: "Receipt capture from the field and the management receipts review tab.",
    default: true
  },
  {
    key: "crew.change_orders",
    kind: "feature",
    parent: "apps.crew",
    label: "Field Change Orders",
    description: "Crews can view and manage change orders on assigned projects.",
    default: true,
    audience: ["field"]
  },
  {
    key: "crew.field_payments",
    kind: "feature",
    parent: "apps.crew",
    requires: ["platform.money"],
    label: "Field Payments",
    description: "Crews can view and collect customer payments in the field.",
    default: true,
    audience: ["field"]
  },
  {
    key: "checklists.templates",
    kind: "feature",
    parent: "apps.checklists",
    label: "Checklist Authoring",
    description: "Create and edit checklist templates. Completing assigned checklists stays available without it.",
    default: true
  },
  {
    key: "checklists.supervision",
    kind: "feature",
    parent: "apps.checklists",
    label: "Checklist Supervision",
    description: "Supervisor review and sign-off on completed checklists.",
    default: true
  },
  {
    key: "money.profitability",
    kind: "feature",
    parent: "platform.money",
    label: "Profitability & Financials",
    description: "The Financials tab, profitability overview, and ledger views.",
    default: true
  },
  {
    key: "money.payment_schedules",
    kind: "feature",
    parent: "platform.money",
    label: "Payment Schedules",
    description: "Recurring payment schedules and invoicing.",
    default: true
  },
  {
    key: "money.invoices",
    kind: "feature",
    parent: "platform.money",
    label: "Invoices Tab",
    description: "The global Invoices tab: outstanding invoices, aging, projects that still need billing, and quick send.",
    default: false
  },
  {
    key: "money.take_payment",
    kind: "feature",
    parent: "platform.money",
    label: "Take Payments",
    description: "Collecting customer payments from the Money app.",
    default: true
  },
  {
    key: "money.merchant_processing",
    kind: "feature",
    parent: "platform.money",
    label: "Merchant Processing",
    description: "Real card and bank payment processing through the boarded merchant account (Forward). Off until the organization completes merchant onboarding.",
    default: false
  },
  {
    key: "money.expenses",
    kind: "feature",
    parent: "platform.money",
    label: "Expenses & Payables",
    description: "Expense tracking, payables, and disbursements.",
    default: true
  },
  {
    key: "crm.pipeline",
    kind: "feature",
    parent: "apps.crm",
    label: "Sales Pipeline",
    description: "The CRM pipeline board and lead workflows.",
    default: true
  },
  {
    key: "crm.automations",
    kind: "feature",
    parent: "apps.crm",
    label: "Automations",
    description: "The Automations settings tab and event-driven automation rules.",
    default: true
  },
  {
    key: "crm.call_lists",
    kind: "feature",
    parent: "apps.crm",
    label: "Call Lists",
    description: "CRM call lists and dialing workflows.",
    default: true
  },
  {
    key: "scheduling.appointment_slots",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Appointment Slots",
    description: "Bookable appointment slots and the appointment schedule view.",
    default: true
  },
  {
    key: "scheduling.appointment_confirmations",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Appointment Confirmations",
    // The real off switch is the branch module's `enabled` flag, which starts
    // false — this node exists so the whole surface can be hidden per plan.
    description: "Ask customers to confirm appointments by email or text, and flag unconfirmed appointments on the schedule.",
    default: true
  },
  {
    key: "scheduling.crew_dispatch",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Crew Dispatch",
    description: "The crew schedule and resource dispatch grid.",
    default: true
  },
  {
    key: "scheduling.routing",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Routing View",
    description: "The resource routing and dispatch view in Scheduling and project schedules.",
    default: true
  },
  {
    key: "scheduling.gantt",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Gantt Project View",
    description: "The advanced Gantt timeline with grouped work items, dependencies, and zoomable hour-to-month scales.",
    default: true
  },
  {
    key: "scheduling.travel_time",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Smart Travel Time",
    description: "Live travel-time indicators between routed stops on the sales and production schedules.",
    default: true
  },
  {
    key: "photos.markup",
    kind: "feature",
    parent: "platform.project_photos",
    label: "Photo Markup",
    description: "Drawing and markup review on project photos.",
    default: true
  },
  {
    key: "docs.markup",
    kind: "feature",
    parent: "platform.project_docs",
    label: "Document Markup",
    description: "Markup and annotation on project documents.",
    default: true
  },
  {
    key: "proposals.signing",
    kind: "feature",
    parent: "platform.proposals",
    label: "Customer Signing",
    description: "Sending proposals for customer signature.",
    default: true
  },
  {
    key: "materials.ordering",
    kind: "feature",
    parent: "platform.materials",
    label: "Material Ordering",
    description: "Ordering and delivery tracking, beyond plain material lists.",
    default: true
  },
  {
    key: "customer_portal.payments",
    kind: "feature",
    parent: "platform.customer_portal",
    requires: ["platform.money"],
    label: "Portal Payments",
    description: "Customers can pay through the customer portal.",
    default: true
  },
  {
    key: "topbar.global_search",
    kind: "setting",
    parent: "platform.top_bar",
    label: "Global Search",
    description: "The global search box in the platform header.",
    default: true
  },
  {
    key: "topbar.notifications",
    kind: "setting",
    parent: "platform.top_bar",
    label: "Notifications Bell",
    description: "The notifications bell and menu in the platform header.",
    default: true
  },

  // --- Web Editor (website builder) ----------------------------------------
  {
    key: "apps.web_editor",
    kind: "app",
    icon: "fa-globe",
    category: "Platform & Appearance",
    label: "Web Editor",
    description: "Visual website builder: host public websites and design custom customer-portal pages.",
    catalog_stub: "Build and host customer websites.",
    default: false,
    runtime_app_id: "web-editor"
  },
  {
    key: "web_editor.public_sites",
    kind: "feature",
    parent: "apps.web_editor",
    label: "Public websites",
    default: true,
    description: "Build and host public marketing websites."
  },
  {
    key: "web_editor.portal_pages",
    kind: "feature",
    parent: "apps.web_editor",
    label: "Customer portal pages",
    default: true,
    description: "Inject custom published pages into the customer portal as tabs."
  },
  {
    key: "web_editor.custom_domains",
    kind: "feature",
    parent: "apps.web_editor",
    label: "Custom domains",
    default: false,
    description: "Attach custom domains or platform subdomains to hosted sites."
  },

  // --- Platform UX settings ------------------------------------------------
  {
    key: "platform.top_bar",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Platform Top Bar",
    description: "The global search box and notifications bell in the platform header.",
    default: false
  },
  {
    key: "channels.attention_v2",
    kind: "feature",
    parent: "apps.channels",
    label: "Unreads, Activity & Threads",
    description: "Viewport-aware read state, All Unreads, durable Activity, followed threads, and notification preferences.",
    default: true
  },
  {
    key: "channels.rich_messages",
    kind: "feature",
    parent: "apps.channels",
    label: "Rich Messages & Drafts",
    description: "Formatting, synced drafts, scheduling, reminders, forwarding, and advanced message actions.",
    default: true
  },
  {
    key: "channels.resources",
    kind: "feature",
    parent: "apps.channels",
    label: "Channel Resources",
    description: "Project-aware Media, Documents, To Dos, tabs, folders, and resource cards.",
    default: true
  },
  {
    key: "channels.clips",
    kind: "feature",
    parent: "apps.channels",
    label: "Audio, Video & Screen Clips",
    description: "Record and upload asynchronous audio, camera, and screen clips.",
    default: true
  },
  {
    key: "channels.workflows",
    kind: "feature",
    parent: "apps.channels",
    label: "Channel Workflows",
    description: "Message actions, workflow shortcuts, bots, and signed webhook extension points.",
    default: true
  },
  {
    key: "channels.ai",
    kind: "feature",
    parent: "apps.channels",
    label: "Channels AI",
    description: "FirstMate Assistant conversations, summaries, recaps, and confirmed actions.",
    default: true
  },
  {
    key: "calls.rooms",
    kind: "feature",
    label: "Calls",
    description: "Reusable organization audio/video rooms for Channels, projects, appointments, and customer experiences.",
    default: true
  },
  {
    key: "crew.reimbursements",
    kind: "feature",
    parent: "apps.crew",
    requires: ["platform.money", "crew.receipts"],
    label: "Employee Reimbursements",
    description: "Crew members can identify personal purchases, request repayment, and track office or payroll settlement.",
    default: true
  },
  {
    key: "scheduling.customer_rescheduling",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Customer Self-Scheduling",
    description: "Let eligible customers choose or change appointment times from the customer portal.",
    default: false
  },
  {
    key: "scheduling.automated_rescheduling",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Guided SMS & Email Rescheduling",
    description: "Offer numbered appointment choices and process customer replies without requiring an AI agent.",
    default: false
  },
  {
    key: "scheduling.resource_availability",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Resource Availability Rules",
    description: "Apply working hours, capacity, exceptions, buffers, and crew or group rules when calculating slots.",
    default: false
  },
  {
    key: "scheduling.agent_availability",
    kind: "feature",
    parent: "platform.scheduling",
    label: "Agent Scheduling Tools",
    description: "Allow enabled agents to read authoritative availability and hold or reschedule eligible appointments.",
    default: false
  },
  {
    key: "scheduling.confirmation_release",
    kind: "feature",
    parent: "scheduling.appointment_confirmations",
    label: "Release Unconfirmed Capacity",
    description: "Allow explicitly configured appointment policies to release a reservation after its confirmation deadline.",
    default: false
  },
  {
    key: "calls.recording",
    kind: "feature",
    parent: "calls.rooms",
    label: "Call Recording",
    description: "Allow visibly indicated call recordings and retained call artifacts.",
    default: true
  },
  {
    key: "calls.record_video",
    kind: "feature",
    parent: "calls.recording",
    label: "Call Video Recording",
    description: "Include cameras and shared screens in retained call recordings when present.",
    default: true
  },
  {
    key: "channels.huddles",
    kind: "feature",
    parent: "apps.channels",
    requires: ["calls.rooms"],
    label: "Huddles & Screen Sharing",
    description: "Lightweight audio/video huddles with live screen sharing and a durable channel thread.",
    default: true
  },
  {
    key: "channels.recording",
    kind: "feature",
    parent: "channels.huddles",
    label: "Huddle Recording",
    description: "Allow visibly indicated huddle recordings, transcripts, notes, and follow-up To Dos.",
    default: true
  },
  {
    key: "channels.record_video",
    kind: "feature",
    parent: "channels.recording",
    label: "Huddle Video Recording",
    description: "Include cameras and shared screens in retained huddle recordings when present.",
    default: true
  },
  {
    key: "channels.external",
    kind: "feature",
    parent: "apps.channels",
    label: "External Collaboration",
    description: "Federated external direct messages and shared channels with restricted resource sharing.",
    default: false
  },
  {
    key: "platform.left_column_apps",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Left Column Apps",
    description: "Show the Apps navigation mode in the portal left column. When only one left-column mode is enabled, its tab header is hidden.",
    default: true
  },
  {
    key: "platform.separate_user_section",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Separate User Section",
    description: "Keep the account switcher in its own labeled section below the sidebar app launchers. Turn this off to show Settings, More Apps, and User together as icons in one footer row.",
    default: false
  },
  {
    key: "platform.advanced_app_menu",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Advanced App Menu",
    description: "Replace the More Apps pop-up with the full-screen app launcher and sidebar pinning experience.",
    default: false
  },
  {
    key: "platform.left_column_todo_list",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Left Column To Do List",
    description: "The Apps/To Do switcher and today's action-item list in the portal left column.",
    default: false
  },
  {
    key: "platform.left_column_default_mode",
    kind: "setting",
    category: "Platform & Appearance",
    type: "select",
    label: "Default Left Column",
    description: "Which enabled left-column mode opens by default. If that mode is unavailable, the first enabled mode is used.",
    default: "apps",
    options: [
      ["apps", "Apps"],
      ["todo", "To Do"],
      ["channels", "Channels"],
      ["agents", "Agents"]
    ]
  },
  {
    key: "platform.left_column_expansion_mode",
    kind: "setting",
    category: "Platform & Appearance",
    type: "select",
    label: "Collapsed Left Column Expansion",
    description: "Choose whether a temporary expansion resizes the page or overlaps it. An expansion locked with the rail arrow always resizes the page.",
    default: "resize",
    options: [
      ["resize", "Resize page"],
      ["overlap", "Overlap page"]
    ]
  },
  {
    key: "platform.always_collapsible_left_column",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Always Collapsible Left Column",
    description: "Start the portal with a compact left rail on every app. Use the rail arrow to lock it open or collapse it again.",
    default: false
  },
  {
    key: "platform.cobrand_sidebar_logo",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Co-Branded Sidebar Logo",
    description: "Shows the FirstMate logo in the org primary color before the company logo in the portal sidebar.",
    default: true
  },
  {
    key: "platform.custom_fields",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Custom Fields Settings",
    description: "Shows the Custom Fields tab in Company Settings.",
    default: true
  },
  {
    key: "platform.terminology_settings",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Terminology Settings",
    description: "Shows the Terminology tab in Company Settings.",
    default: true
  },
  {
    key: "platform.new_button_mode",
    kind: "setting",
    category: "Platform & Appearance",
    type: "select",
    label: "New Button Mode",
    description: "Whether the sidebar New button is hidden, opens the selector, or directly starts one workflow. doc:<type> actions start a new document of that type.",
    default: "report",
    options: [
      ["off", "Off"],
      ["selector", "Selector menu"],
      ...NEW_BUTTON_ITEM_OPTIONS
    ]
  },
  {
    key: "platform.new_button_items",
    kind: "setting",
    category: "Platform & Appearance",
    type: "multi_select",
    label: "New Button Menu Items",
    description: "Which actions the New button's selector menu offers. Document actions come from the document type registry; leave empty for the default menu.",
    default: "",
    options: NEW_BUTTON_ITEM_OPTIONS
  },
  {
    key: "platform.configuration",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Configuration",
    description: "Shows the Configuration settings tab.",
    default: false
  },
  {
    key: "platform.terminology_agent",
    kind: "setting",
    category: "Platform & Appearance",
    label: "Terminology Assistant",
    description: "The AI navigation and draft-editing assistant in Company Settings terminology.",
    default: false
  },
  {
    key: "platform.user_modals",
    kind: "setting",
    category: "Platform & Appearance",
    label: "User Modals",
    description: "Clickable user profile modals with uploaded-photo views.",
    default: false
  },
  {
    key: "platform.user_activity",
    kind: "setting",
    parent: "platform.user_modals",
    label: "User Activity",
    description: "Activity streams in user profile modals.",
    default: false
  },

  { key: "platform.advanced_ai", kind: "feature", label: "Advanced AI", description: "Optional Advanced AI subscription; Basic AI remains included.", requires: ["platform.expanded_access"], default: false },

  // --- Storage --------------------------------------------------------------
  {
    key: "platform.storage_limits",
    kind: "setting",
    category: "Storage",
    label: "Storage Limits",
    description: "Shows storage usage and enforces media upload limits.",
    default: false
  },
  {
    key: "platform.free_storage_gb",
    kind: "setting",
    parent: "platform.storage_limits",
    type: "number",
    label: "Free Storage GB",
    description: "Included media storage in gigabytes before upload limits apply.",
    default: 1,
    min: 0,
    step: 0.25
  },
  {
    key: "platform.purchasable_storage",
    kind: "setting",
    parent: "platform.storage_limits",
    label: "Purchasable Storage",
    description: "Shows storage checkout entry points.",
    default: false
  },

  // --- Management permissions ------------------------------------------------
  {
    key: "permission.view_projects",
    kind: "permission",
    parent: "apps.projects",
    permission_key: "view_projects",
    access: "read",
    label: "View Projects",
    description: "See projects, project data, payments, materials, and proposals."
  },
  {
    key: "permission.manage_projects",
    kind: "permission",
    parent: "apps.projects",
    permission_key: "manage_projects",
    access: "write",
    label: "Manage Projects",
    description: "Create and edit projects, proposals, payments, and materials."
  },
  {
    key: "permission.view_reports",
    kind: "permission",
    parent: "apps.firstmeasure",
    permission_key: "view_reports",
    access: "read",
    label: "View Reports",
    description: "See ordered measurement reports."
  },
  {
    key: "permission.order_reports",
    kind: "permission",
    parent: "apps.firstmeasure",
    permission_key: "order_reports",
    access: "write",
    label: "Order Reports",
    description: "Order measurement reports and spend report credits."
  },
  {
    key: "permission.manage_report_settings",
    kind: "permission",
    parent: "apps.firstmeasure",
    permission_key: "manage_report_settings",
    access: "write",
    label: "Manage Report Settings",
    description: "Change measurement report defaults and settings."
  },
  {
    key: "permission.manage_schedule",
    kind: "permission",
    parent: "platform.scheduling",
    permission_key: "manage_schedule",
    access: "write",
    label: "Manage Schedule",
    description: "Create and edit appointments and scheduling slots."
  },
  {
    key: "permission.view_appointment_confirmation",
    kind: "permission",
    parent: "scheduling.appointment_confirmations",
    permission_key: "view_appointment_confirmation",
    access: "read",
    label: "View Appointment Confirmation Status",
    description: "See whether a customer has confirmed an appointment. Companies that would rather their sales team not see unconfirmed appointments can withhold this."
  },
  {
    key: "permission.send_communications",
    kind: "permission",
    parent: "apps.messaging",
    permission_key: "send_communications",
    access: "write",
    label: "Send Communications",
    description: "Send SMS and messaging conversations to customers."
  },
  {key:'permission.make_calls',kind:'permission',parent:'apps.messaging',permission_key:'make_calls',access:'write',label:'Make Customer Calls',description:'Use call lists, log outcomes, and place customer calls through enabled voice service.'},
  {key:'permission.manage_communications',kind:'permission',parent:'apps.messaging',permission_key:'manage_communications',access:'write',label:'Manage Communications',description:'Manage shared call lists, scripts, assignments, voice routing, and call recovery.'},
  {key:'permission.record_calls',kind:'permission',parent:'apps.messaging',permission_key:'record_calls',access:'write',label:'Record Customer Calls',description:'Start consent-controlled recording on connected customer calls.'},
  {key:'permission.view_call_recordings',kind:'permission',parent:'apps.messaging',permission_key:'view_call_recordings',access:'read',label:'View Customer Call Recordings',description:'Access permitted customer call recordings and transcripts.'},
  {
    key: "permission.create_channels",
    kind: "permission",
    parent: "apps.channels",
    permission_key: "create_channels",
    access: "write",
    label: "Create Channels",
    description: "Create public and private team messaging channels."
  },
  {
    key: "permission.manage_channels",
    kind: "permission",
    parent: "apps.channels",
    permission_key: "manage_channels",
    access: "write",
    label: "Manage Channels",
    description: "Edit or archive any channel, manage members, and remove or restore any message."
  },
  {
    key: "permission.manage_sales",
    kind: "permission",
    parent: "apps.crm",
    permission_key: "manage_sales",
    access: "write",
    label: "Manage Sales",
    description: "Work CRM pipeline records and sales workflows."
  },
  {
    key: "permission.manage_billing",
    kind: "permission",
    parent: "apps.billing",
    permission_key: "manage_billing",
    access: "write",
    label: "Manage Billing",
    description: "Change billing settings, payment methods, and credits."
  },
  {
    key: "permission.manage_payroll",
    kind: "permission",
    parent: "apps.payroll",
    permission_key: "manage_payroll",
    access: "write",
    label: "Manage Payroll",
    description: "Run payroll and edit compensation settings."
  },
  {
    key: "permission.equipment_view",
    kind: "permission",
    parent: "apps.equipment",
    permission_key: "equipment.view",
    access: "read",
    label: "View Equipment",
    description: "See the equipment registry, units, and availability."
  },
  {
    key: "permission.equipment_manage",
    kind: "permission",
    parent: "apps.equipment",
    permission_key: "equipment.manage",
    access: "write",
    label: "Manage Equipment",
    description: "Create and edit equipment types, units, and equipment module settings."
  },
  {
    key: "permission.equipment_service",
    kind: "permission",
    parent: "apps.equipment",
    permission_key: "equipment.service",
    access: "write",
    label: "Service Equipment",
    description: "Log meter readings and work service and maintenance workflows."
  },
  {
    key: "permission.manage_company_settings",
    kind: "permission",
    permission_key: "manage_company_settings",
    access: "write",
    label: "Manage Company Settings",
    description: "Edit organization-wide settings, templates, and configuration."
  },
  {
    key: "permission.manage_company_users",
    kind: "permission",
    permission_key: "manage_company_users",
    access: "write",
    label: "Manage Company Users",
    description: "Invite, edit, and disable organization users."
  },
  {
    key: "permission.manage_company_user_permissions",
    kind: "permission",
    permission_key: "manage_company_user_permissions",
    access: "write",
    label: "Manage User Permissions",
    description: "Change other users' permission sets and roles."
  },

  // --- Crew (field) permissions ----------------------------------------------
  {
    key: "permission.crew_dashboard_view",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.dashboard.view",
    access: "read",
    audience: ["field"],
    label: "Crew Dashboard",
    description: "See the crew dashboard."
  },
  {
    key: "permission.crew_projects_view",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.projects.view",
    access: "read",
    audience: ["field"],
    label: "View Assigned Projects",
    description: "See projects assigned to the user or their crew."
  },
  {
    key: "permission.crew_projects_view_all_production",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.projects.view_all_production",
    access: "read",
    audience: ["field"],
    label: "View All Production Projects",
    description: "Supervisor scope: see every production project, not just assigned ones."
  },
  {
    key: "permission.crew_schedule_view",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.scheduling"],
    permission_key: "crew.schedule.view",
    access: "read",
    audience: ["field"],
    label: "View Schedule",
    description: "See the crew schedule."
  },
  {
    key: "permission.crew_time_clock_use",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.time_clock.use",
    access: "write",
    audience: ["field"],
    relevance: "hourly_compensation",
    label: "Time Clock",
    description: "Clock in and out. Only shown to users with an hourly pay component."
  },
  {
    key: "permission.crew_receipts_upload",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.receipts.upload",
    access: "write",
    audience: ["field"],
    label: "Upload Receipts",
    description: "Upload purchase receipts from the field."
  },
  {
    key: "permission.crew_reimbursements_request",
    kind: "permission",
    parent: "apps.crew",
    requires: ["crew.reimbursements"],
    permission_key: "crew.reimbursements.request",
    access: "write",
    audience: ["field"],
    label: "Request Reimbursements",
    description: "Identify personal purchases and submit receipt-backed reimbursement requests."
  },
  {
    key: "permission.crew_materials_view",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.materials"],
    permission_key: "crew.materials.view",
    access: "read",
    audience: ["field"],
    label: "View Materials",
    description: "See project material lists."
  },
  {
    key: "permission.crew_materials_append",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.materials"],
    permission_key: "crew.materials.append",
    access: "write",
    audience: ["field"],
    label: "Append Materials",
    description: "Add material amendments from the field."
  },
  {
    key: "permission.crew_payouts_view",
    kind: "permission",
    parent: "apps.crew",
    requires: ["apps.payroll"],
    permission_key: "crew.payouts.view",
    access: "read",
    audience: ["field"],
    label: "View Payouts",
    description: "See personal payout history."
  },
  {
    key: "permission.crew_checklists_view",
    kind: "permission",
    parent: "apps.crew",
    requires: ["apps.checklists"],
    permission_key: "crew.checklists.view",
    access: "read",
    audience: ["field"],
    label: "View Checklists",
    description: "See assigned checklists."
  },
  {
    key: "permission.crew_checklists_complete",
    kind: "permission",
    parent: "apps.crew",
    requires: ["apps.checklists"],
    permission_key: "crew.checklists.complete",
    access: "write",
    audience: ["field"],
    label: "Complete Checklists",
    description: "Complete checklist items in the field."
  },
  {
    key: "permission.crew_checklists_manage",
    kind: "permission",
    parent: "apps.crew",
    requires: ["apps.checklists"],
    permission_key: "crew.checklists.manage",
    access: "write",
    audience: ["field"],
    label: "Manage Checklists",
    description: "Create and edit checklists."
  },
  {
    key: "permission.crew_checklists_supervise",
    kind: "permission",
    parent: "apps.crew",
    requires: ["apps.checklists"],
    permission_key: "crew.checklists.supervise",
    access: "write",
    audience: ["field"],
    label: "Supervise Checklists",
    description: "Review and sign off on crew checklist completion."
  },
  {
    key: "permission.crew_payments_view",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.money"],
    permission_key: "crew.payments.view",
    access: "read",
    audience: ["field"],
    label: "View Customer Payments",
    description: "See customer payment status on assigned projects."
  },
  {
    key: "permission.crew_signatures_present",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.documents", "documents.esign"],
    permission_key: "crew.signatures.present",
    access: "write",
    audience: ["field"],
    label: "Collect Customer Signatures",
    description: "Present required documents and collect customer signatures in person from a mobile device."
  },
  {
    key: "permission.crew_payments_take",
    kind: "permission",
    parent: "apps.crew",
    requires: ["platform.money"],
    permission_key: "crew.payments.take",
    access: "write",
    audience: ["field"],
    label: "Take Customer Payments",
    description: "Collect customer payments in the field."
  },
  {
    key: "permission.crew_change_orders_view",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.change_orders.view",
    access: "read",
    audience: ["field"],
    label: "View Change Orders",
    description: "See change orders on assigned projects."
  },
  {
    key: "permission.crew_change_orders_manage",
    kind: "permission",
    parent: "apps.crew",
    permission_key: "crew.change_orders.manage",
    access: "write",
    audience: ["field"],
    label: "Manage Change Orders",
    description: "Create and edit change orders in the field."
  },

  // --- Sales (field) permissions ---------------------------------------------
  {
    key: "permission.sales_dashboard_view",
    kind: "permission",
    parent: "apps.sales",
    permission_key: "sales.dashboard.view",
    access: "read",
    audience: ["field"],
    label: "Sales Dashboard",
    description: "See the sales Today dashboard: appointments, follow-ups, and pipeline pulse."
  },
  {
    key: "permission.sales_schedule_view",
    kind: "permission",
    parent: "apps.sales",
    requires: ["platform.scheduling"],
    permission_key: "sales.schedule.view",
    access: "read",
    audience: ["field"],
    label: "View Sales Schedule",
    description: "See past and upcoming sales appointments."
  },
  {
    key: "permission.sales_followups_manage",
    kind: "permission",
    parent: "apps.sales",
    permission_key: "sales.followups.manage",
    access: "write",
    audience: ["field"],
    label: "Manage Own Follow-ups",
    description: "Create, claim, and resolve the salesperson's own follow-ups."
  },
  {
    key: "permission.sales_earnings_view",
    kind: "permission",
    parent: "apps.sales",
    requires: ["apps.payroll"],
    permission_key: "sales.earnings.view",
    access: "read",
    audience: ["field"],
    label: "View Commission Earnings",
    description: "See personal commission and earnings history."
  },
  {
    key: "permission.sales_documents_view_status",
    kind: "permission",
    parent: "apps.sales",
    requires: ["platform.proposals"],
    permission_key: "sales.documents.view_status",
    access: "read",
    audience: ["field"],
    label: "View Proposal Status",
    description: "See whether proposals and documents are sent, signed, or paid."
  },
  {
    key: "permission.sales_money_view_status",
    kind: "permission",
    parent: "apps.sales",
    requires: ["platform.money"],
    permission_key: "sales.money.view_status",
    access: "read",
    audience: ["field"],
    label: "View Payment Status",
    description: "See payment status chips on own projects without amounts."
  },
  {
    key: "permission.sales_stats_view_own",
    kind: "permission",
    parent: "apps.sales",
    requires: ["apps.stats"],
    permission_key: "sales.stats.view_own",
    access: "read",
    audience: ["field"],
    label: "View Own Sales Stats",
    description: "See personal close rate, appointments run, and revenue sold."
  },
  {
    key: "permission.sales_stats_view_team",
    kind: "permission",
    parent: "apps.sales",
    requires: ["apps.stats"],
    permission_key: "sales.stats.view_team",
    access: "read",
    audience: ["field"],
    label: "View Team Sales Stats",
    description: "See the team leaderboard across salespeople."
  },
  // Business permissions group published data and actions. These are separate
  // from the seven FirstMeasure permissions retained for existing accounts.
  ...([
    ["view_contacts", "apps.projects", "read", "View Contacts", "Read customer and contact records."],
    ["view_schedule", "platform.scheduling", "read", "View Schedule", "Read project calendars and availability."],
    ["view_financials", "platform.money", "read", "View Financials", "Read project finances and the organization ledger."],
    ["manage_project_billing", "platform.money", "write", "Manage Project Billing", "Create and update project invoices and payments."],
    ["refund_payments", "platform.money", "write", "Refund Payments", "Issue customer payment refunds."],
    ["view_documents", "platform.documents", "read", "View Documents", "Read project documents and published document values."],
    ["manage_documents", "platform.documents", "write", "Manage Documents", "Edit document workflows and generated documents."],
    ["issue_documents", "platform.documents", "write", "Issue Documents", "Issue documents to customers."],
    ["view_materials", "platform.materials", "read", "View Materials", "Read project material lists and orders."],
    ["view_proposals", "platform.proposals", "read", "View Proposals", "Read project proposals."],
    ["manage_proposals", "platform.proposals", "write", "Manage Proposals", "Create and edit project proposals."],
    ["send_proposals", "platform.proposals", "write", "Send Proposals", "Send proposals to customers."],
    ["view_stats", "apps.stats", "read", "View Statistics", "Query statistics and read dashboards."],
    ["manage_stats", "apps.stats", "write", "Manage Statistics", "Refresh statistics and edit dashboards."],
    ["view_websites", "apps.web_editor", "read", "View Websites", "Read company website designs."],
    ["manage_websites", "apps.web_editor", "write", "Manage Websites", "Edit and discard website drafts."],
    ["publish_websites", "apps.web_editor", "write", "Publish Websites", "Publish website pages."],
    ["view_pricebook", "platform.pricebook", "read", "View Price Book", "Read published price book items and calculations."],
    ["view_feedback", "apps.feedback", "read", "View Feedback", "Read customer feedback status."],
    ["request_feedback", "apps.feedback", "write", "Request Feedback", "Send customer feedback requests."],
    ["view_canvassing", "canvassing.app", "read", "View Canvassing", "Read canvassing pins."],
    ["manage_canvassing", "canvassing.app", "write", "Manage Canvassing", "Create and edit canvassing pins."],
    ["view_media", "platform.photos_feed", "read", "View Media", "Read permitted media metadata."],
    ["manage_media", "platform.photos_feed", "write", "Manage Media", "Rename permitted project media."],
    ["view_customer_portals", "platform.customer_portal", "read", "View Customer Portals", "Read customer portal metadata."],
    ["manage_customer_portals", "platform.customer_portal", "write", "Manage Customer Portals", "Create and configure customer portals."],
    ["view_project_data", "apps.projects", "read", "View Project Data", "Read published project datasets."],
    ["manage_project_data", "apps.projects", "write", "Manage Project Data", "Save and select project datasets."],
    ["manage_training", "apps.training", "write", "Manage Training", "Manage training assignments and course progress."]
  ] as const).map(([permission_key, parent, access, label, description]) => ({
    key: `permission.${permission_key}`,
    kind: "permission" as const,
    parent,
    permission_key,
    access,
    label,
    description
  }))
];
registerCapabilities(definitions);

// Fail fast: a structurally invalid registry should stop the server (and any
// test) at import time, not resolve inconsistently at request time.
validateCapabilityRegistry();
