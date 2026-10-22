import path from "node:path";

import { openSqlStore, type SqlStore } from "../../platform/sql_store.js";
import { env } from "../../src/config/env.js";
import { INDEX_VERSION, type IndexStep, type SessionIndex } from "./indexer.js";

/**
 * The search index over session replays (docs/architecture/session-replay-search.md): one row per session,
 * its behaviour steps, the catalogue of screens and elements, and day-level aggregates kept up to date as
 * sessions are indexed, so questions about many sessions read aggregates and never the recordings.
 * Re-indexing a session first takes its old contribution out of the aggregates.
 */
type Row = Record<string, unknown>;
let database: SqlStore | null = null;
let databasePath = "";
const num = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => String(value ?? "");

export async function closeReplayInsightsDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return await current?.close();
}

export function insightsDb() {
  const nextPath = path.resolve(process.cwd(), env.platformStorageRoot, "session-replay-insights.sqlite");
  if (database && databasePath === nextPath) return database;
  void closeReplayInsightsDatabase();
  // Raise this whenever initialize gains a table or a column: Postgres runs it again only for a higher version.
  database = openSqlStore({ id: "session_replay_insights", schemaVersion: 1, filename: nextPath, initialize });
  databasePath = nextPath;
  return database;
}

async function initialize(store: SqlStore) {
  await store.exec(`
    CREATE TABLE IF NOT EXISTS replay_ix_sessions (
      session_id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT '',
      user_email TEXT NOT NULL DEFAULT '',
      started_at BIGINT NOT NULL,
      ended_at BIGINT NOT NULL,
      duration_ms BIGINT NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      inputs INTEGER NOT NULL DEFAULT 0,
      dialogs INTEGER NOT NULL DEFAULT 0,
      js_errors INTEGER NOT NULL DEFAULT 0,
      ui_errors INTEGER NOT NULL DEFAULT 0,
      rage INTEGER NOT NULL DEFAULT 0,
      dead INTEGER NOT NULL DEFAULT 0,
      screens_json TEXT NOT NULL DEFAULT '[]',
      device_json TEXT NOT NULL DEFAULT '{}',
      search_text TEXT NOT NULL DEFAULT '',
      source_last_at BIGINT NOT NULL DEFAULT 0,
      indexed_at BIGINT NOT NULL DEFAULT 0,
      index_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_replay_ix_sessions_org ON replay_ix_sessions (organization_id, started_at);
    CREATE TABLE IF NOT EXISTS replay_ix_steps (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      organization_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      t BIGINT NOT NULL,
      kind TEXT NOT NULL,
      screen_id TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_replay_ix_steps_target ON replay_ix_steps (organization_id, target_id, t);
    CREATE INDEX IF NOT EXISTS idx_replay_ix_steps_screen ON replay_ix_steps (organization_id, screen_id, kind, t);
    CREATE INDEX IF NOT EXISTS idx_replay_ix_steps_kind ON replay_ix_steps (organization_id, kind, t);
    CREATE TABLE IF NOT EXISTS replay_ix_screens (
      organization_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      screen_key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      url_example TEXT NOT NULL DEFAULT '',
      first_seen BIGINT NOT NULL,
      last_seen BIGINT NOT NULL,
      PRIMARY KEY (organization_id, screen_id)
    );
    CREATE TABLE IF NOT EXISTS replay_ix_targets (
      organization_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      first_seen BIGINT NOT NULL,
      last_seen BIGINT NOT NULL,
      PRIMARY KEY (organization_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS replay_ix_screen_stats (
      organization_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      day TEXT NOT NULL,
      visits INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      total_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, screen_id, day)
    );
    CREATE TABLE IF NOT EXISTS replay_ix_target_stats (
      organization_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      day TEXT NOT NULL,
      clicks INTEGER NOT NULL DEFAULT 0,
      sessions INTEGER NOT NULL DEFAULT 0,
      dead INTEGER NOT NULL DEFAULT 0,
      rage INTEGER NOT NULL DEFAULT 0,
      errors_after INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, screen_id, target_id, day)
    );
    CREATE TABLE IF NOT EXISTS replay_ix_transitions (
      organization_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      from_target TEXT NOT NULL,
      to_target TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      total_ms BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (organization_id, screen_id, from_target, to_target, day)
    );
  `);
  if (store.isPostgres) {
    await store.exec(`CREATE INDEX IF NOT EXISTS idx_replay_ix_sessions_search ON replay_ix_sessions USING GIN (to_tsvector('simple', search_text));`);
  }
}

