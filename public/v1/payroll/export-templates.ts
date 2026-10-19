/*
 * Export templates (docs/architecture/pay-rules.md#export-templates). A pay run is copied out to whatever payroll or
 * accounting software a company uses with a template: which people, one row per person or per person and pay item,
 * and a list of columns, each a header and a source from the catalog below, with number and date formatting. The
 * Gusto, QuickBooks and pay run summary files are the built-in templates; a company duplicates one and changes it.
 *
 * Templates are data, stored per organization with a revision. A file is made from the template as it is when the
 * file is made, and the file records which template and revision made it; files made before never change.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import { listDocuments } from "../platform/storage.js";
import { scopedBatch, type PayeeScope } from "./payee-scope.js";
import { asArray, asObject, cleanText, listPayrollExportTemplates, readPayrollBatch, readPayrollExportTemplate, savePayrollExportTemplate, type JsonObject } from "./storage.js";

// ---- What a pay run holds for one payee ------------------------------------------------------------------------

export const PAY_KINDS = ["hourly", "salary", "piece_rate", "commission", "adjustment", "reimbursement"] as const;
export const LINE_KEYS = [...PAY_KINDS, "off_cycle", "taken_back"] as const;
export const PAY_ITEM_LABELS: Record<string, string> = { hourly: "Hourly pay", salary: "Salary", piece_rate: "Piece rate", commission: "Commission", adjustment: "Bonus or adjustment", reimbursement: "Reimbursement", off_cycle: "Already paid outside a pay run", taken_back: "Clawback or correction", work: "Subcontractor payments", reimbursements: "Reimbursements" };
type LineKey = typeof LINE_KEYS[number];
export type Lines = Record<LineKey, number>;
export type PayRunSection = "employees" | "contractors" | "bills";
export const SECTION_ORDER: PayRunSection[] = ["employees", "contractors", "bills"];
const SECTION_LABELS: Record<PayRunSection, string> = { employees: "Employees", contractors: "Contractors", bills: "Bills" };

/** One payee's part of a pay run, by kind: what was paid for and what was taken off. */
export function payeeLines(item: JsonObject): Lines {
  const lines: Lines = { hourly: 0, salary: 0, piece_rate: 0, commission: 0, adjustment: 0, reimbursement: 0, off_cycle: 0, taken_back: 0 };
  for (const entry of asArray(item.entries).map(asObject)) {
    const applied = Number(entry.allocation_cents || 0);
    if (applied > 0) {
      const kind = ((PAY_KINDS as readonly string[]).includes(cleanText(entry.kind)) ? cleanText(entry.kind) : "adjustment") as LineKey;
      lines[kind] += applied;
    } else if (applied < 0) {
      lines[cleanText(entry.subgroup) === "off_cycle" && Object.keys(asObject(asObject(entry.metadata).off_cycle_payment)).length ? "off_cycle" : "taken_back"] += applied;
    }
  }
  return lines;
}
export function nameParts(name: string) {
  const words = cleanText(name).split(" ").filter(Boolean);
  return words.length < 2 ? { first: words[0] || "", last: "" } : { first: words.slice(0, -1).join(" "), last: words[words.length - 1] || "" };
}
const isEmployee = (item: JsonObject) => cleanText(asObject(item.payee).worker_type || "employee") === "employee";
/** Which part of a pay run someone is in: employees, contractors paid with payroll, or bills paid through payables. */
export function payRunSection(item: JsonObject): PayRunSection {
  if (cleanText(asObject(item.metadata).paid_through) === "payables") return "bills";
  return isEmployee(item) ? "employees" : "contractors";
}
export function payRunMemo(batch: JsonObject, extra = "") {
  const period = cleanText(batch.period_start) ? `period ${cleanText(batch.period_start).slice(0, 10)} to ${cleanText(batch.period_end).slice(0, 10)}` : "";
  return [`Pay date ${cleanText(batch.pay_date)}`, period, extra].filter(Boolean).join(", ");
}
const dollars = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const humanize = (value: unknown) => { const text = cleanText(value).replace(/[_-]+/g, " "); return text ? text.charAt(0).toUpperCase() + text.slice(1) : ""; };

type Person = {
  item: JsonObject; payee: JsonObject; lines: Lines; section: PayRunSection; name: string; first: string; last: string;
  email: string; net: number; deductions: number; due_date: string;
};
type Line = { key: string; label: string; amount: number; description: string };

/** What a template reads besides the pay run: emails, branches, departments, approved hours, custom fields. */
export type TemplateContext = {
  batch: JsonObject;
  emails: Map<string, string>;
  schedule_name?: string;
  people?: Map<string, { branches: string[]; departments: string[] }>;
  hours?: Map<string, number>;
  fields?: Map<string, Record<string, string>>;
  warnings?: string[];
  /** Date-range reports: the dates, the ledger entries (earning rows) and the reimbursement requests (reimbursement rows). */
  range?: { from: string; through: string };
  entries?: JsonObject[];
  reimbursements?: JsonObject[];
};

function peopleOf(ctx: TemplateContext): Person[] {
  return asArray(ctx.batch.items).map(asObject).map((item) => {
    const payee = asObject(item.payee), lines = payeeLines(item);
    return {
      item, payee, lines, section: payRunSection(item), ...nameParts(cleanText(payee.name)), name: cleanText(payee.name || payee.id),
      email: cleanText(payee.type) === "organization_user" ? cleanText(ctx.emails.get(cleanText(payee.id))) : "",
      net: Number(item.net_cents || 0), deductions: lines.off_cycle + lines.taken_back, due_date: cleanText(asObject(item.metadata).due_date)
    };
  });
}

function linesOf(person: Person, definition: TemplateDefinition): Line[] {
  const label = (key: string) => cleanText(asObject(definition.pay_item_labels)[key]) || PAY_ITEM_LABELS[key] || key;
  if (definition.pay_items === "work_and_reimbursement") {
    const work = person.net - person.lines.reimbursement;
    return [
      ...(work ? [{ key: "work", label: label("work"), amount: work, description: person.deductions ? `Work in this pay run, after ${dollars(person.deductions)} already paid or taken back` : "Work in this pay run" }] : []),
      ...(person.lines.reimbursement ? [{ key: "reimbursements", label: label("reimbursements"), amount: person.lines.reimbursement, description: "Reimbursed expenses" }] : [])
    ];
  }
  return LINE_KEYS.filter((key) => person.lines[key] !== 0).map((key) => ({ key, label: label(key), amount: person.lines[key], description: label(key) }));
}

// ---- The source catalog -----------------------------------------------------------------------------------------

