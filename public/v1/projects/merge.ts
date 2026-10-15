import { randomBytes } from "node:crypto";
import { badRequest, conflict, forbidden } from "../platform/errors.js";
import { listDocuments, readDocument, type JsonObject } from "../platform/storage.js";
import { updateProjectData } from "../platform/project_document_mutation.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
import { contactStore } from "../contacts/store.js";
import { projectReferenceAdapters } from "../contacts/references.js";
import { projectContactLinks, refreshProjections, setProjectContactLinks } from "../contacts/records.js";

// Project merge (docs/architecture/opportunities.md "Project merge"): one sale
// that came in twice. The merged project is kept, marked merged_into, with its
// open plans closed; what belongs to the customer moves to the survivor.

export const MERGE_COMMITTED_PERMISSION = "merge_committed_projects";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown) => Array.isArray(value) ? value : [];

/** Sold, paid or finalized: merging it needs merge_committed_projects. */
export async function projectIsCommitted(org: string, projectId: string, data: JsonObject) {
  const lifecycle = object(data.lifecycle);
  if (text(lifecycle.sold_at) || Number(object(lifecycle.opportunities).won || 0) > 0 || text(data.won_at)) return true;
  const payments = await listDocuments(org, "payment_transactions").catch(() => []);
  if (payments.some(row => text(object(row.data).project_id) === projectId)) return true;
  const finalized = await listDocuments(org, "labor_completions").catch(() => []);
  return finalized.some(row => text(object(row.data).project_id) === projectId);
}

export async function mergeProjects(org: string, survivorId: string, mergedId: string, options: { actor_user_id?: string; allow_committed?: boolean } = {}) {
  if (!text(survivorId) || !text(mergedId) || survivorId === mergedId) throw badRequest("project_merge_same", "Choose two different projects to merge.");
  const survivor = await readDocument(org, "projects", survivorId), merged = await readDocument(org, "projects", mergedId);
  const survivorData = object(survivor.data), mergedData = object(merged.data);
  if (text(survivorData.merged_into) || text(mergedData.merged_into)) throw conflict("project_already_merged", "One of these projects was already merged into another.");
  for (const [id, data] of [[mergedId, mergedData], [survivorId, survivorData]] as const) {
    if (!options.allow_committed && await projectIsCommitted(org, id, data)) throw forbidden("project_merge_committed", "This project has a won sale, a payment or finalized work. Merging it needs the Merge sold projects permission.");
  }
  const moved: Record<string, number> = {};
  const time = new Date().toISOString(), reason = "merged";

  // Contacts: the survivor's first, then the merged project's that it lacks.
  const ours = await projectContactLinks(org, survivorId), theirs = await projectContactLinks(org, mergedId);
  await setProjectContactLinks(org, survivorId, [...ours, ...theirs.filter(link => !ours.some(own => own.contact_id === link.contact_id)).map(link => ({ ...link, primary: false }))]);
  await setProjectContactLinks(org, mergedId, []);
  moved.contact_links = theirs.length;

  // Plans are not spliced: the merged project's open ones close, and an open opportunity is recorded as merged.
  const work = await import("../work/storage.js"), service = await import("../work/service.js");
  const plans = (await work.listPlanRecords(org, { project_id: mergedId })).filter(plan => !["completed", "canceled"].includes(text(plan.status)));
  for (const plan of plans) {
    for (const node of (await work.listNodeRecords(org, { plan_id: text(plan.id) })).filter(node => !["completed", "skipped", "canceled"].includes(text(node.status)))) {
      await service.transitionWorkNode(org, text(node.id), "canceled", { reason });
    }
    await work.updatePlanRecord(org, text(plan.id), { status: "canceled", canceled_at: time, outcome_reason: plan.sales === true ? reason : "", metadata: { ...object(plan.metadata), canceled_reason: reason, merged_into: survivorId } });
  }
  moved.closed_plans = plans.length;
  for (const adapter of projectReferenceAdapters()) moved[adapter.id] = await adapter.repoint(org, mergedId, survivorId);

  // Both lead sources stay, so attribution and both reps survive; schedule items on the project move with it.
  const sources = [...list(survivorData.lead_sources), ...(Object.keys(object(survivorData.lead_source)).length ? [survivorData.lead_source] : []), ...list(mergedData.lead_sources), ...(Object.keys(object(mergedData.lead_source)).length ? [mergedData.lead_source] : [])];
  const seen = new Set<string>();
  const leadSources = sources.map(object).filter(source => { const key = JSON.stringify(source); if (seen.has(key)) return false; seen.add(key); return true; });
  const events = list(mergedData.events);
  await updateProjectData(org, survivorId, data => ({ ...data, lead_sources: leadSources, events: [...list(data.events), ...events], merged_project_ids: [...new Set([...list(data.merged_project_ids).map(text), mergedId])] }));
  await updateProjectData(org, mergedId, data => ({ ...data, events: [], merged_into: survivorId, merged_at: time }));
  moved.events = events.length;

  const db = contactStore(), id = `merge_${randomBytes(8).toString("hex")}`;
  await db.prepare("UPDATE contact_duplicates SET status='merged', updated_at=? WHERE organization_id=? AND kind='project' AND (first_id=? OR second_id=?)").run(time, org, mergedId, mergedId);
  await db.prepare("INSERT INTO contact_merges(organization_id,id,kind,survivor_id,merged_id,actor_user_id,before_json,moved_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(org, id, "project", survivorId, mergedId, text(options.actor_user_id), JSON.stringify({ survivor: survivorData.lead_source || {}, merged: mergedData.lead_source || {} }), JSON.stringify(moved), time);
  await refreshProjections(org, [survivorId, mergedId]);
  await service.syncProjectWorkProjection(org, survivorId);
  await service.syncProjectWorkProjection(org, mergedId);
  await publishRealtimeEvent({ organization_id: org, topic: "project.merged", payload: { project_id: survivorId, merged_id: mergedId } });
  return { merge_id: id, project: await readDocument(org, "projects", survivorId), moved };
}
