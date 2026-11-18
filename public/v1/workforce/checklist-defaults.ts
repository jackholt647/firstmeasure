/**
 * An organization's default checklists, and the pipeline stages each is added in (GP-1).
 *
 * The default checklists are the ones the checklists setup picked (`checklists-setup.ts`, FM-448/FM-600) plus any
 * project checklist someone later made a default. They live in the default branch's `starting_checklists` module:
 *
 *   checklists: [definition]                    what each default says, keyed by `key` (the setup's use case for its own)
 *   pipelines:  { <scope template id>: { checklists: { <key>: "all" | [stage id] } } }
 *
 * A pipeline is a scope template and its stages are the template's stage nodes. A pipeline with no entry of its own
 * keeps what every organization had before: each default checklist is added when one of its scopes starts. Once
 * someone sets a pipeline up in Checklist settings (the project Checklists tab), a default is added when a scope of
 * that pipeline starts if it is on for all stages or for the stage it starts in, and when the project reaches a stage
 * it is on for (`checklists.addStageDefaults.v1`, bound by the default organization rules
 * `platform_checklists_stage_defaults` and `platform_checklists_stage_defaults_manual`). A list is added once per
 * project (source key `setup:<key>`); one someone deleted from the project is not added again, and nothing is taken
 * off when the project moves on.
 *
 * Read through the `checklist-defaults` provider and changed only through `checklists.defaults.save`.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { randomBytes } from "node:crypto";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { PlatformError, badRequest, conflict, notFound } from "../platform/errors.js";
import { readBranchModule, readDocument, saveBranchModule } from "../platform/storage.js";
import { adoptProjectChecklist, ensureProjectChecklists, listProjectChecklists, type ProjectChecklistDefinition } from "./crew_storage.js";

export const STARTING_CHECKLISTS_MODULE = "starting_checklists";
export const USE_CASES = ["punchlist", "crew_safety", "work_completion"] as const;
const MAX_DEFAULTS = 24;
const KEY = /^[a-z0-9][a-z0-9_]{0,59}$/;

const definitionFields = {
  title: z.string().trim().min(1).max(160),
  description: z.string().max(1000).default(""),
  audience: z.enum(["crew", "supervisor"]).default("crew"),
  crew_editable: z.boolean().default(false),
  signature_required: z.boolean().default(false),
  /** What the customer can do in their portal: nothing, look, or tick items off. */
  customer: z.enum(["none", "view", "complete"]).default("none"),
  items: z.array(z.object({ title: z.string().trim().min(1).max(300), item_type: z.enum(["todo", "rating"]).default("todo") }).strict()).max(40).default([])
};
/** A checklist the setup offers: one per use case. */
export const setupChecklistDefinition = z.object({ use_case: z.enum(USE_CASES), ...definitionFields }).passthrough();
/** A stored default: the setup's (keyed by its use case) or one made from a project checklist (its own `key`). */
const storedDefinition = z.object({ use_case: z.enum(USE_CASES).optional(), key: z.string().regex(KEY).optional(), ...definitionFields }).passthrough()
  .refine((entry) => !!(entry.key || entry.use_case), "A default checklist needs a key.");
export type DefaultChecklist = z.infer<typeof storedDefinition>;

const assignment = z.union([z.literal("all"), z.array(z.string().trim().min(1).max(160)).max(200)]);
type Assignment = z.infer<typeof assignment>;
const pipelineSettings = z.object({
  checklists: z.record(assignment).default({}),
  updated_at: z.string().optional(),
  updated_by: z.string().optional()
}).passthrough();
type PipelineSettings = z.infer<typeof pipelineSettings>;

