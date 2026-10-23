import { createHash, randomBytes, randomUUID } from "node:crypto";

import { insightsDb } from "./store.js";

/**
 * Access keys for the session replay search tools (docs/architecture/session-replay-search.md, "Access for coding
 * agents"). A platform administrator creates one and gives it to a coding agent (Claude Code, Codex), which then calls
 * the tools over HTTP or MCP with `Authorization: Bearer <key>`. A key opens the search tools only: it cannot manage
 * keys, switch recording on or play recordings. Only a hash of the key is stored; the key is shown once.
 */
export const KEY_PREFIX = "fmrk_";
const DAY_MS = 86400000;
const num = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => String(value ?? "");
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export type AccessKey = {
  id: string;
  name: string;
  prefix: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  last_used_at: number;
  uses: number;
  revoked_at: number;
  revoked_by: string;
  active: boolean;
};

function fromRow(row: Record<string, unknown>): AccessKey {
  const expires = num(row.expires_at), revoked = num(row.revoked_at);
  return {
    id: text(row.id), name: text(row.name), prefix: text(row.prefix), created_by: text(row.created_by), created_at: num(row.created_at),
    expires_at: expires, last_used_at: num(row.last_used_at), uses: num(row.uses), revoked_at: revoked, revoked_by: text(row.revoked_by),
    active: !revoked && expires > Date.now()
  };
}

export async function createAccessKey(input: { name: string; createdBy: string; days?: number }) {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  const days = Math.min(365, Math.max(1, Math.round(input.days ?? 30)));
  const row = {
    id: "rk_" + randomUUID().replace(/-/g, "").slice(0, 16), name: input.name.slice(0, 120), prefix: key.slice(0, KEY_PREFIX.length + 6),
    created_by: input.createdBy, created_at: Date.now(), expires_at: Date.now() + days * DAY_MS
  };
  await insightsDb().prepare(`INSERT INTO replay_ix_access_keys (id, name, key_hash, prefix, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(row.id, row.name, hash(key), row.prefix, row.created_by, row.created_at, row.expires_at);
  return { key, ...fromRow({ ...row, last_used_at: 0, uses: 0, revoked_at: 0, revoked_by: "" }) };
}

export async function listAccessKeys() {
  const rows = await insightsDb().prepare("SELECT * FROM replay_ix_access_keys ORDER BY created_at DESC LIMIT 200").all();
  return rows.map(fromRow);
}

export async function revokeAccessKey(id: string, by: string) {
  const result = await insightsDb().prepare("UPDATE replay_ix_access_keys SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at=0").run(Date.now(), by, id);
  return result.changes > 0;
}

/** The key behind an Authorization header, if it is a live replay key. Use is recorded at most once a minute. */
export async function verifyAccessKey(key: string): Promise<AccessKey | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length < KEY_PREFIX.length + 40 || key.length > 200) return null;
  const db = insightsDb();
  const row = await db.prepare("SELECT * FROM replay_ix_access_keys WHERE key_hash=?").get(hash(key));
  if (!row) return null;
  const found = fromRow(row);
  if (!found.active) return null;
  if (Date.now() - found.last_used_at > 60000) {
    await db.prepare("UPDATE replay_ix_access_keys SET last_used_at=?, uses=uses+1 WHERE id=?").run(Date.now(), found.id);
  }
  return found;
}

export function bearerKey(header: unknown) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(text(header));
  return match && match[1]!.startsWith(KEY_PREFIX) ? match[1]! : "";
}
