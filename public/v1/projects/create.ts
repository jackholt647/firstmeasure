import { badRequest } from "../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { readScopeTemplate } from "../scopes/storage.js";
import { readIntakeRouting, startEntryScope } from "../scopes/router.js";

// A project starts in one of two ways (docs/architecture/opportunities.md):
// `receiveLead` for a lead, or here, for a project made by hand, an import or
// an app. Here it always starts a scope: the one the request names, or the
// branch's `manual_template_id` (intake routing). There is no project without
// a scope other than a new lead.

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** The scope a new project starts with; refused when neither the request's nor the branch default is available. */
export async function creationScopeTemplate(orgId: string, branchId: string, requested = "") {
  const templateId = text(requested) || (await readIntakeRouting(orgId, branchId)).manual_template_id;
  const template: JsonObject = await readScopeTemplate(orgId, branchId, templateId).catch(() => ({} as JsonObject));
  if (!text(template.id) || template.enabled === false || text(template.status) === "archived") {
    throw badRequest("project_scope_required", "Choose an available scope for the new project, or create it as a lead.", { scope_template_id: templateId });
  }
  return template;
}

/** Splits the scope choice off a project write; it is not stored on the project. */
export function withoutScopeChoice(input: JsonObject) {
  const { scope_template_id: requested, ...rest } = input;
  const data = { ...object(rest.data) };
  const fromData = data.scope_template_id;
  delete data.scope_template_id;
  return { requested: text(requested || fromData), input: { ...rest, data } };
}

/** Starts the new project's scope once its document exists. */
export async function startCreatedProjectScope(orgId: string, projectId: string, template: JsonObject) {
  const data = object((await readDocument(orgId, "projects", projectId)).data);
  const branchId = text(data.branch_id) || "default";
  await startEntryScope(orgId, projectId, branchId, template, { project_created_at: text(data.created_at), created_by: "create_project" });
  return await readDocument(orgId, "projects", projectId);
}

/** Creates a project with its scope. For server code; the project routes go through the same steps. */
export async function createProject(orgId: string, value: JsonObject) {
  const { requested, input } = withoutScopeChoice(value);
  const data = object(input.data);
  const branchId = text(data.branch_id) || "default";
  const template = await creationScopeTemplate(orgId, branchId, requested);
  const now = new Date().toISOString();
  const document = await upsertDocument(orgId, "projects", {
    ...input,
    data: { ...data, branch_id: branchId, created_at: text(data.created_at) || now, updated_at: now },
    metadata: { kind: "platform_project", ...object((input as JsonObject).metadata) }
  }, { createOnly: true, replace: true });
  return await startCreatedProjectScope(orgId, document.id, template);
}
