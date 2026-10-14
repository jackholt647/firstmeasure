import { listPayPlans, listPayRules, listPaySplitRules, savePayPlan, savePayRule, savePaySplitRule } from "./pay-rules.js";

const mine = { field: "assignee_key", operator: "equals", value: "$payee.key" };
/** Projects whose assignment field for a role names the payee, and that were not canceled. The standard scopes fill these fields from the sales appointment. */
const role = (key: string) => ({ rules: [{ field: `assignee_keys.assignments.${key}`, operator: "contains", value: "$payee.key" }, { field: "canceled_at", operator: "is_missing" }] });
const share = (label: string) => `const amount = Math.round(unit.record.contract_cents * params.rate_bps / 10000);
return { amount_cents: amount, description: ${JSON.stringify(label)} + " " + (unit.record.title || "project"), details: { contract_cents: unit.record.contract_cents, rate_bps: params.rate_bps } };`;

/**
 * A starting library: the common ways of being paid, written as pay rules,
 * plans that group them, and (further down) ways of dividing a group's pay. Rates are parameters, so nobody is
 * paid until a plan or a payee's setup supplies one. Matched by id; a rule or
 * plan that already exists is left as the organization has it.
 */
export const SAMPLE_PAY_RULES = [
  { id: "hourly_time_clock", name: "Hourly from the time clock", description: "Approved time clock hours each week, with overtime over a weekly threshold.", definition: {
    grain: "period" as const, period: "week" as const, kind: "hourly" as const,
    inputs: { shifts: { source: { provider: "payroll", export: "time_shifts" }, date: "clocked_out_at", where: { rules: [mine, { field: "approval_status", operator: "equals", value: "approved" }] } } },
    parameters: { rate_cents: { label: "Hourly rate", type: "cents" as const }, overtime_after_hours: { label: "Weekly hours before overtime", type: "number" as const, default: 40 }, overtime_multiplier: { label: "Overtime multiplier", type: "number" as const, default: 1.5 } },
    code: `if (!(params.rate_cents > 0)) throw new Error("Set this payee's hourly rate.");
const hours = unit.rows.shifts.reduce((sum, shift) => sum + shift.worked_seconds, 0) / 3600;
const regular = Math.min(hours, params.overtime_after_hours), overtime = hours - regular;
const lines = [{ key: "regular", amount_cents: Math.round(regular * params.rate_cents), description: regular.toFixed(2) + " hours", details: { hours: regular, rate_cents: params.rate_cents } }];
if (overtime > 0) lines.push({ key: "overtime", amount_cents: Math.round(overtime * params.rate_cents * params.overtime_multiplier), description: overtime.toFixed(2) + " overtime hours", details: { hours: overtime, multiplier: params.overtime_multiplier } });
return lines;`
  } },
  { id: "committed_labor", name: "Committed labor lists", description: "The total of each labor list committed to this payee, earned when its work is confirmed as done and finalized to be paid.", definition: {
    // Only finalized work has a finalized_at, and a finalized commitment can be neither released nor superseded.
    grain: "record" as const, kind: "piece_rate" as const, earned_at: "finalized_at", project: "project_id",
    inputs: { commitments: { primary: true, source: { provider: "payroll", export: "labor_commitments" }, where: { rules: [mine] } } },
    parameters: {},
    code: `if (unit.record.unpriced_lines > 0) throw new Error("This commitment has " + unit.record.unpriced_lines + " line(s) with no rate.");
return { amount_cents: unit.record.total_cents, description: "Committed labor" };`
  } },
  { id: "inside_sales_booking", name: "Booking fee for the inside salesperson", description: "A fixed amount for every sold project whose Inside salesperson field names this payee. Copy it and change the field to pay a different role.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "sold_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("inside_salesperson") } },
    parameters: { amount_cents: { label: "Amount per project", type: "cents" as const, default: 10000 } },
    code: `return { amount_cents: Math.round(params.amount_cents), description: "Booked " + (unit.record.title || "project") };`
  } },
  { id: "estimator_commission_sold", name: "Estimator commission when sold", description: "A share of the contract for every project whose Estimator field names this payee, earned when the project is sold.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "sold_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("estimator") } },
    parameters: { rate_bps: { label: "Share of contract", type: "basis_points" as const, default: 500 } },
    code: share("Sold")
  } },
  { id: "estimator_commission_completed", name: "Estimator commission when completed", description: "A share of the contract for every project whose Estimator field names this payee, earned when the project is completed.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "completed_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("estimator") } },
    parameters: { rate_bps: { label: "Share of contract", type: "basis_points" as const, default: 500 } },
    code: share("Completed")
  } },
  { id: "salary", name: "Salary", description: "An annual amount earned a day at a time. It reads no data; when it is paid follows the payee's pay schedule.", definition: {
    grain: "period" as const, period: "day" as const, always: true, kind: "salary" as const, inputs: {},
    parameters: { annual_cents: { label: "Annual salary", type: "cents" as const }, weekdays_only: { label: "Earn on weekdays only", type: "boolean" as const, default: false } },
    code: `if (!(params.annual_cents > 0)) throw new Error("Set this payee's annual salary.");
const weekend = unit.period.weekday === 0 || unit.period.weekday === 6;
if (params.weekdays_only && weekend) return null;
// Every day of the year earns an equal share; with weekdays only, 260 working days share it.
const days = params.weekdays_only ? 260 : unit.period.days_in_year;
return { amount_cents: Math.round(params.annual_cents / days), description: "Salary for " + unit.period.from };`
  } }
];
export const SAMPLE_PAY_PLANS = [
  { id: "hourly_staff", name: "Hourly staff", description: "Paid for approved time clock hours.", rules: [{ rule_id: "hourly_time_clock" }] },
  { id: "labor_by_commitment", name: "Paid by committed labor", description: "Paid the total of the labor lists committed to them.", rules: [{ rule_id: "committed_labor" }] },
  { id: "estimator", name: "Estimator", description: "A share of each contract, half when sold and half when completed.", rules: [{ rule_id: "estimator_commission_sold" }, { rule_id: "estimator_commission_completed" }] },
  { id: "inside_sales", name: "Inside sales", description: "A booking fee for each sold project they booked.", rules: [{ rule_id: "inside_sales_booking" }] },
  { id: "salaried", name: "Salaried", description: "An annual salary earned by the day.", rules: [{ rule_id: "salary" }] }
];

