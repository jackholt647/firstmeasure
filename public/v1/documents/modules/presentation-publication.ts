import { badRequest } from "../../platform/errors.js";
import { registerAction, type ActionDefinition } from "../../platform/publication/actions.js";
import { backendImplementationDigest } from "../../platform/publication/implementation.js";
import type { JsonSchema, TargetRef } from "../../platform/publication/contracts.js";
import { changePresentation, createPresentation, producePresentationContract, sharePresentation } from "./presentation-service.js";

/** Business actions for workflows, scopes and agents. State is read as typed data
 * through `document-modules.value`; these reuse the presentation service and its
 * authorization. There is no action for acting as the customer. */
let registered = false;
export function registerPresentationActions() {
  if (registered) return;
  registered = true;
  const string = { type: "string", minLength: 1 }, revision = { type: "integer", minimum: 1 }, object = { type: "object" };
  const instance = (target: TargetRef) => { if (!target.id) throw badRequest("module_instance_required", "Select a presentation."); return target.id; };
  const summary = (value: { id: unknown; revision: unknown; ready: boolean; frozen: boolean; pricing: unknown }) => ({ id: value.id, revision: value.revision, ready: value.ready, frozen: value.frozen, pricing: value.pricing });
  const register = (name: string, description: string, permission: string, properties: Record<string, JsonSchema>, required: string[], execute: ActionDefinition["execute"]) => registerAction({
    id: `document-modules.presentation.${name}`, version: "1", implementation: backendImplementationDigest(), domain: "documents", description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }, outputSchema: { type: "object" },
    effect: "write", executionKinds: ["api", "module", "work", "agent"], idempotency: "required",
    policy: { scopes: ["project"], permissions: [permission], capabilities: ["platform.documents"] }, execute: (ctx, target, input, execution) => execute({ ...ctx, projectId: target.projectId }, target, input, execution)
  });
  const manage = "manage_documents|manage_projects|manage_company_settings";
  register("create", "Create a presentation from a draft document or a workflow export.", manage, { documentId: string, source: { type: "object", properties: { instanceId: string, exportName: string }, required: ["instanceId", "exportName"], additionalProperties: false }, moduleId: string, version: string, inputs: object }, [], async (ctx, target, input) =>
    summary(await createPresentation(ctx, { ...input as Parameters<typeof createPresentation>[1], projectId: target.projectId! })));
  register("input.write", "Change declared interactive inputs of a presentation and return the repriced state.", manage, { expectedRevision: revision, changes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { input: string, value: {} }, required: ["input"], additionalProperties: false } } }, ["expectedRevision", "changes"], async (ctx, target, input) =>
    summary(await changePresentation(ctx, instance(target), input as Parameters<typeof changePresentation>[2])));
  register("contract.produce", "Write a presentation's current choices onto its draft contract document.", manage, { expectedRevision: revision, documentId: string }, ["expectedRevision"], async (ctx, target, input) => {
    const result = await producePresentationContract(ctx, instance(target), input as Parameters<typeof producePresentationContract>[2]);
    return { ...summary(result.presentation), document: result.document };
  });
  // The link is emailed to the recipients; a caller never receives the bearer token.
  register("share", "Email recipients a link to view, or choose within, a presentation.", "issue_documents", { expectedRevision: revision, access: { enum: ["view", "choose"] }, recipients: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: { name: { type: "string" }, email: string }, required: ["email"], additionalProperties: false } }, message: { type: "string", maxLength: 4000 } }, ["expectedRevision", "recipients"], async (ctx, target, input) => {
    const result = await sharePresentation(ctx, instance(target), { ...input as Parameters<typeof sharePresentation>[2], deliver: true });
    return { id: result.presentation.id, revision: result.presentation.revision, shareId: result.share.id, access: result.share.access, emailed: result.emailed.length };
  });
}
