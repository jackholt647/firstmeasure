/* Day-routing service: gathers an organization's scheduled events for one day
 * and one event type, resolves the subjects the event type's assignment policy
 * allows, estimates travel between stops, runs the optimizer, and (optionally)
 * writes the winning assignments back onto the project events.
 *
 * Deliberately data-driven: the event type id is a parameter, eligibility comes
 * from the same assignment-policy engine the schedulers use, and travel knobs
 * are read from the branch scheduling module's optional `routing` object.
 */

import { PlatformError } from "../platform/errors.js";
import {
  listDocuments,
  readBranchModule,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { assignmentPolicyForEventType } from "../workforce/assignability.js";
import { resolveAssignableSubjects } from "../workforce/service.js";
import {
  normalizeSchedulingAvailabilitySettings,
  resourceAvailabilityCapacity,
  subjectUnavailableOnDate
} from "../appointments/availability.js";
import { resolveOrganizationTimezone, zonedInstant, zonedParts } from "../platform/timezone.js";
import { haversineKm, optimizeRoutes, type RoutingStop } from "./optimizer.js";

type TravelConfig = {
  average_speed_kmh: number;
  road_factor: number;
  min_travel_minutes: number;
  default_travel_minutes: number;
  /* Extra feasibility margin per leg: estimates are optimistic, and live
   * Distance Matrix numbers often come in above them. */
  travel_slack_minutes: number;
  fixed_buffer_minutes: number;
};

const DEFAULT_TRAVEL_CONFIG: TravelConfig = {
  average_speed_kmh: 40,
  road_factor: 1.35,
  min_travel_minutes: 5,
  default_travel_minutes: 20,
  travel_slack_minutes: 5,
  fixed_buffer_minutes: 0
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function finiteNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) && num !== 0 ? num : null;
}

/* Mirrors the frontend addressKey()/travelKey() normalization so cached
 * google_distance_matrix entries on project.travel_times are reusable here. */
function addressKey(value: unknown) {
  return cleanText(value).toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s#-]/g, "").trim();
}

function travelCacheKey(origin: unknown, destination: unknown) {
  return `${addressKey(origin)}=>${addressKey(destination)}`;
}

function routableAddress(event: JsonObject, project: JsonObject) {
  const manifest = asObject(project.manifest);
  return [project.address, project.project_address, project.property_address, project.formatted_address, manifest.address, event.project_address]
    .map(cleanText)
    .find((value) => value && !/^(?:no|missing|unknown|n\/?a)(?:\s+address)?(?:\s+yet)?$/i.test(value)) || "";
}

type StopContext = {
  event: JsonObject;
  projectId: string;
  projectTitle: string;
  address: string;
  lat: number | null;
  lng: number | null;
};

function eventTypeIdOf(event: JsonObject) {
  return cleanText(event.event_type_default_id || event.type_id || event.event_type_id);
}

function eventAssignedUserId(event: JsonObject) {
  const ids = Array.isArray(event.assigned_user_ids) ? event.assigned_user_ids : [];
  return cleanText(event.assigned_user_id || ids[0]);
}

function eventAssignedSubjectId(event: JsonObject) {
  const ref = asObject(event.work_resource_ref);
  return cleanText(ref.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id) || eventAssignedUserId(event);
}

export type OptimizeDayInput = {
  event_type_id: string;
  date?: string;
  window_start?: string;
  window_end?: string;
  branch_id?: string;
  apply?: boolean;
  /* Keep existing assignments fixed instead of reshuffling the whole day. */
  keep_existing?: boolean;
  actor?: { userId?: string; name?: string };
};