type Kind = "text" | "money" | "date" | "number";
/** What a template makes one row of: a person or a person and pay item of a pay run, or, for a date range, an earning of the ledger or a reimbursement. */
export const TEMPLATE_ROWS = ["person", "pay_item", "earning", "reimbursement"] as const;
export type TemplateRows = typeof TEMPLATE_ROWS[number];
const PAY_RUN_ROWS: readonly TemplateRows[] = ["person", "pay_item"];
/** Which kinds of row a source can fill, by what it is about. */
function rowsOf(id: string): TemplateRows[] {
  if (id === "fixed") return [...TEMPLATE_ROWS];
  if (id.startsWith("line.")) return ["pay_item"];
  if (id.startsWith("entry.")) return ["earning"];
  if (id.startsWith("reimbursement.")) return ["reimbursement"];
  if (id.startsWith("range.")) return ["earning", "reimbursement"];
  if (id.startsWith("person.")) return ["person", "pay_item", "earning"];
  return ["person", "pay_item"];
}
type SourceDef = { id: string; label: string; description: string; kind: Kind; group: string; needs?: "field" | "value"; rows?: TemplateRows[] };
/** Every value a column can show. Published (`export_templates.sources`) so no screen keeps its own copy. */
export const EXPORT_SOURCES: SourceDef[] = [
  { id: "person.name", group: "Person", kind: "text", label: "Name", description: "The person's, group's or company's name." },
  { id: "person.first_name", group: "Person", kind: "text", label: "First name", description: "Everything in the name before its last word." },
  { id: "person.last_name", group: "Person", kind: "text", label: "Last name", description: "The last word of the name; blank for a one-word name." },
  { id: "person.email", group: "Person", kind: "text", label: "Email", description: "A person's email. Blank for groups and companies." },
  { id: "person.id", group: "Person", kind: "text", label: "Platform ID", description: "The ID this platform keeps for the person, group or company. It never changes." },
  { id: "person.field", group: "Person", kind: "text", label: "Custom field", needs: "field", description: "One of a person's custom fields, such as an employee number your payroll software uses. Blank for groups and companies, and for a field you may not read." },
  { id: "person.type", group: "Person", kind: "text", label: "Person, group or company", description: "Person, Group or Company." },
  { id: "person.classification", group: "Person", kind: "text", label: "Worker classification", description: "Employee, Independent contractor or Subcontractor, as set in People." },
  { id: "person.contractor_type", group: "Person", kind: "text", label: "Individual or business", description: "Business for an outside company, Individual for everyone else." },
  { id: "person.section", group: "Person", kind: "text", label: "Paid as", description: "Employees, Contractors (paid with payroll) or Bills (paid through payables)." },
  { id: "person.paid_through", group: "Person", kind: "text", label: "Paid through", description: "Payroll or Payables." },
  { id: "person.payment_terms", group: "Person", kind: "text", label: "Payment terms", description: "On the pay schedule, or Net and a number of days, for someone paid through payables." },
  { id: "person.branch", group: "Person", kind: "text", label: "Branch", description: "The branches the payee belongs to, separated by semicolons." },
  { id: "person.department", group: "Person", kind: "text", label: "Department", description: "The departments the payee belongs to, separated by semicolons." },
  { id: "person.hours", group: "Person", kind: "number", label: "Approved hours", description: "Hours on approved shifts that ended inside the pay period, net of breaks. Blank for groups and companies." },
  { id: "pay.hourly", group: "Amounts", kind: "money", label: "Hourly pay", description: "Hourly earnings in this pay run." },
  { id: "pay.salary", group: "Amounts", kind: "money", label: "Salary", description: "Salary in this pay run." },
  { id: "pay.piece_rate", group: "Amounts", kind: "money", label: "Piece rate", description: "Piece-rate and labor earnings in this pay run." },
  { id: "pay.commission", group: "Amounts", kind: "money", label: "Commission", description: "Commissions in this pay run." },
  { id: "pay.adjustment", group: "Amounts", kind: "money", label: "Bonus or adjustment", description: "Bonuses, adjustments and any other earnings." },
  { id: "pay.reimbursement", group: "Amounts", kind: "money", label: "Reimbursement", description: "Approved expense reimbursements, paid in full." },
  { id: "pay.off_cycle", group: "Amounts", kind: "money", label: "Already paid outside a pay run", description: "Payments recorded as made outside a pay run, taken off here. Negative." },
  { id: "pay.taken_back", group: "Amounts", kind: "money", label: "Clawback or correction", description: "Clawbacks and corrections taken off here. Negative." },
  { id: "pay.earnings", group: "Amounts", kind: "money", label: "Earnings", description: "Every kind of earning except reimbursements, before anything is taken off." },
  { id: "pay.gross", group: "Amounts", kind: "money", label: "Earnings and reimbursements", description: "Earnings and reimbursements, before anything is taken off." },
  { id: "pay.deductions", group: "Amounts", kind: "money", label: "Taken off", description: "Already paid outside a pay run plus clawbacks. Negative." },
  { id: "pay.wage", group: "Amounts", kind: "money", label: "To pay, without reimbursements", description: "The amount to pay less reimbursements." },
  { id: "pay.net", group: "Amounts", kind: "money", label: "Amount to pay", description: "What this pay run pays them, after anything taken off." },
  { id: "line.label", group: "Pay item", kind: "text", rows: "pay_item", label: "Pay item", description: "The pay item this row is for (Hourly pay, Commission, ...). Rename them under Pay items." },
  { id: "line.amount", group: "Pay item", kind: "money", rows: "pay_item", label: "Pay item amount", description: "The amount of this pay item; what is taken off is negative." },
  { id: "line.key", group: "Pay item", kind: "text", rows: "pay_item", label: "Pay item code", description: "A fixed code for the pay item (hourly, salary, piece_rate, ...), for software that maps codes." },
  { id: "line.description", group: "Pay item", kind: "text", rows: "pay_item", label: "Pay item description", description: "A sentence about the pay item, such as what was already taken off." },
  { id: "run.pay_date", group: "Pay run", kind: "date", label: "Pay date", description: "The pay run's pay date." },
  { id: "run.period_start", group: "Pay run", kind: "date", label: "Period start", description: "The first day of the pay period." },
  { id: "run.period_end", group: "Pay run", kind: "date", label: "Period end", description: "The last day of the pay period." },
  { id: "run.schedule", group: "Pay run", kind: "text", label: "Pay schedule", description: "The pay schedule's name." },
  { id: "run.type", group: "Pay run", kind: "text", label: "Regular or off-cycle", description: "Regular or Off cycle." },
  { id: "run.status", group: "Pay run", kind: "text", label: "Pay run status", description: "Draft, Run, Partial or Paid." },
  { id: "run.currency", group: "Pay run", kind: "text", label: "Currency", description: "The pay run's currency code, such as USD." },
  { id: "run.memo", group: "Pay run", kind: "text", label: "Memo", description: "Pay date and period, as one sentence." },
  { id: "run.memo_deductions", group: "Pay run", kind: "text", label: "Memo with what was taken off", description: "The memo, and how much was already paid or taken back when anything was." },
  { id: "item.status", group: "Payment", kind: "text", label: "Payment status", description: "Draft, Run or Paid for this person." },
  { id: "item.payment_reference", group: "Payment", kind: "text", label: "Payment reference", description: "The check number or reference recorded when they were marked paid." },
  { id: "item.paid_on", group: "Payment", kind: "date", label: "Paid on", description: "The day they were marked paid." },
  { id: "bill.number", group: "Bill", kind: "text", label: "Bill number", description: "The pay date and the end of the payee's ID: the same number every time the file is made." },
  { id: "bill.date", group: "Bill", kind: "date", label: "Bill date", description: "The pay date." },
  { id: "bill.due_date", group: "Bill", kind: "date", label: "Due date", description: "The pay date plus the payee's net days; the pay date for anyone else." },
  { id: "entry.earned_on", group: "Earning", kind: "date", label: "Earned on", description: "The day the earning counts from for pay (its eligible date)." },
  { id: "entry.earned_at", group: "Earning", kind: "text", label: "Earned (date and time)", description: "The exact moment the earning counts from, as stored." },
  { id: "entry.kind", group: "Earning", kind: "text", label: "Earning type", description: "Hourly, Salary, Piece rate, Commission, Reimbursement, Adjustment or Clawback." },
  { id: "entry.kind_key", group: "Earning", kind: "text", label: "Earning type code", description: "A fixed code for the earning type (hourly, salary, ...), for software that maps codes." },
  { id: "entry.state", group: "Earning", kind: "text", label: "Earning status", description: "Accrued (earned), Projected (forecast or held for review) or Void." },
  { id: "entry.project_title", group: "Earning", kind: "text", label: "Project", description: "The project the earning came from, when it came from one." },
  { id: "entry.project_id", group: "Earning", kind: "text", label: "Project ID", description: "The project's ID." },
  { id: "entry.description", group: "Earning", kind: "text", label: "Earning description", description: "What the earning is for." },
  { id: "entry.amount", group: "Earning", kind: "money", label: "Earning amount", description: "The earning's amount; what is taken back is negative." },
  { id: "entry.applied", group: "Earning", kind: "money", label: "Already in a pay run", description: "How much of the earning pay runs have included." },
  { id: "entry.remaining", group: "Earning", kind: "money", label: "Still owed", description: "How much of the earning no pay run has included yet." },
  { id: "entry.currency", group: "Earning", kind: "text", label: "Earning currency", description: "The earning's currency code." },
  { id: "entry.id", group: "Earning", kind: "text", label: "Earning ID", description: "The ledger entry's ID. It never changes." },
  { id: "reimbursement.requested_by", group: "Reimbursement", kind: "text", label: "Requested by", description: "Who asked to be reimbursed." },
  { id: "reimbursement.project_id", group: "Reimbursement", kind: "text", label: "Reimbursement project", description: "The project the expense was for, when it was for one." },
  { id: "reimbursement.amount", group: "Reimbursement", kind: "money", label: "Reimbursement amount", description: "The amount asked for or approved." },
  { id: "reimbursement.currency", group: "Reimbursement", kind: "text", label: "Reimbursement currency", description: "The reimbursement's currency code." },
  { id: "reimbursement.status", group: "Reimbursement", kind: "text", label: "Reimbursement status", description: "Submitted, Approved, Paid, Rejected and so on." },
  { id: "reimbursement.requested_on", group: "Reimbursement", kind: "date", label: "Requested on (date)", description: "The day it was asked for." },
  { id: "reimbursement.requested_at", group: "Reimbursement", kind: "text", label: "Requested on", description: "The moment it was asked for, as stored." },
  { id: "reimbursement.approved_at", group: "Reimbursement", kind: "text", label: "Approved on", description: "The moment it was approved, as stored." },
  { id: "reimbursement.paid_at", group: "Reimbursement", kind: "text", label: "Paid on", description: "The moment it was paid, as stored." },
  { id: "reimbursement.timing", group: "Reimbursement", kind: "text", label: "Paid how", description: "With the next payroll, or off cycle." },
  { id: "reimbursement.note", group: "Reimbursement", kind: "text", label: "Reimbursement note", description: "The note given with the request." },
  { id: "range.from", group: "Dates", kind: "date", label: "From", description: "The first day of the report's dates." },
  { id: "range.through", group: "Dates", kind: "date", label: "Through", description: "The last day of the report's dates." },
  { id: "fixed", group: "Other", kind: "text", needs: "value", label: "Fixed text", description: "The same text on every row, such as a company code or an account name." }
].map((source) => ({ ...source, rows: rowsOf(source.id) })) as SourceDef[];
const SOURCE_IDS = EXPORT_SOURCES.map((source) => source.id) as [string, ...string[]];
const sourceOf = (id: string) => EXPORT_SOURCES.find((source) => source.id === id)!;
export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "M/D/YYYY", "DD/MM/YYYY", "YYYYMMDD"] as const;

