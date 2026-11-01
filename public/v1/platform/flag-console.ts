import { createHash, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled, queryPostgres } from "../src/database/postgres.js";
import "./capability_defs.js";
import { capabilityDefinition, effectiveCapabilities, EQUIPMENT_SIMPLE_CAPABILITIES, readCapabilityCountryRules, valueCapabilities, type NormalizedCapability } from "./capabilities.js";
import { badRequest, notFound } from "./errors.js";
import { FLAG_OVERRIDES_KEY, flagBucket, flagOverrides, flagValueSource, percentCovers, readFlagRollouts, saveFlagRollout, type FlagRollouts } from "./flag-rollouts.js";
import { openSqlStore, type SqlStore } from "./sql_store.js";
import { findIdentityByEmail, listDocuments, listIdentityMemberships, listOrganizations, mutateGlobal, readGlobal, readOrganization, searchIdentities, searchOrganizations, type JsonObject } from "./storage.js";

/**
 * The feature flag console (docs/architecture/feature-flags.md): counts across every organization, an organization's
 * flags, a pasted list of organizations, percentages, the audit log and access keys for agents. A flag is an
 * organization switch: nothing here looks at who has an app.
 */

const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => Number(value ?? 0) || 0;
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

// listExpandedPlatformOrgIds selects these two by their stored value in SQL, and they are a rollout ceiling of their own.
const NO_PERCENTAGE = new Set(["platform.expanded_access", "platform.more_apps"]);
const MAX_BULK_ORGS = 5000;
const MAX_PASTED_ENTRIES = 2000;
const SNAPSHOT_TTL_MS = 60_000;
const SCAN_PAGE = 2000;

export type FlagActor = { kind: "staff" | "key" | "system"; label: string; can_write: boolean };

// ---------------------------------------------------------------------------
// Audit log and access keys: one store, SQLite in tests, Postgres on real hosts
// ---------------------------------------------------------------------------

let database: SqlStore | null = null;
let databasePath = "";
function store() {
  const nextPath = path.resolve(process.cwd(), env.platformStorageRoot, "feature-flags.sqlite");
  if (database && databasePath === nextPath) return database;
  // Raise this whenever initialize gains a table or a column: Postgres runs it again only for a higher version.
  database = openSqlStore({ id: "feature_flags", schemaVersion: 1, filename: nextPath, initialize });
  databasePath = nextPath;
  return database;
}
export async function closeFlagConsoleStore() {
  const open = database;
  database = null;
  databasePath = "";
  snapshot = null;
  await open?.close();
}

async function initialize(db: SqlStore) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS feature_flag_audit (
      id TEXT PRIMARY KEY,
      at BIGINT NOT NULL,
      actor TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      action TEXT NOT NULL,
      flag_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      org_count INTEGER NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      note TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feature_flag_audit_at ON feature_flag_audit(at);
    CREATE INDEX IF NOT EXISTS feature_flag_audit_flag ON feature_flag_audit(flag_key, at);
    CREATE TABLE IF NOT EXISTS feature_flag_audit_orgs (
      audit_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      org_name TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      PRIMARY KEY (audit_id, org_id)
    );
    CREATE INDEX IF NOT EXISTS feature_flag_audit_orgs_org ON feature_flag_audit_orgs(org_id);
    CREATE TABLE IF NOT EXISTS feature_flag_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      scope TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      last_used_at BIGINT NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0,
      revoked_at BIGINT NOT NULL DEFAULT 0,
      revoked_by TEXT NOT NULL DEFAULT ''
    );
  `);
}

type OrgChange = { org_id: string; org_name: string; before: unknown; after: unknown };
export async function recordFlagAudit(actor: FlagActor, entry: { action: string; flag_key?: string; summary: string; before?: unknown; after?: unknown; note?: string; orgs?: OrgChange[] }) {
  const id = "ffa_" + randomUUID().replace(/-/g, "");
  const orgs = entry.orgs ?? [];
  await store().transaction(async (tx) => {
    await tx.prepare(`INSERT INTO feature_flag_audit (id, at, actor, actor_kind, action, flag_key, summary, org_count, before_json, after_json, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, Date.now(), actor.label.slice(0, 320), actor.kind, entry.action, entry.flag_key ?? "", entry.summary.slice(0, 500), orgs.length, JSON.stringify(entry.before ?? null), JSON.stringify(entry.after ?? null), (entry.note ?? "").slice(0, 500));
    for (let index = 0; index < orgs.length; index += 200) {
      const batch = orgs.slice(index, index + 200);
      await tx.prepare(`INSERT INTO feature_flag_audit_orgs (audit_id, org_id, org_name, before_json, after_json) VALUES ${batch.map(() => "(?,?,?,?,?)").join(",")}`)
        .run(...batch.flatMap((org) => [id, org.org_id, org.org_name.slice(0, 200), JSON.stringify(org.before ?? null), JSON.stringify(org.after ?? null)]));
    }
  });
  return id;
}

