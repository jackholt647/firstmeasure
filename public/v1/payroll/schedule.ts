export type JsonObject = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function parseDate(value: unknown) {
  const text = cleanText(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysBetween(left: Date, right: Date) {
  return Math.round((right.getTime() - left.getTime()) / 86_400_000);
}

function timezoneFor(schedule: unknown) {
  const timezone = cleanText(asObject(schedule).timezone || "UTC") || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "UTC";
  }
}

function zonedIso(day: Date, hour: number, minute: number, second: number, millisecond: number, timezone: string) {
  const desired = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year || 1970, (parts.month || 1) - 1, parts.day || 1, parts.hour || 0, parts.minute || 0, parts.second || 0) - instant;
  };
  let instant = desired - offsetAt(desired);
  instant = desired - offsetAt(instant);
  return new Date(instant + millisecond).toISOString();
}

function endOfDayIso(value: Date, timezone: string) {
  return zonedIso(value, 23, 59, 59, 999, timezone);
}

function startOfDayIso(value: Date, timezone: string) {
  return zonedIso(value, 0, 0, 0, 0, timezone);
}

function monthDay(year: number, month: number, day: number) {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.max(1, Math.min(last, Math.floor(day)))));
}

function scheduleRecurrence(schedule: unknown) {
  return asObject(asObject(schedule).recurrence);
}

function scheduleDelay(schedule: unknown) {
  const delay = asObject(asObject(schedule).delay);
  return {
    periods: Math.max(0, Math.floor(Number(delay.periods || 0))),
    days: Math.max(0, Math.floor(Number(delay.days || 0)))
  };
}

export function payrollPayDates(schedule: unknown, fromValue: string, throughValue: string) {
  const from = parseDate(fromValue);
  const through = parseDate(throughValue);
  if (!from || !through || from > through) return [];
  const recurrence = scheduleRecurrence(schedule);
  const frequency = cleanText(recurrence.frequency);
  const numbers = (value: unknown) => (Array.isArray(value) ? value : []).map((entry) => Math.trunc(Number(entry))).filter(Number.isFinite);
  const anchor = parseDate(recurrence.anchor_date);
  const months = new Set(numbers(recurrence.months));
  const interval = Math.max(1, Math.trunc(Number(recurrence.interval || 0)) || (frequency === "biweekly" ? 2 : 1));
  const adjust = cleanText(recurrence.adjust);
  // A weekend pay day can move a few days, so look slightly past each end and trim afterwards.
  const start = addDays(from, -3), end = addDays(through, 3);
  const dates = new Set<string>();
  const add = (date: Date) => {
    if (months.size && !months.has(date.getUTCMonth() + 1)) return;
    const weekday = date.getUTCDay();
    const moved = weekday !== 0 && weekday !== 6 ? date
      : adjust === "previous_weekday" ? addDays(date, weekday === 6 ? -1 : -2)
        : adjust === "next_weekday" ? addDays(date, weekday === 6 ? 2 : 1) : date;
    if (moved >= from && moved <= through) dates.add(dateKey(moved));
  };

  if (frequency === "daily") {
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      if (interval === 1 || (anchor && ((daysBetween(anchor, cursor) % interval) + interval) % interval === 0)) add(cursor);
    }
  } else if (frequency === "weekly" || frequency === "biweekly") {
    const weekdays = new Set(numbers(recurrence.weekdays).length ? numbers(recurrence.weekdays) : [Math.max(0, Math.min(6, Math.floor(Number(recurrence.weekday || 0))))]);
    const weekOf = (date: Date) => addDays(date, -date.getUTCDay());
    const anchorWeek = anchor ? weekOf(anchor) : null;
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
      if (!weekdays.has(cursor.getUTCDay())) continue;
      const weeks = anchorWeek ? Math.round(daysBetween(anchorWeek, weekOf(cursor)) / 7) : 0;
      if (interval === 1 || !anchorWeek || ((weeks % interval) + interval) % interval === 0) add(cursor);
    }
  } else {
    const step = interval * (frequency === "quarterly" ? 3 : frequency === "yearly" ? 12 : 1);
    const anchorMonth = anchor ? anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() : 0;
    const positions = (Array.isArray(recurrence.nth_weekdays) ? recurrence.nth_weekdays : []).map((entry) => asObject(entry))
      .map((entry) => ({ nth: Math.trunc(Number(entry.nth)), weekday: Math.trunc(Number(entry.weekday)) })).filter((entry) => entry.nth && entry.weekday >= 0 && entry.weekday <= 6);
    const listed = numbers(recurrence.days).length ? numbers(recurrence.days) : recurrence.day !== undefined ? [Math.trunc(Number(recurrence.day))] : [];
    const days = [...new Set(listed.length || positions.length ? listed : frequency === "semi_monthly" ? [1, 15] : [1])].filter((day) => day !== 0);
    const monthCursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const finalMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    for (; monthCursor <= finalMonth; monthCursor.setUTCMonth(monthCursor.getUTCMonth() + 1)) {
      const year = monthCursor.getUTCFullYear(), month = monthCursor.getUTCMonth();
      if (frequency === "yearly") {
        // Named months decide which months of a paying year; otherwise it is the anchor's month, or January.
        const years = year - (anchor ? anchor.getUTCFullYear() : 0);
        if (((years % interval) + interval) % interval !== 0 || (!months.size && month !== (anchor ? anchor.getUTCMonth() : 0))) continue;
      } else {
        const index = year * 12 + month - anchorMonth;
        if (step > 1 && ((index % step) + step) % step !== 0) continue;
      }
      const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      // A day past the end of a short month pays on its last day; a negative day counts back from the end.
      for (const day of days) add(monthDay(year, month, day > 0 ? day : last + 1 + day));
      for (const position of positions) {
        const matches = Array.from({ length: last }, (_value, offset) => new Date(Date.UTC(year, month, offset + 1))).filter((date) => date.getUTCDay() === position.weekday);
        const chosen = position.nth > 0 ? matches[position.nth - 1] : matches[matches.length + position.nth];
        if (chosen) add(chosen);
      }
    }
  }

  return [...dates].sort();
}

