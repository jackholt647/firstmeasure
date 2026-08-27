import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";

import { env } from "../src/config/env.js";
import {
  bootstrapPostgresApplicationUser,
  isFirstMeasurePostgresEnabled,
  queryPostgres,
  withPostgresClient
} from "../src/database/postgres.js";

export type JsonObject = Record<string, unknown>;
export type InternalUser = JsonObject & {
  id: string;
  email: string;
  name: string;
  account_type: string;
  status: string;
  permissions: JsonObject;
  created_at: string;
  updated_at: string;
};

export type SaveInternalUserOptions = {
  changedBy?: string;
};

function normalizeInternalTeamId(value: unknown) {
  const teamId = String(value ?? "").trim();
  return teamId.toLowerCase() === "default" ? "" : teamId;
}

type UserIndexRow = {
  id: string;
  email: string;
  name: string;
  account_type: string;
  status: string;
  department: string;
  role: string;
  team_id: string;
  branch_id: string;
  queue_mode: string;
  training_complete: number;
  disabled: number;
  has_shift_schedule: number;
  updated_at: string;
  file_name: string;
  user_json: string;
};

let postgresUserIndexReadyPromise: Promise<void> | null = null;
const internalUserPatchLocks = new Map<string, Promise<void>>();

async function serializeInternalUserPatch<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeEmail(userId) || sanitizeId(userId, "user");
  const previous = internalUserPatchLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  internalUserPatchLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (internalUserPatchLocks.get(key) === tail) internalUserPatchLocks.delete(key);
  }
}

function storageRoot() {
  return path.resolve(process.cwd(), process.env.INTERNAL_STORAGE_ROOT ?? env.internalStorageRoot);
}

function usersRoot() {
  return path.join(storageRoot(), "users");
}

function userIndexPath() {
  return path.join(storageRoot(), "users.sqlite");
}

function collectionRoot(collection: string) {
  return path.join(storageRoot(), "state", sanitizeId(collection, "collection"));
}

function collectionDocumentPath(collection: string, documentId: string) {
  return path.join(collectionRoot(collection), `${sanitizeId(documentId, "document")}.json`);
}

