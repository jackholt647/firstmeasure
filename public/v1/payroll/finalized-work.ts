/**
 * Work orders finalized to be paid (docs/architecture/closeout.md) and the earnings their pay rules produced. A
 * labor list's work is earned when it is finalized: a rule that reads `labor_commitments` (the sample
 * `committed_labor`) earns on `finalized_at`, one record per commitment, so the earning's `metadata.pay_rule.unit`
 * is the commitment id. A finalized work order with no earning yet is waiting for an earnings refresh, or its
 * assignee is not paid by a rule that reads committed labor. Reads only.
 */
import { listCompletions } from "../labor/completion.js";
import { readDocument } from "../platform/storage.js";
import type { PayeeScope } from "./payee-scope.js";
import { asObject, cleanText, listPayrollLedgerEntries, type JsonObject } from "./storage.js";

export async function finalizedWorkToPay(orgId: string, scope?: PayeeScope) {
  const completions = (await listCompletions(orgId)).filter((entry) => entry.state === "finalized")
    .filter((entry) => !scope || scope.visible(entry.assignee));
  const ids = new Set(completions.map((entry) => entry.pay_unit || entry.commitment_id)); // a payout of part of a list earns under its own row
  const earnings = new Map<string, JsonObject[]>();
  for (const entry of await listPayrollLedgerEntries(orgId, { limit: 5000 })) {
    const unit = cleanText(asObject(asObject(entry.metadata).pay_rule).unit);
    if (!ids.has(unit) || cleanText(entry.state) === "void") continue;
    earnings.set(unit, [...(earnings.get(unit) || []), entry]);
  }
  const titles = new Map<string, string>();
  for (const projectId of new Set(completions.map((entry) => entry.project_id).filter(Boolean))) {
    const project = await readDocument(orgId, "projects", projectId).catch(() => null);
    const data = asObject(project?.data);
    titles.set(projectId, cleanText(data.title || data.name || data.address) || projectId);
  }
  const rows = completions.map((completion) => {
    const produced = (earnings.get(completion.pay_unit || completion.commitment_id) || []).map((entry) => ({
      id: cleanText(entry.id), payee: asObject(entry.payee), kind: cleanText(entry.kind), state: cleanText(entry.state),
      amount_cents: Number(entry.amount_cents || 0), applied_cents: Number(entry.applied_cents || 0), remaining_cents: Number(entry.remaining_cents || 0),
      description: cleanText(entry.description), held: asObject(entry.metadata).review_required === true
    }));
    const accrued = produced.filter((entry) => entry.state === "accrued");
    const earned = accrued.reduce((sum, entry) => sum + entry.amount_cents, 0);
    const applied = accrued.reduce((sum, entry) => sum + entry.applied_cents, 0);
    return {
      id: completion.id, commitment_id: completion.commitment_id, list_id: completion.list_id, list_title: completion.list_title,
      project_id: completion.project_id, project_title: titles.get(completion.project_id) || "",
      assignee: completion.assignee, total_cents: completion.total_cents, unpriced_lines: completion.unpriced_lines,
      finalized_at: completion.finalized_at, finalized_by_user_id: completion.finalized_by_user_id, method: completion.method,
      earnings: produced, earned_cents: earned, in_pay_run_cents: applied,
      /** not_earned: no earning yet. waiting: earned, not in a pay run. in_pay_run: some or all of it is in one. */
      pay_state: !accrued.length ? "not_earned" : applied === 0 ? "waiting" : "in_pay_run"
    };
  });
  return rows.sort((left, right) => right.finalized_at.localeCompare(left.finalized_at));
}