const parseJson = (value: unknown) => { try { return JSON.parse(text(value) || "null"); } catch { return null; } };
function auditFromRow(row: Record<string, unknown>) {
  return {
    id: text(row.id), at: num(row.at), actor: text(row.actor), actor_kind: text(row.actor_kind), action: text(row.action), flag_key: text(row.flag_key),
    summary: text(row.summary), org_count: num(row.org_count), before: parseJson(row.before_json), after: parseJson(row.after_json), note: text(row.note)
  };
}

/** Newest first; optionally one flag's or one organization's history. */
export async function listFlagAudit(options: { flag?: string; org?: string; before?: number; limit?: number }) {
  const limit = Math.max(1, Math.min(200, options.limit || 50));
  const where: string[] = [], values: (string | number)[] = [];
  if (options.flag) { where.push("flag_key=?"); values.push(options.flag); }
  if (options.org) { where.push("id IN (SELECT audit_id FROM feature_flag_audit_orgs WHERE org_id=?)"); values.push(options.org); }
  if (options.before) { where.push("at<?"); values.push(options.before); }
  const rows = await store().prepare(`SELECT * FROM feature_flag_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ${limit}`).all(...values);
  return rows.map(auditFromRow);
}

export async function readFlagAuditEntry(id: string) {
  const db = store();
  const row = await db.prepare("SELECT * FROM feature_flag_audit WHERE id=?").get(id);
  if (!row) throw notFound("audit_entry_not_found", "That audit entry was not found.");
  const orgs = await db.prepare("SELECT org_id, org_name, before_json, after_json FROM feature_flag_audit_orgs WHERE audit_id=? ORDER BY org_name").all(id);
  return { ...auditFromRow(row), orgs: orgs.map((org) => ({ org_id: text(org.org_id), org_name: text(org.org_name), before: parseJson(org.before_json), after: parseJson(org.after_json) })) };
}

export const FLAG_KEY_PREFIX = "fmfk_";
const DAY_MS = 86400000;
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
function keyFromRow(row: Record<string, unknown>) {
  const expires = num(row.expires_at), revoked = num(row.revoked_at);
  return {
    id: text(row.id), name: text(row.name), prefix: text(row.prefix), scope: text(row.scope) === "write" ? "write" as const : "read" as const, created_by: text(row.created_by),
    created_at: num(row.created_at), expires_at: expires, last_used_at: num(row.last_used_at), uses: num(row.uses), revoked_at: revoked, revoked_by: text(row.revoked_by),
    active: !revoked && expires > Date.now()
  };
}

