import { registerAssigneeCleanup } from "../assignees/base.js";
import type { Assignee } from "../labor/assignees.js";
import { closePaySetup, ensurePayRuleSchema, readPaySetup } from "./pay-rules.js";
import { getPayrollDatabase, listPayrollLedgerEntries } from "./storage.js";

/**
 * What payroll does when an assignee is removed: it keeps everything. Someone who did the work must still be paid,
 * so their ledger entries (paid or not), the results their rules last worked out, their pay setup and the record of
 * which defaults covered them all stay exactly as they are. The only change is that the setup is marked closed, so
 * no new earnings are worked out for them. Earnings already accrued stay payable in the next pay run.
 *
 * Loading this module registers the step. `assignees/base.ts` loads the modules named in its `cleanupOwners` before a
 * cleanup runs; until payroll is listed there the step is registered when the payroll publication is (at startup).
 */
export async function keepPayAfterRemoval(orgId: string, payee: Assignee, actor: { userId: string }) {
  await ensurePayRuleSchema();
  const db = getPayrollDatabase();
  const where = [orgId, payee.type, payee.id];
  const count = async (table: string) => Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id=? AND payee_type=? AND payee_id=?`).get(...where))?.n || 0);
  const entries = await count("payroll_ledger_entries");
  const results = await count("pay_rule_units");
  const unpaid = (await listPayrollLedgerEntries(orgId, { payee_type: payee.type, payee_id: payee.id, state: "accrued", open_only: true, limit: 5000 })).reduce((sum, entry) => sum + entry.remaining_cents, 0);
  const setup = await readPaySetup(orgId, payee);
  const hadSetup = setup.revision > 0;
  if (hadSetup) await closePaySetup(orgId, payee, actor);
  const kept = entries + results + (hadSetup ? 1 : 0);
  const parts = [
    `${entries} ledger ${entries === 1 ? "entry" : "entries"}`,
    `${results} worked-out ${results === 1 ? "result" : "results"}`,
    ...(hadSetup ? ["their pay setup, now closed"] : [])
  ];
  return {
    removed: 0, kept,
    detail: kept ? `Kept ${parts.join(", ")}.${unpaid ? ` ${(unpaid / 100).toFixed(2)} earned and not yet paid stays payable in the next pay run.` : ""} No new earnings are worked out for them.` : ""
  };
}

let registered = false;
/** Registers payroll's step with the assignee cleanup. Safe to call more than once. */
export function registerPayrollAssigneeCleanup() {
  if (registered) return;
  registered = true;
  registerAssigneeCleanup("payroll-pay", (orgId, assignee, actor) => keepPayAfterRemoval(orgId, assignee, { userId: String(actor?.userId || "") }));
}
registerPayrollAssigneeCleanup();
