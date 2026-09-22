import { isCapabilityEnabled } from "../platform/capabilities.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { sendProjectEmail, sendProjectSms } from "../comms/service.js";
import {
  activeRescheduleSession,
  contactKeyFor,
  patchRescheduleSession,
  upsertRescheduleSession
} from "./storage.js";
import {
  appointmentAvailability,
  commitAppointmentReschedule,
  effectiveCustomerSchedulingPolicy,
  holdAppointmentSlot,
  readSchedulingAvailabilitySettings
} from "./availability.js";

function cleanText(value: unknown) { return String(value ?? "").trim(); }
function asObject(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {}; }
function asArray(value: unknown) { return Array.isArray(value) ? value : []; }

const REQUEST_PATTERN = /\b(reschedul|change (?:my|the|our)?\s*(?:appointment|time|date)|move (?:my|the|our)?\s*(?:appointment|time|date)|another (?:time|day|date)|different (?:time|day|date)|can'?t make it|cannot make it)\b/i;

function template(value: unknown, variables: Record<string, string>) {
  return cleanText(value).replace(/\{\{\s*([a-z0-9_.-]+)\s*\}\}/gi, (match, key) => Object.prototype.hasOwnProperty.call(variables, key) ? (variables[key] ?? match) : match);
}

function messageText(message: JsonObject) {
  return `${cleanText(message.subject)} ${cleanText(message.text_body || message.body || message.text)}`.trim();
}

function senderContactKey(message: JsonObject) {
  const sender = asObject(message.sender);
  const channel = cleanText(message.channel);
  const address = cleanText(sender.address);
  return contactKeyFor(channel === "email" ? address.toLowerCase() : "", channel === "sms" ? address : "");
}

async function sendWorkflowMessage(orgId: string, branchId: string, projectId: string, message: JsonObject, text: string) {
  if (cleanText(message.channel) === "sms") {
    return await sendProjectSms(orgId, branchId, projectId, {
      text,
      source: { type: "automation", id: "appointment_rescheduling", automation_id: "appointments.guidedReschedule.v1" }
    }, { branchId } as never);
  }
  return await sendProjectEmail(orgId, branchId, projectId, {
    subject: cleanText(message.subject).toLowerCase().startsWith("re:") ? cleanText(message.subject) : `Re: ${cleanText(message.subject) || "Your appointment"}`,
    text,
    conversation_id: cleanText(message.conversation_id),
    source: { type: "automation", id: "appointment_rescheduling", automation_id: "appointments.guidedReschedule.v1" }
  }, { branchId } as never);
}

function upcomingSchedulableEvent(project: JsonObject, scheduling: JsonObject) {
  const eventTypes = asObject(scheduling.event_types);
  return asArray(project.events).map(asObject)
    .filter((event) => Date.parse(cleanText(event.start_at)) > Date.now())
    .filter((event) => !["cancelled", "canceled", "completed", "unscheduled"].includes(cleanText(event.status).toLowerCase()))
    .filter((event) => {
      const typeId = cleanText(event.event_type_default_id || event.type_id);
      return effectiveCustomerSchedulingPolicy(event, asObject(eventTypes[typeId]), scheduling).enabled;
    })
    .sort((left, right) => Date.parse(cleanText(left.start_at)) - Date.parse(cleanText(right.start_at)))[0] || null;
}

export async function handleInboundReschedulingResponse(orgId: string, branchIdValue: string, messageValue: JsonObject) {
  if (!(await isCapabilityEnabled(orgId, "scheduling.automated_rescheduling").catch(() => false))) return null;
  const channel = cleanText(messageValue.channel);
  if (!["sms", "email"].includes(channel)) return null;
  const projectId = cleanText(asObject(messageValue.context).project_id || messageValue.project_id);
  if (!projectId) return null;
  const branchId = cleanText(branchIdValue) || "default";
  const { scheduling, settings } = await readSchedulingAvailabilitySettings(orgId, branchId);
  if (!settings.self_service.enabled || !settings.self_service.deterministic_workflow) return null;
  const contactKey = senderContactKey(messageValue);
  if (!contactKey) return null;
  const text = messageText(messageValue);
  const existing = (await activeRescheduleSession(orgId, contactKey)) as JsonObject | null;
  const choice = /^\s*([1-9])\s*[.)]?\s*$/.exec(text)?.[1];
  if (existing && choice) {
    const options = asArray(existing.options).map(asObject);
    const selected = options[Number(choice) - 1];
    if (!selected) {
      await sendWorkflowMessage(orgId, branchId, projectId, messageValue, `Please reply with a number from 1 to ${options.length}.`);
      return { handled: true, state: "invalid_choice", session_id: existing.id };
    }
    try {
      const held = await holdAppointmentSlot(orgId, branchId, {
        project_id: cleanText(existing.project_id),
        event_id: cleanText(existing.event_id),
        start_at: cleanText(selected.start_at),
        resource_key: cleanText(selected.resource_key),
        source: "guided_message",
        source_id: cleanText(existing.id)
      });
      const committed = await commitAppointmentReschedule(orgId, cleanText(asObject(held.hold).id), { source: "guided_message", actor: "customer" }) as JsonObject;
      (await patchRescheduleSession(cleanText(existing.id), { status: "completed" }));
      const success = template(asObject(asObject(settings.self_service).default_policy).messages && asObject(asObject(asObject(settings.self_service).default_policy).messages).success, { appointment_time: cleanText(selected.label) });
      await sendWorkflowMessage(orgId, branchId, projectId, messageValue, success);
      return { handled: true, state: "completed", session_id: existing.id, event: committed.event };
    } catch {
      (await patchRescheduleSession(cleanText(existing.id), { status: "expired" }));
      await sendWorkflowMessage(orgId, branchId, projectId, messageValue, "That time was just taken. Reply RESCHEDULE and I'll find the latest openings.");
      return { handled: true, state: "slot_lost", session_id: existing.id };
    }
  }
  if (!REQUEST_PATTERN.test(text)) return null;
  const document = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!document) return null;
  const project = asObject(document.data);
  const event = upcomingSchedulableEvent(project, scheduling);
  if (!event) return null;
  const availability = await appointmentAvailability(orgId, branchId, {
    project_id: projectId,
    event_id: cleanText(event.id),
    days: 14,
    limit: 240
  });
  const slots = asArray(availability.slots).map(asObject).filter((slot) => slot.available === true).slice(0, 3);
  const policy = effectiveCustomerSchedulingPolicy(event, asObject(asObject(scheduling.event_types)[cleanText(event.event_type_default_id || event.type_id)]), scheduling);
  if (!slots.length) {
    await sendWorkflowMessage(orgId, branchId, projectId, messageValue, template(asObject(policy.messages).no_slots, {}));
    return { handled: true, state: "no_slots", event_id: event.id };
  }
  const options = slots.map((slot) => ({
    start_at: cleanText(slot.start_at),
    end_at: cleanText(slot.end_at),
    label: cleanText(slot.label),
    resource_key: cleanText(asObject(asArray(slot.candidates)[0]).resource_key)
  }));
  const session = (await upsertRescheduleSession({
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    event_id: cleanText(event.id),
    contact_key: contactKey,
    channel,
    options,
    expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  }));
  const prompt = [
    template(asObject(policy.messages).intro, {}),
    ...options.map((option, index) => `${index + 1}. ${option.label}`),
    template(asObject(policy.messages).slot_prompt, {})
  ].filter(Boolean).join("\n");
  await sendWorkflowMessage(orgId, branchId, projectId, messageValue, prompt);
  return { handled: true, state: "offered", session_id: session.id, event_id: event.id, options };
}
