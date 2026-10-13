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
import { declinePayCorrection, listPayReview, listPayUnits, listUnresolvedPay, previewPaySetup, refreshOrganizationEarnings } from "./pay-refresh.js";
import {
  archivePayPlan, archivePayRule, distributionOn, effectiveRuleSlots, listPayDefaults, listPayPlans, listPayRules, listPaySetups, normalizePaySetup, payDefaultSaveSchema, payLayersFor,
  payPlanSaveSchema, payRuleSaveSchema, paySetupSaveSchema, readPaySetup, savePayDefault, savePayPlan, savePayRule, savePaySetup
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

export const PAY_RULE_EXPORTS = ["pay_rules", "pay_plans", "pay_defaults", "pay_setups", "pay_setup", "pay_units", "pay_unresolved", "pay_review"] as const;
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
    pay_defaults: { description: "The pay each kind of payee starts from: a pay setup shared by everyone a subject covers (the organization, all users, all groups or all outside companies, employees or contractors, groups of one kind), underneath each payee's own setup.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = (await listPayDefaults(ctx.organizationId)).map((entry) => ({ id: `${entry.subject.type}:${entry.subject.id}`, ...entry })); return { value, revision: revision(value) }; } },
    pay_setup: { description: "One payee's pay. Name the payee in target.id as type:id. Carries their own setup, the `layers` it sits on (each default that covers them, lowest first, then their own entries), the rules in effect today with their parameters under `effective`, and for a group how its earnings are distributed today.", schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => {
        const payee = payeeOf(ref.target), setup = await readPaySetup(ctx.organizationId, payee), layers = await payLayersFor(ctx.organizationId, payee);
        const plans = new Map((await listPayPlans(ctx.organizationId)).map((plan) => [plan.id, plan])), today = new Date().toISOString().slice(0, 10);
        // Where each rule in effect came from: the lowest layer that brought it in, and whether a higher layer then changed it.
        const final = effectiveRuleSlots(layers, plans, today);
        const effective = [...final.values()].map((slot) => {
          const first = layers.findIndex((_layer, index) => effectiveRuleSlots(layers.slice(0, index + 1), plans, today).has(slot.rule_id));
          const brought = effectiveRuleSlots(layers.slice(0, first + 1), plans, today).get(slot.rule_id);
          return { ...slot, origin: layers[first]?.source || null, changed_above: JSON.stringify(brought) !== JSON.stringify(slot) };
        });
        const value = { ...setup, layers, effective, distribution_today: payee.type === "resource_group" ? distributionOn(layers, today) || { mode: "as_one" } : null };
        return { value, revision: revision({ setup: setup.revision, layers }) };
      } },
    pay_units: { description: "What each pay rule last worked out for one payee, per record or period: the earnings, the date earned, and the reason for anything that could not be worked out. Name the payee in target.id as type:id.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => { const value = await listPayUnits(ctx.organizationId, payeeOf(ref.target)); return { value, revision: revision(value) }; } },
    pay_unresolved: { description: "Every earning that could not be worked out at the last refresh, for every payee: the payee and their name, the rule, the record or period (or `whole_rule` when the rule could not read its inputs at all) and the reason. An unresolved earning is not zero.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = await listUnresolvedPay(ctx.organizationId); return { value, revision: revision(value) }; } },
    pay_review: { description: "Corrections waiting on a person: `held` (projected ledger entries held for review; accrue to accept, payroll.correction.decline to refuse) and `off_cycle` (back pay asked to go on an off-cycle run and not yet in one).", schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = await listPayReview(ctx.organizationId); return { value, revision: revision(value) }; } }
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
  add("payroll.payDefault.save", "Replace the pay every payee a subject covers starts from. Subjects: organization (id is the organization id), assignee_kind (organization_user, resource_group or organization_connection), worker_classification (employee or independent_contractor), group_kind (a group kind id). Same entries as a pay setup; for groups it may also say whether earnings are paid as one or split among members. A payee's own setup sits on top.", payDefaultSaveSchema, "write",
    (ctx, _target, value) => savePayDefault(ctx.organizationId, value, actor(ctx)));
  add("payroll.earnings.refresh", "Work out what payees have earned from their pay rules and post any difference to the ledger. Leave payees out to refresh everyone with a setup.", z.object({ payees: z.array(payeeArg).max(500).optional() }).strict(), "write",
    (ctx, _target, value) => refreshOrganizationEarnings(ctx.organizationId, { payees: value.payees }));
  add("payroll.correction.decline", "Decline a correction that was held for review. Name the held ledger entry in target.id. To accept it instead, accrue it.", z.object({ note: z.string().max(500).optional() }).strict(), "write",
    (ctx, target, value) => { if (!target.id) throw badRequest("payroll_target_required", "Choose the held correction."); return declinePayCorrection(ctx.organizationId, target.id, actor(ctx), value.note); });
}