export const keyOf = (entry: { key?: string; use_case?: string }) => String(entry.key || entry.use_case || "");
export const sourceKeyOf = (key: string) => `setup:${key}`;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** The module as stored, normalized: defaults that no longer parse are left out, assignments name only defaults. */
export async function readDefaultChecklistSettings(orgId: string) {
  let stored: Awaited<ReturnType<typeof readBranchModule>> | null;
  try { stored = await readBranchModule(orgId, "default", STARTING_CHECKLISTS_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) stored = null; else throw error; }
  const data = object(stored?.data);
  const seen = new Set<string>();
  const checklists = list(data.checklists).flatMap((raw) => {
    const parsed = storedDefinition.safeParse(raw);
    if (!parsed.success || seen.has(keyOf(parsed.data))) return [];
    seen.add(keyOf(parsed.data));
    return [parsed.data];
  });
  const pipelines: Record<string, PipelineSettings> = {};
  for (const [templateId, raw] of Object.entries(object(data.pipelines))) {
    const parsed = pipelineSettings.safeParse(raw);
    if (!parsed.success) continue;
    pipelines[templateId] = { ...parsed.data, checklists: Object.fromEntries(Object.entries(parsed.data.checklists).filter(([key]) => seen.has(key))) };
  }
  return { exists: !!stored, revision: Number(stored?.revision || 0), data, checklists, pipelines };
}

export function projectDefinitions(chosen: DefaultChecklist[]): ProjectChecklistDefinition[] {
  return chosen.map((entry, index) => ({
    title: entry.title,
    description: entry.description,
    kind: "todo",
    audience: entry.audience,
    crew_editable: entry.crew_editable,
    signature_required: entry.signature_required,
    sort_order: index,
    source: "setup",
    source_key: sourceKeyOf(keyOf(entry)),
    assignment_policy: { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] },
    customer_access: { schema_version: 1, visible: entry.customer !== "none", can_complete: entry.customer === "complete", can_edit_items: false },
    metadata: entry.use_case ? { setup_use_case: entry.use_case } : { default_checklist: keyOf(entry) },
    items: entry.items.map((item, itemIndex) => ({ ...item, sort_order: (itemIndex + 1) * 10 }))
  }));
}

/** The stages of a pipeline (scope template definition): its stage nodes, in order. */
export function pipelineStages(definition: unknown) {
  const stages: Array<{ id: string; title: string; color: string }> = [];
  const walk = (nodes: unknown) => list(nodes).map(object).forEach((node) => {
    if (text(node.terminology_key).endsWith("stage") && text(node.id)) {
      stages.push({ id: text(node.id), title: text(node.title) || text(node.id), color: text(object(node.metadata).color || node.color) });
      return;
    }
    walk(node.children);
  });
  walk(object(object(definition).work_plan).root_nodes);
  return stages;
}

const assigned = (value: Assignment | undefined, stageIds: readonly string[]) =>
  value === "all" || (Array.isArray(value) && value.some((stageId) => stageIds.includes(stageId)));

async function addDefaults(orgId: string, projectId: string, chosen: DefaultChecklist[]) {
  if (!chosen.length) return { created: [] as unknown[] };
  // A default someone deleted from this project stays deleted: stage changes would otherwise bring it back.
  return await ensureProjectChecklists(orgId, projectId, { definitions: projectDefinitions(chosen), skipDeletedSourceKeys: true });
}

/**
 * What a scope starting on a project adds: null when the organization has no default checklists; for a pipeline
 * set up in Checklist settings, the defaults on for all stages or the stage the scope starts in (`configured`);
 * otherwise every default (the caller keeps the older rules for that case).
 */
export async function defaultChecklistsForScopeStart(orgId: string, templateId: string, stageIds: readonly string[]) {
  const settings = await readDefaultChecklistSettings(orgId);
  if (!settings.checklists.length) return null;
  const pipeline = settings.pipelines[templateId];
  if (!pipeline) return { configured: false, checklists: settings.checklists };
  return { configured: true, checklists: settings.checklists.filter((entry) => assigned(pipeline.checklists[keyOf(entry)], stageIds)) };
}

