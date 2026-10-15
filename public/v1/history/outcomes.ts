import { generationOutcome } from "./diff.js";
import { listGenerations, listProjectChanges, type GenerationRun } from "./storage.js";

/**
 * A generator run beside what people made of it. The list as the run left it is compared with the lines as they stood
 * just before the same list was generated again (or as they stand now), so a later run's lines are never counted as edits
 * to an earlier one. Only changes that were not themselves made by a generator count as what people did.
 */
export async function generationWithOutcome(orgId: string, run: GenerationRun, next?: GenerationRun) {
  const changes = await listProjectChanges(orgId, { subject_id: run.subject_id, since: run.at, ...(next ? { until: next.at } : {}), limit: 2000 });
  const after = changes.filter((change) => change.op === "lines" && change.id && change.generation_id !== (next?.id || "\u0000") && Array.isArray(change.after));
  const last = after[after.length - 1];
  const made = Array.isArray(run.output.lines) ? run.output.lines : [];
  // The list as the generator left it, with the lines it kept that people had added before; only what came after counts.
  const own = changes.find((change) => change.op === "lines" && change.generation_id === run.id && Array.isArray(change.after));
  const baseline = own ? own.after as unknown[] : made;
  const outcome = generationOutcome(baseline, last ? last.after as unknown[] : baseline);
  const edits = changes.filter((change) => change.source.kind !== "generator" && change.generation_id !== run.id);
  return {
    id: run.id, project_id: run.project_id, at: run.at, generator: run.generator, generator_version: run.generator_version,
    subject_type: run.subject_type, subject_id: run.subject_id, started_by: run.source, inputs: run.inputs, made: made.length,
    outcome: { ...outcome, edited_by: [...new Set(edits.map((change) => change.source.kind === "person" ? `person:${change.source.user_id || ""}` : change.source.kind))], last_change_at: edits.length ? edits[edits.length - 1]!.at : "" },
    superseded_at: next?.at || ""
  };
}

/** Runs of one project, or of one generator across the organization, newest first, each with its outcome. */
export async function generationsWithOutcomes(orgId: string, filter: { project_id?: string; generator?: string; since?: string; limit?: number; edited_only?: boolean }) {
  const runs = await listGenerations(orgId, filter);
  const rows = [];
  for (const run of runs) {
    const later = (await listGenerations(orgId, { subject_id: run.subject_id, since: run.at, limit: 50 })).filter((other) => other.id !== run.id && other.at >= run.at).sort((first, second) => first.at.localeCompare(second.at));
    const row = await generationWithOutcome(orgId, run, later[0]);
    if (!filter.edited_only || !row.outcome.untouched) rows.push(row);
  }
  return rows;
}