/** Only a hash is stored; the key is returned once, here. */
export async function createFlagKey(input: { name: string; scope: "read" | "write"; days?: number; createdBy: string }) {
  const key = FLAG_KEY_PREFIX + randomBytes(32).toString("base64url");
  const row = {
    id: "ffk_" + randomUUID().replace(/-/g, "").slice(0, 16), name: input.name.slice(0, 120), prefix: key.slice(0, FLAG_KEY_PREFIX.length + 6), scope: input.scope,
    created_by: input.createdBy, created_at: Date.now(), expires_at: Date.now() + Math.min(365, Math.max(1, Math.round(input.days ?? 90))) * DAY_MS
  };
  await store().prepare(`INSERT INTO feature_flag_keys (id, name, key_hash, prefix, scope, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(row.id, row.name, keyHash(key), row.prefix, row.scope, row.created_by, row.created_at, row.expires_at);
  return { key, ...keyFromRow(row) };
}

export async function listFlagKeys() {
  return (await store().prepare("SELECT * FROM feature_flag_keys ORDER BY created_at DESC LIMIT 200").all()).map(keyFromRow);
}

export async function revokeFlagKey(id: string, by: string) {
  return (await store().prepare("UPDATE feature_flag_keys SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at=0").run(Date.now(), by, id)).changes > 0;
}

export function bearerFlagKey(header: unknown) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(text(header));
  return match && match[1]!.startsWith(FLAG_KEY_PREFIX) ? match[1]! : "";
}

/** The live key behind a bearer value. Use is recorded at most once a minute. */
export async function verifyFlagKey(key: string) {
  if (!key.startsWith(FLAG_KEY_PREFIX) || key.length < FLAG_KEY_PREFIX.length + 40 || key.length > 200) return null;
  const db = store();
  const row = await db.prepare("SELECT * FROM feature_flag_keys WHERE key_hash=?").get(keyHash(key));
  if (!row) return null;
  const found = keyFromRow(row);
  if (!found.active) return null;
  if (Date.now() - found.last_used_at > 60000) await db.prepare("UPDATE feature_flag_keys SET last_used_at=?, uses=uses+1 WHERE id=?").run(Date.now(), found.id);
  return found;
}

// ---------------------------------------------------------------------------
// Counts: one paged scan of every organization's flag values, kept compactly
// (docs/optimization-backlog.md, "Feature flag counts scan every organization")
// ---------------------------------------------------------------------------

type OrgRow = { id: string; stored: Uint8Array; overrides: Record<string, boolean> | null };
type Snapshot = { at: number; orgs: OrgRow[]; rollouts: FlagRollouts; stats: Map<string, FlagStats> };
export type FlagStats = { on: number; stored_on: number; explicit_on: number; explicit_off: number; percent_added: number; percent_covered: number };

const STORED_UNSET = 0, STORED_ON = 1, STORED_OFF = 2;
let snapshot: Snapshot | null = null;
let scanning: Promise<Snapshot> | null = null;
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

function storedBytes(nodes: NormalizedCapability[], flags: JsonObject) {
  const bytes = new Uint8Array(nodes.length);
  nodes.forEach((node, index) => {
    if (node.type !== "boolean") return;
    const value = asObject(flags[node.group])[node.flag];
    bytes[index] = value === undefined ? STORED_UNSET : value === false ? STORED_OFF : STORED_ON;
  });
  return bytes;
}

async function scanOrganizations(nodes: NormalizedCapability[]) {
  const orgs: OrgRow[] = [];
  if (isFirstMeasurePostgresEnabled()) {
    let after = "";
    for (;;) {
      const page = await queryPostgres<{ id: string; flags: JsonObject | null; legacy: JsonObject | null; overrides: JsonObject | null }>(
        `SELECT o.id, d.document #> '{data,app_flags}' AS flags, d.document #> '{data,feature_flags}' AS legacy, d.document #> '{data,${FLAG_OVERRIDES_KEY}}' AS overrides
         FROM platform_organizations o LEFT JOIN platform_documents d ON d.organization_id = o.id AND d.collection = 'global' AND d.id = 'global'
         WHERE o.id > $1 ORDER BY o.id LIMIT $2`, [after, SCAN_PAGE]);
      for (const row of page.rows) {
        const overrides = flagOverrides({ [FLAG_OVERRIDES_KEY]: row.overrides });
        orgs.push({ id: row.id, stored: storedBytes(nodes, asObject(row.flags ?? row.legacy)), overrides: Object.keys(overrides).length ? overrides : null });
      }
      if (page.rows.length < SCAN_PAGE) return orgs;
      after = page.rows[page.rows.length - 1]!.id;
    }
  }
  for (const org of await listOrganizations()) {
    const data = asObject((await readGlobal(text(org.id))).data);
    const overrides = flagOverrides(data);
    orgs.push({ id: text(org.id), stored: storedBytes(nodes, asObject(data.app_flags || data.feature_flags)), overrides: Object.keys(overrides).length ? overrides : null });
  }
  return orgs;
}

/** What resolveCapabilities decides, compiled for one pass per organization. Dependencies come before their dependents. */
function compileDependencies(nodes: NormalizedCapability[]) {
  const position = new Map(nodes.map((node, index) => [node.key, index]));
  const order: number[] = [], seen = new Set<number>();
  const deps = nodes.map((node) => [...(node.parent ? [node.parent] : []), ...node.requires].map((key) => position.get(key)).filter((value): value is number => value !== undefined));
  const visit = (index: number) => { if (seen.has(index)) return; seen.add(index); deps[index]!.forEach(visit); order.push(index); };
  nodes.forEach((_, index) => visit(index));
  return { order, deps };
}

async function computeStats(orgs: OrgRow[], nodes: NormalizedCapability[], rollouts: FlagRollouts) {
  const { order, deps } = compileDependencies(nodes);
  const stats = new Map<string, FlagStats>();
  const counters = nodes.map((node) => { const value = { on: 0, stored_on: 0, explicit_on: 0, explicit_off: 0, percent_added: 0, percent_covered: 0 }; stats.set(node.key, value); return value; });
  const raw = new Uint8Array(nodes.length), effective = new Uint8Array(nodes.length);
  const rolloutFor = nodes.map((node) => rollouts[node.key]);
  for (let orgIndex = 0; orgIndex < orgs.length; orgIndex += 1) {
    if (orgIndex && orgIndex % 2000 === 0) await breathe();
    const org = orgs[orgIndex]!;
    nodes.forEach((node, index) => {
      if (node.type !== "boolean") { raw[index] = 1; return; }
      const stored = org.stored[index];
      const override = org.overrides?.[node.key];
      const rollout = rolloutFor[index];
      const counter = counters[index]!;
      if (stored === STORED_ON) counter.stored_on += 1;
      if (override === true) counter.explicit_on += 1;
      if (override === false) counter.explicit_off += 1;
      if (rollout && percentCovers(rollout.percent, node.key, org.id)) counter.percent_covered += 1;
      const simple = EQUIPMENT_SIMPLE_CAPABILITIES[node.key];
      const { value, source } = simple !== undefined && override === undefined
        ? { value: simple, source: "default" as const }
        : flagValueSource({ key: node.key, orgId: org.id, stored: stored === STORED_UNSET ? undefined : stored === STORED_ON, override, rollout, defaultValue: node.default === true });
      raw[index] = value ? 1 : 0;
      if (source === "percentage") counter.percent_added += 1;
    });
    for (const index of order) {
      let on = raw[index]!;
      for (const dep of deps[index]!) if (!effective[dep]) { on = 0; break; }
      effective[index] = on;
      if (on && nodes[index]!.type === "boolean") counters[index]!.on += 1;
    }
  }
  return stats;
}

async function readSnapshot(fresh = false) {
  const rollouts = await readFlagRollouts(fresh);
  const rolloutsMatch = (value: FlagRollouts) => JSON.stringify(value) === JSON.stringify(rollouts);
  if (!fresh && snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS && rolloutsMatch(snapshot.rollouts)) return snapshot;
  if (scanning) return scanning;
  // A changed percentage changes the counts, not what is stored: no need to read every organization again.
  const reusable = !fresh && snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS ? snapshot : null;
  scanning = (async () => {
    const nodes = valueCapabilities();
    const orgs = reusable ? reusable.orgs : await scanOrganizations(nodes);
    await breathe();
    snapshot = { at: Date.now(), orgs, rollouts, stats: await computeStats(orgs, nodes, rollouts) };
    return snapshot;
  })().finally(() => { scanning = null; });
  return scanning;
}

function forgetSnapshot() { snapshot = null; }

function requireBooleanFlag(key: string) {
  const node = capabilityDefinition(key);
  if (!node?.stores_value) throw notFound("flag_not_found", `There is no flag "${key}".`);
  if (node.type !== "boolean") throw badRequest("flag_not_boolean", `"${key}" is a ${node.type} setting, not an on/off flag.`);
  return node;
}

function flagView(node: NormalizedCapability, rollouts: FlagRollouts) {
  return {
    key: node.key, label: node.label, description: node.description, kind: node.kind, type: node.type, group: node.group, default: node.default,
    parent: node.parent, requires: node.requires, percentage_allowed: node.type === "boolean" && !NO_PERCENTAGE.has(node.key),
    rollout: rollouts[node.key] ?? null
  };
}

/** Every flag with its counts. Only on/off flags are counted; settings carry a value, not on or off. */
export async function listFlags(fresh = false) {
  const current = await readSnapshot(fresh);
  const rules = await readCapabilityCountryRules();
  return {
    total_orgs: current.orgs.length,
    computed_at: current.at,
    flags: valueCapabilities().map((node) => ({
      ...flagView(node, current.rollouts),
      stats: node.type === "boolean" ? current.stats.get(node.key) : null,
      country_rules: rules.filter((rule) => node.key in rule.values).length
    }))
  };
}

/** How many organizations a percentage would cover, without saving it. */
export async function flagCoverage(key: string, percent: number) {
  requireBooleanFlag(key);
  const current = await readSnapshot();
  let covered = 0;
  for (let index = 0; index < current.orgs.length; index += 1) {
    if (index && index % 5000 === 0) await breathe();
    if (percentCovers(percent, key, current.orgs[index]!.id)) covered += 1;
  }
  return { key, percent, covered, total_orgs: current.orgs.length };
}

export async function setFlagRollout(key: string, input: { percent?: number; killed?: boolean; note?: string }, actor: FlagActor) {
  const node = requireBooleanFlag(key);
  if (input.percent !== undefined) {
    if (!Number.isFinite(input.percent) || input.percent < 0 || input.percent > 100) throw badRequest("invalid_percent", "A percentage is from 0 to 100.");
    if (input.percent > 0 && NO_PERCENTAGE.has(key)) throw badRequest("percentage_not_allowed", `"${key}" cannot be rolled out by percentage. Set it per organization.`);
  }
  const { before, after } = await saveFlagRollout(key, (current) => ({
    percent: input.percent === undefined ? (current?.percent ?? 0) : Math.round(input.percent * 100) / 100,
    killed: input.killed === undefined ? (current?.killed ?? false) : input.killed,
    updated_at: new Date().toISOString(), updated_by: actor.label, ...(input.note ? { note: input.note.slice(0, 300) } : {})
  }));
  const shape = (value: typeof before) => ({ percent: value?.percent ?? 0, killed: value?.killed ?? false });
  const coverage = await flagCoverage(key, after?.percent ?? 0);
  const changes = [];
  if (shape(before).percent !== shape(after).percent) changes.push(`percentage ${shape(before).percent}% to ${shape(after).percent}%, covering ${coverage.covered} of ${coverage.total_orgs}`);
  if (shape(before).killed !== shape(after).killed) changes.push(shape(after).killed ? "off for everyone" : "no longer off for everyone");
  const warnings = node.default === true && (after?.percent ?? 0) > 0 ? ["This flag is on by default, so a percentage turns on only organizations with it stored off."] : [];
  if (changes.length) await recordFlagAudit(actor, { action: "rollout", flag_key: key, summary: `${node.label}: ${changes.join("; ")}`, before: shape(before), after: { ...shape(after), covered: coverage.covered, total_orgs: coverage.total_orgs }, note: input.note });
  return { key, rollout: after, coverage, warnings };
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/** Who owns each organization: its first owner, else its first admin, else its first user with an email. */
async function ownerEmails(orgIds: string[]) {
  const owners = new Map<string, string>();
  const rows: Array<{ organization_id: string; email: string; role: string }> = [];
  if (!orgIds.length) return owners;
  if (isFirstMeasurePostgresEnabled()) {
    const result = await queryPostgres<{ organization_id: string; email: string; role: string }>(
      `SELECT organization_id, document #>> '{data,email}' AS email, document #>> '{data,role}' AS role FROM platform_documents WHERE organization_id = ANY($1::text[]) AND collection = 'users'`, [orgIds]);
    rows.push(...result.rows);
  } else {
    for (const id of orgIds) for (const user of await listDocuments(id, "users").catch(() => [])) rows.push({ organization_id: id, email: text(asObject(user.data).email), role: text(asObject(user.data).role) });
  }
  const rank = (role: string) => role === "owner" ? 0 : role === "admin" ? 1 : 2;
  rows.filter((row) => row.email).sort((a, b) => rank(text(a.role).toLowerCase()) - rank(text(b.role).toLowerCase()) || a.email.localeCompare(b.email))
    .forEach((row) => { if (!owners.has(row.organization_id)) owners.set(row.organization_id, row.email.toLowerCase()); });
  return owners;
}

