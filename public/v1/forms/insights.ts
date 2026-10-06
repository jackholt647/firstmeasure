import type { JsonObject } from "../platform/storage.js";
import { withProjectDocumentLock } from "../platform/project_document_mutation.js";
import { formItems, type FormDefinition } from "./contracts.js";
import { ACTIVITY, SUBMISSIONS, findRecord, listRecords, saveRecord } from "./storage.js";

/**
 * Who reaches a form and how they fill it in. Activity is anonymous counts per
 * form per day (views, starts, steps reached); everything about individual
 * people comes from the submissions they chose to send.
 */

const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown) => String(value ?? "").trim();
const day = (date = new Date()) => date.toISOString().slice(0, 10);

export type ActivityEvent = { type: "view" | "start" | "step"; step_id?: string };

export async function recordActivity(orgId: string, formId: string, event: ActivityEvent) {
  const id = `${formId}_${day()}`;
  await withProjectDocumentLock(orgId, `form_activity:${formId}`, async () => {
    const current = await findRecord(orgId, ACTIVITY, id);
    const steps = { ...obj(current?.steps) };
    if (event.type === "step" && event.step_id) steps[event.step_id] = Number(steps[event.step_id] || 0) + 1;
    await saveRecord(orgId, ACTIVITY, id, {
      form_id: formId,
      day: day(),
      views: Number(current?.views || 0) + (event.type === "view" ? 1 : 0),
      starts: Number(current?.starts || 0) + (event.type === "start" ? 1 : 0),
      steps
    });
  });
}

const DAYS = 30;

export async function buildInsights(orgId: string, formId: string, definition: FormDefinition) {
  const [activity, submissions] = await Promise.all([
    listRecords(orgId, ACTIVITY).then((rows) => rows.filter((row) => row.form_id === formId)),
    listRecords(orgId, SUBMISSIONS).then((rows) => rows.filter((row) => row.form_id === formId && row.status === "complete"))
  ]);
  submissions.sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)));

  const days: string[] = [];
  for (let offset = DAYS - 1; offset >= 0; offset -= 1) days.push(day(new Date(Date.now() - offset * 86_400_000)));
  const byDay = new Map(days.map((entry) => [entry, { day: entry, views: 0, starts: 0, submissions: 0 }]));
  const stepsReached: Record<string, number> = {};
  let views = 0;
  let starts = 0;
  for (const row of activity) {
    views += Number(row.views || 0);
    starts += Number(row.starts || 0);
    const entry = byDay.get(str(row.day));
    if (entry) { entry.views += Number(row.views || 0); entry.starts += Number(row.starts || 0); }
    for (const [stepId, count] of Object.entries(obj(row.steps))) stepsReached[stepId] = (stepsReached[stepId] || 0) + Number(count || 0);
  }
  for (const row of submissions) {
    const entry = byDay.get(str(row.created_at).slice(0, 10));
    if (entry) entry.submissions += 1;
  }

  // How each question was answered, across every submission.
  const questions: JsonObject[] = [];
  for (const item of formItems(definition)) {
    if (!item.param) continue;
    const values = submissions.map((row) => obj(row.answers)[item.param!]).filter((value) => value !== undefined && value !== null && value !== "");
    if (item.kind === "select" || item.kind === "multi_select") {
      const counts = new Map(item.options.map((option) => [option.value, 0]));
      for (const value of values) for (const entry of Array.isArray(value) ? value : [value]) counts.set(str(entry), (counts.get(str(entry)) || 0) + 1);
      questions.push({ param: item.param, label: item.label || item.param, kind: item.kind, answered: values.length, options: item.options.map((option) => ({ label: option.label, count: counts.get(option.value) || 0 })) });
    } else if (item.kind === "boolean") {
      questions.push({ param: item.param, label: item.label || item.param, kind: item.kind, answered: values.length, options: [{ label: "Yes", count: values.filter((value) => value === true).length }, { label: "No", count: values.filter((value) => value === false).length }] });
    } else if (item.kind === "number") {
      const numbers = values.map(Number).filter(Number.isFinite);
      questions.push({ param: item.param, label: item.label || item.param, kind: item.kind, answered: numbers.length, unit: item.unit, ...(numbers.length ? { average: Math.round(numbers.reduce((total, value) => total + value, 0) / numbers.length * 100) / 100, min: Math.min(...numbers), max: Math.max(...numbers) } : {}) });
    }
  }

  const priced = submissions.map((row) => obj(row.estimate)).filter((estimate) => Number.isFinite(Number(estimate.low)) && Object.keys(estimate).length);
  const average = (key: string) => priced.length ? Math.round(priced.reduce((total, estimate) => total + Number(estimate[key] || 0), 0) / priced.length) : 0;
  const appointments = submissions.map((row) => obj(row.appointment)).filter((appointment) => appointment.status);
  const rate = (part: number, whole: number) => whole > 0 ? Math.min(100, Math.round(part / whole * 1000) / 10) : null;

  return {
    period_days: DAYS,
    totals: {
      views,
      starts,
      submissions: submissions.length,
      // Activity counting began with this release; older submissions have no matching views.
      start_rate: rate(starts, views),
      completion_rate: rate(submissions.length, starts),
      last_submission_at: str(submissions[0]?.created_at)
    },
    daily: [...byDay.values()],
    steps: definition.steps.map((step, index) => ({ id: step.id, title: step.title || `Step ${index + 1}`, reached: stepsReached[step.id] || 0 })),
    questions,
    estimates: priced.length ? { count: priced.length, average_low: average("low"), average_high: average("high"), currency: str(priced[0]!.currency) || "USD" } : null,
    appointments: appointments.length ? { booked: appointments.filter((entry) => entry.status === "booked").length, requested: appointments.filter((entry) => entry.status !== "booked").length } : null,
    recent: submissions.slice(0, 50).map((row) => ({
      id: row.id,
      created_at: str(row.created_at),
      contact: obj(row.contact),
      address: str(row.address),
      summary: Array.isArray(row.summary) ? row.summary : [],
      estimate: row.estimate || null,
      appointment: row.appointment || null,
      project_id: str(row.project_id),
      page_url: str(row.page_url)
    }))
  };
}
