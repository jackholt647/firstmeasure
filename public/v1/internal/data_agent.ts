import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { env } from "../src/config/env.js";
import { listOrganizations, readOrganization } from "../platform/storage.js";
import { asObject, deleteInternalDocument, listInternalDocuments, listInternalUsers, readInternalDocument, readInternalUser, saveInternalDocument } from "./storage.js";

type JsonObject = Record<string, unknown>;
type Actor = {
  email: string;
  name: string;
  role: string;
};
type DataAgentRun = JsonObject & {
  id: string;
  session_id: string;
  status: "queued" | "running" | "completed" | "error";
  events: Array<{ seq: number; event: string; data: JsonObject; created_at: string }>;
  last_event_seq: number;
};

const DATA_AGENT_COLLECTION = "data_agent";
const SESSIONS_COLLECTION = "data_agent_sessions";
const RUNS_COLLECTION = "data_agent_runs";
const DATA_AGENT_TIMEZONE = process.env.DATA_AGENT_TIMEZONE || "America/Los_Angeles";
const TECHNICIAN_TIMEZONE = "Asia/Manila";
const ACTIVE_RUNS = new Set<string>();

function nowIso() {
  return new Date().toISOString();
}

function newId(bytes = 16) {
  return randomBytes(bytes).toString("hex");
}

function sanitizeSessionId(value: unknown) {
  const id = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{24,64}$/.test(id) ? id : "";
}

function storageRoot() {
  return path.resolve(process.cwd(), process.env.INTERNAL_STORAGE_ROOT ?? env.internalStorageRoot);
}

function publicRoot() {
  return path.resolve(process.cwd(), "..");
}

function measureInternalRoot() {
  return path.join(publicRoot(), "measure", "internal");
}

function measureStorageRoot() {
  return path.join(measureInternalRoot(), "storage");
}

function firstMeasureStorageRoot() {
  return path.resolve(process.cwd(), "storage", "firstmeasure");
}

