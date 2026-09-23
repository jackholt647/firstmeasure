// The global FirstMate assistant, declared as a framework agent. The tool
// implementations are unchanged from the original service — what moved to
// the shared runtime is the loop, trace, report_result contract, thread
// storage, and the failure epilogue. Write tools now also carry per-user
// permission keys, so the assistant can only do what the calling user could
// do through the UI.

import { env } from "../../src/config/env.js";
import { hasPermission } from "../../platform/auth.js";
import { readOrganization, readDocument, listDocuments } from "../../platform/storage.js";
import {
  createCanonicalActionItem,
  listCanonicalActionItems,
  searchPlatformProjectsAndContacts
} from "../../platform/api.js";
import { effectiveCapabilities } from "../../platform/capabilities.js";
import { buildAgentInstructions } from "../../platform/agent_instructions.js";
import { projectWorkProjection, transitionWorkNode } from "../../work/service.js";
import { emitWorkEvent } from "../../work/engine.js";
import { listWorkEventDefinitions } from "../../work/events.js";
import { listEventRecords } from "../../work/storage.js";
import { createProjectScheduleRequirement } from "../../work/automations/builtins.js";
import { executeStatsQueries } from "../../stats/metrics.js";
import { ensureStatsFreshness } from "../../stats/sync.js";
import { listProjectDocuments, readDocumentInstance } from "../../documents/storage.js";
import { sendCommunication } from "../../messaging/communications_service.js";
import { sendCommunicationSchema } from "../../messaging/schemas.js";
import { ensureProjectChannelRecord, postAgentMessage } from "../../channels/service.js";
import { channelUserIdForAgent } from "../../agents/participants.js";
import { registerAgent } from "../../agents/registry.js";
import type { AgentRun, AgentTool } from "../../agents/types.js";
import {
  asArray,
  asObject,
  cleanText,
  errorMessage,
  parseJsonArg,
  toolError,
  truncateJson,
  type JsonObject
} from "../../agents/util.js";
import { defaultAssistantSettings, loadAssistantSettings, normalizeAssistantSettings, saveAssistantSettings } from "../settings.js";
import { buildAssistantManifest } from "./manifest.js";

const MAX_NAVIGATION_ACTIONS = 6;

const ACTION_PERMISSION = "manage_projects";
const SCHEDULE_PERMISSION = "manage_schedule|manage_projects";
const MESSAGING_PERMISSION = "send_communications|manage_sales|manage_projects|manage_company_settings";

function settings(run: AgentRun) {
  return run.settings as ReturnType<typeof normalizeAssistantSettings>;
}

function dataScope(run: AgentRun): Record<string, boolean> {
  return asObject(settings(run).data_scope) as Record<string, boolean>;
}

function actionsAllowed(run: AgentRun) {
  return run.scratch.actionsAllowed === true && settings(run).allow_actions;
}

function messagingAllowed(run: AgentRun) {
  return run.scratch.messagingAllowed === true && settings(run).allow_messaging;
}

function scopeDisabled(area: string) {
  return `Access to ${area} is turned off in this company's assistant settings. Tell the customer an admin can re-enable it under Company Settings → AI Assistant.`;
}

const ACTIONS_DISABLED = "Assistant actions are turned off for this company (Company Settings → AI Assistant, and the Assistant Actions feature toggle). You can look things up but not change them.";

function looseCtx(run: AgentRun): Record<string, unknown> {
  return { userId: run.userId, branchId: run.branchId, user: { id: run.userId } };
}

// ── Compact projections (keep tool output small) ───────────────────────────