export const ENTRY = "^";
export const EXIT = "$";
const ERROR_AFTER_MS = 3000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

type Contribution = {
  screens: Map<string, { screen_id: string; day: string; visits: number; sessions: number; total_ms: number }>;
  targets: Map<string, { screen_id: string; target_id: string; day: string; clicks: number; sessions: number; dead: number; rage: number; errors_after: number }>;
  transitions: Map<string, { screen_id: string; from_target: string; to_target: string; day: string; count: number; total_ms: number }>;
};

/** What one session adds to the aggregates; derived from its steps alone so it can be taken back out. */
export function contribution(steps: Array<Pick<IndexStep, "t" | "kind" | "screen_id" | "target_id" | "detail">>): Contribution {
  const out: Contribution = { screens: new Map(), targets: new Map(), transitions: new Map() };
  const seenScreen = new Set<string>(), seenTarget = new Set<string>();
  let visitScreen = "", lastClick: { target: string; t: number } | null = null;
  const transition = (screen: string, from: string, to: string, t: number, ms: number) => {
    const key = [screen, from, to, day(t)].join("|");
    const row = out.transitions.get(key) || { screen_id: screen, from_target: from, to_target: to, day: day(t), count: 0, total_ms: 0 };
    row.count++; row.total_ms += Math.max(0, ms);
    out.transitions.set(key, row);
  };
  const closeVisit = () => { if (visitScreen && lastClick) transition(visitScreen, lastClick.target, EXIT, lastClick.t, 0); lastClick = null; };
  const targetRow = (screen: string, target: string, t: number) => {
    const key = [screen, target, day(t)].join("|");
    let row = out.targets.get(key);
    if (!row) { row = { screen_id: screen, target_id: target, day: day(t), clicks: 0, sessions: 0, dead: 0, rage: 0, errors_after: 0 }; out.targets.set(key, row); }
    if (!seenTarget.has(key)) { seenTarget.add(key); row.sessions = 1; }
    return row;
  };
  const clicks: Array<{ t: number; screen: string; target: string }> = [];
  for (const step of steps) {
    if (step.kind === "screen") {
      closeVisit();
      visitScreen = step.screen_id;
      const key = [step.screen_id, day(step.t)].join("|");
      const row = out.screens.get(key) || { screen_id: step.screen_id, day: day(step.t), visits: 0, sessions: 0, total_ms: 0 };
      row.visits++; row.total_ms += num((step.detail || {}).ms);
      if (!seenScreen.has(key)) { seenScreen.add(key); row.sessions = 1; }
      out.screens.set(key, row);
    } else if (step.kind === "click" && step.target_id) {
      const row = targetRow(step.screen_id, step.target_id, step.t);
      row.clicks++;
      if ((step.detail || {}).dead) row.dead++;
      if (step.screen_id === visitScreen) {
        const previous: { target: string; t: number } | null = lastClick;
        transition(visitScreen, previous ? previous.target : ENTRY, step.target_id, step.t, previous ? step.t - previous.t : 0);
        lastClick = { target: step.target_id, t: step.t };
      }
      clicks.push({ t: step.t, screen: step.screen_id, target: step.target_id });
    } else if (step.kind === "rage" && step.target_id) {
      targetRow(step.screen_id, step.target_id, step.t).rage++;
    } else if (step.kind === "ui_error" || step.kind === "js_error") {
      const cause = [...clicks].reverse().find((c) => c.screen === step.screen_id && step.t - c.t <= ERROR_AFTER_MS && step.t >= c.t);
      if (cause) targetRow(cause.screen, cause.target, cause.t).errors_after++;
    }
  }
  closeVisit();
  return out;
}

