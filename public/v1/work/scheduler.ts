import { platformBackgroundAllowed } from "../platform/runtime.js";
import { getWorkDatabase, createEventRecord, dueNodeRecords, readCronState, saveCronState, timerCandidateNodes, type JsonObject } from "./storage.js";
import { drainWorkEvents, emitWorkEvent } from "./engine.js";
import { latestCronFire } from "./cron.js";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let tickCount = 0;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

const TIMER_ANCHOR_COLUMNS: Record<string, string> = {
  created: "created_at",
  ready: "ready_at",
  started: "started_at",
  due: "due_at"
};

// Fires declared node timers: `timers: [{ id, anchor, offset_minutes }]` on a
// template node emits `work.node.timer` once the anchor timestamp plus offset
// passes. Idempotency (node:timer:id) makes each timer one-shot.
async function emitDueNodeTimers(now: number) {
  let emitted = 0;
  for (const node of (await timerCandidateNodes())) {
    const timers = asArray(asObject(node.metadata).timers).map(asObject);
    for (const declaration of timers) {
      const timerId = cleanText(declaration.id);
      if (!timerId) continue;
      const anchorColumn = TIMER_ANCHOR_COLUMNS[cleanText(declaration.anchor) || "ready"] || "ready_at";
      const anchorAt = Date.parse(cleanText(node[anchorColumn]));
      if (!Number.isFinite(anchorAt)) continue;
      const fireAt = anchorAt + Math.max(0, Number(declaration.offset_minutes || 0)) * 60_000;
      if (fireAt > now) continue;
      await emitWorkEvent({
        organization_id: node.organization_id,
        branch_id: node.branch_id,
        project_id: node.project_id,
        plan_id: node.plan_id,
        node_id: node.id,
        type: "work.node.timer",
        idempotency_key: `${cleanText(node.id)}:timer:${timerId}`,
        payload: { timer_id: timerId, anchor: cleanText(declaration.anchor) || "ready", fire_at: new Date(fireAt).toISOString() }
      }, { process: false });
      emitted += 1;
    }
  }
  return emitted;
}

// Fires scheduled organization automation rules (rules with schedule.cron).
// Only explicitly enabled organizations enter the indexed platform sweep.
async function emitDueCronRules() {
  const { listExpandedPlatformOrgIds } = await import("../platform/capabilities.js");
  const { readAutomationRules } = await import("./rules.js");
  const organizations = await listExpandedPlatformOrgIds();
  let emitted = 0;
  for (const organization of organizations) {
    const orgId = organization;
    if (!orgId) continue;
    const branchId = "default";
    const { rules } = await readAutomationRules(orgId, branchId).catch(() => ({ rules: [] as JsonObject[] }));
    for (const rule of rules) {
      const cron = cleanText(asObject(rule.schedule).cron);
      if (!cron || rule.enabled === false) continue;
      const ruleId = cleanText(rule.id);
      const state = (await readCronState(orgId, branchId, ruleId));
      const fireAt = latestCronFire(cron, cleanText(asObject(state).last_fired_at));
      if (!fireAt) continue;
      await getWorkDatabase().transaction(async () => {
      await createEventRecord({
        organization_id: orgId,
        branch_id: branchId,
        type: "time.cron",
        idempotency_key: `time.cron:${branchId}:${ruleId}:${fireAt}`,
        payload: { rule_id: ruleId, fired_at: fireAt, cron }
      });
      await saveCronState(orgId, branchId, ruleId, fireAt);
      });
      emitted += 1;
    }
  }
  return emitted;
}

export async function runWorkSchedulerTick(options: { cron?: boolean } = {}) {
  if (running) return 0;
  running = true;
  try {
    let emitted = 0;
    const now = Date.now();
    for (const node of (await dueNodeRecords())) {
      await emitWorkEvent({
        organization_id: node.organization_id,
        branch_id: node.branch_id,
        project_id: node.project_id,
        plan_id: node.plan_id,
        node_id: node.id,
        type: "work.node.due",
        idempotency_key: `${cleanText(node.id)}:due:${cleanText(node.due_at)}`,
        payload: { due_at: node.due_at }
      }, { process: false });
      emitted += 1;
    }
    emitted += await emitDueNodeTimers(now);
    tickCount += 1;
    // Cron rules only need minute resolution — sweep every 12th tick (~60s).
    if (options.cron === true || tickCount % 12 === 0) {
      emitted += await emitDueCronRules();
    }
    await drainWorkEvents();
    return emitted;
  } finally {
    running = false;
  }
}

export function startWorkScheduler() {
  if (!platformBackgroundAllowed()) return;
  if (timer || process.env.WORK_SCHEDULER_DISABLED === "1" || process.env.PLATFORM_HEARTBEAT_DISABLED === "1") return;
  timer = setInterval(() => void runWorkSchedulerTick(), 5_000);
  timer.unref?.();
}

export function stopWorkScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
