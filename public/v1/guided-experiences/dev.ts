import { z } from "zod";
import { env } from "../src/config/env.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { readOrganization, type JsonObject } from "../platform/storage.js";
import { readInternalUser } from "../internal/storage.js";
import { getAgentsDatabase } from "../agents/storage.js";
import type { Author } from "../config-library/contracts.js";
import { libraryCopy, libraryEntries, libraryEntry, libraryVersion, libraryWritable, refreshLibrary, startLibrarySync } from "../config-library/library.js";
import { experience } from "./registry.js";
import { unitIdFor } from "./chooser.js";
import { clearExposures, clearProgress, guidedStore } from "./store.js";
import { copyObjects, GUIDED_COPY_KIND, GUIDED_COPY_KINDS } from "./library-checks.js";

/**
 * Development tools for guided experiences (docs/architecture/guided-experiences.md, "Development"): reset an
 * experience so it plays as new, and edit its copy in place. Development data environment only; refused everywhere
 * else, production included, whoever asks.
 *
 * Copy is config library data. Editing a piece of copy in place saves a new revision of every library entry that
 * holds its `gx_` key (the experience, tab questions or setup step: the `{ key, text }` with that key gets the new
 * text); a string the browser libraries draw themselves is a `guided_copy` entry keyed by it. History is the library
 * revisions of that entry, and reverting saves an earlier revision's text as a new revision. Edits reach every dev
 * process within about a second and production with the next snapshot.
 */

const text = (value: unknown) => String(value ?? "").trim();
const gxKey = z.string().regex(/^gx_[a-z0-9_]{2,90}$/);

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
const authorOf = (ctx: PlatformAuthContext): Author => ({ kind: "person", id: text((ctx.identity as JsonObject | undefined)?.email) || ctx.userId });

/** The browser libraries' own strings as the library has them (`guided_copy`): key -> English. Read everywhere. */
let uiCopy: { version: number; map: Record<string, string> } | null = null;
export function libraryUiCopy(): Record<string, string> {
  const version = libraryVersion();
  if (uiCopy?.version !== version) uiCopy = { version, map: Object.fromEntries(libraryEntries<{ text: string }>(GUIDED_COPY_KIND).map((entry) => [entry.id, entry.data.text])) };
  return uiCopy.map;
}

/** The entries whose data holds this copy key, or, for a string of the browser libraries, its guided_copy entry. */
function holdersOf(key: string) {
  const holders = GUIDED_COPY_KINDS.flatMap((kind) => libraryEntries(kind).filter((entry) => copyObjects(entry.data).some((copy) => copy.key === key)).map((entry) => ({ kind: kind as string, id: entry.id })));
  return holders.length ? holders : [{ kind: GUIDED_COPY_KIND, id: key }];
}
const textIn = (data: unknown, key: string, kind: string) => (kind === GUIDED_COPY_KIND ? (data && typeof data === "object" ? text((data as { text?: unknown }).text) : "") : copyObjects(data).find((copy) => copy.key === key)?.text ?? "") || null;
function withText(data: unknown, key: string, value: string): unknown {
  if (Array.isArray(data)) return data.map((item) => withText(item, key, value));
  if (!data || typeof data !== "object") return data;
  const entry = data as Record<string, unknown>;
  if (entry.key === key && typeof entry.text === "string" && Object.keys(entry).length === 2) return { key, text: value };
  return Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, withText(child, key, value)]));
}

/** Sets one key's English in every entry that holds it, each as a new revision. Returns the first holder's revision. */
async function setCopyText(key: string, value: string, author: Author, note: string) {
  const { saveEntry } = await import("../config-library/writes.js");
  let revision = 0;
  for (const holder of holdersOf(key)) {
    const save = async () => {
      const current = libraryEntry(holder.kind, holder.id);
      const data = holder.kind === GUIDED_COPY_KIND ? { text: value } : withText(libraryCopy(holder.kind, holder.id), key, value);
      return saveEntry({ kind: holder.kind, id: holder.id, data, expected_revision: current?.revision ?? 0, note }, author);
    };
    // A save another process made a moment ago: read it and apply this edit to it.
    const saved = await save().catch(async (error) => { if ((error as { statusCode?: number }).statusCode !== 409) throw error; await refreshLibrary(); return save(); });
    revision ||= saved.entry.revision;
  }
  return { copy_key: key, text: value, revision };
}

const copyInput = z.object({
  key: gxKey,
  /** Plain text. Markup is refused, not stripped: what is saved is what was typed. */
  text: z.string().max(2000).refine((value) => !/[<>]/.test(value), "Copy is plain text."),
  experience_id: z.string().max(120).default(""), variant_id: z.string().max(120).default(""), step_id: z.string().max(120).default(""), field: z.string().max(60).default("")
}).strict();

