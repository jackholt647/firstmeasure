import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { env } from "../src/config/env.js";
import { requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden, notFound, unauthorized } from "../platform/errors.js";
import { guidedDevAccess } from "../guided-experiences/dev.js";
import type { Author } from "./contracts.js";
import { libraryStore } from "./store.js";

/**
 * Who may edit the config library (docs/architecture/config-library.md, "Editing"): on the development data
 * environment only (everywhere else the routes answer 404, whoever asks), a signed-in platform administrator or the
 * development tools audience (a sandbox test organization's settings managers, as the dev console), or a coding agent
 * (Codex, Claude) holding an access key a platform administrator created. A key reaches library entries and assets
 * only: never keys, organizations or their copies.
 */

export const KEY_PREFIX = "fmck_";
const DAY_MS = 86400000;
const text = (value: unknown) => String(value ?? "").trim();
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export const libraryDevEnvironment = () => !env.isProduction && env.dataEnvironment === "development";
export function requireLibraryEnvironment() {
  if (!libraryDevEnvironment()) throw notFound("not_found", "Not found.");
}

export type LibraryCaller = { author: Author; ctx?: PlatformAuthContext; admin: boolean; key?: { id: string; name: string } };

/** A bearer key when one is sent (no CSRF: it is not a cookie), otherwise a signed-in editor. */
export async function requireLibraryEditor(request: FastifyRequest, options: { csrf?: boolean; orgId?: string; keys?: boolean } = {}): Promise<LibraryCaller> {
  requireLibraryEnvironment();
  if (request.headers.authorization && options.keys !== false) {
    const key = bearerKey(request.headers.authorization);
    const found = key ? await verifyAccessKey(key) : null;
    if (!found) throw unauthorized("invalid_library_key", "This config library access key is not valid, has expired or was revoked.");
    return { author: { kind: "agent", id: `key:${found.id} ${found.name}`.slice(0, 200) }, admin: false, key: { id: found.id, name: found.name } };
  }
  const ctx = await requirePlatformAuth(request, { csrf: !!options.csrf, ...(options.orgId ? { orgId: options.orgId } : {}) });
  const access = await guidedDevAccess(ctx);
  if (!access.editor) throw forbidden("config_library_denied", "The config library is edited by platform administrators and the development tools audience, in development.");
  return { author: { kind: "person", id: text(ctx.identity?.email) || ctx.userId }, ctx, admin: access.admin };
}
export async function requireLibraryAdmin(request: FastifyRequest, csrf = false) {
  const caller = await requireLibraryEditor(request, { csrf, keys: false });
  if (!caller.admin) throw forbidden("platform_admin_required", "Only platform administrators manage config library access keys.");
  return caller;
}

export async function createAccessKey(input: { name: string; createdBy: string; days?: number; createdAt?: number }) {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const days = Math.min(365, Math.max(1, Math.round(input.days ?? 30)));
  const createdAt = input.createdAt ?? Date.now();
  const row = { id: "ck_" + randomUUID().replace(/-/g, "").slice(0, 16), name: input.name.slice(0, 120), prefix: key.slice(0, KEY_PREFIX.length + 6), created_by: input.createdBy, created_at: createdAt, expires_at: createdAt + days * DAY_MS };
  await libraryStore().prepare("INSERT INTO config_library_keys (id, name, key_hash, prefix, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)")
    .run(row.id, row.name, hash(key), row.prefix, row.created_by, row.created_at, row.expires_at);
  return { key, ...keyFromRow({ ...row, last_used_at: 0, uses: 0, revoked_at: 0, revoked_by: "" }) };
}
function keyFromRow(row: Record<string, unknown>) {
  const expires = Number(row.expires_at || 0), revoked = Number(row.revoked_at || 0);
  return { id: text(row.id), name: text(row.name), prefix: text(row.prefix), created_by: text(row.created_by), created_at: Number(row.created_at || 0), expires_at: expires, last_used_at: Number(row.last_used_at || 0), uses: Number(row.uses || 0), revoked_at: revoked, revoked_by: text(row.revoked_by), active: !revoked && expires > Date.now() };
}
export async function listAccessKeys() {
  return (await libraryStore().prepare("SELECT * FROM config_library_keys ORDER BY created_at DESC LIMIT 200").all()).map(keyFromRow);
}
export async function revokeAccessKey(id: string, by: string) {
  return (await libraryStore().prepare("UPDATE config_library_keys SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at=0").run(Date.now(), by, id)).changes > 0;
}
export async function verifyAccessKey(key: string) {
  if (!key.startsWith(KEY_PREFIX) || key.length < KEY_PREFIX.length + 40 || key.length > 200) return null;
  const db = libraryStore();
  const row = await db.prepare("SELECT * FROM config_library_keys WHERE key_hash=?").get(hash(key));
  if (!row) return null;
  const found = keyFromRow(row);
  if (!found.active) return null;
  if (Date.now() - found.last_used_at > 60000) await db.prepare("UPDATE config_library_keys SET last_used_at=?, uses=uses+1 WHERE id=?").run(Date.now(), found.id);
  return found;
}
export function bearerKey(header: unknown) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(text(header));
  return match && match[1]!.startsWith(KEY_PREFIX) ? match[1]! : "";
}
