import type { JsonObject } from "../platform/storage.js";
import { zonedInstant, zonedParts } from "../platform/timezone.js";
import { eventChildren, eventIsFixed, eventWindow } from "./event-model.js";

/**
 * Where a child event sits relative to its parent, and the one routine that moves children when a parent moves. See
 * docs/architecture/schedule-events.md. Pure: callers pass the events and persist what comes back.
 */

export type PlacementAmount = { value?: number; expression?: unknown; unit: PlacementUnit; adjust?: { calendar: "business_day"; direction: "previous" | "next" } };
export type PlacementUnit = "minute" | "hour" | "day" | "business_day" | "week";
export type Placement = {
  anchor: "start" | "end" | "span";
  offset?: PlacementAmount;
  duration?: PlacementAmount;
  all_day?: boolean;
  /** Set when someone moved the child by hand; the offset is then a fixed distance from the parent. */
  manual?: boolean;
};
export type PlacementContext = { timezone: string; measurements?: JsonObject };

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const UNITS: PlacementUnit[] = ["minute", "hour", "day", "business_day", "week"];
const MINUTE = 60000, DAY = 86400000;

function normalizeAmount(value: unknown): PlacementAmount | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? { value, unit: "day" } : undefined;
  const input = obj(value);
  if (!Object.keys(input).length) return undefined;
  const unit = text(input.unit || "day").toLowerCase().replace(/s$/, "") as PlacementUnit;
  const adjust = obj(input.adjust);
  const amount: PlacementAmount = { unit: UNITS.includes(unit) ? unit : "day" };
  if (input.expression !== undefined && input.expression !== null) amount.expression = input.expression;
  else amount.value = Number.isFinite(Number(input.value)) ? Number(input.value) : 0;
  if (text(adjust.calendar).toLowerCase().replace(/s$/, "") === "business_day") amount.adjust = { calendar: "business_day", direction: text(adjust.direction).toLowerCase() === "next" ? "next" : "previous" };
  return amount;
}

/** A stored or template placement in its one shape, or null when there is none. */
export function normalizePlacement(value: unknown): Placement | null {
  const input = obj(value);
  if (!Object.keys(input).length) return null;
  const anchor = text(input.anchor).toLowerCase();
  const placement: Placement = { anchor: anchor === "end" ? "end" : anchor === "span" ? "span" : "start" };
  if (placement.anchor !== "span") {
    const offset = normalizeAmount(input.offset);
    if (offset) placement.offset = offset;
    const duration = normalizeAmount(input.duration);
    if (duration) placement.duration = duration;
  }
  if (input.all_day === true || input.all_day === false) placement.all_day = input.all_day;
  if (input.manual === true) placement.manual = true;
  return placement;
}

function readPath(source: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), source);
}

/** Arithmetic over numbers and `{ ref }` paths into the context. Anything it cannot read counts as zero. */
export function evaluatePlacementExpression(expression: unknown, context: JsonObject): number {
  if (typeof expression === "number") return Number.isFinite(expression) ? expression : 0;
  if (typeof expression === "string") { const numeric = Number(expression); return Number.isFinite(numeric) ? numeric : Number(readPath(context, expression) || 0) || 0; }
  const rule = obj(expression);
  if (rule.ref) return Number(readPath(context, text(rule.ref)) ?? rule.fallback ?? 0) || 0;
  const operator = text(rule.operator).toLowerCase();
  if (!operator) return rule.value === undefined ? 0 : evaluatePlacementExpression(rule.value, context);
  const operands = Array.isArray(rule.operands)
    ? rule.operands.map((entry) => evaluatePlacementExpression(entry, context))
    : [evaluatePlacementExpression(rule.left ?? rule.value ?? 0, context), evaluatePlacementExpression(rule.right ?? 0, context)];
  const [left = 0, right = 0] = operands;
  switch (operator) {
    case "add": return operands.reduce((sum, value) => sum + value, 0);
    case "subtract": return left - right;
    case "multiply": return operands.reduce((product, value) => product * value, 1);
    case "divide": return right === 0 ? 0 : left / right;
    case "floor": return Math.floor(left);
    case "ceil": return Math.ceil(left);
    case "round": return Math.round(left);
    case "min": return Math.min(...operands);
    case "max": return Math.max(...operands);
    case "coalesce": return operands.find((value) => Number.isFinite(value) && value !== 0) ?? 0;
    default: return 0;
  }
}

