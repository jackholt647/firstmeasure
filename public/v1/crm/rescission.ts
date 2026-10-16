import { z } from "zod";
import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { evaluateConditions, validateConditions } from "../work/conditions.js";

// Rescission rules (docs/architecture/crm.md, "Building blocks for industries"): the
// days a customer may cancel a sale, how days are counted, which holidays do not count,
// and conditions (a state, a customer's age, a kind of sale) that pick a rule. A sales
// scope's rescission step runs sales.startRescission.v1, which sets its due date from the
// first matching rule. Industries without rescission have no such step.

export const RESCISSION_MODULE = "crm_rescission";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

const ruleSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  label: z.string().trim().min(1).max(120),
  days: z.number().int().min(0).max(60),
  /** calendar: every day; business: every day but Sunday (the FTC cooling-off rule); weekdays: Monday to Friday. */
  count: z.enum(["calendar", "business", "weekdays"]).default("business"),
  holidays: z.enum(["us_federal", "none"]).default("us_federal"),
  conditions: z.object({}).passthrough().default({}),
  note: z.string().trim().max(500).default("")
}).strict();
export type RescissionRule = z.infer<typeof ruleSchema>;
const settingsSchema = z.object({ version: z.literal(1).default(1), enabled: z.boolean().default(false), rules: z.array(ruleSchema).max(50).default([]) }).strict();

export function normalizeRescission(value: unknown) {
  const settings = settingsSchema.parse({ ...object(value), version: 1 });
  const ids = new Set<string>();
  for (const rule of settings.rules) {
    if (ids.has(rule.id)) throw badRequest("crm_rescission_duplicate", `The rule id "${rule.id}" is used more than once.`);
    ids.add(rule.id);
    const issues = validateConditions(rule.conditions, `rescission rule "${rule.id}"`);
    if (issues.length) throw badRequest("crm_rescission_conditions_invalid", issues[0]!, { issues });
  }
  return settings;
}

export async function readRescission(orgId: string) {
  try { return normalizeRescission((await readBranchModule(orgId, "default", RESCISSION_MODULE)).data); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return normalizeRescission({}); throw error; }
}

export async function saveRescission(orgId: string, value: unknown) {
  const settings = normalizeRescission(object(value).data ?? value);
  await saveBranchModule(orgId, "default", RESCISSION_MODULE, { data: settings, metadata: { kind: "crm_rescission" } }, { replace: true });
  return settings;
}

// ---- Calendars --------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const key = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(year: number, month: number, weekday: number) {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}
/** A fixed-date holiday falling on a weekend is observed on the Friday before or the Monday after. */
function observed(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day)), dow = date.getUTCDay();
  if (dow === 6) date.setUTCDate(day - 1); else if (dow === 0) date.setUTCDate(day + 1);
  return key(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
/**
 * US federal holidays (5 U.S.C. 6103): the legal date and, for a fixed date on a weekend,
 * the observed weekday too. Excluding both can only lengthen a cancellation window, which
 * is the safe side for the customer.
 */
export function usFederalHolidays(year: number) {
  const fixed: [number, number][] = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]];
  return new Set([
    ...fixed.flatMap(([m, d]) => [key(year, m, d), observed(year, m, d)]), observed(year + 1, 1, 1),
    key(year, 1, nthWeekday(year, 1, 1, 3)), key(year, 2, nthWeekday(year, 2, 1, 3)), key(year, 5, lastWeekday(year, 5, 1)),
    key(year, 9, nthWeekday(year, 9, 1, 1)), key(year, 10, nthWeekday(year, 10, 1, 2)), key(year, 11, nthWeekday(year, 11, 4, 4))
  ]);
}

