import { randomBytes } from "node:crypto";

import type { SqlStore } from "../platform/sql_store.js";
import { replayDatabase } from "./storage.js";

/**
 * Who session replay records (docs/architecture/session-replay.md, "Who is recorded").
 *
 * One mode for the whole platform, plus rules for people and organizations:
 *   off       nobody is recorded, whatever the rules say (the kill switch)
 *   listed    only people and organizations whose rule says record (the default, so nothing records at first)
 *   everyone  everybody, except people and organizations whose rule says don't
 * A person is a sign-in identity, so their rule follows them into every organization they belong to, and it wins
 * over their organization's rule. A rule may expire; an expired rule counts as absent. Every change is logged.
 * Only platform administrators read or change any of this (session-replay/api.ts).
 */
export type ReplayMode = "off" | "listed" | "everyone";
export type RuleKind = "person" | "organization";
export type ReplayRule = {
  kind: RuleKind;
  target_id: string;
  enabled: boolean;
  expires_at: number;
  reason: string;
  /** What the rule is about, as it was when set: an email for a person, a name for an organization. */
  label: string;
  /** A person's name, or an organization's id. */
  detail: string;
  updated_by: string;
  updated_at: number;
  created_at: number;
};
export type ReplayDecision = {
  record: boolean;
  because: "mode_off" | "person" | "organization" | "everyone" | "not_listed";
  mode: ReplayMode;
  rule: ReplayRule | null;
};
export type RuleInput = { kind: RuleKind; target_id: string; enabled: boolean; expires_at: number; reason: string; label: string; detail: string };

export const REPLAY_MODES: ReplayMode[] = ["off", "listed", "everyone"];
const DEFAULT_MODE: ReplayMode = "listed";
// Decisions are cached per process for this long, so a change reaches every node within it. A page asks once when
// it loads and the answer is checked again on every upload, which is what stops a page that was switched off.
const CACHE_MS = 10_000;
const CACHE_LIMIT = 20_000;

const text = (value: unknown) => String(value ?? "").trim();
const num = (value: unknown) => Number(value ?? 0) || 0;
const store = (): SqlStore => replayDatabase();

let modeCache: { at: number; value: Awaited<ReturnType<typeof readModeRow>> } | null = null;
const decisionCache = new Map<string, { at: number; decision: ReplayDecision }>();

/** Forget cached modes and decisions in this process (after a write, and in tests). */
export function clearReplayTargetingCache() {
  modeCache = null;
  decisionCache.clear();
}

function ruleFromRow(row: Record<string, unknown>): ReplayRule {
  return {
    kind: text(row.kind) as RuleKind,
    target_id: text(row.target_id),
    enabled: num(row.enabled) === 1,
    expires_at: num(row.expires_at),
    reason: text(row.reason),
    label: text(row.label),
    detail: text(row.detail),
    updated_by: text(row.updated_by),
    updated_at: num(row.updated_at),
    created_at: num(row.created_at)
  };
}

const live = (rule: ReplayRule, now: number) => !rule.expires_at || rule.expires_at > now;

async function readModeRow() {
  const row = await store().prepare("SELECT value, reason, updated_by, updated_at FROM session_replay_config WHERE key='mode'").get();
  const value = text(row?.value) as ReplayMode;
  return {
    mode: REPLAY_MODES.includes(value) ? value : DEFAULT_MODE,
    reason: text(row?.reason),
    updated_by: text(row?.updated_by),
    updated_at: num(row?.updated_at)
  };
}

export async function readReplayMode(fresh = false) {
  const now = Date.now();
  if (!fresh && modeCache && now - modeCache.at < CACHE_MS) return modeCache.value;
  const value = await readModeRow();
  modeCache = { at: now, value };
  return value;
}