// ---- Calendar arithmetic in the organization's timezone ----
type Local = { year: number; month: number; day: number; hour: number; minute: number };
const local = (instant: number, timezone: string): Local => zonedParts(new Date(instant), timezone);
const instant = (parts: Local, timezone: string) => zonedInstant(parts.year, parts.month, parts.day, parts.hour, parts.minute, timezone).getTime();
const weekday = (parts: Local) => new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
const isWeekend = (parts: Local) => [0, 6].includes(weekday(parts));
function shiftDays(parts: Local, days: number): Local {
  const moved = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { ...parts, year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}
const localMidnight = (at: number, timezone: string) => instant({ ...local(at, timezone), hour: 0, minute: 0 }, timezone);
const addLocalDays = (at: number, days: number, timezone: string) => instant(shiftDays(local(at, timezone), days), timezone);
/** Whole local days between two instants' dates. */
function localDayDifference(from: number, to: number, timezone: string) {
  const a = local(from, timezone), b = local(to, timezone);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY);
}

function applyAmount(base: number, amount: PlacementAmount | undefined, context: JsonObject, timezone: string): number {
  if (!amount) return base;
  const value = amount.expression !== undefined ? evaluatePlacementExpression(amount.expression, context) : Number(amount.value || 0);
  let result: number;
  if (amount.unit === "minute") result = base + value * MINUTE;
  else if (amount.unit === "hour") result = base + value * 60 * MINUTE;
  else if (amount.unit === "business_day") {
    let parts = local(base, timezone);
    const direction = value < 0 ? -1 : 1;
    for (let remaining = Math.abs(Math.trunc(value)); remaining > 0;) { parts = shiftDays(parts, direction); if (!isWeekend(parts)) remaining -= 1; }
    result = instant(parts, timezone);
  } else {
    const days = amount.unit === "week" ? value * 7 : value;
    // Whole days keep the local time of day across a clock change; a fraction of a day is plain elapsed time.
    result = Number.isInteger(days) ? addLocalDays(base, days, timezone) : base + days * DAY;
  }
  if (amount.adjust) {
    let parts = local(result, timezone);
    const direction = amount.adjust.direction === "next" ? 1 : -1;
    while (isWeekend(parts)) parts = shiftDays(parts, direction);
    result = instant(parts, timezone);
  }
  return result;
}

function amountMinutes(amount: PlacementAmount, context: JsonObject) {
  const value = amount.expression !== undefined ? evaluatePlacementExpression(amount.expression, context) : Number(amount.value || 0);
  const perUnit = amount.unit === "minute" ? 1 : amount.unit === "hour" ? 60 : amount.unit === "week" ? 7 * 1440 : 1440;
  return value * perUnit;
}

/** How long a scope template suggests a span should run, in minutes, or 0 when it suggests nothing. Reads `measurements.<key>`. */
export function suggestedDurationMinutes(value: unknown, measurements: JsonObject = {}): number {
  const amount = normalizeAmount(value);
  return amount ? Math.max(0, Math.round(amountMinutes(amount, { measurements }))) : 0;
}

export type Window = { start: number; end: number };

