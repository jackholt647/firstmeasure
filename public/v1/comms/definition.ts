// The comms agent, declared as a framework agent. Works over the unified
// communications store. Interactive threads carry the focus project id as the
// framework thread subject_id (empty subject = the org-wide comms center).
// Auto-responses run threadless via runAgentOnce with the propose_reply tool
// (see agent.ts). Per-project settings overrides resolve in prepare().

import { env } from "../src/config/env.js";
import { readDocument, readOrganization } from "../platform/storage.js";
import { buildAgentInstructions } from "../platform/agent_instructions.js";
import { createProjectScheduleRequirement, patchProjectDocument } from "../work/automations/builtins.js";
import { registerAgent } from "../agents/registry.js";
import type { AgentRun, AgentTool } from "../agents/types.js";
import { asArray, asObject, cleanText, errorMessage, toolError, type JsonObject } from "../agents/util.js";
import {
  orgCommsFeed,
  projectCommsFeed,
  projectEmailThreadDetail,
  searchComms,
  sendProjectEmail,
  sendProjectSms
} from "./service.js";
import { loadCommsSettings, resolveProjectCommsSettings, saveCommsSettings } from "./settings.js";
import { appointmentAvailability, commitAppointmentReschedule, holdAppointmentSlot, readSchedulingAvailabilitySettings } from "../appointments/availability.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";

export const COMMS_AGENT_ID = "comms";

const SEND_PERMISSION = "send_comms|send_communications|manage_projects|manage_company_settings";
const SCHEDULE_PERMISSION = "manage_schedule|manage_projects|manage_company_settings";
const READ_PERMISSION = "view_comms";

function focusProjectId(run: AgentRun) {
  return cleanText(run.subjectId);
}

function allowSend(run: AgentRun) {
  return run.scratch.allowSend === true;
}

function allowScheduling(run: AgentRun) {
  return run.scratch.allowScheduling === true;
}

function allowAvailabilityRead(run: AgentRun) {
  return run.scratch.allowAvailabilityRead === true && run.scratch.agentAvailabilityFeature === true;
}

function allowRescheduling(run: AgentRun) {
  return run.scratch.allowRescheduling === true && run.scratch.agentAvailabilityFeature === true;
}

function requireProject(run: AgentRun): string | JsonObject {
  const projectId = focusProjectId(run);
  if (!projectId) {
    return toolError("This conversation is not focused on one project. Ask the customer which project they mean, or use search_comms / get_comms_feed with all_projects to look across the company.");
  }
  return projectId;
}

async function projectContext(run: AgentRun): Promise<JsonObject> {
  const projectId = focusProjectId(run);
  const document = await readDocument(run.orgId, "projects", projectId);
  const data = asObject(document.data);
  const contacts = asArray(data.contacts).map((contact) => {
    const record = asObject(contact);
    return {
      id: record.id || record.contact_id,
      name: record.name || `${cleanText(record.first_name)} ${cleanText(record.last_name)}`.trim(),
      email: record.email,
      phone: record.phone || record.phone_number || record.mobile,
      primary: record.primary === true
    };
  });
  const events = asArray(data.events).map((event) => {
    const record = asObject(event);
    return {
      id: record.id,
      title: record.title,
      kind: record.kind || record.type,
      status: record.status,
      start_at: record.start_at,
      end_at: record.end_at,
      assigned_role_ids: record.assigned_role_ids,
      assigned_user_ids: record.assigned_user_ids
    };
  });
  return {
    id: document.id,
    title: data.title || data.name,
    address: data.address,
    status: data.status,
    stage: data.stage_label || data.stage,
    contacts,
    events,
    custom_fields: asObject(data.custom_fields)
  };
}

