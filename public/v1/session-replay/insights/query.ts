import { gunzipSync } from "node:zlib";

import { listReplaySessions, readReplayChunks, readReplaySession, replayStorageTotals } from "../storage.js";
import { Codec, Model } from "./library.js";
import { ENTRY, EXIT, insightsDb, parseJson } from "./store.js";

/**
 * Questions over many recorded sessions, answered from the search index (docs/architecture/session-replay-search.md).
 * Every function takes plain JSON and returns plain JSON sized for a language model's context: ids to follow
 * up with, labels people would recognise, counts, and example moments to open.
 */
type Row = Record<string, unknown>;
type Filter = { org_id?: string; from?: string | number; to?: string | number };
const num = (value: unknown) => Number(value ?? 0) || 0;
const text = (value: unknown) => String(value ?? "");
const DAY_MS = 86400000;

function range(filter: Filter) {
  const parse = (value: string | number | undefined, fallback: number) => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    if (Number.isFinite(n) && n > 1e11) return n;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const to = parse(filter.to, Date.now() + DAY_MS);
  const from = parse(filter.from, to - 90 * DAY_MS);
  return { from, to, fromDay: new Date(from).toISOString().slice(0, 10), toDay: new Date(to).toISOString().slice(0, 10) };
}

function where(parts: Array<[string, unknown] | false | undefined | null>) {
  const clauses: string[] = [], values: unknown[] = [];
  for (const part of parts) if (part) { clauses.push(part[0]); if (part[1] !== undefined) values.push(...(Array.isArray(part[1]) ? part[1] : [part[1]])); }
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", values: values as (string | number)[] };
}

const inList = (column: string, ids: string[]): [string, unknown] => [`${column} IN (${ids.map(() => "?").join(",")})`, ids];

async function screenLabels(ids: string[]) {
  const out = new Map<string, { label: string; key: string }>();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 400) {
    const slice = unique.slice(i, i + 400);
    const rows = await insightsDb().prepare(`SELECT screen_id, label, screen_key FROM replay_ix_screens WHERE screen_id IN (${slice.map(() => "?").join(",")})`).all(...slice);
    for (const r of rows) if (!out.has(text(r.screen_id))) out.set(text(r.screen_id), { label: text(r.label), key: text(r.screen_key) });
  }
  return out;
}

