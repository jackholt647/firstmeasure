/**
 * The checklists setup's completion action (guided experience `checklists.setup`, docs/architecture/guided-experiences.md):
 * the checklists the person picked (a customer punch list to sign off, a crew safety checklist, a work-completion
 * checklist) are the organization's starting checklists from then on, and the project the setup ran on gets exactly
 * those, where the Checklists tab tour then shows them.
 *
 * What each checklist says is data: the setup step's options in the library entry (which a variant can change per
 * kind of company), handed back as the step's selections. This writes them, as ordinary project checklists, once
 * each: a setup played again keeps the ones already there (source key `setup:<use case>`). Lists the project started
 * with (from its scope template, or picked in an earlier play) that are not picked now and nobody has touched are
 * taken off.
 *
 * The picks, as the person left them on the setup's own page for each (FM-600), are kept for the organization in the
 * default branch's `starting_checklists` module: its default checklists. Once it is set, a scope that starts adds these
 * instead of its template's checklists (`checklists.initializeFromScope.v1`), so every new project starts with the same
 * lists (FM-448); before it is set, an organization with Checklists gets none. Which stages of each pipeline add which
 * default, and defaults made from project checklists, are Checklist settings (`checklist-defaults.ts`, GP-1); playing
 * the setup again changes only its own picks.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { badRequest } from "../platform/errors.js";
import { ensureProjectChecklists, removeUntouchedProjectChecklists } from "./crew_storage.js";
import { USE_CASES, projectDefinitions, readDefaultChecklistSettings, saveSetupDefaults, setupChecklistDefinition } from "./checklist-defaults.js";

export { STARTING_CHECKLISTS_MODULE } from "./checklist-defaults.js";

const setupInput = z.object({
  checklist_use_cases: z.array(z.enum(USE_CASES)).max(USE_CASES.length).default([]),
  checklist_definitions: z.array(setupChecklistDefinition).max(USE_CASES.length).default([])
}).passthrough();

/** The organization's default checklists, as project checklist definitions, or null when there are none. */
export async function readStartingChecklists(orgId: string) {
  const { checklists } = await readDefaultChecklistSettings(orgId);
  return checklists.length ? projectDefinitions(checklists) : null;
}

export async function applyChecklistsSetup(orgId: string, projectId: string, actorUserId: string, value: unknown) {
  const input = setupInput.parse(value);
  const picked = new Set(input.checklist_use_cases);
  const chosen = input.checklist_definitions.filter((entry) => picked.has(entry.use_case));
  if (!chosen.length) throw badRequest("checklists_setup_empty", "Pick at least one checklist to start with.");
  await saveSetupDefaults(orgId, chosen, actorUserId);
  const result = await ensureProjectChecklists(orgId, projectId, { definitions: projectDefinitions(chosen), actorUserId });
  const ids = new Set(chosen.map((entry) => `setup:${entry.use_case}`));
  // Only the picked lists: what the project started with from its scope template, or an earlier play's pick, goes
  // unless someone has worked on it. Punch lists a scope requested (`punch:`) and lists people made stay.
  // Defaults someone made from a project checklist (GP-1) are not the setup's to take off.
  const setupKeys = new Set(USE_CASES.map((useCase) => `setup:${useCase}`));
  const removed = await removeUntouchedProjectChecklists(orgId, projectId, (checklist) =>
    checklist.source_key.startsWith("scope:") || (setupKeys.has(checklist.source_key) && !ids.has(checklist.source_key)));
  return {
    created: result.created.map((checklist) => checklist.id),
    removed,
    checklists: result.checklists.filter((checklist) => ids.has(checklist.source_key)).map((checklist) => ({ id: checklist.id, title: checklist.title, use_case: checklist.source_key.slice(6) }))
  };
}

export function registerChecklistsSetupPublication() {
  registerAction({
    id: "checklists.setup.apply", version: "1", domain: "work", implementation: backendImplementationDigest(),
    description: "Make the checklists picked in the checklists setup (customer punch list, crew safety, work completion) the organization's starting checklists, and give the project exactly those.",
    inputSchema: zodToJsonSchema(setupInput, { $refStrategy: "none" }) as Record<string, unknown>,
    outputSchema: { type: "object" },
    executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["project"], permissions: ["manage_projects"], capabilities: ["apps.checklists"] },
    effect: "write", idempotency: "required",
    validateInput: (input) => { setupInput.parse(input); },
    execute: (ctx, target, input) => applyChecklistsSetup(ctx.organizationId, String(target.projectId || ""), String(ctx.auth?.userId || "system"), input)
  });
}