function asString(value: unknown) {
  return String(value ?? "");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeActor(input: JsonObject = {}): Actor {
  const actor = asObject(input.actor);
  return {
    email: asString(input.actor_email ?? input.user_email ?? input.email ?? actor.email).trim().toLowerCase(),
    name: asString(input.actor_name ?? input.user_name ?? input.name ?? actor.name),
    role: asString(input.actor_role ?? input.user_role ?? input.role ?? actor.role).trim().toLowerCase()
  };
}

function unwrapDocumentData(document: JsonObject | null | undefined): JsonObject {
  return asObject(document?.data ?? document);
}

function normalizeSessionDocument(document: JsonObject | null | undefined): JsonObject | null {
  if (!document) return null;
  const data = { ...unwrapDocumentData(document), ...document };
  delete data.data;
  return {
    ...data,
    id: asString(data.id ?? document.id),
    created_at: asString(data.created_at ?? document.created_at),
    updated_at: asString(data.updated_at ?? document.updated_at)
  };
}

function normalizeRunDocument(document: JsonObject | null | undefined): DataAgentRun | null {
  if (!document) return null;
  const data = { ...unwrapDocumentData(document), ...document };
  delete data.data;
  const events = asArray(data.events).filter((event): event is DataAgentRun["events"][number] => Boolean(event && typeof event === "object"))
    .map((event) => ({
      seq: clampInt(asObject(event).seq, 0, 0, 1000000),
      event: asString(asObject(event).event),
      data: asObject(asObject(event).data),
      created_at: asString(asObject(event).created_at)
    }));
  let status = ["queued", "running", "completed", "error"].includes(asString(data.status)) ? asString(data.status) as DataAgentRun["status"] : "queued";
  if (status === "queued" || status === "running") {
    if (data.completed_at || data.assistant_message || events.some((event) => event.event === "done" || event.event === "assistant_message")) status = "completed";
    if (data.error || events.some((event) => event.event === "error")) status = "error";
  }
  return {
    ...data,
    id: asString(data.id ?? document.id),
    session_id: asString(data.session_id),
    status,
    events,
    last_event_seq: clampInt(data.last_event_seq, events.length, 0, 1000000)
  };
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonObject(filePath: string): Promise<JsonObject | null> {
  try {
    const parsed = await readJson(filePath);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${newId(4)}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function listJsonFiles(root: string, limit = 500) {
  const rows: string[] = [];
  async function walk(dir: string) {
    if (rows.length >= limit || !(await pathExists(dir))) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (rows.length >= limit) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(".")) rows.push(full);
    }
  }
  await walk(root);
  return rows;
}

async function currentUser(actor: Actor) {
  if (!actor.email) return null;
  return await readInternalUser(actor.email);
}

async function currentUserIsAdmin(actor: Actor) {
  const user = await currentUser(actor);
  const permissions = asObject(user?.permissions);
  return actor.role === "admin" || asString(user?.role).toLowerCase() === "admin" || Boolean(user?.is_admin || permissions.is_admin_legacy);
}

async function canUseDataAgent(actor: Actor) {
  if (!actor.email) return false;
  const user = await currentUser(actor);
  if (!user) return actor.role === "admin";
  if (asString(user.account_type) === "customer") return false;
  const permissions = asObject(user.permissions);
  return actor.role === "admin" || asString(user.role).toLowerCase() === "admin" || Boolean(user.is_admin || permissions.is_admin_legacy);
}

async function requireDataAgent(actor: Actor) {
  if (!(await canUseDataAgent(actor))) {
    const error = new Error("Not authorized for the data agent.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
}

async function saveSession(session: JsonObject) {
  const id = sanitizeSessionId(session.id);
  if (!id) throw new Error("Invalid session id.");
  const next = { ...session, id, updated_at: nowIso() };
  const document = await saveInternalDocument(SESSIONS_COLLECTION, id, { ...next, data: next }, { replace: true });
  return normalizeSessionDocument(document) ?? next;
}

async function readSession(id: string) {
  return normalizeSessionDocument(await readInternalDocument(SESSIONS_COLLECTION, id));
}

async function deleteSession(id: string) {
  const document = await readInternalDocument(SESSIONS_COLLECTION, id);
  if (!document) return null;
  await deleteInternalDocument(SESSIONS_COLLECTION, id);
  return normalizeSessionDocument(document);
}

async function canAccessSession(session: JsonObject | null, actor: Actor) {
  if (!session) return false;
  if (asString(session.created_by_email).toLowerCase() === actor.email && actor.email) return true;
  return await currentUserIsAdmin(actor);
}

async function createSession(actor: Actor, title = "New data chat", persist = true) {
  const session: JsonObject = {
    id: newId(16),
    title,
    created_at: nowIso(),
    updated_at: nowIso(),
    created_by_email: actor.email,
    created_by_name: actor.name,
    messages: []
  };
  return persist ? await saveSession(session) : session;
}

async function listSessions(actor: Actor) {
  const isAdmin = await currentUserIsAdmin(actor);
  const sessions: JsonObject[] = [];
  for (const document of await listInternalDocuments(SESSIONS_COLLECTION)) {
    const session = normalizeSessionDocument(document);
    if (!session) continue;
    const messages = asArray(session.messages);
    if (!messages.length) continue;
    if (!isAdmin && asString(session.created_by_email).toLowerCase() !== actor.email) continue;
    const last = asObject(messages[messages.length - 1]);
    sessions.push({
      id: session.id,
      title: session.title || "Data chat",
      updated_at: session.updated_at,
      created_at: session.created_at,
      created_by_email: session.created_by_email,
      created_by_name: session.created_by_name,
      message_count: messages.length,
      last_preview: asString(last.content).trim().slice(0, 160)
    });
  }
  return sessions.sort((a, b) => asString(b.updated_at).localeCompare(asString(a.updated_at)));
}

async function saveRun(run: DataAgentRun) {
  const next = { ...run, updated_at: nowIso() };
  const document = await saveInternalDocument(RUNS_COLLECTION, run.id, { ...next, data: next }, { replace: true });
  return normalizeRunDocument(document) ?? run;
}

async function readRun(id: string) {
  return normalizeRunDocument(await readInternalDocument(RUNS_COLLECTION, id));
}

async function appendRunEvent(runId: string, event: string, data: JsonObject = {}) {
  const run = await readRun(runId);
  if (!run) return null;
  const seq = clampInt(run.last_event_seq, run.events.length, 0, 1000000) + 1;
  run.events.push({ seq, event, data, created_at: nowIso() });
  if (run.events.length > 500) run.events = run.events.slice(-500);
  run.last_event_seq = seq;
  return await saveRun(run);
}

async function latestActiveRunForSession(sessionId: string, actor: Actor) {
  let latest: DataAgentRun | null = null;
  for (const document of await listInternalDocuments(RUNS_COLLECTION)) {
    const run = normalizeRunDocument(document);
    if (!run || run.session_id !== sessionId || !["queued", "running"].includes(run.status)) continue;
    if (asString(run.created_by_email).toLowerCase() !== actor.email && !(await currentUserIsAdmin(actor))) continue;
    if (!latest || asString(run.updated_at).localeCompare(asString(latest.updated_at)) > 0) latest = run;
  }
  return latest ? { id: latest.id, session_id: latest.session_id, status: latest.status, last_event_seq: latest.last_event_seq, updated_at: latest.updated_at } : null;
}

async function defaultSettings() {
  return {
    system_prompt: await coreSystemInstructions(),
    custom_context: "",
    updated_at: "",
    updated_by_email: "",
    updated_by_name: ""
  };
}

async function loadSettings() {
  const document = await readInternalDocument(DATA_AGENT_COLLECTION, "settings");
  const settings = { ...(await defaultSettings()), ...unwrapDocumentData(document) };
  if (!asString(settings.system_prompt).trim()) settings.system_prompt = await coreSystemInstructions();
  return settings;
}

async function saveSettings(input: JsonObject, actor: Actor) {
  let prompt = asString(input.system_prompt).trim() || await coreSystemInstructions();
  if (prompt.length > 30000) prompt = prompt.slice(0, 30000);
  const settings = {
    ...(await loadSettings()),
    ...input,
    system_prompt: prompt,
    custom_context: "",
    updated_at: nowIso(),
    updated_by_email: actor.email,
    updated_by_name: actor.name
  };
  const document = await saveInternalDocument(DATA_AGENT_COLLECTION, "settings", settings, { replace: true });
  return unwrapDocumentData(document);
}

async function getServerConfigValue(key: string) {
  const document = await readInternalDocument("server_config", key);
  const data = unwrapDocumentData(document);
  return asString(data.value ?? data[key] ?? "");
}

async function openAiApiKey() {
  for (const value of [
    process.env.OPENAI_API_KEY,
    await getServerConfigValue("data_agent_openai_api_key"),
    await getServerConfigValue("openai_api_key"),
    await getServerConfigValue("OPENAI_API_KEY")
  ]) {
    const key = asString(value).trim();
    if (key) return key;
  }
  return "";
}

async function modelCandidates() {
  const candidates = [
    await getServerConfigValue("data_agent_openai_model"),
    process.env.DATA_AGENT_OPENAI_MODEL,
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.1",
    "gpt-5",
    "gpt-4.1"
  ].map((value) => asString(value).trim()).filter(Boolean);
  return [...new Set(candidates)];
}

async function titleModelCandidates() {
  const candidates = [
    await getServerConfigValue("data_agent_title_model"),
    process.env.DATA_AGENT_TITLE_MODEL,
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-5.4"
  ].map((value) => asString(value).trim()).filter(Boolean);
  return [...new Set(candidates)];
}

async function openAiRequest(payload: JsonObject, apiKey: string, timeoutMs = 90000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let json: JsonObject | null = null;
    try {
      const parsed = text ? JSON.parse(text) : null;
      json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
    } catch {
      json = null;
    }
    return { ok: response.ok && Boolean(json), status: response.status, json, raw: text, error: response.ok ? "" : response.statusText };
  } catch (error) {
    return { ok: false, status: 0, json: null, raw: "", error: error instanceof Error ? error.message : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function responseText(response: JsonObject | null) {
  if (!response) return "";
  if (typeof response.output_text === "string") return response.output_text.trim();
  const parts: string[] = [];
  for (const item of asArray(response.output)) {
    const object = asObject(item);
    if (object.type !== "message") continue;
    for (const content of asArray(object.content)) {
      const c = asObject(content);
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function functionCalls(response: JsonObject | null) {
  return asArray(response?.output).map((item) => asObject(item)).filter((item) => item.type === "function_call");
}

function dbMap() {
  return {
    projects: path.join(process.cwd(), "storage", "firstmeasure", "projects_index.sqlite"),
    leads: path.join(process.cwd(), "storage", "crm", "databases", "leads.sqlite"),
    commissions: path.join(process.cwd(), "storage", "crm", "databases", "commissions.sqlite"),
    referrals: path.join(process.cwd(), "storage", "crm", "databases", "referrals.sqlite"),
    legacy_projects: path.join(measureStorageRoot(), "databases", "pj_idx.sqlite")
  };
}

function openDb(database: string) {
  const map = dbMap();
  const key = database.toLowerCase() as keyof ReturnType<typeof dbMap>;
  const dbPath = map[key];
  if (!dbPath) throw new Error(`Unknown database: ${database}`);
  return new DatabaseSync(dbPath, { readOnly: true });
}

function databaseSchema(database = "") {
  const output: JsonObject = {};
  for (const [name, dbPath] of Object.entries(dbMap())) {
    if (database && database !== name) continue;
    if (!DatabaseSync || !dbPath) {
      output[name] = { path: dbPath, exists: false, tables: [] };
      continue;
    }
    try {
      const db = openDb(name);
      const tables = db.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as JsonObject[];
      output[name] = {
        path: dbPath,
        exists: true,
        tables: tables.map((table) => {
          const tableName = asString(table.name);
          const columns = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, "\"\"")}")`).all() as JsonObject[];
          let rowCount: number | null = null;
          try {
            rowCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM "${tableName.replace(/"/g, "\"\"")}"`).get() as JsonObject | undefined)?.count ?? 0);
          } catch {
            rowCount = null;
          }
          return { name: tableName, type: table.type, row_count: rowCount, columns };
        })
      };
      db.close();
    } catch {
      output[name] = { path: dbPath, exists: false, tables: [] };
    }
  }
  return output;
}

function bindParams(statement: ReturnType<DatabaseSync["prepare"]>, params: JsonObject = {}) {
  const bound: JsonObject = {};
  for (const [key, value] of Object.entries(params)) {
    const bindKey = key.startsWith(":") || key.startsWith("@") || key.startsWith("$") ? key : `:${key}`;
    bound[bindKey] = value;
  }
  return statement.all(bound as any) as JsonObject[];
}

function runReadonlySql(args: JsonObject) {
  const database = asString(args.database || "projects").toLowerCase();
  let sql = asString(args.sql).trim();
  const limit = clampInt(args.limit, 200, 1, 500);
  if (!sql) throw new Error("SQL is required.");
  if (sql.includes(";")) throw new Error("Only one read-only statement is allowed; omit semicolons.");
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("Only SELECT or WITH queries are allowed.");
  if (/\b(insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex|pragma|truncate)\b/i.test(sql)) {
    throw new Error("This query contains a disallowed write or database-control keyword.");
  }
  if (!/\blimit\s+\d+/i.test(sql)) sql += ` LIMIT ${limit}`;
  const started = Date.now();
  const db = openDb(database);
  try {
    const rows = bindParams(db.prepare(sql), asObject(args.params)).slice(0, limit);
    return { database, sql, row_count: rows.length, limit, duration_ms: Date.now() - started, polled_at: nowIso(), rows };
  } finally {
    db.close();
  }
}

function projectWhere(filtersInput: unknown) {
  const filters = asObject(filtersInput);
  const where = ["1=1"];
  const params: JsonObject = {};
  for (const field of ["status", "project_type", "team_id", "organization_id", "owner_email", "assigned_to_email", "qa_claimed_by_email"]) {
    const value = filters[field];
    if (value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      const keys = value.map((item, index) => {
        const key = `:${field}${index}`;
        params[key] = item;
        return key;
      });
      if (keys.length) where.push(`${field} IN (${keys.join(",")})`);
    } else {
      params[`:${field}`] = value;
      where.push(`${field} = :${field}`);
    }
  }
  if (filters.technician) {
    params[":technician"] = `%${asString(filters.technician).toLowerCase()}%`;
    where.push("(lower(assigned_to_name) LIKE :technician OR lower(assigned_to_email) LIKE :technician OR lower(qa_claimed_by_name) LIKE :technician OR lower(qa_claimed_by_email) LIKE :technician)");
  }
  if (filters.search) {
    params[":search"] = `%${asString(filters.search).toLowerCase()}%`;
    where.push("lower(search_text) LIKE :search");
  }
  const dateField = ["created_at_ms", "queued_at_ms", "started_at_ms", "uploaded_at_ms", "completed_at_ms", "rejected_at_ms", "cancelled_at_ms", "updated_at_ms"]
    .includes(asString(filters.date_field)) ? asString(filters.date_field) : "completed_at_ms";
  for (const [key, op] of [["start", ">="], ["end", "<="]] as const) {
    if (!filters[key]) continue;
    const time = Date.parse(asString(filters[key]));
    if (!Number.isNaN(time)) {
      params[`:${key}_ms`] = time;
      where.push(`${dateField} ${op} :${key}_ms`);
    }
  }
  for (const field of ["is_filler", "is_vip", "is_expedited"]) {
    if (!(field in filters)) continue;
    params[`:${field}`] = filters[field] ? 1 : 0;
    where.push(`${field} = :${field}`);
  }
  return { where: where.join(" AND "), params };
}

function searchProjects(args: JsonObject) {
  const { where, params } = projectWhere(args.filters ?? args);
  const limit = clampInt(args.limit, 50, 1, 200);
  params[":limit"] = limit;
  return runReadonlySql({
    database: "projects",
    sql: `SELECT id,status,project_type,address,owner_name,owner_email,issuer_name,issuer_email,organization_id,team_id,assigned_to_name,assigned_to_email,qa_claimed_by_name,qa_claimed_by_email,complexity,amount_charged,is_filler,is_vip,is_expedited,created_at,queued_at,started_at,uploaded_at,completed_at,updated_at,has_report_pdf,has_summary_pdf FROM projects WHERE ${where} ORDER BY sort_ts DESC, updated_at_ms DESC LIMIT :limit`,
    params,
    limit
  });
}

function projectStats(args: JsonObject) {
  const { where, params } = projectWhere(args.filters);
  const groupMap: Record<string, string> = {
    status: "status",
    project_type: "project_type",
    technician: "COALESCE(NULLIF(assigned_to_name,''), NULLIF(assigned_to_email,''), 'Unassigned')",
    qa_technician: "COALESCE(NULLIF(qa_claimed_by_name,''), NULLIF(qa_claimed_by_email,''), 'Unclaimed')",
    owner_email: "owner_email",
    team_id: "team_id",
    organization_id: "organization_id",
    day_completed: "substr(completed_at,1,10)",
    day_created: "substr(created_at,1,10)",
    complexity: "COALESCE(NULLIF(complexity,''), 'unknown')"
  };
  const groups = (Array.isArray(args.group_by) ? args.group_by : [args.group_by || "project_type"]).slice(0, 3).map(String).filter((group) => groupMap[group]);
  const selects = groups.length ? groups.map((group, index) => `${groupMap[group]} AS group_${index + 1}`) : ["'all' AS group_1"];
  const groupSql = selects.map((_select, index) => `group_${index + 1}`).join(", ");
  const result = runReadonlySql({
    database: "projects",
    sql: `SELECT ${selects.join(", ")}, COUNT(*) AS report_count, SUM(CASE WHEN project_type='commercial' THEN 1 ELSE 0 END) AS commercial_count, SUM(CASE WHEN project_type='multifamily' THEN 1 ELSE 0 END) AS multifamily_count, SUM(CASE WHEN project_type='residential' THEN 1 ELSE 0 END) AS residential_count, ROUND(AVG(amount_charged),2) AS avg_amount_charged, ROUND(SUM(amount_charged),2) AS total_amount_charged FROM projects WHERE ${where} GROUP BY ${groupSql} ORDER BY report_count DESC LIMIT 200`,
    params,
    limit: 200
  });
  const rows = asArray(result.rows).map((row) => asObject(row));
  const total = rows.reduce((sum, row) => sum + Number(row.report_count || 0), 0);
  return {
    ...result,
    total_count: total,
    rows: rows.map((row) => ({
      ...row,
      share_pct: total ? Math.round((Number(row.report_count || 0) / total) * 10000) / 100 : 0,
      commercial_share_pct: Number(row.report_count) ? Math.round((Number(row.commercial_count || 0) / Number(row.report_count)) * 10000) / 100 : 0
    }))
  };
}

async function safeUser(user: JsonObject) {
  return {
    id: user.id ?? "",
    email: asString(user.email).toLowerCase(),
    name: asString(user.name),
    role: asString(user.role),
    department: asString(user.department),
    team_id: asString(user.team_id),
    account_type: asString(user.account_type),
    organization_id: asString(user.organization_id),
    training_complete: Boolean(user.training_complete),
    queue_mode: asString(user.queue_mode),
    shift_rate: user.shift_rate ?? null,
    last_activity_at: user.last_activity_at ?? null,
    permissions: asObject(user.permissions)
  };
}

async function searchUsers(args: JsonObject) {
  const query = asString(args.query).toLowerCase();
  const role = asString(args.role).toLowerCase();
  const department = asString(args.department).toLowerCase();
  const team = asString(args.team_id).toLowerCase();
  const limit = clampInt(args.limit, 50, 1, 200);
  const rows = [];
  for (const user of await listInternalUsers()) {
    const safe = await safeUser(user);
    const hay = [safe.email, safe.name, safe.role, safe.department, safe.team_id].join(" ").toLowerCase();
    if (query && !hay.includes(query)) continue;
    if (role && safe.role.toLowerCase() !== role) continue;
    if (department && safe.department.toLowerCase() !== department) continue;
    if (team && safe.team_id.toLowerCase() !== team) continue;
    rows.push(safe);
    if (rows.length >= limit) break;
  }
  return { row_count: rows.length, rows, polled_at: nowIso() };
}

function orgSummary(orgInput: JsonObject) {
  const org = asObject(orgInput);
  const ledger = asArray(org.credits_ledger).map((entry) => asObject(entry));
  let spent = 0;
  let added = 0;
  let orderSubmitted = 0;
  let firstOrderAt = "";
  let lastOrderAt = "";
  for (const entry of ledger) {
    const delta = Number(entry.delta || 0);
    if (delta < 0) spent += Math.abs(delta);
    if (delta > 0) added += delta;
    if (entry.reason === "order_submitted") {
      orderSubmitted += 1;
      const ts = asString(entry.ts);
      if (ts && (!firstOrderAt || ts < firstOrderAt)) firstOrderAt = ts;
      if (ts && (!lastOrderAt || ts > lastOrderAt)) lastOrderAt = ts;
    }
  }
  return {
    id: asString(org.id),
    name: asString(org.name),
    created_at: org.created_at ?? null,
    created_by_email: org.created_by_email ?? null,
    created_by_name: org.created_by_name ?? null,
    credits_balance: org.credits_balance ?? null,
    credits_added_total: added,
    credits_spent_total: spent,
    ledger_count: ledger.length,
    ledger_order_submitted_count: orderSubmitted,
    first_order_at: firstOrderAt || null,
    last_order_at: lastOrderAt || null,
    assigned_sales_email: org.assigned_sales_email ?? "",
    assigned_sales_name: org.assigned_sales_name ?? "",
    paired_lead_ids: org.paired_lead_ids ?? [],
    contact: org.contact ?? {},
    report_settings: org.report_settings ?? {},
    is_test: Boolean(org.is_test)
  };
}

function localDayRange(dateInput: unknown, timezoneInput: unknown = DATA_AGENT_TIMEZONE) {
  const timezone = asString(timezoneInput || DATA_AGENT_TIMEZONE);
  const date = asString(dateInput) || new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startMs: start.getTime(), endMs: end.getTime(), date, timezone };
}

function orgMatchesFilters(summary: JsonObject, filtersInput: unknown) {
  const filters = asObject(filtersInput);
  const query = asString(filters.query).toLowerCase();
  if (query) {
    const hay = [summary.id, summary.name, summary.created_by_email, summary.created_by_name, summary.assigned_sales_email, summary.assigned_sales_name].join(" ").toLowerCase();
    if (!hay.includes(query)) return false;
  }
  if (!filters.include_test && summary.is_test) return false;
  const created = Date.parse(asString(summary.created_at));
  if (filters.created_on) {
    const { startMs, endMs } = localDayRange(filters.created_on, filters.timezone);
    if (Number.isNaN(created) || created < startMs || created >= endMs) return false;
  }
  if (filters.created_start) {
    const start = Date.parse(asString(filters.created_start));
    if (!Number.isNaN(start) && (Number.isNaN(created) || created < start)) return false;
  }
  if (filters.created_end) {
    const end = Date.parse(asString(filters.created_end));
    if (!Number.isNaN(end) && (Number.isNaN(created) || created >= end)) return false;
  }
  return true;
}

function projectCountsByOrganization(orgIdsInput: unknown[]) {
  const orgIds = [...new Set(orgIdsInput.map(String).filter(Boolean))];
  const counts: Record<string, JsonObject> = Object.fromEntries(orgIds.map((id) => [id, { project_count: 0, completed_project_count: 0, cancelled_project_count: 0, rejected_project_count: 0, latest_project_at: null }]));
  if (!orgIds.length) return counts;
  const db = openDb("projects");
  try {
    for (let offset = 0; offset < orgIds.length; offset += 80) {
      const chunk = orgIds.slice(offset, offset + 80);
      const params: JsonObject = {};
      const keys = chunk.map((id, index) => {
        const key = `:org${index}`;
        params[key] = id;
        return key;
      });
      const rows = bindParams(db.prepare(`SELECT organization_id, COUNT(*) AS project_count, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed_project_count, SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled_project_count, SUM(CASE WHEN status LIKE 'rejected%' THEN 1 ELSE 0 END) AS rejected_project_count, MAX(COALESCE(NULLIF(completed_at,''), NULLIF(updated_at,''), NULLIF(created_at,''))) AS latest_project_at FROM projects WHERE organization_id IN (${keys.join(",")}) GROUP BY organization_id`), params);
      for (const row of rows) {
        counts[asString(row.organization_id)] = {
          project_count: Number(row.project_count || 0),
          completed_project_count: Number(row.completed_project_count || 0),
          cancelled_project_count: Number(row.cancelled_project_count || 0),
          rejected_project_count: Number(row.rejected_project_count || 0),
          latest_project_at: row.latest_project_at ?? null
        };
      }
    }
  } finally {
    db.close();
  }
  return counts;
}

async function searchOrganizations(args: JsonObject) {
  const filters = asObject(args.filters ?? args);
  if (args.query && !filters.query) filters.query = args.query;
  const limit = clampInt(args.limit, 50, 1, 200);
  const includeCounts = Boolean(args.include_project_counts || filters.include_project_counts);
  const rows = [];
  for (const org of await listOrganizations()) {
    const summary = orgSummary(org);
    if (!orgMatchesFilters(summary, filters)) continue;
    rows.push(summary);
    if (rows.length >= limit) break;
  }
  if (includeCounts && rows.length) {
    const counts = projectCountsByOrganization(rows.map((row) => row.id));
    rows.forEach((row) => Object.assign(row, counts[asString(row.id)] ?? {}));
  }
  return { row_count: rows.length, rows, polled_at: nowIso() };
}

async function organizationSignupStats(args: JsonObject) {
  const filters = asObject(args.filters ?? args);
  if (!filters.created_on && !filters.created_start && !filters.created_end) {
    filters.created_on = asString(args.created_on) || new Intl.DateTimeFormat("en-CA", { timeZone: DATA_AGENT_TIMEZONE }).format(new Date());
    filters.timezone = filters.timezone || DATA_AGENT_TIMEZONE;
  }
  const limit = clampInt(args.limit, 200, 1, 500);
  const rows = [];
  for (const org of await listOrganizations()) {
    const summary = orgSummary(org);
    if (orgMatchesFilters(summary, filters)) rows.push(summary);
  }
  rows.sort((a, b) => asString(b.created_at).localeCompare(asString(a.created_at)));
  const counts = projectCountsByOrganization(rows.map((row) => row.id));
  let projectTotal = 0;
  let completedTotal = 0;
  let ledgerOrders = 0;
  rows.forEach((row) => {
    const mutableRow = row as JsonObject;
    Object.assign(mutableRow, counts[asString(row.id)] ?? {});
    projectTotal += Number(mutableRow.project_count || 0);
    completedTotal += Number(mutableRow.completed_project_count || 0);
    ledgerOrders += Number(row.ledger_order_submitted_count || 0);
  });
  return {
    filters,
    organization_count: rows.length,
    project_count_total: projectTotal,
    completed_project_count_total: completedTotal,
    ledger_order_submitted_count_total: ledgerOrders,
    rows_returned: Math.min(rows.length, limit),
    rows: rows.slice(0, limit),
    note: "project_count_total counts projects/reports in the projects SQLite index by organization_id. ledger_order_submitted_count_total counts order_submitted entries in organization credit ledgers.",
    polled_at: nowIso()
  };
}

async function firstMeasureApiRequest(args: JsonObject) {
  const method = asString(args.method || "GET").toUpperCase();
  const requestPath = `/${asString(args.path).replace(/^\/+/, "")}`;
  if (requestPath === "/") throw new Error("path is required.");
  const allowedPost = [/^\/projects\/query$/, /^\/projects\/list$/, /^\/projects\/find-by-address$/, /^\/queue\/status(?:\/compat)?$/, /^\/queue\/admin\/overview(?:\/compat)?$/];
  if (method !== "GET" && method !== "POST") throw new Error("Only GET and read-only POST routes are allowed.");
  if (method === "POST" && !allowedPost.some((pattern) => pattern.test(requestPath))) {
    throw new Error("This POST route is not on the read-only allowlist.");
  }
  const url = new URL(`http://${env.host}:${env.port}/v1/firstmeasure${requestPath}`);
  for (const [key, value] of Object.entries(asObject(args.query))) {
    if (value !== undefined && value !== null) url.searchParams.set(key, asString(value));
  }
  const response = await fetch(url, {
    method,
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(asObject(args.body)) : undefined
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    ok: response.ok,
    status: response.status,
    url: url.toString(),
    polled_at: nowIso(),
    json: json && typeof json === "object" ? json : null,
    body_preview: json && typeof json === "object" ? null : text.slice(0, 4000)
  };
}

async function listDataSources() {
  return {
    app: "FirstMeasure for FirstMate roof reports",
    server_time: nowIso(),
    timezone: DATA_AGENT_TIMEZONE,
    firstmeasure_api_base: "/v1/firstmeasure",
    sqlite_databases: databaseSchema(""),
    json_stores: {
      users: { path: path.join(storageRoot(), "users"), count: (await listInternalUsers()).length },
      organizations: { path: path.join(process.cwd(), "storage", "platform-migration-dev", "organizations") },
      data_agent: { path: path.join(storageRoot(), "state", "data_agent") },
      v1_firstmeasure_projects: { path: path.join(firstMeasureStorageRoot(), "projects") }
    },
    admin_readable_json_catalog: allowedJsonRoots().map((root) => root.label),
    not_directly_exposed: ["storage/secrets", "storage/config and OAuth token state", "raw mailbox tokens", "live Stripe payloads"],
    terminology: terminology()
  };
}

function terminology() {
  return {
    product: "FirstMeasure",
    company_context: "FirstMeasure is a FirstMate product used to produce roof reports.",
    report_types: ["residential", "commercial", "multifamily"],
    people: {
      main_managers: ["Melden", "Rashid"],
      technicians: "Production users who draw/process roof reports.",
      qa_technicians: "QA users who review reports.",
      managers: "Managers supervise queue, QA, reviews, users, payroll, and production operations."
    },
    timezones: {
      company_and_agent_users: DATA_AGENT_TIMEZONE,
      technicians_qa_managers: TECHNICIAN_TIMEZONE
    },
    time_awareness: "Data changes over time. Each tool result includes polled_at."
  };
}

function allowedJsonRoots() {
  return [
    { label: "internal/state", root: path.join(storageRoot(), "state") },
    { label: "firstmeasure/storage", root: firstMeasureStorageRoot() },
    { label: "measure/storage/data", root: path.join(measureStorageRoot(), "data") },
    { label: "measure/storage/territory", root: path.join(measureStorageRoot(), "territory") },
    { label: "measure/storage/tutorials", root: path.join(measureStorageRoot(), "tutorials") },
    { label: "measure/storage/coupons", root: path.join(measureStorageRoot(), "coupons") }
  ];
}

function redactValue(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as JsonObject).map(([k, v]) => [k, redactValue(v, k)]));
  return /(password|secret|token|api[_-]?key|access[_-]?key|refresh|authorization|oauth|stripe|postmark|gemini|google_api)/i.test(key) && asString(value) ? "[redacted]" : value;
}

async function portalDataCatalog(args: JsonObject = {}) {
  const limit = clampInt(args.limit, 200, 1, 500);
  const rows = [];
  for (const source of allowedJsonRoots()) {
    for (const file of await listJsonFiles(source.root, limit - rows.length)) {
      const stats = await stat(file);
      rows.push({ path: `${source.label}/${path.relative(source.root, file).replace(/\\/g, "/")}`, area: source.label, bytes: stats.size, modified_at: stats.mtime.toISOString() });
      if (rows.length >= limit) break;
    }
    if (rows.length >= limit) break;
  }
  return { row_count: rows.length, rows, coverage_note: "Secrets, OAuth token state, raw mailboxes, live Stripe payloads, and source files are excluded.", polled_at: nowIso() };
}

async function readPortalJsonDocument(args: JsonObject) {
  const requested = asString(args.path).replace(/\\/g, "/").replace(/^\/+/, "");
  for (const source of allowedJsonRoots()) {
    const prefix = `${source.label}/`;
    if (!requested.startsWith(prefix)) continue;
    const relative = requested.slice(prefix.length);
    if (!relative || relative.includes("..")) break;
    const filePath = path.resolve(source.root, relative);
    if (!filePath.startsWith(path.resolve(source.root)) || !(await pathExists(filePath))) break;
    const stats = await stat(filePath);
    if (stats.size > 2 * 1024 * 1024) throw new Error("JSON document is too large for direct agent reading.");
    return { path: requested, modified_at: stats.mtime.toISOString(), data: redactValue(await readJson(filePath)), polled_at: nowIso() };
  }
  throw new Error("Path is not in an allowed read-only JSON area.");
}

function createTableArtifact(args: JsonObject) {
  return {
    artifact: {
      id: `artifact_${newId(6)}`,
      type: "table",
      title: asString(args.title || "Table"),
      columns: asArray(args.columns).map(String).slice(0, 20),
      rows: asArray(args.rows).map((row) => asObject(row)).slice(0, 200)
    },
    polled_at: nowIso()
  };
}

function createChartArtifact(args: JsonObject) {
  const type = ["bar", "line", "pie", "doughnut"].includes(asString(args.chart_type)) ? asString(args.chart_type) : "bar";
  const labels = asArray(args.labels).map(String);
  const datasets = asArray(args.datasets).map((dataset, index) => {
    const object = asObject(dataset);
    return { ...object, label: asString(object.label || object.name || `Series ${index + 1}`), data: asArray(object.data ?? object.values).map((value) => Number(value) || 0) };
  }).filter((dataset) => dataset.data.length);
  if (!labels.length || !datasets.length) throw new Error("create_chart requires labels and at least one numeric dataset.");
  return { artifact: { id: `artifact_${newId(6)}`, type: "chart", chart_type: type, title: asString(args.title || "Chart"), labels, datasets }, polled_at: nowIso() };
}

async function callTool(name: string, args: JsonObject) {
  switch (name) {
    case "list_data_sources": return await listDataSources();
    case "inspect_database_schema": return databaseSchema(asString(args.database));
    case "run_readonly_sql": return runReadonlySql(args);
    case "search_projects": return searchProjects(args);
    case "project_stats": return projectStats(args);
    case "get_project_detail": return runReadonlySql({ database: "projects", sql: "SELECT * FROM projects WHERE id = :id LIMIT 1", params: { ":id": args.project_id ?? args.id }, limit: 1 });
    case "search_users": return await searchUsers(args);
    case "get_user_profile": {
      const user = await readInternalUser(asString(args.email));
      return { user: user ? await safeUser(user) : null, polled_at: nowIso() };
    }
    case "get_shift_snapshot": return { ...(await searchUsers(args)), technician_timezone: TECHNICIAN_TIMEZONE, company_user_timezone: DATA_AGENT_TIMEZONE };
    case "search_organizations": return await searchOrganizations(args);
    case "organization_signup_stats": return await organizationSignupStats(args);
    case "get_organization_summary": {
      const id = asString(args.organization_id || args.id);
      if (!id) throw new Error("organization_id is required.");
      const org = await readOrganization(id).catch(() => null);
      return { organization: org ? orgSummary(org) : null, polled_at: nowIso() };
    }
    case "search_leads": return runReadonlySql({ database: "leads", sql: "SELECT * FROM leads LIMIT :limit", params: { ":limit": clampInt(args.limit, 50, 1, 200) }, limit: clampInt(args.limit, 50, 1, 200) });
    case "lead_stats": return runReadonlySql({ database: "leads", sql: "SELECT status AS group_1, COUNT(*) AS lead_count FROM leads GROUP BY status ORDER BY lead_count DESC LIMIT 200", params: {}, limit: 200 });
    case "list_portal_data_catalog": return await portalDataCatalog(args);
    case "read_portal_json_document": return await readPortalJsonDocument(args);
    case "get_crm_settings_snapshot": return { crm_settings: await listInternalDocuments("crm_settings"), call_scripts: await listInternalDocuments("call_scripts"), polled_at: nowIso() };
    case "firstmeasure_api_request": return await firstMeasureApiRequest(args);
    case "create_table": return createTableArtifact(args);
    case "create_chart": return createChartArtifact(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function toolDefinitions() {
  const object = { type: "object", additionalProperties: false };
  return [
    { type: "function", name: "list_data_sources", description: "List available read-only data sources, schemas, storage paths, counts, API base URL, and terminology.", parameters: { ...object, properties: {}, required: [] }, strict: false },
    { type: "function", name: "inspect_database_schema", description: "Inspect SQLite tables/columns/counts for one database or all databases.", parameters: { ...object, properties: { database: { type: "string" } }, required: ["database"] }, strict: false },
    { type: "function", name: "run_readonly_sql", description: "Run a read-only SELECT/WITH SQL query against an allowed SQLite database. Max 500 rows.", parameters: { type: "object", additionalProperties: false, properties: { database: { type: "string", enum: ["projects", "leads", "commissions", "referrals", "legacy_projects"] }, sql: { type: "string" }, params: { type: "object", additionalProperties: true }, limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["database", "sql", "params", "limit"] }, strict: false },
    { type: "function", name: "search_projects", description: "Search FirstMeasure project/report index by filters.", parameters: { type: "object", additionalProperties: false, properties: { filters: { type: "object", additionalProperties: true }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["filters", "limit"] }, strict: false },
    { type: "function", name: "project_stats", description: "Aggregate projects/reports by status, type, technician, owner, organization, day, or complexity.", parameters: { type: "object", additionalProperties: false, properties: { filters: { type: "object", additionalProperties: true }, group_by: { type: "array", items: { type: "string" } } }, required: ["filters", "group_by"] }, strict: false },
    { type: "function", name: "get_project_detail", description: "Get one project/report row.", parameters: { ...object, properties: { project_id: { type: "string" }, include_manifest: { type: "boolean" } }, required: ["project_id", "include_manifest"] }, strict: false },
    { type: "function", name: "search_users", description: "Search internal users/technicians/managers.", parameters: { ...object, properties: { query: { type: "string" }, role: { type: "string" }, department: { type: "string" }, team_id: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["query", "role", "department", "team_id", "limit"] }, strict: false },
    { type: "function", name: "get_user_profile", description: "Get one sanitized internal user profile by email.", parameters: { ...object, properties: { email: { type: "string" } }, required: ["email"] }, strict: false },
    { type: "function", name: "get_shift_snapshot", description: "Read employee shift schedules and timezone context.", parameters: { ...object, properties: { query: { type: "string" }, role: { type: "string" }, department: { type: "string" }, team_id: { type: "string" }, date: { type: "string" }, on_shift_only: { type: "boolean" }, limit: { type: "integer" } }, required: ["query", "role", "department", "team_id", "date", "on_shift_only", "limit"] }, strict: false },
    { type: "function", name: "search_organizations", description: "Search customer organizations and return safe summaries.", parameters: { ...object, properties: { query: { type: "string" }, filters: { type: "object", additionalProperties: true }, limit: { type: "integer" }, include_project_counts: { type: "boolean" } }, required: ["query", "filters", "limit", "include_project_counts"] }, strict: false },
    { type: "function", name: "organization_signup_stats", description: "Find organizations by signup date and aggregate project counts.", parameters: { ...object, properties: { filters: { type: "object", additionalProperties: true }, limit: { type: "integer" } }, required: ["filters", "limit"] }, strict: false },
    { type: "function", name: "get_organization_summary", description: "Get a summary for one customer organization.", parameters: { ...object, properties: { organization_id: { type: "string" } }, required: ["organization_id"] }, strict: false },
    { type: "function", name: "search_leads", description: "Search CRM leads.", parameters: { type: "object", additionalProperties: false, properties: { filters: { type: "object", additionalProperties: true }, limit: { type: "integer" } }, required: ["filters", "limit"] }, strict: false },
    { type: "function", name: "lead_stats", description: "Aggregate CRM leads.", parameters: { type: "object", additionalProperties: false, properties: { filters: { type: "object", additionalProperties: true }, group_by: { type: "string" } }, required: ["filters", "group_by"] }, strict: false },
    { type: "function", name: "list_portal_data_catalog", description: "List admin-readable JSON files from safe storage areas.", parameters: { ...object, properties: { limit: { type: "integer", minimum: 1, maximum: 500 } }, required: ["limit"] }, strict: false },
    { type: "function", name: "read_portal_json_document", description: "Read one JSON document from list_portal_data_catalog.", parameters: { ...object, properties: { path: { type: "string" } }, required: ["path"] }, strict: false },
    { type: "function", name: "get_crm_settings_snapshot", description: "Read CRM settings and call scripts through normalized read-only helpers.", parameters: { ...object, properties: {}, required: [] }, strict: false },
    { type: "function", name: "firstmeasure_api_request", description: "Read-only FirstMeasure API request placeholder.", parameters: { ...object, properties: { method: { type: "string" }, path: { type: "string" }, query: { type: "object", additionalProperties: true }, body: { type: "object", additionalProperties: true } }, required: ["method", "path", "query", "body"] }, strict: false },
    { type: "function", name: "create_table", description: "Create a rendered table artifact.", parameters: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["title", "columns", "rows"] }, strict: false },
    { type: "function", name: "create_chart", description: "Create a rendered Chart.js artifact.", parameters: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, chart_type: { type: "string", enum: ["bar", "line", "pie", "doughnut"] }, labels: { type: "array", items: { type: "string" } }, datasets: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["title", "chart_type", "labels", "datasets"] }, strict: false }
  ];
}

async function coreSystemInstructions() {
  const sources = dbMap();
  return `You are the FirstMeasure Data Agent inside the FirstMate internal CRM.
Current server time: ${nowIso()}. Timezone: ${DATA_AGENT_TIMEZONE}. Always pay attention to when data was polled, because operational data can change.

Product context: FirstMeasure is a FirstMate product for roof reports. Reports/projects can be residential, commercial, or multifamily. Main managers: Melden and Rashid.
Timezone context: users asking questions are normally in Pacific time (${DATA_AGENT_TIMEZONE}). Technicians, QA technicians, and managers generally work in the Philippines on Philippine Standard Time (${TECHNICIAN_TIMEZONE}, UTC+08, no DST).

Data locations: projects SQLite index is ${sources.projects}; CRM leads are in ${sources.leads}; users are in ${path.join(storageRoot(), "users")}; FirstMeasure API base is /v1/firstmeasure.
You have only read-only tools. Never request writes, mutations, destructive SQL, or secret material. Do not reveal password hashes, tokens, API keys, files from storage/secrets, OAuth state, raw mailbox tokens, live Stripe payloads, or arbitrary source code.

Use tools proactively. Prefer high-level stats/search tools when they fit; use read-only SQL when a custom aggregation is needed. For statistical answers, show numerator, denominator, filters, and poll time. Generate tables/charts when they make the answer clearer.`;
}

async function systemInstructions() {
  const settings = await loadSettings();
  return `${asString(settings.system_prompt) || await coreSystemInstructions()}

Non-editable runtime safety: all available tools are read-only. Never request writes, mutations, destructive SQL, or secret material.

Non-editable rendering rule: when the user asks for a chart, graph, visualization, trend line, bar chart, pie chart, or similar visual, call create_chart with labels and datasets.`;
}

function functionCallSummaries() {
  return toolDefinitions().map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
}

function buildInputMessages(messages: unknown, newUserText: string) {
  const input = asArray(messages).slice(-20).map((message) => {
    const object = asObject(message);
    const role = object.role === "assistant" ? "assistant" : object.role === "user" ? "user" : "";
    const content = asString(object.content).trim();
    return role && content ? { role, content } : null;
  }).filter(Boolean) as Array<{ role: string; content: string }>;
  input.push({ role: "user", content: newUserText });
  return input;
}

function traceSummary(result: JsonObject) {
  if (result.artifact) return { artifact: result.artifact };
  if (result.row_count !== undefined) return { row_count: result.row_count, polled_at: result.polled_at ?? null };
  if (result.total_count !== undefined) return { total_count: result.total_count, row_count: result.row_count ?? null, polled_at: result.polled_at ?? null };
  if (result.status !== undefined) return { status: result.status, ok: result.ok ?? null, polled_at: result.polled_at ?? null };
  return { keys: Object.keys(result).slice(0, 12), polled_at: result.polled_at ?? null };
}

async function runChat(runId: string, session: JsonObject, message: string) {
  const apiKey = await openAiApiKey();
  if (!apiKey) {
    await appendRunEvent(runId, "error", { message: "Missing OPENAI_API_KEY or server_config data_agent_openai_api_key." });
    return { answer: null, trace: [], artifacts: [], model: "" };
  }
  const tools = toolDefinitions();
  const input = buildInputMessages(session.messages, message);
  const artifacts: JsonObject[] = [];
  const trace: JsonObject[] = [];
  let selectedModel = "";
  let response: JsonObject | null = null;
  let lastError = "";
  await appendRunEvent(runId, "status", { message: "Contacting OpenAI with read-only tools." });
  for (const model of await modelCandidates()) {
    const payload: JsonObject = { model, instructions: await systemInstructions(), input, tools, tool_choice: "auto", parallel_tool_calls: true };
    if (model.startsWith("gpt-5")) payload.reasoning = { effort: "medium" };
    const result = await openAiRequest(payload, apiKey);
    if (result.ok) {
      selectedModel = model;
      response = result.json;
      break;
    }
    lastError = asString(asObject(result.json?.error).message || result.error || result.raw || "OpenAI request failed.");
    if (!/model|does not exist|not found/i.test(lastError)) {
      await appendRunEvent(runId, "error", { message: lastError, status: result.status });
      return { answer: null, trace, artifacts, model: selectedModel };
    }
    await appendRunEvent(runId, "status", { message: `Model ${model} unavailable; trying fallback.` });
  }
  if (!response || !selectedModel) {
    await appendRunEvent(runId, "error", { message: lastError || "No configured model was available." });
    return { answer: null, trace, artifacts, model: "" };
  }
  await appendRunEvent(runId, "meta", { model: selectedModel, server_time: nowIso() });
  let previousResponseId = "";
  for (let step = 0; step < 12; step++) {
    const activeResponse = response;
    if (!activeResponse) break;
    previousResponseId = asString(activeResponse.id || previousResponseId);
    const calls = functionCalls(activeResponse);
    if (!calls.length) break;
    const outputs = [];
    for (const call of calls) {
      const name = asString(call.name);
      const callId = asString(call.call_id);
      let args: JsonObject = {};
      try {
        args = asObject(JSON.parse(asString(call.arguments || "{}")));
      } catch {
        args = {};
      }
      const started = Date.now();
      await appendRunEvent(runId, "tool_call", { name, arguments: args, call_id: callId, started_at: nowIso() });
      const traceItem: JsonObject = { name, arguments: args, call_id: callId, started_at: nowIso() };
      try {
        const result = asObject(await callTool(name, args));
        if (result.artifact) artifacts.push(asObject(result.artifact));
        const summary = traceSummary(result);
        traceItem.ok = true;
        traceItem.summary = summary;
        traceItem.duration_ms = Date.now() - started;
        outputs.push({ type: "function_call_output", call_id: callId, output: JSON.stringify(result) });
        await appendRunEvent(runId, "tool_result", { name, call_id: callId, ok: true, summary, duration_ms: traceItem.duration_ms });
      } catch (error) {
        const err = { ok: false, error: error instanceof Error ? error.message : "Tool failed.", polled_at: nowIso() };
        traceItem.ok = false;
        traceItem.error = err.error;
        outputs.push({ type: "function_call_output", call_id: callId, output: JSON.stringify(err) });
        await appendRunEvent(runId, "tool_result", { name, call_id: callId, ok: false, error: err.error });
      }
      trace.push(traceItem);
    }
    await appendRunEvent(runId, "status", { message: "Sending tool results back to the model." });
    const payload: JsonObject = { model: selectedModel, previous_response_id: previousResponseId, input: outputs, tools, tool_choice: "auto", parallel_tool_calls: true };
    if (selectedModel.startsWith("gpt-5")) payload.reasoning = { effort: "medium" };
    const result = await openAiRequest(payload, apiKey, 120000);
    if (!result.ok) {
      const messageText = asString(asObject(result.json?.error).message || result.error || "OpenAI follow-up request failed.");
      await appendRunEvent(runId, "error", { message: messageText, status: result.status });
      return { answer: null, trace, artifacts, model: selectedModel };
    }
    response = result.json;
  }
  const answer = responseText(response) || "I could not produce a final answer from the tool results.";
  await appendRunEvent(runId, "assistant_message", { content: answer, artifacts, model: selectedModel, created_at: nowIso() });
  return { answer, trace, artifacts, model: selectedModel };
}

async function generateTitle(message: string) {
  const fallback = message.replace(/\s+/g, " ").trim().slice(0, 54) || "Data chat";
  const apiKey = await openAiApiKey();
  if (!apiKey) return fallback;
  const input = `Create a concise 3-7 word title for this FirstMeasure data-agent conversation. Return only the title, no punctuation wrapper.\n\nUser request: ${message}`;
  for (const model of await titleModelCandidates()) {
    const result = await openAiRequest({ model, instructions: "You write short CRM conversation titles. Return only a plain title.", input: [{ role: "user", content: input }], max_output_tokens: 32 }, apiKey, 12000);
    if (!result.ok) continue;
    const title = responseText(result.json).replace(/^[\s"'`.,:;-]+|[\s"'`.,:;-]+$/g, "").slice(0, 70);
    if (title) return title;
  }
  return fallback;
}

async function maybeGenerateTitle(sessionId: string, message: string) {
  const session = await readSession(sessionId);
  if (!session) return;
  const messages = asArray(session.messages);
  const title = asString(session.title).trim();
  if (messages.length !== 1) return;
  if (title && title !== "New data chat" && title !== "Generating title...") return;
  session.title = await generateTitle(message);
  await saveSession(session);
}

async function repairCompletedRunVisibility(run: DataAgentRun) {
  if (run.status !== "completed") return run;
  const assistantMessage = asObject(run.assistant_message);
  let changedRun = false;
  if (assistantMessage.content && !run.events.some((event) => event.event === "assistant_message")) {
    run.events.push({
      seq: 0,
      event: "assistant_message",
      data: {
        content: asString(assistantMessage.content),
        artifacts: asArray(assistantMessage.artifacts),
        model: asString(assistantMessage.model),
        created_at: asString(assistantMessage.created_at) || nowIso()
      },
      created_at: asString(assistantMessage.created_at) || nowIso()
    });
    changedRun = true;
  }
  if (!run.events.some((event) => event.event === "done")) {
    run.events.push({
      seq: 0,
      event: "done",
      data: { session_id: run.session_id, run_id: run.id, updated_at: nowIso() },
      created_at: nowIso()
    });
    changedRun = true;
  }
  if (changedRun) {
    run.events = run.events.map((event, index) => ({ ...event, seq: index + 1 }));
    run.last_event_seq = run.events.length;
    run = await saveRun(run);
  }

  const session = await readSession(run.session_id);
  if (session) {
    let changedSession = false;
    const messages = asArray(session.messages).map((message) => asObject(message));
    if (assistantMessage.content && !messages.some((message) => message.role === "assistant" && message.content === assistantMessage.content)) {
      messages.push({
        role: "assistant",
        content: asString(assistantMessage.content),
        created_at: asString(assistantMessage.created_at) || nowIso(),
        trace: asArray(assistantMessage.trace),
        artifacts: asArray(assistantMessage.artifacts),
        model: asString(assistantMessage.model)
      });
      session.messages = messages;
      changedSession = true;
    }
    const title = asString(session.title).trim();
    if ((!title || title === "Generating title..." || title === "New data chat") && asString(run.message).trim()) {
      session.title = asString(run.message).replace(/\s+/g, " ").trim().slice(0, 54) || "Data chat";
      changedSession = true;
    }
    if (changedSession) await saveSession(session);
  }
  return run;
}

async function runBackgroundJob(runId: string) {
  if (ACTIVE_RUNS.has(runId)) return;
  ACTIVE_RUNS.add(runId);
  try {
    let run = await readRun(runId);
    if (!run || !["queued", "running"].includes(run.status)) return;
    run.status = "running";
    run.started_at = run.started_at || nowIso();
    run = await saveRun(run);
    const result = await runChat(runId, { id: run.session_id, messages: run.context_messages }, asString(run.message));
    await maybeGenerateTitle(run.session_id, asString(run.message));
    run = await readRun(runId) ?? run;
    if (result.answer !== null) {
      const assistantMessage = { role: "assistant", content: result.answer, created_at: nowIso(), trace: result.trace, artifacts: result.artifacts, model: result.model };
      const session = await readSession(run.session_id);
      if (session) {
        session.messages = [...asArray(session.messages), assistantMessage];
        await saveSession(session);
      }
      run.status = "completed";
      run.completed_at = nowIso();
      run.assistant_message = assistantMessage;
      await saveRun(run);
      await appendRunEvent(runId, "done", { session_id: run.session_id, run_id: runId, updated_at: nowIso() });
    } else {
      run.status = "error";
      run.completed_at = nowIso();
      await saveRun(run);
    }
  } catch (error) {
    await appendRunEvent(runId, "error", { message: error instanceof Error ? error.message : "Run failed." });
    const run = await readRun(runId);
    if (run) {
      run.status = "error";
      run.completed_at = nowIso();
      run.error = error instanceof Error ? error.message : "Run failed.";
      await saveRun(run);
    }
  } finally {
    ACTIVE_RUNS.delete(runId);
  }
}

async function buildUserMessageAndSession(body: JsonObject, actor: Actor) {
  const id = sanitizeSessionId(body.session_id);
  const message = asString(body.message).trim();
  if (!message) throw new Error("Message is required.");
  const editRaw = body.edit_message_index;
  const editIndex = editRaw === undefined || editRaw === "" ? null : clampInt(editRaw, -1, -1, 100000);
  if (editIndex !== null && editIndex < 0) throw new Error("Invalid message edit index.");
  let session = id ? await readSession(id) : null;
  if (id && !(await canAccessSession(session, actor))) throw new Error("Conversation not found.");
  if (editIndex !== null && !session) throw new Error("Cannot edit a conversation that has not been saved yet.");
  if (!session) session = await createSession(actor, "Generating title...", false);
  let messagesBeforeNewUser = asArray(session.messages).map((messageItem) => asObject(messageItem));
  const userMessage: JsonObject = { role: "user", content: message, created_at: nowIso() };
  if (editIndex !== null) {
    let latestUserIndex = -1;
    messagesBeforeNewUser.forEach((savedMessage, index) => {
      if (savedMessage.role === "user") latestUserIndex = index;
    });
    if (!messagesBeforeNewUser[editIndex] || messagesBeforeNewUser[editIndex]?.role !== "user") throw new Error("Only a saved user message can be edited.");
    if (editIndex !== latestUserIndex) throw new Error("Only the most recent user message can be edited.");
    userMessage.edited_at = nowIso();
    userMessage.replaces_message_index = editIndex;
    messagesBeforeNewUser = messagesBeforeNewUser.slice(0, editIndex);
    session.messages = messagesBeforeNewUser;
  }
  session.messages = [...asArray(session.messages), userMessage];
  if (session.title === "New data chat") session.title = "Generating title...";
  session = await saveSession(session);
  return { session, messagesBeforeNewUser, userMessage };
}

async function startRun(body: JsonObject, actor: Actor) {
  const { session, messagesBeforeNewUser, userMessage } = await buildUserMessageAndSession(body, actor);
  const run: DataAgentRun = {
    id: newId(16),
    session_id: asString(session.id),
    status: "queued",
    created_at: nowIso(),
    updated_at: nowIso(),
    created_by_email: actor.email,
    created_by_name: actor.name,
    message: asString(body.message).trim(),
    context_messages: messagesBeforeNewUser,
    user_message: userMessage,
    events: [],
    last_event_seq: 0
  };
  await saveRun(run);
  await appendRunEvent(run.id, "user_message", { ...userMessage, session_id: session.id });
  void runBackgroundJob(run.id);
  const savedRun = await readRun(run.id) ?? run;
  return {
    success: true,
    ok: true,
    session_id: session.id,
    session,
    run: { id: savedRun.id, status: savedRun.status, last_event_seq: savedRun.last_event_seq },
    user_message: userMessage
  };
}

export async function handleDataAgentLegacyAction(action: string, rawBody: JsonObject) {
  const body = asObject(rawBody);
  const actor = normalizeActor(body);
  await requireDataAgent(actor);
  switch (action) {
    case "data_agent_bootstrap":
      return { ok: true, success: true, settings: await loadSettings(), sessions: await listSessions(actor), sources_summary: { server_time: nowIso(), timezone: DATA_AGENT_TIMEZONE, firstmeasure_api_base: "/v1/firstmeasure", model_candidates: await modelCandidates() } };
    case "data_agent_new_session":
      return { ok: true, success: true, session: await createSession(actor, asString(body.title), false) };
    case "data_agent_get_settings":
      return { ok: true, success: true, settings: await loadSettings(), system_prompt: asString((await loadSettings()).system_prompt), function_calls: functionCallSummaries() };
    case "data_agent_save_settings":
      return { ok: true, success: true, settings: await saveSettings(body, actor) };
    case "data_agent_list_sessions":
      return { ok: true, success: true, sessions: await listSessions(actor) };
    case "data_agent_get_session": {
      const id = sanitizeSessionId(body.session_id);
      const session = id ? await readSession(id) : null;
      if (!(await canAccessSession(session, actor))) return { ok: false, success: false, error: "Conversation not found." };
      return { ok: true, success: true, session, active_run: await latestActiveRunForSession(id, actor) };
    }
    case "data_agent_delete_session": {
      const id = sanitizeSessionId(body.session_id);
      const session = id ? await readSession(id) : null;
      if (!(await canAccessSession(session, actor))) return { ok: false, success: false, error: "Conversation not found." };
      await deleteSession(id);
      return { ok: true, success: true, deleted_session_id: id };
    }
    case "data_agent_rename_session": {
      const id = sanitizeSessionId(body.session_id);
      const session = id ? await readSession(id) : null;
      if (!(await canAccessSession(session, actor)) || !session) return { ok: false, success: false, error: "Conversation not found." };
      const title = asString(body.title).trim().slice(0, 90);
      if (!title) return { ok: false, success: false, error: "Title is required." };
      session.title = title;
      return { ok: true, success: true, session: await saveSession(session) };
    }
    case "data_agent_start_run":
      return await startRun(body, actor);
    case "data_agent_get_run": {
      const id = sanitizeSessionId(body.run_id);
      let run = id ? await readRun(id) : null;
      if (!run || (asString(run.created_by_email).toLowerCase() !== actor.email && !(await currentUserIsAdmin(actor)))) {
        return { ok: false, success: false, error: "Run not found." };
      }
      if (run.status === "queued" && !ACTIVE_RUNS.has(run.id)) void runBackgroundJob(run.id);
      run = await repairCompletedRunVisibility(run);
      const after = clampInt(body.after_seq, 0, 0, 1000000);
      const session = await readSession(run.session_id);
      return {
        ok: true,
        success: true,
        run: { id: run.id, session_id: run.session_id, status: run.status, last_event_seq: run.last_event_seq, updated_at: run.updated_at },
        session_title: asString(session?.title),
        events: run.events.filter((event) => event.seq > after),
        done: run.status === "completed" || run.status === "error"
      };
    }
    default:
      return null;
  }
}

export async function getDataAgentSettings() {
  return { ok: true, success: true, settings: await loadSettings() };
}

export async function putDataAgentSettings(body: JsonObject, actor: Actor) {
  if (actor.email) await requireDataAgent(actor);
  return { ok: true, success: true, settings: await saveSettings(body, actor) };
}

export async function listDataAgentSessions(actor: Actor) {
  if (actor.email) await requireDataAgent(actor);
  return { ok: true, success: true, sessions: await listSessions(actor) };
}