function sanitizeId(value: unknown, fallback = "item") {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || `${fallback}_${randomBytes(6).toString("hex")}`;
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function userIdFromInput(input: JsonObject) {
  return sanitizeId(input.id || input.email || input.name, "user");
}

function userPath(userId: string) {
  return path.join(usersRoot(), `${sanitizeId(userId, "user")}.json`);
}

function userPathFromFileName(fileName: string) {
  return path.join(usersRoot(), fileName);
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function ensureInternalStorage() {
  await mkdir(usersRoot(), { recursive: true });
  await mkdir(path.join(storageRoot(), "state"), { recursive: true });
}

export function normalizeInternalUser(input: JsonObject = {}, existing: JsonObject = {}): InternalUser {
  const now = new Date().toISOString();
  const merged = { ...existing, ...input };
  const id = userIdFromInput(merged);
  const email = normalizeEmail(input.email ?? existing.email);
  delete merged.password;
  return {
    ...merged,
    id,
    email,
    name: String(input.name ?? existing.name ?? email),
    account_type: String(input.account_type ?? existing.account_type ?? "employee"),
    status: String(input.status ?? existing.status ?? "active"),
    department: String(input.department ?? existing.department ?? "production"),
    role: String(input.role ?? existing.role ?? "user"),
    team_id: normalizeInternalTeamId(input.team_id ?? input.team ?? existing.team_id ?? existing.team ?? ""),
    branch_id: String(input.branch_id ?? existing.branch_id ?? "default"),
    queue_mode: String(input.queue_mode ?? existing.queue_mode ?? "disabled"),
    complexity_preference: String(input.complexity_preference ?? existing.complexity_preference ?? "all"),
    drafter_rank: String(input.drafter_rank ?? existing.drafter_rank ?? "standard"),
    training_complete: Boolean(input.training_complete ?? existing.training_complete ?? false),
    is_qa_trainee: Boolean(input.is_qa_trainee ?? existing.is_qa_trainee ?? false),
    qa_fix_only_mode: Boolean(input.qa_fix_only_mode ?? existing.qa_fix_only_mode ?? false),
    shift_rate: Number(input.shift_rate ?? existing.shift_rate ?? 0) || 0,
    shift_schedule: asObject(input.shift_schedule ?? existing.shift_schedule),
    permissions: asObject(input.permissions ?? existing.permissions),
    integrations: asObject(input.integrations ?? existing.integrations),
    profile: asObject(input.profile ?? existing.profile),
    stats: asObject(input.stats ?? existing.stats),
    metadata: asObject(input.metadata ?? existing.metadata),
    created_at: String(existing.created_at ?? input.created_at ?? now),
    updated_at: now
  };
}

function hasShiftScheduleBlocks(user: JsonObject) {
  const schedule = asObject(user.shift_schedule);
  const recurring = asObject(schedule.recurring);
  if (Object.values(recurring).some((blocks) => Array.isArray(blocks) && blocks.length > 0)) return true;
  return Object.keys(asObject(schedule.overrides)).length > 0;
}

function getUserIndexDb() {
  mkdirSync(storageRoot(), { recursive: true });
  const db = new DatabaseSync(userIndexPath());
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS user_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users_index (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      status TEXT NOT NULL,
      department TEXT NOT NULL,
      role TEXT NOT NULL,
      team_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      queue_mode TEXT NOT NULL,
      training_complete INTEGER NOT NULL,
      disabled INTEGER NOT NULL,
      has_shift_schedule INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      file_name TEXT NOT NULL,
      user_json TEXT NOT NULL
    );
    DROP INDEX IF EXISTS users_index_email_idx;
    CREATE INDEX IF NOT EXISTS users_index_email_idx ON users_index(email);
    CREATE INDEX IF NOT EXISTS users_index_account_type_idx ON users_index(account_type);
    CREATE INDEX IF NOT EXISTS users_index_status_idx ON users_index(status);
    CREATE INDEX IF NOT EXISTS users_index_role_idx ON users_index(role);
    CREATE INDEX IF NOT EXISTS users_index_team_idx ON users_index(team_id);
    CREATE INDEX IF NOT EXISTS users_index_visible_team_idx
      ON users_index(account_type, status, training_complete, has_shift_schedule);
  `);
  return db;
}

function indexMeta(db: DatabaseSync, key: string) {
  return (db.prepare("SELECT value FROM user_index_meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value ?? "";
}

function setIndexMeta(db: DatabaseSync, key: string, value: string) {
  db.prepare(`
    INSERT INTO user_index_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function userIndexValues(user: InternalUser) {
  const fileName = `${sanitizeId(user.id, "user")}.json`;
  return {
    id: user.id,
    email: user.email,
    name: String(user.name || user.email || user.id),
    account_type: String(user.account_type || "employee").toLowerCase(),
    status: String(user.status || "active").toLowerCase(),
    department: String(user.department || "production").toLowerCase(),
    role: String(user.role || "user").toLowerCase(),
    team_id: normalizeInternalTeamId(user.team_id),
    branch_id: String(user.branch_id || "default"),
    queue_mode: String(user.queue_mode || "disabled").toLowerCase(),
    training_complete: user.training_complete ? 1 : 0,
    disabled: user.disabled === true ? 1 : 0,
    has_shift_schedule: hasShiftScheduleBlocks(user) ? 1 : 0,
    updated_at: String(user.updated_at || ""),
    file_name: fileName,
    user_json: JSON.stringify(user)
  };
}

function upsertUserIndexSync(db: DatabaseSync, user: InternalUser) {
  const row = userIndexValues(user);
  db.prepare(`
    INSERT INTO users_index (
      id, email, name, account_type, status, department, role, team_id, branch_id,
      queue_mode, training_complete, disabled, has_shift_schedule, updated_at, file_name, user_json
    )
    VALUES (
      @id, @email, @name, @account_type, @status, @department, @role, @team_id, @branch_id,
      @queue_mode, @training_complete, @disabled, @has_shift_schedule, @updated_at, @file_name, @user_json
    )
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      account_type = excluded.account_type,
      status = excluded.status,
      department = excluded.department,
      role = excluded.role,
      team_id = excluded.team_id,
      branch_id = excluded.branch_id,
      queue_mode = excluded.queue_mode,
      training_complete = excluded.training_complete,
      disabled = excluded.disabled,
      has_shift_schedule = excluded.has_shift_schedule,
      updated_at = excluded.updated_at,
      file_name = excluded.file_name,
      user_json = excluded.user_json
  `).run(row);
}

function userFromIndexRow(row: UserIndexRow) {
  try {
    const value = typeof row.user_json === "string" ? JSON.parse(row.user_json) : row.user_json;
    return normalizeInternalUser(value as JsonObject);
  } catch {
    return normalizeInternalUser({
      id: row.id,
      email: row.email,
      name: row.name,
      account_type: row.account_type,
      status: row.status,
      department: row.department,
      role: row.role,
      team_id: row.team_id,
      branch_id: row.branch_id,
      queue_mode: row.queue_mode,
      training_complete: Boolean(row.training_complete),
      disabled: Boolean(row.disabled),
      updated_at: row.updated_at
    });
  }
}

async function ensurePostgresUserIndex() {
  postgresUserIndexReadyPromise ??= initializePostgresUserIndex();
  await postgresUserIndexReadyPromise;
}

async function initializePostgresUserIndex() {
  await ensureInternalStorage();
  await bootstrapPostgresApplicationUser();
  await withPostgresClient(async (client) => {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["firstmeasure-internal-users-v1"]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS internal_users_index (
          id text PRIMARY KEY,
          email text NOT NULL,
          name text NOT NULL,
          account_type text NOT NULL,
          status text NOT NULL,
          department text NOT NULL,
          role text NOT NULL,
          team_id text NOT NULL,
          branch_id text NOT NULL,
          queue_mode text NOT NULL,
          training_complete integer NOT NULL DEFAULT 0,
          disabled integer NOT NULL DEFAULT 0,
          has_shift_schedule integer NOT NULL DEFAULT 0,
          updated_at text NOT NULL DEFAULT '',
          file_name text NOT NULL,
          user_json jsonb NOT NULL,
          updated_db_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS internal_storage_migrations (
          key text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS internal_documents (
          collection text NOT NULL,
          id text NOT NULL,
          document_json jsonb NOT NULL,
          revision integer NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS idx_internal_documents_updated
          ON internal_documents (collection, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_internal_users_email ON internal_users_index (email);
        CREATE INDEX IF NOT EXISTS idx_internal_users_account_type ON internal_users_index (account_type);
        CREATE INDEX IF NOT EXISTS idx_internal_users_status ON internal_users_index (status);
        CREATE INDEX IF NOT EXISTS idx_internal_users_role ON internal_users_index (role);
        CREATE INDEX IF NOT EXISTS idx_internal_users_team ON internal_users_index (team_id);
        CREATE INDEX IF NOT EXISTS idx_internal_users_visible_team
          ON internal_users_index (account_type, status, training_complete, has_shift_schedule);
      `);
      const migrated = await client.query<{ migrated: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM internal_storage_migrations WHERE key = 'users_json_import_v1') AS migrated"
      );
      if (!migrated.rows[0]?.migrated) {
        await rebuildPostgresUserIndexWithClient(client);
        await client.query(
          "INSERT INTO internal_storage_migrations (key) VALUES ('users_json_import_v1') ON CONFLICT (key) DO NOTHING"
        );
      }
      const documentsMigrated = await client.query<{ migrated: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM internal_storage_migrations WHERE key = 'documents_json_import_v1') AS migrated"
      );
      if (!documentsMigrated.rows[0]?.migrated) {
        await importPostgresInternalDocumentsWithClient(client);
        await client.query(
          "INSERT INTO internal_storage_migrations (key) VALUES ('documents_json_import_v1') ON CONFLICT (key) DO NOTHING"
        );
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["firstmeasure-internal-users-v1"]).catch(() => undefined);
    }
  });
}

async function importPostgresInternalDocumentsWithClient(client: import("pg").PoolClient) {
  const stateRoot = path.join(storageRoot(), "state");
  const collections = await readdir(stateRoot, { withFileTypes: true }).catch(() => []);
  for (const collectionEntry of collections) {
    if (!collectionEntry.isDirectory()) continue;
    const collection = sanitizeId(collectionEntry.name, "collection");
    const root = path.join(stateRoot, collectionEntry.name);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const document = asObject(await readJsonFile<JsonObject>(path.join(root, entry.name)));
        const id = sanitizeId(document.id ?? entry.name.replace(/\.json$/i, ""), "document");
        const createdAt = String(document.created_at ?? document.updated_at ?? new Date().toISOString());
        const updatedAt = String(document.updated_at ?? createdAt);
        await client.query(`
          INSERT INTO internal_documents (collection, id, document_json, revision, created_at, updated_at)
          VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::timestamptz)
          ON CONFLICT (collection, id) DO NOTHING
        `, [collection, id, JSON.stringify(document), Number(document.revision ?? 1) || 1, createdAt, updatedAt]);
      } catch {
        // Preserve readable documents and leave damaged legacy files untouched.
      }
    }
  }
}

async function rebuildPostgresUserIndexWithClient(client: import("pg").PoolClient) {
  const entries = await readdir(usersRoot(), { withFileTypes: true });
  const users: InternalUser[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      users.push(normalizeInternalUser(await readJsonFile<JsonObject>(path.join(usersRoot(), entry.name))));
    } catch {
      // Preserve the current behavior: one corrupt legacy record does not block all users.
    }
  }
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM internal_users_index");
    for (let index = 0; index < users.length; index += 500) {
      await upsertPostgresUsers(client, users.slice(index, index + 500));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return users.length;
}

async function upsertPostgresUsers(client: import("pg").PoolClient, users: InternalUser[]) {
  if (!users.length) return;
  const rows = users.map(userIndexValues);
  await client.query(`
    INSERT INTO internal_users_index (
      id, email, name, account_type, status, department, role, team_id, branch_id,
      queue_mode, training_complete, disabled, has_shift_schedule, updated_at, file_name, user_json
    )
    SELECT x.id, x.email, x.name, x.account_type, x.status, x.department, x.role, x.team_id, x.branch_id,
      x.queue_mode, x.training_complete, x.disabled, x.has_shift_schedule, x.updated_at, x.file_name, x.user_json
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, email text, name text, account_type text, status text, department text, role text, team_id text,
      branch_id text, queue_mode text, training_complete integer, disabled integer, has_shift_schedule integer,
      updated_at text, file_name text, user_json jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email, name = EXCLUDED.name, account_type = EXCLUDED.account_type,
      status = EXCLUDED.status, department = EXCLUDED.department, role = EXCLUDED.role,
      team_id = EXCLUDED.team_id, branch_id = EXCLUDED.branch_id, queue_mode = EXCLUDED.queue_mode,
      training_complete = EXCLUDED.training_complete, disabled = EXCLUDED.disabled,
      has_shift_schedule = EXCLUDED.has_shift_schedule, updated_at = EXCLUDED.updated_at,
      file_name = EXCLUDED.file_name, user_json = EXCLUDED.user_json, updated_db_at = now()
  `, [JSON.stringify(rows.map((row) => ({ ...row, user_json: JSON.parse(row.user_json) }))) ]);
}

async function upsertPostgresUser(user: InternalUser) {
  await ensurePostgresUserIndex();
  await withPostgresClient((client) => upsertPostgresUsers(client, [user]));
}

async function rebuildUserIndexFromJson(db: DatabaseSync) {
  await ensureInternalStorage();
  const entries = await readdir(usersRoot(), { withFileTypes: true });
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM users_index");
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const user = normalizeInternalUser(await readJsonFile<JsonObject>(path.join(usersRoot(), entry.name)));
        upsertUserIndexSync(db, user);
      } catch {
        // Keep rebuilding even if one legacy JSON record is corrupt.
      }
    }
    setIndexMeta(db, "schema_version", "1");
    setIndexMeta(db, "rebuilt_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function ensureUserIndex() {
  await ensureInternalStorage();
  const db = getUserIndexDb();
  if (indexMeta(db, "schema_version") !== "1") await rebuildUserIndexFromJson(db);
  return db;
}

export async function rebuildInternalUserIndex() {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const countResult = await queryPostgres<{ count: string }>("SELECT COUNT(*)::text AS count FROM internal_users_index");
    const count = Number(countResult.rows[0]?.count ?? 0);
    return {
      ok: true,
      success: true,
      count,
      rebuilt_at: new Date().toISOString(),
      path: "postgresql:internal_users_index"
    };
  }
  const db = getUserIndexDb();
  try {
    await rebuildUserIndexFromJson(db);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM users_index").get() as { n: number }).n;
    return {
      ok: true,
      success: true,
      count,
      rebuilt_at: indexMeta(db, "rebuilt_at"),
      path: userIndexPath()
    };
  } finally {
    db.close();
  }
}

export async function listInternalUsers(query: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) return listPostgresInternalUsers(query);
  const db = await ensureUserIndex();
  try {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    const accountType = String(query.account_type ?? "").trim().toLowerCase();
    const department = String(query.department ?? "").trim().toLowerCase();
    const teamId = String(query.team_id ?? query.team ?? "").trim().toLowerCase();
    const status = String(query.status ?? "").trim().toLowerCase();
    const role = String(query.role ?? "").trim().toLowerCase();
    const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
    if (accountType) {
      where.push("account_type = ?");
      params.push(accountType);
    }
    if (department) {
      where.push("department = ?");
      params.push(department);
    }
    if (teamId) {
      where.push("lower(team_id) = ?");
      params.push(teamId);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (role) {
      where.push("role = ?");
      params.push(role);
    }
    if (query.training_complete === true || query.training_complete === "1" || query.training_complete === "true") {
      where.push("training_complete = 1");
    }
    if (query.visible_team === true || query.visible_team === "1" || query.visible_team === "true") {
      where.push("disabled = 0");
      where.push("status <> 'disabled'");
      where.push("account_type <> 'customer'");
      where.push("(training_complete = 1 OR has_shift_schedule = 1)");
    }
    if (search) {
      where.push("(lower(name) LIKE ? OR lower(email) LIKE ? OR lower(team_id) LIKE ? OR lower(department) LIKE ?)");
      const like = `%${search.replace(/[%_]/g, "\\$&")}%`;
      params.push(like, like, like, like);
    }
    const sql = `
      SELECT * FROM users_index
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY name COLLATE NOCASE, email COLLATE NOCASE
    `;
    const rows = db.prepare(sql).all(...params) as UserIndexRow[];
    return rows.map(userFromIndexRow);
  } finally {
    db.close();
  }
}

async function listPostgresInternalUsers(query: JsonObject = {}) {
  await ensurePostgresUserIndex();
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    where.push(`${column} = $${values.length}`);
  };
  const accountType = String(query.account_type ?? "").trim().toLowerCase();
  const department = String(query.department ?? "").trim().toLowerCase();
  const teamId = String(query.team_id ?? query.team ?? "").trim().toLowerCase();
  const status = String(query.status ?? "").trim().toLowerCase();
  const role = String(query.role ?? "").trim().toLowerCase();
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  if (accountType) add("account_type", accountType);
  if (department) add("department", department);
  if (teamId) add("lower(team_id)", teamId);
  if (status) add("status", status);
  if (role) add("role", role);
  if (query.training_complete === true || query.training_complete === "1" || query.training_complete === "true") {
    where.push("training_complete = 1");
  }
  if (query.visible_team === true || query.visible_team === "1" || query.visible_team === "true") {
    where.push("disabled = 0", "status <> 'disabled'", "account_type <> 'customer'", "(training_complete = 1 OR has_shift_schedule = 1)");
  }
  if (search) {
    values.push(`%${search.replace(/[%_]/g, "\\$&")}%`);
    const parameter = `$${values.length}`;
    where.push(`(lower(name) LIKE ${parameter} ESCAPE '\\' OR lower(email) LIKE ${parameter} ESCAPE '\\'
      OR lower(team_id) LIKE ${parameter} ESCAPE '\\' OR lower(department) LIKE ${parameter} ESCAPE '\\')`);
  }
  const rows = await queryPostgres<UserIndexRow>(`
    SELECT * FROM internal_users_index
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY lower(name), lower(email)
  `, values);
  return rows.rows.map(userFromIndexRow);
}

export async function readInternalUser(userIdOrEmail: string) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const email = normalizeEmail(userIdOrEmail);
    const id = sanitizeId(userIdOrEmail, "user");
    const result = await queryPostgres<UserIndexRow>(
      "SELECT * FROM internal_users_index WHERE email = $1 OR id = $2 ORDER BY id LIMIT 1",
      [email, id]
    );
    if (result.rows[0]) return userFromIndexRow(result.rows[0]);
    return null;
  }
  await ensureInternalStorage();
  const directPath = userPath(userIdOrEmail);
  if (await pathExists(directPath)) {
    const user = normalizeInternalUser(await readJsonFile<JsonObject>(directPath));
    const db = await ensureUserIndex();
    try {
      upsertUserIndexSync(db, user);
    } finally {
      db.close();
    }
    return user;
  }
  const email = normalizeEmail(userIdOrEmail);
  const db = await ensureUserIndex();
  try {
    const row = db.prepare("SELECT * FROM users_index WHERE email = ? OR id = ? LIMIT 1")
      .get(email, sanitizeId(userIdOrEmail, "user")) as UserIndexRow | undefined;
    if (!row) return null;
    const filePath = userPathFromFileName(row.file_name);
    if (await pathExists(filePath)) {
      const user = normalizeInternalUser(await readJsonFile<JsonObject>(filePath));
      upsertUserIndexSync(db, user);
      return user;
    }
    return userFromIndexRow(row);
  } finally {
    db.close();
  }
}

export async function saveInternalUser(input: JsonObject = {}, options: SaveInternalUserOptions = {}) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    return withPostgresClient(async (client) => {
      await client.query("BEGIN");
      try {
        const requested = String(input.id || input.email || "");
        const email = normalizeEmail(requested);
        const id = sanitizeId(requested, "user");
        const result = await client.query<UserIndexRow>(
          "SELECT * FROM internal_users_index WHERE email = $1 OR id = $2 ORDER BY id LIMIT 1 FOR UPDATE",
          [email, id]
        );
        const existing = result.rows[0] ? userFromIndexRow(result.rows[0]) : null;
        if (!existing && !normalizeEmail(input.email)) throw new Error("internal_user_email_required");
        const user = normalizeInternalUser(input, existing ?? {});
        const previousTeamId = normalizeInternalTeamId(existing?.team_id);
        const nextTeamId = normalizeInternalTeamId(user.team_id);
        if (existing && previousTeamId !== nextTeamId) {
          const history = Array.isArray(existing.team_assignment_history)
            ? existing.team_assignment_history.filter((entry) => entry && typeof entry === "object").slice(-99)
            : [];
          user.team_assignment_history = [...history, {
            from_team_id: previousTeamId || null,
            to_team_id: nextTeamId || null,
            changed_at: new Date().toISOString(),
            changed_by: String(options.changedBy ?? "").trim().toLowerCase() || null
          }];
        }
        await upsertPostgresUsers(client, [user]);
        await client.query("COMMIT");
        return user;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }
  const existing = await readInternalUser(String(input.id || input.email || "")).catch(() => null);
  if (!existing && !normalizeEmail(input.email)) {
    throw new Error("internal_user_email_required");
  }
  const user = normalizeInternalUser(input, existing ?? {});
  const previousTeamId = normalizeInternalTeamId(existing?.team_id);
  const nextTeamId = normalizeInternalTeamId(user.team_id);
  if (existing && previousTeamId !== nextTeamId) {
    const history = Array.isArray(existing.team_assignment_history)
      ? existing.team_assignment_history.filter((entry) => entry && typeof entry === "object").slice(-99)
      : [];
    user.team_assignment_history = [
      ...history,
      {
        from_team_id: previousTeamId || null,
        to_team_id: nextTeamId || null,
        changed_at: new Date().toISOString(),
        changed_by: String(options.changedBy ?? "").trim().toLowerCase() || null
      }
    ];
  }
  await ensureInternalStorage();
  await writeJsonAtomic(userPath(user.id), user);
    const db = await ensureUserIndex();
    try {
      upsertUserIndexSync(db, user);
    } finally {
      db.close();
    }
  return user;
}

export async function patchInternalUser(userId: string, patch: JsonObject = {}) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const updated = await withPostgresClient(async (client) => {
      await client.query("BEGIN");
      try {
        const email = normalizeEmail(userId);
        const id = sanitizeId(userId, "user");
        const result = await client.query<UserIndexRow>(
          "SELECT * FROM internal_users_index WHERE email = $1 OR id = $2 ORDER BY id LIMIT 1 FOR UPDATE",
          [email, id]
        );
        if (!result.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const existing = userFromIndexRow(result.rows[0]);
        const user = normalizeInternalUser({ ...existing, ...patch, id: existing.id }, existing);
        const previousTeamId = normalizeInternalTeamId(existing.team_id);
        const nextTeamId = normalizeInternalTeamId(user.team_id);
        if (previousTeamId !== nextTeamId) {
          const history = Array.isArray(existing.team_assignment_history)
            ? existing.team_assignment_history.filter((entry) => entry && typeof entry === "object").slice(-99)
            : [];
          user.team_assignment_history = [
            ...history,
            {
              from_team_id: previousTeamId || null,
              to_team_id: nextTeamId || null,
              changed_at: new Date().toISOString(),
              changed_by: null
            }
          ];
        }
        await upsertPostgresUsers(client, [user]);
        await client.query("COMMIT");
        return user;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
    return updated;
  }

  return serializeInternalUserPatch(userId, async () => {
    const existing = await readInternalUser(userId);
    if (!existing) return null;
    return saveInternalUser({ ...existing, ...patch, id: existing.id });
  });
}

export async function deleteInternalUser(userId: string) {
  const existing = await readInternalUser(userId);
  if (!existing) return false;
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    await queryPostgres("DELETE FROM internal_users_index WHERE id = $1 OR email = $2", [existing.id, existing.email]);
    return true;
  }
  await rm(userPath(existing.id), { force: true });
  const db = await ensureUserIndex();
  try {
    db.prepare("DELETE FROM users_index WHERE id = ? OR email = ?").run(existing.id, existing.email);
  } finally {
    db.close();
  }
  return true;
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export async function listInternalDocuments(collection: string) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const normalizedCollection = sanitizeId(collection, "collection");
    const result = await queryPostgres<{ document_json: JsonObject }>(`
      SELECT document_json
      FROM internal_documents
      WHERE collection = $1
      ORDER BY updated_at DESC
    `, [normalizedCollection]);
    return result.rows.map((row) => asObject(row.document_json));
  }
  await ensureInternalStorage();
  const root = collectionRoot(collection);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const documents: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      documents.push(await readJsonFile<JsonObject>(path.join(root, entry.name)));
    } catch {
      // Ignore incomplete state files.
    }
  }
  return documents.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
}

export async function readInternalDocument(collection: string, documentId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const result = await queryPostgres<{ document_json: JsonObject }>(`
      SELECT document_json
      FROM internal_documents
      WHERE collection = $1 AND id = $2
    `, [sanitizeId(collection, "collection"), sanitizeId(documentId, "document")]);
    return result.rows[0] ? asObject(result.rows[0].document_json) : null;
  }
  await ensureInternalStorage();
  if (!(await pathExists(collectionDocumentPath(collection, documentId)))) return null;
  return await readJsonFile<JsonObject>(collectionDocumentPath(collection, documentId));
}

export async function saveInternalDocument(collection: string, documentId: string, input: JsonObject = {}, options: { replace?: boolean } = {}) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const normalizedCollection = sanitizeId(collection, "collection");
    const id = sanitizeId(documentId, "document");
    return withPostgresClient(async (client) => {
      await client.query("BEGIN");
      try {
        const current = await client.query<{ document_json: JsonObject }>(`
          SELECT document_json
          FROM internal_documents
          WHERE collection = $1 AND id = $2
          FOR UPDATE
        `, [normalizedCollection, id]);
        const existing = current.rows[0] ? asObject(current.rows[0].document_json) : null;
        const now = new Date().toISOString();
        const next = existing
          ? {
              ...existing,
              ...(options.replace ? input : { data: { ...asObject(existing.data), ...asObject(input.data ?? input) } }),
              id,
              collection: normalizedCollection,
              revision: Number(existing.revision ?? 0) + 1,
              updated_at: now
            }
          : {
              schema_version: 1,
              id,
              collection: normalizedCollection,
              data: asObject(input.data ?? input),
              metadata: asObject(input.metadata),
              revision: 1,
              created_at: now,
              updated_at: now
            };
        await client.query(`
          INSERT INTO internal_documents (collection, id, document_json, revision, created_at, updated_at)
          VALUES ($1, $2, $3::jsonb, $4, $5::timestamptz, $6::timestamptz)
          ON CONFLICT (collection, id) DO UPDATE SET
            document_json = EXCLUDED.document_json,
            revision = EXCLUDED.revision,
            updated_at = EXCLUDED.updated_at
        `, [normalizedCollection, id, JSON.stringify(next), next.revision, next.created_at, next.updated_at]);
        await client.query("COMMIT");
        return next;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }
  await ensureInternalStorage();
  const existing = await readInternalDocument(collection, documentId);
  const now = new Date().toISOString();
  const id = sanitizeId(documentId, "document");
  const next = existing
    ? {
        ...existing,
        ...(options.replace ? input : { data: { ...asObject(existing.data), ...asObject(input.data ?? input) } }),
        id,
        collection: sanitizeId(collection, "collection"),
        revision: Number(existing.revision ?? 0) + 1,
        updated_at: now
      }
    : {
        schema_version: 1,
        id,
        collection: sanitizeId(collection, "collection"),
        data: asObject(input.data ?? input),
        metadata: asObject(input.metadata),
        revision: 1,
        created_at: now,
        updated_at: now
      };
  await writeJsonAtomic(collectionDocumentPath(collection, id), next);
  return next;
}

export async function deleteInternalDocument(collection: string, documentId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    await ensurePostgresUserIndex();
    const result = await queryPostgres<{ document_json: JsonObject }>(`
      DELETE FROM internal_documents
      WHERE collection = $1 AND id = $2
      RETURNING document_json
    `, [sanitizeId(collection, "collection"), sanitizeId(documentId, "document")]);
    return result.rows[0] ? asObject(result.rows[0].document_json) : null;
  }
  const existing = await readInternalDocument(collection, documentId);
  if (!existing) return null;
  await rm(collectionDocumentPath(collection, documentId), { force: true });
  return existing;
}
