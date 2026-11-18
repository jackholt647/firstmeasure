import fs from "node:fs";
import path from "node:path";

import type { PlatformAuthContext } from "../platform/auth.js";
import { notFound, forbidden } from "../platform/errors.js";
import { liveAssetsDir } from "../platform/live_assets.js";
import { readDocument, readOrganization, type JsonObject } from "../platform/storage.js";
import { guidedDevAccess, guidedDevEnvironment } from "../guided-experiences/dev.js";
import { listExperiences } from "../guided-experiences/registry.js";
import { ensureGuidedDefinitions } from "../guided-experiences/service.js";
import { listSetupSteps, setupStep, stepSatisfied, type SatisfactionCache } from "../guided-experiences/setup-steps.js";
import { listProgress, listStepEvents } from "../guided-experiences/store.js";
import { SETUP_STEP_EXPERIENCE_PREFIX } from "../guided-experiences/library-checks.js";
import { findInstanceByOrg } from "../signup-sandbox/service.js";
import { requireDevelopmentOrganization } from "./synthetic-data.js";

/**
 * The dev console (docs/architecture/dev-console.md): who sees the tray and which of its sections apply here.
 * The audience is the development tools audience as guided experiences decide it: development data environment
 * only, then a platform administrator or a sandbox organization's settings managers. Everyone else, and production
 * whoever asks, gets 404 or 403 and no tray.
 */
export async function devConsoleAccess(ctx: PlatformAuthContext) {
  const access = await guidedDevAccess(ctx);
  if (!access.editor) {
    if (!guidedDevEnvironment()) throw notFound("not_found", "Not found.");
    throw forbidden("dev_console_denied", "The dev console is for the development tools audience.");
  }
  const sandbox = await requireDevelopmentOrganization(ctx).then(() => true, () => false);
  const run = await findInstanceByOrg(String(ctx.orgId)).catch(() => null);
  const org = await readOrganization(ctx.orgId).catch(() => null) as JsonObject | null;
  return {
    ok: true,
    admin: access.admin,
    organization: { id: String(ctx.orgId), name: String(org?.name ?? ""), sandbox },
    sections: {
      setup: true,
      test_run: !!run,
      synthetic_data: sandbox,
      synthetic_leads: sandbox,
      software_layers: sandbox,
      guided: true,
      live: !!liveAssetsDir()
    }
  };
}

/**
 * What the live layer serves now (docs/architecture/live-layer.md), with the checkout that put each file there and
 * the recent retirements. Read from the receiver's manifest; nothing here writes.
 */
export async function devConsoleLive(ctx: PlatformAuthContext) {
  await devConsoleAccess(ctx);
  const dir = liveAssetsDir();
  let manifest: JsonObject = {};
  if (dir) { try { manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as JsonObject; } catch { manifest = {}; } }
  const files = Object.entries((manifest.files ?? {}) as Record<string, JsonObject>)
    .map(([file, entry]) => ({ path: file, sha: String(entry?.sha ?? ""), source: String(entry?.source ?? ""), at: Number(entry?.at) || null }));
  const retired = Object.entries((manifest.retired ?? {}) as Record<string, JsonObject>)
    .map(([file, entry]) => ({ path: file, reason: String(entry?.reason ?? ""), gen: Number(entry?.gen) || 0 }))
    .sort((a, b) => b.gen - a.gen)
    .slice(0, 20);
  return { ok: true, gen: Number(manifest.gen) || 0, at: String(manifest.at ?? ""), files, retired };
}

/**
 * The dev console's Setup section: every setup step (a question asked once) and every guided setup and tour, with how
 * far this organization (or, for a person's, the caller) got and where each was done. A step's answer is read as
 * setup steps read it (stepSatisfied); where it was answered, asked or skipped is the newest guided event that names
 * the step, so an answer saved by Settings, signup, an agent or an import has none. Reads only.
 */
