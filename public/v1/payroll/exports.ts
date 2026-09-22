import { createHash } from "node:crypto";

import { renderTemplatedArtifact } from "../documents/artifacts.js";
import { badRequest } from "../platform/errors.js";
import { listDocuments } from "../platform/storage.js";
import { listPayrollTimesheets } from "./timesheets.js";
import {
  asArray,
  asObject,
  cleanText,
  createPayrollArtifact,
  listPayrollArtifacts,
  listPayrollLedgerEntries,
  readPayrollBatch,
  readPayrollSchedule,
  type JsonObject
} from "./storage.js";

type ExportColumn = { key: string; label: string; width?: number };

export const PAYROLL_EXPORT_CATALOG = [
  { type: "payroll_register", label: "Payroll register", description: "A clear worker-by-worker summary of gross pay, deductions, and final pay.", purpose: "Review the payroll totals or give a readable record to your accountant.", scope: "payroll_run", scope_label: "Payroll run", formats: ["csv", "pdf"] },
  { type: "batch_summary", label: "Payroll summary", description: "One-page totals for a completed or upcoming payroll, including employee and contractor totals.", purpose: "Print or share a quick approval and bookkeeping summary.", scope: "payroll_run", scope_label: "Payroll run", formats: ["csv", "pdf"] },
  { type: "batch_detail", label: "Earnings detail", description: "Every earning included in a payroll, with the worker, project, earning type, and amount.", purpose: "Answer questions about how each worker's pay was calculated.", scope: "payroll_run", scope_label: "Payroll run", formats: ["csv", "pdf"] },
  { type: "provider_handoff", label: "Payroll provider file", description: "Worker payment amounts and references arranged for transfer to an outside payroll provider.", purpose: "Use as the source file when entering or importing payroll with your provider.", scope: "payroll_run", scope_label: "Payroll run", formats: ["csv", "pdf"] },
  { type: "contractor_payments", label: "Contractor payments", description: "Payments owed or paid to independent contractors and subcontractor companies.", purpose: "Reconcile crew payments or send contractor totals to your bookkeeper.", scope: "payroll_run_or_date_range", scope_label: "Payroll run or date range", formats: ["csv", "pdf"] },
  { type: "earnings_ledger", label: "All earnings", description: "A detailed list of employee and contractor earnings recorded during the selected dates.", purpose: "Audit compensation activity or provide supporting detail to your accountant.", scope: "date_range", scope_label: "Date range", formats: ["csv", "pdf"] },
  { type: "commissions", label: "Commission report", description: "Commission earnings, projects, payment status, and remaining balances for the selected dates.", purpose: "Review sales and production commissions before or after payroll.", scope: "date_range", scope_label: "Date range", formats: ["csv", "pdf"] },
  { type: "timesheets", label: "Timesheet report", description: "Clock-in, clock-out, worked time, projects, and approval status for the selected dates.", purpose: "Review field hours or retain a printable time record.", scope: "date_range", scope_label: "Date range", formats: ["csv", "pdf"] },
  { type: "reimbursements", label: "Reimbursement report", description: "Requested, approved, and paid employee reimbursements during the selected dates.", purpose: "Reconcile receipts and repayment status with payroll or bookkeeping.", scope: "date_range", scope_label: "Date range", formats: ["csv", "pdf"] }
] as const;

function definition(type: string) {
  const result = PAYROLL_EXPORT_CATALOG.find((entry) => entry.type === type);
  if (!result) throw badRequest("payroll_export_type_invalid", "Choose one of the available payroll reports.");
  return result;
}

