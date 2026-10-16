/**
 * Branch scope for the payees payroll shows (docs/architecture/branches.md). Payroll records name payees, not
 * branches, so a payee's branches are read from the organization structure on the caller's authorization: a user's
 * and a group's branches, and an outside company's (none means it works in every branch). Scope only removes
 * payees; the payroll permission is still what allows the read.
 */
import type { PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { branchScope, canManageBranches, requestedBranchIds } from "../workforce/branch-scope.js";
import { asArray, asObject, cleanText, type JsonObject } from "./storage.js";

type Payee = { type?: unknown; id?: unknown };
type Subject = { id?: unknown; branch_ids?: unknown };

export type PayeeScope = {
  /** Branch scope applies: the organization has several branches and the viewer sees only some, or asked for some. */
  active: boolean;
  /** The branches shown, never wider than the viewer may see. Null when every payee is shown. */
  branch_ids: string[] | null;
  multiple: boolean;
  visible(payee: Payee): boolean;
  manageable(payee: Payee): boolean;
  /** What the screen needs to offer a branch filter. */
  summary: JsonObject;
};

const everyone: PayeeScope = { active: false, branch_ids: null, multiple: false, visible: () => true, manageable: () => true, summary: { multiple: false } };

export function payeeScope(ctx: PlatformAuthContext | null | undefined, query: unknown = {}): PayeeScope {
  if (!ctx?.organizationStructure) return everyone;
  const scope = branchScope(ctx);
  if (!scope.multiple) return everyone;
  const structure = asObject(ctx.organizationStructure);
  const branches = new Map<string, string[]>();
  const add = (type: string, rows: unknown) => asArray(rows).map((row) => asObject(row) as Subject).forEach((row) => {
    branches.set(`${type}:${cleanText(row.id)}`, asArray(row.branch_ids).map(cleanText).filter(Boolean));
  });
  add("organization_user", structure.users);
  add("resource_group", structure.groups);
  add("organization_connection", structure.connections);
  const shown = requestedBranchIds(scope, asObject(query).branch_ids === undefined ? {} : { branch_ids: asObject(query).branch_ids });
  const branchesOf = (payee: Payee) => branches.get(`${cleanText(payee.type)}:${cleanText(payee.id)}`);
  const company = (payee: Payee) => cleanText(payee.type) === "organization_connection";
  return {
    active: shown !== null,
    branch_ids: shown,
    multiple: true,
    visible(payee) {
      if (shown === null) return true;
      const own = branchesOf(payee);
      // A payee who is no longer in the organization has no branch any more; only an unrestricted view shows them.
      if (!own) return !scope.restricted_view && !asObject(query).branch_ids;
      if (!own.length) return company(payee);
      return own.some((id) => shown.includes(id));
    },
    manageable(payee) {
      const own = branchesOf(payee);
      if (!own) return !scope.restricted_manage;
      return canManageBranches(scope, own, company(payee));
    },
    summary: {
      multiple: true, my_branch_id: scope.my_branch_id, visible_branch_ids: scope.visible_branch_ids,
      manageable_branch_ids: scope.manageable_branch_ids, restricted: scope.restricted_view, shown_branch_ids: shown
    }
  };
}

export function assertPayeeManageable(scope: PayeeScope, payee: Payee) {
  if (!scope.manageable(payee)) throw forbidden("branch_scope_denied", "This payee belongs to a branch you cannot manage.");
}

/** A pay run as this viewer may see it: payees of other branches are left out and the totals are of those shown. */
export function scopedBatch<T extends JsonObject>(batch: T, scope: PayeeScope): T {
  if (!scope.active || !batch) return batch;
  const items = asArray(batch.items).map(asObject);
  const shown = items.filter((item) => scope.visible(asObject(item.payee)));
  if (shown.length === items.length) return batch;
  const total = (rows: JsonObject[]) => rows.reduce((sum, item) => sum + Number(item.net_cents || 0), 0);
  const employees = shown.filter((item) => cleanText(asObject(item.payee).worker_type || "employee") === "employee");
  return {
    ...batch, items: shown,
    total_cents: total(shown), employee_total_cents: total(employees), subcontractor_total_cents: total(shown) - total(employees),
    branch_view: { hidden_payee_count: items.length - shown.length }
  };
}

/** Upcoming pay runs as this viewer may see them. */
export function scopedUpcoming<T extends JsonObject>(result: T, scope: PayeeScope): T {
  if (!scope.active) return { ...result, branch_scope: scope.summary };
  const upcoming = asArray(result.upcoming).map(asObject).map((occurrence) => {
    const keep = (rows: unknown) => asArray(rows).map(asObject).filter((item) => scope.visible(asObject(item.payee)));
    const employees = keep(occurrence.employees), subcontractors = keep(occurrence.subcontractors);
    const all = [...employees, ...subcontractors];
    const sum = (key: string) => all.reduce((total, item) => total + Number(asObject(item[key]).net_cents || 0), 0);
    return {
      ...occurrence, employees, subcontractors,
      batch: occurrence.batch ? scopedBatch(asObject(occurrence.batch), scope) : null,
      accrued_total_cents: sum("accrued"), projected_additional_cents: sum("projected"),
      forecast_total_cents: all.reduce((total, item) => total + Number(item.forecast_net_cents || 0), 0),
      branch_view: { hidden_payee_count: asArray(occurrence.employees).length + asArray(occurrence.subcontractors).length - all.length }
    };
  });
  const history = result.history === undefined ? {} : { history: asArray(result.history).map((batch) => scopedBatch(asObject(batch), scope)) };
  return { ...result, upcoming, ...history, branch_scope: scope.summary };
}
