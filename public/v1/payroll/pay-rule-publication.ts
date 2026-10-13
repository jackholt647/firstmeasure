import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ASSIGNEE_TYPES, type Assignee } from "../labor/assignees.js";
import { hasPermission } from "../platform/auth.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import type { AccessPolicy, PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { DataExport } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { declinePayCorrection, listPayUnits, previewPaySetup, refreshOrganizationEarnings } from "./pay-refresh.js";
import {
  archivePayPlan, archivePayRule, listPayPlans, listPayRules, listPaySetups, normalizePaySetup, payPlanSaveSchema, payRuleSaveSchema, paySetupSaveSchema,
  readPaySetup, savePayPlan, savePayRule, savePaySetup
} from "./pay-rules.js";
import { paySourceExports } from "./pay-sources.js";

/** Pay rules decide what people are paid, so reading and changing them is payroll management. */
const manage: AccessPolicy = { scopes: ["organization"], permissions: ["manage_payroll|manage_company_settings"], capabilities: ["apps.payroll"], authorize: (ctx) => {
  if (ctx.auth && !hasPermission(ctx.auth, "manage_payroll|manage_company_settings")) throw forbidden("payroll_access", "Payroll management access is required.");
} };
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
const loose = { type: "object", additionalProperties: true };
const list = { type: "array", items: loose };
const payeeArg = z.object({ type: z.enum(ASSIGNEE_TYPES), id: z.string().min(1).max(200) }).strict();
/** A payee is named in a target as `type:id`. */
function payeeOf(target: TargetRef): Assignee {
  const [type, ...rest] = String(target.id || "").split(":");
  const parsed = payeeArg.safeParse({ type, id: rest.join(":") });
  if (!parsed.success) throw badRequest("pay_payee_required", "Name the payee as type:id, for example organization_user:user_1.");
  return parsed.data;
}
const actor = (ctx: PublicationContext) => {
  if (!ctx.auth) throw forbidden("payroll_principal", "A signed-in user is required to change how people are paid.");
  return { userId: ctx.auth.userId };
};

export const PAY_RULE_EXPORTS = ["pay_rules", "pay_plans", "pay_setups", "pay_setup", "pay_units"] as const;
export function payRuleExports(): Record<string, DataExport> {
  const revision = (value: unknown) => contentHash(JSON.parse(JSON.stringify(value)));
  return {
    ...paySourceExports(),
    pay_rules: { description: "Every pay rule with its versions: the inputs each reads, its parameters, its formula and the date each version takes effect.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = await listPayRules(ctx.organizationId); return { value, revision: revision(value) }; } },
    pay_plans: { description: "Every pay plan: a named group of pay rules with the parameters the plan sets, by effective date.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = await listPayPlans(ctx.organizationId); return { value, revision: revision(value) }; } },
    pay_setups: { description: "Every payee's pay setup: the plans they are on and the rules added, removed or changed for them, each with its dates and who entered it.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = (await listPaySetups(ctx.organizationId)).map((setup) => ({ id: `${setup.payee.type}:${setup.payee.id}`, ...setup })); return { value, revision: revision(value) }; } },
    pay_setup: { description: "One payee's pay setup. Name the payee in target.id as type:id.", schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => { const value = await readPaySetup(ctx.organizationId, payeeOf(ref.target)); return { value, revision: String(value.revision) }; } },
    pay_units: { description: "What each pay rule last worked out for one payee, per record or period: the earnings, the date earned, and the reason for anything that could not be worked out. Name the payee in target.id as type:id.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => { const value = await listPayUnits(ctx.organizationId, payeeOf(ref.target)); return { value, revision: revision(value) }; } }
  };
}

export function registerPayRuleActions() {
  const add = <T extends z.ZodTypeAny>(id: string, description: string, input: T, effect: "read" | "write", execute: (ctx: PublicationContext, target: TargetRef, value: z.infer<T>) => Promise<unknown>) => registerAction({
    id, version: "1", implementation: contentHash({ artifact: backendImplementationDigest(), id, source: execute.toString() }), domain: "payroll", description,
    inputSchema: json(input), validateInput: (value) => input.parse(value), outputSchema: loose, effect, executionKinds: ["api", "agent", "module", "work"],
    idempotency: effect === "read" ? "none" : "required", policy: manage,
    execute: async (ctx, target, value) => JSON.parse(JSON.stringify(await execute(ctx, target, input.parse(value))))
  });
  const archive = z.object({ id: z.string().min(1).max(120), expected_revision: z.number().int().nonnegative().optional() }).strict();
  add("payroll.payRule.save", "Create a pay rule or add a version of one. A version applies to earnings from its effective_from date; a past date backdates it. Read pay_rules first for the shape and existing versions.", payRuleSaveSchema, "write",
    (ctx, _target, value) => savePayRule(ctx.organizationId, value, actor(ctx)));
  add("payroll.payRule.archive", "Stop offering a pay rule for new plans and setups. Setups that use it keep working until it is removed from them.", archive, "write",
    (ctx, _target, value) => archivePayRule(ctx.organizationId, value));
  add("payroll.payPlan.save", "Create a pay plan or add a version of one: the rules it groups and the parameters it sets, from an effective date.", payPlanSaveSchema, "write",
    (ctx, _target, value) => savePayPlan(ctx.organizationId, value, actor(ctx)));
  add("payroll.payPlan.archive", "Stop offering a pay plan for new setups.", archive, "write", (ctx, _target, value) => archivePayPlan(ctx.organizationId, value));
  add("payroll.paySetup.preview", "Work out what replacing a payee's pay setup would change, earning by earning, without changing anything. Use it before backdating a change.", paySetupSaveSchema, "read",
    async (ctx, _target, value) => previewPaySetup(ctx.organizationId, value.payee, await normalizePaySetup(ctx.organizationId, value, actor(ctx), await readPaySetup(ctx.organizationId, value.payee))));
  add("payroll.paySetup.save", "Replace a payee's pay setup: the plans they are on and the rules added, removed or overridden for them, each with effective dates. Earnings change at the next refresh; nothing already paid is edited.", paySetupSaveSchema, "write",
    (ctx, _target, value) => savePaySetup(ctx.organizationId, value, actor(ctx)));
  add("payroll.earnings.refresh", "Work out what payees have earned from their pay rules and post any difference to the ledger. Leave payees out to refresh everyone with a setup.", z.object({ payees: z.array(payeeArg).max(500).optional() }).strict(), "write",
    (ctx, _target, value) => refreshOrganizationEarnings(ctx.organizationId, { payees: value.payees }));
  add("payroll.correction.decline", "Decline a correction that was held for review. Name the held ledger entry in target.id. To accept it instead, accrue it.", z.object({ note: z.string().max(500).optional() }).strict(), "write",
    (ctx, target, value) => { if (!target.id) throw badRequest("payroll_target_required", "Choose the held correction."); return declinePayCorrection(ctx.organizationId, target.id, actor(ctx), value.note); });
}