type OrgSummary = { id: string; name: string; status: string; owner_email: string };
async function summarize(orgs: JsonObject[]): Promise<OrgSummary[]> {
  const owners = await ownerEmails(orgs.map((org) => text(org.id)));
  return orgs.map((org) => ({ id: text(org.id), name: text(org.name), status: text(org.status) || "active", owner_email: owners.get(text(org.id)) ?? "" }));
}

const looksLikeEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
async function orgsForEmail(email: string) {
  const identity = await findIdentityByEmail(email).catch(() => null);
  if (!identity) return [];
  return (await listIdentityMemberships(text(identity.id)).catch(() => [])).map((membership) => asObject(membership.organization)).filter((org) => text(org.id));
}
async function orgById(id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(id)) return null;
  return await readOrganization(id).catch(() => null);
}

/** Search by name, id or the email of anyone in the organization. */
export async function searchFlagOrganizations(query: string, limit = 25) {
  const needle = text(query);
  if (!needle) return { organizations: [] as OrgSummary[] };
  const found = new Map<string, JsonObject>();
  const add = (org: JsonObject) => { if (text(org.id) && found.size < limit) found.set(text(org.id), org); };
  const exact = await orgById(needle);
  if (exact) add(exact);
  if (needle.includes("@")) {
    for (const identity of await searchIdentities(needle, 10)) for (const membership of await listIdentityMemberships(text(identity.id)).catch(() => [])) add(asObject(membership.organization));
  }
  for (const org of await searchOrganizations(needle, limit)) add(org);
  return { organizations: await summarize([...found.values()]) };
}

