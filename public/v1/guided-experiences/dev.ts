import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../src/config/env.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { readOrganization, type JsonObject } from "../platform/storage.js";
import { readInternalUser } from "../internal/storage.js";
import { getAgentsDatabase } from "../agents/storage.js";
import { experience } from "./registry.js";
import { unitIdFor } from "./chooser.js";
import { clearExposures, clearProgress, copyHistory, listCopyOverrides, writeCopyOverride } from "./store.js";

/**
 * Development tools for guided experiences (docs/architecture/guided-experiences.md, "Development"): reset an
 * experience so it plays as new, and edit its copy in place. Development data environment only; refused everywhere
 * else, production included, whoever asks. Copy overrides are platform-wide (every organization) and English-only:
 * they replace a key's English text and are read only in development, until they are exported into the code.
 */

const text = (value: unknown) => String(value ?? "").trim();

export function guidedDevEnvironment() { return !env.isProduction && env.dataEnvironment === "development"; }

async function platformAdmin(ctx: PlatformAuthContext) {
  const email = text((ctx.identity as JsonObject | undefined)?.email).toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) as JsonObject | null : null;
  const permissions = (user?.permissions || {}) as JsonObject;
  return !!user && !user.disabled && user.status === "active" && (["admin", "system_admin"].includes(text(user.role).toLowerCase()) || user.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true);
}
/** The development tools audience: a sandbox test organization's settings managers (as the dev bar's tools). */
async function sandboxManager(ctx: PlatformAuthContext) {
  if (!hasPermission(ctx, "manage_company_settings")) return false;
  const org = await readOrganization(ctx.orgId).catch(() => null) as JsonObject | null;
  const meta = (org?.metadata || {}) as JsonObject;
  return meta.sandbox_test_org === true && !!text(meta.sandbox_instance_id);
}
/** Who may use the tools: development only, then a platform administrator or the development tools audience. */
export async function guidedDevAccess(ctx: PlatformAuthContext | null) {
  if (!ctx || !guidedDevEnvironment()) return { editor: false, admin: false };
  const admin = await platformAdmin(ctx);
  return { editor: admin || await sandboxManager(ctx), admin };
}
async function requireDev(ctx: PlatformAuthContext) {
  if (!guidedDevEnvironment()) throw notFound("not_found", "Not found.");
  const access = await guidedDevAccess(ctx);
  if (!access.editor) throw forbidden("guided_dev_denied", "Guided experience development tools are for platform administrators in development.");
  return access;
}

/** The copy overrides in force: development only. Elsewhere none, so production shows the code's copy. */
export async function copyOverrideMap(): Promise<Record<string, string>> {
  if (!guidedDevEnvironment()) return {};
  return Object.fromEntries((await listCopyOverrides()).map((row) => [row.copy_key, row.text]));
}
/** Replaces the English text of every `{ key, text }` copy object found in a value with its override. */
export function applyCopyOverrides<T>(value: T, overrides: Record<string, string>): T {
  if (!Object.keys(overrides).length) return value;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const entry = node as Record<string, unknown>;
    if (typeof entry.key === "string" && typeof entry.text === "string" && Object.keys(entry).length === 2) return overrides[entry.key] !== undefined ? { key: entry.key, text: overrides[entry.key] } : entry;
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, walk(child)]));
  };
  return walk(value) as T;
}

const copyInput = z.object({
  key: z.string().regex(/^gx_[a-z0-9_]{2,90}$/),
  /** Plain text. Markup is refused, not stripped: what is saved is what was typed. */
  text: z.string().max(2000).refine((value) => !/[<>]/.test(value), "Copy is plain text."),
  experience_id: z.string().max(120).default(""), variant_id: z.string().max(120).default(""), step_id: z.string().max(120).default(""), field: z.string().max(60).default("")
}).strict();

export async function saveCopy(ctx: PlatformAuthContext, input: unknown) {
  await requireDev(ctx);
  const body = copyInput.parse(input);
  const value = body.text.replace(/\s+/g, " ").trim();
  if (!value) throw badRequest("guided_copy_empty", "Copy cannot be empty. Revert it instead.");
  return writeCopyOverride({ copy_key: body.key, text: value, experience_id: body.experience_id, variant_id: body.variant_id, step_id: body.step_id, field: body.field, author: text((ctx.identity as JsonObject | undefined)?.email) || ctx.userId });
}
export async function copyFieldHistory(ctx: PlatformAuthContext, key: string) {
  await requireDev(ctx);
  return copyHistory(z.string().regex(/^gx_[a-z0-9_]{2,90}$/).parse(key));
}
/** Back to an earlier revision's text, or (revision 0) to the code's own copy. Recorded as a new revision. */
export async function revertCopy(ctx: PlatformAuthContext, input: unknown) {
  await requireDev(ctx);
  const body = z.object({ key: z.string().regex(/^gx_[a-z0-9_]{2,90}$/), revision: z.number().int().min(0) }).strict().parse(input);
  const author = text((ctx.identity as JsonObject | undefined)?.email) || ctx.userId;
  if (body.revision === 0) return writeCopyOverride({ copy_key: body.key, text: null, author, action: "revert" });
  const target = (await copyHistory(body.key)).find((entry) => entry.revision === body.revision);
  if (!target || target.action === "clear" || !target.text) throw notFound("guided_copy_revision", "That revision does not exist.");
  return writeCopyOverride({ copy_key: body.key, text: target.text, author, action: "revert" });
}