/** The local calendar date of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}
/** The instant a local date ends (23:59:59.999) in a time zone. */
export function endOfLocalDay(y: number, m: number, d: number, timeZone: string) {
  const guess = Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  const shown = localDate(new Date(guess), timeZone);
  const asUtc = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
  const part = (type: string) => Number(asUtc.find(p => p.type === type)?.value);
  const zoned = Date.UTC(shown.y, shown.m - 1, shown.d, part("hour") % 24, part("minute"), part("second"), 999);
  return new Date(guess - (zoned - guess));
}

/**
 * The end of the last day a customer may cancel: count `days` counted days after the day
 * of the sale (which does not count), skipping what the rule does not count.
 */
export function rescissionDeadline(rule: Pick<RescissionRule, "days" | "count" | "holidays">, soldAt: Date, timeZone = "America/New_York") {
  let { y, m, d } = localDate(soldAt, timeZone);
  let counted = 0;
  const holidayCache = new Map<number, Set<string>>();
  const isHoliday = (yy: number, k: string) => rule.holidays === "us_federal" && (holidayCache.get(yy) || holidayCache.set(yy, usFederalHolidays(yy)).get(yy)!).has(k);
  while (counted < rule.days) {
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate();
    const dow = next.getUTCDay(), k = key(y, m, d);
    if (rule.count === "business" && (dow === 0 || isHoliday(y, k))) continue;
    if (rule.count === "weekdays" && (dow === 0 || dow === 6 || isHoliday(y, k))) continue;
    counted++;
  }
  return endOfLocalDay(y, m, d, timeZone);
}

/** A project's address parts: `address_components` is stored as Google-style parts, sometimes as JSON text. */
export function projectAddress(project: JsonObject) {
  let raw: unknown = project.address_components;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = {}; } }
  const parts = object(raw);
  const part = (key: string, form: "short" | "long") => { const value = parts[key]; return text(value && typeof value === "object" ? object(value)[form] || object(value).long : value); };
  return {
    state: part("administrative_area_level_1", "short") || text(parts.state_short) || part("state", "short"),
    state_name: part("administrative_area_level_1", "long") || part("state", "long"),
    city: part("locality", "long") || part("city", "long"),
    zip: part("postal_code", "long") || part("zip", "long")
  };
}

/** The context rescission conditions read: the project and its address, its primary contact (with age) and its lead source. */
export function rescissionContext(project: JsonObject, contact: JsonObject = {}, now = new Date()) {
  const birthday = Date.parse(text(contact.birthday));
  const age = Number.isFinite(birthday) ? Math.floor((now.getTime() - birthday) / (365.2425 * 86_400_000)) : null;
  return { project, address: projectAddress(project), contact: { ...contact, age }, lead_source: object(project.lead_source) };
}

export function pickRescissionRule(settings: z.infer<typeof settingsSchema>, context: JsonObject) {
  if (!settings.enabled) return null;
  return settings.rules.find(rule => evaluateConditions(rule.conditions, context, { caseInsensitive: true, commaLists: true, payloadFallback: false })) || null;
}

/**
 * The customer cancelled inside the window: the won sale whose cancellation step is still
 * open becomes lost, which cancels its open work so production never starts.
 */
export async function cancelSaleInWindow(orgId: string, projectId: string, input: { reason?: string; actor_user_id?: string } = {}) {
  const { listPlanRecords, listNodeRecords } = await import("../work/storage.js");
  const plans = (await listPlanRecords(orgId, { project_id: projectId, sales: true })).filter(plan => text(plan.outcome) === "won");
  for (const plan of plans) {
    const open = (await listNodeRecords(orgId, { plan_id: text(plan.id), open_only: true })).find(node => object(object(node.metadata).rescission).deadline);
    if (!open) continue;
    const { setOpportunityOutcome } = await import("../work/opportunities.js");
    return await setOpportunityOutcome(orgId, { plan_id: text(plan.id), outcome: "lost", reason: text(input.reason) || "Cancelled in the cancellation window", actor_user_id: input.actor_user_id });
  }
  throw conflict("rescission_window_closed", "This sale has no open cancellation window.");
}