export async function addScopeStartDefaults(orgId: string, projectId: string, chosen: DefaultChecklist[]) {
  return await addDefaults(orgId, projectId, chosen);
}

/** A project reached a stage of a pipeline: add the defaults that pipeline has on for it. */
export async function addStageDefaultChecklists(orgId: string, projectId: string, templateId: string, stageId: string) {
  if (!projectId || !templateId || !stageId) return { skipped: true, reason: "missing_project_pipeline_or_stage" };
  const settings = await readDefaultChecklistSettings(orgId);
  const pipeline = settings.pipelines[templateId];
  // A pipeline nobody set up adds every default when its scope starts, so there is nothing more to add per stage.
  if (!settings.checklists.length || !pipeline) return { skipped: true, reason: settings.checklists.length ? "pipeline_not_configured" : "no_default_checklists" };
  const chosen = settings.checklists.filter((entry) => Array.isArray(pipeline.checklists[keyOf(entry)]) && assigned(pipeline.checklists[keyOf(entry)], [stageId]));
  if (!chosen.length) return { skipped: true, reason: "no_default_checklists_for_stage" };
  const result = await addDefaults(orgId, projectId, chosen);
  return { initialized: true, source: "pipeline_stage_defaults", stage_id: stageId, checklist_count: result.created.length };
}

/** The setup's picks become the setup's defaults; defaults made from project checklists and pipeline settings stay. */
export async function saveSetupDefaults(orgId: string, chosen: Array<z.infer<typeof setupChecklistDefinition>>, actorUserId: string) {
  const current = await readDefaultChecklistSettings(orgId);
  const own = current.checklists.filter((entry) => !entry.use_case);
  const before = new Set(current.checklists.map(keyOf));
  const added = chosen.map(keyOf).filter((key) => !before.has(key));
  // A newly picked default is on for all stages of each pipeline someone has set up, as it is everywhere else.
  const pipelines = Object.fromEntries(Object.entries(current.pipelines).map(([id, pipeline]) =>
    [id, { ...pipeline, checklists: { ...pipeline.checklists, ...Object.fromEntries(added.map((key) => [key, "all"])) } }]));
  await saveBranchModule(orgId, "default", STARTING_CHECKLISTS_MODULE, {
    data: { use_cases: chosen.map((entry) => entry.use_case), checklists: [...chosen, ...own].slice(0, MAX_DEFAULTS), pipelines, updated_by: actorUserId }
  }, { replace: true });
}

// ── Published read and save ─────────────────────────────────────────────────

async function pipelinesFor(orgId: string, projectId: string) {
  const { listScopeTemplates } = await import("../scopes/storage.js");
  const { readIntakeRouting } = await import("../scopes/router.js");
  const { isIntakeTemplate } = await import("../scopes/categories.js");
  const project = projectId ? object((await readDocument(orgId, "projects", projectId).catch(() => null))?.data) : {};
  const running = list(object(project.work_projection).instances).map(object)
    .filter((instance) => !["completed", "canceled"].includes(text(instance.status)));
  const templates = await listScopeTemplates(orgId, "default", { include_disabled: true });
  const defaultId = text((await readIntakeRouting(orgId).catch(() => ({ default_template_id: "" }))).default_template_id);
  return {
    defaultId,
    running,
    templates: templates.filter((template) => {
      const id = text(template.id);
      if (running.some((instance) => text(instance.template_id) === id)) return true;
      return template.enabled !== false && !isIntakeTemplate(template.definition) && text(template.status) !== "archived";
    })
  };
}