export async function optimizeDayRouting(orgId: string, input: OptimizeDayInput) {
  const eventTypeId = cleanText(input.event_type_id);
  if (!eventTypeId) throw new PlatformError("routing_event_type_required", 400, "Provide the event type to route.");
  const branchId = cleanText(input.branch_id) || "default";
  const timezone = await resolveOrganizationTimezone(orgId, branchId);

  let windowStart: Date;
  let windowEnd: Date;
  if (cleanText(input.window_start) && cleanText(input.window_end)) {
    windowStart = new Date(cleanText(input.window_start));
    windowEnd = new Date(cleanText(input.window_end));
  } else {
    const date = cleanText(input.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new PlatformError("routing_date_required", 400, "Provide date (YYYY-MM-DD) or window_start/window_end.");
    }
    const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
    windowStart = zonedInstant(year, month, day, 0, 0, timezone);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    windowEnd = zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timezone);
  }
  if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowEnd <= windowStart) {
    throw new PlatformError("routing_window_invalid", 400, "The routing window is invalid.");
  }

  const schedulingModule = await readBranchModule(orgId, branchId, "scheduling").catch(() => null);
  const schedulingData = asObject(asObject(schedulingModule).data);
  const availabilitySettings = normalizeSchedulingAvailabilitySettings(schedulingData);
  const eventType = asObject(asObject(schedulingData.event_types)[eventTypeId]);
  const policy = assignmentPolicyForEventType(eventType, eventTypeId);
  const routingConfig = asObject(schedulingData.routing);
  const sharedTravel = availabilitySettings.travel;
  const travelConfig: TravelConfig = {
    average_speed_kmh: sharedTravel.enabled ? sharedTravel.average_speed_mph * 1.609344 : (Number(routingConfig.average_speed_kmh) > 0 ? Number(routingConfig.average_speed_kmh) : DEFAULT_TRAVEL_CONFIG.average_speed_kmh),
    road_factor: sharedTravel.enabled ? sharedTravel.multiplier : (Number(routingConfig.road_factor) > 0 ? Number(routingConfig.road_factor) : DEFAULT_TRAVEL_CONFIG.road_factor),
    min_travel_minutes: sharedTravel.enabled ? sharedTravel.minimum_minutes : (Number(routingConfig.min_travel_minutes) > 0 ? Number(routingConfig.min_travel_minutes) : DEFAULT_TRAVEL_CONFIG.min_travel_minutes),
    default_travel_minutes: sharedTravel.enabled ? sharedTravel.default_minutes : (Number(routingConfig.default_travel_minutes) > 0 ? Number(routingConfig.default_travel_minutes) : DEFAULT_TRAVEL_CONFIG.default_travel_minutes),
    travel_slack_minutes: sharedTravel.enabled ? sharedTravel.slack_minutes : (Number(routingConfig.travel_slack_minutes) >= 0 && routingConfig.travel_slack_minutes !== undefined
      ? Number(routingConfig.travel_slack_minutes)
      : DEFAULT_TRAVEL_CONFIG.travel_slack_minutes),
    fixed_buffer_minutes: sharedTravel.enabled ? sharedTravel.fixed_buffer_minutes : 0
  };

  /* Per-day unavailability lives in the scheduling module as
   * unavailability: { "<subject_id>": ["YYYY-MM-DD", ...] } — subject-type
   * agnostic, toggled from the routing view's resource column. */
  const windowDates: string[] = [];
  for (let day = new Date(windowStart); day < windowEnd; day = new Date(day.getTime() + 24 * 60 * 60_000)) {
    const parts = zonedParts(day, timezone);
    const key = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    if (!windowDates.includes(key)) windowDates.push(key);
  }
  const subjectUnavailable = (subjectId: string) => windowDates.some((date) => subjectUnavailableOnDate(schedulingData, subjectId, date));

  const resolved = await resolveAssignableSubjects(orgId, branchId, policy);
  const allSubjects = (resolved.subjects as JsonObject[])
    .filter((subject) => !["disabled", "deleted", "archived"].includes(cleanText(subject.status).toLowerCase()))
    .map((subject) => ({
      id: cleanText(subject.id),
      name: cleanText(subject.name || asObject(subject.user).name || subject.id),
      subject_type: cleanText(subject.subject_type)
    }))
    .filter((subject) => subject.id);
  const unavailableSubjects = allSubjects.filter((subject) => subjectUnavailable(subject.id));
  const subjects = allSubjects.filter((subject) => !subjectUnavailable(subject.id));
  if (!subjects.length) {
    throw new PlatformError("routing_no_subjects", 400, "No assignable people or resources satisfy this event type's assignment policy.");
  }

  /* Collect the day's stops and a travel cache from every project. */
  const projects = await listDocuments(orgId, "projects");
  const stopContexts = new Map<string, StopContext>();
  const stops: RoutingStop[] = [];
  const skippedMissingAddress: Array<{ event_id: string; project_id: string; project_title: string; reason: "missing_address" }> = [];
  const cachedTravel = new Map<string, number>();
  const subjectIds = new Set(subjects.map((subject) => subject.id));

  for (const document of projects) {
    const data = asObject(asObject(document).data);
    for (const [key, valueRaw] of Object.entries(asObject(data.travel_times))) {
      const value = asObject(valueRaw);
      const minutes = Number(value.minutes ?? valueRaw);
      if (key && Number.isFinite(minutes) && minutes > 0) cachedTravel.set(key, minutes);
    }
    const events = Array.isArray(data.events) ? data.events : [];
    for (const eventRaw of events) {
      const event = asObject(eventRaw);
      const status = cleanText(event.status).toLowerCase();
      if (["unscheduled", "cancelled", "canceled"].includes(status)) continue;
      const start = new Date(cleanText(event.start_at || event.start));
      const end = new Date(cleanText(event.end_at || event.end));
      if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) continue;
      if (eventTypeIdOf(event) !== eventTypeId) {
        /* A subject's OTHER timed commitments inside the window become pinned
         * "busy" blocks so the optimizer never double-books around them. */
        const assignee = eventAssignedSubjectId(event);
        if (!assignee || !subjectIds.has(assignee)) continue;
        if (end <= windowStart || start >= windowEnd) continue;
        const granularity = cleanText(event.schedule_granularity).toLowerCase();
        if (event.all_day === true || granularity === "date") continue;
        const busyId = `__busy_${cleanText(asObject(document).id)}_${cleanText(event.id) || String(stops.length)}`;
        if (stopContexts.has(busyId)) continue;
        stopContexts.set(busyId, {
          event,
          projectId: cleanText(asObject(document).id),
          projectTitle: cleanText(data.title || asObject(document).id),
          address: cleanText(event.project_address || data.address),
          lat: finiteNumber(data.lat),
          lng: finiteNumber(data.lng)
        });
        stops.push({ id: busyId, start_ms: start.getTime(), end_ms: end.getTime(), locked_subject_id: assignee });
        continue;
      }
      if (start < windowStart || start >= windowEnd) continue;
      const stopId = cleanText(event.id);
      if (!stopId || stopContexts.has(stopId)) continue;
      const projectId = cleanText(asObject(document).id);
      const projectTitle = cleanText(data.title || asObject(document).id);
      const address = routableAddress(event, data);
      if (!address) {
        skippedMissingAddress.push({
          event_id: stopId,
          project_id: projectId,
          project_title: projectTitle,
          reason: "missing_address"
        });
        continue;
      }
      const assignedSubject = eventAssignedSubjectId(event);
      const pinned = (event.locked === true || input.keep_existing === true)
        && assignedSubject && subjectIds.has(assignedSubject)
        ? assignedSubject
        : "";
      stopContexts.set(stopId, {
        event,
        projectId,
        projectTitle,
        address,
        lat: finiteNumber(data.lat),
        lng: finiteNumber(data.lng)
      });
      stops.push({
        id: stopId,
        start_ms: start.getTime(),
        end_ms: end.getTime(),
        ...(pinned ? { locked_subject_id: pinned } : {})
      });
    }
  }
  const isBusyStop = (stopId: string) => stopId.startsWith("__busy_");
  const skippedMissingAddressCount = new Set(skippedMissingAddress.map((entry) => entry.project_id)).size;
  if (!stops.some((stop) => !isBusyStop(stop.id))) {
    if (skippedMissingAddress.length) {
      return {
        ok: true as const,
        event_type_id: eventTypeId,
        branch_id: branchId,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        subjects,
        unavailable_subjects: unavailableSubjects,
        routes: [],
        unassigned: [],
        skipped_missing_address: skippedMissingAddress,
        skipped_missing_address_count: skippedMissingAddressCount,
        total_travel_minutes: 0,
        travel_sources: { cached: 0, estimated: 0, fallback: 0 },
        travel_config: travelConfig,
        applied: input.apply === true,
        applied_count: 0,
        cleared_count: 0
      };
    }
    throw new PlatformError("routing_no_events", 404, "No scheduled events of this type fall inside the routing window.");
  }

  const travelSources = { cached: 0, estimated: 0, fallback: 0 };
  const travelMemo = new Map<string, number>();
  const travelMinutes = (fromId: string, toId: string) => {
    // Busy blocks are pure time-blockers: no location semantics, no travel.
    if (isBusyStop(fromId) || isBusyStop(toId)) return 0;
    const memoKey = `${fromId}|${toId}`;
    const memoized = travelMemo.get(memoKey);
    if (memoized !== undefined) return memoized;
    const from = stopContexts.get(fromId);
    const to = stopContexts.get(toId);
    let minutes: number;
    const cached = from && to ? cachedTravel.get(travelCacheKey(from.address, to.address)) : undefined;
    if (cached !== undefined) {
      minutes = cached + travelConfig.fixed_buffer_minutes;
      travelSources.cached += 1;
    } else if (from?.lat != null && from?.lng != null && to?.lat != null && to?.lng != null) {
      const km = haversineKm(from.lat, from.lng, to.lat, to.lng) * travelConfig.road_factor;
      minutes = Math.ceil(Math.max(travelConfig.min_travel_minutes, (km / travelConfig.average_speed_kmh) * 60) + travelConfig.fixed_buffer_minutes);
      travelSources.estimated += 1;
    } else {
      minutes = travelConfig.default_travel_minutes + travelConfig.fixed_buffer_minutes;
      travelSources.fallback += 1;
    }
    travelMemo.set(memoKey, minutes);
    return minutes;
  };

  const rawSubjectById = new Map((resolved.subjects as JsonObject[]).map((subject) => [cleanText(subject.id), subject]));
  const laneToSubject = new Map<string, typeof subjects[number]>();
  const laneIdsBySubject = new Map<string, string[]>();
  const routingSubjects = subjects.flatMap((subject) => {
    const capacity = Math.max(0, resourceAvailabilityCapacity(availabilitySettings, rawSubjectById.get(subject.id) || subject));
    const lanes = Array.from({ length: capacity }, (_, index) => {
      const id = index === 0 ? subject.id : `${subject.id}::capacity:${index + 1}`;
      laneToSubject.set(id, subject);
      return { id };
    });
    laneIdsBySubject.set(subject.id, lanes.map((lane) => lane.id));
    return lanes;
  });
  /* Spread already-fixed overlapping commitments across the same capacity
   * lanes before optimizing the free stops. */
  const fixedByLane = new Map<string, RoutingStop[]>();
  for (const stop of [...stops].sort((a, b) => a.start_ms - b.start_ms)) {
    const subjectId = cleanText(stop.locked_subject_id);
    if (!subjectId) continue;
    const configuredLanes = laneIdsBySubject.get(subjectId);
    const lanes = configuredLanes?.length ? configuredLanes : [subjectId];
    const laneId = lanes.find((id) => !(fixedByLane.get(id) || []).some((fixed) => stop.start_ms < fixed.end_ms && fixed.start_ms < stop.end_ms)) || lanes[0]!;
    stop.locked_subject_id = laneId;
    fixedByLane.set(laneId, [...(fixedByLane.get(laneId) || []), stop]);
  }
  const result = optimizeRoutes(stops, routingSubjects, travelMinutes, { slackMinutes: travelConfig.travel_slack_minutes });

  const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
  const routes = result.routes.map((route) => {
    const subject = laneToSubject.get(route.subject_id) || subjectById.get(route.subject_id);
    const legByStop = new Map(route.legs.map((leg) => [leg.to_stop_id, leg]));
    return {
      subject_id: subject?.id || route.subject_id,
      subject_name: subject?.name || route.subject_id,
      subject_type: subject?.subject_type || "organization_user",
      travel_minutes: route.travel_minutes,
      stops: route.stop_ids.filter((stopId) => !isBusyStop(stopId)).map((stopId, index) => {
        const context = stopContexts.get(stopId)!;
        const leg = legByStop.get(stopId);
        return {
          event_id: stopId,
          project_id: context.projectId,
          project_title: context.projectTitle,
          address: context.address,
          start_at: cleanText(context.event.start_at || context.event.start),
          end_at: cleanText(context.event.end_at || context.event.end),
          sequence: index + 1,
          travel_from_previous_minutes: leg ? leg.travel_minutes : 0,
          slack_minutes: leg ? leg.slack_minutes : null
        };
      })
    };
  }).filter((route) => route.stops.length);

  const unassigned = result.unassigned.filter((entry) => !isBusyStop(entry.stop_id)).map((entry) => {
    const context = stopContexts.get(entry.stop_id);
    return {
      event_id: entry.stop_id,
      project_id: context?.projectId || "",
      project_title: context?.projectTitle || "",
      reason: entry.reason
    };
  });

  let appliedCount = 0;
  let clearedCount = 0;
  if (input.apply === true) {
    /* Group writes per project so each document is rewritten once. An empty
     * subjectId means "clear the assignment": a stop the optimizer could not
     * place must not silently keep whoever a previous run gave it — that is
     * how phantom double-bookings happen. */
    const byProject = new Map<string, Array<{ eventId: string; subjectId: string; sequence: number; travel: number; reason?: string }>>();
    for (const route of routes) {
      for (const stop of route.stops) {
        const list = byProject.get(stop.project_id) || [];
        list.push({ eventId: stop.event_id, subjectId: route.subject_id, sequence: stop.sequence, travel: stop.travel_from_previous_minutes });
        byProject.set(stop.project_id, list);
      }
    }
    for (const entry of unassigned) {
      const context = stopContexts.get(entry.event_id);
      if (!context || context.event.locked === true) continue;
      if (!eventAssignedSubjectId(context.event)) continue;
      const list = byProject.get(context.projectId) || [];
      list.push({ eventId: entry.event_id, subjectId: "", sequence: 0, travel: 0, reason: entry.reason });
      byProject.set(context.projectId, list);
    }
    const routedAt = new Date().toISOString();
    for (const [projectId, assignments] of byProject) {
      const document = await readDocument(orgId, "projects", projectId);
      const data = asObject(asObject(document).data);
      const events = Array.isArray(data.events) ? data.events.map((item) => asObject(item)) : [];
      for (const assignment of assignments) {
        const event = events.find((item) => cleanText(item.id) === assignment.eventId);
        if (!event) continue;
        if (!assignment.subjectId) {
          Object.assign(event, {
            assigned_user_ids: [],
            assigned_users: [],
            assigned_user_id: "",
            assigned_user_name: "",
            crew_id: "",
            crew_name: "",
            resource_id: "",
            resource_name: "",
            work_resource_ref: null,
            assigned_resource_kind: "",
            assigned_resource_id: "",
            assigned_resource_name: "",
            assigned_crew_id: "",
            assigned_crew_name: "",
            assigned_crew: null,
            routing: { routed_at: routedAt, routed_by: cleanText(input.actor?.userId), unassigned_reason: cleanText(assignment.reason) || "no_feasible_subject" }
          });
          clearedCount += 1;
          continue;
        }
        const subject = subjectById.get(assignment.subjectId);
        if (!subject) continue;
        /* Same alias set the scheduling UI writes (assignmentPayloadForSubject)
         * so every reader — routing view, gantt, popups — agrees. */
        if (subject.subject_type === "organization_user") {
          Object.assign(event, {
            assigned_user_ids: [subject.id],
            assigned_users: [{ id: subject.id, name: subject.name }],
            assigned_user_id: subject.id,
            assigned_user_name: subject.name,
            crew_id: "",
            crew_name: "",
            resource_id: "",
            resource_name: "",
            work_resource_ref: null,
            assigned_resource_kind: "",
            assigned_resource_id: "",
            assigned_resource_name: "",
            assigned_crew_id: "",
            assigned_crew_name: "",
            assigned_crew: null
          });
        } else {
          Object.assign(event, {
            assigned_user_ids: [],
            assigned_users: [],
            assigned_user_id: "",
            assigned_user_name: "",
            crew_id: subject.id,
            crew_name: subject.name,
            resource_id: subject.id,
            resource_name: subject.name,
            work_resource_ref: { kind: subject.subject_type, id: subject.id, name: subject.name },
            assigned_resource_kind: subject.subject_type,
            assigned_resource_id: subject.id,
            assigned_resource_name: subject.name,
            assigned_crew_id: subject.id,
            assigned_crew_name: subject.name,
            assigned_crew: { id: subject.id, name: subject.name }
          });
        }
        Object.assign(event, {
          routing: {
            routed_at: routedAt,
            routed_by: cleanText(input.actor?.userId),
            sequence: assignment.sequence,
            travel_from_previous_minutes: assignment.travel
          }
        });
        appliedCount += 1;
      }
      await upsertDocument(orgId, "projects", {
        id: projectId,
        data: { ...data, events },
        metadata: { routing_applied_at: routedAt }
      }, { replace: true });
    }
  }

  return {
    ok: true as const,
    event_type_id: eventTypeId,
    branch_id: branchId,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    subjects,
    unavailable_subjects: unavailableSubjects,
    routes,
    unassigned,
    skipped_missing_address: skippedMissingAddress,
    skipped_missing_address_count: skippedMissingAddressCount,
    total_travel_minutes: result.total_travel_minutes,
    travel_sources: travelSources,
    travel_config: travelConfig,
    applied: input.apply === true,
    applied_count: appliedCount,
    cleared_count: clearedCount
  };
}
