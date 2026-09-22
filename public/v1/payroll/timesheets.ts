import { badRequest, conflict } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import { resolveHourlyCompensation } from "../workforce/access.js";
import {
  listCrewTimeShifts,
  patchCrewTimeShift,
  readCrewTimeShift,
  setCrewTimeShiftApproval
} from "../workforce/crew_storage.js";
import { hydratedWorkforceUser, listWorkforceUsers } from "../workforce/service.js";
import { recordPayrollLedgerEntries, reversePayrollLedgerEntry } from "./service.js";
import { asObject, cleanText, readPayrollLedgerEntry, type JsonObject } from "./storage.js";

function finite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function eventLocation(eventValue: unknown) {
  const event = asObject(eventValue);
  const data = asObject(event.data);
  const location = asObject(data.location || data.geolocation || data.geo);
  const latitude = finite(location.latitude ?? location.lat);
  const longitude = finite(location.longitude ?? location.lng ?? location.lon);
  return {
    status: cleanText(location.status || (latitude !== null && longitude !== null ? "captured" : "unavailable")),
    ...(latitude !== null && longitude !== null ? { latitude, longitude } : {}),
    ...(finite(location.accuracy_meters ?? location.accuracy) !== null ? { accuracy_meters: finite(location.accuracy_meters ?? location.accuracy) } : {}),
    captured_at: cleanText(location.captured_at),
    reason: cleanText(location.reason)
  };
}

function radians(value: number) { return value * Math.PI / 180; }