/** Everything the console shows for one organization. */
export async function readOrganizationFlags(orgId: string) {
  const org = await readOrganization(orgId);
  const [summary] = await summarize([org]);
  const data = asObject((await readGlobal(orgId)).data);
  const flags = asObject(data.app_flags || data.feature_flags);
  const overrides = flagOverrides(data);
  const [rollouts, resolution, rules] = await Promise.all([readFlagRollouts(), effectiveCapabilities(orgId), readCapabilityCountryRules()]);
  return {
    organization: summary!,
    flags: valueCapabilities().map((node) => {
      const stored = asObject(flags[node.group])[node.flag];
      const rollout = rollouts[node.key];
      const layered = node.type === "boolean"
        ? flagValueSource({ key: node.key, orgId, stored: stored === undefined ? undefined : stored !== false, override: overrides[node.key], rollout, defaultValue: node.default === true })
        : { value: false, source: "default" as const };
      return {
        ...flagView(node, rollouts),
        value: resolution.values[node.key],
        effective: resolution.effectiveByKey[node.key] === true,
        reason: resolution.reasons[node.key] ?? null,
        source: layered.source,
        stored: stored ?? null,
        explicit: overrides[node.key] ?? null,
        bucket: rollout ? flagBucket(node.key, orgId) / 100 : null,
        country_rules: rules.filter((rule) => node.key in rule.values).length
      };
    })
  };
}