/** Whether this person, signed in to this organization, is recorded, and which setting decided it. */
export async function decideReplay(input: { identityId: string; orgId: string }, now = Date.now()): Promise<ReplayDecision> {
  const key = input.identityId + "\u0000" + input.orgId;
  const cached = decisionCache.get(key);
  if (cached && now - cached.at < CACHE_MS) return cached.decision;
  const { mode } = await readReplayMode();
  let decision: ReplayDecision;
  if (mode === "off") {
    decision = { record: false, because: "mode_off", mode, rule: null };
  } else {
    const rows = await store().prepare(`SELECT * FROM session_replay_rules
      WHERE (kind='person' AND target_id=?) OR (kind='organization' AND target_id=?)`).all(input.identityId || "\u0000", input.orgId || "\u0000");
    const rules = rows.map(ruleFromRow).filter((rule) => live(rule, now));
    const person = rules.find((rule) => rule.kind === "person");
    const organization = rules.find((rule) => rule.kind === "organization");
    const rule = person || organization || null;
    if (rule) decision = { record: rule.enabled, because: rule.kind, mode, rule };
    else decision = { record: mode === "everyone", because: mode === "everyone" ? "everyone" : "not_listed", mode, rule: null };
  }
  if (decisionCache.size >= CACHE_LIMIT) decisionCache.clear();
  decisionCache.set(key, { at: now, decision });
  return decision;
}

function logId() {
  return Date.now().toString(36) + randomBytes(6).toString("hex");
}

async function log(tx: SqlStore, entry: { actor: string; kind: string; target_id: string; label: string; before: unknown; after: unknown; reason: string }) {
  await tx.prepare(`INSERT INTO session_replay_rule_log (id, at, actor, kind, target_id, label, before_json, after_json, reason)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(logId(), Date.now(), entry.actor.slice(0, 320), entry.kind, entry.target_id.slice(0, 200),
    entry.label.slice(0, 320), JSON.stringify(entry.before ?? null), JSON.stringify(entry.after ?? null), entry.reason.slice(0, 500));
}

export async function setReplayMode(mode: ReplayMode, actor: string, reason: string) {
  if (!REPLAY_MODES.includes(mode)) throw new Error("Unknown session replay mode: " + mode);
  const result = await store().transaction(async (tx) => {
    const before = await tx.prepare("SELECT value FROM session_replay_config WHERE key='mode'").get();
    const now = Date.now();
    await tx.prepare(`INSERT INTO session_replay_config (key, value, reason, updated_by, updated_at) VALUES ('mode',?,?,?,?)
      ON CONFLICT (key) DO UPDATE SET value=excluded.value, reason=excluded.reason, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(mode, reason.slice(0, 500), actor.slice(0, 320), now);
    await log(tx, { actor, kind: "mode", target_id: "*", label: "Everyone", before: text(before?.value) || DEFAULT_MODE, after: mode, reason });
    return { mode, reason, updated_by: actor, updated_at: now };
  }, "replay-targeting");
  clearReplayTargetingCache();
  return result;
}

