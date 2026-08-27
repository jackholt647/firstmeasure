import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { badRequest } from "./errors.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import {
  ensureFirstMeasureProjectIndexReady,
  getFirstMeasureProjectIndexDb
} from "./project_index.js";
import { resolveFirstMeasureStorageRoot } from "./storage.js";
import { mutateSharedDocument, readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";
import { acquireFirstMeasureLock } from "./locks.js";

export const RUSH_BONUS_PERCENT = 25;

const DEFAULT_RUSH_AUTOMATION_SETTINGS = {
  enabled: false,
  request_count_threshold: 30,
  request_window_minutes: 60,
  queue_threshold_enabled: false,
  queue_count_threshold: 0,
  rush_duration_minutes: 60
};

type RushModeRecord = {
  id: string;
  start_at: string;
  duration_seconds: number;
  created_at: string;
  created_by_email: string | null;
  created_by_name: string | null;
  source: "manual" | "automatic";
  trigger_snapshot?: RushAutomationSnapshot | null;
};

type RushModeStore = {
  rush_modes: RushModeRecord[];
  automation_settings: RushAutomationSettings;
  last_automation_snapshot: RushAutomationSnapshot | null;
};

type RushAutomationSettings = typeof DEFAULT_RUSH_AUTOMATION_SETTINGS;

type RushAutomationSnapshot = {
  evaluated_at: string;
  requested_count: number;
  queue_count: number;
  request_window_minutes: number;
  request_count_threshold: number;
  queue_threshold_enabled: boolean;
  queue_count_threshold: number;
  triggered: boolean;
  reason: string;
};

function rushStorePath() {
  return path.join(resolveFirstMeasureStorageRoot(), "rush_modes.json");
}

async function writeFileAtomic(filePath: string, content: string) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, content);
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function normalizeStore(value: unknown): RushModeStore {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rushModes = Array.isArray(record.rush_modes) ? record.rush_modes : [];
  return {
    automation_settings: normalizeAutomationSettings(record.automation_settings),
    last_automation_snapshot: normalizeAutomationSnapshot(record.last_automation_snapshot),
    rush_modes: rushModes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: String(item.id ?? ""),
        start_at: String(item.start_at ?? ""),
        duration_seconds: Math.max(0, Math.round(Number(item.duration_seconds ?? 0))),
        created_at: String(item.created_at ?? ""),
        created_by_email: item.created_by_email == null ? null : String(item.created_by_email),
        created_by_name: item.created_by_name == null ? null : String(item.created_by_name),
        source: item.source === "automatic" ? "automatic" as const : "manual" as const,
        trigger_snapshot: normalizeAutomationSnapshot(item.trigger_snapshot)
      }))
      .filter((item) => item.id && Date.parse(item.start_at) > 0 && item.duration_seconds > 0)
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeAutomationSettings(value: unknown): RushAutomationSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: record.enabled === true,
    request_count_threshold: clampInteger(
      record.request_count_threshold,
      DEFAULT_RUSH_AUTOMATION_SETTINGS.request_count_threshold,
      1,
      10000
    ),
    request_window_minutes: clampInteger(
      record.request_window_minutes,
      DEFAULT_RUSH_AUTOMATION_SETTINGS.request_window_minutes,
      1,
      24 * 60
    ),
    queue_threshold_enabled: record.queue_threshold_enabled === true,
    queue_count_threshold: clampInteger(
      record.queue_count_threshold,
      DEFAULT_RUSH_AUTOMATION_SETTINGS.queue_count_threshold,
      0,
      10000
    ),
    rush_duration_minutes: clampInteger(
      record.rush_duration_minutes,
      DEFAULT_RUSH_AUTOMATION_SETTINGS.rush_duration_minutes,
      1,
      24 * 60
    )
  };
}

function normalizeAutomationSnapshot(value: unknown): RushAutomationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const evaluatedAt = String(record.evaluated_at ?? "");
  if (Date.parse(evaluatedAt) <= 0) return null;
  const settings = normalizeAutomationSettings(record);
  return {
    evaluated_at: evaluatedAt,
    requested_count: Math.max(0, Math.round(Number(record.requested_count ?? 0))),
    queue_count: Math.max(0, Math.round(Number(record.queue_count ?? 0))),
    request_window_minutes: settings.request_window_minutes,
    request_count_threshold: settings.request_count_threshold,
    queue_threshold_enabled: settings.queue_threshold_enabled,
    queue_count_threshold: settings.queue_count_threshold,
    triggered: record.triggered === true,
    reason: String(record.reason ?? "")
  };
}