/**
 * Sets one flag on one organization: true or false is an explicit value that beats any percentage; null clears it, so
 * the organization follows the default and any percentage again. Written to app_flags too, for code that reads the
 * stored document directly (for example the expanded access query).
 */
async function writeOrganizationFlag(orgId: string, node: NormalizedCapability, value: boolean | null, actor: FlagActor) {
  let before = { explicit: null as boolean | null, stored: null as unknown }, changed = false;
  await mutateGlobal(orgId, (global) => {
    const data = asObject(global.data);
    const flags = { ...asObject(data.app_flags || data.feature_flags) };
    const group = { ...asObject(flags[node.group]) };
    const overrides = flagOverrides(data);
    before = { explicit: overrides[node.key] ?? null, stored: group[node.flag] ?? null };
    changed = before.explicit !== value;
    if (!changed) return { data: {} };
    if (value === null) { delete overrides[node.key]; delete group[node.flag]; }
    else { overrides[node.key] = value; group[node.flag] = value; }
    flags[node.group] = group;
    return {
      data: { app_flags: flags, [FLAG_OVERRIDES_KEY]: overrides },
      metadata: { app_flags_updated_by_email: actor.label, app_flags_updated_at: new Date().toISOString(), app_flags_source: "flag_console" }
    };
  });
  return { changed, before, after: { explicit: value, stored: value } };
}

