import { MANAGEMENT_TIME_ZONE, managementDateKey, managementDayBounds } from "./reporting_time.js";

export const QA_SHIFT_TIME_ZONE = MANAGEMENT_TIME_ZONE;
export const QA_SHIFT_INACTIVITY_GAP_MS = 4 * 60 * 60 * 1000;
export const QA_SHIFT_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type QaShiftPointEvent = {
  email: string;
  name?: string;
  occurredAtMs: number;
  points: number;
  projectId?: string;
};

export type QaShiftDetail = {
  id: string;
  date: string;
  email: string;
  name: string;
  started_at: string;
  ended_at: string;
  duration_minutes: number;
  approved_count: number;
  points: number;
};

export type QaShiftLeaderboardRow = {
  email: string;
  name: string;
  approved_count: number;
  points: number;
  projects_per_hour: number;
  points_per_hour: number;
  shift_count: number;
  shift_start_at: string;
  shift_end_at: string;
  active_hours: number;
  shifts: QaShiftDetail[];
  rank: number;
};

function validDateKey(value: string) {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() + 1 === Number(match[2])
    && date.getUTCDate() === Number(match[3]);
}

export function qaShiftDateKey(now = new Date()) {
  return managementDateKey(now);
}

export function normalizeQaShiftDateKey(value: unknown) {
  const requested = String(value ?? "").trim();
  return validDateKey(requested) ? requested : qaShiftDateKey();
}

export function qaShiftQueryWindow(date: string) {
  const bounds = managementDayBounds(date);
  const startMs = bounds.startMs;
  const endExclusiveMs = bounds.endExclusiveMs;
  return {
    date,
    startMs,
    endExclusiveMs,
    queryStartMs: startMs - QA_SHIFT_INACTIVITY_GAP_MS,
    queryEndMs: endExclusiveMs + QA_SHIFT_MAX_DURATION_MS
  };
}

export function buildQaShiftLeaderboard(events: QaShiftPointEvent[], date: string) {
  const targetDate = normalizeQaShiftDateKey(date);
  const byEmail = new Map<string, QaShiftPointEvent[]>();
  for (const rawEvent of Array.isArray(events) ? events : []) {
    const email = String(rawEvent?.email ?? "").trim().toLowerCase();
    const occurredAtMs = Number(rawEvent?.occurredAtMs);
    const points = Number(rawEvent?.points);
    if (!email || !Number.isFinite(occurredAtMs) || occurredAtMs <= 0 || !Number.isFinite(points) || points <= 0) continue;
    const event = { ...rawEvent, email, occurredAtMs, points };
    const list = byEmail.get(email) ?? [];
    list.push(event);
    byEmail.set(email, list);
  }

  const selectedShifts: QaShiftDetail[] = [];
  for (const [email, unsorted] of byEmail) {
    const ordered = [...unsorted].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
    let current: QaShiftPointEvent[] = [];
    const finishShift = () => {
      if (!current.length) return;
      const first = current[0]!;
      const last = current[current.length - 1]!;
      const shiftDate = qaShiftDateKey(new Date(first.occurredAtMs));
      if (shiftDate === targetDate) {
        selectedShifts.push({
          id: `${email}|${new Date(first.occurredAtMs).toISOString()}`,
          date: shiftDate,
          email,
          name: String(first.name || current.find((event) => event.name)?.name || email).trim() || email,
          started_at: new Date(first.occurredAtMs).toISOString(),
          ended_at: new Date(last.occurredAtMs).toISOString(),
          duration_minutes: Math.max(0, Math.round((last.occurredAtMs - first.occurredAtMs) / 60_000)),
          approved_count: current.length,
          points: Math.round(current.reduce((sum, event) => sum + event.points, 0) * 100) / 100
        });
      }
      current = [];
    };

    for (const event of ordered) {
      const previous = current[current.length - 1];
      if (previous && event.occurredAtMs - previous.occurredAtMs >= QA_SHIFT_INACTIVITY_GAP_MS) finishShift();
      current.push(event);
    }
    finishShift();
  }

  const rows = new Map<string, Omit<QaShiftLeaderboardRow, "rank">>();
  for (const shift of selectedShifts.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))) {
    const row = rows.get(shift.email) ?? {
      email: shift.email,
      name: shift.name,
      approved_count: 0,
      points: 0,
      projects_per_hour: 0,
      points_per_hour: 0,
      shift_count: 0,
      shift_start_at: shift.started_at,
      shift_end_at: shift.ended_at,
      active_hours: 0,
      shifts: []
    };
    row.approved_count += shift.approved_count;
    row.points += shift.points;
    row.shift_count += 1;
    row.shift_start_at = Date.parse(shift.started_at) < Date.parse(row.shift_start_at) ? shift.started_at : row.shift_start_at;
    row.shift_end_at = Date.parse(shift.ended_at) > Date.parse(row.shift_end_at) ? shift.ended_at : row.shift_end_at;
    row.active_hours += shift.duration_minutes / 60;
    row.shifts.push(shift);
    rows.set(shift.email, row);
  }

  const leaderboard = [...rows.values()]
    .map((row) => {
      const activeHours = Math.round(row.active_hours * 100) / 100;
      const rateHours = activeHours > 0 ? activeHours : 0;
      return {
        ...row,
        points: Math.round(row.points * 100) / 100,
        active_hours: activeHours,
        projects_per_hour: rateHours ? Math.round((row.approved_count / rateHours) * 100) / 100 : 0,
        points_per_hour: rateHours ? Math.round((row.points / rateHours) * 100) / 100 : 0
      };
    })
    .sort((a, b) => b.points - a.points || b.approved_count - a.approved_count || a.name.localeCompare(b.name))
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    success: true,
    leaderboard,
    shifts: selectedShifts,
    date: targetDate,
    timezone: QA_SHIFT_TIME_ZONE,
    shift_gap_hours: QA_SHIFT_INACTIVITY_GAP_MS / 3_600_000,
    cached: false
  };
}
