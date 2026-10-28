/**
 * The checklists setup's completion action (guided experience `checklists.setup`, docs/architecture/guided-experiences.md):
 * the checklists the person picked (a customer punch list to sign off, a crew safety checklist, a work-completion
 * checklist) are added to the project the setup ran on, where the Checklists tab tour then shows them.
 *
 * What each checklist says is data: the setup step's options in the library entry (which a variant can change per
 * kind of company), handed back as the step's selections. This only writes them, as ordinary project checklists,
 * once each: a setup played again keeps the ones already there (source key `setup:<use case>`).
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { badRequest } from "../platform/errors.js";
import { ensureProjectChecklists, type ProjectChecklistDefinition } from "./crew_storage.js";

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

export async function applyChecklistsSetup(orgId: string, projectId: string, actorUserId: string, value: unknown) {
  const input = setupInput.parse(value);
  const picked = new Set(input.checklist_use_cases);
  const chosen = input.checklist_definitions.filter((entry) => picked.has(entry.use_case));
  if (!chosen.length) throw badRequest("checklists_setup_empty", "Pick at least one checklist to start with.");
  const definitions: ProjectChecklistDefinition[] = chosen.map((entry, index) => ({
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
  const result = await ensureProjectChecklists(orgId, projectId, { definitions, actorUserId });
  const ids = new Set(chosen.map((entry) => `setup:${entry.use_case}`));
  return {
    created: result.created.map((checklist) => checklist.id),
    checklists: result.checklists.filter((checklist) => ids.has(checklist.source_key)).map((checklist) => ({ id: checklist.id, title: checklist.title, use_case: checklist.source_key.slice(6) }))
  };
}

export function registerChecklistsSetupPublication() {
  registerAction({
    id: "checklists.setup.apply", version: "1", domain: "work", implementation: backendImplementationDigest(),
    description: "Add the checklists picked in the checklists setup (customer punch list, crew safety, work completion) to the project.",
    inputSchema: zodToJsonSchema(setupInput, { $refStrategy: "none" }) as Record<string, unknown>,
    outputSchema: { type: "object" },
    executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["project"], permissions: ["manage_projects"], capabilities: ["apps.checklists"] },
    effect: "write", idempotency: "required",
    validateInput: (input) => { setupInput.parse(input); },
    execute: (ctx, target, input) => applyChecklistsSetup(ctx.organizationId, String(target.projectId || ""), String(ctx.auth?.userId || "system"), input)
  });
}
