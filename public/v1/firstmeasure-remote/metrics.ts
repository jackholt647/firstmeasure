import { getFirstMeasureProjectIndexDb, getIndexedQueueCounts } from "../firstmeasure/project_index.js";

type JsonObject = Record<string, unknown>;
type SqlValue = string | number | null;

const DATE_COLUMNS = {
  created: "created_at_ms",
  queued: "queued_at_ms",
  started: "started_at_ms",
  completed: "completed_at_ms",
  updated: "updated_at_ms"
} as const;

const GROUP_COLUMNS = {
  status: "status",
  project_type: "project_type",
  team_id: "team_id"
} as const;

function text(value: unknown) {
  return String(value ?? "").trim();
}

function boundedStrings(value: unknown, max = 20) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter((item) => item && item.length <= 100))].slice(0, max);
}

function validTimezone(value: unknown) {
  const timezone = text(value) || "America/Los_Angeles";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new RemoteMetricsInputError("invalid_timezone", "timezone must be a valid IANA timezone.");
  }
}

function dateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function timezoneOffsetMs(date: Date, timezone: string) {
  const parts = dateParts(date, timezone);
  const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return represented - Math.floor(date.getTime() / 1000) * 1000;
}

function localMidnightUtc(year: number, month: number, day: number, timezone: string) {
  const naive = Date.UTC(year, month - 1, day);
  let resolved = naive - timezoneOffsetMs(new Date(naive), timezone);
  resolved = naive - timezoneOffsetMs(new Date(resolved), timezone);
  return resolved;
}

function currentDayBounds(timezone: string, now = new Date()) {
  const parts = dateParts(now, timezone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const startMs = localMidnightUtc(year, month, day, timezone);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  const endMs = localMidnightUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), timezone);
  return {
    localDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    startMs,
    endMs
  };
}

