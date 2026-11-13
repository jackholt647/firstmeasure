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
 * The picks are kept for the organization in the default branch's `starting_checklists` module. Once it is set, a
 * scope that starts adds these instead of its template's checklists (`checklists.initializeFromScope.v1`), so every
 * new project starts with the same lists (FM-448). One set per organization, the platform MVP's single configuration.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { PlatformError, badRequest } from "../platform/errors.js";
import { readBranchModule, saveBranchModule } from "../platform/storage.js";
import { ensureProjectChecklists, removeUntouchedProjectChecklists, type ProjectChecklistDefinition } from "./crew_storage.js";

export const STARTING_CHECKLISTS_MODULE = "starting_checklists";

const USE_CASES = ["punchlist", "crew_safety", "work_completion"] as const;
const definition = z.object({
  use_case: z.enum(USE_CASES),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(1000).default(""),
  audience: z.enum(["crew", "supervisor"]).default("crew"),
  crew_editable: z.boolean().default(false),
  signature_required: z.boolean().default(false),
  /** What the customer can do in their portal: nothing, look, or tick items off. */
  customer: z.enum(["none", "view", "complete"]).default("none"),
  items: z.array(z.object({ title: z.string().trim().min(1).max(300), item_type: z.enum(["todo", "rating"]).default("todo") }).strict()).max(40).default([])
}).passthrough();
const setupInput = z.object({
  checklist_use_cases: z.array(z.enum(USE_CASES)).max(USE_CASES.length).default([]),
  checklist_definitions: z.array(definition).max(USE_CASES.length).default([])
}).passthrough();

type SetupChecklist = z.infer<typeof definition>;

function projectDefinitions(chosen: SetupChecklist[]): ProjectChecklistDefinition[] {
  return chosen.map((entry, index) => ({
    title: entry.title,
    description: entry.description,
    kind: "todo",
    audience: entry.audience,
    crew_editable: entry.crew_editable,
    signature_required: entry.signature_required,
    sort_order: index,
    source: "setup",
    source_key: `setup:${entry.use_case}`,
    assignment_policy: { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] },
    customer_access: { schema_version: 1, visible: entry.customer !== "none", can_complete: entry.customer === "complete", can_edit_items: false },
    metadata: { setup_use_case: entry.use_case },
    items: entry.items.map((item, itemIndex) => ({ ...item, sort_order: (itemIndex + 1) * 10 }))
  }));
}

/** The organization's starting checklists, as project checklist definitions, or null when the setup never ran. */
export async function readStartingChecklists(orgId: string): Promise<ProjectChecklistDefinition[] | null> {
  let stored: Awaited<ReturnType<typeof readBranchModule>> | null;
  try { stored = await readBranchModule(orgId, "default", STARTING_CHECKLISTS_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
  const parsed = z.array(definition).max(USE_CASES.length).safeParse((stored?.data as Record<string, unknown> | undefined)?.checklists);
  return parsed.success && parsed.data.length ? projectDefinitions(parsed.data) : null;
}

/** What a starting scope adds: the organization's starting checklists, the same keys on every project. */
export async function ensureStartingChecklists(orgId: string, projectId: string) {
  const definitions = await readStartingChecklists(orgId);
  return definitions ? await ensureProjectChecklists(orgId, projectId, { definitions }) : null;
}

export async function applyChecklistsSetup(orgId: string, projectId: string, actorUserId: string, value: unknown) {
  const input = setupInput.parse(value);
  const picked = new Set(input.checklist_use_cases);
  const chosen = input.checklist_definitions.filter((entry) => picked.has(entry.use_case));
  if (!chosen.length) throw badRequest("checklists_setup_empty", "Pick at least one checklist to start with.");
  await saveBranchModule(orgId, "default", STARTING_CHECKLISTS_MODULE, {
    data: { use_cases: chosen.map((entry) => entry.use_case), checklists: chosen, updated_by: actorUserId }
  }, { replace: true });
  const result = await ensureProjectChecklists(orgId, projectId, { definitions: projectDefinitions(chosen), actorUserId });
  const ids = new Set(chosen.map((entry) => `setup:${entry.use_case}`));
  // Only the picked lists: what the project started with from its scope template, or an earlier play's pick, goes
  // unless someone has worked on it. Punch lists a scope requested (`punch:`) and lists people made stay.
  const removed = await removeUntouchedProjectChecklists(orgId, projectId, (checklist) =>
    checklist.source_key.startsWith("scope:") || (checklist.source_key.startsWith("setup:") && !ids.has(checklist.source_key)));
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