/** The range a child holds for a given parent range. `child` supplies the length to keep when the placement names none. */
export function evaluatePlacement(placement: Placement, parent: Window, child: unknown, ctx: PlacementContext): Window & { all_day: boolean } {
  const childEvent = obj(child);
  const parentMinutes = Math.max(1, Math.round((parent.end - parent.start) / MINUTE));
  const context: JsonObject = { parent: { duration: { minutes: parentMinutes, days: Math.max(1, localDayDifference(parent.start, parent.end, ctx.timezone) || Math.round(parentMinutes / 1440)) } }, measurements: ctx.measurements || {} };
  if (placement.anchor === "span") return { start: parent.start, end: parent.end, all_day: placement.all_day ?? childEvent.all_day === true };
  const allDay = placement.all_day ?? childEvent.all_day === true;
  let start = applyAmount(placement.anchor === "end" ? parent.end : parent.start, placement.offset, context, ctx.timezone);
  const current = eventWindow({ ...childEvent, status: "scheduled" });
  const keptMinutes = current ? Math.round((current.end - current.start) / MINUTE) : Math.max(1, Number(childEvent.duration_minutes || (allDay ? 1440 : 60)));
  const minutes = Math.max(1, placement.duration ? amountMinutes(placement.duration, context) : keptMinutes);
  if (allDay) {
    start = localMidnight(start, ctx.timezone);
    return { start, end: addLocalDays(start, Math.max(1, Math.round(minutes / 1440)), ctx.timezone), all_day: true };
  }
  return { start, end: start + Math.round(minutes) * MINUTE, all_day: false };
}

/** The placement that keeps a child exactly where it now is, as a fixed distance from its parent's start. */
export function manualPlacement(child: Window & { all_day?: boolean }, parent: Window, ctx: PlacementContext): Placement {
  if (child.all_day) {
    return {
      anchor: "start",
      offset: { value: localDayDifference(parent.start, child.start, ctx.timezone), unit: "day" },
      duration: { value: Math.max(1, localDayDifference(child.start, child.end, ctx.timezone)), unit: "day" },
      all_day: true,
      manual: true
    };
  }
  return {
    anchor: "start",
    offset: { value: Math.round((child.start - parent.start) / MINUTE), unit: "minute" },
    duration: { value: Math.max(1, Math.round((child.end - child.start) / MINUTE)), unit: "minute" },
    all_day: false,
    manual: true
  };
}

export type PlacedChildren = {
  /** Children whose stored range or status changed, in their new state. */
  updated: JsonObject[];
  /** Locked or finished children that should have moved and did not. */
  blocked: JsonObject[];
};

/**
 * Re-places everything under one parent after that parent's range changed. `events` is the project's events with the
 * parent already in its new state. Children that carry no placement are left alone, as are their own children.
 */
export function placeChildren(events: unknown[], parentId: string, ctx: PlacementContext, now = new Date().toISOString()): PlacedChildren {
  const working = events.map(obj).map((event) => ({ ...event }));
  const byId = new Map(working.map((event) => [text(event.id), event]));
  const updated: JsonObject[] = [], blocked: JsonObject[] = [];
  const seen = new Set<string>([text(parentId)]);
  const queue = [text(parentId)];
  while (queue.length) {
    const parent = byId.get(queue.shift()!);
    if (!parent) continue;
    const parentWindow = eventWindow(parent);
    for (const stored of eventChildren(working, text(parent.id))) {
      const id = text(stored.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const placement = normalizePlacement(stored.placement);
      if (!placement) continue;
      const current = eventWindow(stored);
      const target = parentWindow ? evaluatePlacement(placement, parentWindow, stored, ctx) : null;
      const unchanged = target ? !!current && current.start === target.start && current.end === target.end : !current;
      if (unchanged) { queue.push(id); continue; }
      if (eventIsFixed(stored)) { blocked.push(stored); continue; }
      const child = byId.get(id)!;
      if (target) {
        child.start_at = new Date(target.start).toISOString();
        child.end_at = new Date(target.end).toISOString();
        child.duration_minutes = Math.max(1, Math.round((target.end - target.start) / MINUTE));
        child.all_day = target.all_day;
        if (text(child.status).toLowerCase() === "unscheduled" || !text(child.status)) child.status = "scheduled";
      } else {
        child.start_at = "";
        child.end_at = "";
        child.status = "unscheduled";
      }
      child.event_revision = Math.max(0, Math.floor(Number(child.event_revision) || 0)) + 1;
      child.updated_at = now;
      updated.push(child);
      queue.push(id);
    }
  }
  return { updated, blocked };
}