async function targetLabels(ids: string[]) {
  const out = new Map<string, { label: string; role: string; path: string }>();
  const unique = [...new Set(ids.filter((id) => id && id !== ENTRY && id !== EXIT))];
  for (let i = 0; i < unique.length; i += 400) {
    const slice = unique.slice(i, i + 400);
    const rows = await insightsDb().prepare(`SELECT target_id, label, role, path FROM replay_ix_targets WHERE target_id IN (${slice.map(() => "?").join(",")})`).all(...slice);
    for (const r of rows) if (!out.has(text(r.target_id))) out.set(text(r.target_id), { label: text(r.label), role: text(r.role), path: text(r.path) });
  }
  return out;
}
const describeTarget = (labels: Map<string, { label: string; role: string; path: string }>, id: string) =>
  id === ENTRY ? "(entered the screen)" : id === EXIT ? "(left the screen / no more clicks)" : (() => { const t = labels.get(id); return t ? `${t.role} "${t.label || "(no label)"}"` : id; })();

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export async function overview(input: Filter) {
  const r = range(input);
  const w = where([input.org_id ? ["organization_id=?", input.org_id] : null, ["started_at>=?", r.from], ["started_at<?", r.to]]);
  const totals = await insightsDb().prepare(`SELECT COUNT(*) AS sessions, COUNT(DISTINCT user_id) AS people, SUM(duration_ms) AS ms, SUM(clicks) AS clicks, SUM(inputs) AS inputs,
    SUM(js_errors) AS js_errors, SUM(ui_errors) AS ui_errors, SUM(rage) AS rage, SUM(dead) AS dead, SUM(dialogs) AS dialogs FROM replay_ix_sessions ${w.sql}`).get(...w.values) || {};
  const sw = where([input.org_id ? ["organization_id=?", input.org_id] : null, ["day>=?", r.fromDay], ["day<=?", r.toDay]]);
  const screens = await insightsDb().prepare(`SELECT screen_id, SUM(visits) AS visits, SUM(sessions) AS sessions, SUM(total_ms) AS total_ms FROM replay_ix_screen_stats ${sw.sql}
    GROUP BY screen_id ORDER BY SUM(sessions) DESC LIMIT 12`).all(...sw.values);
  const labels = await screenLabels(screens.map((s) => text(s.screen_id)));
  const storage = await replayStorageTotals();
  const recorded = storage.filter((o) => !input.org_id || o.organization_id === input.org_id).reduce((sum, o) => sum + o.sessions, 0);
  const indexed = num((await insightsDb().prepare(`SELECT COUNT(*) AS n FROM replay_ix_sessions ${input.org_id ? "WHERE organization_id=?" : ""}`).get(...(input.org_id ? [input.org_id] : [])))?.n);
  return {
    period: { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString() },
    sessions: num(totals.sessions), people: num(totals.people), recorded_hours: Math.round(num(totals.ms) / 36000) / 100,
    clicks: num(totals.clicks), field_edits: num(totals.inputs), dialogs_opened: num(totals.dialogs),
    friction: { rage_clicks: num(totals.rage), dead_clicks: num(totals.dead), on_screen_errors: num(totals.ui_errors), script_errors: num(totals.js_errors) },
    top_screens: screens.map((s) => ({ screen_id: text(s.screen_id), label: labels.get(text(s.screen_id))?.label || "", sessions: num(s.sessions), visits: num(s.visits), avg_seconds: num(s.visits) ? Math.round(num(s.total_ms) / num(s.visits) / 100) / 10 : 0 })),
    index_coverage: { recorded_sessions: recorded, indexed_sessions: indexed }
  };
}

export async function screens(input: Filter & { query?: string; limit?: number }) {
  const r = range(input);
  let ids: string[] | null = null;
  if (input.query) {
    const like = `%${String(input.query).toLowerCase()}%`;
    const rows = await insightsDb().prepare(`SELECT DISTINCT screen_id FROM replay_ix_screens WHERE (LOWER(label) LIKE ? OR LOWER(screen_key) LIKE ?) ${input.org_id ? "AND organization_id=?" : ""} LIMIT 500`)
      .all(like, like, ...(input.org_id ? [input.org_id] : []));
    ids = rows.map((row) => text(row.screen_id));
    if (!ids.length) return { screens: [] };
  }
  const w = where([input.org_id ? ["organization_id=?", input.org_id] : null, ["day>=?", r.fromDay], ["day<=?", r.toDay], ids ? inList("screen_id", ids) : null]);
  const rows = await insightsDb().prepare(`SELECT screen_id, SUM(visits) AS visits, SUM(sessions) AS sessions, SUM(total_ms) AS total_ms FROM replay_ix_screen_stats ${w.sql}
    GROUP BY screen_id ORDER BY SUM(sessions) DESC LIMIT ${Math.min(200, Math.max(1, num(input.limit) || 30))}`).all(...w.values);
  const labels = await screenLabels(rows.map((s) => text(s.screen_id)));
  return { screens: rows.map((s) => ({ screen_id: text(s.screen_id), label: labels.get(text(s.screen_id))?.label || "", url_pattern: labels.get(text(s.screen_id))?.key || "",
    sessions: num(s.sessions), visits: num(s.visits), avg_seconds: num(s.visits) ? Math.round(num(s.total_ms) / num(s.visits) / 100) / 10 : 0 })) };
}

const TARGET_SORTS: Record<string, string> = { clicks: "SUM(clicks)", sessions: "SUM(sessions)", dead: "SUM(dead)", rage: "SUM(rage)", errors_after: "SUM(errors_after)" };