/** Checklist settings as the panel shows them: the defaults, and per pipeline the stages each is added in. */
export async function readChecklistDefaultsView(orgId: string, projectId = "") {
  const settings = await readDefaultChecklistSettings(orgId);
  const { defaultId, running, templates } = await pipelinesFor(orgId, projectId);
  const keys = settings.checklists.map(keyOf);
  const pipelines = templates.map((template) => {
    const id = text(template.id);
    const own = settings.pipelines[id];
    const definition = object(template.definition);
    // Not set up: what a scope start adds today, which is every default where the template has checklists of its own.
    const fallback = list(definition.checklists).length ? Object.fromEntries(keys.map((key) => [key, "all" as const])) : {};
    const instance = running.find((entry) => text(entry.template_id) === id);
    return {
      id,
      name: text(template.name || definition.name) || id,
      color: text(definition.color || template.color),
      icon: text(definition.icon || template.icon),
      is_default: id === defaultId,
      configured: !!own,
      stages: pipelineStages(definition),
      checklists: own ? own.checklists : fallback,
      project: instance ? { running: true, stage_id: text(instance.stage_id), stage_title: text(instance.stage_title) } : { running: false, stage_id: "", stage_title: "" }
    };
  }).sort((a, b) => Number(b.project.running) - Number(a.project.running) || Number(b.is_default) - Number(a.is_default));
  return {
    revision: settings.revision,
    project_id: projectId,
    checklists: settings.checklists.map((entry) => ({
      key: keyOf(entry),
      source_key: sourceKeyOf(keyOf(entry)),
      use_case: entry.use_case || "",
      title: entry.title,
      description: entry.description,
      audience: entry.audience,
      signature_required: entry.signature_required,
      customer: entry.customer,
      items: entry.items
    })),
    default_pipeline_id: defaultId,
    pipelines
  };
}

const saveInput = z.object({
  expected_revision: z.number().int().min(0).optional(),
  /** One pipeline's settings: each default's stages ("all" or stage ids; a default left out is off). null = as before. */
  pipeline: z.object({ id: z.string().trim().min(1).max(160), checklists: z.record(z.string().regex(KEY), assignment).nullable() }).strict().optional(),
  /** Make one of the target project's checklists a default (it becomes that default on this project). */
  add_from_checklist_id: z.string().trim().min(1).max(160).optional(),
  /** Stop using these defaults. Projects keep the lists they already have. */
  remove: z.array(z.string().regex(KEY)).max(MAX_DEFAULTS).optional()
}).strict();
type SaveInput = z.infer<typeof saveInput>;

function definitionFromChecklist(checklist: Awaited<ReturnType<typeof listProjectChecklists>>[number], key: string): DefaultChecklist {
  const access = object(checklist.customer_access);
  return {
    key,
    title: text(checklist.title).slice(0, 160) || "Checklist",
    description: text(checklist.description).slice(0, 1000),
    audience: checklist.audience === "supervisor" ? "supervisor" : "crew",
    crew_editable: checklist.crew_editable === true,
    signature_required: checklist.signature_required === true,
    customer: access.visible !== true ? "none" : access.can_complete === true ? "complete" : "view",
    items: list(checklist.items).map(object).filter((item) => text(item.title)).slice(0, 40)
      .map((item) => ({ title: text(item.title).slice(0, 300), item_type: text(item.item_type) === "rating" ? "rating" as const : "todo" as const }))
  };
}