function distanceMeters(leftValue: unknown, rightValue: unknown) {
  const left = asObject(leftValue);
  const right = asObject(rightValue);
  const lat1 = finite(left.latitude ?? left.lat);
  const lon1 = finite(left.longitude ?? left.lng ?? left.lon);
  const lat2 = finite(right.latitude ?? right.lat);
  const lon2 = finite(right.longitude ?? right.lng ?? right.lon);
  if ([lat1, lon1, lat2, lon2].some((value) => value === null)) return null;
  const dLat = radians((lat2 as number) - (lat1 as number));
  const dLon = radians((lon2 as number) - (lon1 as number));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1 as number)) * Math.cos(radians(lat2 as number)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function projectLocation(documentValue: unknown) {
  const data = asObject(asObject(documentValue).data);
  const measurement = asObject(data.measurement);
  const latitude = finite(data.latitude ?? data.lat ?? measurement.latitude ?? measurement.lat);
  const longitude = finite(data.longitude ?? data.lng ?? measurement.longitude ?? measurement.lng);
  return latitude === null || longitude === null ? {} : { latitude, longitude };
}

function projectTitle(documentValue: unknown) {
  const document = asObject(documentValue);
  const data = asObject(document.data);
  return cleanText(data.title || data.name || data.project_name || data.address || document.id);
}

function locationSummary(shift: JsonObject, action: string) {
  const event = (Array.isArray(shift.events) ? shift.events : []).map(asObject).find((entry) => cleanText(entry.action) === action);
  return event ? eventLocation(event) : { status: "unavailable", captured_at: "", reason: "not_recorded" };
}

export async function listPayrollTimesheets(orgId: string, options: JsonObject = {}) {
  const from = cleanText(options.from);
  const through = cleanText(options.through);
  const shifts = (await listCrewTimeShifts(orgId, {
    user_id: cleanText(options.user_id),
    status: cleanText(options.shift_status),
    ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
    ...(through ? { through: `${through}T23:59:59.999Z` } : {}),
    limit: Math.min(1000, Math.max(1, Number(options.limit || 500)))
  })).filter((shiftValue) => {
    const shift = asObject(shiftValue);
    return !cleanText(options.approval_status) || cleanText(shift.approval_status) === cleanText(options.approval_status);
  });
  const users = await listWorkforceUsers(orgId, { include_disabled: true });
  const usersById = new Map(users.map((user) => [cleanText(user.id), user]));
  const projectIds = [...new Set(shifts.map((shift) => cleanText(asObject(shift).project_id)).filter(Boolean))];
  const projects = new Map<string, JsonObject>();
  await Promise.all(projectIds.map(async (projectId) => {
    const project = await readDocument(orgId, "projects", projectId).catch(() => null);
    if (project) projects.set(projectId, project);
  }));
  const rows: JsonObject[] = shifts.map((shiftValue) => {
    const shift = asObject(shiftValue);
    const user = asObject(usersById.get(cleanText(shift.user_id)));
    const project = projects.get(cleanText(shift.project_id));
    const expected = projectLocation(project);
    const clockInLocation = locationSummary(shift, "clock_in");
    const clockOutLocation = locationSummary(shift, "clock_out");
    return {
      ...shift,
      user: {
        id: cleanText(shift.user_id),
        name: cleanText(user.name || user.email || shift.user_id),
        email: cleanText(user.email)
      },
      project: cleanText(shift.project_id) ? {
        id: cleanText(shift.project_id),
        title: projectTitle(project) || cleanText(shift.project_id),
        location: expected
      } : null,
      clock_in_location: { ...clockInLocation, distance_to_project_meters: distanceMeters(clockInLocation, expected) },
      clock_out_location: { ...clockOutLocation, distance_to_project_meters: distanceMeters(clockOutLocation, expected) }
    } as JsonObject;
  });
  return {
    timesheets: rows,
    count: rows.length,
    summary: {
      active: rows.filter((row) => cleanText(row.status) === "active").length,
      pending: rows.filter((row) => cleanText(row.approval_status) === "pending").length,
      approved: rows.filter((row) => cleanText(row.approval_status) === "approved").length,
      rejected: rows.filter((row) => cleanText(row.approval_status) === "rejected").length,
      worked_seconds: rows.reduce((sum, row) => sum + Math.max(0, Number(row.worked_seconds || 0)), 0),
      missing_location: rows.filter((row) => cleanText(asObject(row.clock_in_location).status) !== "captured" || (cleanText(row.status) === "closed" && cleanText(asObject(row.clock_out_location).status) !== "captured")).length
    }
  };
}

async function reverseTimesheetPayroll(orgId: string, shift: JsonObject, actorUserId: string, reason: string) {
  const entryId = cleanText(shift.payroll_entry_id);
  if (!entryId) return null;
  const entry = (await readPayrollLedgerEntry(orgId, entryId));
  if (Number(entry.amount_cents || 0) <= 0) return null;
  return (await reversePayrollLedgerEntry(orgId, entryId, {
    source_event_id: `crew.time_shift:${cleanText(shift.id)}:reversal:r${Number(shift.revision || 0)}`,
    occurred_at: new Date().toISOString(),
    description: `Timesheet ${reason}: ${cleanText(asObject(entry.payee).name || shift.user_id)}`,
    metadata: { source: "crew_timesheet", shift_id: cleanText(shift.id), actor_user_id: actorUserId, reason }
  }));
}

function assertExpectedRevision(shift: JsonObject, input: JsonObject) {
  const expected = Number(input.expected_revision || 0);
  if (expected && expected !== Number(shift.revision || 0)) {
    throw conflict("time_shift_revision_conflict", "The timesheet changed elsewhere. Reload and try again.", { current_revision: shift.revision });
  }
}

function validateCorrection(shift: JsonObject, input: JsonObject) {
  const startMs = Date.parse(cleanText(input.clocked_in_at || shift.clocked_in_at));
  const endMs = Date.parse(cleanText(input.clocked_out_at || shift.clocked_out_at));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw badRequest("time_shift_range_invalid", "Clock-out time must be after clock-in time.");
  }
  const elapsedSeconds = Math.floor((endMs - startMs) / 1000);
  const breakSeconds = Math.max(0, Math.round(Number(input.break_seconds ?? shift.break_seconds ?? 0)));
  if (!Number.isFinite(breakSeconds) || breakSeconds >= elapsedSeconds) {
    throw badRequest("time_shift_break_invalid", "Break time must be shorter than the shift.");
  }
}

export async function correctPayrollTimesheet(orgId: string, shiftId: string, input: JsonObject, actorUserId: string) {
  const current = (await readCrewTimeShift(orgId, shiftId));
  assertExpectedRevision(current, input);
  validateCorrection(current, input);
  if (cleanText(current.approval_status) === "approved" && cleanText(current.payroll_entry_id)) {
    await reverseTimesheetPayroll(orgId, current, actorUserId, "corrected");
  }
  return await Promise.resolve((await patchCrewTimeShift(orgId, shiftId, input, actorUserId)));
}