export async function targets(input: Filter & { screen_id?: string; query?: string; role?: string; sort?: string; limit?: number }) {
  const r = range(input);
  let ids: string[] | null = null;
  if (input.query || input.role) {
    const parts: Array<[string, unknown] | null> = [
      input.query ? ["LOWER(label) LIKE ?", `%${String(input.query).toLowerCase()}%`] : null,
      input.role ? ["role=?", input.role] : null,
      input.org_id ? ["organization_id=?", input.org_id] : null
    ];
    const w0 = where(parts);
    ids = (await insightsDb().prepare(`SELECT DISTINCT target_id FROM replay_ix_targets ${w0.sql} LIMIT 800`).all(...w0.values)).map((row) => text(row.target_id));
    if (!ids.length) return { targets: [] };
  }
  const w = where([input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null,
    ["day>=?", r.fromDay], ["day<=?", r.toDay], ids ? inList("target_id", ids) : null]);
  const order = TARGET_SORTS[input.sort || "clicks"] || TARGET_SORTS.clicks;
  const rows = await insightsDb().prepare(`SELECT target_id, SUM(clicks) AS clicks, SUM(sessions) AS sessions, SUM(dead) AS dead, SUM(rage) AS rage, SUM(errors_after) AS errors_after
    FROM replay_ix_target_stats ${w.sql} GROUP BY target_id ORDER BY ${order} DESC LIMIT ${Math.min(200, Math.max(1, num(input.limit) || 30))}`).all(...w.values);
  const targetIds = rows.map((row) => text(row.target_id));
  const next = targetIds.length ? await (async () => {
    const tw = where([input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null,
      ["day>=?", r.fromDay], ["day<=?", r.toDay], inList("from_target", targetIds)]);
    return await insightsDb().prepare(`SELECT from_target, to_target, SUM(count) AS n FROM replay_ix_transitions ${tw.sql} GROUP BY from_target, to_target`).all(...tw.values);
  })() : [];
  const labels = await targetLabels([...targetIds, ...next.map((row) => text(row.to_target))]);
  return {
    targets: rows.map((row) => {
      const id = text(row.target_id), t = labels.get(id);
      const followers = next.filter((n) => text(n.from_target) === id).sort((a, b) => num(b.n) - num(a.n)).slice(0, 3);
      return {
        target_id: id, role: t?.role || "", label: t?.label || "", path: t?.path || "",
        clicks: num(row.clicks), sessions: num(row.sessions), dead_clicks: num(row.dead), rage_clicks: num(row.rage), errors_within_3s: num(row.errors_after),
        then: followers.map((n) => ({ target_id: text(n.to_target), what: describeTarget(labels, text(n.to_target)), times: num(n.n) }))
      };
    })
  };
}

export async function target(input: Filter & { target_id: string }) {
  const r = range(input);
  const w = where([["target_id=?", input.target_id], input.org_id ? ["organization_id=?", input.org_id] : null, ["day>=?", r.fromDay], ["day<=?", r.toDay]]);
  const byScreen = await insightsDb().prepare(`SELECT screen_id, SUM(clicks) AS clicks, SUM(sessions) AS sessions, SUM(dead) AS dead, SUM(rage) AS rage, SUM(errors_after) AS errors_after
    FROM replay_ix_target_stats ${w.sql} GROUP BY screen_id ORDER BY SUM(clicks) DESC LIMIT 20`).all(...w.values);
  const labels = await targetLabels([input.target_id]);
  const screensById = await screenLabels(byScreen.map((row) => text(row.screen_id)));
  const sw = where([["target_id=?", input.target_id], ["kind=?", "click"], input.org_id ? ["organization_id=?", input.org_id] : null, ["t>=?", r.from], ["t<?", r.to]]);
  const outcomes = await insightsDb().prepare(`SELECT outcome, COUNT(*) AS n FROM replay_ix_steps ${sw.sql} GROUP BY outcome`).all(...sw.values);
  return {
    target_id: input.target_id, ...(labels.get(input.target_id) || { label: "", role: "", path: "" }),
    outcomes: Object.fromEntries(outcomes.map((row) => [text(row.outcome) || "unknown", num(row.n)])),
    by_screen: byScreen.map((row) => ({ screen_id: text(row.screen_id), screen: screensById.get(text(row.screen_id))?.label || "", clicks: num(row.clicks), sessions: num(row.sessions),
      dead_clicks: num(row.dead), rage_clicks: num(row.rage), errors_within_3s: num(row.errors_after) })),
    outcome_meaning: { navigated: "the URL changed", dialog: "a dialog opened", error: "an error message appeared", changed: "the page changed", toggled: "a field value changed", focus: "a field took focus", none: "nothing changed within 1.5 s (a dead click)" }
  };
}

