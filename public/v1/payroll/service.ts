import type { SqlStore } from "../platform/sql_store.js";

import { badRequest, conflict } from "../platform/errors.js";
import { payrollEligibleAt, payrollOccurrence, payrollOccurrences } from "./schedule.js";
import type { PayrollLedgerEntryInput, PayrollPayeeRef } from "./schemas.js";
import {
  asArray,
  asObject,
  cleanText,
  generatedId,
  getPayrollDatabase,
  listPayrollBatches,
  listPayrollLedgerEntries,
  listPayrollSchedules,
  listProjectPayees,
  nowIso,
  readPayrollBatch,
  readPayrollBatchItem,
  readPayrollLedgerEntry,
  readPayrollSchedule,
  resolvePayrollPolicy,
  upsertPayrollLedgerEntry,
  voidPayrollLedgerEntry,
  withPayrollTransaction,
  type JsonObject
} from "./storage.js";

// Record automation events in the same database transaction as payroll changes.
// A worker forwards them with the original idempotency key after commit.
async function publishPayrollWorkEvent(input: JsonObject) {
  await getPayrollDatabase().prepare(`INSERT INTO payroll_work_outbox (id, payload_json, created_at)
    VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .run(`${cleanText(input.organization_id)}:${cleanText(input.idempotency_key)}`, JSON.stringify(input), nowIso());
}
export async function drainPayrollWorkEvents(limit = 50) {
  const db = getPayrollDatabase();
  const rows = await db.prepare("SELECT id,payload_json,attempts FROM payroll_work_outbox WHERE state='pending' AND retry_at<=? ORDER BY created_at LIMIT ?").all(nowIso(), limit);
  const { emitWorkEvent } = await import("../work/engine.js");
  let delivered = 0;
  for (const row of rows) {
    try {
      const event = await emitWorkEvent(JSON.parse(String(row.payload_json)), { process: false });
      if (!event) throw new Error("Work event was not persisted.");
      if (event.status === "disabled") {
        // Preserve pending payroll notifications while an operator pauses rollout.
        await db.prepare("UPDATE payroll_work_outbox SET retry_at=? WHERE id=?").run(new Date(Date.now() + 60000).toISOString(), String(row.id));
        continue;
      }
      await db.prepare("DELETE FROM payroll_work_outbox WHERE id=?").run(String(row.id));
      delivered++;
    } catch (error) {
      // Missing/deleted organizations and malformed payloads need review. Retain
      // their audit records without starving healthy organizations behind them.
      const permanent = error instanceof SyntaxError || Number((error as { statusCode?: number })?.statusCode) === 404;
      const attempts = Number(row.attempts || 0) + 1;
      const delay = Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12));
      await db.prepare("UPDATE payroll_work_outbox SET state=?,attempts=?,retry_at=?,last_error=? WHERE id=?")
        .run(permanent ? "blocked" : "pending", attempts, new Date(Date.now() + delay).toISOString(),
          String(error instanceof Error ? error.message : error).slice(0, 1000), String(row.id));
    }
  }
  return delivered;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function entryPayee(entry: JsonObject): PayrollPayeeRef {
  const payee = asObject(entry.payee);
  const workerType = cleanText(payee.worker_type);
  return {
    type: cleanText(payee.type) === "organization_connection" ? "organization_connection" : "organization_user",
    id: cleanText(payee.id),
    name: cleanText(payee.name),
    worker_type: ["subcontractor", "independent_contractor"].includes(workerType) ? workerType as PayrollPayeeRef["worker_type"] : "employee"
  };
}

async function normalizedLedgerInput(orgId: string, inputValue: PayrollLedgerEntryInput & JsonObject) {
  const input = { ...inputValue };
  const policy = cleanText(input.schedule_id) ? null : (await resolvePayrollPolicy(orgId, input.payee, input.kind));
  const scheduleId = cleanText(input.schedule_id || policy?.schedule_id);
  const unscheduledKind = !scheduleId && ["commission", "reimbursement"].includes(cleanText(input.kind));
  if (!scheduleId && !unscheduledKind) {
    throw badRequest("payroll_schedule_unresolved", `No payroll schedule is configured for ${input.payee.name || input.payee.id} (${input.kind}).`);
  }
  const schedule = scheduleId ? (await readPayrollSchedule(orgId, scheduleId)) : null;
  if (schedule?.status === "archived") throw badRequest("payroll_schedule_archived", "New payroll entries cannot use an archived schedule.");
  const timingBasis = cleanText(policy?.timing_basis || schedule?.timing_basis || (unscheduledKind ? "completed" : "worked"));
  return {
    ...input,
    schedule_id: scheduleId,
    subgroup: cleanText(input.subgroup || input.kind),
    state: input.state || "accrued",
    eligible_at: payrollEligibleAt(input, timingBasis),
    currency: cleanText(input.currency || schedule?.currency || "USD").toUpperCase(),
    metadata: {
      recognition_basis: timingBasis,
      payroll_policy: policy ? {
        subject_type: policy.subject_type,
        subject_id: policy.subject_id,
        earning_kind: policy.earning_kind,
        revision: policy.revision
      } : { source: unscheduledKind ? `unscheduled_${cleanText(input.kind)}` : "explicit_schedule" },
      ...(schedule ? { schedule_snapshot: {
        id: schedule.id,
        name: schedule.name,
        revision: schedule.revision,
        recurrence: schedule.recurrence,
        delay: schedule.delay,
        timezone: schedule.timezone
      } } : {}),
      ...asObject(input.metadata)
    }
  } as PayrollLedgerEntryInput & JsonObject;
}

export async function recordPayrollLedgerEntries(orgId: string, inputs: Array<PayrollLedgerEntryInput & JsonObject>) {
  return (await withPayrollTransaction(async () => (await Promise.all(inputs.map(async (input) => (await upsertPayrollLedgerEntry(orgId, (await normalizedLedgerInput(orgId, input)))))))));
}

function storedEntryInput(entry: JsonObject) {
  return {
    id: cleanText(entry.id),
    payee: entryPayee(entry),
    schedule_id: cleanText(entry.schedule_id),
    kind: cleanText(entry.kind),
    subgroup: cleanText(entry.subgroup),
    state: cleanText(entry.state),
    amount_cents: Number(entry.amount_cents || 0),
    currency: cleanText(entry.currency || "USD"),
    project_id: cleanText(entry.project_id),
    project_title: cleanText(entry.project_title),
    worked_at: cleanText(entry.worked_at),
    completed_at: cleanText(entry.completed_at),
    eligible_at: cleanText(entry.eligible_at),
    source_event_id: cleanText(entry.source_event_id),
    source_trigger_id: cleanText(entry.source_trigger_id),
    description: cleanText(entry.description),
    metadata: asObject(entry.metadata)
  } as PayrollLedgerEntryInput & JsonObject;
}

export async function accruePayrollProjection(orgId: string, entryId: string, input: JsonObject = {}) {
  return (await getPayrollDatabase().transaction(async () => {
  const entry = (await readPayrollLedgerEntry(orgId, entryId));
  if (cleanText(entry.state) === "accrued") return entry;
  if (cleanText(entry.state) !== "projected") throw badRequest("payroll_projection_not_accruable", "Only projected payroll entries can be accrued.");
  const occurredAt = cleanText(input.occurred_at);
  const accrued = (await upsertPayrollLedgerEntry(orgId, (await normalizedLedgerInput(orgId, {
    ...storedEntryInput(entry),
    state: "accrued",
    ...(occurredAt ? { worked_at: occurredAt, completed_at: occurredAt, eligible_at: "" } : {})
  }))));
  const projectId = cleanText(accrued.project_id);
  await publishPayrollWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    ...(projectId ? { project_id: projectId } : {}),
    type: "payroll.commission.accrued",
    idempotency_key: `payroll.commission.accrued:${cleanText(accrued.id) || entryId}`,
    payload: {
      entry_id: cleanText(accrued.id) || entryId,
      ...(projectId ? { project_id: projectId } : {}),
      amount_cents: Math.round(Number(accrued.amount_cents || 0)),
      kind: cleanText(accrued.kind),
      payee_name: cleanText(asObject(accrued.payee).name)
    },
    context: { actor_user_id: cleanText(input.actor_user_id) }
  });
  return accrued;

  }));
}

export async function reversePayrollLedgerEntry(orgId: string, entryId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const entry = (await readPayrollLedgerEntry(orgId, entryId));
  if (cleanText(entry.state) !== "accrued" || Number(entry.amount_cents || 0) <= 0) {
    throw badRequest("payroll_entry_not_reversible", "Only positive accrued payroll entries can be reversed.");
  }
  const amount = Math.min(Math.abs(Number(entry.amount_cents || 0)), Math.abs(Number(input.amount_cents || entry.amount_cents || 0)));
  return (await upsertPayrollLedgerEntry(orgId, (await normalizedLedgerInput(orgId, {
    payee: entryPayee(entry),
    schedule_id: cleanText(entry.schedule_id),
    kind: cleanText(entry.kind) === "commission" ? "clawback" : "adjustment",
    subgroup: cleanText(entry.subgroup || entry.kind),
    state: "accrued",
    amount_cents: -amount,
    currency: cleanText(entry.currency || "USD"),
    project_id: cleanText(entry.project_id),
    project_title: cleanText(entry.project_title),
    worked_at: cleanText(input.occurred_at || nowIso()),
    completed_at: cleanText(input.occurred_at || nowIso()),
    source_event_id: cleanText(input.source_event_id),
    source_trigger_id: `reversal:${cleanText(entry.source_trigger_id || entry.id)}`,
    description: cleanText(input.description || `Reversal: ${entry.description || entry.kind}`),
    metadata: { ...asObject(input.metadata), reverses_ledger_entry_id: entry.id, original_amount_cents: entry.amount_cents }
  } as PayrollLedgerEntryInput & JsonObject))));

  }));
}

function commissionTotal(input: JsonObject) {
  if (Number.isFinite(Number(input.amount_cents))) return Math.max(0, Math.round(Number(input.amount_cents)));
  return Math.max(0, Math.round(Number(input.basis_cents || 0) * Number(input.rate_bps || 0) / 10_000));
}

function splitCents(total: number, count: number) {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_value, index) => base + (index < remainder ? 1 : 0));
}

export async function triggerCommissionEvent(orgId: string, projectId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const triggerId = cleanText(input.trigger_id);
  if (cleanText(input.state) === "cancelled") {
    const reverseSource = cleanText(input.reverses_source_event_id);
    const reverseTrigger = cleanText(input.reverses_trigger_id || triggerId);
    const originals = (await listPayrollLedgerEntries(orgId, {
      project_id: projectId,
      kind: "commission",
      limit: 5000,
      ...(reverseSource ? { source_event_id: reverseSource } : {})
    })).filter((entry) => (!reverseTrigger || cleanText(entry.source_trigger_id) === reverseTrigger) && cleanText(entry.state) !== "void");
    const results: JsonObject[] = [];
    (await withPayrollTransaction(async () => {
      for (const original of originals) {
        if (cleanText(original.state) === "projected") {
          results.push((await upsertPayrollLedgerEntry(orgId, {
            ...original,
            payee: entryPayee(original),
            state: "void",
            source_event_id: cleanText(original.source_event_id),
            source_trigger_id: cleanText(original.source_trigger_id)
          } as PayrollLedgerEntryInput & JsonObject)));
          continue;
        }
        results.push((await upsertPayrollLedgerEntry(orgId, (await normalizedLedgerInput(orgId, {
          payee: entryPayee(original),
          schedule_id: cleanText(original.schedule_id),
          kind: "clawback",
          subgroup: "commission",
          state: "accrued",
          amount_cents: -Math.abs(Number(original.amount_cents || 0)),
          currency: cleanText(original.currency || input.currency || "USD"),
          project_id: projectId,
          project_title: cleanText(input.project_title || original.project_title),
          worked_at: cleanText(input.occurred_at || nowIso()),
          completed_at: cleanText(input.completed_at || input.occurred_at || nowIso()),
          source_event_id: `${cleanText(input.source_event_id)}:${cleanText(original.id)}`,
          source_trigger_id: `${triggerId}:clawback:${cleanText(original.id)}`,
          description: cleanText(input.description || `Clawback: ${original.description || "commission reversal"}`),
          metadata: {
            ...asObject(input.metadata),
            reverses_ledger_entry_id: cleanText(original.id),
            reverses_source_event_id: cleanText(original.source_event_id),
            original_amount_cents: Number(original.amount_cents || 0)
          }
        } as PayrollLedgerEntryInput & JsonObject)))));
      }
    }));
    return { entries: results, reversed_count: results.length };
  }

  const directPayees = asArray(input.payees) as PayrollPayeeRef[];
  const roleKey = cleanText(input.payee_role);
  const role = roleKey ? (await listProjectPayees(orgId, projectId)).find((entry) => cleanText(entry.role_key) === roleKey) : null;
  const payees = (directPayees.length ? directPayees : asArray(role?.payees) as PayrollPayeeRef[])
    .filter((payee) => cleanText(payee?.id));
  if (!payees.length) throw badRequest("commission_payees_empty", `No commission payees are assigned${roleKey ? ` to '${roleKey}'` : ""}.`);
  const total = commissionTotal(input);
  const amounts = cleanText(input.allocation || "split_evenly") === "each"
    ? payees.map(() => total)
    : splitCents(total, payees.length);
  const entries = (await Promise.all(payees.map(async (payee, index) => (await normalizedLedgerInput(orgId, {
    payee,
    kind: "commission",
    subgroup: "commission",
    state: cleanText(input.state) === "projected" ? "projected" : "accrued",
    amount_cents: amounts[index],
    currency: cleanText(input.currency || "USD"),
    project_id: projectId,
    project_title: cleanText(input.project_title),
    worked_at: cleanText(input.occurred_at || nowIso()),
    completed_at: cleanText(input.completed_at),
    source_event_id: cleanText(input.source_event_id),
    source_trigger_id: triggerId,
    description: cleanText(input.description || "Project commission"),
    metadata: {
      ...asObject(input.metadata),
      payee_role: roleKey,
      allocation: cleanText(input.allocation || "split_evenly"),
      pool_amount_cents: total,
      payee_count: payees.length,
      basis_cents: Number(input.basis_cents || 0),
      rate_bps: Number(input.rate_bps || 0)
    }
  } as PayrollLedgerEntryInput & JsonObject)))));
  return { entries: (await recordPayrollLedgerEntries(orgId, entries)), total_cents: amounts.reduce((sum, amount) => sum + amount, 0) };

  }));
}

export async function reconcileProjectedCommissionPayees(orgId: string, projectId: string, roleKey: string) {
  return (await getPayrollDatabase().transaction(async () => {
  const role = (await listProjectPayees(orgId, projectId)).find((entry) => cleanText(entry.role_key) === roleKey);
  const payees = asArray(role?.payees) as PayrollPayeeRef[];
  const entries = (await listPayrollLedgerEntries(orgId, { project_id: projectId, kind: "commission", limit: 5000 }))
    .filter((entry) => cleanText(asObject(entry.metadata).payee_role) === roleKey)
    .filter((entry) => cleanText(entry.state) === "projected"
      || (cleanText(entry.state) === "void" && asObject(entry.metadata).commission_payee_removed === true));
  const groups = new Map<string, JsonObject[]>();
  for (const entry of entries) {
    const key = `${cleanText(entry.source_event_id)}\u0000${cleanText(entry.source_trigger_id)}`;
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  let updatedCount = 0;
  let voidedCount = 0;
  for (const group of groups.values()) {
    const first = group[0] || {};
    const metadata = asObject(first.metadata);
    let desired = new Set<string>();
    if (payees.length) {
      const result = (await triggerCommissionEvent(orgId, projectId, {
        source_event_id: cleanText(first.source_event_id),
        trigger_id: cleanText(first.source_trigger_id),
        state: "projected",
        payee_role: roleKey,
        payees,
        amount_cents: Number(metadata.pool_amount_cents ?? group.reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0)),
        allocation: cleanText(metadata.allocation || "split_evenly"),
        currency: cleanText(first.currency || "USD"),
        occurred_at: cleanText(first.worked_at || first.created_at),
        completed_at: cleanText(first.completed_at),
        project_title: cleanText(first.project_title),
        description: cleanText(first.description || "Project commission"),
        metadata: { ...metadata, commission_payee_removed: false }
      }));
      desired = new Set(asArray(result.entries).map((entry) => {
        const payee = asObject(asObject(entry).payee);
        return `${cleanText(payee.type)}:${cleanText(payee.id)}`;
      }));
      updatedCount += asArray(result.entries).length;
    }
    for (const entry of group.filter((candidate) => cleanText(candidate.state) === "projected")) {
      const payee = asObject(entry.payee);
      if (!desired.has(`${cleanText(payee.type)}:${cleanText(payee.id)}`)) {
        (await voidPayrollLedgerEntry(orgId, cleanText(entry.id), { commission_payee_removed: true, commission_payee_removed_at: nowIso() }));
        voidedCount += 1;
      }
    }
  }
  return { updated_count: updatedCount, voided_count: voidedCount };

  }));
}

export async function overrideProjectCommission(orgId: string, projectId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const entry = (await readPayrollLedgerEntry(orgId, cleanText(input.entry_id)));
  if (cleanText(entry.project_id) !== projectId || cleanText(entry.kind) !== "commission") {
    throw badRequest("project_commission_entry_invalid", "The selected entry is not a commission for this project.");
  }
  const target = Math.max(0, Math.round(Number(input.target_amount_cents || 0)));
  const reason = cleanText(input.reason);
  const overrideMetadata = {
    ...asObject(input.metadata),
    manual_override: true,
    manual_override_for: cleanText(entry.id),
    manual_override_reason: reason,
    manual_override_target_cents: target,
    manual_override_original_cents: Number(entry.amount_cents || 0)
  };
  if (cleanText(entry.state) === "projected") {
    const { manual_override_for: _adjustmentTarget, ...projectionOverrideMetadata } = overrideMetadata;
    const updated = (await upsertPayrollLedgerEntry(orgId, {
      ...storedEntryInput(entry),
      amount_cents: target,
      description: cleanText(entry.description || "Project commission"),
      metadata: {
        ...asObject(entry.metadata),
        ...projectionOverrideMetadata,
        manual_override_history: [
          ...asArray(asObject(entry.metadata).manual_override_history),
          { target_amount_cents: target, reason, source_event_id: cleanText(input.source_event_id), at: nowIso() }
        ]
      }
    }));
    return { entry: updated, adjustment: null, effective_amount_cents: target };
  }
  if (cleanText(entry.state) !== "accrued") throw badRequest("project_commission_override_state", "Only projected or accrued commissions can be overridden.");
  const related = (await listPayrollLedgerEntries(orgId, { project_id: projectId, limit: 5000 }))
    .filter((candidate) => cleanText(candidate.id) !== cleanText(entry.id)
      && cleanText(asObject(candidate.metadata).manual_override_for) === cleanText(entry.id));
  const effective = Number(entry.amount_cents || 0) + related.reduce((sum, candidate) => sum + Number(candidate.amount_cents || 0), 0);
  const delta = target - effective;
  if (!delta) return { entry, adjustment: null, effective_amount_cents: effective };
  const [adjustment] = (await recordPayrollLedgerEntries(orgId, [{
    payee: entryPayee(entry),
    schedule_id: cleanText(entry.schedule_id),
    kind: delta < 0 ? "clawback" : "commission",
    subgroup: "commission",
    state: "accrued",
    amount_cents: delta,
    currency: cleanText(entry.currency || "USD"),
    project_id: projectId,
    project_title: cleanText(entry.project_title),
    worked_at: nowIso(),
    completed_at: nowIso(),
    source_event_id: cleanText(input.source_event_id),
    source_trigger_id: `manual_override:${cleanText(entry.id)}`,
    description: `Manual commission override: ${reason}`,
    metadata: overrideMetadata
  } as PayrollLedgerEntryInput & JsonObject]));
  return { entry, adjustment, effective_amount_cents: effective + delta };

  }));
}

type PreviewEntry = JsonObject & { remaining_cents: number };

async function clawbackCap(orgId: string, schedule: JsonObject, payee: PayrollPayeeRef, earningKind = "*") {
  const policy = (await resolvePayrollPolicy(orgId, payee, earningKind));
  const value = policy?.clawback_cap_percent ?? schedule.clawback_cap_percent ?? 100;
  return Math.max(0, Math.min(100, Number(value)));
}

async function previewPayee(orgId: string, schedule: JsonObject, entries: PreviewEntry[], projected: boolean) {
  const positives = entries.filter((entry) => entry.remaining_cents > 0 && (cleanText(entry.state) === "projected") === projected);
  const negatives = entries.filter((entry) => entry.remaining_cents < 0 && (
    projected ? true : cleanText(entry.state) !== "projected"
  ));
  const gross = positives.reduce((sum, entry) => sum + entry.remaining_cents, 0);
  const payee = entryPayee(entries[0] || {});
  const cap = Math.floor(gross * (await clawbackCap(orgId, schedule, payee)) / 100);
  const availableDeduction = negatives.reduce((sum, entry) => sum + Math.abs(entry.remaining_cents), 0);
  const deduction = Math.min(gross, cap, availableDeduction);
  const subgroups: Record<string, number> = {};
  for (const entry of positives) {
    const subgroup = cleanText(entry.subgroup || entry.kind || "other");
    subgroups[subgroup] = (subgroups[subgroup] || 0) + entry.remaining_cents;
    entry.remaining_cents = 0;
  }
  let deductionLeft = deduction;
  for (const entry of negatives) {
    const applied = Math.min(deductionLeft, Math.abs(entry.remaining_cents));
    entry.remaining_cents += applied;
    deductionLeft -= applied;
    if (applied) subgroups.clawback = (subgroups.clawback || 0) - applied;
    if (!deductionLeft) break;
  }
  return {
    payee,
    worker_type: payee.worker_type,
    gross_cents: gross,
    commission_cents: positives.filter((entry) => cleanText(entry.kind) === "commission").reduce((sum, entry) => sum + Number(entry.amount_cents || 0), 0),
    deduction_cents: deduction,
    net_cents: gross - deduction,
    subgroup_totals: subgroups,
    entry_count: positives.length + negatives.filter((entry) => Math.abs(Number(entry.amount_cents || 0)) !== Math.abs(entry.remaining_cents)).length
  };
}

export async function upcomingPayroll(orgId: string, options: JsonObject = {}) {
  const today = new Date();
  const from = cleanText(options.from || isoDate(today));
  const through = cleanText(options.through || options.to || isoDate(addDays(today, 90)));
  const includeProjected = options.include_projected !== false && cleanText(options.include_projected) !== "0";
  const schedules = (await listPayrollSchedules(orgId, false));
  const existingBatches = (await listPayrollBatches(orgId, { from, through, limit: 500 }));
  const upcoming: JsonObject[] = [];
  const diagnostics: JsonObject[] = [];

  for (const schedule of schedules) {
    const entries = (await listPayrollLedgerEntries(orgId, { schedule_id: schedule.id, open_only: true, limit: 5000 }))
      .filter((entry) => cleanText(entry.state) === "accrued" || (includeProjected && cleanText(entry.state) === "projected"))
      .map((entry) => ({ ...entry, remaining_cents: Number(entry.remaining_cents || 0) } as PreviewEntry));
    for (const occurrence of payrollOccurrences(schedule, from, through)) {
      const eligible = entries.filter((entry) => entry.remaining_cents !== 0 && Date.parse(cleanText(entry.eligible_at)) <= Date.parse(occurrence.cutoff_at));
      const groups = new Map<string, PreviewEntry[]>();
      for (const entry of eligible) {
        const payee = entryPayee(entry);
        const key = `${payee.type}:${payee.id}`;
        groups.set(key, [...(groups.get(key) || []), entry]);
      }
      const items: JsonObject[] = [];
      for (const group of groups.values()) {
        const accrued = (await previewPayee(orgId, schedule, group, false));
        const projected = includeProjected ? (await previewPayee(orgId, schedule, group, true)) : { gross_cents: 0, deduction_cents: 0, net_cents: 0, subgroup_totals: {}, entry_count: 0 };
        if (!accrued.entry_count && !projected.entry_count) continue;
        items.push({
          payee: accrued.payee,
          worker_type: accrued.worker_type,
          accrued,
          projected,
          forecast_net_cents: accrued.net_cents + projected.net_cents
        });
      }
      const batch = existingBatches.find((candidate) => cleanText(candidate.schedule_id) === schedule.id && cleanText(candidate.pay_date) === occurrence.pay_date) || null;
      const employeeItems = items.filter((item) => cleanText(item.worker_type) === "employee");
      const subcontractorItems = items.filter((item) => cleanText(item.worker_type) !== "employee");
      upcoming.push({
        ...occurrence,
        schedule,
        batch,
        employees: employeeItems,
        subcontractors: subcontractorItems,
        accrued_total_cents: items.reduce((sum, item) => sum + Number(asObject(item.accrued).net_cents || 0), 0),
        projected_additional_cents: items.reduce((sum, item) => sum + Number(asObject(item.projected).net_cents || 0), 0),
        forecast_total_cents: items.reduce((sum, item) => sum + Number(item.forecast_net_cents || 0), 0)
      });
    }
  }
  const unassigned = (await listPayrollLedgerEntries(orgId, { open_only: true, limit: 5000 })).filter((entry) => !cleanText(entry.schedule_id));
  if (unassigned.length) diagnostics.push({ code: "unassigned_entries", count: unassigned.length, entry_ids: unassigned.slice(0, 50).map((entry) => entry.id) });
  upcoming.sort((left, right) => cleanText(left.pay_date).localeCompare(cleanText(right.pay_date)) || cleanText(asObject(left.schedule).name).localeCompare(cleanText(asObject(right.schedule).name)));
  return { from, through, schedules, upcoming, diagnostics };
}

async function insertBatchItem(db: SqlStore, orgId: string, batchId: string, group: JsonObject[], schedule: JsonObject) {
  const payee = entryPayee(group[0] || {});
  const positives = group.filter((entry) => Number(entry.remaining_cents || 0) > 0);
  const negatives = group.filter((entry) => Number(entry.remaining_cents || 0) < 0);
  const gross = positives.reduce((sum, entry) => sum + Number(entry.remaining_cents || 0), 0);
  if (gross <= 0) return null;
  const cap = Math.floor(gross * (await clawbackCap(orgId, schedule, payee)) / 100);
  const deduction = Math.min(gross, cap, negatives.reduce((sum, entry) => sum + Math.abs(Number(entry.remaining_cents || 0)), 0));
  const subgroupTotals: Record<string, number> = {};
  for (const entry of positives) {
    const subgroup = cleanText(entry.subgroup || entry.kind || "other");
    subgroupTotals[subgroup] = (subgroupTotals[subgroup] || 0) + Number(entry.remaining_cents || 0);
  }
  if (deduction) subgroupTotals.clawback = -deduction;
  const commission = positives.filter((entry) => cleanText(entry.kind) === "commission").reduce((sum, entry) => sum + Number(entry.remaining_cents || 0), 0);
  const itemId = generatedId("pay_item");
  const now = nowIso();
  (await db.prepare(`INSERT INTO payroll_batch_items
    (id, batch_id, organization_id, payee_type, payee_id, payee_name, worker_type, status, gross_cents, commission_cents,
     deduction_cents, net_cents, subgroup_totals_json, payment_reference, metadata_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, '', '{}', 1, ?, ?)`)
    .run(itemId, batchId, orgId, payee.type, payee.id, payee.name || payee.id, payee.worker_type || "employee", gross, commission,
      deduction, gross - deduction, JSON.stringify(subgroupTotals), now, now));
  const allocationInsert = db.prepare(`INSERT INTO payroll_allocations
    (id, organization_id, batch_id, batch_item_id, ledger_entry_id, applied_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of positives) {
    (await allocationInsert.run(generatedId("pay_alloc"), orgId, batchId, itemId, cleanText(entry.id), Number(entry.remaining_cents || 0), now));
  }
  let deductionLeft = deduction;
  for (const entry of negatives) {
    const applied = Math.min(deductionLeft, Math.abs(Number(entry.remaining_cents || 0)));
    if (applied) (await allocationInsert.run(generatedId("pay_alloc"), orgId, batchId, itemId, cleanText(entry.id), -applied, now));
    deductionLeft -= applied;
    if (!deductionLeft) break;
  }
  return { net_cents: gross - deduction, worker_type: payee.worker_type || "employee" };
}

export async function createPayrollBatch(orgId: string, input: JsonObject, actorUserId = "") {
  return (await getPayrollDatabase().transaction(async () => {
  const schedule = (await readPayrollSchedule(orgId, cleanText(input.schedule_id)));
  const runType = cleanText(input.run_type) === "off_cycle" ? "off_cycle" : "regular";
  const scheduledOccurrence = payrollOccurrence(schedule, cleanText(input.pay_date));
  if (runType === "regular" && (!scheduledOccurrence || scheduledOccurrence.pay_date !== cleanText(input.pay_date))) {
    throw badRequest("invalid_payroll_occurrence", "The pay date is not part of this schedule.");
  }
  const occurrence = runType === "off_cycle" ? {
    pay_date: cleanText(input.pay_date),
    period_start: cleanText(input.period_start || input.pay_date),
    period_end: cleanText(input.period_end || input.pay_date),
    cutoff_at: `${cleanText(input.period_end || input.pay_date)}T23:59:59.999Z`
  } : scheduledOccurrence as JsonObject;
  if (runType === "off_cycle" && cleanText(occurrence.period_end) < cleanText(occurrence.period_start)) {
    throw badRequest("off_cycle_period_invalid", "Off-cycle period_end must be on or after period_start.");
  }
  const prior = (await listPayrollBatches(orgId, { schedule_id: schedule.id, from: occurrence.pay_date, through: occurrence.pay_date, limit: 1 }))[0];
  if (prior) throw conflict("payroll_batch_exists", "A payroll batch already exists for this schedule and pay date.", { batch_id: prior.id });
  const batchId = generatedId("pay_batch");
  (await withPayrollTransaction(async (db) => {
    const entries = (await listPayrollLedgerEntries(orgId, {
      schedule_id: schedule.id,
      state: "accrued",
      eligible_through: occurrence.cutoff_at,
      open_only: true,
      limit: 5000
    })).filter((entry) => !asArray(input.entry_ids).length || asArray(input.entry_ids).map(cleanText).includes(cleanText(entry.id)));
    if (asArray(input.entry_ids).length) {
      const found = new Set(entries.map((entry) => cleanText(entry.id)));
      const missing = asArray(input.entry_ids).map(cleanText).filter((id) => !found.has(id));
      if (missing.length) throw badRequest("off_cycle_entries_ineligible", "One or more selected earnings are unavailable or ineligible.", { entry_ids: missing });
    }
    const groups = new Map<string, JsonObject[]>();
    for (const entry of entries) {
      const payee = entryPayee(entry);
      const key = `${payee.type}:${payee.id}`;
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    const now = nowIso();
    (await db.prepare(`INSERT INTO payroll_batches
      (id, organization_id, schedule_id, pay_date, period_start, period_end, status, currency, metadata_json, revision, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?, ?, ?)`)
      .run(batchId, orgId, cleanText(schedule.id), cleanText(occurrence.pay_date), cleanText(occurrence.period_start), cleanText(occurrence.period_end), cleanText(schedule.currency),
        JSON.stringify({ ...asObject(input.metadata), run_type: runType, reason: cleanText(input.reason), approval: { status: "draft" } }), actorUserId, now, now));
    let employeeTotal = 0;
    let subcontractorTotal = 0;
    let itemCount = 0;
    for (const group of groups.values()) {
      const item = (await insertBatchItem(db, orgId, batchId, group, schedule));
      if (!item) continue;
      itemCount += 1;
      if (item.worker_type !== "employee") subcontractorTotal += item.net_cents;
      else employeeTotal += item.net_cents;
    }
    if (!itemCount) throw badRequest("payroll_batch_empty", "No accrued positive earnings are eligible for this payroll date.");
    (await db.prepare(`UPDATE payroll_batches SET total_cents=?, employee_total_cents=?, subcontractor_total_cents=? WHERE id=?`)
      .run(employeeTotal + subcontractorTotal, employeeTotal, subcontractorTotal, batchId));
  }));
  return (await readPayrollBatch(orgId, batchId));

  }));
}

async function syncBatchStatus(db: SqlStore, orgId: string, batchId: string) {
  const rows = (await db.prepare("SELECT status FROM payroll_batch_items WHERE organization_id=? AND batch_id=?").all(orgId, batchId)).map(asObject);
  const statuses = rows.map((row) => cleanText(row.status));
  const status = statuses.length && statuses.every((value) => value === "paid")
    ? "paid"
    : statuses.length && statuses.every((value) => ["run", "paid"].includes(value))
      ? "run"
      : statuses.some((value) => ["run", "paid"].includes(value)) ? "partial" : "draft";
  const now = nowIso();
  (await db.prepare(`UPDATE payroll_batches SET status=?, revision=revision+1, updated_at=?,
    run_at=CASE WHEN ? IN ('run','paid') THEN COALESCE(run_at, ?) ELSE run_at END,
    paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at, ?) ELSE NULL END WHERE organization_id=? AND id=?`)
    .run(status, now, status, now, status, now, orgId, batchId));
}

async function rebuildDraftPayrollBatch(orgId: string, batch: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const schedule = (await readPayrollSchedule(orgId, cleanText(batch.schedule_id)));
  const runType = cleanText(batch.run_type || asObject(batch.metadata).run_type || "regular");
  const regularOccurrence = runType === "off_cycle" ? null : payrollOccurrence(schedule, cleanText(batch.pay_date));
  if (runType !== "off_cycle" && !regularOccurrence) throw badRequest("payroll_date_not_scheduled", "This payroll date no longer matches the batch schedule.");
  const cutoffAt = runType === "off_cycle"
    ? `${cleanText(batch.period_end)}T23:59:59.999Z`
    : cleanText(regularOccurrence?.cutoff_at);
  (await withPayrollTransaction(async (db) => {
    (await db.prepare("DELETE FROM payroll_allocations WHERE organization_id=? AND batch_id=?").run(orgId, cleanText(batch.id)));
    (await db.prepare("DELETE FROM payroll_batch_items WHERE organization_id=? AND batch_id=?").run(orgId, cleanText(batch.id)));
    const groups = new Map<string, JsonObject[]>();
    for (const entry of (await listPayrollLedgerEntries(orgId, { schedule_id: schedule.id, state: "accrued", eligible_through: cutoffAt, open_only: true, limit: 5000 }))) {
      const payee = entryPayee(entry);
      const key = `${payee.type}:${payee.id}`;
      groups.set(key, [...(groups.get(key) || []), entry]);
    }
    let employeeTotal = 0;
    let subcontractorTotal = 0;
    let itemCount = 0;
    for (const group of groups.values()) {
      const item = (await insertBatchItem(db, orgId, cleanText(batch.id), group, schedule));
      if (!item) continue;
      itemCount += 1;
      if (item.worker_type === "employee") employeeTotal += item.net_cents;
      else subcontractorTotal += item.net_cents;
    }
    if (!itemCount) throw badRequest("payroll_batch_empty", "No accrued positive earnings remain eligible for this payroll run.");
    (await db.prepare(`UPDATE payroll_batches SET status='draft', total_cents=?, employee_total_cents=?, subcontractor_total_cents=?,
      run_at=NULL, paid_at=NULL, revision=revision+1, updated_at=? WHERE organization_id=? AND id=?`)
      .run(employeeTotal + subcontractorTotal, employeeTotal, subcontractorTotal, nowIso(), orgId, cleanText(batch.id)));
  }));

  }));
}

