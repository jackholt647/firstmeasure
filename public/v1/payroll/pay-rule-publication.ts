import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ASSIGNEE_TYPES, type Assignee } from "../labor/assignees.js";
import { hasPermission } from "../platform/auth.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import { authorizePublicationDiscovery } from "../platform/publication/context.js";
import type { AccessPolicy, PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { listDataProviders, type DataExport } from "../platform/publication/providers.js";
import { selectionSupport } from "../platform/publication/select.js";
import { contentHash } from "../platform/publication/validation.js";
import { listDocuments } from "../platform/storage.js";
import { CONDITION_OPERATORS } from "../work/conditions.js";
import { PAYROLL_PERMISSION_KEYS } from "../workforce/access.js";
import { getWorkforceDatabase } from "../workforce/storage.js";
import {
  declinePayCorrection, listPayReview, listPayUnits, listUnresolvedPay, payeesCoveredBy, previewPayDefaultSave, previewPayPlanSave, previewPayRuleSave, previewPaySetup, projectOrganizationEarnings, projectPayeeEarnings,
  projectUserEarnings, refreshOrganizationEarnings
} from "./pay-refresh.js";
import {
  archivePayPlan, archivePayRule, archivePaySplitRule, distributionOn, effectiveRuleSlots, listPayDefaults, listPayPlans, listPayRules, listPaySetups, listPaySplitRules, normalizePaySetup, PAY_DEFAULT_SUBJECTS,
  PAY_PARAMETER_TYPES, PAY_PERIODS, PAY_SCHEDULE_EARNING_KINDS, PAY_VOCABULARY_LABELS, payDefaultSaveSchema, payLayersFor, payPlanSaveSchema, payRuleSaveSchema, paySetupSaveSchema, paySplitRuleSaveSchema, readPayDefault, readPaySetup, resolvePaySchedule,
  savePayDefault, savePayPlan, savePayRule, savePaySetup, savePaySplitRule, scheduleChoiceOn, type PayDefaultSubject
} from "./pay-rules.js";
import { paySourceExports } from "./pay-sources.js";
import { assertPayeeManageable, payeeScope } from "./payee-scope.js";
import { listPayrollSchedules } from "./storage.js";

/** Pay rules decide what people are paid, so reading and changing them is payroll management. */
const manage: AccessPolicy = { scopes: ["organization"], permissions: ["manage_payroll|manage_company_settings"], capabilities: ["apps.payroll"], authorize: (ctx) => {
  if (ctx.auth && !hasPermission(ctx.auth, "manage_payroll|manage_company_settings")) throw forbidden("payroll_access", "Payroll management access is required.");
} };
/**
 * A payee's own projected earnings: signed in, the self-service earnings feature on, and the permission to see
 * projections, which roles grant by default and a company can take away. Only ever the signed-in user's own.
 */
export const OWN_PROJECTED_EARNINGS_PERMISSION = PAYROLL_PERMISSION_KEYS.view_own_projected_earnings;
const ownProjection: AccessPolicy = { scopes: ["organization"], applications: false, permissions: [OWN_PROJECTED_EARNINGS_PERMISSION], capabilities: ["payroll.self_service_earnings"], authorize: (ctx) => {
  if (!ctx.auth) throw forbidden("payroll_subject_required", "Personal earnings require a current signed-in user.");
  if (!hasPermission(ctx.auth, OWN_PROJECTED_EARNINGS_PERMISSION)) throw forbidden("payroll_projection_denied", "Projected earnings are not shown to this user.");
} };
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
const loose = { type: "object", additionalProperties: true };
const list = { type: "array", items: loose };
const payeeArg = z.object({ type: z.enum(ASSIGNEE_TYPES), id: z.string().min(1).max(200) }).strict();
const text = (value: unknown) => String(value ?? "").trim();
/** A payee is named in a target as `type:id`. */
function payeeOf(target: TargetRef): Assignee {
  const [type, ...rest] = String(target.id || "").split(":");
  const parsed = payeeArg.safeParse({ type, id: rest.join(":") });
  if (!parsed.success) throw badRequest("pay_payee_required", "Name the payee as type:id, for example organization_user:user_1.");
  return parsed.data;
}
/** A default's subject is named in a target as `type:id`, for example `role:crew_foreman`. */
function subjectOf(target: TargetRef): PayDefaultSubject {
  const [type, ...rest] = String(target.id || "").split(":");
  const parsed = z.object({ type: z.enum(PAY_DEFAULT_SUBJECTS), id: z.string().min(1).max(200) }).safeParse({ type, id: rest.join(":") });
  if (!parsed.success) throw badRequest("pay_default_subject", "Name the default as type:id, for example role:crew_foreman or group_type:crew.");
  return parsed.data;
}
const actor = (ctx: PublicationContext) => {
  if (!ctx.auth) throw forbidden("payroll_principal", "A signed-in user is required to change how people are paid.");
  return { userId: ctx.auth.userId };
};

type Json = Record<string, unknown>;
/**
 * Names for what the stored rows only hold ids of, read once per answer: who entered a version or an entry, and what
 * a default's subject is called. Reads only: roles are read as stored, never put in place.
 */
async function namesFor(orgId: string) {
  const users = new Map((await listDocuments(orgId, "users")).map((row) => [row.id, text((row.data as Json).name) || text((row.data as Json).email)]));
  const roles = new Map((await getWorkforceDatabase().prepare("SELECT id, name FROM workforce_access_roles WHERE organization_id=?").all(orgId).catch(() => [])).map((row) => [text(row.id), text(row.name)]));
  const types = new Map((await (await import("../assignees/base.js")).listAssigneeTypes(orgId).catch(() => ({ types: [] }))).types.map((type) => [type.id, type.name]));
  const subject = (source: PayDefaultSubject) => source.type === "organization" ? "Everyone"
    : source.type === "assignee_kind" ? ({ organization_user: "Users", resource_group: "Groups of users", organization_connection: "Outside companies" } as Json)[source.id] as string || source.id
      : source.type === "worker_classification" ? (source.id === "independent_contractor" ? "Independent contractors" : "Employees")
        : (source.type === "role" ? roles.get(source.id) : types.get(source.id)) || source.id;
  /** Adds `entered_by_name` beside every `entered_by`. A rule's own definition is data the organization wrote and is left alone. */
  const stamp = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map(stamp) as unknown as T;
    if (!value || typeof value !== "object") return value;
    const out: Json = {};
    for (const [key, entry] of Object.entries(value as Json)) out[key] = key === "definition" ? entry : stamp(entry);
    if (typeof out.entered_by === "string") out.entered_by_name = users.get(out.entered_by) || "";
    if (out.closed && typeof (out.closed as Json).by === "string") out.closed = { ...(out.closed as Json), by_name: users.get((out.closed as Json).by as string) || "" };
    return out as T;
  };
  return { stamp, subject };
}