export async function next(input: Filter & { target_id: string; screen_id?: string; limit?: number }) {
  const r = range(input);
  const w = where([["from_target=?", input.target_id], input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null,
    ["day>=?", r.fromDay], ["day<=?", r.toDay]]);
  const rows = await insightsDb().prepare(`SELECT to_target, SUM(count) AS n, SUM(total_ms) AS ms FROM replay_ix_transitions ${w.sql} GROUP BY to_target ORDER BY SUM(count) DESC
    LIMIT ${Math.min(50, Math.max(1, num(input.limit) || 10))}`).all(...w.values);
  const pw = where([["to_target=?", input.target_id], input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null,
    ["day>=?", r.fromDay], ["day<=?", r.toDay]]);
  const before = await insightsDb().prepare(`SELECT from_target, SUM(count) AS n FROM replay_ix_transitions ${pw.sql} GROUP BY from_target ORDER BY SUM(count) DESC LIMIT 10`).all(...pw.values);
  const labels = await targetLabels([input.target_id, ...rows.map((row) => text(row.to_target)), ...before.map((row) => text(row.from_target))]);
  const total = rows.reduce((sum, row) => sum + num(row.n), 0) || 1;
  return {
    target: describeTarget(labels, input.target_id),
    next_clicks: rows.map((row) => ({ target_id: text(row.to_target), what: describeTarget(labels, text(row.to_target)), share: Math.round((num(row.n) / total) * 1000) / 10,
      times: num(row.n), avg_seconds_between: text(row.to_target) === EXIT || !num(row.n) ? null : Math.round(num(row.ms) / num(row.n) / 100) / 10 })),
    previous_clicks: before.map((row) => ({ target_id: text(row.from_target), what: describeTarget(labels, text(row.from_target)), times: num(row.n) }))
  };
}

/** Most common click sequences on a screen, from where people enter it or from one element. */
export async function flows(input: Filter & { screen_id: string; start_target_id?: string; length?: number; limit?: number; max_steps_scanned?: number }) {
  const r = range(input);
  const length = Math.min(8, Math.max(2, num(input.length) || 4));
  const w = where([["screen_id=?", input.screen_id], inList("kind", ["screen", "click"]), input.org_id ? ["organization_id=?", input.org_id] : null, ["t>=?", r.from], ["t<?", r.to]]);
  const cap = Math.min(500000, Math.max(1000, num(input.max_steps_scanned) || 200000));
  const rows = await insightsDb().prepare(`SELECT session_id, seq, t, kind, target_id FROM replay_ix_steps ${w.sql} ORDER BY session_id, seq LIMIT ${cap}`).all(...w.values);
  const counts = new Map<string, { n: number; sessions: Set<string>; ms: number[] }>();
  let visit: Array<{ target: string; t: number }> = [], session = "", visits = 0;
  const flush = () => {
    if (!visit.length) return;
    visits++;
    const seq = [{ target: ENTRY, t: visit[0]!.t }, ...visit, { target: EXIT, t: visit[visit.length - 1]!.t }];
    const starts = input.start_target_id ? seq.map((s, i) => (s.target === input.start_target_id ? i : -1)).filter((i) => i >= 0) : [0];
    for (const start of starts) {
      const path = seq.slice(start, start + length);
      if (path.length < 2) continue;
      const key = path.map((s) => s.target).join(">");
      const entry = counts.get(key) || { n: 0, sessions: new Set<string>(), ms: [] };
      entry.n++; entry.sessions.add(session); entry.ms.push(path[path.length - 1]!.t - path[0]!.t);
      counts.set(key, entry);
    }
    visit = [];
  };
  for (const row of rows) {
    if (text(row.session_id) !== session) { flush(); session = text(row.session_id); }
    if (row.kind === "screen") { flush(); continue; }
    visit.push({ target: text(row.target_id), t: num(row.t) });
  }
  flush();
  const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, Math.min(50, Math.max(1, num(input.limit) || 15)));
  const labels = await targetLabels(top.flatMap(([key]) => key.split(">")));
  const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
  return {
    screen_id: input.screen_id, visits_with_clicks: visits, steps_scanned: rows.length, truncated: rows.length >= cap,
    paths: top.map(([key, value]) => ({ steps: key.split(">").map((id) => ({ target_id: id, what: describeTarget(labels, id) })), times: value.n, sessions: value.sessions.size, median_seconds: Math.round(median(value.ms) / 100) / 10 }))
  };
}

