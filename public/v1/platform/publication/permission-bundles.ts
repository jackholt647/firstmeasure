/**
 * Permission bundles are the stable middle layer between published operations
 * and workforce roles. An operation has one business permission; roles grant
 * sets of permissions. Resource, app, feature and tenant rules still apply.
 *
 * This catalog covers the built-in API/agent publication surface. An explicit
 * empty permission means authenticated subject access (for example, a channel
 * member reading that channel), not unrestricted access.
 */
const bundles: Record<string, { actions?: readonly string[]; data?: readonly string[] }> = {
  view_projects: { actions: ["projects.search", "work.plan.read", "work.project.projection", "customFields.defaults.compute"], data: ["projects.record", "work.records", "organization.profile", "referrals.eligibility"] },
  manage_projects: { actions: ["projects.lead.create", "work.node.patch", "work.node.transition"] },
  view_contacts: { data: ["customers.record"] },
  view_schedule: { actions: ["scheduling.availability"], data: ["calendar.record"] },
  manage_schedule: { actions: ["scheduling.slot.hold", "scheduling.confirmation.set", "scheduling.reschedule.review"] },
  view_financials: { actions: ["payments.ledger.list", "payments.project.summary"], data: ["payments.records", "financials.records"] },
  manage_project_billing: { actions: ["payments.invoice.create", "payments.invoice.due", "payments.invoice.void", "payments.payment.clear"] },
  refund_payments: { actions: ["payments.payment.refund"] },
  manage_billing: { data: ["billing.balance"] },
  view_documents: { actions: ["documents.instance.read"], data: ["documents.params", "documents.outputs", "document-modules.value"] },
  manage_documents: { actions: ["documents.workflow.update", "document-modules.instance.create", "document-modules.instance.refresh", "document-modules.instance.command", "document-modules.instance.freeze", "document-modules.export.write", "document-modules.document.generate", "document-modules.document.materialize"] },
  issue_documents: { actions: ["documents.instance.issue"] },
  view_materials: { actions: ["materials.project.lists", "materials.list.read", "materials.order.read"], data: ["materials.record"] },
  view_proposals: { actions: ["proposals.project.list"], data: ["proposals.record"] },
  manage_proposals: { actions: ["proposals.create", "proposals.patch", "proposals.snapshot"] },
  send_proposals: { actions: ["proposals.send"] },
  view_stats: { actions: ["stats.schema", "stats.query", "stats.views.list"], data: ["stats.records"] },
  manage_stats: { actions: ["stats.refresh", "stats.view.fromPreset"] },
  view_websites: { actions: ["websites.sites.list"], data: ["websites.record"] },
  manage_websites: { actions: ["websites.page.discard"] },
  publish_websites: { actions: ["websites.page.publish"] },
  view_pricebook: { actions: ["pricebook.catalog.validate", "pricebook.item.resolve"], data: ["pricebook.items"] },
  view_feedback: { actions: ["feedback.project.summary"], data: ["feedback.record"] },
  request_feedback: { actions: ["feedback.project.request"] },
  view_canvassing: { actions: ["canvassing.pins.list"], data: ["canvassing.records"] },
  manage_canvassing: { actions: ["canvassing.pin.save"] },
  view_media: { actions: ["media.item.read"], data: ["media.metadata"] },
  manage_media: { actions: ["media.item.rename"] },
  view_comms: { actions: ["comms.project.feed"], data: ["comms.records"] },
  send_communications: { actions: ["comms.project.sendSms", "comms.project.sendEmail"] },
  view_live_chat: { actions: ["chat.inbox"], data: ["chat.records"] },
  send_live_chat: { actions: ["chat.conversation.claim", "chat.conversation.release", "chat.conversation.send"] },
  view_customer_portals: { data: ["customer-portal.record"] },
  manage_customer_portals: { actions: ["customerPortal.ensure"] },
  view_project_data: { data: ["datasets.contract", "datasets.value"] },
  manage_project_data: { actions: ["datasets.save", "datasets.select", "firstmeasure.measurements.import"] },
  view_reports: { actions: ["referrals.customer.ensure"], data: ["firstmeasure.status", "firstmeasure.measurements"] },
  order_reports: { actions: ["firstmeasure.exteriors.quote"] },
  manage_payroll: { actions: ["payroll.upcoming.read"], data: ["payroll.records"] },
  "equipment.view": { actions: ["equipment.fleet.list", "equipment.unit.history"], data: ["equipment.records"] },
  "equipment.service": { actions: ["equipment.maintenance.cancel", "equipment.maintenance.complete", "equipment.maintenance.open", "equipment.meter.record", "equipment.unit.checkIn", "equipment.unit.checkOut"] },
  manage_company_users: { actions: ["workforce.users.list"], data: ["workforce.records"] },
  manage_company_settings: { data: ["scopes.records"] },
  manage_training: { actions: ["training.course.progress"] },
  // Membership and per-subject checks are the permission for these exports.
  "": { actions: ["channels.list", "channels.messages.list", "channels.message.react", "training.courses.mine"], data: ["channels.records", "training.records"] }
};

function index(kind: "actions" | "data") {
  const result = new Map<string, string>();
  for (const [permission, group] of Object.entries(bundles)) {
    for (const operation of group[kind] || []) {
      if (result.has(operation)) throw new Error(`Published ${kind} operation ${operation} belongs to two permission bundles.`);
      result.set(operation, permission);
    }
  }
  return result;
}

const actionPermissions = index("actions");
const dataPermissions = index("data");
export function publishedActionPermission(id: string): string | undefined { return actionPermissions.get(id); }
export function publishedDataPermission(id: string): string | undefined { return dataPermissions.get(id); }
export function publishedPermissionBundles() { return bundles; }