export async function saveCopy(ctx: PlatformAuthContext, input: unknown) {
  await requireDev(ctx);
  const body = copyInput.parse(input);
  const value = body.text.replace(/\s+/g, " ").trim();
  if (!value) throw badRequest("guided_copy_empty", "Copy cannot be empty. Revert it instead.");
  const where = [body.experience_id, body.step_id, body.field].filter(Boolean).join(" / ");
  return setCopyText(body.key, value, authorOf(ctx), `Copy ${body.key} edited in place${where ? ` (${where})` : ""}.`);
}

/** Each revision of the entry holding this key in which its text changed, newest first. */
async function keyHistory(key: string) {
  const { listRevisions } = await import("../config-library/writes.js");
  const holder = holdersOf(key)[0]!;
  const revisions = await listRevisions(holder.kind, holder.id, { data: true });
  return { holder, history: revisions.flatMap((entry, index) => {
    const value = entry.data === null ? null : textIn(entry.data, key, holder.kind);
    const older = revisions[index + 1];
    if (older && (older.data === null ? null : textIn(older.data, key, holder.kind)) === value) return [];
    return [{ copy_key: key, text: value ?? "", action: entry.action, revision: entry.revision, author: entry.updated_by, created_at: entry.updated_at }];
  }) };
}
export async function copyFieldHistory(ctx: PlatformAuthContext, key: string) {
  await requireDev(ctx);
  return (await keyHistory(gxKey.parse(key))).history;
}
/**
 * Back to an earlier revision's text, saved as a new revision. Revision 0 is the first text the library had (as the
 * snapshot brought it); for a browser library string, its built-in text (the guided_copy entry is deleted).
 */
export async function revertCopy(ctx: PlatformAuthContext, input: unknown) {
  await requireDev(ctx);
  const body = z.object({ key: gxKey, revision: z.number().int().min(0) }).strict().parse(input);
  const author = authorOf(ctx);
  const { holder, history } = await keyHistory(body.key);
  if (body.revision === 0 && holder.kind === GUIDED_COPY_KIND) {
    if (libraryEntry(GUIDED_COPY_KIND, body.key)) await (await import("../config-library/writes.js")).deleteEntry({ kind: GUIDED_COPY_KIND, id: body.key, note: "Back to the library's built-in text." }, author);
    return { copy_key: body.key, text: null, revision: 0 };
  }
  const target = body.revision === 0 ? history.at(-1) : history.find((entry) => entry.revision === body.revision)
    ?? await (await import("../config-library/writes.js")).readRevision(holder.kind, holder.id, body.revision).then((revision) => ({ text: revision.data === null ? "" : textIn(revision.data, body.key, holder.kind) ?? "" })).catch(() => null);
  if (!target?.text) throw notFound("guided_copy_revision", "That revision does not exist.");
  return setCopyText(body.key, target.text, author, body.revision === 0 ? `Copy ${body.key} back to its first text.` : `Copy ${body.key} back to revision ${body.revision}.`);
}

/**
 * Moves copy edits made before copy was library data (the development `guided_copy` table) into the library, once,
 * then forgets them. Development only; a no-op where the table never existed.
 */
let imported: Promise<number> | undefined;
export function importLegacyCopyOverrides() {
  if (!guidedDevEnvironment() || !libraryWritable()) return Promise.resolve(0);
  return imported ??= (async () => {
    let rows: Record<string, unknown>[] = [];
    try { rows = await guidedStore().prepare("SELECT copy_key, text, updated_by FROM guided_copy ORDER BY copy_key").all(); } catch { return 0; }
    if (!rows.length) return 0;
    (await import("../config-library/kinds/index.js")).registerAllLibraryKinds();
    await startLibrarySync();
    let moved = 0;
    for (const row of rows) {
      const key = text(row.copy_key), value = text(row.text);
      if (!gxKey.safeParse(key).success || !value || /[<>]/.test(value)) continue;
      try {
        await setCopyText(key, value, { kind: "person", id: text(row.updated_by) || "guided-copy-import" }, "Imported from the development copy overrides.");
        await guidedStore().prepare("DELETE FROM guided_copy WHERE copy_key=?").run(key);
        moved += 1;
      } catch (error) { console.warn(`[guided-experiences] Copy ${key} was not moved into the library: ${(error as Error).message}`); }
    }
    return moved;
  })().catch((error) => { imported = undefined; console.warn(`[guided-experiences] Copy overrides were not imported: ${(error as Error).message}`); return 0; });
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
  if (body.scope === "organization") progress = Number((await guidedStore().prepare("DELETE FROM guided_progress WHERE organization_id=? AND experience_id=?").run(ctx.orgId, definition.id)).changes);
  else progress = Number(await clearProgress(ctx.orgId, definition.id, definition.scope === "organization" ? ["", ctx.userId] : [ctx.userId]));
  const context = { organization: { id: ctx.orgId } as never, person: { id: ctx.userId } as never };
  const units = body.scope === "organization" && definition.scope === "person"
    ? (await guidedStore().prepare("SELECT DISTINCT unit_id FROM guided_events WHERE organization_id=? AND experience_id=? AND type='exposure'").all(ctx.orgId, definition.id)).map((row) => String(row.unit_id))
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