/**
 * The published collections a pay rule or split rule may select from, as the reader could choose them: every
 * collection published for a whole organization that can answer a selection and that this reader may read.
 */
async function selectableSources(ctx: PublicationContext) {
  const latest = new Map(listDataProviders().map((provider) => [provider.id, provider]));
  const sources: Json[] = [];
  for (const provider of latest.values()) {
    // Collections of a connected outside system are published per connection and are not offered here; a rule can still name one.
    if (provider.id.startsWith("external.")) continue;
    for (const [name, exported] of Object.entries(provider.exports)) {
      if (!exported.access.scopes.includes("organization")) continue;
      const support = selectionSupport({ provider: provider.id, export: name, version: provider.version });
      if (!support.selectable) continue;
      try { await authorizePublicationDiscovery(ctx, { scope: "organization", organizationId: ctx.organizationId }, exported.access as unknown as AccessPolicy, `${provider.id}.${name}`); }
      catch { continue; }
      const args = exported.argsSchema as { properties?: Json; required?: string[] };
      const items = (exported.schema as { items?: { properties?: Json } }).items;
      sources.push({
        id: `${provider.id}.${name}`, provider: provider.id, export: name, description: exported.description, units: exported.units,
        /** True when the collection cannot be read without options: a rule that selects from it has to give them. */
        needs_args: Array.isArray(args.required) && args.required.length > 0,
        required_args: Array.isArray(args.required) ? args.required : [], args: Object.keys(args.properties || {}),
        /** The fields a row is known to have, when the collection says. A collection may publish more. */
        fields: Object.keys(items?.properties || {}), indexed: support.indexed
      });
    }
  }
  return sources.sort((a, b) => Number(b.provider === "payroll") - Number(a.provider === "payroll") || String(a.id).localeCompare(String(b.id)));
}

