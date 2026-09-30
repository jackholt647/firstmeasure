import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Recurring series semantics: DST-stable wall-clock times, "this event" /
// "this and following" / "all events" edit scopes, and per-occurrence
// exceptions (moves, edits, skips, deletions) surviving later series edits.

let app: any = null;
let storageRoot = "";
const ZONE = "America/Los_Angeles";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-recurrence-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `recurrence-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Recurrence Owner",
    company: "Recurrence Test Org",
    organization_id: `org_recurrence_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  // Series created without an explicit timezone must follow the organization's zone.
  await saveGlobal(orgId, { data: { timezone: ZONE, company: { timezone: ZONE } } }, { replace: false });
  return { orgId };
}

function localTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

function localDate(iso: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

async function calendarSeriesEvents(client: ReturnType<typeof createSessionClient>, orgId: string, title: RegExp) {
  const listed = await client.request("GET", `/v1/platform/organizations/${orgId}/calendar_events`);
  const documents: any[] = Array.isArray(listed?.documents) ? listed.documents : Array.isArray(listed) ? listed : [];
  return documents
    .map((doc) => ({ ...(doc.data || doc), id: doc.id || doc.data?.id }))
    .filter((event) => title.test(String(event.title || "")))
    .sort((left, right) => String(left.start_at).localeCompare(String(right.start_at)));
}

function active(events: any[]) {
  return events.filter((event) => !["cancelled", "canceled"].includes(String(event.status || "").toLowerCase()));
}

test("occurrence dates keep local wall-clock time across DST and clamp month ends", async () => {
  const { occurrenceDate } = await import("../platform/recurrence.js");
  const weekly = { frequency: "weekly" as const, interval: 1, end_at: "", occurrence_count: null };
  const anchor = new Date("2026-10-26T14:00:00.000Z"); // Mon 07:00 PDT
  const afterDst = occurrenceDate(anchor, weekly, 1, ZONE);
  assert.equal(afterDst.toISOString(), "2026-11-02T15:00:00.000Z"); // Mon 07:00 PST
  assert.equal(localTime(occurrenceDate(anchor, weekly, 20, ZONE).toISOString()), "07:00"); // back across spring DST
  const monthly = { frequency: "monthly" as const, interval: 1, end_at: "", occurrence_count: null };
  const inspection = new Date("2026-10-05T17:00:00.000Z"); // 10:00 PDT
  assert.equal(occurrenceDate(inspection, monthly, 1, ZONE).toISOString(), "2026-11-05T18:00:00.000Z");
  const monthEnd = new Date("2027-01-31T17:00:00.000Z"); // Jan 31 09:00 PST
  const february = occurrenceDate(monthEnd, monthly, 1, ZONE);
  assert.equal(localDate(february.toISOString()), "2027-02-28");
  assert.equal(localTime(february.toISOString()), "09:00");
  assert.equal(localDate(occurrenceDate(monthEnd, monthly, 2, ZONE).toISOString()), "2027-03-31");
  const biweekly = { frequency: "weekly" as const, interval: 2, end_at: "", occurrence_count: 6 };
  const gutter = new Date("2026-10-13T16:00:00.000Z"); // Tue 09:00 PDT
  const gutterTimes = Array.from({ length: 6 }, (_, index) => localTime(occurrenceDate(gutter, biweekly, index, ZONE).toISOString()));
  assert.deepEqual(gutterTimes, ["09:00", "09:00", "09:00", "09:00", "09:00", "09:00"]);
});

test("floating weekly series: DST, single-occurrence exceptions, all-events and this-and-following edits", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const base = `/v1/platform/organizations/${orgId}`;
  const created = await client.request("POST", `${base}/recurrence-series`, {
    branch_id: "default",
    title: "Weekly safety meeting",
    start_at: "2026-10-12T14:00:00.000Z", // Mon 07:00 PDT
    recurrence: { frequency: "weekly", interval: 1, occurrence_count: 10 },
    event_template: { title: "Weekly safety meeting", event_type_default_id: "custom", duration_minutes: 30 }
  });
  const seriesId = created.series.id;
  assert.equal(created.series.timezone, ZONE);
  let events = await calendarSeriesEvents(client, orgId, /safety/i);
  assert.equal(events.length, 10);
  assert.ok(events.every((event) => localTime(event.start_at) === "07:00"), `all occurrences at 07:00: ${events.map((event) => localTime(event.start_at))}`);

  // "This event": rename #2, move #3 by an hour, delete #4, skip #6.
  const [renamed, moved, deleted, , skipped] = [events[1], events[2], events[3], events[4], events[5]];
  await client.request("PUT", `${base}/calendar_events/${renamed.id}`, { data: { ...renamed, title: "Weekly safety meeting - ladders" }, metadata: { kind: "calendar_event" } });
  const movedStart = new Date(Date.parse(moved.start_at) + 3_600_000).toISOString();
  const movedEnd = new Date(Date.parse(moved.end_at) + 3_600_000).toISOString();
  await client.request("PUT", `${base}/calendar_events/${moved.id}`, { data: { ...moved, start_at: movedStart, end_at: movedEnd }, metadata: { kind: "calendar_event" } });
  await client.request("DELETE", `${base}/calendar_events/${deleted.id}`);
  const skippedResult = await client.request("POST", `${base}/recurrence-series/${seriesId}/occurrences/${skipped.id}/skipped`, {});
  assert.equal(skippedResult.occurrence.status, "skipped");

  // "All events": new title and 15 minutes longer; the anchor and total stay.
  const untouched = events[0];
  const allEdit = await client.request("PATCH", `${base}/recurrence-series/${seriesId}`, {
    scope: "all",
    event_id: untouched.id,
    occurrence_start_at: untouched.start_at,
    occurrence_end_at: new Date(Date.parse(untouched.end_at) + 15 * 60_000).toISOString(),
    title: "Safety huddle",
    event_template: { title: "Safety huddle", event_type_default_id: "custom" }
  });
  assert.equal(allEdit.series.start_at, "2026-10-12T14:00:00.000Z");
  assert.equal(allEdit.series.recurrence.occurrence_count, 10);
  assert.equal(allEdit.series.event_template.duration_minutes, 45);
  events = await calendarSeriesEvents(client, orgId, /safety|huddle/i);
  const byId = new Map(events.map((event) => [event.id, event]));
  assert.equal(events.length, 8, "the deleted and the skipped occurrence are not recreated");
  assert.equal(byId.has(deleted.id), false);
  assert.equal(byId.get(renamed.id).title, "Weekly safety meeting - ladders", "an individually renamed occurrence keeps its title");
  assert.equal(byId.get(moved.id).title, "Safety huddle");
  assert.equal(byId.get(moved.id).start_at, movedStart, "an individually moved occurrence keeps its time");
  assert.equal(byId.has(skipped.id), false, "a skipped floating occurrence stays off the calendar");
  const scheduled = active(events);
  assert.equal(scheduled.length, 8);
  assert.ok(scheduled.filter((event) => event.id !== moved.id).every((event) => localTime(event.start_at) === "07:00"));
  assert.ok(scheduled.filter((event) => event.id !== moved.id).every((event) => Date.parse(event.end_at) - Date.parse(event.start_at) === 45 * 60_000));

  // "This and following" from #7 (Nov 23): move to 09:00. Earlier occurrences stay at 07:00.
  const splitAt = events.find((event) => localDate(event.start_at) === "2026-11-23");
  assert.ok(splitAt);
  const splitStart = new Date(Date.parse(splitAt.start_at) + 2 * 3_600_000).toISOString();
  const split = await client.request("PATCH", `${base}/recurrence-series/${seriesId}`, {
    scope: "following",
    event_id: splitAt.id,
    occurrence_start_at: splitStart,
    occurrence_end_at: new Date(Date.parse(splitStart) + 45 * 60_000).toISOString(),
    event_template: { title: "Safety huddle" }
  });
  assert.notEqual(split.series.id, seriesId);
  assert.equal(split.previous_series.recurrence.occurrence_count, 6);
  assert.equal(split.series.recurrence.occurrence_count, 4);
  assert.equal(split.series.split_from_series_id, seriesId);
  events = await calendarSeriesEvents(client, orgId, /safety|huddle/i);
  assert.equal(events.length, 8, "splitting neither duplicates nor recreates occurrences");
  const before = events.filter((event) => event.start_at < "2026-11-23");
  const following = events.filter((event) => event.start_at >= "2026-11-23");
  assert.equal(following.length, 4);
  assert.ok(following.every((event) => event.recurrence_series_id === split.series.id));
  assert.ok(following.every((event) => localTime(event.start_at) === "09:00"), `following at 09:00: ${following.map((event) => localTime(event.start_at))}`);
  assert.ok(before.every((event) => event.recurrence_series_id === seriesId));
  assert.ok(active(before).filter((event) => event.id !== moved.id).every((event) => localTime(event.start_at) === "07:00"));
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.equal(active(events).length, 8);

  const oldOccurrences = (await client.request("GET", `${base}/recurrence-series/${seriesId}/occurrences`)).occurrences;
  const newOccurrences = (await client.request("GET", `${base}/recurrence-series/${split.series.id}/occurrences`)).occurrences;
  assert.equal(oldOccurrences.length, 6);
  assert.equal(newOccurrences.length, 4);
  assert.equal(oldOccurrences.find((entry: any) => entry.event_id === deleted.id)?.status, "cancelled");
  assert.equal(oldOccurrences.find((entry: any) => entry.event_id === skipped.id)?.status, "skipped");

  // Listing (which materializes) creates nothing new.
  await client.request("GET", `${base}/recurrence-series?include_cancelled=1`);
  assert.equal((await calendarSeriesEvents(client, orgId, /safety|huddle/i)).length, 8);

  // A skipped occurrence can be restored and keeps the time it had.
  const restored = await client.request("POST", `${base}/recurrence-series/${seriesId}/occurrences/${skipped.id}/scheduled`, {});
  assert.equal(restored.occurrence.status, "scheduled");
  const restoredEvent = (await calendarSeriesEvents(client, orgId, /safety|huddle/i)).find((event) => event.id === skipped.id);
  assert.equal(restoredEvent.status, "scheduled");
});