async function readRushStore(): Promise<RushModeStore> {
  if (isFirstMeasurePostgresEnabled()) {
    const stored = await readSharedDocument<RushModeStore>({ namespace: "firstmeasure", collection: "runtime", id: "rush_modes" });
    return normalizeStore(stored);
  }
  try {
    const raw = await readFile(rushStorePath(), "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch {
    return {
      rush_modes: [],
      automation_settings: normalizeAutomationSettings(null),
      last_automation_snapshot: null
    };
  }
}

async function writeRushStore(store: RushModeStore) {
  if (isFirstMeasurePostgresEnabled()) {
    await replaceSharedDocument({ namespace: "firstmeasure", collection: "runtime", id: "rush_modes" }, normalizeStore(store));
    return;
  }
  await writeFileAtomic(rushStorePath(), JSON.stringify(normalizeStore(store), null, 2));
}

function rushModeWithComputedFields(mode: RushModeRecord, nowMs = Date.now()) {
  const startMs = Date.parse(mode.start_at);
  const endMs = startMs + mode.duration_seconds * 1000;
  return {
    ...mode,
    bonus_percent: RUSH_BONUS_PERCENT,
    end_at: new Date(endMs).toISOString(),
    active: startMs <= nowMs && nowMs < endMs,
    remaining_seconds: Math.max(0, Math.ceil((endMs - nowMs) / 1000))
  };
}

export async function listRushModes() {
  const store = await readRushStore();
  return store.rush_modes
    .slice()
    .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at))
    .map((mode) => rushModeWithComputedFields(mode));
}

export async function getRushAutomationSettings() {
  const store = await readRushStore();
  return {
    ok: true,
    success: true,
    settings: store.automation_settings,
    last_evaluation: store.last_automation_snapshot
  };
}

export async function updateRushAutomationSettings(input: Record<string, unknown>) {
  if (isFirstMeasurePostgresEnabled()) {
    const store = await mutateSharedDocument<RushModeStore>(
      { namespace: "firstmeasure", collection: "runtime", id: "rush_modes" },
      (current) => {
        const normalized = normalizeStore(current);
        normalized.automation_settings = normalizeAutomationSettings({ ...normalized.automation_settings, ...input });
        return normalized;
      },
      { create: () => normalizeStore(null) }
    );
    return { ok: true, success: true, settings: store.automation_settings, last_evaluation: store.last_automation_snapshot };
  }
  const store = await readRushStore();
  store.automation_settings = normalizeAutomationSettings({
    ...store.automation_settings,
    ...input
  });
  await writeRushStore(store);
  return {
    ok: true,
    success: true,
    settings: store.automation_settings,
    last_evaluation: store.last_automation_snapshot
  };
}

export async function getCurrentRushMode(nowMs = Date.now()) {
  const store = await readRushStore();
  const active = store.rush_modes
    .map((mode) => rushModeWithComputedFields(mode, nowMs))
    .filter((mode) => mode.active)
    .sort((a, b) => Date.parse(b.start_at) - Date.parse(a.start_at))[0] ?? null;

  return {
    ok: true,
    active: Boolean(active),
    rush_mode: active ? {
      id: active.id,
      start_at: active.start_at,
      duration_seconds: active.duration_seconds,
      end_at: active.end_at,
      remaining_seconds: active.remaining_seconds,
      bonus_percent: active.bonus_percent
    } : null
  };
}

export async function createRushMode(input: {
  start_at?: unknown;
  duration_minutes?: unknown;
  duration_seconds?: unknown;
  actor?: Record<string, unknown> | null;
  source?: "manual" | "automatic";
  trigger_snapshot?: RushAutomationSnapshot | null;
}) {
  const durationSecondsRaw = input.duration_seconds ?? (Number(input.duration_minutes ?? 0) * 60);
  const durationSeconds = Math.round(Number(durationSecondsRaw));
  if (!Number.isFinite(durationSeconds) || durationSeconds < 60 || durationSeconds > 24 * 60 * 60) {
    throw badRequest("invalid_rush_duration", "Rush mode duration must be between 1 minute and 24 hours.");
  }

  const startRaw = input.start_at == null || String(input.start_at).trim() === ""
    ? new Date()
    : new Date(String(input.start_at));
  const startMs = startRaw.getTime();
  if (!Number.isFinite(startMs)) {
    throw badRequest("invalid_rush_start", "Rush mode start time is invalid.");
  }

  const nowIso = new Date().toISOString();
  const actor = input.actor && typeof input.actor === "object" ? input.actor : {};
  const mode: RushModeRecord = {
    id: `rush_${startMs}_${randomBytes(4).toString("hex")}`,
    start_at: new Date(startMs).toISOString(),
    duration_seconds: durationSeconds,
    created_at: nowIso,
    created_by_email: actor.email == null ? null : String(actor.email),
    created_by_name: actor.name == null ? null : String(actor.name),
    source: input.source === "automatic" ? "automatic" : "manual",
    trigger_snapshot: input.trigger_snapshot ?? null
  };

  if (isFirstMeasurePostgresEnabled()) {
    await mutateSharedDocument<RushModeStore>(
      { namespace: "firstmeasure", collection: "runtime", id: "rush_modes" },
      (current) => {
        const store = normalizeStore(current);
        store.rush_modes.push(mode);
        return store;
      },
      { create: () => normalizeStore(null) }
    );
  } else {
    const store = await readRushStore();
    store.rush_modes.push(mode);
    await writeRushStore(store);
  }
  return rushModeWithComputedFields(mode);
}