/**
 * Resets an experience so it plays as new: progress (which also lifts any reveal), the exposure that counted it,
 * and the scripted lines it wrote into conversations. `me` clears this person's (and, for an organization setup, the
 * organization's) progress; `organization` clears everyone's in the organization. Price book items a setup wrote stay.
 */
export async function resetExperience(ctx: PlatformAuthContext, input: unknown) {
  await requireDev(ctx);
  const body = z.object({ experience_id: z.string().max(120), scope: z.enum(["me", "organization"]).default("me") }).strict().parse(input);
  const definition = experience(body.experience_id);
  if (!definition) throw notFound("guided_experience_missing", "That guided experience does not exist.");
  let progress = 0;
  if (body.scope === "organization") progress = Number((await (await import("./store.js")).guidedStore().prepare("DELETE FROM guided_progress WHERE organization_id=? AND experience_id=?").run(ctx.orgId, definition.id)).changes);
  else progress = Number(await clearProgress(ctx.orgId, definition.id, definition.scope === "organization" ? ["", ctx.userId] : [ctx.userId]));
  const context = { organization: { id: ctx.orgId } as never, person: { id: ctx.userId } as never };
  const units = body.scope === "organization" && definition.scope === "person"
    ? (await (await import("./store.js")).guidedStore().prepare("SELECT DISTINCT unit_id FROM guided_events WHERE organization_id=? AND experience_id=? AND type='exposure'").all(ctx.orgId, definition.id)).map((row) => String(row.unit_id))
    : [unitIdFor(definition, context)];
  const exposures = Number(await clearExposures(ctx.orgId, definition.id, units));
  // Scripted lines carry `line_key` "<experience>:<step>:...": remove them so they are written again.
  const pattern = `%"line_key":"${definition.id}:%`;
  const db = getAgentsDatabase();
  const removed = body.scope === "organization"
    ? await db.prepare("DELETE FROM agent_messages WHERE organization_id=? AND agent_id='assistant' AND data_json LIKE ?").run(ctx.orgId, pattern)
    : await db.prepare("DELETE FROM agent_messages WHERE organization_id=? AND agent_id='assistant' AND data_json LIKE ? AND thread_id IN (SELECT id FROM agent_threads WHERE organization_id=? AND created_by_user_id=?)").run(ctx.orgId, pattern, ctx.orgId, ctx.userId);
  return { experience_id: definition.id, scope: body.scope, progress, exposures, conversation_lines: Number(removed.changes) };
}

/**
 * The overrides as a patch to the code, so the copy can be committed: each override beside the source line that
 * holds its key and current English (definitions/*.ts and the guided libraries), and the same text as catalog
 * entries for the `guided-experiences` namespace. `scripts/guided-copy-apply.mjs` applies the file edits.
 */
export async function exportCopy(ctx: PlatformAuthContext) {
  await requireDev(ctx);
  const overrides = await listCopyOverrides();
  const roots = [path.resolve(process.cwd(), "guided-experiences/definitions"), path.resolve(process.cwd(), "../libraries/guided-experiences")];
  const files = roots.filter((dir) => existsSync(dir)).flatMap((dir) => readdirSync(dir).filter((name) => /\.(ts|js)$/.test(name)).map((name) => path.join(dir, name)));
  const sources = files.map((file) => ({ file: path.relative(path.resolve(process.cwd(), "../.."), file).split(path.sep).join("/"), body: readFileSync(file, "utf8") }));
  const edits = overrides.map((row) => {
    const pattern = new RegExp(`(["'])${row.copy_key}\\1\\s*,\\s*(["'])((?:\\\\.|(?!\\2).)*)\\2`);
    for (const source of sources) {
      const match = pattern.exec(source.body);
      if (!match) continue;
      const quote = match[2]!;
      const literal = (value: string) => quote + value.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`) + quote;
      const from = match[0];
      return { key: row.copy_key, file: source.file, from, to: from.slice(0, from.length - match[3]!.length - 2) + literal(row.text), text: row.text, updated_by: row.updated_by, updated_at: row.updated_at };
    }
    return { key: row.copy_key, file: "", from: "", to: "", text: row.text, updated_by: row.updated_by, updated_at: row.updated_at };
  });
  return { edits, catalog: { "guided-experiences": Object.fromEntries(overrides.map((row) => [row.copy_key, row.text])) }, unmatched: edits.filter((edit) => !edit.file).map((edit) => edit.key) };
}