function compactProject(document: JsonObject) {
  const data = asObject(document.data);
  const projection = asObject(data.work_projection);
  const lifecycle = asObject(data.lifecycle);
  const stage = asObject(projection.primary_stage);
  return {
    id: cleanText(document.id),
    title: cleanText(data.title || data.project_title || data.customer_name || data.address) || "(untitled)",
    address: cleanText(data.address || data.project_address),
    customer_name: cleanText(data.customer_name),
    customer_phone: cleanText(data.customer_phone),
    customer_email: cleanText(data.customer_email),
    status: cleanText(lifecycle.status || data.status || "open") || "open",
    stage: cleanText(stage.stage_title || stage.title),
    source: cleanText(data.source),
    created_at: cleanText(document.created_at),
    updated_at: cleanText(document.updated_at)
  };
}

function compactTask(item: JsonObject) {
  return {
    id: cleanText(item.id),
    title: cleanText(item.title),
    body: cleanText(item.body).slice(0, 300),
    status: cleanText(item.status),
    priority: cleanText(item.priority),
    due_at: cleanText(item.due_at),
    kind: cleanText(item.kind),
    project_ids: asArray(item.project_ids).map(cleanText),
    project_title: cleanText(item.project_title),
    assigned_user_ids: asArray(item.assigned_user_ids).map(cleanText)
  };
}

function compactEvent(event: JsonObject) {
  return {
    id: cleanText(event.id),
    type: cleanText(event.type),
    project_id: cleanText(event.project_id),
    actor_user_id: cleanText(event.actor_user_id),
    created_at: cleanText(event.created_at)
  };
}

