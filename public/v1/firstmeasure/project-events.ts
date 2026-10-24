// A FirstMeasure report as events on the platform projects that link it (work/events.ts), for scopes, organization
// rules and the Feed: linking a report to a project publishes `measurement.report.ordered`, and a linked report that
// completes publishes `measurement.report.completed`. Nothing here knows which scope or rule listens.
import { listDocuments, type JsonObject } from "../platform/storage.js";

const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const clean = (value: unknown) => String(value ?? "").trim();

/** The report a platform project links, as every reader of the link resolves it. */
export function linkedReportId(project: JsonObject) {
  const measurement = obj(project.measurement_project || project.measurement), raw = obj(measurement.raw);
  return clean(measurement.id || measurement.project_id || raw.id || raw.project_id || project.measurement_project_id || project.folder);
}

async function emit(orgId: string, projectId: string, project: JsonObject, type: string, reportId: string, payload: JsonObject, actorUserId = "") {
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({
    organization_id: orgId,
    branch_id: clean(project.branch_id) || "default",
    project_id: projectId,
    type,
    // Once per project and report: a resave or a retry publishes nothing new.
    idempotency_key: `${type}:${projectId}:${reportId}`,
    payload: { report_id: reportId, ...payload },
    ...(actorUserId ? { context: { actor_user_id: actorUserId } } : {})
  });
}

/**
 * A project write that links a report the project did not link before: the report was ordered for it. A report that
 * is already complete when it is linked (an instant report) has also been delivered.
 */
export async function publishProjectReportLink(orgId: string, projectId: string, before: JsonObject, after: JsonObject, actorUserId = "") {
  const reportId = linkedReportId(after);
  if (!orgId || !projectId || !reportId || reportId === linkedReportId(before)) return;
  try {
    const report = obj(after.measurement_project || after.measurement);
    const status = clean(report.status || obj(report.raw).status).toLowerCase();
    await emit(orgId, projectId, after, "measurement.report.ordered", reportId, { report_status: status }, actorUserId);
    if (status === "completed") await emit(orgId, projectId, after, "measurement.report.completed", reportId, {}, actorUserId);
  } catch (error) {
    // The project is saved; a failed publication must not undo it.
    console.warn("Publishing measurement.report.ordered failed", projectId, error);
  }
}

/** A report that has just completed publishes `measurement.report.completed` on every project of its organization that links it. */
export async function publishReportCompleted(previous: JsonObject | null, current: JsonObject) {
  if (clean(current.status) !== "completed" || clean(previous?.status) === "completed") return;
  const orgId = clean(obj(current.organization_ref).id), reportId = clean(current.id);
  if (!orgId || !reportId) return;
  try {
    // Full scan of the organization's projects, once per completed report (docs/optimization-backlog.md).
    for (const project of (await listDocuments(orgId, "projects")).filter((document) => linkedReportId(obj(document.data)) === reportId)) {
      await emit(orgId, clean(project.id), obj(project.data), "measurement.report.completed", reportId, {});
    }
  } catch (error) {
    // The report transition is committed; a failed publication must not reverse it.
    console.warn("Publishing measurement.report.completed failed", reportId, error);
  }
}
