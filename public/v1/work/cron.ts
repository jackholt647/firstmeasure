// Minimal 5-field cron support for scheduled automation rules:
//   "minute hour day-of-month month day-of-week"
// Supports: * , - */n and plain numbers. Day-of-week 0-6 (Sunday=0; 7 also
// accepted as Sunday). Evaluated in server-local time, or in an explicit
// IANA timezone when one is passed.

import { zonedParts } from "../platform/timezone.js";

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
  for (let minute = nowMinute; minute >= lowerBound; minute -= 60_000) {
    if (cronMatches(expression, new Date(minute), timezone)) return new Date(minute).toISOString();
  }
  return "";
}
