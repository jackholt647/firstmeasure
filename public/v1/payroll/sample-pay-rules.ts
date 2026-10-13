import { listPayPlans, listPayRules, savePayPlan, savePayRule } from "./pay-rules.js";

const mine = { field: "assignee_key", operator: "equals", value: "$payee.key" };
/** Projects whose assignment field for a role names the payee, and that were not canceled. The standard scopes fill these fields from the sales appointment. */
const role = (key: string) => ({ rules: [{ field: `assignee_keys.assignments.${key}`, operator: "contains", value: "$payee.key" }, { field: "canceled_at", operator: "is_missing" }] });
const share = (label: string) => `const amount = Math.round(unit.record.contract_cents * params.rate_bps / 10000);
return { amount_cents: amount, description: ${JSON.stringify(label)} + " " + (unit.record.title || "project"), details: { contract_cents: unit.record.contract_cents, rate_bps: params.rate_bps } };`;

/**
 * A starting library: the common ways of being paid, written as pay rules,
 * and plans that group them. Rates are parameters, so nobody is
 * paid until a plan or a payee's setup supplies one. Matched by id; a rule or
 * plan that already exists is left as the organization has it.
 */
export const SAMPLE_PAY_RULES = [
  { id: "hourly_time_clock", name: "Hourly from the time clock", description: "Approved time clock hours each week, with overtime over a weekly threshold.", definition: {
    grain: "period" as const, period: "week" as const, kind: "hourly" as const,
    inputs: { shifts: { source: { provider: "payroll", export: "time_shifts" }, date: "clocked_out_at", where: { rules: [mine, { field: "approval_status", operator: "equals", value: "approved" }] } } },
    parameters: { rate_cents: { label: "Hourly rate (cents)" }, overtime_after_hours: { label: "Weekly hours before overtime", default: 40 }, overtime_multiplier: { label: "Overtime multiplier", default: 1.5 } },
    code: `if (!(params.rate_cents > 0)) throw new Error("Set this payee's hourly rate.");
const hours = unit.rows.shifts.reduce((sum, shift) => sum + shift.worked_seconds, 0) / 3600;
const regular = Math.min(hours, params.overtime_after_hours), overtime = hours - regular;
const lines = [{ key: "regular", amount_cents: Math.round(regular * params.rate_cents), description: regular.toFixed(2) + " hours", details: { hours: regular, rate_cents: params.rate_cents } }];
if (overtime > 0) lines.push({ key: "overtime", amount_cents: Math.round(overtime * params.rate_cents * params.overtime_multiplier), description: overtime.toFixed(2) + " overtime hours", details: { hours: overtime, multiplier: params.overtime_multiplier } });
return lines;`
  } },
  { id: "committed_labor", name: "Committed labor lists", description: "The total of each labor list committed to this payee, earned when the commitment is released.", definition: {
    grain: "record" as const, kind: "piece_rate" as const, earned_at: "released_at", project: "project_id",
    inputs: { commitments: { primary: true, source: { provider: "payroll", export: "labor_commitments" }, where: { rules: [mine, { field: "status", operator: "equals", value: "released" }] } } },
    parameters: {},
    code: `if (unit.record.unpriced_lines > 0) throw new Error("This commitment has " + unit.record.unpriced_lines + " line(s) with no rate.");
return { amount_cents: unit.record.total_cents, description: "Committed labor" };`
  } },
  { id: "inside_sales_booking", name: "Booking fee for the inside salesperson", description: "A fixed amount for every sold project whose Inside salesperson field names this payee. Copy it and change the field to pay a different role.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "sold_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("inside_salesperson") } },
    parameters: { amount_cents: { label: "Amount per project (cents)", default: 10000 } },
    code: `return { amount_cents: Math.round(params.amount_cents), description: "Booked " + (unit.record.title || "project") };`
  } },
  { id: "estimator_commission_sold", name: "Estimator commission when sold", description: "A share of the contract for every project whose Estimator field names this payee, earned when the project is sold.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "sold_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("estimator") } },
    parameters: { rate_bps: { label: "Share of contract (basis points)", default: 500 } },
    code: share("Sold")
  } },
  { id: "estimator_commission_completed", name: "Estimator commission when completed", description: "A share of the contract for every project whose Estimator field names this payee, earned when the project is completed.", definition: {
    grain: "record" as const, kind: "commission" as const, earned_at: "completed_at", project: "id",
    inputs: { projects: { primary: true, source: { provider: "payroll", export: "project_records", args: { facts: true } }, where: role("estimator") } },
    parameters: { rate_bps: { label: "Share of contract (basis points)", default: 500 } },
    code: share("Completed")
  } }
];
export const SAMPLE_PAY_PLANS = [
  { id: "hourly_staff", name: "Hourly staff", description: "Paid for approved time clock hours.", rules: [{ rule_id: "hourly_time_clock" }] },
  { id: "labor_by_commitment", name: "Paid by committed labor", description: "Paid the total of the labor lists committed to them.", rules: [{ rule_id: "committed_labor" }] },
  { id: "estimator", name: "Estimator", description: "A share of each contract, half when sold and half when completed.", rules: [{ rule_id: "estimator_commission_sold" }, { rule_id: "estimator_commission_completed" }] },
  { id: "inside_sales", name: "Inside sales", description: "A booking fee for each sold project they booked.", rules: [{ rule_id: "inside_sales_booking" }] }
];

export async function seedSamplePayRules(orgId: string, actor: { userId: string }) {
  const rules = new Set((await listPayRules(orgId)).map((rule) => rule.id));
  const plans = new Set((await listPayPlans(orgId)).map((plan) => plan.id));
  // Effective from the start of the year so work already done in a new organization is covered once someone is put on a plan.
  const effective_from = `${new Date().getUTCFullYear()}-01-01`;
  for (const rule of SAMPLE_PAY_RULES) if (!rules.has(rule.id)) await savePayRule(orgId, { ...rule, effective_from }, actor);
  for (const plan of SAMPLE_PAY_PLANS) if (!plans.has(plan.id)) await savePayPlan(orgId, { ...plan, effective_from }, actor);
}
