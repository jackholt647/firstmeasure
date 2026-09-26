// Minimal 5-field cron support for scheduled automation rules:
//   "minute hour day-of-month month day-of-week"
// Supports: * , - */n and plain numbers. Day-of-week 0-6 (Sunday=0; 7 also
// accepted as Sunday). Evaluated in server-local time, or in an explicit
// IANA timezone when one is passed.

import { systemTimezone, zonedInstant, zonedParts } from "../platform/timezone.js";

function fieldMatches(field: string, value: number, min: number, max: number) {
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [rangePart = "*", stepPart = ""] = trimmed.split("/");
    const step = stepPart ? Math.max(1, Number(stepPart) || 1) : 1;
    let start = min;
    let end = max;
    if (rangePart !== "*" && rangePart !== "") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-");
        start = Number(rawStart);
        end = Number(rawEnd);
      } else {
        start = Number(rangePart);
        end = stepPart ? max : Number(rangePart);
      }
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (value >= start && value <= end && (value - start) % step === 0) return true;
  }
  return false;
}

/** The wall-clock fields cron matches against, in the zone (or server-local). */
function cronClock(date: Date, timezone?: string) {
  if (!timezone) {
    return { minute: date.getMinutes(), hour: date.getHours(), day: date.getDate(), month: date.getMonth() + 1, weekday: date.getDay() };
  }
  const parts = zonedParts(date, timezone);
  return {
    minute: parts.minute,
    hour: parts.hour,
    day: parts.day,
    month: parts.month,
    // Weekday of the zone's civil date, independent of the server's zone.
    weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  };
}

export function cronMatches(expression: string, date: Date, timezone?: string) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute = "*", hour = "*", dayOfMonth = "*", month = "*", dayOfWeek = "*"] = fields;
  const clock = cronClock(date, timezone);
  return fieldMatches(minute, clock.minute, 0, 59)
    && fieldMatches(hour, clock.hour, 0, 23)
    && fieldMatches(dayOfMonth, clock.day, 1, 31)
    && fieldMatches(month, clock.month, 1, 12)
    && (fieldMatches(dayOfWeek, clock.weekday, 0, 6) || (clock.weekday === 0 && fieldMatches(dayOfWeek, 7, 0, 7)));
}

// Returns the most recent minute in (afterIso, now] that matches the cron
// expression, or "" when none does. Bounded to the trailing 24h so a long
// downtime fires at most one catch-up.
export function latestCronFire(expression: string, afterIso: string, now = new Date(), timezone?: string) {
  const after = Date.parse(afterIso || "");
  const floorMinute = (ms: number) => Math.floor(ms / 60_000) * 60_000;
  const nowMinute = floorMinute(now.getTime());
  const lowerBound = Math.max(
    Number.isFinite(after) ? floorMinute(after) + 60_000 : nowMinute,
    nowMinute - 24 * 60 * 60_000
  );
  return findCronOccurrence(expression, lowerBound - 1, nowMinute, timezone, "desc");
}

type ParsedCron = { minutes: number[]; hours: number[]; days: Set<number>; months: Set<number>; weekdays: Set<number> };

/** Expands one field strictly; a malformed or out-of-range part makes the whole expression invalid. */
function expandField(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!match) return null;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    const start = match[1] === "*" ? min : Number(match[2]);
    const end = match[1] === "*" ? max : match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? max : start;
    if (!(step >= 1) || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? [...values].sort((a, b) => a - b) : null;
}

export function parseCron(expression: string): ParsedCron | null {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = expandField(fields[0]!, 0, 59), hour = expandField(fields[1]!, 0, 23), day = expandField(fields[2]!, 1, 31);
  const month = expandField(fields[3]!, 1, 12), weekday = expandField(fields[4]!, 0, 7);
  if (!minute || !hour || !day || !month || !weekday) return null;
  return { minutes: minute, hours: hour, days: new Set(day), months: new Set(month), weekdays: new Set(weekday.map((value) => value % 7)) };
}

export function isValidCron(expression: string) {
  return parseCron(expression) !== null;
}

/**
 * First (asc) or last (desc) matching minute in (startMs, endMs]. Walks civil
 * days in the zone and expands only days whose date matches, so impossible
 * expressions such as February 31 cost one check per day instead of per minute.
 */
export function findCronOccurrence(expression: string, startMs: number, endMs: number, timezone?: string, order: "asc" | "desc" = "asc") {
  const cron = parseCron(expression);
  if (!cron || !(endMs > startMs)) return "";
  const zone = timezone || systemTimezone();
  const first = zonedParts(new Date(startMs), zone);
  const last = zonedParts(new Date(endMs), zone);
  const firstDay = Date.UTC(first.year, first.month - 1, first.day);
  const dayCount = Math.round((Date.UTC(last.year, last.month - 1, last.day) - firstDay) / 86_400_000);
  const hours = order === "asc" ? cron.hours : [...cron.hours].reverse();
  const minutes = order === "asc" ? cron.minutes : [...cron.minutes].reverse();
  for (let step = 0; step <= dayCount; step += 1) {
    const civil = new Date(firstDay + (order === "asc" ? step : dayCount - step) * 86_400_000);
    const year = civil.getUTCFullYear(), month = civil.getUTCMonth() + 1, day = civil.getUTCDate();
    if (!cron.months.has(month) || !cron.days.has(day) || !cron.weekdays.has(civil.getUTCDay())) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        const instant = zonedInstant(year, month, day, hour, minute, zone).getTime();
        if (instant <= startMs || instant > endMs) continue;
        // Skip wall-clock times that do not exist on a daylight-saving transition day.
        const actual = zonedParts(new Date(instant), zone);
        if (actual.hour !== hour || actual.minute !== minute || actual.day !== day) continue;
        return new Date(instant).toISOString();
      }
    }
  }
  return "";
}
