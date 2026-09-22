import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "firstmate-reschedule-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.APPOINTMENT_CONFIRMATIONS_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(root, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  process.env.MESSAGING_STORAGE_ROOT = path.join(root, "messaging");
});

after(async () => {
  const { closeWorkDatabase } = await import("../work/storage.js");
  const { closeAppointmentsDatabase } = await import("../appointments/storage.js");
  (await closeWorkDatabase());
  (await closeAppointmentsDatabase());
  if (root) await rm(root, { recursive:true, force:true, maxRetries:5, retryDelay:100 }).catch(() => null);
});

test("availability, holds, capacity, and reschedule commit share one authority", async () => {
  const { createOrganization, saveBranchModule, upsertDocument, readDocument } = await import("../platform/storage.js");
  const { appointmentAvailability, holdAppointmentSlot, commitAppointmentReschedule, reviewAppointmentReschedule, cancelAppointmentRescheduleRequest } = await import("../appointments/availability.js");
  const { listWorkTodos } = await import("../work/service.js");
  const orgId = `org_reschedule_${Date.now().toString(36)}`;
  await createOrganization({ id:orgId, name:"Rescheduling Test" });
  await Promise.all(["rep_one", "rep_two"].map((id) => upsertDocument(orgId, "users", {
    id,
    data:{ id, name:id === "rep_one" ? "Avery" : "Blake", status:"active", branch_id:"default", roles:["sales_appointments"] }
  })));
  await saveBranchModule(orgId, "default", "scheduling", { data:{
    availability:{ days:[0,1,2,3,4,5,6], start:"08:00", end:"18:00", sales_appointment_slot_minutes:30 },
    self_service:{ enabled:true, portal_enabled:true, default_policy:{ enabled:true, actions:["reschedule"], min_notice_minutes:0, booking_horizon_days:45, max_reschedules:3, hold_minutes:5 } },
    event_types:{ sales_appointment:{ duration_minutes:60, slot_minutes:30, buffer_minutes:15, customer_scheduling:{ enabled:true, actions:["reschedule"] }, assignment_policy:{ allow_unassigned:false, rules:[{ subject_types:["organization_user"], role_ids:["sales_appointments"] }] } } }
  } }, { replace:true });

  const tomorrow = new Date(Date.now() + 36 * 60 * 60_000);
  const date = tomorrow.toISOString().slice(0, 10);
  const original = `${date}T16:00:00.000Z`;
  await upsertDocument(orgId, "projects", { id:"project_reschedule", data:{ id:"project_reschedule", branch_id:"default", title:"Customer Project", address:"100 Main St", events:[{
    id:"appointment_one", title:"Consultation", event_type_default_id:"sales_appointment", start_at:original, end_at:`${date}T17:00:00.000Z`, duration_minutes:60, status:"scheduled", customer_visible:true,
    customer_scheduling:{ enabled:true, actions:["reschedule"], min_notice_minutes:0, max_reschedules:3 }, confirmation:{ required:true, status:"confirmed", confirmed_at:new Date().toISOString() }
  }] } });

  const availability = await appointmentAvailability(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_date:date, end_date:date });
  const open = availability.slots.find((slot: any) => slot.available === true);
  assert.ok(open, "at least one canonical slot is available");
  const openCandidates = open.candidates as any[];
  assert.equal(openCandidates.length, 2, "both eligible sales resources are represented");
  assert.equal(open.available_count, 2);

  const held = await holdAppointmentSlot(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_at:open.start_at, resource_key:openCandidates[0].resource_key, source:"test" });
  const duringHold = await appointmentAvailability(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_date:date, end_date:date });
  const sameDuringHold = duringHold.slots.find((slot: any) => slot.start_at === open.start_at);
  assert.ok(sameDuringHold);
  assert.equal(sameDuringHold.available_count, 1, "a temporary hold consumes exactly one unit of capacity");

  const committed = await commitAppointmentReschedule(orgId, String((held.hold as any).id), { source:"test", actor:"customer" });
  assert.equal((committed.event as any).start_at, open.start_at);
  assert.equal((committed.event as any).confirmation.status, "pending", "moving a confirmed appointment requires fresh confirmation");
  assert.equal((committed.event as any).schedule_history.at(-1).action, "customer_rescheduled");
  const stored = await readDocument(orgId, "projects", "project_reschedule");
  const storedEvent = (stored.data.events as any[]).find((event) => event.id === "appointment_one");
  assert.equal(storedEvent.start_at, open.start_at);
  assert.equal(storedEvent.assigned_user_id, "rep_one");

  const reviewEvent = {
    ...storedEvent,
    customer_scheduling:{ ...storedEvent.customer_scheduling, reschedule_approval:"required", reschedule_review_todo:true, reschedule_staff_notification:false, reschedule_customer_notification:"none" }
  };
  await upsertDocument(orgId, "projects", { id:"project_reschedule", expected_revision:stored.revision, data:{ ...(stored.data as any), events:[reviewEvent] }, metadata:stored.metadata }, { replace:true });
  const reviewAvailability = await appointmentAvailability(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_date:date, end_date:date });
  const reviewSlot = reviewAvailability.slots.find((slot: any) => slot.available === true && slot.start_at !== open.start_at) as any;
  assert.ok(reviewSlot);
  const reviewHold = await holdAppointmentSlot(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_at:reviewSlot.start_at, resource_key:reviewSlot.candidates[0].resource_key, source:"customer_portal" });
  const requested = await commitAppointmentReschedule(orgId, String((reviewHold.hold as any).id), { source:"customer_portal", actor:"customer" });
  assert.equal(requested.status, "pending_approval");
  assert.equal((requested.event as any).start_at, open.start_at, "the original appointment remains reserved during review");
  assert.equal((requested.event as any).reschedule_request.requested_start_at, reviewSlot.start_at);
  const reviewTodos = (await listWorkTodos(orgId, { project_id:"project_reschedule", include_future:true }));
  assert.ok(reviewTodos.some((todo: any) => todo.metadata?.reschedule_request_id === (requested.request as any).id), "scope policy creates a project review to-do");
  const pendingAvailability = await appointmentAvailability(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_date:date, end_date:date });
  assert.equal((pendingAvailability.slots.find((slot: any) => slot.start_at === reviewSlot.start_at) as any).available_count, 1, "the pending request reserves one unit of capacity");
  const canceled = await cancelAppointmentRescheduleRequest(orgId, "project_reschedule", "appointment_one", { actor:"customer", source:"customer_portal", branch_id:"default" });
  assert.equal(canceled.status, "canceled");
  assert.equal((canceled.event as any).start_at, open.start_at, "canceling the request keeps the original appointment");
  assert.equal((canceled.event as any).reschedule_request.status, "canceled");
  const restoredAvailability = await appointmentAvailability(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_date:date, end_date:date });
  assert.equal((restoredAvailability.slots.find((slot: any) => slot.start_at === reviewSlot.start_at) as any).available_count, 2, "canceling releases the requested capacity");
  assert.ok((await listWorkTodos(orgId, { project_id:"project_reschedule", include_completed:true, include_future:true })).some((todo: any) => todo.metadata?.reschedule_request_id === (requested.request as any).id && todo.status === "canceled"));

  const approvalHold = await holdAppointmentSlot(orgId, "default", { project_id:"project_reschedule", event_id:"appointment_one", start_at:reviewSlot.start_at, resource_key:reviewSlot.candidates[0].resource_key, source:"customer_portal" });
  const requestedAgain = await commitAppointmentReschedule(orgId, String((approvalHold.hold as any).id), { source:"customer_portal", actor:"customer" });
  const approved = await reviewAppointmentReschedule(orgId, "project_reschedule", "appointment_one", "approved", { actor:"manager_one", branch_id:"default" });
  assert.equal(approved.status, "approved");
  assert.equal((approved.event as any).start_at, reviewSlot.start_at);
  assert.equal((approved.event as any).reschedule_request.status, "approved");
  assert.ok((await listWorkTodos(orgId, { project_id:"project_reschedule", include_completed:true, include_future:true })).some((todo: any) => todo.metadata?.reschedule_request_id === (requestedAgain.request as any).id && todo.status === "completed"));
});