async function applyContribution(tx: SqlStore, organizationId: string, c: Contribution, sign: 1 | -1) {
  for (const r of c.screens.values()) {
    await tx.prepare(`INSERT INTO replay_ix_screen_stats (organization_id, screen_id, day, visits, sessions, total_ms) VALUES (?,?,?,?,?,?)
      ON CONFLICT (organization_id, screen_id, day) DO UPDATE SET visits=replay_ix_screen_stats.visits+excluded.visits,
      sessions=replay_ix_screen_stats.sessions+excluded.sessions, total_ms=replay_ix_screen_stats.total_ms+excluded.total_ms`)
      .run(organizationId, r.screen_id, r.day, sign * r.visits, sign * r.sessions, sign * r.total_ms);
  }
  for (const r of c.targets.values()) {
    await tx.prepare(`INSERT INTO replay_ix_target_stats (organization_id, screen_id, target_id, day, clicks, sessions, dead, rage, errors_after) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (organization_id, screen_id, target_id, day) DO UPDATE SET clicks=replay_ix_target_stats.clicks+excluded.clicks,
      sessions=replay_ix_target_stats.sessions+excluded.sessions, dead=replay_ix_target_stats.dead+excluded.dead,
      rage=replay_ix_target_stats.rage+excluded.rage, errors_after=replay_ix_target_stats.errors_after+excluded.errors_after`)
      .run(organizationId, r.screen_id, r.target_id, r.day, sign * r.clicks, sign * r.sessions, sign * r.dead, sign * r.rage, sign * r.errors_after);
  }
  for (const r of c.transitions.values()) {
    await tx.prepare(`INSERT INTO replay_ix_transitions (organization_id, screen_id, from_target, to_target, day, count, total_ms) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (organization_id, screen_id, from_target, to_target, day) DO UPDATE SET count=replay_ix_transitions.count+excluded.count,
      total_ms=replay_ix_transitions.total_ms+excluded.total_ms`)
      .run(organizationId, r.screen_id, r.from_target, r.to_target, r.day, sign * r.count, sign * r.total_ms);
  }
}

export type IndexedSessionMeta = {
  session_id: string;
  organization_id: string;
  user_id: string;
  user_email: string;
  pages: number;
  device: Record<string, unknown>;
  source_last_at: number;
};