export async function patchPayrollBatchItem(orgId: string, batchId: string, itemId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const batch = (await readPayrollBatch(orgId, batchId));
  if (["void", "paid"].includes(cleanText(batch.status))) throw badRequest("payroll_batch_locked", "This payroll batch can no longer be changed.");
  const approval = asObject(batch.approval || asObject(batch.metadata).approval);
  if (Object.keys(approval).length && cleanText(approval.status) !== "finalized") {
    throw badRequest("payroll_batch_not_finalized", "Finalize the named approval workflow before recording payroll item payments.");
  }
  const current = (await readPayrollBatchItem(orgId, batchId, itemId));
  if (cleanText(current.status) === "paid") throw badRequest("payroll_item_paid", "A paid payroll item cannot be changed.");
  const nextStatus = cleanText(input.status) === "paid" ? "paid" : "run";
  (await withPayrollTransaction(async (db) => {
    const now = nowIso();
    (await db.prepare(`UPDATE payroll_batch_items SET status=?, payment_reference=?, metadata_json=?, revision=revision+1, updated_at=?,
      run_at=COALESCE(run_at, ?), paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at, ?) ELSE paid_at END
      WHERE organization_id=? AND batch_id=? AND id=?`)
      .run(nextStatus, cleanText(input.payment_reference || current.payment_reference), JSON.stringify({ ...asObject(current.metadata), ...asObject(input.metadata) }),
        now, now, nextStatus, now, orgId, batchId, itemId));
    (await syncBatchStatus(db, orgId, batchId));
  }));
  return (await readPayrollBatch(orgId, batchId));

  }));
}