/** Where people struggle: rage and dead clicks, errors after clicks, error messages and script errors. */
export async function friction(input: Filter & { screen_id?: string; limit?: number }) {
  const r = range(input);
  const limit = Math.min(50, Math.max(1, num(input.limit) || 10));
  const statsWhere = where([input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null, ["day>=?", r.fromDay], ["day<=?", r.toDay]]);
  const byTarget = await insightsDb().prepare(`SELECT target_id, screen_id, SUM(clicks) AS clicks, SUM(sessions) AS sessions, SUM(dead) AS dead, SUM(rage) AS rage, SUM(errors_after) AS errors_after
    FROM replay_ix_target_stats ${statsWhere.sql} GROUP BY target_id, screen_id HAVING SUM(dead) > 0 OR SUM(rage) > 0 OR SUM(errors_after) > 0 LIMIT 5000`).all(...statsWhere.values);
  const stepWhere = where([inList("kind", ["ui_error", "js_error"]), input.org_id ? ["organization_id=?", input.org_id] : null, input.screen_id ? ["screen_id=?", input.screen_id] : null, ["t>=?", r.from], ["t<?", r.to]]);
  const errors = await insightsDb().prepare(`SELECT session_id, t, kind, screen_id, detail_json FROM replay_ix_steps ${stepWhere.sql} ORDER BY t DESC LIMIT 20000`).all(...stepWhere.values);
  const grouped = new Map<string, { kind: string; message: string; n: number; sessions: Set<string>; screens: Set<string>; example: { session_id: string; t: number } }>();
  for (const row of errors) {
    const detail = parseJson(row.detail_json);
    const key = text(row.kind) + ":" + text(detail.key || detail.message);
    const entry = grouped.get(key) || { kind: text(row.kind), message: text(detail.message), n: 0, sessions: new Set<string>(), screens: new Set<string>(), example: { session_id: text(row.session_id), t: num(row.t) } };
    entry.n++; entry.sessions.add(text(row.session_id)); entry.screens.add(text(row.screen_id));
    grouped.set(key, entry);
  }
  const labels = await targetLabels(byTarget.map((row) => text(row.target_id)));
  const screensById = await screenLabels([...byTarget.map((row) => text(row.screen_id)), ...[...grouped.values()].flatMap((g) => [...g.screens])]);
  const row = (x: Row) => ({ target_id: text(x.target_id), what: describeTarget(labels, text(x.target_id)), screen_id: text(x.screen_id), screen: screensById.get(text(x.screen_id))?.label || "",
    clicks: num(x.clicks), sessions: num(x.sessions), dead_clicks: num(x.dead), dead_rate: num(x.clicks) ? Math.round((num(x.dead) / num(x.clicks)) * 100) / 100 : 0, rage_clicks: num(x.rage), errors_within_3s: num(x.errors_after) });
  const sorted = (key: string) => byTarget.filter((x) => num(x[key]) > 0).sort((a, b) => num(b[key]) - num(a[key])).slice(0, limit).map(row);
  const messages = (kind: string) => [...grouped.values()].filter((g) => g.kind === kind).sort((a, b) => b.n - a.n).slice(0, limit)
    .map((g) => ({ message: g.message, times: g.n, sessions: g.sessions.size, screens: [...g.screens].map((s) => screensById.get(s)?.label || s).slice(0, 5), example: g.example }));
  return {
    rage_clicks: sorted("rage"), dead_clicks: sorted("dead"), clicks_followed_by_errors: sorted("errors_after"),
    on_screen_errors: messages("ui_error"), script_errors: messages("js_error"),
    note: "Dead click: nothing on the page changed within 1.5 s. Rage click: 3+ clicks on the same element within 1 s. Errors within 3 s are on-screen error messages or script errors that followed a click on the same screen."
  };
}

