/**
 * Project-level projections of customer-portal state.
 *
 * WHY THIS EXISTS. Scope automations gate on conditions, and `conditionMatches`
 * (work/engine.ts) evaluates dot-paths over `{ event, payload, context, project,
 * plan, node }`. So the way to make portal state *gateable by scope authors* —
 * rather than by a hardcoded server rule — is to project a small summary of it
 * onto the project document, exactly as `work_projection` and `lifecycle`
 * already are.
 *
 * A scope template can then write, with no engine changes:
 *
 *   conditions: { "project.punch.required_outstanding": "0" }
 *   conditions: { "project.completion.signed": "true" }
 *
 * ...and the same facts are available to automation inputs via {{project.…}}.
 *
 * Keep these projections SMALL and STABLE. Every field here is a public
 * contract for every scope set ever authored — the same rule the work-event
 * catalog carries.
 *
 * Contract: docs/customer-portal-v2-spec.md §8.2 / §8.4.
 */

import { listProjectChecklists } from "../workforce/crew_storage.js";
import { isPunchList, punchConfigOf } from "../workforce/punch_lists.js";
import { readDocument, upsertDocument, type JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export type PunchProjection = {
  total: number;
  required_total: number;
  /** Required lists not yet accepted. The usual gate: "0" means clear to close out. */
  required_outstanding: number;
  awaiting_customer: number;
  awaiting_company: number;
  accepted: number;
  all_accepted: boolean;
  by_key: JsonObject;
};

/** Summarize every punch list on a project into gateable facts. */
export async function projectPunchProjection(orgId: string, projectId: string): Promise<PunchProjection> {
  let lists: Awaited<ReturnType<typeof listProjectChecklists>> = [];
  try {
    lists = (await listProjectChecklists(orgId, projectId)).filter((checklist) => isPunchList(checklist));
  } catch {
    lists = [];
  }
  const byKey: JsonObject = {};
  let requiredTotal = 0;
  let requiredOutstanding = 0;
  let awaitingCustomer = 0;
  let awaitingCompany = 0;
  let accepted = 0;

  for (const checklist of lists) {
    const config = punchConfigOf(checklist);
    const state = config.state;
    // Key by the instance segment of source_key so a scope author can gate on a
    // SPECIFIC list ("project.punch.by_key.finish.state") and not just the
    // aggregate. source_key is "punch:<instance>[:<node>]" — take <instance>,
    // which is the stable name the scope template chose.
    const sourceKey = cleanText(asObject(checklist).source_key);
    const key = sourceKey.startsWith("punch:")
      ? (sourceKey.split(":")[1] || cleanText(asObject(checklist).id))
      : (sourceKey || cleanText(asObject(checklist).id));
    byKey[key] = { state, required: config.required, accepted: state === "accepted" };

    if (config.required) requiredTotal += 1;
    if (state === "accepted") accepted += 1;
    else if (config.required) requiredOutstanding += 1;
    if (state === "requested") awaitingCustomer += 1;
    if (state === "work_complete") awaitingCustomer += 1;
    if (state === "submitted") awaitingCompany += 1;
  }

  return {
    total: lists.length,
    required_total: requiredTotal,
    required_outstanding: requiredOutstanding,
    awaiting_customer: awaitingCustomer,
    awaiting_company: awaitingCompany,
    accepted,
    all_accepted: lists.length > 0 && accepted === lists.length,
    by_key: byKey
  };
}

/**
 * Recompute and persist the portal projections onto the project document.
 *
 * Mirrors syncProjectWorkProjection: read, merge the projection keys, write
 * back with `replace: true`. Never throws — a projection failure must not fail
 * the customer action that triggered it.
 */
export async function syncPortalProjection(orgId: string, projectId: string) {
  if (!orgId || !projectId) return null;
  try {
    const document = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (!document) return null;
    const data = asObject(document.data);
    const punch = (await projectPunchProjection(orgId, projectId));
    // Completion is written by the completion flow itself; preserve whatever is
    // already there so this sync never clears it.
    const completion = asObject(data.completion);
    const saved = await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...data, punch, completion, updated_at: new Date().toISOString() },
      metadata: asObject(document.metadata)
    }, { replace: true });
    return asObject(saved.data);
  } catch {
    return null;
  }
}

/**
 * Record project completion on the project document so later scope nodes can
 * gate on `project.completion.signed`.
 */
export async function recordProjectCompletion(orgId: string, projectId: string, input: JsonObject) {
  const document = await readDocument(orgId, "projects", projectId);
  const data = asObject(document.data);
  const completion = {
    ...asObject(data.completion),
    requested: true,
    signed: input.signed === true,
    signed_at: cleanText(input.signed_at) || (input.signed === true ? new Date().toISOString() : ""),
    signer_name: cleanText(input.signer_name),
    mode: cleanText(input.mode) || "signature",
    document_id: cleanText(input.document_id)
  };
  const saved = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...data, completion, updated_at: new Date().toISOString() },
    metadata: asObject(document.metadata)
  }, { replace: true });
  return asObject(saved.data).completion;
}