function adjacentPayDate(schedule: unknown, payDateValue: string, direction: -1 | 1) {
  const payDate = parseDate(payDateValue);
  if (!payDate) return "";
  const from = direction < 0 ? addDays(payDate, -400) : addDays(payDate, 1);
  const through = direction < 0 ? addDays(payDate, -1) : addDays(payDate, 400);
  const dates = payrollPayDates(schedule, dateKey(from), dateKey(through));
  return direction < 0 ? dates.at(-1) || "" : dates[0] || "";
}

function shiftedByPeriods(schedule: unknown, payDateValue: string, periods: number) {
  let result = payDateValue;
  const direction: -1 | 1 = periods < 0 ? -1 : 1;
  for (let index = 0; index < Math.abs(periods); index += 1) {
    result = adjacentPayDate(schedule, result, direction);
    if (!result) break;
  }
  return result;
}

function cutoffDate(schedule: unknown, payDateValue: string) {
  const payDate = parseDate(payDateValue);
  if (!payDate) return null;
  const delay = scheduleDelay(schedule);
  const shifted = delay.periods ? parseDate(shiftedByPeriods(schedule, payDateValue, -delay.periods)) : payDate;
  return shifted ? addDays(shifted, -delay.days) : null;
}

export function payrollOccurrence(schedule: unknown, payDateValue: string) {
  const scheduleValue = asObject(schedule);
  const payDate = parseDate(payDateValue);
  const cutoff = cutoffDate(schedule, payDateValue);
  if (!payDate || !cutoff) return null;
  // Only a day the schedule actually pays on is an occurrence of it.
  if (!payrollPayDates(schedule, dateKey(payDate), dateKey(payDate)).length) return null;
  const previousPayDate = adjacentPayDate(schedule, payDateValue, -1);
  const previousCutoff = previousPayDate ? cutoffDate(schedule, previousPayDate) : null;
  const periodStart = previousCutoff ? addDays(previousCutoff, 1) : addDays(cutoff, -31);
  const timezone = timezoneFor(schedule);
  return {
    schedule_id: cleanText(scheduleValue.id),
    schedule_name: cleanText(scheduleValue.name),
    pay_date: dateKey(payDate),
    period_start: startOfDayIso(periodStart, timezone),
    period_end: endOfDayIso(cutoff, timezone),
    cutoff_at: endOfDayIso(cutoff, timezone),
    timezone,
    currency: cleanText(scheduleValue.currency || "USD")
  };
}

export function payrollOccurrences(schedule: unknown, fromValue: string, throughValue: string) {
  return payrollPayDates(schedule, fromValue, throughValue)
    .map((payDate) => payrollOccurrence(schedule, payDate))
    .filter((value): value is NonNullable<typeof value> => !!value);
}

export function payrollEligibleAt(input: JsonObject, timingBasis: string) {
  const explicit = cleanText(input.eligible_at);
  if (explicit) return explicit;
  const workedAt = cleanText(input.worked_at);
  const completedAt = cleanText(input.completed_at);
  const selected = timingBasis === "completed" ? (completedAt || workedAt) : (workedAt || completedAt);
  return selected || new Date().toISOString();
}