export async function evaluateAutomaticRushMode() {
  if (isFirstMeasurePostgresEnabled()) {
    const release = await acquireFirstMeasureLock("rush-mode-automatic-evaluation", { ttlMs: 120_000, waitMs: 5_000 });
    try {
      return await evaluateAutomaticRushModeUnlocked();
    } finally {
      await release();
    }
  }
  return evaluateAutomaticRushModeUnlocked();
}

async function evaluateAutomaticRushModeUnlocked() {
  const store = await readRushStore();
  const settings = store.automation_settings;
  const nowMs = Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();

  const makeSnapshot = (input: Partial<RushAutomationSnapshot>): RushAutomationSnapshot => ({
    evaluated_at: evaluatedAt,
    requested_count: 0,
    queue_count: 0,
    request_window_minutes: settings.request_window_minutes,
    request_count_threshold: settings.request_count_threshold,
    queue_threshold_enabled: settings.queue_threshold_enabled,
    queue_count_threshold: settings.queue_count_threshold,
    triggered: false,
    reason: "not_evaluated",
    ...input
  });

  if (!settings.enabled) {
    return {
      ok: true,
      success: true,
      triggered: false,
      reason: "disabled",
      settings,
      snapshot: makeSnapshot({ reason: "disabled" })
    };
  }

  const current = await getCurrentRushMode(nowMs);
  if (current.active) {
    const snapshot = makeSnapshot({ reason: "rush_already_active" });
    store.last_automation_snapshot = snapshot;
    await writeRushStore(store);
    return { ok: true, success: true, triggered: false, reason: snapshot.reason, settings, snapshot };
  }

  await ensureFirstMeasureProjectIndexReady();
  const sinceMs = nowMs - settings.request_window_minutes * 60 * 1000;
  const [requestedRow, queueRow] = isFirstMeasurePostgresEnabled()
    ? await (async () => {
      const query = (await import("./project_index_postgres.js")).queryPostgresRows;
      const requested = await query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM projects
        WHERE created_at_ms > $1 AND is_filler = 0
      `, [sinceMs]);
      const queued = await query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM projects
        WHERE status IN ('queued', 'ready') AND assigned_to_email = '' AND is_filler = 0
      `);
      return [requested[0], queued[0]];
    })()
    : (() => {
      const db = getFirstMeasureProjectIndexDb();
      return [
        db.prepare(`
          SELECT COUNT(*) AS count FROM projects WHERE created_at_ms > $sinceMs AND is_filler = 0
        `).get({ sinceMs }) as { count?: number } | undefined,
        db.prepare(`
          SELECT COUNT(*) AS count FROM projects
          WHERE status IN ('queued', 'ready') AND assigned_to_email = '' AND is_filler = 0
        `).get() as { count?: number } | undefined
      ];
    })();
  const requestedCount = Math.max(0, Math.round(Number(requestedRow?.count ?? 0)));
  const queueCount = Math.max(0, Math.round(Number(queueRow?.count ?? 0)));
  const requestCriteriaMet = requestedCount > settings.request_count_threshold;
  const queueCriteriaMet = !settings.queue_threshold_enabled || queueCount > settings.queue_count_threshold;

  if (!requestCriteriaMet || !queueCriteriaMet) {
    const snapshot = makeSnapshot({
      requested_count: requestedCount,
      queue_count: queueCount,
      reason: !requestCriteriaMet ? "request_threshold_not_met" : "queue_threshold_not_met"
    });
    store.last_automation_snapshot = snapshot;
    await writeRushStore(store);
    return { ok: true, success: true, triggered: false, reason: snapshot.reason, settings, snapshot };
  }

  const snapshot = makeSnapshot({
    requested_count: requestedCount,
    queue_count: queueCount,
    triggered: true,
    reason: "criteria_met"
  });
  const rushMode = await createRushMode({
    duration_minutes: settings.rush_duration_minutes,
    source: "automatic",
    trigger_snapshot: snapshot
  });
  const refreshed = await readRushStore();
  refreshed.last_automation_snapshot = snapshot;
  await writeRushStore(refreshed);

  return {
    ok: true,
    success: true,
    triggered: true,
    reason: "criteria_met",
    settings,
    snapshot,
    rush_mode: rushMode
  };
}
