/** Permission keys the field and sales apps publish (docs/architecture/permissions-and-agents.md). */
export const CREW_PERMISSION_KEYS = Object.freeze({
  dashboard_view: "crew.dashboard.view",
  projects_view: "crew.projects.view",
  projects_view_all_production: "crew.projects.view_all_production",
  schedule_view: "crew.schedule.view",
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

/** Payroll permissions a payee holds about their own pay. Seeded roles grant them by default. */
export const PAYROLL_PERMISSION_KEYS = Object.freeze({
  view_own_projected_earnings: "payroll.view_own_projected_earnings"
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