export async function devConsoleSetup(ctx: PlatformAuthContext) {
  await devConsoleAccess(ctx);
  ensureGuidedDefinitions();
  const steps = listSetupSteps();
  const experiences = listExperiences();
  const titleOf = new Map(experiences.map((definition) => [definition.id, definition.title.text]));
  const people = new Map<string, Promise<string>>();
  const person = (userId: string) => {
    if (!userId) return Promise.resolve("");
    if (!people.has(userId)) people.set(userId, readDocument(ctx.orgId, "users", userId).then((doc) => {
      const user = (doc?.data || {}) as JsonObject;
      return String(user.name || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email || userId);
    }, () => userId));
    return people.get(userId)!;
  };
  const where = async (event: { experience_id: string; user_id: string; created_at: string } | undefined) => event ? {
    experience_id: event.experience_id,
    // A step played on its own (FirstMateGuides.require) is the derived setup_step.<id> experience.
    experience_title: event.experience_id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX) ? "" : titleOf.get(event.experience_id) || event.experience_id,
    on_its_own: event.experience_id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX),
    by: await person(event.user_id), at: event.created_at
  } : null;

  // Which setups ask each step: the ones that name it and, through it, what it requires.
  const askedBy = new Map<string, string[]>();
  for (const definition of experiences) {
    if (definition.id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX)) continue;
    const named = [...definition.requires, ...definition.steps.flatMap((step) => (step as { requires?: string[] }).requires || [])];
    const seen = new Set<string>();
    const walk = (stepId: string) => { if (seen.has(stepId)) return; seen.add(stepId); for (const next of setupStep(stepId)?.requires || []) walk(next); };
    named.forEach(walk);
    for (const stepId of seen) askedBy.set(stepId, [...(askedBy.get(stepId) || []), definition.title.text]);
  }

  const events = await listStepEvents(ctx.orgId, steps.map((step) => step.id));
  const { listSetupTests } = await import("./setup-tests.js");
  const tests = new Map((await listSetupTests(ctx.orgId)).map((test) => [test.step_id, test]));
  const cache: SatisfactionCache = new Map();
  const stepRows = [];
  for (const step of steps) {
    const mine = events.filter((event) => event.step_id === step.id && (step.scope === "organization" || event.user_id === ctx.userId));
    const answered = await stepSatisfied(ctx, step, cache);
    const latest = mine[0];
    const status = answered ? "done" : latest?.type === "step_skip" ? "skipped" : latest ? "started" : "not_started";
    stepRows.push({
      id: step.id, scope: step.scope, title: step.title.text, requires: [...step.requires], status,
      answered_in: await where(mine.find((event) => event.type === "step_done")),
      last: await where(latest), last_type: latest?.type || null,
      asked_by: askedBy.get(step.id) || [],
      test: tests.get(step.id) || null
    });
  }

  const progress = await listProgress(ctx.orgId, ["", ctx.userId]);
  const guideRows = [];
  for (const definition of experiences) {
    if (definition.id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX)) continue;
    const subject = definition.scope === "organization" ? "" : ctx.userId;
    const row = progress.find((entry) => entry.experience_id === definition.id && entry.subject_id === subject);
    const step = row?.step_id ? definition.steps.find((entry) => entry.id === row.step_id) : null;
    guideRows.push({
      id: definition.id, title: definition.title.text, kind: definition.kind, scope: definition.scope,
      group: definition.kind === "modal" || definition.kind === "agentic" ? "setup" : "tour",
      status: !row ? "not_started" : row.status === "completed" ? "done" : row.status === "dismissed" ? "skipped" : "started",
      step: row?.step_id ? { id: row.step_id, title: (step as { title?: { text?: string } } | null)?.title?.text || setupStep(row.step_id)?.title.text || row.step_id } : null,
      started_at: row?.started_at || null, updated_at: row?.updated_at || null, finished_at: row?.finished_at || null,
      finished_by: row?.finished_by ? await person(row.finished_by) : "",
      asks: [...new Set([...definition.requires, ...definition.steps.flatMap((entry) => (entry as { requires?: string[] }).requires || [])])].map((stepId) => setupStep(stepId)?.title.text || stepId)
    });
  }
  return { ok: true, steps: stepRows, guides: guideRows };
}

/** The Setup section's tests (development/setup-tests.ts): start one (play the step), end it, roll it back. */
export async function devConsoleSetupTest(ctx: PlatformAuthContext, stepId: string, what: "start" | "end" | "rollback") {
  await devConsoleAccess(ctx);
  const tests = await import("./setup-tests.js");
  const id = String(stepId || "").trim();
  return { ok: true, ...(what === "start" ? await tests.startSetupTest(ctx, id) : what === "end" ? await tests.endSetupTest(ctx, id) : await tests.rollbackSetupTest(ctx, id)) };
}