const PROJECTION = "Projected earnings are what a payee's pay rules say they are expected to earn from work that is not done yet: each rule that pays per record, over the rows its primary input projects (labor commitments not yet released and assigned labor lists not yet committed), with the version and parameters in effect on the expected day. Each earning carries `projected: true`, `amount_cents`, `expected_on` (the day it is expected to be earned, blank when nothing is scheduled), `expected_from`, the job (`project_id`, `project_title`) and the rule; `projects` totals them by job; `unresolved` lists what a rule could not work out, with the reason, which is never counted as zero. Nothing projected is posted to the ledger or paid in a pay run.";
export function payRuleExports(): Record<string, DataExport> {
  const revision = (value: unknown) => contentHash(JSON.parse(JSON.stringify(value)));
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    ...paySourceExports(),
    pay_rules: { description: "Every pay rule with its versions: the inputs each reads, its parameters (each may declare a `type`: number, boolean, text, cents or basis_points), its formula and the date each version takes effect. Each version says who entered it (`entered_by`, `entered_by_name`) and when.", schema: list, schemaVersion: "2", access: manage,
      read: async (ctx) => { const value = (await namesFor(ctx.organizationId)).stamp(await listPayRules(ctx.organizationId)); return { value, revision: revision(value) }; } },
    pay_split_rules: { description: "Every split rule with its versions: how one earning of a group of users is divided among its members. Each version declares its inputs (selections over published collections, with how rows are matched to an earning by field and by exact time), its parameters and the formula that returns each member's weight, and says who entered it. A group's pay names one under `distribution` with `method: \"rule\"`.", schema: list, schemaVersion: "2", access: manage,
      read: async (ctx) => { const value = (await namesFor(ctx.organizationId)).stamp(await listPaySplitRules(ctx.organizationId)); return { value, revision: revision(value) }; } },
    pay_plans: { description: "Every pay plan: a named group of pay rules with the parameters the plan sets, by effective date, with who entered each version.", schema: list, schemaVersion: "2", access: manage,
      read: async (ctx) => { const value = (await namesFor(ctx.organizationId)).stamp(await listPayPlans(ctx.organizationId)); return { value, revision: revision(value) }; } },
    pay_setups: { description: "Every payee's own pay setup: the plans they are on, the rules added, removed or changed for them, and under `schedules` which pay schedule pays them, each with its dates and who entered it.", schema: list, schemaVersion: "2", access: manage,
      read: async (ctx) => { const value = (await namesFor(ctx.organizationId)).stamp((await listPaySetups(ctx.organizationId)).map((setup) => ({ id: `${setup.payee.type}:${setup.payee.id}`, ...setup }))); return { value, revision: revision(value) }; } },
    pay_defaults: { description: "The pay each kind of payee starts from: a pay setup shared by everyone a subject covers, underneath each payee's own setup. Subjects, lowest first: organization, assignee_kind (all users, all groups, all outside companies), worker_classification (employees, independent contractors), then role (every user with that access role), group_type (groups of that kind) and company_type (outside companies with that type). Each carries rule `entries`, for groups `distribution`, and `schedules`: which pay schedule pays the people it covers.", schema: list, schemaVersion: "2", access: manage,
      read: async (ctx) => {
        const names = await namesFor(ctx.organizationId);
        const value = names.stamp((await listPayDefaults(ctx.organizationId)).map((entry) => ({ id: `${entry.subject.type}:${entry.subject.id}`, subject_name: names.subject(entry.subject), ...entry })));
        return { value, revision: revision(value) };
      } },
    pay_default: { description: "One pay default. Name its subject in target.id as type:id, for example role:crew_foreman, group_type:crew or organization:<organization id>. Carries its entries, distribution and schedule choices (empty when nothing is saved, with revision 0), what the subject is called, and under `covers` the payees it covers today.", schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => {
        const subject = subjectOf(ref.target), names = await namesFor(ctx.organizationId);
        const stored = await readPayDefault(ctx.organizationId, subject), covers = await payeesCoveredBy(ctx.organizationId, subject);
        const value = names.stamp({ id: `${subject.type}:${subject.id}`, subject_name: names.subject(subject), ...stored, covers: covers.slice(0, 500), covers_count: covers.length });
        return { value, revision: revision({ stored, covers }) };
      } },
    pay_setup: { description: "One payee's pay. Name the payee in target.id as type:id. Carries their own setup (entries, distribution, schedules), the `layers` it sits on (each default that covers them, lowest first, with its name and, when a role or type was given or taken away, the days it covered them; then their own entries), the rules in effect today with their parameters and where each came from under `effective`, the pay schedule in effect today for each kind of earning and where it came from under `schedule_today`, and for a group how its earnings are distributed today.", schema: loose, schemaVersion: "2", access: manage,
      read: async (ctx, ref) => {
        const orgId = ctx.organizationId, payee = payeeOf(ref.target), setup = await readPaySetup(orgId, payee), layers = await payLayersFor(orgId, payee);
        const plans = new Map((await listPayPlans(orgId)).map((plan) => [plan.id, plan])), day = today(), names = await namesFor(orgId);
        // Where each rule in effect came from: the lowest layer that brought it in, and whether a higher layer then changed it.
        const final = effectiveRuleSlots(layers, plans, day);
        const effective = [...final.values()].map((slot) => {
          const first = layers.findIndex((_layer, index) => effectiveRuleSlots(layers.slice(0, index + 1), plans, day).has(slot.rule_id));
          const brought = effectiveRuleSlots(layers.slice(0, first + 1), plans, day).get(slot.rule_id);
          return { ...slot, origin: layers[first]?.source ? { ...layers[first]!.source, name: names.subject(layers[first]!.source!) } : null, changed_above: JSON.stringify(brought) !== JSON.stringify(slot) };
        });
        // When they are paid: the catch-all choice, and every kind of earning that is paid on something else.
        const schedules = new Map((await listPayrollSchedules(orgId, true)).map((schedule) => [schedule.id, schedule]));
        const catchAll = scheduleChoiceOn(layers, day, "*");
        const schedule_today = PAY_SCHEDULE_EARNING_KINDS.map((kind) => ({ kind, found: scheduleChoiceOn(layers, day, kind) }))
          .filter(({ kind, found }) => found && (kind === "*" || found.choice.id !== catchAll?.choice.id))
          .map(({ kind, found }) => ({
            earning_kind: kind, schedule_id: found!.choice.schedule_id, schedule_name: schedules.get(found!.choice.schedule_id)?.name || "",
            timing_basis: found!.choice.timing_basis || schedules.get(found!.choice.schedule_id)?.timing_basis || "", clawback_cap_percent: found!.choice.clawback_cap_percent ?? schedules.get(found!.choice.schedule_id)?.clawback_cap_percent ?? null,
            effective_from: found!.choice.effective_from, origin: found!.source ? { ...found!.source, name: names.subject(found!.source) } : null
          }));
        const value = names.stamp({
          ...setup, layers: layers.map((layer) => ({ ...layer, source: layer.source ? { ...layer.source, name: names.subject(layer.source) } : null })), effective, schedule_today,
          distribution_today: payee.type === "resource_group" ? distributionOn(layers, day) || { mode: "as_one" } : null
        });
        return { value, revision: revision({ setup: setup.revision, layers, schedule_today }) };
      } },
    pay_units: { description: "What each pay rule last worked out for one payee, per record or period: the earnings, the date earned, and the reason for anything that could not be worked out. For a group whose pay is split, `split` says how each line was divided: the method, the split rule and parameters when there is one, the members it was divided among, and per line each member's weight, cents and the rule's reason. Name the payee in target.id as type:id.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => { const value = await listPayUnits(ctx.organizationId, payeeOf(ref.target)); return { value, revision: revision(value) }; } },
    pay_unresolved: { description: "Every earning that could not be worked out at the last refresh, for every payee: the payee and their name, the rule, the record or period (or `whole_rule` when the rule could not read its inputs at all) and the reason. An unresolved earning is not zero.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const scope = payeeScope(ctx.auth); const value = (await listUnresolvedPay(ctx.organizationId)).filter((item) => scope.visible(item.payee)); return { value, revision: revision(value) }; } },
    pay_review: { description: "Corrections waiting on a person: `held` (projected ledger entries held for review; accrue to accept, payroll.correction.decline to refuse) and `off_cycle` (back pay asked to go on an off-cycle run and not yet in one).", schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx) => {
        // Payees of branches the viewer cannot see are left out (docs/architecture/branches.md).
        const scope = payeeScope(ctx.auth), review = await listPayReview(ctx.organizationId);
        const value = { held: review.held.filter((entry) => scope.visible(entry.payee)), off_cycle: review.off_cycle.filter((entry) => scope.visible(entry.payee)) };
        return { value, revision: revision(value) };
      } },
    pay_rule_sources: { description: "The published collections a pay rule or a split rule can select from, for a picker: provider, export, what it holds, the units of its fields, the fields a row is known to have, the options it takes and whether it needs any (`needs_args`). Only collections the reader may read are listed.", schema: list, schemaVersion: "1", access: manage,
      read: async (ctx) => { const value = await selectableSources(ctx); return { value, revision: revision(value) }; } },
    projected_earnings: { description: `${PROJECTION} Name a payee in target.id as type:id for their projection, or leave it out for everyone whose pay comes from rules, with totals only (at most 200 payees; \`truncated\` says when there are more).`, schema: loose, schemaVersion: "1", access: manage,
      read: async (ctx, ref) => {
        const scope = payeeScope(ctx.auth);
        if (ref.target.id && !scope.visible(payeeOf(ref.target))) throw forbidden("branch_scope_denied", "This payee belongs to a branch you cannot see.");
        const all = ref.target.id ? null : await projectOrganizationEarnings(ctx.organizationId);
        const shown = all ? all.payees.filter((row) => scope.visible(row.payee)) : [];
        const value = all ? { ...all, payees: shown, total_cents: shown.reduce((sum, row) => sum + row.total_cents, 0), ...(shown.length < all.payees.length ? { hidden_payee_count: all.payees.length - shown.length } : {}) } : await projectPayeeEarnings(ctx.organizationId, payeeOf(ref.target));
        return { value, revision: revision(value) };
      } },
    my_projected_earnings: { description: `The signed-in user's own projected earnings: their own rules, and their share of a group's when the group's pay is split among its members. ${PROJECTION}`, schema: loose, schemaVersion: "1", access: ownProjection,
      read: async (ctx) => { const value = await projectUserEarnings(ctx.organizationId, ctx.auth!.userId); return { value, revision: revision(value), provenance: { domain: "payroll", payeeUserId: ctx.auth!.userId } }; },
      authorizeSnapshot: (ctx, _ref, result) => { if ((result.provenance as Json | undefined)?.payeeUserId !== ctx.auth?.userId) throw forbidden("payroll_snapshot_subject", "These projected earnings belong to another user."); } },
    pay_rule_vocabulary: { description: "The fixed words a pay rule editor offers, so no screen keeps its own copy: `operators` (the shared condition operators: id, label, the kind of value each takes and what it means), `parameter_types`, `earning_kinds`, `schedule_earning_kinds`, `periods`, `default_subjects`, and under `labels` what each earning kind, parameter type and period is called.", schema: loose, schemaVersion: "1", access: manage,
      read: async () => {
        const value = { operators: CONDITION_OPERATORS, parameter_types: PAY_PARAMETER_TYPES, earning_kinds: PAY_SCHEDULE_EARNING_KINDS.filter((kind) => kind !== "*" && kind !== "clawback"), schedule_earning_kinds: PAY_SCHEDULE_EARNING_KINDS, periods: PAY_PERIODS, default_subjects: PAY_DEFAULT_SUBJECTS, labels: PAY_VOCABULARY_LABELS };
        return { value, revision: revision(value) };
      } }
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
  const changes = "Returns the payees it reaches (`payee_count`), and for each one it would change the earnings that would come to a different amount (`change_cents` each and in total), how many of those have already been in a pay run and would be held for review (`held_count`), and anything it would leave unresolved. Differences already waiting for the next refresh for other reasons are not counted. Nothing is saved or posted.";
  add("payroll.payRule.save", "Create a pay rule or add a version of one. A version applies to earnings from its effective_from date; a past date backdates it. Read pay_rules first for the shape and existing versions, pay_rule_sources for the collections an input can select from and pay_rule_vocabulary for condition operators and parameter types.", payRuleSaveSchema, "write",
    (ctx, _target, value) => savePayRule(ctx.organizationId, value, actor(ctx)));
  add("payroll.payRule.preview", `Work out what saving this version of a pay rule would change across everyone the rule pays, without changing anything. Takes exactly what payroll.payRule.save takes. ${changes}`, payRuleSaveSchema, "read",
    (ctx, _target, value) => previewPayRuleSave(ctx.organizationId, value, actor(ctx)));
  add("payroll.payRule.archive", "Stop offering a pay rule for new plans and setups. Setups that use it keep working until it is removed from them.", archive, "write",
    (ctx, _target, value) => archivePayRule(ctx.organizationId, value));
  add("payroll.paySplitRule.save", "Create a split rule or add a version of one: how an earning of a group of users is divided among its members, from an effective_from date. Read pay_split_rules first for the shape and existing versions. The formula returns a weight per member; weight 0 excludes a member, and an earning nobody has a weight for stays unresolved.", paySplitRuleSaveSchema, "write",
    (ctx, _target, value) => savePaySplitRule(ctx.organizationId, value, actor(ctx)));
  add("payroll.paySplitRule.archive", "Stop offering a split rule. Groups whose pay already names it keep being divided by it until their distribution changes.", archive, "write",
    (ctx, _target, value) => archivePaySplitRule(ctx.organizationId, value));
  add("payroll.payPlan.save", "Create a pay plan or add a version of one: the rules it groups and the parameters it sets, from an effective date.", payPlanSaveSchema, "write",
    (ctx, _target, value) => savePayPlan(ctx.organizationId, value, actor(ctx)));
  add("payroll.payPlan.preview", `Work out what saving this version of a pay plan would change across everyone on the plan, without changing anything. Takes exactly what payroll.payPlan.save takes. ${changes}`, payPlanSaveSchema, "read",
    (ctx, _target, value) => previewPayPlanSave(ctx.organizationId, value, actor(ctx)));
  add("payroll.payPlan.archive", "Stop offering a pay plan for new setups.", archive, "write", (ctx, _target, value) => archivePayPlan(ctx.organizationId, value));
  add("payroll.paySetup.preview", "Work out what replacing a payee's pay setup would change, earning by earning, without changing anything. Use it before backdating a change.", paySetupSaveSchema, "read",
    async (ctx, _target, value) => previewPaySetup(ctx.organizationId, value.payee, await normalizePaySetup(ctx.organizationId, value, actor(ctx), await readPaySetup(ctx.organizationId, value.payee))));
  add("payroll.paySetup.save", "Replace a payee's own pay setup: the plans they are on and the rules added, removed or overridden for them, each with effective dates. `schedules` says which pay schedule pays them, from a date, for every kind of earning (`earning_kind: \"*\"`, the default) or one kind, optionally overriding the schedule's timing_basis and clawback_cap_percent; leave `schedules` out to keep what is stored, or send an empty list to go back to what their defaults say. For a group of users, `distribution` says from which date its earnings are paid as one or split among members: `equal`, fixed `shares`, or `method: \"rule\"` with a `split_rule_id` and `params`. Earnings change at the next refresh; nothing already paid is edited.", paySetupSaveSchema, "write",
    (ctx, _target, value) => savePaySetup(ctx.organizationId, value, actor(ctx)));
  add("payroll.payDefault.save", "Replace the pay every payee a subject covers starts from. Subjects, lowest first: organization (id is the organization id), assignee_kind (organization_user, resource_group or organization_connection), worker_classification (employee or independent_contractor), role (an access role id: every user who has that role), group_type (a kind of group: read assignee-directory.types) and company_type (a type of outside company). Same entries as a pay setup, and the same `schedules`: which pay schedule pays the people it covers, per kind of earning or for all (left out, the stored choices are kept). For groups it may also say whether earnings are paid as one or split among members (equally, by fixed shares, or by a split rule); only organization, assignee_kind resource_group and group_type may. A payee's own setup sits on top.", payDefaultSaveSchema, "write",
    (ctx, _target, value) => savePayDefault(ctx.organizationId, value, actor(ctx)));
  add("payroll.payDefault.preview", `Work out what saving this pay default would change across everyone its subject covers, without changing anything. Takes exactly what payroll.payDefault.save takes. ${changes}`, payDefaultSaveSchema, "read",
    (ctx, _target, value) => previewPayDefaultSave(ctx.organizationId, value, actor(ctx)));
  add("payroll.paySchedule.resolve", "Say which pay schedule pays one kind of a payee's earnings on a day, and which layer of their pay chose it: their own setup (`source` null) or a default. Leave earning_kind out for the catch-all and date out for today. Null when nothing has been chosen.", z.object({ payee: payeeArg, earning_kind: z.enum(PAY_SCHEDULE_EARNING_KINDS).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(), "read",
    (ctx, _target, value) => resolvePaySchedule(ctx.organizationId, value.payee, value.earning_kind || "*", value.date));
  add("payroll.earnings.refresh", "Work out what payees have earned from their pay rules and post any difference to the ledger. Leave payees out to refresh everyone with a setup.", z.object({ payees: z.array(payeeArg).max(500).optional() }).strict(), "write",
    (ctx, _target, value) => refreshOrganizationEarnings(ctx.organizationId, { payees: value.payees }));
  add("payroll.projectedEarnings.read", `Work out one payee's projected earnings (name them under payee), or leave payee out for projected totals for everyone whose pay comes from rules. ${PROJECTION}`, z.object({ payee: payeeArg.optional() }).strict(), "read",
    (ctx, _target, value) => value.payee ? projectPayeeEarnings(ctx.organizationId, value.payee) : projectOrganizationEarnings(ctx.organizationId));
  registerAction({
    id: "payroll.projectedEarnings.me", version: "1", implementation: contentHash({ artifact: backendImplementationDigest(), id: "payroll.projectedEarnings.me", source: projectUserEarnings.toString() }), domain: "payroll",
    description: `The signed-in user's own projected earnings. ${PROJECTION}`, inputSchema: json(z.object({}).strict()), validateInput: (value) => z.object({}).strict().parse(value ?? {}), outputSchema: loose,
    effect: "read", executionKinds: ["api", "agent", "module", "work"], idempotency: "none", policy: ownProjection,
    execute: async (ctx) => JSON.parse(JSON.stringify(await projectUserEarnings(ctx.organizationId, ctx.auth!.userId)))
  });
  add("payroll.correction.decline", "Decline a correction that was held for review. Name the held ledger entry in target.id. To accept it instead, accrue it.", z.object({ note: z.string().max(500).optional() }).strict(), "write",
    async (ctx, target, value) => {
      if (!target.id) throw badRequest("payroll_target_required", "Choose the held correction.");
      const { readPayrollLedgerEntry } = await import("./storage.js");
      assertPayeeManageable(payeeScope(ctx.auth), (await readPayrollLedgerEntry(ctx.organizationId, target.id)).payee);
      return declinePayCorrection(ctx.organizationId, target.id, actor(ctx), value.note);
    });
}
