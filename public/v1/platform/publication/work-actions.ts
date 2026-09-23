import type { WorkAutomationContext, WorkAutomationHandler, WorkAutomationMeta } from "../../work/registry.js";
import type { JsonSchema, PublicationContext } from "./contracts.js";
import { jsonValueSchema } from "./contracts.js";
import { systemPublicationContext } from "./context.js";
import { registerAction, invokeAction } from "./actions.js";
import { contentHash } from "./validation.js";
import { forbidden } from "../errors.js";
import { backendImplementationDigest } from "./implementation.js";
import type { PlatformAuthContext } from "../auth.js";

const text = { type: "string" };
const object = { type: "object", additionalProperties: true };
const list = { type: "array", items: {} };
const number = { type: ["number", "string"] }; // Work definitions allow template expressions.
/** Explicit legacy input contracts. Extra fields are retained for existing scope definitions. */
const fields: Record<string, Record<string, JsonSchema>> = {
  "project.patch.v1": { values: object },
  "notification.create.v1": { id: text, title: text, body: text, target_role_ids: list, target_user_ids: list, kind: text, celebration: object, frontend_action: object },
  "communications.sendSms.v1": { to: text, text, recipients: list },
  "communications.sendEmail.v1": { to: text, subject: text, text, html: text, recipients: list },
  "work.createTodo.v1": { title: text, message: text, assigned_role_ids: list, assigned_user_ids: list, assigned_resource_group_ids: list, priority: number, due_offset_minutes: number, metadata: object },
  "crm.callLists.add.v1": { list: object, title: text }, "crm.callLists.remove.v1": {},
  "scheduling.createRequirement.v1": { event_type_default_id: text, title: text, kind: text, resource_refs: list, resource_requirements: list },
  "scheduling.createRequirements.v1": { requirements: list },
  "scheduling.createPerStructure.v1": { event_type_default_id: text },
  "scopes.activateFromProposal.v1": {}, "scopes.activateTemplate.v1": { template_id: text, instance_key: text },
  "project.claim.v1": { key: text, holder: text }, "materials.initializeFromScope.v1": {},
  "checklists.initializeFromScope.v1": {},
  "punchlist.request.v1": { title: text, description: text, instance_key: text, terminology_key: text, labels: object, config: object },
  "customFields.initializeFromScope.v1": {}, "payroll.reconcileScopeCommissions.v1": {}, "scopes.reconcileProjectResources.v1": {},
  "payments.ensureReceivables.v1": {}, "documents.dispatchOnSigned.v1": {}, "payments.reconcileRecognition.v1": {},
  "documents.issue.v1": { document_type: text, template_id: text, params: object, deliver: text, title: text },
  "completion.request.v1": { mode: text, deliver: text, params: object, tab: object },
  "feedback.requestReview.v1": { project_id: text, branch_id: text, channels: list, message_overrides: object, source_key: text, resend: { type: "boolean" } },
  "payroll.commission.post.v1": { payee_role: text, payees: list, amount: object, allocation: text, entry_state: text },
  "payroll.projectPayees.set.v1": { role_key: text, label: text, payees: list },
  "payroll.commission.rule.v1": { rule: object },
  "payroll.commission.accrue.v1": { rule_id: text, installment_id: text }
};
const contexts = new WeakMap<PublicationContext, WorkAutomationContext>();
export const legacyWorkActionIds: readonly string[] = Object.freeze(Object.keys(fields));
/** Server-only bridge for scope code. The guest receives bindings, never this context object. */
export async function withWorkPublicationContext<T>(context: WorkAutomationContext, operations: string[], callback: (ctx: PublicationContext) => Promise<T>, principal?: PlatformAuthContext): Promise<T> {
  const organizationId = String(context.event.organization_id || "");
  const projectId = String(context.project.id || context.plan.project_id || context.event.project_id || "");
  const branchId = String(context.event.branch_id || context.plan.branch_id || "default");
  const ctx = systemPublicationContext({ kind: "work", organizationId, ...(projectId ? { projectId } : {}), branchId, operations, mode: "command", invocationId: context.idempotencyKey });
  if (principal) ctx.auth = principal;
  contexts.set(ctx,context);
  try { return await callback(ctx); } finally { contexts.delete(ctx); }
}
export function publishWorkAutomation(id: string, handler: WorkAutomationHandler, meta: WorkAutomationMeta): WorkAutomationHandler {
  const properties = fields[id];
  if (!properties && !meta.inputSchema) throw new Error(`Work automation '${id}' must declare inputSchema before publication.`);
  const version = meta.version || "1";
  registerAction({
    id, version, implementation: contentHash({ artifact: backendImplementationDigest(), declared: meta.implementation || "", id, version, source: handler.toString() }),
    domain: id.split(".")[0]!, description: meta.description || id,
    inputSchema: meta.inputSchema || { type: "object", properties, additionalProperties: true },
    outputSchema: meta.outputSchema || jsonValueSchema,
    effect: meta.effect || (/^(communications\.|documents\.issue|completion\.|feedback\.)/.test(id) ? "external" : "write"),
    executionKinds: ["work"], idempotency: "host",
    policy: { scopes: ["organization", "project"], permissions: ["manage_company_settings"], systemKinds: ["work"], authorize: (ctx) => {
      if (!contexts.has(ctx)) throw forbidden("action_work_context_required", "This automation requires a trusted work execution context.");
    } },
    execute: async (ctx, target, input, execution) => {
      if (input.project_id && input.project_id !== target.projectId) throw forbidden("publication_project_denied", "A work action cannot override its target project.");
      if (input.branch_id && target.branchId && input.branch_id !== target.branchId) throw forbidden("publication_branch_denied", "A work action cannot override its target branch.");
      const original = contexts.get(ctx)!;
      const result = await handler(execution.idempotencyKey ? { ...original, idempotencyKey: execution.receiptId } : original, input);
      return JSON.parse(JSON.stringify(result ?? null));
    }
  });
  return async (context, input) => {
    return withWorkPublicationContext(context,[id],async ctx => {
      const { organizationId, projectId, branchId } = ctx;
      return (await invokeAction(ctx, { action: id, version, target: { scope: projectId ? "project" : "organization", organizationId, branchId, ...(projectId ? { projectId } : {}) } }, input)).value;
    });
  };
}