// ---- What a template is ---------------------------------------------------------------------------------------

const formatSchema = z.object({
  decimals: z.number().int().min(0).max(4).optional(),
  unit: z.enum(["dollars", "cents"]).optional(),
  negative: z.enum(["minus", "parentheses"]).optional(),
  thousands: z.boolean().optional(),
  zero: z.enum(["show", "blank"]).optional(),
  date: z.enum(DATE_FORMATS).optional()
}).strict();
const columnSchema = z.object({
  header: z.string().trim().max(120),
  source: z.enum(SOURCE_IDS),
  value: z.string().max(300).optional(),
  field: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,179}$/, "Name the custom field by its path.").optional(),
  key: z.string().trim().regex(/^[a-z0-9_]{1,60}$/).optional(),
  format: formatSchema.optional()
}).strict().superRefine((column, issues) => {
  if (column.source === "person.field" && !column.field) issues.addIssue({ code: z.ZodIssueCode.custom, path: ["field"], message: "Choose which custom field this column shows." });
});
export const templateDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  /** person and pay_item make a file from one pay run; earning and reimbursement make a report for a date range. */
  rows: z.enum(TEMPLATE_ROWS),
  /** Earning rows: only these kinds of earning (all when left out), and forecasts and held corrections too when true. */
  kinds: z.array(z.enum(["hourly", "salary", "piece_rate", "commission", "reimbursement", "adjustment", "clawback"])).max(7).optional(),
  include_projected: z.boolean().optional(),
  pay_items: z.enum(["by_kind", "work_and_reimbursement"]).optional(),
  pay_item_labels: z.record(z.string().trim().max(120)).optional(),
  people: z.array(z.enum(["employees", "contractors", "bills"])).min(1).max(3),
  skip_zero: z.boolean().optional(),
  /** Pay run rows: by `name` (default) or `last_name`. Date-range rows keep the ledger's order unless sorted by name. */
  sort: z.enum(["name", "last_name", "none"]).optional(),
  group: z.enum(["section", "none"]).optional(),
  totals: z.enum(["none", "grand", "sections"]).optional(),
  number: formatSchema.omit({ date: true }).optional(),
  date: z.enum(DATE_FORMATS).optional(),
  file: z.object({ type: z.literal("csv"), delimiter: z.enum(["comma", "semicolon", "tab"]).optional(), bom: z.boolean().optional(), header_row: z.boolean().optional() }).strict().optional(),
  columns: z.array(columnSchema).min(1).max(60)
}).strict().superRefine((definition, issues) => {
  const rowWords: Record<TemplateRows, string> = { person: "one row per person of a pay run", pay_item: "one row per pay item", earning: "one row per earning", reimbursement: "one row per reimbursement" };
  definition.columns.forEach((column, index) => {
    const allowed = rowsOf(column.source);
    if (!allowed.includes(definition.rows)) issues.addIssue({ code: z.ZodIssueCode.custom, path: ["columns", index, "source"], message: `${sourceOf(column.source).label} needs ${allowed.map((rows) => rowWords[rows]).join(" or ")}.` });
  });
  if (!PAY_RUN_ROWS.includes(definition.rows) && definition.totals && definition.totals !== "none" && definition.totals !== "grand") issues.addIssue({ code: z.ZodIssueCode.custom, path: ["totals"], message: "A report for dates has at most a total at the end." });
  if (definition.rows === "pay_item" && definition.totals && definition.totals !== "none") issues.addIssue({ code: z.ZodIssueCode.custom, path: ["totals"], message: "Totals need one row per person." });
  if (definition.totals === "sections" && definition.group === "none") issues.addIssue({ code: z.ZodIssueCode.custom, path: ["totals"], message: "Totals per group need people grouped." });
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;
export type ExportTemplate = { id: string; name: string; built_in: boolean; based_on: string; revision: number; formats: string[]; scope: "pay_run" | "date_range"; definition: TemplateDefinition; updated_at?: string; updated_by?: string };
/** A pay run file (person or pay item rows), or a report for a date range (earning or reimbursement rows). */
export const templateScope = (definition: Pick<TemplateDefinition, "rows">): ExportTemplate["scope"] => PAY_RUN_ROWS.includes(definition.rows) ? "pay_run" : "date_range";

const money = (header: string, source: string, key: string) => ({ header, source, key });
const kindColumns = [
  money("Hourly pay", "pay.hourly", "hourly_cents"), money("Salary", "pay.salary", "salary_cents"), money("Piece rate", "pay.piece_rate", "piece_rate_cents"),
  money("Commission", "pay.commission", "commission_cents"), money("Bonus or adjustment", "pay.adjustment", "adjustment_cents"), money("Reimbursement", "pay.reimbursement", "reimbursement_cents"),
  money("Already paid outside a pay run", "pay.off_cycle", "off_cycle_cents"), money("Clawback or correction", "pay.taken_back", "taken_back_cents")
];
const ledgerColumns = [
  { header: "Earned on", source: "entry.earned_at", key: "eligible_at" }, { header: "Worker or company", source: "person.name", key: "payee_name" },
  { header: "Paid as", source: "person.classification", key: "worker_classification" }, { header: "Earning type", source: "entry.kind", key: "earning_kind" },
  { header: "Project", source: "entry.project_title", key: "project_title" }, { header: "Description", source: "entry.description", key: "description" },
  { header: "Amount", source: "entry.amount", key: "amount_cents" }, { header: "Already included", source: "entry.applied", key: "applied_cents" },
  { header: "Still owed", source: "entry.remaining", key: "remaining_cents" }, { header: "Status", source: "entry.state", key: "state" }
];
const period = [{ header: "Pay date", source: "run.pay_date", key: "pay_date" }, { header: "Period start", source: "run.period_start", key: "period_start" }, { header: "Period end", source: "run.period_end", key: "period_end" }];
/**
 * The files Payroll has always offered, as templates. Each makes exactly the file it made before it was a template
 * (tests/payroll-export-templates.test.ts holds those files), so most people just download one.
 */
export const BUILT_IN_TEMPLATES: ExportTemplate[] = ([
  { id: "pay_run_summary", formats: ["csv", "pdf"], definition: { name: "Pay run summary", description: "Everyone in the pay run, employees, contractors paid with payroll and bills, with earnings by kind, what was taken off and the amount to pay, with totals.", rows: "person", people: ["employees", "contractors", "bills"], sort: "name", group: "section", totals: "sections",
    columns: [{ header: "Paid as", source: "person.section", key: "section" }, { header: "Name", source: "person.name", key: "name" }, ...kindColumns, { header: "Amount to pay", source: "pay.net", key: "net_cents" }, { header: "Status", source: "item.status", key: "status" }, { header: "Payment reference", source: "item.payment_reference", key: "payment_reference" }] } },
  { id: "gusto_employees", formats: ["csv"], definition: { name: "Gusto: employees", description: "One row per employee in the columns of Gusto's earnings import.", rows: "person", people: ["employees"], sort: "last_name", group: "section", totals: "none",
    columns: [{ header: "Last Name", source: "person.last_name", key: "last_name" }, { header: "First Name", source: "person.first_name", key: "first_name" }, { header: "Email", source: "person.email", key: "email" }, ...kindColumns, { header: "Total To Pay", source: "pay.net", key: "net_cents" }, ...period, { header: "Personal Note", source: "run.memo", key: "memo" }] } },
  { id: "gusto_contractors", formats: ["csv"], definition: { name: "Gusto: contractors", description: "One row per contractor paid with payroll, in the columns of Gusto's contractor payments.", rows: "person", people: ["contractors"], sort: "name", group: "section", totals: "none",
    columns: [{ header: "Contractor", source: "person.name", key: "contractor" }, { header: "Email", source: "person.email", key: "email" }, { header: "Contractor Type", source: "person.contractor_type", key: "contractor_type" }, { header: "Wage", source: "pay.wage", key: "wage_cents" }, { header: "Reimbursement", source: "pay.reimbursement", key: "reimbursement_cents" }, { header: "Total", source: "pay.net", key: "net_cents" }, ...period, { header: "Memo", source: "run.memo_deductions", key: "memo" }] } },
  { id: "quickbooks_payroll", formats: ["csv"], definition: { name: "QuickBooks Payroll: employees", description: "One row per employee and pay item, the shape QuickBooks Payroll takes.", rows: "pay_item", pay_items: "by_kind", people: ["employees"], sort: "name", group: "section", totals: "none",
    columns: [{ header: "Employee", source: "person.name", key: "employee" }, { header: "Email", source: "person.email", key: "email" }, { header: "Pay Item", source: "line.label", key: "pay_item" }, { header: "Amount", source: "line.amount", key: "amount_cents" }, ...period, { header: "Memo", source: "run.memo", key: "memo" }] } },
  { id: "quickbooks_bills", formats: ["csv"], definition: { name: "QuickBooks: contractor bills", description: "Payees paid through payables as bills to vendors, one line per vendor and category, due on their payment terms.", rows: "pay_item", pay_items: "work_and_reimbursement", people: ["bills"], sort: "name", group: "section", totals: "none",
    columns: [{ header: "Vendor", source: "person.name", key: "vendor" }, { header: "Bill No", source: "bill.number", key: "bill_no" }, { header: "Bill Date", source: "bill.date", key: "bill_date" }, { header: "Due Date", source: "bill.due_date", key: "due_date" }, { header: "Category", source: "line.label", key: "category" }, { header: "Description", source: "line.description", key: "description" }, { header: "Amount", source: "line.amount", key: "amount_cents" }, { header: "Memo", source: "run.memo", key: "memo" }] } },
  // Reports for a date range, as templates (tests/fixtures/payroll-date-range-reports.json holds the files they always made).
  { id: "earnings_ledger", formats: ["csv", "pdf"], definition: { name: "All earnings", description: "Every earning recorded for the dates, employees and contractors, with what pay runs have included and what is still owed.", rows: "earning", people: ["employees", "contractors"], sort: "none", group: "none", totals: "none", columns: ledgerColumns } },
  { id: "commissions", formats: ["csv", "pdf"], definition: { name: "Commission report", description: "Commission earnings for the dates, with what pay runs have included and what is still owed.", rows: "earning", kinds: ["commission"], people: ["employees", "contractors"], sort: "none", group: "none", totals: "none", columns: ledgerColumns } },
  { id: "reimbursements", formats: ["csv", "pdf"], definition: { name: "Reimbursement report", description: "Reimbursements asked for in the dates, with their status.", rows: "reimbursement", people: ["employees", "contractors"], sort: "none", group: "none", totals: "none",
    columns: [{ header: "Employee", source: "reimbursement.requested_by", key: "requested_by_name" }, { header: "Project", source: "reimbursement.project_id", key: "project_id" }, { header: "Amount", source: "reimbursement.amount", key: "amount_cents" }, { header: "Currency", source: "reimbursement.currency", key: "currency" }, { header: "Status", source: "reimbursement.status", key: "status" }, { header: "Requested on", source: "reimbursement.requested_at", key: "requested_at" }, { header: "Approved on", source: "reimbursement.approved_at", key: "approved_at" }, { header: "Paid on", source: "reimbursement.paid_at", key: "paid_at" }, { header: "Note", source: "reimbursement.note", key: "note" }] } }
] as Array<{ id: string; formats: string[]; definition: unknown }>).map((entry) => { const definition = templateDefinitionSchema.parse(entry.definition); return { id: entry.id, name: definition.name, built_in: true, based_on: "", revision: 0, formats: entry.formats, scope: templateScope(definition), definition }; });
export const isBuiltInTemplate = (id: string) => BUILT_IN_TEMPLATES.some((template) => template.id === id);

// ---- Making the table --------------------------------------------------------------------------------------------

type Value = { kind: Kind; value: string | number | null };
function valueOf(source: string, column: TemplateDefinition["columns"][number], person: Person | null, line: Line | null, ctx: TemplateContext, total: null | { section: PayRunSection | "all"; people: Person[] }): Value {
  const batch = ctx.batch, def = sourceOf(source);
  const text = (value: unknown): Value => ({ kind: "text", value: cleanText(value) });
  const cents = (value: number): Value => ({ kind: "money", value });
  const date = (value: unknown): Value => ({ kind: "date", value: cleanText(value).slice(0, 10) });
  if (source === "range.from") return date(ctx.range?.from);
  if (source === "range.through") return date(ctx.range?.through);
  if (source.startsWith("entry.")) {
    const entry = asObject(person?.item);
    if (source === "entry.earned_on") return date(entry.eligible_at);
    if (source === "entry.earned_at") return text(entry.eligible_at);
    if (source === "entry.kind") return text(humanize(entry.kind));
    if (source === "entry.kind_key") return text(entry.kind);
    if (source === "entry.state") return text(humanize(entry.state));
    if (source === "entry.amount") return cents(Number(entry.amount_cents || 0));
    if (source === "entry.applied") return cents(Number(entry.applied_cents || 0));
    if (source === "entry.remaining") return cents(Number(entry.remaining_cents || 0));
    if (source === "entry.currency") return text(entry.currency || "USD");
    return text(entry[source.slice("entry.".length)]);
  }
  if (source.startsWith("reimbursement.")) {
    const request = asObject(person?.item);
    if (source === "reimbursement.requested_by") return text(asObject(request.requested_by).name);
    if (source === "reimbursement.amount") return cents(Number(request.amount_cents || 0));
    if (source === "reimbursement.currency") return text(request.currency || "USD");
    if (source === "reimbursement.status") return text(humanize(request.status));
    if (source === "reimbursement.requested_on") return date(request.requested_at);
    if (source === "reimbursement.timing") return text(humanize(request.payment_timing));
    return text(request[source.slice("reimbursement.".length).replace(/^requested_at$/, "requested_at")]);
  }
  if (source.startsWith("run.") || source === "fixed") {
    if (source === "fixed") return text(column.value);
    if (source === "run.pay_date") return date(batch.pay_date);
    if (source === "run.period_start") return date(batch.period_start);
    if (source === "run.period_end") return date(batch.period_end);
    if (source === "run.schedule") return text(ctx.schedule_name);
    if (source === "run.type") return text(humanize(batch.run_type || "regular"));
    if (source === "run.status") return text(humanize(batch.status));
    if (source === "run.currency") return text(batch.currency || "USD");
  }
  if (total) {
    // A total row adds up amounts; it names its group, and the grand total carries the pay run's status.
    if (def.kind === "money" && !source.startsWith("line.")) return cents(total.people.reduce((sum, row) => sum + Number(valueOf(source, column, row, null, ctx, null).value || 0), 0));
    if (source === "person.section") return text(total.section === "all" ? "Total" : SECTION_LABELS[total.section]);
    if (source === "person.name") return text(total.section === "all" ? "Pay run total" : `${SECTION_LABELS[total.section]} total`);
    if (source === "item.status") return text(total.section === "all" ? humanize(batch.status) : "");
    if (source === "run.memo") return text(payRunMemo(batch));
    return text("");
  }
  const row = person!, payee = row.payee, metadata = asObject(row.item.metadata), key = `${cleanText(payee.type)}:${cleanText(payee.id)}`;
  switch (source) {
    case "person.name": return text(row.name);
    case "person.first_name": return text(row.first);
    case "person.last_name": return text(row.last);
    case "person.email": return text(row.email);
    case "person.id": return text(payee.id);
    case "person.field": return text(cleanText(payee.type) === "organization_user" ? asObject(ctx.fields?.get(cleanText(payee.id)))[cleanText(column.field)] : "");
    case "person.type": return text(({ organization_user: "Person", resource_group: "Group", organization_connection: "Company" } as Record<string, string>)[cleanText(payee.type)] || "");
    case "person.classification": return text(humanize(payee.worker_type || "employee"));
    case "person.contractor_type": return text(cleanText(payee.type) === "organization_connection" ? "Business" : "Individual");
    case "person.section": return text(SECTION_LABELS[row.section]);
    case "person.paid_through": return text(row.section === "bills" ? "Payables" : "Payroll");
    case "person.payment_terms": { const terms = asObject(metadata.payment_terms); return text(row.section !== "bills" ? "" : cleanText(terms.basis) === "net_days" ? `Net ${Number(terms.net_days || 0)}` : "On the pay schedule"); }
    case "person.branch": return text((ctx.people?.get(key)?.branches || []).join("; "));
    case "person.department": return text((ctx.people?.get(key)?.departments || []).join("; "));
    case "person.hours": return cleanText(payee.type) === "organization_user" ? { kind: "number", value: Number(ctx.hours?.get(cleanText(payee.id)) || 0) / 3600 } : { kind: "number", value: null };
    case "pay.hourly": case "pay.salary": case "pay.piece_rate": case "pay.commission": case "pay.adjustment": case "pay.reimbursement": case "pay.off_cycle": case "pay.taken_back":
      return cents(row.lines[source.slice(4) as LineKey]);
    case "pay.earnings": return cents(PAY_KINDS.filter((kind) => kind !== "reimbursement").reduce((sum, kind) => sum + row.lines[kind], 0));
    case "pay.gross": return cents(PAY_KINDS.reduce((sum, kind) => sum + row.lines[kind], 0));
    case "pay.deductions": return cents(row.deductions);
    case "pay.wage": return cents(row.net - row.lines.reimbursement);
    case "pay.net": return cents(row.net);
    case "line.label": return text(line?.label);
    case "line.amount": return cents(Number(line?.amount || 0));
    case "line.key": return text(line?.key);
    case "line.description": return text(line?.description);
    case "run.memo": return text(payRunMemo(batch));
    case "run.memo_deductions": return text(payRunMemo(batch, row.deductions ? `after ${dollars(row.deductions)} already paid or taken back` : ""));
    case "item.status": return text(humanize(row.item.status));
    case "item.payment_reference": return text(row.item.payment_reference);
    case "item.paid_on": return date(row.item.paid_at);
    case "bill.number": return text(`${cleanText(batch.pay_date)}-${cleanText(payee.id).slice(-8)}`);
    case "bill.date": return date(batch.pay_date);
    case "bill.due_date": return date(row.due_date || batch.pay_date);
  }
  return text("");
}

function formatDate(value: string, format: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const [, y, m, d] = match;
  if (format === "MM/DD/YYYY") return `${m}/${d}/${y}`;
  if (format === "M/D/YYYY") return `${Number(m)}/${Number(d)}/${y}`;
  if (format === "DD/MM/YYYY") return `${d}/${m}/${y}`;
  if (format === "YYYYMMDD") return `${y}${m}${d}`;
  return value;
}
function formatNumber(amount: number, decimals: number, thousands: boolean) {
  const fixed = Math.abs(amount).toFixed(decimals);
  if (!thousands) return fixed;
  const [whole, fraction] = fixed.split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction !== undefined ? `.${fraction}` : ""}`;
}
/** A value as the file shows it. Money is in whole units with two decimals unless the template says otherwise. */
export function formatValue(value: Value, column: TemplateDefinition["columns"][number], definition: TemplateDefinition) {
  const format = { ...asObject(definition.number), ...(definition.date ? { date: definition.date } : {}), ...asObject(column.format) } as z.infer<typeof formatSchema>;
  if (value.value === null || value.value === undefined || value.value === "") return "";
  if (value.kind === "date") return formatDate(String(value.value), format.date || "YYYY-MM-DD");
  if (value.kind === "number") return formatNumber(Number(value.value), format.decimals ?? 2, format.thousands === true);
  if (value.kind !== "money") return String(value.value);
  const cents = Math.round(Number(value.value) || 0);
  if (cents === 0 && format.zero === "blank") return "";
  const body = format.unit === "cents" ? formatNumber(cents, 0, format.thousands === true) : formatNumber(cents / 100, format.decimals ?? 2, format.thousands === true);
  if (cents >= 0) return body;
  return format.negative === "parentheses" ? `(${body})` : `-${body}`;
}

export type RenderedTable = { headers: string[]; keys: string[]; rows: string[][]; person_count: number };
/** Ledger entries as rows: each carries the entry as its `item` and its payee, so person sources read the payee. */
function recordsOfEntries(ctx: TemplateContext, definition: TemplateDefinition): Person[] {
  const kinds = definition.kinds?.length ? new Set<string>(definition.kinds) : null;
  return asArray(ctx.entries).map(asObject).filter((entry) => !kinds || kinds.has(cleanText(entry.kind))).map((entry) => {
    const payee = asObject(entry.payee);
    return { item: entry, payee, lines: payeeLines({}), section: isEmployee(entry) ? "employees" : "contractors", ...nameParts(cleanText(payee.name)), name: cleanText(payee.name || payee.id),
      email: cleanText(payee.type) === "organization_user" ? cleanText(ctx.emails.get(cleanText(payee.id))) : "", net: Number(entry.amount_cents || 0), deductions: 0, due_date: "" } as Person;
  });
}
function recordsOfReimbursements(ctx: TemplateContext): Person[] {
  return asArray(ctx.reimbursements).map(asObject).map((request) => {
    const by = asObject(request.requested_by);
    const payee = { type: "organization_user", id: cleanText(by.user_id), name: cleanText(by.name) };
    return { item: request, payee, lines: payeeLines({}), section: "employees", ...nameParts(cleanText(by.name)), name: cleanText(by.name), email: cleanText(ctx.emails.get(cleanText(by.user_id))), net: Number(request.amount_cents || 0), deductions: 0, due_date: "" } as Person;
  });
}

/** The file's table: headers and display strings, one row per person (and total), or per person and pay item. */
export function renderTemplate(definitionValue: TemplateDefinition, ctx: TemplateContext): RenderedTable {
  const definition = templateDefinitionSchema.parse(definitionValue);
  const columns = definition.columns;
  const keys = columns.map((column, index) => column.key || `c${index + 1}`);
  const wanted = new Set(definition.people);
  const cellOf = (person: Person | null, line: Line | null, total: null | { section: PayRunSection | "all"; people: Person[] }) => columns.map((column) => formatValue(valueOf(column.source, column, person, line, ctx, total), column, definition));
  if (!PAY_RUN_ROWS.includes(definition.rows)) {
    // A report for dates: one row per ledger entry or reimbursement request, in the order they were read unless sorted by name.
    const subjects = definition.rows === "earning" ? recordsOfEntries(ctx, definition).filter((row) => wanted.has(row.section)) : recordsOfReimbursements(ctx);
    if (definition.sort === "name" || definition.sort === "last_name") subjects.sort(definition.sort === "last_name" ? (a, b) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first) : (a, b) => a.name.localeCompare(b.name));
    const rows = subjects.map((subject) => cellOf(subject, null, null));
    if (definition.totals === "grand") rows.push(columns.map((column, index) => {
      const def = sourceOf(column.source);
      if (def.kind === "money") return formatValue({ kind: "money", value: subjects.reduce((sum, subject) => sum + Number(valueOf(column.source, column, subject, null, ctx, null).value || 0), 0) }, column, definition);
      return index === 0 ? "Total" : "";
    }));
    return { headers: columns.map((column) => column.header), keys, rows, person_count: new Set(subjects.map((subject) => `${cleanText(subject.payee.type)}:${cleanText(subject.payee.id)}`)).size };
  }
  let people = peopleOf(ctx).filter((row) => wanted.has(row.section));
  if (definition.skip_zero) people = people.filter((row) => row.net !== 0);
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name);
  const byLast = (a: Person, b: Person) => a.last.localeCompare(b.last) || a.first.localeCompare(b.first);
  const order = definition.sort === "last_name" ? byLast : byName;
  const groups: Array<{ section: PayRunSection | "all"; people: Person[] }> = definition.group === "none"
    ? [{ section: "all", people: [...people].sort(order) }]
    : SECTION_ORDER.filter((section) => wanted.has(section)).map((section) => ({ section, people: people.filter((row) => row.section === section).sort(order) }));
  const cell = (person: Person | null, line: Line | null, total: null | { section: PayRunSection | "all"; people: Person[] }) => columns.map((column) => formatValue(valueOf(column.source, column, person, line, ctx, total), column, definition));
  const rows: string[][] = [];
  for (const group of groups) {
    if (!group.people.length) continue;
    for (const person of group.people) {
      if (definition.rows === "pay_item") for (const line of linesOf(person, definition)) rows.push(cell(person, line, null));
      else rows.push(cell(person, null, null));
    }
    if (definition.rows === "person" && definition.totals === "sections" && group.section !== "all") rows.push(cell(null, null, group));
  }
  if (definition.rows === "person" && definition.totals && definition.totals !== "none") rows.push(cell(null, null, { section: "all", people }));
  return { headers: columns.map((column) => column.header), keys, rows, person_count: people.length };
}

const DELIMITERS = { comma: ",", semicolon: ";", tab: "\t" } as const;
/** CSV the way spreadsheets read it: a byte order mark, CRLF line ends, quoted where needed. */
export function tableCsv(table: RenderedTable, definition: TemplateDefinition) {
  const delimiter = DELIMITERS[definition.file?.delimiter || "comma"];
  const quote = (text: string) => (text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const lines = [...(definition.file?.header_row === false ? [] : [table.headers.map(quote).join(delimiter)]), ...table.rows.map((row) => row.map(quote).join(delimiter))];
  return `${definition.file?.bom === false ? "" : "﻿"}${lines.join("\r\n")}\r\n`;
}
export function fileTypeOf(definition: TemplateDefinition) {
  return definition.file?.delimiter === "tab" ? { extension: "tsv", content_type: "text/tab-separated-values; charset=utf-8" } : { extension: "csv", content_type: "text/csv; charset=utf-8" };
}

// ---- What a template needs read ------------------------------------------------------------------------------------

/**
 * Reads only what the template's columns use. Branches and departments come from the organization structure; approved
 * hours from the time clock in the pay period; a custom field only when the viewer may read it (custom_fields).
 */
export async function templateContext(orgId: string, batch: JsonObject, definition: TemplateDefinition, auth?: PlatformAuthContext | null, range?: { from: string; through: string; include_projected?: boolean; scope?: PayeeScope }): Promise<TemplateContext> {
  const uses = new Set(definition.columns.map((column) => column.source));
  const ctx: TemplateContext = { batch, emails: new Map(), warnings: [], ...(range ? { range: { from: range.from, through: range.through } } : {}) };
  if (range && definition.rows === "earning") {
    // The ledger for the dates, as the earnings report always read it: by eligible day, forecasts only when asked for.
    const projected = range.include_projected === true || definition.include_projected === true;
    const entries = await (await import("./storage.js")).listPayrollLedgerEntries(orgId, { limit: 5000 });
    ctx.entries = entries.filter((entry) => cleanText(entry.eligible_at).slice(0, 10) >= range.from && cleanText(entry.eligible_at).slice(0, 10) <= range.through
      && (projected || cleanText(entry.state) !== "projected") && (!range.scope || range.scope.visible(asObject(entry.payee))));
    if (entries.length >= 5000) ctx.warnings!.push("Only the first 5,000 earnings of the ledger were read.");
  }
  if (range && definition.rows === "reimbursement") {
    const receipts = await listDocuments(orgId, "payment_receipts");
    ctx.reimbursements = receipts.map((doc) => asObject(asObject(doc.data).reimbursement_request)).filter((request) => cleanText(request.id)
      && cleanText(request.requested_at).slice(0, 10) >= range.from && cleanText(request.requested_at).slice(0, 10) <= range.through
      && (!range.scope || range.scope.visible({ type: "organization_user", id: cleanText(asObject(request.requested_by).user_id) })));
  }
  const users = uses.has("person.email") || uses.has("person.field") ? await listDocuments(orgId, "users") : [];
  ctx.emails = new Map(users.map((row) => [cleanText(row.id), cleanText(asObject(row.data).email)]));
  if (uses.has("run.schedule")) ctx.schedule_name = cleanText((await (await import("./storage.js")).readPayrollSchedule(orgId, cleanText(batch.schedule_id)).catch(() => null))?.name);
  if (uses.has("person.branch") || uses.has("person.department")) {
    const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(orgId);
    const branchName = new Map(structure.branches.map((branch) => [branch.id, branch.name || (branch.is_default ? "Main branch" : branch.id)]));
    const departmentName = new Map(asArray(asObject(structure.catalog).departments).map(asObject).map((row) => [cleanText(row.id), cleanText(row.name) || cleanText(row.id)]));
    ctx.people = new Map();
    for (const [type, list] of [["organization_user", structure.users], ["resource_group", structure.groups], ["organization_connection", structure.connections]] as const) {
      for (const row of list) ctx.people.set(`${type}:${row.id}`, { branches: row.branch_ids.map((id) => branchName.get(id) || id), departments: row.department_ids.map((id) => departmentName.get(id) || id) });
    }
  }
  if (uses.has("person.hours")) {
    const { listPayrollTimesheets } = await import("./timesheets.js");
    const result = await listPayrollTimesheets(orgId, { from: cleanText(batch.period_start || range?.from).slice(0, 10), through: cleanText(batch.period_end || range?.through).slice(0, 10), approval_status: "approved", limit: 1000 });
    ctx.hours = new Map();
    for (const shift of asArray(result.timesheets).map(asObject).filter((row) => cleanText(row.status) === "closed")) ctx.hours.set(cleanText(shift.user_id), (ctx.hours.get(cleanText(shift.user_id)) || 0) + Number(shift.worked_seconds || 0));
    if (asArray(result.timesheets).length >= 1000) ctx.warnings!.push("Approved hours were read from the first 1,000 shifts of the period only.");
  }
  const paths = [...new Set(definition.columns.filter((column) => column.source === "person.field").map((column) => cleanText(column.field)))];
  if (paths.length) {
    const { definitions, valuesOf, canReadField } = await import("../custom_fields/records.js");
    const ids = new Set([...asArray(batch.items).map(asObject).map((item) => asObject(item.payee)), ...asArray(ctx.entries).map((entry) => asObject(asObject(entry).payee))].filter((payee) => cleanText(payee.type) === "organization_user").map((payee) => cleanText(payee.id)));
    ctx.fields = new Map();
    const hidden = new Set<string>();
    for (const row of users.filter((doc) => ids.has(cleanText(doc.id)))) {
      const record = asObject(row.data), values = valuesOf(record, "user");
      const declared = await definitions(orgId, "default", "user", { ...record, id: row.id }).catch(() => [] as JsonObject[]);
      const shown: Record<string, string> = {};
      for (const path of paths) {
        const field = asArray(declared).map(asObject).find((entry) => cleanText(entry.path || entry.key) === path);
        if (field && !canReadField({ auth: auth || undefined } as never, field)) { hidden.add(path); continue; }
        const value = path.split(".").reduce<unknown>((current, part) => asObject(current)[part], values);
        shown[path] = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
      }
      ctx.fields.set(cleanText(row.id), shown);
    }
    for (const path of hidden) ctx.warnings!.push(`The custom field ${path} is private; it is left blank.`);
  }
  return ctx;
}

// ---- Stored templates --------------------------------------------------------------------------------------------

function storedView(row: Awaited<ReturnType<typeof readPayrollExportTemplate>>): ExportTemplate {
  const parsed = templateDefinitionSchema.safeParse(row.definition);
  const definition = parsed.success ? parsed.data : { ...(row.definition as TemplateDefinition), name: row.name };
  // A company's own template also prints: the same table as a PDF.
  return { id: row.id, name: row.name, built_in: false, based_on: row.based_on, revision: row.revision, formats: ["csv", "pdf"], scope: templateScope(definition), definition, updated_at: row.updated_at, updated_by: row.updated_by };
}
/** The built-in templates, then the organization's own, by name. */
export async function listExportTemplates(orgId: string) {
  return [...BUILT_IN_TEMPLATES, ...(await listPayrollExportTemplates(orgId)).map(storedView)];
}
export async function readExportTemplate(orgId: string, id: string): Promise<ExportTemplate> {
  const builtIn = BUILT_IN_TEMPLATES.find((template) => template.id === id);
  if (builtIn) return builtIn;
  const row = await readPayrollExportTemplate(orgId, id);
  if (row.status === "archived") throw badRequest("payroll_export_template_archived", "That export template was removed.");
  return storedView(row);
}
export const exportTemplateSaveSchema = z.object({
  id: z.string().trim().regex(/^pay_export_[a-z0-9]{6,40}$/).optional(),
  expected_revision: z.number().int().min(1).optional(),
  based_on: z.string().trim().max(120).optional(),
  definition: templateDefinitionSchema
}).strict();
/** Saves a company's own template. A built-in is never changed: duplicate it (`based_on`) and change the copy. */
export async function saveExportTemplate(orgId: string, input: z.infer<typeof exportTemplateSaveSchema>, actorUserId: string) {
  const id = input.id || `pay_export_${randomBytes(6).toString("hex")}`;
  if (isBuiltInTemplate(id)) throw badRequest("payroll_export_template_built_in", "A built-in template cannot be changed. Duplicate it and change the copy.");
  const saved = await savePayrollExportTemplate(orgId, { id, name: input.definition.name, based_on: cleanText(input.based_on), definition: input.definition as JsonObject, ...(input.expected_revision ? { expected_revision: input.expected_revision } : {}) }, actorUserId);
  return storedView(saved);
}
export async function archiveExportTemplate(orgId: string, id: string, expectedRevision: number, actorUserId: string) {
  if (isBuiltInTemplate(id)) throw badRequest("payroll_export_template_built_in", "A built-in template cannot be removed.");
  const row = await readPayrollExportTemplate(orgId, id);
  return storedView(await savePayrollExportTemplate(orgId, { id, name: row.name, based_on: row.based_on, status: "archived", definition: row.definition, expected_revision: expectedRevision }, actorUserId));
}

/** What the screens offer: the templates, every source a column can use, and the formats. */
export async function exportTemplateCatalog(orgId: string) {
  return {
    templates: await listExportTemplates(orgId),
    sources: EXPORT_SOURCES.map((source) => ({ ...source })),
    date_formats: [...DATE_FORMATS],
    pay_item_labels: PAY_ITEM_LABELS,
    people: SECTION_ORDER.map((id) => ({ id, label: SECTION_LABELS[id] }))
  };
}

export const exportTemplatePreviewSchema = z.object({
  /** A pay run, for a pay run file; or `from` and `through`, for a report for dates. */
  batch_id: z.string().trim().min(1).max(180).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  include_projected: z.boolean().optional(),
  template_id: z.string().trim().max(120).optional(),
  definition: templateDefinitionSchema.optional(),
  limit: z.number().int().min(1).max(50).optional()
}).strict().refine((value) => !!value.template_id || !!value.definition, "Choose a template, or give its definition.");
/** The first rows a template makes from one pay run, as the file would show them. Saves nothing. */
export async function previewExportTemplate(orgId: string, input: z.infer<typeof exportTemplatePreviewSchema>, scope: PayeeScope, auth?: PlatformAuthContext | null) {
  const definition = input.definition || (await readExportTemplate(orgId, cleanText(input.template_id))).definition;
  const dated = templateScope(definition) === "date_range";
  if (dated && (!input.from || !input.through)) throw badRequest("payroll_export_dates_required", "Choose a start date and end date for this report.");
  if (!dated && !input.batch_id) throw badRequest("payroll_export_batch_required", "Choose the pay run this file should cover.");
  const batch = dated ? {} : scopedBatch(await readPayrollBatch(orgId, input.batch_id!) as JsonObject, scope);
  const ctx = await templateContext(orgId, batch, definition, auth, dated ? { from: input.from!, through: input.through!, include_projected: input.include_projected, scope } : undefined);
  const table = renderTemplate(definition, ctx);
  return { headers: table.headers, rows: table.rows.slice(0, input.limit || 8), row_count: table.rows.length, person_count: table.person_count, warnings: ctx.warnings || [], file: fileTypeOf(definition) };
}