function countProjects(options: { statuses?: string[]; dateColumn?: string; startMs?: number; endMs?: number; teamId?: string }) {
  const db = getFirstMeasureProjectIndexDb();
  const where = ["instant_only = 0"];
  const params: Record<string, SqlValue> = {};
  if (options.teamId) {
    where.push("team_id = $teamId");
    params.teamId = options.teamId;
  }
  if (options.statuses?.length) {
    const placeholders = options.statuses.map((status, index) => {
      params[`status${index}`] = status;
      return `$status${index}`;
    });
    where.push(`status IN (${placeholders.join(", ")})`);
  }
  if (options.dateColumn && options.startMs != null && options.endMs != null) {
    where.push(`${options.dateColumn} >= $startMs AND ${options.dateColumn} < $endMs`);
    params.startMs = options.startMs;
    params.endMs = options.endMs;
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM projects WHERE ${where.join(" AND ")}`).get(params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

export class RemoteMetricsInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RemoteMetricsInputError";
  }
}

export async function buildRemoteSummary(input: JsonObject = {}) {
  const timezone = validTimezone(input.timezone);
  const teamId = text(input.team_id);
  if (teamId.length > 100) throw new RemoteMetricsInputError("invalid_team_id", "team_id is too long.");
  const day = currentDayBounds(timezone);
  const queue = await getIndexedQueueCounts({ team_id: teamId || undefined });
  const queryTeamNote = teamId ? { team_id: teamId } : {};

  // Cohort counts use created_at; completed_today uses completed_at independently.
  const total = countProjects({ teamId });
  const orderedToday = countProjects({ teamId, dateColumn: "created_at_ms", startMs: day.startMs, endMs: day.endMs });
  const orderedTodayCompleted = countProjects({ teamId, statuses: ["completed"], dateColumn: "created_at_ms", startMs: day.startMs, endMs: day.endMs });
  const completedToday = countProjects({ teamId, statuses: ["completed"], dateColumn: "completed_at_ms", startMs: day.startMs, endMs: day.endMs });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    timezone,
    local_date: day.localDate,
    filters: queryTeamNote,
    projects: {
      total,
      ordered_today: orderedToday,
      ordered_today_completed: orderedTodayCompleted,
      completed_today: completedToday
    },
    queue: queue.groups,
    queue_total: queue.total,
    queue_version: queue.version,
    definitions: {
      ordered_today: "Projects whose created_at falls within the current local day.",
      ordered_today_completed: "Today's ordered-project cohort whose current status is completed.",
      completed_today: "Projects whose completed_at falls within the current local day."
    }
  };
}

function parseDate(value: unknown, field: string) {
  if (value == null || value === "") return null;
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) throw new RemoteMetricsInputError("invalid_date", `${field} must be an ISO-8601 date/time.`);
  return parsed;
}

export function runRemoteAggregateQuery(input: JsonObject = {}) {
  const dateField = text(input.date_field || "created") as keyof typeof DATE_COLUMNS;
  const dateColumn = DATE_COLUMNS[dateField];
  if (!dateColumn) throw new RemoteMetricsInputError("invalid_date_field", `date_field must be one of: ${Object.keys(DATE_COLUMNS).join(", ")}.`);
  const groupBy = text(input.group_by || "status");
  const groupColumn = GROUP_COLUMNS[groupBy as keyof typeof GROUP_COLUMNS];
  if (groupBy !== "none" && groupBy !== "day" && !groupColumn) {
    throw new RemoteMetricsInputError("invalid_group_by", `group_by must be one of: none, day, ${Object.keys(GROUP_COLUMNS).join(", ")}.`);
  }
  const startMs = parseDate(input.start, "start");
  const endMs = parseDate(input.end, "end");
  if (startMs != null && endMs != null && startMs >= endMs) throw new RemoteMetricsInputError("invalid_range", "start must be earlier than end.");
  const statuses = boundedStrings(input.statuses);
  const projectTypes = boundedStrings(input.project_types);
  const teamId = text(input.team_id);
  if (teamId.length > 100) throw new RemoteMetricsInputError("invalid_team_id", "team_id is too long.");

  const where = ["instant_only = 0"];
  const params: Record<string, SqlValue> = {};
  if (startMs != null) { where.push(`${dateColumn} >= $startMs`); params.startMs = startMs; }
  if (endMs != null) { where.push(`${dateColumn} < $endMs`); params.endMs = endMs; }
  if (teamId) { where.push("team_id = $teamId"); params.teamId = teamId; }
  if (statuses.length) {
    const values = statuses.map((status, index) => { params[`status${index}`] = status; return `$status${index}`; });
    where.push(`status IN (${values.join(", ")})`);
  }
  if (projectTypes.length) {
    const values = projectTypes.map((type, index) => { params[`type${index}`] = type; return `$type${index}`; });
    where.push(`project_type IN (${values.join(", ")})`);
  }

  let groupExpression = "'all'";
  if (groupBy === "day") groupExpression = `strftime('%Y-%m-%d', ${dateColumn} / 1000, 'unixepoch')`;
  else if (groupColumn) groupExpression = `COALESCE(NULLIF(${groupColumn}, ''), 'unknown')`;
  const db = getFirstMeasureProjectIndexDb();
  const rows = db.prepare(`
    SELECT ${groupExpression} AS group_key, COUNT(*) AS project_count
    FROM projects
    WHERE ${where.join(" AND ")}
    GROUP BY group_key
    ORDER BY project_count DESC, group_key ASC
    LIMIT 500
  `).all(params) as Array<{ group_key?: string; project_count?: number }>;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    metric: "project_count",
    date_field: dateField,
    group_by: groupBy,
    filters: { start: input.start || null, end: input.end || null, statuses, project_types: projectTypes, team_id: teamId || null },
    total: rows.reduce((sum, row) => sum + Number(row.project_count ?? 0), 0),
    rows: rows.map((row) => ({ group: row.group_key || "unknown", project_count: Number(row.project_count ?? 0) }))
  };
}