test("policy precedence remains data driven", async () => {
  const { normalizeCustomerSchedulingPolicy, effectiveCustomerSchedulingPolicy } = await import("../appointments/availability.js");
  const defaults = normalizeCustomerSchedulingPolicy({ enabled:false, min_notice_minutes:120, max_reschedules:3 });
  const policy = effectiveCustomerSchedulingPolicy(
    { customer_scheduling:{ enabled:false, max_reschedules:1 } },
    { customer_scheduling:{ enabled:true, min_notice_minutes:240 } },
    { self_service:{ default_policy:defaults } }
  );
  assert.equal(policy.enabled, false, "appointment override wins");
  assert.equal(policy.min_notice_minutes, 240, "event-type defaults are inherited");
  assert.equal(policy.max_reschedules, 1);
  assert.equal(normalizeCustomerSchedulingPolicy({ reschedule_approval:"required", reschedule_staff_notification:true, reschedule_customer_notification:"sms" }).reschedule_approval, "required");
});

test("routing and slot calculation share weekly and date-specific subject availability", async () => {
  const { subjectUnavailableOnDate } = await import("../appointments/availability.js");
  const scheduling = {
    availability_weekdays:{ rep_one:[1, 2, 3, 4, 5] },
    unavailability:{ rep_one:["2027-01-08", "2027-01-09"] }
  };
  assert.equal(subjectUnavailableOnDate(scheduling, "rep_one", "2027-01-08"), true, "a weekday override marks the subject off");
  assert.equal(subjectUnavailableOnDate(scheduling, "rep_one", "2027-01-09"), false, "a weekend override makes the subject available");
  assert.equal(subjectUnavailableOnDate(scheduling, "rep_one", "2027-01-10"), true, "weekly availability remains authoritative without an override");
});
