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

/** YYYY-MM-DD, MM-DD (yearly) or M/D[/YYYY] to [year, month, day]; year 0 when none is given. */
function dateParts(value: string): [number, number, number] | null {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value) || /^-{0,2}()(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return [Number(iso[1] || 0), Number(iso[2]), Number(iso[3])];
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(value);
  if (us) return [Number(us[3] || 0) < 100 && us[3] ? 2000 + Number(us[3]) : Number(us[3] || 0), Number(us[1]), Number(us[2])];
  return null;
}

/**
 * A scheduled rule on a contact date: every contact whose date falls on the day the rule looks at gets one
 * contact.date event. `offset_days` moves the firing from the date (-3: three days before). Yearly dates
 * match on month and day; 29 February matches 28 February in other years.
 * Reads every contact once per firing: docs/optimization-backlog.md, "Contact date rules".
 */
export async function emitContactDateEvents(orgId: string, branchId: string, rule: JsonObject, fireAt: string) {
  const spec = asObject(asObject(rule.schedule).contact_date);
  const field = cleanText(spec.field);
  if (!field) return 0;
  const { resolveOrganizationTimezone } = await import("../platform/timezone.js");
  const zone = await resolveOrganizationTimezone(orgId, branchId).catch(() => "UTC");
  const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const today = dayOf(Date.parse(fireAt));
  // The contact date this firing is for: offset -3 fires on the 7th for a date on the 10th.
  const target = dayOf(Date.parse(`${today}T12:00:00Z`) - Number(spec.offset_days || 0) * 86_400_000);
  const [ty, tm, td] = target.split("-").map(Number) as [number, number, number];
  const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const { listAllContacts } = await import("../contacts/records.js");
  const { contactDate } = await import("../contacts/events.js");
  let emitted = 0;
  for (const contact of await listAllContacts(orgId)) {
    const value = contactDate(contact, field);
    const parts = value ? dateParts(value) : null;
    if (!parts) continue;
    const [year, month, day] = parts;
    const onDay = spec.yearly === false
      ? year === ty && month === tm && day === td
      : month === tm && (day === td || (month === 2 && day === 29 && td === 28 && !leap(ty)));
    if (!onDay) continue;
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: branchId,
      type: "contact.date",
      idempotency_key: `contact.date:${branchId}:${cleanText(rule.id)}:${contact.id}:${target}`,
      payload: { rule_id: cleanText(rule.id), contact_id: contact.id, field, date: value, on: today },
      context: { contact_id: contact.id }
    }, { process: false });
    emitted += 1;
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
      // A contact date is checked at a time of day where the organization is, not where the server is.
      const datedRule = !!cleanText(asObject(asObject(rule.schedule).contact_date).field);
      const zone = datedRule ? await (await import("../platform/timezone.js")).resolveOrganizationTimezone(orgId, branchId).catch(() => undefined) : undefined;
      const fireAt = latestCronFire(cron, cleanText(asObject(state).last_fired_at), new Date(), zone);
      if (!fireAt) continue;
      if (datedRule) {
        // Each contact event has its own identity, so a firing that stops part way resumes without repeats.
        emitted += await emitContactDateEvents(orgId, branchId, rule, fireAt);
        await saveCronState(orgId, branchId, ruleId, fireAt);
        continue;
      }
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