export async function findSessions(input: Filter & { user?: string; screen_id?: string; target_ids?: string[]; ordered?: boolean; has?: string[]; text?: string; min_seconds?: number; limit?: number; order?: string }) {
  const r = range(input);
  const db = insightsDb();
  const HAS: Record<string, string> = { rage: "rage>0", dead: "dead>0", ui_error: "ui_errors>0", js_error: "js_errors>0", dialog: "dialogs>0", input: "inputs>0" };
  const parts: Array<[string, unknown] | null> = [
    input.org_id ? ["organization_id=?", input.org_id] : null, ["started_at>=?", r.from], ["started_at<?", r.to],
    input.user ? ["LOWER(user_email) LIKE ?", `%${String(input.user).toLowerCase()}%`] : null,
    input.screen_id ? ["screens_json LIKE ?", `%"${input.screen_id}"%`] : null,
    input.min_seconds ? ["duration_ms>=?", num(input.min_seconds) * 1000] : null,
    ...(input.has || []).filter((k) => HAS[k]).map((k) => [HAS[k], undefined] as [string, unknown])
  ];
  if (input.text) parts.push(db.isPostgres ? ["to_tsvector('simple', search_text) @@ websearch_to_tsquery('simple', ?)", input.text] : ["1=1", undefined]);
  let candidateIds: string[] | null = null;
  const targetIds = (input.target_ids || []).filter(Boolean).slice(0, 10);
  if (targetIds.length) {
    const w = where([inList("target_id", targetIds), ["kind=?", "click"], input.org_id ? ["organization_id=?", input.org_id] : null, ["t>=?", r.from], ["t<?", r.to]]);
    const rows = await db.prepare(`SELECT session_id, target_id, MIN(t) AS first_t FROM replay_ix_steps ${w.sql} GROUP BY session_id, target_id LIMIT 200000`).all(...w.values);
    const bySession = new Map<string, Map<string, number>>();
    for (const row of rows) { const m = bySession.get(text(row.session_id)) || new Map(); m.set(text(row.target_id), num(row.first_t)); bySession.set(text(row.session_id), m); }
    candidateIds = [...bySession.entries()].filter(([, m]) => targetIds.every((id) => m.has(id))
      && (!input.ordered || targetIds.every((id, i) => i === 0 || (m.get(targetIds[i - 1]!) ?? Infinity) <= (m.get(id) ?? -Infinity)))).map(([id]) => id);
    if (!candidateIds.length) return { sessions: [], matched: 0 };
    parts.push(inList("session_id", candidateIds.slice(0, 5000)));
  }
  const w = where(parts);
  const random = input.order === "random";
  const limit = Math.min(100, Math.max(1, num(input.limit) || 20));
  let rows = await db.prepare(`SELECT session_id, organization_id, user_email, started_at, duration_ms, pages, clicks, inputs, dialogs, js_errors, ui_errors, rage, dead, screens_json, search_text
    FROM replay_ix_sessions ${w.sql} ORDER BY started_at DESC LIMIT ${random || input.text ? 2000 : limit}`).all(...w.values);
  if (input.text && !db.isPostgres) {
    const words = String(input.text).toLowerCase().split(/\s+/).filter(Boolean);
    rows = rows.filter((row) => { const body = text(row.search_text).toLowerCase(); return words.every((word) => body.includes(word)); });
  }
  const matched = rows.length;
  if (random) rows = rows.map((row) => ({ row, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.row);
  rows = rows.slice(0, limit);
  const labels = await screenLabels(rows.flatMap((row) => JSON.parse(text(row.screens_json) || "[]") as string[]));
  return {
    matched,
    sessions: rows.map((row) => ({
      session_id: text(row.session_id), organization_id: text(row.organization_id), person: text(row.user_email), started: new Date(num(row.started_at)).toISOString(),
      minutes: Math.round(num(row.duration_ms) / 6000) / 10, pages: num(row.pages), clicks: num(row.clicks), field_edits: num(row.inputs), dialogs: num(row.dialogs),
      problems: { rage_clicks: num(row.rage), dead_clicks: num(row.dead), on_screen_errors: num(row.ui_errors), script_errors: num(row.js_errors) },
      screens: (JSON.parse(text(row.screens_json) || "[]") as string[]).map((id) => labels.get(id)?.label || id).slice(0, 8),
      ...(input.text ? { snippet: snippet(text(row.search_text), String(input.text)) } : {})
    }))
  };
}

function snippet(body: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const lower = body.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (at === undefined) return "";
  return (at > 60 ? "…" : "") + body.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, " ") + "…";
}

export async function searchText(input: Filter & { query: string; limit?: number }) {
  return await findSessions({ ...input, text: input.query });
}

/** One session as readable lines: when, where, what was done and what happened. */
export async function sessionTimeline(input: { session_id: string; from_seconds?: number; to_seconds?: number; limit?: number; kinds?: string[] }) {
  const db = insightsDb();
  const session = await db.prepare("SELECT * FROM replay_ix_sessions WHERE session_id=?").get(input.session_id);
  if (!session) return { error: "This session is not indexed (yet). Recent sessions are indexed about 10 minutes after they go quiet; index_now indexes one immediately." };
  const start = num(session.started_at);
  const steps = await db.prepare("SELECT seq, t, kind, screen_id, target_id, outcome, detail_json FROM replay_ix_steps WHERE session_id=? ORDER BY seq").all(input.session_id);
  const labels = await screenLabels(steps.map((s) => text(s.screen_id)));
  const from = start + (num(input.from_seconds) * 1000), to = input.to_seconds === undefined ? Infinity : start + num(input.to_seconds) * 1000;
  const kinds = input.kinds && input.kinds.length ? new Set(input.kinds) : null;
  const lines: string[] = [];
  const limit = Math.min(1000, Math.max(10, num(input.limit) || 250));
  const clock = (t: number) => { const s = Math.max(0, (t - start) / 1000); return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`; };
  let shown = 0, omitted = 0;
  for (const step of steps) {
    const t = num(step.t);
    if (t < from || t > to || (kinds && !kinds.has(text(step.kind)))) continue;
    if (shown >= limit) { omitted++; continue; }
    const d = parseJson(step.detail_json);
    const kind = text(step.kind), outcome = text(step.outcome);
    let line = "";
    switch (kind) {
      case "screen": line = `opened screen "${labels.get(text(step.screen_id))?.label || ""}" (${text(d.url)})${d.ms ? `, stayed ${Math.round(num(d.ms) / 1000)} s` : ""}`; break;
      case "click": line = `${d.context_menu ? "right-clicked" : d.double ? "double-clicked" : d.pointer === "touch" ? "tapped" : "clicked"} ${text(d.role)} "${text(d.label)}"${(d.context as string[] | undefined)?.length ? ` in ${(d.context as string[]).join(" / ")}` : ""} → ${outcome || "?"}${d.dead ? " (dead click)" : ""}`; break;
      case "input": line = `${d.masked ? "typed in protected field" : "edited field"} "${text(d.label)}": ${num(d.changes)} changes${num(d.deleted) ? `, ${num(d.deleted)} characters deleted` : ""}, final length ${num(d.final_length)}${d.checked !== undefined ? `, checked=${d.checked}` : ""}`; break;
      case "key": line = `pressed ${text(d.key)}${d.label ? ` in "${text(d.label)}"` : ""}`; break;
      case "dialog": line = `dialog appeared: "${text(d.title)}"`; break;
      case "ui_error": line = `ERROR MESSAGE shown: "${text(d.message)}"`; break;
      case "js_error": line = `script error: ${text(d.message)}`; break;
      case "rage": line = `RAGE CLICKED "${text(d.label)}" ${num(d.clicks)} times`; break;
      case "idle": line = `no activity for ${Math.round(num(d.ms) / 1000)} s`; break;
      case "hidden": line = "switched to another tab or window"; break;
      case "visible": line = "came back"; break;
      case "custom": line = `marker ${text(d.name)} ${text(d.data)}`; break;
      case "end": line = "left the page"; break;
      default: line = kind;
    }
    lines.push(`${clock(t)}  ${line}`);
    shown++;
  }
  return {
    session_id: input.session_id, person: text(session.user_email), organization_id: text(session.organization_id), started: new Date(start).toISOString(),
    minutes: Math.round(num(session.duration_ms) / 6000) / 10, timeline: lines.join("\n"), ...(omitted ? { omitted_lines: omitted, hint: "Narrow with from_seconds/to_seconds or kinds." } : {})
  };
}

/** What was on the screen at a moment: an outline of the recorded page rebuilt to that time. */
export async function screenAt(input: { session_id: string; seconds?: number; t?: number; max_lines?: number; node_id?: number }) {
  const found = await readReplaySession(input.session_id);
  if (!found) return { error: "No recording with that id." };
  const t = input.t ? num(input.t) : found.session.started_at + num(input.seconds) * 1000;
  const page = [...found.pages].reverse().find((p) => p.started_at <= t) || found.pages[0];
  if (!page) return { error: "That recording has no pages." };
  const chunks: unknown[] = [];
  let after = -1;
  for (;;) {
    const batch = await readReplayChunks(input.session_id, page.page_id, after, 500);
    for (const chunk of batch) { if (chunk.t_start > t + 10000) break; chunks.push(JSON.parse(gunzipSync(chunk.data).toString("utf8"))); after = chunk.seq; }
    if (batch.length < 500 || (batch.length && batch[batch.length - 1]!.t_start > t + 10000)) break;
  }
  const mirror = Model.readPage(chunks).mirrorAt(t);
  const focused = mirror.node(mirror.focusId), hovered = mirror.node(mirror.hoverId);
  return {
    session_id: input.session_id, at: new Date(t).toISOString(), seconds_into_session: Math.round((t - found.session.started_at) / 100) / 10, url: mirror.url,
    focused: focused ? `${mirror.role(mirror.interactive(focused))} "${mirror.label(mirror.interactive(focused))}"` : "",
    pointer_over: hovered ? `${mirror.role(mirror.interactive(hovered))} "${mirror.label(mirror.interactive(hovered))}"` : "",
    headings: mirror.headings(8),
    outline: mirror.outline(Math.min(600, Math.max(20, num(input.max_lines) || 150)), input.node_id),
    note: "The outline lists interactive elements and text in page order with {node ids}; pass node_id to expand one part. It cannot apply CSS, so elements hidden only by stylesheets may still appear."
  };
}

export function replayLink(input: { session_id: string; origin?: string }) {
  return { url: `${input.origin || "https://dev.1m8.ai"}/libraries/session-replay/viewer.html#session=${encodeURIComponent(input.session_id)}` };
}

export async function recentSessions(input: { org_id?: string; limit?: number }) {
  const sessions = await listReplaySessions({ organizationId: input.org_id || undefined, limit: Math.min(100, num(input.limit) || 20) });
  return { sessions: sessions.map((s) => ({ session_id: s.id, organization_id: s.organization_id, person: s.user_email, started: new Date(s.started_at).toISOString(), minutes: Math.round((s.last_at - s.started_at) / 6000) / 10, pages: s.pages })) };
}

export { Codec };
