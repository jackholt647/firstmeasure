import type { WorkAutomationContext } from "../work/registry.js";
import { registerWorkAutomation } from "../work/registry.js";
import { ASSIGNEE_TYPES, type Assignee } from "../labor/assignees.js";
import { refreshOrganizationEarnings } from "./pay-refresh.js";
import { cleanText, type JsonObject } from "./storage.js";

let registered = false;
const recent = new Map<string, { at: number; run: ReturnType<typeof refreshOrganizationEarnings> }>();

/**
 * Works out earnings from pay rules when an automation asks for them, for
 * example on a schedule before notifying people what they are owed. A rule
 * that runs once per project would otherwise refresh the whole organization
 * once per project, so runs for everyone within a minute share one refresh.
 */
async function refreshEarnings(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const type = cleanText(input.payee_type), id = cleanText(input.payee_id);
  const payee = id && (ASSIGNEE_TYPES as readonly string[]).includes(type) ? { type, id } as Assignee : null;
  const summarize = (result: Awaited<ReturnType<typeof refreshOrganizationEarnings>>) => ({
    payee_count: result.payees.length, posted_count: result.posted_count, posted_cents: result.posted_cents, held_count: result.held_count, unresolved_count: result.unresolved_count
  });
  if (payee) return summarize(await refreshOrganizationEarnings(orgId, { payees: [payee] }));
  const last = recent.get(orgId);
  if (last && Date.now() - last.at < 60_000) return summarize(await last.run);
  const run = refreshOrganizationEarnings(orgId);
  recent.set(orgId, { at: Date.now(), run });
  run.catch(() => recent.delete(orgId));
  return summarize(await run);
}

export function registerPayrollAutomations() {
  if (registered) return;
  registered = true;
  registerWorkAutomation("payroll.refreshEarnings.v1", refreshEarnings, {
    description: "Works out what payees have earned from their pay rules and posts any difference to the payroll ledger.",
    input: { payee_type: "Refresh one payee: organization_user, resource_group or organization_connection.", payee_id: "That payee's id. Leave both out to refresh everyone." }
  });
}