/** Sets or replaces rules, in one transaction. Each change is logged with what it replaced. */
export async function upsertReplayRules(rules: RuleInput[], actor: string) {
  const saved = await store().transaction(async (tx) => {
    const out: ReplayRule[] = [];
    const now = Date.now();
    for (const rule of rules) {
      const beforeRow = await tx.prepare("SELECT * FROM session_replay_rules WHERE kind=? AND target_id=?").get(rule.kind, rule.target_id);
      const before = beforeRow ? ruleFromRow(beforeRow) : null;
      await tx.prepare(`INSERT INTO session_replay_rules
        (kind, target_id, enabled, expires_at, reason, label, detail, updated_by, updated_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (kind, target_id) DO UPDATE SET enabled=excluded.enabled, expires_at=excluded.expires_at, reason=excluded.reason,
          label=excluded.label, detail=excluded.detail, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(
        rule.kind, rule.target_id, rule.enabled ? 1 : 0, Math.max(0, Math.round(rule.expires_at)), rule.reason.slice(0, 500),
        rule.label.slice(0, 320), rule.detail.slice(0, 320), actor.slice(0, 320), now, before ? before.created_at : now);
      const after: ReplayRule = { ...rule, expires_at: Math.max(0, Math.round(rule.expires_at)), updated_by: actor, updated_at: now, created_at: before ? before.created_at : now };
      await log(tx, { actor, kind: rule.kind, target_id: rule.target_id, label: rule.label, before, after: { enabled: after.enabled, expires_at: after.expires_at }, reason: rule.reason });
      out.push(after);
    }
    return out;
  }, "replay-targeting");
  clearReplayTargetingCache();
  return saved;
}

export async function removeReplayRule(kind: RuleKind, targetId: string, actor: string, reason: string) {
  const removed = await store().transaction(async (tx) => {
    const row = await tx.prepare("SELECT * FROM session_replay_rules WHERE kind=? AND target_id=?").get(kind, targetId);
    if (!row) return null;
    const before = ruleFromRow(row);
    await tx.prepare("DELETE FROM session_replay_rules WHERE kind=? AND target_id=?").run(kind, targetId);
    await log(tx, { actor, kind, target_id: targetId, label: before.label, before, after: null, reason });
    return before;
  }, "replay-targeting");
  clearReplayTargetingCache();
  return removed;
}

export async function readReplayRules(kind: RuleKind, targetIds: string[]) {
  const ids = [...new Set(targetIds.map(text).filter(Boolean))].slice(0, 500);
  if (!ids.length) return new Map<string, ReplayRule>();
  const rows = await store().prepare(`SELECT * FROM session_replay_rules WHERE kind=? AND target_id IN (${ids.map(() => "?").join(",")})`).all(kind, ...ids);
  return new Map(rows.map((row) => [text(row.target_id), ruleFromRow(row)]));
}

/**
 * Rules, newest change first, a page at a time. `cursor` is the `next` of the previous page.
 * `state`: "recording" (live rules that record), "excluded" (live rules that don't), "expired", or everything.
 */
export async function listReplayRules(options: { kind?: RuleKind; state?: "recording" | "excluded" | "expired"; cursor?: string; limit?: number }) {
  const now = Date.now();
  const limit = Math.max(1, Math.min(200, options.limit || 50));
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.kind) { where.push("kind=?"); values.push(options.kind); }
  if (options.state === "recording") { where.push("enabled=1 AND (expires_at=0 OR expires_at>?)"); values.push(now); }
  if (options.state === "excluded") { where.push("enabled=0 AND (expires_at=0 OR expires_at>?)"); values.push(now); }
  if (options.state === "expired") { where.push("expires_at>0 AND expires_at<=?"); values.push(now); }
  const [at, kind, ...rest] = text(options.cursor).split(":");
  if (at && kind) {
    where.push("(updated_at<? OR (updated_at=? AND (kind>? OR (kind=? AND target_id>?))))");
    values.push(num(at), num(at), kind, kind, rest.join(":"));
  }
  const rows = await store().prepare(`SELECT * FROM session_replay_rules ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY updated_at DESC, kind, target_id LIMIT ${limit + 1}`).all(...values);
  const rules = rows.slice(0, limit).map(ruleFromRow);
  const last = rules[rules.length - 1];
  return { rules, next: rows.length > limit && last ? `${last.updated_at}:${last.kind}:${last.target_id}` : null };
}

/** How many live rules record or exclude, by kind. */
export async function countReplayRules() {
  const now = Date.now();
  const rows = await store().prepare(`SELECT kind, enabled, COUNT(*) AS n FROM session_replay_rules
    WHERE expires_at=0 OR expires_at>? GROUP BY kind, enabled`).all(now);
  const counts = { people_recording: 0, people_excluded: 0, organizations_recording: 0, organizations_excluded: 0 };
  for (const row of rows) {
    const key = `${text(row.kind) === "person" ? "people" : "organizations"}_${num(row.enabled) === 1 ? "recording" : "excluded"}` as keyof typeof counts;
    counts[key] = num(row.n);
  }
  return counts;
}

/** Changes to the mode and the rules, newest first. */
export async function listReplayRuleLog(options: { before?: number; limit?: number }) {
  const limit = Math.max(1, Math.min(200, options.limit || 50));
  const rows = await store().prepare(`SELECT * FROM session_replay_rule_log ${options.before ? "WHERE at<?" : ""} ORDER BY at DESC, id DESC LIMIT ${limit}`)
    .all(...(options.before ? [options.before] : []));
  const parse = (value: unknown) => { try { return JSON.parse(text(value) || "null"); } catch { return null; } };
  return rows.map((row) => ({
    id: text(row.id), at: num(row.at), actor: text(row.actor), kind: text(row.kind), target_id: text(row.target_id), label: text(row.label),
    before: parse(row.before_json), after: parse(row.after_json), reason: text(row.reason)
  }));
}