test("project bi-weekly series keeps exceptions and count through edits; omitted count is preserved", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const base = `/v1/platform/organizations/${orgId}`;
  const projectId = "project_recurring_gutters";
  await client.request("PUT", `${base}/projects/${projectId}`, {
    data: { id: projectId, title: "Kowalski Residence", address: "12 Leak Lane", contacts: [{ id: "customer", primary: true, name: "Piotr" }] },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `${base}/projects/${projectId}/recurrence-series`, {
    branch_id: "default",
    title: "Gutter cleaning (bi-weekly)",
    start_at: "2026-10-13T16:00:00.000Z", // Tue 09:00 PDT
    recurrence: { frequency: "weekly", interval: 2, occurrence_count: 6 },
    event_template: { title: "Gutter cleaning", event_type_default_id: "project_work", duration_minutes: 120, schedule_item_kind: "production" }
  });
  const seriesId = created.series.id;
  const projectEvents = async () => {
    const project = await client.request("GET", `${base}/projects/${projectId}`);
    const events: any[] = project?.document?.data?.events || project?.data?.events || project?.project?.events || [];
    return events.filter((event) => event.recurrence_series_id).sort((left, right) => String(left.start_at).localeCompare(String(right.start_at)));
  };
  let events = await projectEvents();
  assert.equal(events.length, 6);
  assert.ok(events.every((event) => localTime(event.start_at) === "09:00"), `project occurrences at 09:00: ${events.map((event) => localTime(event.start_at))}`);

  // Edit one occurrence's title through the normal event save; delete another.
  const editedId = events[1].id;
  await client.request("POST", `${base}/projects/${projectId}/events`, { event: { id: events[1].id, title: "Gutter cleaning + downspouts" } });
  await client.request("DELETE", `${base}/projects/${projectId}/events/${events[2].id}`);
  const occurrences = (await client.request("GET", `${base}/recurrence-series/${seriesId}/occurrences`)).occurrences;
  assert.equal(occurrences.find((entry: any) => entry.event_id === events[2].id)?.status, "cancelled");

  // The project dialog sends recurrence without occurrence_count: the count must survive.
  const dialogEdit = await client.request("PATCH", `${base}/recurrence-series/${seriesId}`, {
    title: "Gutter cleaning (bi-weekly)",
    start_at: created.series.start_at,
    recurrence: { frequency: "weekly", interval: 2, end_at: "" },
    event_template: { title: "Gutter service", event_type_default_id: "project_work", duration_minutes: 120 }
  });
  assert.equal(dialogEdit.series.recurrence.occurrence_count, 6);
  assert.equal(dialogEdit.series.event_template.schedule_item_kind, "production", "template keys the patch omits are kept");
  events = await projectEvents();
  assert.equal(events.length, 5);
  assert.equal(events.find((event) => event.id === editedId)?.title, "Gutter cleaning + downspouts");
  assert.equal(events.filter((event) => event.title === "Gutter service").length, 4);
  assert.ok(events.every((event) => localTime(event.start_at) === "09:00"));
});
