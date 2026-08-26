export const MANAGEMENT_TIME_ZONE = "America/Los_Angeles";

type CalendarDateParts = {
  year: number;
  month: number;
  day: number;
};

function timeZoneDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: valueFor("year"),
    month: valueFor("month"),
    day: valueFor("day"),
    hour: valueFor("hour"),
    minute: valueFor("minute"),
    second: valueFor("second")
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = timeZoneDateTimeParts(date, timeZone);
  const representedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const inputMsWithoutFraction = Math.trunc(date.getTime() / 1000) * 1000;
  return representedMs - inputMsWithoutFraction;
}

function calendarDateParts(date: Date, timeZone: string): CalendarDateParts {
  const parts = timeZoneDateTimeParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function localMidnightUtcMs(parts: CalendarDateParts, timeZone: string) {
  const naiveUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day);
  let resolvedMs = naiveUtcMs - timeZoneOffsetMs(new Date(naiveUtcMs), timeZone);
  // Resolve once more using the offset that applies at the actual instant. This
  // is what makes the boundary follow daylight-saving transitions.
  resolvedMs = naiveUtcMs - timeZoneOffsetMs(new Date(resolvedMs), timeZone);
  return resolvedMs;
}

function nextCalendarDate(parts: CalendarDateParts): CalendarDateParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function parseDateKey(value: string): CalendarDateParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const normalized = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (normalized.getUTCFullYear() !== parts.year || normalized.getUTCMonth() + 1 !== parts.month || normalized.getUTCDate() !== parts.day) return null;
  return parts;
}

export function managementDateKey(now = new Date()) {
  const parts = calendarDateParts(now, MANAGEMENT_TIME_ZONE);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function managementDayBounds(date = managementDateKey()) {
  const parts = parseDateKey(date);
  if (!parts) throw new Error(`Invalid management calendar date: ${date}`);
  return {
    date,
    timeZone: MANAGEMENT_TIME_ZONE,
    startMs: localMidnightUtcMs(parts, MANAGEMENT_TIME_ZONE),
    endExclusiveMs: localMidnightUtcMs(nextCalendarDate(parts), MANAGEMENT_TIME_ZONE)
  };
}