const TOOLS: AgentTool[] = [
  {
    name: "get_project_context",
    description: "Read the focus project: customer contacts, address, stage, schedule events (with ids), and custom fields. Call this before scheduling or referencing project facts.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      const projectId = requireProject(run);
      if (typeof projectId !== "string") return projectId;
      return { ok: true, project: await projectContext(run) };
    }
  },
  {
    name: "get_comms_feed",
    permission: READ_PERMISSION,
    allowSystem: true,
    description: "Read communication history across channels, newest last. Scoped to the focus project when there is one; set all_projects to read the org-wide feed. Optional channel filter: email, sms, webchat.",
    parameters: { type: "object", properties: { channel: { type: "string" }, limit: { type: "number" }, all_projects: { type: "boolean" } }, required: [], additionalProperties: false },
    async execute(run, args) {
      const projectId = focusProjectId(run);
      const useOrgWide = args.all_projects === true || !projectId;
      const messages = useOrgWide
        ? (await orgCommsFeed(run.orgId, { channel: cleanText(args.channel) || undefined, limit: Number(args.limit) || 100 }))
        : (await projectCommsFeed(run.orgId, projectId, { channel: cleanText(args.channel) || undefined, limit: Number(args.limit) || 100 }));
      return { ok: true, messages: messages.map((message) => ({ ...message, html: undefined })) };
    }
  },
  {
    name: "search_comms",
    permission: READ_PERMISSION,
    allowSystem: true,
    description: "Full-text search this organization's communications. Scoped to the focus project unless all_projects is true.",
    parameters: { type: "object", properties: { query: { type: "string" }, channel: { type: "string" }, all_projects: { type: "boolean" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
    async execute(run, args) {
      return {
        ok: true,
        results: (await searchComms(run.orgId, cleanText(args.query), {
          project_id: args.all_projects === true || !focusProjectId(run) ? undefined : focusProjectId(run),
          channel: cleanText(args.channel) || undefined,
          limit: Number(args.limit) || 25
        })).map((hit) => ({ ...hit, html: undefined }))
      };
    }
  },
  {
    name: "get_email_thread",
    permission: READ_PERMISSION,
    allowSystem: true,
    description: "Read one email thread (conversation) in full. project_id is required when the conversation is not focused on one project.",
    parameters: { type: "object", properties: { conversation_id: { type: "string" }, project_id: { type: "string" } }, required: ["conversation_id"], additionalProperties: false },
    async execute(run, args) {
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id — get it from search_comms or the org-wide feed rows.");
      return { ok: true, thread: (await projectEmailThreadDetail(run.orgId, projectId, cleanText(args.conversation_id))) };
    }
  },
  {
    name: "send_email",
    description: "Send an email to a project's customer from the org inbox. Threads onto the existing conversation when conversation_id is given.",
    parameters: { type: "object", properties: { subject: { type: "string" }, text: { type: "string" }, conversation_id: { type: "string" }, project_id: { type: "string" } }, required: ["subject", "text"], additionalProperties: false },
    permission: SEND_PERMISSION,
    gate: (run) => allowSend(run) ? true : "Sending is turned off for the comms agent (Company Settings → Communications). Draft the message in your reply instead.",
    async execute(run, args) {
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id so the email lands on the right project.");
      const result = await sendProjectEmail(run.orgId, run.branchId, projectId, {
        subject: cleanText(args.subject),
        text: String(args.text ?? ""),
        conversation_id: cleanText(args.conversation_id) || undefined,
        source: { type: "automation", id: "comms_agent" }
      });
      run.changeLog.push(`Sent email "${cleanText(args.subject)}" to the customer.`);
      return { ok: true, message_id: asObject(result.message).id, test_mode: cleanText(asObject(asObject(result.message).metadata).transport_mode) !== "live" };
    }
  },
  {
    name: "send_sms",
    description: "Send a text message to a project's customer.",
    parameters: { type: "object", properties: { text: { type: "string" }, project_id: { type: "string" } }, required: ["text"], additionalProperties: false },
    permission: SEND_PERMISSION,
    gate: (run) => allowSend(run) ? true : "Sending is turned off for the comms agent (Company Settings → Communications). Draft the message in your reply instead.",
    async execute(run, args) {
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id so the text goes to the right customer.");
      const result = await sendProjectSms(run.orgId, run.branchId, projectId, {
        text: String(args.text ?? ""),
        source: { type: "automation", id: "comms_agent" }
      });
      run.changeLog.push("Sent a text message to the customer.");
      return { ok: true, message_id: asObject(result.message).id };
    }
  },
  {
    name: "find_available_appointment_slots",
    description: "Read authoritative bookable slots for an existing appointment. Use this before offering or committing any reschedule.",
    parameters: { type: "object", properties: { event_id: { type: "string" }, start_date: { type: "string" }, end_date: { type: "string" }, days: { type: "number" }, project_id: { type: "string" } }, required: ["event_id"], additionalProperties: false },
    permission: SCHEDULE_PERMISSION,
    allowSystem: true,
    gate: (run) => allowAvailabilityRead(run) ? true : "Availability reading is turned off for this agent.",
    async execute(run, args) {
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id for the appointment.");
      const result = await appointmentAvailability(run.orgId, run.branchId, {
        project_id: projectId,
        event_id: cleanText(args.event_id),
        start_date: cleanText(args.start_date) || undefined,
        end_date: cleanText(args.end_date) || undefined,
        days: Number(args.days) || 14,
        limit: 240
      });
      return {
        ok: true,
        timezone: result.timezone,
        event_id: result.event_id,
        slots: asArray(result.slots).map(asObject).filter((slot) => slot.available === true).slice(0, 12)
      };
    }
  },
  {
    name: "schedule_project_event",
    description: "Add or book a schedule event on the focus project. With start_at/end_at (ISO timestamps with timezone) it is scheduled; without, it is an unscheduled requirement.",
    parameters: { type: "object", properties: { title: { type: "string" }, kind: { type: "string" }, start_at: { type: "string" }, end_at: { type: "string" }, notes: { type: "string" }, project_id: { type: "string" } }, required: ["title"], additionalProperties: false },
    permission: SCHEDULE_PERMISSION,
    allowSystem: true,
    gate: (run) => allowScheduling(run) ? true : "Scheduling is turned off for the comms agent (Company Settings → Communications).",
    async execute(run, args) {
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id to schedule on the right project.");
      const startAt = cleanText(args.start_at);
      const event = await createProjectScheduleRequirement(run.orgId, projectId, {
        title: cleanText(args.title) || "Appointment",
        kind: cleanText(args.kind) || "appointment",
        start_at: startAt,
        end_at: cleanText(args.end_at),
        notes: cleanText(args.notes),
        status: startAt ? "scheduled" : "unscheduled",
        source: "comms_agent"
      });
      run.changeLog.push(startAt ? `Scheduled "${cleanText(args.title)}" for ${startAt}.` : `Added unscheduled requirement "${cleanText(args.title)}".`);
      return { ok: true, event };
    }
  },
  {
    name: "reschedule_project_event",
    description: "Safely move an eligible customer-schedulable appointment to a slot returned by find_available_appointment_slots.",
    parameters: { type: "object", properties: { event_id: { type: "string" }, start_at: { type: "string" }, resource_key: { type: "string" }, project_id: { type: "string" } }, required: ["event_id", "start_at"], additionalProperties: false },
    permission: SCHEDULE_PERMISSION,
    allowSystem: true,
    gate: (run) => allowScheduling(run) ? true : "Scheduling is turned off for the comms agent (Company Settings → Communications).",
    async execute(run, args) {
      if (!allowRescheduling(run)) return toolError("Customer rescheduling is turned off for this agent.");
      const projectId = cleanText(args.project_id) || focusProjectId(run);
      if (!projectId) return toolError("Pass project_id for the project whose event moves.");
      const eventId = cleanText(args.event_id);
      const startAt = cleanText(args.start_at);
      if (!eventId || !startAt) return toolError("event_id and start_at are required.");
      const held = await holdAppointmentSlot(run.orgId, run.branchId, {
        project_id: projectId,
        event_id: eventId,
        start_at: startAt,
        resource_key: cleanText(args.resource_key),
        source: "comms_agent",
        source_id: cleanText(run.input.thread_id || run.input.conversation_id || run.subjectId)
      });
      const committed = await commitAppointmentReschedule(run.orgId, cleanText(asObject(held.hold).id), { source: "comms_agent", actor: "agent" });
      run.changeLog.push(`Rescheduled "${cleanText(asObject(committed.event).title) || eventId}" to ${startAt}.`);
      return { ok: true, event: committed.event };
    }
  }
];

registerAgent({
  id: COMMS_AGENT_ID,
  title: "Comms Agent",
  description: "The communications AI: understands every email, text, and chat conversation, drafts and sends replies, and books appointments straight from customer messages.",
  capability: "comms.agent",
  usePermission: "view_comms|view_projects|manage_projects|manage_company_settings",
  threadScope: "user",
  model: () => ({
    model: env.openaiCommsAgentModel,
    effort: env.openaiCommsAgentEffort,
    timeoutMs: env.openaiCommsAgentTimeoutMs
  }),
  loop: { maxRounds: 12, maxOutputTokens: 6_000 },
  settings: {
    defaults: () => ({ enabled: true, display_name: "Comms Agent", custom_instructions: "" }),
    normalize: (raw) => {
      const value = asObject(raw);
      return {
        enabled: value.enabled !== false,
        display_name: cleanText(value.display_name ?? value.agent_name).slice(0, 80) || "Comms Agent",
        custom_instructions: String(value.custom_instructions ?? "").slice(0, 8_000),
        allow_send: value.allow_send === true,
        allow_scheduling: value.allow_scheduling !== false,
        allow_availability_read: value.allow_availability_read === true,
        allow_rescheduling: value.allow_rescheduling === true,
        auto_response: asObject(value.auto_response)
      };
    },
    // Comms settings live inside the comms_settings branch module; the
    // centralized surface reads/writes the agent section of it.
    load: async (orgId, branchId) => {
      const settings = await loadCommsSettings(orgId, branchId);
      const agent = asObject((settings as unknown as JsonObject).agent);
      return { ...agent, display_name: cleanText(agent.agent_name), enabled: agent.enabled !== false };
    },
    save: async (orgId, branchId, value) => {
      const current = await loadCommsSettings(orgId, branchId) as unknown as JsonObject;
      const agent = {
        ...asObject(current.agent),
        enabled: (value as JsonObject).enabled !== false,
        agent_name: cleanText((value as JsonObject).display_name || (value as JsonObject).agent_name) || "Comms Agent",
        custom_instructions: String((value as JsonObject).custom_instructions ?? "").slice(0, 8_000),
        ...(typeof (value as JsonObject).allow_send === "boolean" ? { allow_send: (value as JsonObject).allow_send } : {}),
        ...(typeof (value as JsonObject).allow_scheduling === "boolean" ? { allow_scheduling: (value as JsonObject).allow_scheduling } : {}),
        ...(typeof (value as JsonObject).allow_availability_read === "boolean" ? { allow_availability_read: (value as JsonObject).allow_availability_read } : {}),
        ...(typeof (value as JsonObject).allow_rescheduling === "boolean" ? { allow_rescheduling: (value as JsonObject).allow_rescheduling } : {})
      };
      const saved = await saveCommsSettings(orgId, branchId, { ...current, agent }) as unknown as JsonObject;
      const savedAgent = asObject(saved.agent);
      return { ...savedAgent, display_name: cleanText(savedAgent.agent_name), enabled: savedAgent.enabled !== false };
    }
  },
  async prepare(run) {
    const projectId = focusProjectId(run);
    if (projectId) {
      const resolved = await resolveProjectCommsSettings(run.orgId, run.branchId, projectId);
      run.scratch.allowSend = resolved.agent.allow_send === true;
      run.scratch.allowScheduling = resolved.agent.allow_scheduling === true;
      run.scratch.allowAvailabilityRead = resolved.agent.allow_availability_read === true;
      run.scratch.allowRescheduling = resolved.agent.allow_rescheduling === true;
      run.scratch.projectInstructions = cleanText(resolved.overrides.agent_instructions);
      run.settings = { ...run.settings, custom_instructions: cleanText(resolved.agent.custom_instructions), display_name: cleanText(resolved.agent.agent_name) || cleanText(run.settings.display_name) };
    } else {
      const settings = await loadCommsSettings(run.orgId, run.branchId) as unknown as JsonObject;
      const agent = asObject(settings.agent);
      run.scratch.allowSend = agent.allow_send === true;
      run.scratch.allowScheduling = agent.allow_scheduling !== false;
      run.scratch.allowAvailabilityRead = agent.allow_availability_read === true;
      run.scratch.allowRescheduling = agent.allow_rescheduling === true;
      run.scratch.projectInstructions = "";
    }
    run.scratch.agentAvailabilityFeature = await isCapabilityEnabled(run.orgId, "scheduling.agent_availability").catch(() => false);
    const schedulingPolicy = (await readSchedulingAvailabilitySettings(run.orgId, run.branchId).catch(() => null))?.settings.self_service;
    run.scratch.allowAvailabilityRead = run.scratch.allowAvailabilityRead === true && schedulingPolicy?.agent_read_enabled === true;
    run.scratch.allowRescheduling = run.scratch.allowRescheduling === true && schedulingPolicy?.agent_write_enabled === true;
    // Auto-response runs never send directly — propose_reply is dispatched
    // under runAutoResponse's control.
    if (cleanText(run.input.auto_mode)) run.scratch.allowSend = false;
  },
  async systemPrompt(run) {
    let orgName = "";
    try {
      const record = asObject(await readOrganization(run.orgId));
      orgName = cleanText(asObject(record.data).name || record.name);
    } catch {}
    const appInstructions = await buildAgentInstructions(run.orgId, run.branchId).catch(() => "");
    const agentName = cleanText(run.settings.display_name) || "the Comms Agent";
    const autoMode = cleanText(run.input.auto_mode);
    const focused = Boolean(focusProjectId(run));
    const roleBlock = autoMode
      ? `You are ${agentName}, the communications AI for "${orgName || "this company"}". A customer just sent an inbound message on a project. Your job is to handle it: read the project context and conversation history, take any actions the customer's message calls for (like rescheduling an appointment — when allowed), then call propose_reply exactly once with a reply in the customer's channel. ${autoMode === "send" ? "Your reply WILL BE SENT to the customer immediately." : "Your reply will be saved as a DRAFT for the team to review before sending."} Write to the CUSTOMER, not the team.`
      : focused
        ? `You are ${agentName}, the communications AI for "${orgName || "this company"}" working inside one project's comms tab. You help a TEAM MEMBER understand and act on customer communications for this project.`
        : `You are ${agentName}, the communications AI for "${orgName || "this company"}" working in the company-wide communications center. You help a TEAM MEMBER across EVERY inbox: email, texts, and chats on all projects. Use all_projects lookups and always name which project/customer each finding belongs to.`;
    return [
      roleBlock,
      appInstructions,
      "## Working rules",
      [
        "- Ground every statement in tool results — never invent messages, dates, or commitments.",
        "- Check get_project_context before scheduling or promising anything time-related.",
        autoMode
          ? "- If the customer's request is unclear, risky, or beyond what you can do (refunds, pricing changes, complaints), do NOT improvise: propose a short acknowledgement reply telling the customer the team will follow up, and say in report_result that a human should take over."
          : "- Sending email/SMS is real customer communication: only send when the team member explicitly asked you to send (not merely to draft), and restate what you sent in your reply.",
        "- ALWAYS finish by calling report_result."
      ].join("\n"),
      cleanText(run.settings.custom_instructions) ? `## Company instructions\n${cleanText(run.settings.custom_instructions)}` : "",
      cleanText(run.scratch.projectInstructions) ? `## Project-specific instructions\n${cleanText(run.scratch.projectInstructions)}` : ""
    ].filter(Boolean).join("\n\n");
  },
  tools: TOOLS
});