/** Replaces a session's index rows and moves the aggregates from its old contribution to its new one. */
export async function saveSessionIndex(meta: IndexedSessionMeta, index: SessionIndex) {
  const db = insightsDb();
  await db.transaction(async (tx) => {
    const old = await tx.prepare("SELECT t, kind, screen_id, target_id, detail_json FROM replay_ix_steps WHERE session_id=? ORDER BY seq").all(meta.session_id);
    if (old.length) {
      await applyContribution(tx, meta.organization_id, contribution(old.map((r) => ({ t: num(r.t), kind: text(r.kind) as IndexStep["kind"], screen_id: text(r.screen_id), target_id: text(r.target_id), detail: parseJson(r.detail_json) }))), -1);
      await tx.prepare("DELETE FROM replay_ix_steps WHERE session_id=?").run(meta.session_id);
    }
    for (let i = 0; i < index.steps.length; i += 100) {
      const batch = index.steps.slice(i, i + 100);
      const values: (string | number)[] = [];
      for (const s of batch) values.push(meta.session_id, s.seq, meta.organization_id, s.page_id, Math.round(s.t), s.kind, s.screen_id, s.target_id, s.outcome, JSON.stringify(s.detail));
      await tx.prepare(`INSERT INTO replay_ix_steps (session_id, seq, organization_id, page_id, t, kind, screen_id, target_id, outcome, detail_json) VALUES ${batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(",")}`).run(...values);
    }
    for (const s of index.screens.values()) {
      await tx.prepare(`INSERT INTO replay_ix_screens (organization_id, screen_id, screen_key, label, url_example, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (organization_id, screen_id) DO UPDATE SET last_seen=excluded.last_seen, label=excluded.label`)
        .run(meta.organization_id, s.screen_id, s.screen_key, s.label, s.url.slice(0, 1000), index.started_at, index.ended_at);
    }
    for (const t of index.targets.values()) {
      await tx.prepare(`INSERT INTO replay_ix_targets (organization_id, target_id, role, label, path, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (organization_id, target_id) DO UPDATE SET last_seen=excluded.last_seen`)
        .run(meta.organization_id, t.target_id, t.role, t.label, t.path.slice(0, 500), index.started_at, index.ended_at);
    }
    await applyContribution(tx, meta.organization_id, contribution(index.steps), 1);
    const c = index.counts;
    await tx.prepare(`INSERT INTO replay_ix_sessions (session_id, organization_id, user_id, user_email, started_at, ended_at, duration_ms, pages, steps, clicks, inputs, dialogs,
        js_errors, ui_errors, rage, dead, screens_json, device_json, search_text, source_last_at, indexed_at, index_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (session_id) DO UPDATE SET ended_at=excluded.ended_at, duration_ms=excluded.duration_ms, pages=excluded.pages, steps=excluded.steps,
        clicks=excluded.clicks, inputs=excluded.inputs, dialogs=excluded.dialogs, js_errors=excluded.js_errors, ui_errors=excluded.ui_errors, rage=excluded.rage,
        dead=excluded.dead, screens_json=excluded.screens_json, device_json=excluded.device_json, search_text=excluded.search_text,
        source_last_at=excluded.source_last_at, indexed_at=excluded.indexed_at, index_version=excluded.index_version`)
      .run(meta.session_id, meta.organization_id, meta.user_id, meta.user_email, Math.round(index.started_at), Math.round(index.ended_at),
        Math.max(0, Math.round(index.ended_at - index.started_at)), meta.pages, index.steps.length, c.clicks, c.inputs, c.dialogs, c.js_errors, c.ui_errors,
        c.rage, c.dead, JSON.stringify([...index.screens.keys()]), JSON.stringify(meta.device || {}), index.searchText, Math.round(meta.source_last_at),
        Date.now(), INDEX_VERSION);
  }, "session:" + meta.session_id);
}

/** Which of these sessions need indexing: never indexed, recorded more since, or indexed by an older indexer. */
export async function staleSessions(candidates: Array<{ id: string; last_at: number }>) {
  if (!candidates.length) return [];
  const rows = await insightsDb().prepare(`SELECT session_id, source_last_at, index_version FROM replay_ix_sessions WHERE session_id IN (${candidates.map(() => "?").join(",")})`)
    .all(...candidates.map((c) => c.id));
  const known = new Map(rows.map((r) => [text(r.session_id), r]));
  return candidates.filter((c) => {
    const row = known.get(c.id);
    return !row || num(row.source_last_at) < c.last_at || num(row.index_version) < INDEX_VERSION;
  });
}

export async function deleteSessionIndex(sessionId: string) {
  await insightsDb().transaction(async (tx) => {
    const session = await tx.prepare("SELECT organization_id FROM replay_ix_sessions WHERE session_id=?").get(sessionId);
    if (!session) return;
    const old = await tx.prepare("SELECT t, kind, screen_id, target_id, detail_json FROM replay_ix_steps WHERE session_id=? ORDER BY seq").all(sessionId);
    await applyContribution(tx, text(session.organization_id), contribution(old.map((r) => ({ t: num(r.t), kind: text(r.kind) as IndexStep["kind"], screen_id: text(r.screen_id), target_id: text(r.target_id), detail: parseJson(r.detail_json) }))), -1);
    await tx.prepare("DELETE FROM replay_ix_steps WHERE session_id=?").run(sessionId);
    await tx.prepare("DELETE FROM replay_ix_sessions WHERE session_id=?").run(sessionId);
  }, "session:" + sessionId);
}

export function parseJson(value: unknown): Record<string, unknown> {
  try { return value ? JSON.parse(String(value)) : {}; } catch { return {}; }
}
export type { Row };