function describeValue(value: boolean | null) {
  return value === null ? "follows default and percentage" : value ? "on" : "off";
}

/** The one writer of per-organization flag values: one audit entry however many organizations it touches. */
export async function setFlagForOrganizations(input: { flag: string; value: boolean | null; org_ids: string[]; note?: string }, actor: FlagActor) {
  const node = requireBooleanFlag(input.flag);
  const orgIds = [...new Set(input.org_ids.map(text).filter(Boolean))];
  if (!orgIds.length) throw badRequest("no_organizations", "Choose at least one organization.");
  if (orgIds.length > MAX_BULK_ORGS) throw badRequest("too_many_organizations", `At most ${MAX_BULK_ORGS} organizations at once. Use a percentage for more.`);
  const changes: OrgChange[] = [], failed: Array<{ org_id: string; error: string }> = [];
  let unchanged = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(8, orgIds.length) }, async () => {
    while (next < orgIds.length) {
      const orgId = orgIds[next++]!;
      try {
        const org = await readOrganization(orgId);
        const result = await writeOrganizationFlag(orgId, node, input.value, actor);
        if (result.changed) changes.push({ org_id: orgId, org_name: text(org.name), before: result.before, after: result.after });
        else unchanged += 1;
      } catch (error) {
        failed.push({ org_id: orgId, error: (error as Error).message || "Could not save." });
      }
    }
  }));
  forgetSnapshot();
  let audit_id = "";
  if (changes.length) {
    const only = changes.length === 1 ? ` for ${changes[0]!.org_name || changes[0]!.org_id}` : ` for ${changes.length} organizations`;
    audit_id = await recordFlagAudit(actor, { action: changes.length === 1 ? "set" : "bulk_set", flag_key: node.key, summary: `${node.label}: ${describeValue(input.value)}${only}`, after: { value: input.value }, note: input.note, orgs: changes });
  }
  return { flag: node.key, value: input.value, changed: changes.length, unchanged, failed, audit_id };
}

/**
 * Resolves pasted ids, names and emails. An entry that names one organization exactly is matched; an email in several
 * organizations, a name several share or a partial name is ambiguous and needs choosing; nothing is ever applied here.
 */
export async function resolveOrganizationList(input: string) {
  const entries: string[] = [];
  for (const line of String(input ?? "").split(/\r?\n/)) {
    const whole = line.trim();
    if (!whole) continue;
    // A comma may be a separator or part of a name ("Acme Roofing, LLC"): the whole line is tried first.
    if (whole.includes(",") && (await searchOrganizations(whole, 5)).some((org) => text(org.name).toLowerCase() === whole.toLowerCase())) { entries.push(whole); continue; }
    entries.push(...whole.split(/[,;\t]+/).map((part) => part.trim()).filter(Boolean));
  }
  const unique = [...new Map(entries.map((entry) => [entry.toLowerCase(), entry])).values()];
  if (unique.length > MAX_PASTED_ENTRIES) throw badRequest("too_many_entries", `At most ${MAX_PASTED_ENTRIES} entries at once.`);
  const results: Array<{ input: string; status: "matched" | "ambiguous" | "unmatched"; matched_by: string; organizations: OrgSummary[] }> = new Array(unique.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, async () => {
    while (next < unique.length) {
      const index = next++;
      const entry = unique[index]!;
      let orgs: JsonObject[] = [], matchedBy = "name", exact = true;
      if (looksLikeEmail(entry)) { orgs = await orgsForEmail(entry); matchedBy = "email"; }
      else {
        const byId = await orgById(entry);
        if (byId) { orgs = [byId]; matchedBy = "id"; }
        else {
          const candidates = await searchOrganizations(entry, 10);
          orgs = candidates.filter((org) => text(org.name).toLowerCase() === entry.toLowerCase());
          if (!orgs.length) { orgs = candidates; exact = false; matchedBy = "partial name"; }
        }
      }
      results[index] = { input: entry, status: !orgs.length ? "unmatched" : orgs.length === 1 && exact ? "matched" : "ambiguous", matched_by: orgs.length ? matchedBy : "", organizations: await summarize(orgs) };
    }
  }));
  const count = (status: string) => results.filter((row) => row.status === status).length;
  return { entries: results, matched: count("matched"), ambiguous: count("ambiguous"), unmatched: count("unmatched") };
}
