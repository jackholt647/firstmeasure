/**
 * Project facts used to decide which customer-portal pages a given project's
 * customer may see (`audience` blocks on website_pages).
 *
 * Contract: docs/customer-portal-v2-spec.md §3.
 *
 * These facts are computed server-side and never leave the server. The portal
 * payload carries only the pages a project is allowed to see — targeting rules
 * are not shipped to the client and pages are not hidden with CSS.
 */

import { listPlanRecords } from "../work/storage.js";
import type { JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export type ProjectAudienceFacts = {
  scope_template_ids: string[];
  tag_ids: string[];
  status: string;
  custom_fields: JsonObject;
};

/**
 * Build the audience facts for a project.
 *
 * - `scope_template_ids` come from the project's work plans (`work_plans.template_id`),
 *   which is how "project type" is actually represented — a project's type IS the
 *   scope template(s) driving it. See docs/customer-portal-v2-spec.md §3.2 and
 *   [[firstmate-pipeline-architecture]] (the sales pipeline is itself a scope template,
 *   so pipeline plans appear here too and can be targeted deliberately).
 * - `tag_ids` are the project's free-text tags, lowercased for case-insensitive
 *   matching. Projects store tags as labels (string[]), not ids — the field keeps
 *   the `tag_ids` name to match the audience block's key.
 *
 * Never throws: a project whose plans cannot be read yields empty facts, which
 * means targeted pages are hidden rather than leaked (fail closed).
 */
export async function projectAudienceFacts(orgId: string, project: JsonObject): Promise<ProjectAudienceFacts> {
  const projectId = cleanText(project.id);
  let scopeTemplateIds: string[] = [];
  if (projectId) {
    try {
      const plans = (await listPlanRecords(orgId, { project_id: projectId }));
      scopeTemplateIds = [...new Set(
        plans
          .map((plan) => cleanText(asObject(plan).template_id))
          .filter(Boolean)
      )];
    } catch {
      // Work database unavailable — degrade to no scope facts (fail closed).
      scopeTemplateIds = [];
    }
  }

  const tags = [...new Set(
    asArray(project.tags)
      .map((tag) => cleanText(tag).toLowerCase())
      .filter(Boolean)
  )];

  return {
    scope_template_ids: scopeTemplateIds,
    tag_ids: tags,
    status: cleanText(project.status).toLowerCase(),
    custom_fields: asObject(project.custom_fields)
  };
}
