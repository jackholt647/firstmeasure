import { can, hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { invokeAction } from "../platform/publication/actions.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { resolveOrganizationTimezone } from "../platform/timezone.js";
import { evaluateConditions } from "../work/conditions.js";
import { createHash } from "node:crypto";
import { appendAgentMessage, listAgentMessages } from "../agents/storage.js";
import { chooseVariant, regionForState, sizeTierFor, unitIdFor, type ChooserContext } from "./chooser.js";
import { EVENT_TYPES, selectionsSchema, type Copy, type ExperienceDefinition, type ExperienceStep, type GuidedEventType } from "./contracts.js";
import { experience, guidedSource, listExperiences, tabFaqs } from "./registry.js";
import { listProgress, readProgress, recordEvent, wasExposed, writeProgress, type Progress } from "./store.js";
import { registerMaterialsGuidedExperiences } from "./definitions/materials.js";

/**
 * The guided-experience runtime on the server: which experiences a person may play now (eligibility, the chooser,
 * progress), what happens when they move through one (progress and analytics events), finishing one (its published
 * action, run as the person), the scripted agent messages of an agentic setup (written into the person's own project
 * conversation) and the context the real assistant gets when the person types during one.
 */

export function ensureGuidedDefinitions() { registerMaterialsGuidedExperiences(); }

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const subjectFor = (definition: ExperienceDefinition, ctx: PlatformAuthContext) => definition.scope === "organization" ? "" : ctx.userId;

/** Facts the chooser and conditions read. Navigation fields come from the page and are only used to pick content. */
export async function chooserContext(ctx: PlatformAuthContext, surface: { tab?: string; projectId?: string } = {}): Promise<ChooserContext> {
  const organization = object(ctx.organization), data = object(organization.data);
  const address = object(data.address || data.business_address || organization.address);
  const state = text(address.state || data.state || data.business_state || organization.state).toUpperCase().slice(0, 2);
  const industryRaw = data.industry || data.trade || (Array.isArray(data.industries) ? data.industries[0] : "") || organization.industry;
  const users = Number(data.employee_count || data.team_size || data.employees || 0);
  const timezone = await resolveOrganizationTimezone(ctx.orgId, ctx.branchId).catch(() => "");
  const [assistant, materials] = await Promise.all([can(ctx, "apps.assistant").catch(() => false), can(ctx, "platform.materials").catch(() => false)]);
  const finished = (await listProgress(ctx.orgId, [""])).filter((row) => row.status !== "started").map((row) => row.experience_id);
  return {
    organization: { id: ctx.orgId, region: regionForState(state), state, timezone, size: { users, tier: sizeTierFor(users) }, industry: text(industryRaw).toLowerCase(),
      capabilities: { assistant, materials }, ...{ flags: { assistant, materials }, finished } } as ChooserContext["organization"],
    person: { id: ctx.userId, role: text(ctx.role), permissions: {} },
    surface: { tab: text(surface.tab).slice(0, 80), project_id: text(surface.projectId).slice(0, 160) }
  };
}

async function eligible(definition: ExperienceDefinition, ctx: PlatformAuthContext, chooser: ChooserContext) {
  for (const permission of definition.eligibility.permissions) if (!hasPermission(ctx, permission)) return false;
  for (const capability of definition.eligibility.capabilities) if (!(await can(ctx, capability).catch(() => false))) return false;
  return !definition.eligibility.when || evaluateConditions(definition.eligibility.when, chooser as unknown as Record<string, unknown>);
}

function nextOf(step: ExperienceStep) { return step.next ?? null; }

/**
 * The step after this one in the variant's order: its `next`, or the first branch whose conditions match the
 * selections so far ({ selections: {...} }), else the next step in order. Null when it was the last.
 */
export function nextStep(definition: ExperienceDefinition, variant: ExperienceDefinition["variants"][number], stepId: string, selections: Record<string, unknown>): string | null {
  const order = variant.steps?.length ? variant.steps : definition.steps.map((step) => step.id);
  const step = definition.steps.find((entry) => entry.id === stepId);
  const sequential = order[order.indexOf(stepId) + 1] || null;
  const next = step?.next as string | { branches: { when: unknown; to: string }[]; otherwise?: string } | undefined;
  if (!next) return sequential;
  if (typeof next === "string") return order.includes(next) ? next : sequential;
  const hit = next.branches.find((branch) => order.includes(branch.to) && evaluateConditions(branch.when, { selections }));
  return hit?.to || (next.otherwise && order.includes(next.otherwise) ? next.otherwise : sequential);
}

/** One experience as this person plays it: its variant, steps in the variant's order with their options filled, armed triggers and progress. */
async function resolve(definition: ExperienceDefinition, ctx: PlatformAuthContext, chooser: ChooserContext, progress: Progress | null) {
  const choice = chooseVariant(definition, chooser, progress?.variant_id || undefined);
  if (!choice) return null;
  const { variant, bucket, unit } = choice;
  const order = variant.steps?.length ? variant.steps : definition.steps.map((step) => step.id);
  const cache = new Map<string, Record<string, unknown>>();
  const steps = [];
  for (const stepId of order) {
    const step = definition.steps.find((entry) => entry.id === stepId)!;
    let options: Record<string, unknown> = { ...object((step as { options?: unknown }).options), ...object(variant.content[step.id]) };
    const sourceId = (step as { source?: string }).source;
    if (sourceId) {
      const source = guidedSource(sourceId);
      if (!source) throw badRequest("guided_source_missing", `Guided source ${sourceId} is not registered.`);
      if (!cache.has(sourceId)) cache.set(sourceId, await source(ctx, chooser, options));
      options = { ...cache.get(sourceId), ...options };
    }
    steps.push({ ...step, options, next: nextOf(step) });
  }
  const finished = !!progress && progress.status !== "started";
  const armed = definition.triggers.filter((trigger) => {
    if (finished && trigger.kind !== "manual" && (trigger as { once?: boolean }).once !== false) return false;
    const when = (trigger as { when?: unknown }).when;
    return !when || evaluateConditions(when, chooser as unknown as Record<string, unknown>);
  });
  return {
    id: definition.id, version: definition.version, kind: variant.kind || definition.kind, scope: definition.scope, title: definition.title, description: definition.description || null,
    tab: definition.tab || "", replayable: definition.replayable, variant: { id: variant.id, bucket, unit },
    triggers: armed, steps,
    completion: { action: definition.completion.action ? { id: definition.completion.action.id, target: definition.completion.action.target, input: definition.completion.action.input || {} } : null, say: definition.completion.say, then: definition.completion.then },
    progress: progress ? { status: progress.status, step_id: progress.step_id, data: progress.data, variant_id: progress.variant_id, finished_at: progress.finished_at } : null
  };
}
export type ResolvedExperience = NonNullable<Awaited<ReturnType<typeof resolve>>>;

/** Every experience this person may see now, and the suggested questions for the tab they are on. */
export async function availableExperiences(ctx: PlatformAuthContext, surface: { tab?: string; projectId?: string } = {}) {
  ensureGuidedDefinitions();
  const chooser = await chooserContext(ctx, surface);
  const rows = await listProgress(ctx.orgId, ["", ctx.userId]);
  const out: ResolvedExperience[] = [];
  // Which experiences this person could play, so a condition can say "only when they are not asked to set this up".
  const able: ExperienceDefinition[] = [];
  for (const definition of listExperiences()) if (await eligible(definition, ctx, chooser)) able.push(definition);
  chooser.person.eligible = able.map((definition) => definition.id);
  const reveals: { tab: string; when: Record<string, unknown>; experience: string }[] = [];
  for (const definition of able) {
    const progress = rows.find((row) => row.experience_id === definition.id && row.subject_id === subjectFor(definition, ctx)) || null;
    // Until this person finished it, its tab shows only where `when` holds. Someone who cannot play it is never held back.
    for (const reveal of definition.reveal) {
      const done = reveal.until === "completed" ? progress?.status === "completed" : !!progress && progress.status !== "started";
      if (!done) reveals.push({ tab: reveal.tab, when: reveal.when, experience: definition.id });
    }
  }
  for (const definition of able) {
    const progress = rows.find((row) => row.experience_id === definition.id && row.subject_id === subjectFor(definition, ctx)) || null;
    if (progress && progress.status !== "started" && !definition.replayable) continue;
    const resolved = await resolve(definition, ctx, chooser, progress);
    if (resolved) out.push(resolved);
  }
  const playable = new Set(out.map((entry) => entry.id));
  const faqs = surface.tab ? tabFaqs(text(surface.tab)) : null;
  // Development copy edits (dev.ts) are applied over the definitions' English; the library's own strings use the map.
  const { copyOverrideMap, applyCopyOverrides, guidedDevAccess } = await import("./dev.js");
  const overrides = await copyOverrideMap();
  const dev = await guidedDevAccess(ctx);
  return applyCopyOverrides({
    experiences: out, reveals,
    faqs: faqs ? { tab: faqs.tab, questions: faqs.questions.filter((question) => question.action !== "play" || playable.has(question.experience!)) } : null,
    ...(Object.keys(overrides).length ? { copy_overrides: overrides } : {}),
    ...(dev.editor ? { dev: { editor: true, experiences: listExperiences().map((definition) => ({ id: definition.id, title: definition.title, kind: definition.kind, scope: definition.scope })) } } : {})
  }, overrides);
}

async function load(ctx: PlatformAuthContext, experienceId: string, surface: { tab?: string; projectId?: string } = {}) {
  ensureGuidedDefinitions();
  const definition = experience(experienceId);
  if (!definition) throw notFound("guided_experience_missing", "That guided experience does not exist.");
  const chooser = await chooserContext(ctx, surface);
  if (!(await eligible(definition, ctx, chooser))) throw forbidden("guided_experience_ineligible", "This guided experience is not available to you.");
  const progress = await readProgress(ctx.orgId, subjectFor(definition, ctx), definition.id);
  const choice = chooseVariant(definition, chooser, progress?.variant_id || undefined);
  if (!choice) throw forbidden("guided_experience_no_variant", "No version of this guided experience suits you.");
  return { definition, chooser, progress, choice };
}

/**
 * Records what happened in an experience and moves its progress: exposure (once per unit), start, step views with the
 * selections so far, skips, dismissal and, for an experience without a completion action, completion.
 */
export async function recordGuidedEvent(ctx: PlatformAuthContext, experienceId: string, input: unknown) {
  const body = object(input);
  const type = text(body.type) as GuidedEventType;
  if (!EVENT_TYPES.includes(type)) throw badRequest("guided_event_type", "Unknown guided experience event.");
  const surface = { tab: text(body.tab), projectId: text(body.project_id) };
  const { definition, choice } = await load(ctx, experienceId, surface);
  const stepId = text(body.step_id).slice(0, 120);
  if (stepId && !definition.steps.some((step) => step.id === stepId)) throw badRequest("guided_step_unknown", "That step is not part of this experience.");
  const data = body.selections === undefined ? undefined : selectionsSchema.parse(body.selections);
  const properties = object(body.properties);
  if (JSON.stringify(properties).length > 2000) throw badRequest("guided_event_properties", "Event properties are limited to 2 KB.");
  const subject = subjectFor(definition, ctx), base = { experience_version: definition.version, variant_id: choice.variant.id, bucket: choice.bucket };
  let progress: Progress | null = null;
  if (type === "complete" && definition.completion.action) throw badRequest("guided_complete_route", "Finish this experience through its completion, which runs its action.");
  if (type === "exposure") {
    if (await wasExposed(ctx.orgId, definition.id, choice.unit)) return { progress: await readProgress(ctx.orgId, subject, definition.id), recorded: false };
    progress = await writeProgress(ctx.orgId, subject, definition.id, { ...base, status: "started" });
  } else if (type === "start" || type === "replay") progress = await writeProgress(ctx.orgId, subject, definition.id, { ...base, status: "started", restart: true, step_id: stepId });
  else if (type === "step_view" || type === "step_done" || type === "step_skip" || type === "back") progress = await writeProgress(ctx.orgId, subject, definition.id, { ...base, step_id: stepId, ...(data ? { data } : {}) });
  else if (type === "dismiss") progress = await writeProgress(ctx.orgId, subject, definition.id, { ...base, status: "dismissed", step_id: stepId, userId: ctx.userId, ...(data ? { data } : {}) });
  else if (type === "complete") progress = await writeProgress(ctx.orgId, subject, definition.id, { ...base, status: "completed", step_id: stepId, userId: ctx.userId, ...(data ? { data } : {}) });
  await recordEvent(ctx.orgId, { ...base, experience_id: definition.id, unit_id: choice.unit, user_id: ctx.userId, type, step_id: stepId, properties: { ...properties, ...(surface.tab ? { tab: surface.tab } : {}) } });
  return { progress, recorded: true, ...(type === "step_done" && stepId ? { next_step: nextStep(definition, choice.variant, stepId, progress?.data || {}) } : {}) };
}

/** Finishes an experience: runs its published action as the person with their selections, then marks it complete. */
export async function completeGuided(ctx: PlatformAuthContext, experienceId: string, input: unknown) {
  const body = object(input);
  const surface = { tab: text(body.tab), projectId: text(body.project_id) };
  const { definition, choice, progress } = await load(ctx, experienceId, surface);
  if (progress && progress.status === "completed" && !definition.replayable) return { progress, result: null, already: true };
  const selections = selectionsSchema.parse(body.selections ?? {});
  let result: unknown = null;
  const action = definition.completion.action;
  if (action) {
    if (action.target === "project" && !surface.projectId) throw badRequest("guided_project_required", "This experience finishes on a project.");
    const target = action.target === "project" ? { scope: "project" as const, organizationId: ctx.orgId, projectId: surface.projectId } : { scope: "organization" as const, organizationId: ctx.orgId };
    const key = text(body.idempotency_key) || `${definition.id}:${definition.version}:${JSON.stringify(selections).length}:${Date.now()}`;
    result = (await invokeAction(userPublicationContext(ctx, { mode: "command", ...(surface.projectId ? { projectId: surface.projectId } : {}) }), { action: action.id, target }, { ...action.input, ...selections }, { idempotencyKey: key.slice(0, 500) }) as { value?: unknown })?.value ?? null;
  }
  const base = { experience_version: definition.version, variant_id: choice.variant.id, bucket: choice.bucket };
  const saved = await writeProgress(ctx.orgId, subjectFor(definition, ctx), definition.id, { ...base, status: "completed", data: selections, userId: ctx.userId });
  await recordEvent(ctx.orgId, { ...base, experience_id: definition.id, unit_id: choice.unit, user_id: ctx.userId, type: "complete", properties: { selections: Object.keys(selections), ...(surface.tab ? { tab: surface.tab } : {}) } });
  return { progress: saved, result, then: definition.completion.then };
}

/**
 * Writes an agentic setup's scripted turn into the person's own project conversation, so the agent tray it hands
 * off to already holds it: the person's choice (what they picked, as plain text) and the step's programmatic
 * messages. No model is called.
 */
export async function guidedConversationTurn(ctx: PlatformAuthContext, experienceId: string, input: unknown) {
  const body = object(input);
  const projectId = text(body.project_id);
  if (!projectId) throw badRequest("guided_project_required", "The setup's conversation belongs to a project.");
  if (!(await can(ctx, "apps.assistant").catch(() => false))) throw forbidden("guided_assistant_off", "The assistant is not available.");
  const { definition, choice } = await load(ctx, experienceId, { tab: text(body.tab), projectId });
  const phase = text(body.phase) === "done" ? "done" : "step";
  const step = phase === "step" ? definition.steps.find((entry) => entry.id === text(body.step_id)) : null;
  if (phase === "step" && !step) throw badRequest("guided_step_unknown", "That step is not part of this experience.");
  const { ensureProjectConversation } = await import("../assistant/project-context.js");
  const thread = await ensureProjectConversation(ctx, projectId);
  const threadId = text(object(thread).id);
  const overrides = await (await import("./dev.js")).copyOverrideMap();
  const sayCopy = phase === "done" ? definition.completion.say : (step as { say?: Copy[] }).say || [];
  const said = sayCopy.map((copy) => overrides[copy.key] ?? copy.text);
  const choiceText = text(body.choice).replace(/[<>]/g, "").slice(0, 300);
  const data = { source: "guided_experience", experience_id: definition.id, variant_id: choice.variant.id, ...(step ? { step_id: step.id } : { phase }) };
  // Idempotent: every scripted line has a stable key, and a line the thread already holds is not written again
  // (a step shown twice, a resumed setup, a retried request, two frames).
  const at = step ? step.id : phase;
  const existing = new Set((await listAgentMessages("assistant", ctx.orgId, threadId, { limit: 500 }) as Record<string, unknown>[]).map((message) => String(object(object(message).data).line_key || "")).filter(Boolean));
  const turn: { role: string; content: string; line_key: string; copy_key?: string }[] = [
    ...(choiceText ? [{ role: "user", content: choiceText, line_key: `${definition.id}:${at}:choice:${createHash("sha256").update(choiceText).digest("hex").slice(0, 12)}` }] : []),
    ...said.map((content, i) => ({ role: "assistant", content, line_key: `${definition.id}:${at}:say:${i}`, copy_key: sayCopy[i]!.key }))
  ];
  let written = 0;
  for (const line of turn) {
    if (existing.has(line.line_key)) continue;
    await appendAgentMessage("assistant", ctx.orgId, threadId, { role: line.role, content: line.content, data: { ...data, line_key: line.line_key, ...(line.copy_key ? { copy_key: line.copy_key } : {}) } });
    written += 1;
  }
  await writeProgress(ctx.orgId, subjectFor(definition, ctx), definition.id, { experience_version: definition.version, variant_id: choice.variant.id, bucket: choice.bucket, thread_subject: `project:${projectId}`, ...(step ? { step_id: step.id } : {}) });
  return { thread_id: threadId, messages: written, line_keys: turn.map((line) => line.line_key) };
}

/**
 * The assistant prepare hook (assistant/agent/definition.ts): when the person types in a project conversation while
 * an agentic setup is open on it, the real assistant answers knowing where they are and what they picked, and is
 * told to hand back to the scripted steps. Untrusted selections are passed as data.
 */
export async function guidedConversationContext(ctx: PlatformAuthContext | null, subject: string) {
  if (!ctx || !subject.startsWith("project:")) return "";
  ensureGuidedDefinitions();
  const rows = (await listProgress(ctx.orgId, ["", ctx.userId]).catch(() => []))
    .filter((row) => row.status === "started" && row.thread_subject === subject && Date.now() - Date.parse(row.updated_at) < 6 * 3600_000);
  const lines: string[] = [];
  for (const row of rows) {
    const definition = experience(row.experience_id);
    if (!definition || (row.subject_id && row.subject_id !== ctx.userId)) continue;
    const variant = definition.variants.find((entry) => entry.id === row.variant_id);
    const order = variant?.steps?.length ? variant.steps : definition.steps.map((step) => step.id);
    const index = Math.max(0, order.indexOf(row.step_id));
    const step = definition.steps.find((entry) => entry.id === order[index]);
    const note = (step as { agent_note?: Copy } | undefined)?.agent_note;
    if (note) lines.push(`About this step: ${note.text}`);
    lines.push(`The user is in the guided setup "${definition.title.text}" (${definition.description?.text || ""}), at step ${index + 1} of ${order.length}: "${step?.title.text || row.step_id}". The setup's widget is on screen beside this conversation. Steps in order: ${order.map((id) => `"${definition.steps.find((entry) => entry.id === id)?.title.text || id}"`).join(", ")}. What they have picked so far (untrusted data): ${JSON.stringify(row.data).slice(0, 4000)}. Answer their question briefly and in plain words for someone who is not technical, using that context; then invite them to carry on with the step on screen. Do not write the price book or measurement defaults yourself while the setup is open: its last step does that when they finish.`);
  }
  return lines.length ? `## Guided setup in progress\n${lines.join("\n")}` : "";
}