function compactDocument(document: JsonObject) {
  return {
    id: cleanText(document.id),
    title: cleanText(document.title || asObject(document.data).title),
    kind: cleanText(document.kind || document.type || asObject(document.data).kind),
    status: cleanText(document.status || asObject(document.data).status),
    created_at: cleanText(document.created_at),
    updated_at: cleanText(document.updated_at)
  };
}

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS: AgentTool[] = [
  {
    name: "get_workspace_context",
    description: "Read the current organization, user and date. Use platform_search for authorized records and operations.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(run) {
      let orgName = "";
      try {
        const record = asObject(await readOrganization(run.orgId));
        orgName = cleanText(asObject(record.data).name || record.name);
      } catch {}
      return {
        organization: { id: run.orgId, name: orgName },
        branch_id: run.branchId,
        current_user: { id: run.userId, name: run.userName },
        today: new Date().toISOString().slice(0, 10)
      };
    }
  },
  {
    name: "search_platform",
    description: "Search projects and contacts by name, address, phone, or email fragment. Returns typed rows with project ids you can pass to get_project.",
    parameters: { type: "object", properties: { query: { type: "string" }, types: { type: "string", description: "Comma list of 'project','contact'. Default both." }, limit: { type: "number" } }, required: ["query"], additionalProperties: false },
    gate: (run) => (dataScope(run).projects || dataScope(run).contacts) ? true : scopeDisabled("projects and contacts"),
    async execute(run, args) {
      const scope = dataScope(run);
      const allowed = [scope.projects && run.ctx && hasPermission(run.ctx,"view_projects") ? "project" : "", scope.contacts && run.ctx && hasPermission(run.ctx,"view_contacts") ? "contact" : ""].filter(Boolean);
      const requested = cleanText(args.types).split(",").map(value=>value.trim()).filter(Boolean);
      const types = (requested.length ? requested.filter(type=>allowed.includes(type)) : allowed).join(",");
      if (!types) return toolError("No requested search category is available to this user.");
      const result = await searchPlatformProjectsAndContacts(run.orgId, {
        query: cleanText(args.query),
        types,
        limit: Math.min(25, Math.max(1, Number(args.limit || 10)))
      });
      return asObject(result);
    }
  },
  {
    name: "list_projects",
    permission: "view_projects",
    description: "List projects with compact rows (title, address, customer, lifecycle status, stage). Optional text query and status filter (open, completed, canceled, lost).",
    parameters: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "number" } }, required: [], additionalProperties: false },
    gate: (run) => dataScope(run).projects ? true : scopeDisabled("projects"),
    async execute(run, args) {
      const documents = (await listDocuments(run.orgId, "projects")).map(asObject);
      const query = cleanText(args.query).toLowerCase();
      const status = cleanText(args.status).toLowerCase();
      const limit = Math.min(50, Math.max(1, Number(args.limit || 25)));
      const projects = documents
        .map(compactProject)
        .filter((project) => !status || project.status === status)
        .filter((project) => {
          if (!query) return true;
          return [project.title, project.address, project.customer_name, project.customer_email, project.customer_phone]
            .some((field) => field.toLowerCase().includes(query));
        })
        .slice(0, limit);
      return { total_in_org: documents.length, returned: projects.length, projects };
    }
  },
  {
    name: "get_project",
    permission: "view_projects",
    description: "Read one project in full: details, contacts, custom fields, scope instances with current stages, lifecycle, open tasks, documents, schedule events, and recent activity. The workhorse lookup tool.",
    parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    gate: (run) => dataScope(run).projects ? true : scopeDisabled("projects"),
    async execute(run, args) {
      const projectId = cleanText(args.project_id);
      if (!projectId) return toolError("project_id is required.");
      let document: JsonObject;
      try {
        document = asObject(await readDocument(run.orgId, "projects", projectId));
      } catch {
        return toolError("That project was not found.");
      }
      const scope = dataScope(run);
      const data = asObject(document.data);
      const projection = (await projectWorkProjection(run.orgId, projectId));
      const tasks = await listCanonicalActionItems(run.orgId, looseCtx(run), { projectId, includeAll: true })
        .then((result) => asArray(asObject(result).items).map((item) => compactTask(asObject(item))))
        .catch(() => []);
      const documents = scope.documents && run.ctx && hasPermission(run.ctx,"view_documents")
        ? (await listProjectDocuments(run.orgId, projectId).catch(() => [])).map((entry) => compactDocument(asObject(entry))).slice(0, 25)
        : [];
      const activity = scope.activity
        ? (await listEventRecords(run.orgId, { project_id: projectId, visibility: "activity", limit: 12 })).map((entry) => compactEvent(asObject(entry)))
        : [];
      return {
        project: {
          ...compactProject(document),
          contacts: asArray(data.contacts).map((contact) => {
            const entry = asObject(contact);
            return {
              id: cleanText(entry.id),
              name: cleanText(entry.name),
              email: cleanText(entry.email),
              phone: cleanText(entry.phone),
              role: cleanText(entry.role),
              primary: entry.primary === true
            };
          }),
          custom_fields: asObject(data.custom_fields),
          schedule_events: asArray(data.events).map((event) => {
            const entry = asObject(event);
            return {
              id: cleanText(entry.id),
              title: cleanText(entry.title || entry.kind || entry.event_type_default_id),
              status: cleanText(entry.status),
              start_at: cleanText(entry.start_at),
              end_at: cleanText(entry.end_at)
            };
          })
        },
        work: {
          lifecycle: asObject(asObject(projection).lifecycle),
          active_stages: asArray(asObject(projection).active_stages),
          instances: asArray(asObject(projection).instances).map((instance) => {
            const entry = asObject(instance);
            return {
              plan_id: cleanText(entry.plan_id),
              kind: cleanText(entry.kind),
              title: cleanText(entry.title),
              status: cleanText(entry.status),
              stage_id: cleanText(entry.stage_id),
              stage_title: cleanText(entry.stage_title)
            };
          })
        },
        tasks,
        documents,
        recent_activity: activity
      };
    }
  },
  {
    name: "list_tasks",
    permission: "view_projects",
    description: "List to-dos / action items (optionally for one project, one status, or a due window). Includes follow-ups and workflow tasks.",
    parameters: { type: "object", properties: { project_id: { type: "string" }, status: { type: "string" }, include_completed: { type: "boolean" }, due_before: { type: "string" }, due_after: { type: "string" }, mine_only: { type: "boolean" } }, required: [], additionalProperties: false },
    async execute(run, args) {
      const result = await listCanonicalActionItems(run.orgId, looseCtx(run), {
        projectId: cleanText(args.project_id),
        includeAll: args.mine_only === true ? false : true,
        includeCompleted: args.include_completed === true,
        dueBefore: cleanText(args.due_before),
        dueAfter: cleanText(args.due_after),
        status: cleanText(args.status)
      });
      const items = asArray(asObject(result).items).map((item) => compactTask(asObject(item)));
      return {
        items: items.slice(0, 50),
        active_count: Number(asObject(result).active_count || 0),
        overdue_count: Number(asObject(result).overdue_count || 0)
      };
    }
  },
  {
    name: "get_schedule",
    permission: "view_schedule",
    description: "Read calendar events between two dates (YYYY-MM-DD, inclusive).",
    parameters: { type: "object", properties: { from: { type: "string" }, through: { type: "string" } }, required: ["from", "through"], additionalProperties: false },
    gate: (run) => dataScope(run).schedule ? true : scopeDisabled("the schedule"),
    async execute(run, args) {
      const from = cleanText(args.from);
      const through = cleanText(args.through);
      if (!from || !through) return toolError("from and through (YYYY-MM-DD) are both required.");
      const fromIso = `${from}T00:00:00.000Z`;
      const throughIso = `${through}T23:59:59.999Z`;
      const events = (await listDocuments(run.orgId, "calendar_events").catch(() => []))
        .map(asObject)
        .map((doc) => ({ ...asObject(doc.data), id: cleanText(doc.id) } as JsonObject))
        .filter((event) => {
          const start = cleanText(event.start_at || event.start);
          const end = cleanText(event.end_at || event.end) || start;
          return start && start <= throughIso && end >= fromIso;
        })
        .map((event) => ({
          id: cleanText(event.id),
          title: cleanText(event.title || event.name),
          project_id: cleanText(event.project_id),
          start_at: cleanText(event.start_at || event.start),
          end_at: cleanText(event.end_at || event.end),
          status: cleanText(event.status),
          assigned_user_ids: asArray(event.assigned_user_ids ?? event.user_ids).map(cleanText)
        }))
        .slice(0, 100);
      return { from, through, events };
    }
  },
  {
    name: "list_activity",
    permission: "view_projects",
    description: "Read the recent activity/event feed for the org or one project. Optional type_prefix filter (e.g. 'payment.' or 'communication.').",
    parameters: { type: "object", properties: { project_id: { type: "string" }, type_prefix: { type: "string" }, include_system: { type: "boolean" }, limit: { type: "number" } }, required: [], additionalProperties: false },
    gate: (run) => dataScope(run).activity ? true : scopeDisabled("the activity feed"),
    async execute(run, args) {
      const events = (await listEventRecords(run.orgId, {
        project_id: cleanText(args.project_id) || undefined,
        type_prefix: cleanText(args.type_prefix) || undefined,
        visibility: args.include_system === true ? undefined : "activity",
        limit: Math.min(50, Math.max(1, Number(args.limit || 25)))
      })).map((entry) => compactEvent(asObject(entry)));
      return { events };
    }
  },
  {
    name: "run_stats_queries",
    permission: "view_stats",
    description: "Run one or more metric-DSL queries against the stats warehouse. Returns rows of {bucket?, group?, group_label?, value, row_count}. Money values are integer cents.",
    parameters: { type: "object", properties: { queries: { type: "string", description: "JSON object mapping names to metric specs." } }, required: ["queries"], additionalProperties: false },
    gate: (run) => dataScope(run).stats ? true : scopeDisabled("stats"),
    async execute(run, args) {
      const queries = parseJsonArg(args.queries, "queries");
      if (!Object.keys(queries).length) return toolError("queries must be a JSON object of {name: metric spec}.");
      await ensureStatsFreshness(run.orgId).catch(() => null);
      try {
        return (await executeStatsQueries(run.orgId, queries)) as unknown as JsonObject;
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "read_document",
    permission: "view_documents",
    description: "Read one document instance (proposal, invoice, contract, report) by id.",
    parameters: { type: "object", properties: { document_id: { type: "string" } }, required: ["document_id"], additionalProperties: false },
    gate: (run) => dataScope(run).documents ? true : scopeDisabled("documents"),
    async execute(run, args) {
      const documentId = cleanText(args.document_id);
      if (!documentId) return toolError("document_id is required.");
      const document = await readDocumentInstance(run.orgId, documentId).catch(() => null);
      if (!document) return toolError("That document was not found.");
      return { document: JSON.parse(truncateJson(document, 20_000)) };
    }
  },

  // ── Write tools (per-user permission + org gates) ─────────────────────────

  {
    name: "create_task",
    description: "Create a to-do / action item, optionally on a project, with due date, priority (low|normal|high|urgent), and assignees.",
    parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, project_id: { type: "string" }, due_at: { type: "string" }, priority: { type: "string" }, assigned_user_ids: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false },
    permission: ACTION_PERMISSION,
    gate: (run) => actionsAllowed(run) ? true : ACTIONS_DISABLED,
    async execute(run, args) {
      const title = cleanText(args.title);
      if (!title) return toolError("title is required.");
      const item = asObject(await createCanonicalActionItem(run.orgId, {
        title,
        body: cleanText(args.body),
        due_at: cleanText(args.due_at),
        priority: cleanText(args.priority) || "normal",
        project_ids: cleanText(args.project_id) ? [cleanText(args.project_id)] : [],
        assigned_user_ids: asArray(args.assigned_user_ids).map(cleanText).filter(Boolean),
        branch_id: run.branchId
      }, looseCtx(run)));
      const createdId = cleanText(item.id);
      if (createdId) {
        run.scratch.createdTaskIds = [...asArray(run.scratch.createdTaskIds).map(cleanText), createdId];
      }
      run.changeLog.push(`Created the to-do "${title}".`);
      return { ok: true, task: compactTask(item) };
    }
  },
  {
    name: "update_task_status",
    description: "Transition a work node: complete/cancel/reactivate a to-do, or advance a pipeline stage node. Statuses: ready, active, completed, skipped, canceled.",
    parameters: { type: "object", properties: { node_id: { type: "string" }, status: { type: "string" }, reason: { type: "string" }, follow_up_outcome: { type: "string" } }, required: ["node_id", "status"], additionalProperties: false },
    permission: ACTION_PERMISSION,
    gate: (run) => actionsAllowed(run) ? true : ACTIONS_DISABLED,
    async execute(run, args) {
      const nodeId = cleanText(args.node_id);
      const status = cleanText(args.status);
      if (!nodeId || !status) return toolError("node_id and status are both required.");
      if (!["ready", "active", "completed", "skipped", "canceled"].includes(status)) {
        return toolError("status must be one of ready, active, completed, skipped, canceled.");
      }
      try {
        const node = asObject(await transitionWorkNode(run.orgId, nodeId, status, {
          reason: cleanText(args.reason) || "assistant",
          ...(cleanText(args.follow_up_outcome) ? { follow_up_outcome: cleanText(args.follow_up_outcome) } : {}),
          context: { actor_user_id: run.userId, source: "assistant" }
        }));
        run.changeLog.push(`Marked "${cleanText(node.title) || nodeId}" as ${status}.`);
        return { ok: true, node: JSON.parse(truncateJson(node, 8_000)) };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "schedule_project_event",
    description: "Add or book a schedule event on a project. With start_at/end_at (ISO timestamps) it is scheduled; without, it is added as an unscheduled requirement.",
    parameters: { type: "object", properties: { project_id: { type: "string" }, title: { type: "string" }, kind: { type: "string" }, start_at: { type: "string" }, end_at: { type: "string" }, notes: { type: "string" } }, required: ["project_id"], additionalProperties: false },
    permission: SCHEDULE_PERMISSION,
    gate: (run) => actionsAllowed(run) ? true : ACTIONS_DISABLED,
    async execute(run, args) {
      const projectId = cleanText(args.project_id);
      if (!projectId) return toolError("project_id is required.");
      const startAt = cleanText(args.start_at);
      try {
        const event = asObject(await createProjectScheduleRequirement(run.orgId, projectId, {
          title: cleanText(args.title),
          kind: cleanText(args.kind),
          start_at: startAt,
          end_at: cleanText(args.end_at),
          status: startAt ? "scheduled" : "unscheduled",
          notes: cleanText(args.notes)
        }));
        run.changeLog.push(startAt
          ? `Scheduled "${cleanText(args.title) || "an event"}" on the project for ${startAt}.`
          : `Added the unscheduled event "${cleanText(args.title) || "event"}" to the project.`);
        return { ok: true, event };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "trigger_automation_event",
    description: "Fire a work event through the automation engine — org automation rules and scope bindings listening to it WILL run immediately and this cannot be undone. Only use when the customer explicitly asks to trigger something.",
    parameters: { type: "object", properties: { type: { type: "string" }, project_id: { type: "string" }, payload: { type: "string", description: "Optional JSON object payload." } }, required: ["type"], additionalProperties: false },
    permission: ACTION_PERMISSION,
    gate: (run) => actionsAllowed(run) ? true : ACTIONS_DISABLED,
    async execute(run, args) {
      const type = cleanText(args.type);
      if (!type) return toolError("type is required.");
      const known = listWorkEventDefinitions().some((definition) => definition.name === type);
      if (!known && !type.startsWith("custom.")) {
        return toolError(`Unknown event type '${type}'. Use a type from the event catalog, or a 'custom.*' type for org automation rules.`);
      }
      const payload = parseJsonArg(args.payload, "payload");
      try {
        const event = asObject(await emitWorkEvent({
          organization_id: run.orgId,
          branch_id: run.branchId,
          project_id: cleanText(args.project_id),
          type,
          payload,
          context: { source: "assistant", actor_user_id: run.userId }
        }));
        run.changeLog.push(`Fired the '${type}' event${cleanText(args.project_id) ? " on the project" : ""} (automations listening to it have run).`);
        return { ok: true, event_id: cleanText(event.id), note: "Event processed. This cannot be undone." };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "post_project_note",
    description: "Post an internal note to a project's notes feed (visible to the team, not the customer).",
    parameters: { type: "object", properties: { project_id: { type: "string" }, text: { type: "string" } }, required: ["project_id", "text"], additionalProperties: false },
    permission: ACTION_PERMISSION,
    gate: (run) => (run.scratch.actionsAllowed === true && settings(run).allow_notes)
      ? true
      : "Posting project notes is turned off in this company's assistant settings.",
    async execute(run, args) {
      const projectId = cleanText(args.project_id);
      const text = cleanText(args.text);
      if (!projectId || !text) return toolError("project_id and text are both required.");
      let title = "";
      try {
        const document = asObject(await readDocument(run.orgId, "projects", projectId));
        title = cleanText(asObject(document.data).title);
      } catch {
        return toolError("That project was not found.");
      }
      const channel = asObject((await ensureProjectChannelRecord(run.orgId, projectId, title, run.userId || "assistant")));
      const { message } = await postAgentMessage(run.orgId, cleanText(channel.id), {
        author_id: channelUserIdForAgent("assistant"),
        text,
        metadata: { source: "assistant", requested_by: run.userId }
      });
      run.changeLog.push("Posted a note on the project.");
      return { ok: true, message_id: cleanText(asObject(message).id) };
    }
  },
  {
    name: "send_customer_message",
    description: "Send an SMS or email to a customer. ONLY after the customer has explicitly confirmed the exact message in this conversation. recipients_json is a JSON array of {name, phone?, email?, contact_id?}.",
    parameters: { type: "object", properties: { channel: { type: "string", enum: ["sms", "email"] }, recipients_json: { type: "string" }, subject: { type: "string" }, text: { type: "string" }, project_id: { type: "string" } }, required: ["channel", "recipients_json", "text"], additionalProperties: false },
    permission: MESSAGING_PERMISSION,
    // Scheduled wakeups and await follow-ups run without a calling user;
    // the capability + settings gate below still applies to those runs.
    allowSystem: true,
    gate: (run) => messagingAllowed(run)
      ? true
      : "Customer messaging by the assistant is turned off for this company (Company Settings → AI Assistant, and the Assistant Customer Messaging feature). Draft the message for the customer to send themselves instead.",
    async execute(run, args) {
      let recipients: unknown = [];
      try {
        recipients = typeof args.recipients_json === "string" ? JSON.parse(args.recipients_json) : args.recipients_json;
      } catch {
        return toolError("recipients_json is not valid JSON.");
      }
      let parsed;
      try {
        parsed = sendCommunicationSchema.parse({
          channel: cleanText(args.channel),
          recipients: asArray(recipients),
          content: {
            subject: cleanText(args.subject),
            text: String(args.text ?? "")
          },
          branch_id: run.branchId,
          ...(cleanText(args.project_id) ? { context: { project_id: cleanText(args.project_id) } } : {}),
          metadata: { source: "assistant", actor_user_id: run.userId }
        });
      } catch (error) {
        return toolError(`Invalid message: ${errorMessage(error).slice(0, 800)}`);
      }
      try {
        const result = asObject(await sendCommunication(run.orgId, parsed, { userId: run.userId, branchId: run.branchId } as never));
        run.changeLog.push(`Sent a ${cleanText(args.channel)} to the customer.`);
        return { ok: true, result: JSON.parse(truncateJson(result, 8_000)) };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    }
  },
  {
    name: "suggest_navigation",
    description: "Attach an 'open this' button to your reply: kind 'project' (with project_id) opens the project, kind 'tab' (with tab id like 'stats', 'scheduling', 'contacts', 'channels', 'money') opens a portal tab. Use whenever you reference something the customer will want to open.",
    parameters: { type: "object", properties: { label: { type: "string" }, kind: { type: "string", enum: ["project", "tab"] }, project_id: { type: "string" }, tab: { type: "string" } }, required: ["label", "kind"], additionalProperties: false },
    execute(run, args) {
      if (run.actions.length >= MAX_NAVIGATION_ACTIONS) return toolError("Too many navigation suggestions in one reply.");
      const label = cleanText(args.label);
      const kind = cleanText(args.kind);
      if (!label || !["project", "tab"].includes(kind)) return toolError("label is required and kind must be 'project' or 'tab'.");
      if (kind === "project" && !cleanText(args.project_id)) return toolError("project_id is required for kind 'project'.");
      if (kind === "tab" && !cleanText(args.tab)) return toolError("tab is required for kind 'tab'.");
      run.actions.push({ label, kind, project_id: cleanText(args.project_id), tab: cleanText(args.tab) });
      return { ok: true };
    }
  }
];

// ── Registration ───────────────────────────────────────────────────────────

export const ASSISTANT_AGENT_ID = "assistant";

registerAgent({
  id: ASSISTANT_AGENT_ID,
  title: "FirstMate Assistant",
  description: "The company-wide AI assistant in the top bar: answers questions, looks up anything in the workspace, runs stats, and takes action across the platform.",
  capability: "apps.assistant",
  usePermission: "use_assistant|view_projects|manage_projects|manage_company_settings",
  threadScope: "user",
  model: () => ({
    model: env.openaiAssistantAgentModel,
    effort: env.openaiAssistantAgentEffort,
    timeoutMs: env.openaiAssistantAgentTimeoutMs
  }),
  loop: { maxRounds: 16 },
  settings: {
    defaults: () => defaultAssistantSettings() as unknown as JsonObject,
    normalize: (raw) => {
      const normalized = normalizeAssistantSettings(raw) as unknown as JsonObject;
      // Common-core aliases for the centralized settings surface.
      return { ...normalized, display_name: normalized.assistant_name };
    },
    load: (orgId, branchId) => loadAssistantSettings(orgId, branchId) as unknown as Promise<JsonObject>,
    save: async (orgId, branchId, value) => {
      const merged = { ...value, assistant_name: cleanText((value as JsonObject).assistant_name || (value as JsonObject).display_name) };
      return await saveAssistantSettings(orgId, branchId, merged) as unknown as JsonObject;
    }
  },
  async prepare(run) {
    const capabilities = await effectiveCapabilities(run.orgId).catch(() => null);
    const effective = asObject(asObject(capabilities).effectiveByKey);
    run.scratch.actionsAllowed = effective["assistant.actions"] === true;
    run.scratch.messagingAllowed = effective["assistant.messaging"] === true;
  },
  async systemPrompt(run) {
    let orgName = "";
    try {
      const record = asObject(await readOrganization(run.orgId));
      orgName = cleanText(asObject(record.data).name || record.name);
    } catch {}
    const current = settings(run);
    const abilities = [
      `- Take actions (tasks, stages, scheduling, events): ${actionsAllowed(run) ? "ALLOWED" : "OFF"}`,
      `- Post project notes: ${run.scratch.actionsAllowed === true && current.allow_notes ? "ALLOWED" : "OFF"}`,
      `- Send customer messages: ${messagingAllowed(run) ? "ALLOWED (only after explicit confirmation)" : "OFF"}`
    ].join("\n");
    // App-published instructions (platform/agent_instructions.ts): every
    // enabled app teaches the agent how to use it, so new apps never require
    // editing this prompt.
    const appInstructions = await buildAgentInstructions(run.orgId, run.branchId).catch(() => "");
    return `You are ${current.assistant_name || "the FirstMate Assistant"}, the company-wide AI assistant for "${orgName || "this company"}" on the FirstMate platform. You are talking to ${run.userName || "a team member"} — a business owner, manager, or crew member, not a developer.

${buildAssistantManifest()}

## What you are currently allowed to do
${abilities}

## Working rules
- Look things up with tools — NEVER invent projects, numbers, names, or dates. If a question needs ids or names, call get_workspace_context or search_platform first, and translate ids to names in your reply.
- Answer stats questions by RUNNING QUERIES (run_stats_queries); money comes back in integer cents — divide by 100 and speak in dollars.
- Before any action that is hard to undo (sending a customer message, firing an automation event, canceling work), restate exactly what you are about to do and get an explicit "yes" in the conversation FIRST. Creating a to-do or posting a note does not need confirmation when the customer asked for it.
- When you reference a project, dashboard, or app surface the customer will want to open, attach a button with suggest_navigation.
- If a tool says a permission, capability, or setting blocks an action, say so plainly. Do not try to work around it.
- ALWAYS finish by calling report_result, then give a short, friendly reply in plain language: what you found or what changed. No JSON, no field names, no jargon.${current.custom_instructions ? `\n\n## Company instructions\n${current.custom_instructions}` : ""}

${appInstructions}`;
  },
  tools: TOOLS,
  async revert(run) {
    const reverted: string[] = [];
    for (const nodeId of asArray(run.scratch.createdTaskIds).map(cleanText).filter(Boolean)) {
      try {
        await transitionWorkNode(run.orgId, nodeId, "canceled", { reason: "assistant_run_failed" });
        reverted.push(nodeId);
      } catch {
        // Best effort — report whatever state remains.
      }
    }
    return reverted;
  }
});