/** Approved time clock shifts of the group's members on the earning's project. Which shifts are read is all here; `window` says which of them belong to one earning. */
const shiftsOnTheJob = {
  source: { provider: "payroll", export: "time_shifts" }, member: "assignee_key", match: { project_id: "$earning.project_id" },
  where: { rules: [{ field: "assignee_key", operator: "in", value: "$members.keys" }, { field: "approval_status", operator: "equals", value: "approved" }] }
};
/**
 * Ways of dividing a group's earning among its members, written as split
 * rules. A group's pay names one under `distribution`. The two that read the
 * time clock divide earnings that carry a project (a rule that pays by record
 * and names its `project` field); an earning with no project has no shifts to
 * go by and stays unresolved rather than being shared out by guesswork.
 */
export const SAMPLE_PAY_SPLIT_RULES = [
  { id: "present_on_the_job", name: "Present on the job", description: "Members with an approved shift on the earning's project on the day it was earned share it equally. Anyone who was not there gets nothing for that job.", definition: {
    inputs: { shifts: { ...shiftsOnTheJob, window: { start: "clocked_in_at", end: "clocked_out_at" } } },
    parameters: { minimum_minutes: { label: "Minutes on the job that day to count as present", default: 1 } },
    code: `const shares = {};
for (const member of members) {
  // seconds is the exact part of each shift that fell inside the earned day.
  const seconds = rows.shifts.filter((shift) => shift.member === member.key).reduce((sum, shift) => sum + shift.seconds, 0);
  const present = seconds > 0 && seconds >= params.minimum_minutes * 60;
  shares[member.key] = { weight: present ? 1 : 0, details: { seconds_on_the_job: seconds },
    reason: present ? "On the job for " + (seconds / 3600).toFixed(2) + " hours that day" : seconds > 0 ? "On the job for less than " + params.minimum_minutes + " minutes that day" : "No approved shift on this job that day" };
}
return shares;`
  } },
  { id: "by_hours_on_the_job", name: "By hours on the job", description: "Members share an earning in proportion to their approved hours on its project, counting every shift that started before the end of the day it was earned.", definition: {
    inputs: { shifts: { ...shiftsOnTheJob, window: { start: "clocked_in_at", end: "clocked_out_at", any_time_before: true } } },
    parameters: {},
    code: `const shares = {};
for (const member of members) {
  // Hours worked, net of breaks, as the time clock recorded them.
  const seconds = rows.shifts.filter((shift) => shift.member === member.key).reduce((sum, shift) => sum + (shift.row.worked_seconds || 0), 0);
  shares[member.key] = { weight: seconds, details: { worked_seconds: seconds },
    reason: seconds > 0 ? (seconds / 3600).toFixed(2) + " approved hours on this job" : "No approved hours on this job" };
}
return shares;`
  } },
  { id: "whole_team", name: "Whole team regardless", description: "Every member shares equally whether or not they were there, as a sales team shares a commission.", definition: {
    inputs: {}, parameters: {},
    code: `const shares = {};
for (const member of members) shares[member.key] = { weight: 1, reason: "Member of the team" };
return shares;`
  } }
];

export async function seedSamplePayRules(orgId: string, actor: { userId: string }) {
  const rules = new Set((await listPayRules(orgId)).map((rule) => rule.id));
  const plans = new Set((await listPayPlans(orgId)).map((plan) => plan.id));
  // Effective from the start of the year so work already done in a new organization is covered once someone is put on a plan.
  const effective_from = `${new Date().getUTCFullYear()}-01-01`;
  for (const rule of SAMPLE_PAY_RULES) if (!rules.has(rule.id)) await savePayRule(orgId, { ...rule, effective_from }, actor);
  for (const plan of SAMPLE_PAY_PLANS) if (!plans.has(plan.id)) await savePayPlan(orgId, { ...plan, effective_from }, actor);
  const splits = new Set((await listPaySplitRules(orgId)).map((rule) => rule.id));
  for (const rule of SAMPLE_PAY_SPLIT_RULES) if (!splits.has(rule.id)) await savePaySplitRule(orgId, { ...rule, effective_from }, actor);
}