function humanize(value: unknown) {
  const text = cleanText(value).replace(/[_-]+/g, " ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function displayValue(value: unknown, key: string) {
  if (value === null || value === undefined || value === "") return "";
  if (key.endsWith("_cents")) return (Number(value || 0) / 100).toFixed(2);
  if (key.endsWith("_seconds")) return (Number(value || 0) / 3600).toFixed(2);
  if (["status", "state", "run_type", "approval_status", "batch_status", "item_status", "worker_classification", "earning_kind", "subgroup", "payee_type", "payment_timing"].includes(key)) return humanize(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function csv(rows: JsonObject[], columns: ExportColumn[]) {
  const lines = [columns.map((column) => csvCell(column.label)).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(displayValue(row[column.key], column.key))).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function friendlyDate(value: unknown) {
  const text = cleanText(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${text}T12:00:00.000Z`));
}

function safeFilePart(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
}

function generatedToken(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function batchRows(batch: JsonObject) {
  return asArray(batch.items).map(asObject).map((item) => {
    const payee = asObject(item.payee);
    return {
      batch_id: cleanText(batch.id), run_type: cleanText(batch.run_type || "regular"), pay_date: cleanText(batch.pay_date),
      period_start: cleanText(batch.period_start), period_end: cleanText(batch.period_end), batch_status: cleanText(batch.status),
      approval_status: cleanText(asObject(batch.approval).status), payee_type: cleanText(payee.type), payee_id: cleanText(payee.id),
      payee_name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type || "employee"), item_status: cleanText(item.status),
      gross_cents: Number(item.gross_cents || 0), commission_cents: Number(item.commission_cents || 0),
      deduction_cents: Number(item.deduction_cents || 0), net_cents: Number(item.net_cents || 0),
      payment_reference: cleanText(item.payment_reference), paid_at: cleanText(item.paid_at)
    };
  });
}

function batchDetailRows(batch: JsonObject) {
  return asArray(batch.items).map(asObject).flatMap((item) => {
    const payee = asObject(item.payee);
    return asArray(item.entries).map(asObject).map((entry) => ({
      batch_id: cleanText(batch.id), pay_date: cleanText(batch.pay_date), item_status: cleanText(item.status),
      payee_id: cleanText(payee.id), payee_name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type),
      ledger_entry_id: cleanText(entry.id), earning_kind: cleanText(entry.kind), subgroup: cleanText(entry.subgroup),
      project_id: cleanText(entry.project_id), project_title: cleanText(entry.project_title), description: cleanText(entry.description),
      eligible_at: cleanText(entry.eligible_at), amount_cents: Number(entry.amount_cents || 0),
      applied_cents: Number(entry.allocation_cents || 0), currency: cleanText(entry.currency || batch.currency || "USD")
    }));
  });
}

async function filteredLedger(orgId: string, input: JsonObject, kind = "") {
  const rows = (await listPayrollLedgerEntries(orgId, { kind, limit: 5000 }));
  const from = cleanText(input.from);
  const through = cleanText(input.through);
  return rows.filter((entry) => (!from || cleanText(entry.eligible_at).slice(0, 10) >= from)
    && (!through || cleanText(entry.eligible_at).slice(0, 10) <= through)
    && (input.include_projected === true || cleanText(entry.state) !== "projected"));
}

async function exportRows(orgId: string, input: JsonObject) {
  const type = cleanText(input.type);
  const report = definition(type);
  const batch = cleanText(input.batch_id) ? (await readPayrollBatch(orgId, cleanText(input.batch_id))) : null;
  if ((report.scope === "payroll_run" || (report.scope === "payroll_run_or_date_range" && !input.from)) && !batch) {
    throw badRequest("payroll_export_batch_required", "Choose the payroll run this report should cover.");
  }
  if ((report.scope === "date_range" || (report.scope === "payroll_run_or_date_range" && !batch)) && (!cleanText(input.from) || !cleanText(input.through))) {
    throw badRequest("payroll_export_dates_required", "Choose a start date and end date for this report.");
  }
  if (type === "batch_summary") return { batch, rows: [{
    batch_id: cleanText(batch?.id), run_type: cleanText(batch?.run_type || "regular"), pay_date: cleanText(batch?.pay_date),
    period_start: cleanText(batch?.period_start), period_end: cleanText(batch?.period_end), status: cleanText(batch?.status),
    approval_status: cleanText(asObject(batch?.approval).status), currency: cleanText(batch?.currency || "USD"),
    payee_count: asArray(batch?.items).length, employee_total_cents: Number(batch?.employee_total_cents || 0),
    contractor_total_cents: Number(batch?.subcontractor_total_cents || 0), total_cents: Number(batch?.total_cents || 0),
    run_at: cleanText(batch?.run_at), paid_at: cleanText(batch?.paid_at)
  }] };
  if (type === "payroll_register" || type === "provider_handoff") return { batch, rows: batchRows(batch || {}) };
  if (type === "batch_detail") return { batch, rows: batchDetailRows(batch || {}) };
  if (type === "contractor_payments") {
    const rows = batch ? batchRows(batch) : (await filteredLedger(orgId, input)).map((entry) => {
      const payee = asObject(entry.payee);
      return {
        batch_id: "", run_type: "date_range", pay_date: cleanText(entry.eligible_at).slice(0, 10), period_start: cleanText(input.from),
        period_end: cleanText(input.through), approval_status: "", payee_type: cleanText(payee.type), payee_id: cleanText(payee.id),
        payee_name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type), gross_cents: Number(entry.amount_cents || 0),
        commission_cents: cleanText(entry.kind) === "commission" ? Number(entry.amount_cents || 0) : 0, deduction_cents: 0,
        net_cents: Number(entry.amount_cents || 0), item_status: cleanText(entry.state), payment_reference: "", paid_at: ""
      };
    });
    return { batch, rows: rows.filter((row) => cleanText(row.worker_classification) !== "employee") };
  }
  if (type === "timesheets") {
    const result = await listPayrollTimesheets(orgId, { from: input.from, through: input.through, limit: 1000 });
    return { batch: null, rows: asArray(result.timesheets).map(asObject).map((shift) => ({
      shift_id: cleanText(shift.id), worker_name: cleanText(asObject(shift.user).name), project_title: cleanText(asObject(shift.project).title),
      clocked_in_at: cleanText(shift.clocked_in_at), clocked_out_at: cleanText(shift.clocked_out_at),
      worked_seconds: Number(shift.worked_seconds || 0), break_seconds: Number(shift.break_seconds || 0),
      approval_status: cleanText(shift.approval_status), manager_note: cleanText(shift.manager_note)
    })) };
  }
  if (type === "reimbursements") {
    const docs = await listDocuments(orgId, "payment_receipts");
    const rows = docs.map((doc) => asObject(asObject(doc.data).reimbursement_request)).map((request) => ({
      request_id: cleanText(request.id), status: cleanText(request.status), requested_by_name: cleanText(asObject(request.requested_by).name),
      project_id: cleanText(request.project_id), amount_cents: Number(request.amount_cents || 0), currency: cleanText(request.currency || "USD"),
      requested_at: cleanText(request.requested_at), approved_at: cleanText(request.approved_at), paid_at: cleanText(request.paid_at),
      payment_timing: cleanText(request.payment_timing), note: cleanText(request.note)
    })).filter((row) => row.request_id && row.requested_at.slice(0, 10) >= cleanText(input.from) && row.requested_at.slice(0, 10) <= cleanText(input.through));
    return { batch: null, rows };
  }
  const ledger = (await filteredLedger(orgId, input, type === "commissions" ? "commission" : ""));
  return { batch: null, rows: ledger.map((entry) => {
    const payee = asObject(entry.payee);
    return {
      entry_id: cleanText(entry.id), state: cleanText(entry.state), earning_kind: cleanText(entry.kind), subgroup: cleanText(entry.subgroup),
      payee_name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type), project_title: cleanText(entry.project_title),
      amount_cents: Number(entry.amount_cents || 0), applied_cents: Number(entry.applied_cents || 0),
      remaining_cents: Number(entry.remaining_cents || 0), currency: cleanText(entry.currency || "USD"),
      eligible_at: cleanText(entry.eligible_at), description: cleanText(entry.description)
    };
  }) };
}

function columnsFor(type: string): ExportColumn[] {
  if (type === "batch_summary") return [
    { key: "pay_date", label: "Pay date" }, { key: "run_type", label: "Payroll type" }, { key: "period_start", label: "Period start" },
    { key: "period_end", label: "Period end" }, { key: "status", label: "Payroll status" }, { key: "approval_status", label: "Approval status" },
    { key: "payee_count", label: "People paid" }, { key: "employee_total_cents", label: "Employee total" },
    { key: "contractor_total_cents", label: "Contractor total" }, { key: "total_cents", label: "Payroll total" }, { key: "currency", label: "Currency" }
  ];
  if (["payroll_register", "provider_handoff", "contractor_payments"].includes(type)) return [
    { key: "pay_date", label: "Pay date" }, { key: "payee_name", label: "Worker or company", width: 1.6 },
    { key: "worker_classification", label: "Paid as" }, { key: "gross_cents", label: "Gross amount" },
    { key: "commission_cents", label: "Commission" }, { key: "deduction_cents", label: "Deductions" },
    { key: "net_cents", label: "Amount to pay" }, { key: "item_status", label: "Payment status" },
    { key: "payment_reference", label: "Payment reference", width: 1.4 }, { key: "paid_at", label: "Paid on" }
  ];
  if (type === "batch_detail") return [
    { key: "payee_name", label: "Worker or company", width: 1.5 }, { key: "worker_classification", label: "Paid as" },
    { key: "earning_kind", label: "Earning type" }, { key: "project_title", label: "Project", width: 1.5 },
    { key: "description", label: "Description", width: 1.6 }, { key: "eligible_at", label: "Earned on" },
    { key: "amount_cents", label: "Earning amount" }, { key: "applied_cents", label: "Included amount" }, { key: "currency", label: "Currency" }
  ];
  if (type === "timesheets") return [
    { key: "worker_name", label: "Worker", width: 1.4 }, { key: "project_title", label: "Project", width: 1.4 },
    { key: "clocked_in_at", label: "Clocked in", width: 1.3 }, { key: "clocked_out_at", label: "Clocked out", width: 1.3 },
    { key: "worked_seconds", label: "Hours worked" }, { key: "break_seconds", label: "Break hours" },
    { key: "approval_status", label: "Approval status" }, { key: "manager_note", label: "Manager note", width: 1.5 }
  ];
  if (type === "reimbursements") return [
    { key: "requested_by_name", label: "Employee", width: 1.4 }, { key: "project_id", label: "Project" },
    { key: "amount_cents", label: "Amount" }, { key: "currency", label: "Currency" }, { key: "status", label: "Status" },
    { key: "requested_at", label: "Requested on" }, { key: "approved_at", label: "Approved on" }, { key: "paid_at", label: "Paid on" },
    { key: "note", label: "Note", width: 1.6 }
  ];
  return [
    { key: "eligible_at", label: "Earned on" }, { key: "payee_name", label: "Worker or company", width: 1.5 },
    { key: "worker_classification", label: "Paid as" }, { key: "earning_kind", label: "Earning type" },
    { key: "project_title", label: "Project", width: 1.4 }, { key: "description", label: "Description", width: 1.5 },
    { key: "amount_cents", label: "Amount" }, { key: "applied_cents", label: "Already included" },
    { key: "remaining_cents", label: "Still owed" }, { key: "state", label: "Status" }
  ];
}

export async function generatePayrollArtifact(orgId: string, input: JsonObject, actorUserId: string) {
  const type = cleanText(input.type);
  const report = definition(type);
  const format = cleanText(input.format) === "pdf" ? "pdf" : "csv";
  const { batch, rows } = await exportRows(orgId, input);
  const generatedAt = new Date();
  const schedule = batch ? (await readPayrollSchedule(orgId, cleanText(batch.schedule_id))) : null;
  const coverageLabel = batch
    ? `${cleanText(batch.run_type) === "off_cycle" ? "Off-cycle payroll" : cleanText(schedule?.name || "Payroll")} - pay date ${friendlyDate(batch.pay_date)}`
    : `${friendlyDate(input.from)} through ${friendlyDate(input.through)}`;
  const columns = columnsFor(type);
  const contentHash = createHash("sha256").update(JSON.stringify({ type, format, coverageLabel, columns, rows })).digest("hex");
  const rawContent = format === "pdf"
    ? (await renderTemplatedArtifact({
        orgId,
        documentId: `doc_payroll_${contentHash.slice(0, 24)}`,
        documentType: "payroll_report",
        templateId: cleanText(input.template_id) || "tpl_payroll_report_default",
        title: report.label,
        actorUserId,
        fileName: `${safeFilePart(report.label)}.pdf`,
        params: {
          report_title: report.label,
          coverage_label: coverageLabel,
          generated_at: generatedAt.toISOString(),
          columns: columns.map((column) => ({ key: column.key, label: column.label })),
          rows: rows.map((row) => {
            const values = row as JsonObject;
            return Object.fromEntries(columns.map((column) => [column.key, displayValue(values[column.key], column.key)]));
          })
        },
        metadata: { source_system: "payroll", report_type: type, coverage_label: coverageLabel }
      })).bytes
    : Buffer.from(csv(rows, columns));
  const scopeKey = batch
    ? `payroll:${cleanText(batch.id)}:revision:${Number(batch.revision || 0)}`
    : `dates:${cleanText(input.from)}:${cleanText(input.through)}:projected:${input.include_projected === true ? "yes" : "no"}`;
  const existing = (await listPayrollArtifacts(orgId, { report_type: type, limit: 250 })).find((artifact) => {
    const metadata = asObject(artifact.metadata);
    return cleanText(metadata.format) === format && cleanText(metadata.scope_key) === scopeKey && cleanText(metadata.content_hash) === contentHash;
  });
  if (existing) return { ...existing, reused: true };
  const extension = format === "pdf" ? "pdf" : "csv";
  const fileName = `${safeFilePart(report.label)} - ${safeFilePart(coverageLabel)} - Generated ${generatedToken(generatedAt)}.${extension}`;
  return (await createPayrollArtifact(orgId, {
    batch_id: cleanText(input.batch_id), artifact_type: format === "pdf" ? "printable_report" : "spreadsheet_export",
    report_type: type, file_name: fileName, content_type: format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
    content: rawContent,
    metadata: {
      ...asObject(input.metadata), report_label: report.label, report_description: report.description, purpose: report.purpose,
      scope_label: batch ? "Payroll run" : "Date range", coverage_label: coverageLabel, scope_key: scopeKey,
      batch_pay_date: cleanText(batch?.pay_date), schedule_name: cleanText(schedule?.name), format, row_count: rows.length,
      from: batch ? cleanText(batch?.period_start) : cleanText(input.from), through: batch ? cleanText(batch?.period_end) : cleanText(input.through),
      content_hash: contentHash, generated_at: generatedAt.toISOString()
    }
  }, actorUserId));
}