export async function approvePayrollTimesheet(orgId: string, shiftId: string, input: JsonObject, actorUserId: string) {
  const current = (await readCrewTimeShift(orgId, shiftId));
  if (cleanText(current.status) !== "closed") throw conflict("timesheet_shift_open", "Clock the worker out before approving this timesheet.");
  if (cleanText(current.approval_status) === "approved" && cleanText(current.payroll_entry_id)) return current;
  assertExpectedRevision(current, input);
  const compensation = (await resolveHourlyCompensation(orgId, cleanText(current.user_id)));
  if (!compensation) throw badRequest("timesheet_hourly_rate_missing", "This worker does not have a positive hourly compensation rate.");
  const user = await hydratedWorkforceUser(orgId, cleanText(current.user_id));
  const workerClassification = cleanText(user.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee";
  const projectId = cleanText(input.project_id || current.project_id);
  let project: JsonObject | null = null;
  if (projectId) project = await readDocument(orgId, "projects", projectId).catch(() => null);
  const rateCents = Math.round(Number(compensation.rate_cents || 0));
  const workedSeconds = Math.max(0, Math.round(Number(current.worked_seconds || 0)));
  const amountCents = Math.round(rateCents * workedSeconds / 3600);
  if (amountCents <= 0) throw badRequest("timesheet_amount_zero", "This shift does not contain payable worked time.");
  const fresh = (await readCrewTimeShift(orgId, shiftId));
  if (Number(fresh.revision || 0) !== Number(current.revision || 0)) {
    throw conflict("time_shift_revision_conflict", "The timesheet changed elsewhere. Reload and try again.", { current_revision: fresh.revision });
  }
  const sourceTriggerId = `approved:r${Number(current.revision || 0)}`;
  const [entry] = (await recordPayrollLedgerEntries(orgId, [{
    payee: { type: "organization_user", id: cleanText(current.user_id), name: cleanText(user.name || user.email || current.user_id), worker_type: workerClassification },
    kind: "hourly",
    subgroup: "hourly",
    state: "accrued",
    amount_cents: amountCents,
    currency: cleanText(compensation.currency || "USD"),
    project_id: projectId,
    project_title: projectTitle(project),
    worked_at: cleanText(current.clocked_out_at),
    completed_at: cleanText(current.clocked_out_at),
    source_event_id: `crew.time_shift:${cleanText(current.id)}`,
    source_trigger_id: sourceTriggerId,
    description: `${(workedSeconds / 3600).toFixed(2)} hours at ${(rateCents / 100).toFixed(2)}/hr`,
    metadata: {
      source: "crew_timesheet",
      shift_id: cleanText(current.id),
      shift_revision: Number(current.revision || 0),
      worked_seconds: workedSeconds,
      break_seconds: Number(current.break_seconds || 0),
      hourly_rate_cents: rateCents,
      compensation_profile_id: cleanText(compensation.profile_id),
      compensation_profile_revision: Number(compensation.profile_revision || 0),
      compensation_source: cleanText(compensation.source),
      approved_by_user_id: actorUserId
    }
  }]));
  if (!entry) throw badRequest("timesheet_payroll_entry_missing", "Payroll did not create an hourly ledger entry for this shift.");
  return (await setCrewTimeShiftApproval(orgId, shiftId, {
    status: "approved",
    expected_revision: Number(input.expected_revision || current.revision || 0),
    manager_note: cleanText(input.manager_note),
    payroll_entry_id: cleanText(entry.id)
  }, actorUserId));
}

export async function rejectPayrollTimesheet(orgId: string, shiftId: string, input: JsonObject, actorUserId: string) {
  const current = (await readCrewTimeShift(orgId, shiftId));
  assertExpectedRevision(current, input);
  if (cleanText(current.approval_status) === "approved" && cleanText(current.payroll_entry_id)) {
    await reverseTimesheetPayroll(orgId, current, actorUserId, "rejected");
  }
  return (await setCrewTimeShiftApproval(orgId, shiftId, {
    status: "rejected",
    expected_revision: Number(input.expected_revision || current.revision || 0),
    manager_note: cleanText(input.manager_note),
    payroll_entry_id: ""
  }, actorUserId));
}