export async function applyPayrollBatchAction(orgId: string, batchId: string, input: JsonObject) {
  return (await getPayrollDatabase().transaction(async () => {
  const batch = (await readPayrollBatch(orgId, batchId));
  const action = cleanText(input.action);
  const actor = asObject(input.actor);
  const actorUserId = cleanText(actor.user_id || input.actor_user_id);
  const actorName = cleanText(actor.name || actor.email || actorUserId);
  const approval = asObject(batch.approval || asObject(batch.metadata).approval);
  if (["submit_approval", "approve", "reject", "finalize", "reopen"].includes(action)) {
    if (cleanText(batch.status) === "paid") throw badRequest("paid_payroll_batch_locked", "A paid payroll batch cannot be reopened or re-approved.");
    if (action === "reopen" && asArray(batch.items).map(asObject).some((item) => cleanText(item.status) === "paid")) {
      throw badRequest("partially_paid_payroll_batch_locked", "A payroll run with paid items cannot be rebuilt. Post a correcting off-cycle run instead.");
    }
    const now = nowIso();
    let next: JsonObject = { ...approval };
    if (action === "submit_approval") {
      const requested = asArray(input.approvers).map(asObject).map((entry) => ({
        user_id: cleanText(entry.user_id), name: cleanText(entry.name || entry.user_id)
      })).filter((entry) => entry.user_id);
      if (!requested.length) throw badRequest("payroll_approver_required", "Choose at least one named payroll approver.");
      next = { status: "pending", requested_approvers: requested, decisions: [], submitted_by: { user_id: actorUserId, name: actorName }, submitted_at: now };
    } else if (action === "approve" || action === "reject") {
      if (cleanText(approval.status) !== "pending") throw badRequest("payroll_approval_not_pending", "This payroll batch is not awaiting approval.");
      const requested = asArray(approval.requested_approvers).map(asObject);
      if (!requested.some((entry) => cleanText(entry.user_id) === actorUserId)) {
        throw badRequest("payroll_approver_not_named", "Only a named approver can decide this payroll batch.");
      }
      const decisions = asArray(approval.decisions).map(asObject).filter((entry) => cleanText(entry.user_id) !== actorUserId);
      decisions.push({ user_id: actorUserId, name: actorName, decision: action === "approve" ? "approved" : "rejected", note: cleanText(input.note), decided_at: now });
      const approvedIds = new Set(decisions.filter((entry) => cleanText(entry.decision) === "approved").map((entry) => cleanText(entry.user_id)));
      next = { ...approval, decisions, status: action === "reject" ? "rejected" : requested.every((entry) => approvedIds.has(cleanText(entry.user_id))) ? "approved" : "pending" };
    } else if (action === "finalize") {
      if (cleanText(approval.status) !== "approved") throw badRequest("payroll_approval_incomplete", "Every named approver must approve before finalization.");
      next = { ...approval, status: "finalized", finalized_by: { user_id: actorUserId, name: actorName }, finalized_at: now };
    } else {
      next = { status: "draft", reopened_by: { user_id: actorUserId, name: actorName }, reopened_at: now, note: cleanText(input.note), prior: approval };
      (await rebuildDraftPayrollBatch(orgId, batch));
    }
    const metadata = { ...asObject(batch.metadata), ...asObject(input.metadata), approval: next };
    (await getPayrollDatabase().prepare("UPDATE payroll_batches SET metadata_json=?, revision=revision+1, updated_at=? WHERE organization_id=? AND id=?")
      .run(JSON.stringify(metadata), now, orgId, batchId));
    return (await readPayrollBatch(orgId, batchId));
  }
  if (action === "void") {
    if (batch.items.some((item: JsonObject) => cleanText(item.status) === "paid")) {
      throw badRequest("paid_payroll_batch_cannot_void", "A batch containing paid workers cannot be voided. Post correcting ledger entries instead.");
    }
    const now = nowIso();
    (await getPayrollDatabase().prepare("UPDATE payroll_batches SET status='void', voided_at=?, updated_at=?, revision=revision+1 WHERE organization_id=? AND id=?")
      .run(now, now, orgId, batchId));
    return (await readPayrollBatch(orgId, batchId));
  }
  if (!["run", "paid"].includes(action)) throw badRequest("invalid_payroll_batch_action", "Payroll batch action must be run, paid, or void.");
  if (Object.keys(approval).length && cleanText(approval.status) !== "finalized") {
    throw badRequest("payroll_batch_not_finalized", "Finalize the named approval workflow before running this payroll batch.");
  }
  if (cleanText(batch.status) === "void") throw badRequest("payroll_batch_void", "A void payroll batch cannot be changed.");
  (await withPayrollTransaction(async (db) => {
    const now = nowIso();
    (await db.prepare(`UPDATE payroll_batch_items SET status=?, payment_reference=CASE WHEN ?<>'' THEN ? ELSE payment_reference END,
      metadata_json=?, revision=revision+1, updated_at=?, run_at=COALESCE(run_at, ?),
      paid_at=CASE WHEN ?='paid' THEN COALESCE(paid_at, ?) ELSE paid_at END
      WHERE organization_id=? AND batch_id=? AND status<>'paid'`)
      .run(action, cleanText(input.payment_reference), cleanText(input.payment_reference), JSON.stringify(asObject(input.metadata)),
        now, now, action, now, orgId, batchId));
    (await syncBatchStatus(db, orgId, batchId));
  }));
  const updated = (await readPayrollBatch(orgId, batchId));
  // Org-scoped: payroll batches are not tied to a single project.
  await publishPayrollWorkEvent({
    organization_id: orgId,
    branch_id: "default",
    type: action === "paid" ? "payroll.batch.paid" : "payroll.batch.run",
    idempotency_key: `payroll.batch.${action}:${batchId}`,
    payload: {
      batch_id: batchId,
      status: cleanText(updated.status),
      pay_date: cleanText(updated.pay_date),
      total_cents: Math.round(Number(updated.total_cents || 0)),
      employee_total_cents: Math.round(Number(updated.employee_total_cents || 0)),
      subcontractor_total_cents: Math.round(Number(updated.subcontractor_total_cents || 0))
    },
    context: { actor_user_id: cleanText(input.actor_user_id) }
  });
  return updated;

  }));
}