export async function saveChecklistDefaults(orgId: string, projectId: string, input: SaveInput, actorUserId: string) {
  const current = await readDefaultChecklistSettings(orgId);
  if (input.expected_revision !== undefined && current.exists && input.expected_revision !== current.revision) {
    throw conflict("checklist_defaults_changed", "Someone else changed the checklist settings. Reload and try again.");
  }
  let checklists = [...current.checklists];
  const pipelines = structuredClone(current.pipelines);
  const removed = new Set(input.remove || []);
  if (removed.size) {
    checklists = checklists.filter((entry) => !removed.has(keyOf(entry)));
    for (const pipeline of Object.values(pipelines)) for (const key of removed) delete pipeline.checklists[key];
  }
  let added: { key: string; checklist_id: string } | null = null;
  if (input.add_from_checklist_id) {
    if (!projectId) throw badRequest("checklist_defaults_project_required", "Make a checklist a default from its project.");
    const checklist = (await listProjectChecklists(orgId, projectId)).find((entry) => entry.id === input.add_from_checklist_id);
    if (!checklist) throw notFound("checklist_not_found", "That checklist is not on this project.");
    const existing = checklist.source_key.startsWith("setup:") ? checklist.source_key.slice(6) : "";
    if (existing && checklists.some((entry) => keyOf(entry) === existing)) throw badRequest("checklist_already_default", "That checklist is already a default.");
    if (checklists.length >= MAX_DEFAULTS) throw badRequest("checklist_defaults_full", `An organization can have up to ${MAX_DEFAULTS} default checklists.`);
    const key = `list_${randomBytes(5).toString("hex")}`;
    checklists.push(definitionFromChecklist(checklist, key));
    await adoptProjectChecklist(orgId, projectId, checklist.id, sourceKeyOf(key));
    added = { key, checklist_id: checklist.id };
  }
  if (input.pipeline) {
    const { id } = input.pipeline;
    if (input.pipeline.checklists === null) delete pipelines[id];
    else {
      const keys = new Set(checklists.map(keyOf));
      const unknown = Object.keys(input.pipeline.checklists).filter((key) => !keys.has(key));
      if (unknown.length) throw badRequest("checklist_default_unknown", `Not a default checklist: ${unknown.join(", ")}.`);
      pipelines[id] = { checklists: input.pipeline.checklists, updated_at: new Date().toISOString(), updated_by: actorUserId };
    }
  }
  await saveBranchModule(orgId, "default", STARTING_CHECKLISTS_MODULE, {
    ...(current.exists ? { expected_revision: current.revision } : {}),
    data: { ...current.data, checklists, pipelines, updated_by: actorUserId }
  }, { replace: true });
  return { ...(await readChecklistDefaultsView(orgId, projectId)), added };
}

const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
const projectExists = async (ctx: PublicationContext, target: TargetRef) => {
  if (target.scope === "project") await readDocument(ctx.organizationId, "projects", String(target.projectId));
};
const readAccess: AccessPolicy = { scopes: ["organization", "project"], permissions: ["view_projects"], capabilities: ["apps.checklists"], systemKinds: ["work", "module", "agent"], authorize: projectExists };

let registered = false;
export function registerChecklistDefaultsPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "checklist-defaults", version: "1", apps: ["checklists"], exports: {
    settings: {
      description: "The organization's default checklists (title, items, who sees them) and, for each pipeline (scope template), its stages and the stages each default is added in: \"all\" or a list of stage ids. `configured: false` means the pipeline adds every default when a scope starts. With a project target, each pipeline also says whether the project runs it and its current stage.",
      schema: { type: "object" }, schemaVersion: "1", access: readAccess,
      read: async (ctx, ref) => {
        const value = await readChecklistDefaultsView(ctx.organizationId, ref.target.scope === "project" ? String(ref.target.projectId || "") : "");
        return { value, revision: String(value.revision) };
      }
    }
  } });
  registerAction({
    id: "checklists.defaults.save", version: "1", domain: "work", implementation: backendImplementationDigest(),
    description: "Change the organization's default checklists: set which stages of one pipeline each default is added in (\"all\" or stage ids; null puts the pipeline back to adding every default when a scope starts), make one of the target project's checklists a default, or stop using defaults. Projects keep the lists they already have.",
    inputSchema: json(saveInput), outputSchema: { type: "object" },
    executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["apps.checklists"], authorize: projectExists },
    effect: "write", idempotency: "required",
    validateInput: (value) => { saveInput.parse(value); },
    execute: (ctx, target, value) => saveChecklistDefaults(ctx.organizationId, target.scope === "project" ? String(target.projectId || "") : "", saveInput.parse(value), String(ctx.auth?.userId || "system"))
  });
}
