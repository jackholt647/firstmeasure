// Personal agents for the global FirstMate assistant, its main thread, and
// dashboard panels.
//
// An agent is a named, self-scheduled task ("Daily Profit Tracker"). It is an
// agent_schedules row (surface 'assistant') plus its own agent thread
// (subject 'agent:<schedule id>'). That thread holds the configuration chat and
// the history of scheduled runs, so each run remembers earlier ones. The shared
// channel scheduler sweeps due rows on the worker; assistant rows are routed
// here instead of into a channel. Every run's reply is delivered to the user's
// single main thread, pinned panels land on their dashboard, and a push
// notification goes to their devices.

import { MAX_PANELS_PER_TURN, MAX_WIDGETS_PER_PANEL, VISUALIZATION_KINDS, UNITS, normalizeVisualizationWidget, panelEnvelope, panelsFrom } from "../../agents/panels.js";
import { authorizePanelWidget } from "../../agents/platform_tools.js";
import { randomUUID } from "node:crypto";
import { runAgentTurn } from "../../agents/runtime.js";
import { assertAgentWakeupLease, drainAgentWakeups } from "../../agents/wakeups.js";
import {
  appendAgentMessage,
  createAgentSchedule,
  createAgentThread,
  enqueueAgentWakeup,
  getAgentsDatabase,
  listAgentMessages,
  listAgentSchedules,
  listAssistantDashboard,
  pinAssistantDashboardItem,
  readAgentSchedule,
  readAgentThread,
  updateAgentSchedule,
  updateAgentThread
} from "../../agents/storage.js";
import type { AgentRun, AgentTool, AgentTurnResult } from "../../agents/types.js";
import { asArray, asObject, cleanText, nowIso, toolError, type JsonObject } from "../../agents/util.js";
import { nextCronFire, parseScheduleAt } from "../../channels/agent.js";
import { resolveOrganizationTimezone } from "../../platform/timezone.js";
import { env } from "../../src/config/env.js";

export const ASSISTANT_SURFACE = "assistant";
const AGENT_ID = "assistant";
export const MAIN_THREAD_SUBJECT = "main";
export const AGENT_THREAD_PREFIX = "agent:";
const MAX_AGENTS_PER_USER = 20;
const MAX_TITLE_LENGTH = 32;
const MIN_RECURRING_GAP_MS = 15 * 60_000;
const MAX_SCHEDULE_DAYS = 366;
const LISTED_STATUSES = ["active", "paused", "done"];

// ── Schedule wording ────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number) {
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

function ordinal(value: number) {
  const suffix = value % 100 >= 11 && value % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][value % 10] || "th";
  return `${value}${suffix}`;
}

/** Plain-language schedule for the common cron shapes the assistant writes. */
export function describeCron(cron: string) {
  const fields = cleanText(cron).split(/\s+/);
  if (fields.length !== 5) return "Custom schedule";
  const [minuteField = "", hourField = "", dayOfMonth = "", month = "", dayOfWeek = ""] = fields;
  const whole = (value: string) => /^\d+$/.test(value) ? Number(value) : NaN;
  const minute = whole(minuteField);
  const hour = whole(hourField);
  if (Number.isFinite(minute) && Number.isFinite(hour) && month === "*") {
    const at = clock(hour, minute);
    if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${at}`;
    if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${at}`;
    if (dayOfMonth === "*" && ["0,6", "6,0"].includes(dayOfWeek)) return `Weekends at ${at}`;
    if (dayOfMonth === "*" && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
      const days = dayOfWeek.split(",").map((day) => `${DAY_NAMES[Number(day)]}s`);
      return `${days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}` : days[0]} at ${at}`;
    }
    if (/^\d+$/.test(dayOfMonth) && dayOfWeek === "*") return `Monthly on the ${ordinal(Number(dayOfMonth))} at ${at}`;
  }
  if (Number.isFinite(minute) && hourField === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return minute === 0 ? "Every hour" : `Every hour at :${String(minute).padStart(2, "0")}`;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hourField);
  if (Number.isFinite(minute) && hourStep && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every ${hourStep[1]} hours`;
  return "Custom schedule";
}

function describeInstant(iso: string, timezone: string) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function describeAssistantAgent(entry: JsonObject) {
  const kind = cleanText(entry.kind) === "recurring" ? "recurring" : "once";
  const timezone = cleanText(entry.timezone);
  const status = cleanText(entry.status) || "active";
  const cron = cleanText(entry.cron);
  const fireAt = cleanText(entry.fire_at);
  const nextRunAt = status !== "active" ? "" : kind === "recurring" ? nextCronFire(cron, timezone) : fireAt;
  return {
    id: cleanText(entry.id),
    title: cleanText(entry.title) || "Untitled agent",
    summary: cleanText(entry.summary),
    instructions: cleanText(entry.instructions),
    kind,
    status,
    schedule_label: kind === "recurring" ? describeCron(cron) : `Once on ${describeInstant(fireAt, timezone)}`,
    cron,
    fire_at: fireAt,
    timezone,
    next_run_at: nextRunAt,
    next_run_label: describeInstant(nextRunAt, timezone),
    last_run_at: cleanText(entry.last_run_at),
    last_run_status: cleanText(entry.last_run_status),
    last_result: cleanText(entry.last_result),
    run_count: Number(entry.fire_count || 0),
    thread_id: cleanText(entry.origin_thread_id),
    created_at: cleanText(entry.created_at),
    updated_at: cleanText(entry.updated_at)
  };
}

// ── Main thread ─────────────────────────────────────────────────────────────

/** Each user has exactly one main thread; automated agent results always post there. */
export async function ensureAssistantMainThread(orgId: string, userId: string, branchId = "default") {
  const owner = cleanText(userId);
  return asObject(await getAgentsDatabase().transaction(async db => {
    const existing = await db.prepare(`SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND created_by_user_id=? AND subject_id=?
      ORDER BY created_at ASC LIMIT 1`).get(AGENT_ID, orgId, owner, MAIN_THREAD_SUBJECT);
    if (existing) return asObject(existing);
    return await createAgentThread({
      agent_id: AGENT_ID, organization_id: orgId, branch_id: cleanText(branchId) || "default",
      subject_id: MAIN_THREAD_SUBJECT, title: "Main thread", created_by_user_id: owner
    });
  }, "main-thread"));
}

// ── Ownership ───────────────────────────────────────────────────────────────

export async function readOwnedAssistantAgent(orgId: string, userId: string, agentId: string) {
  const entry = await readAgentSchedule(cleanText(agentId));
  if (!entry
    || cleanText(entry.organization_id) !== orgId
    || cleanText(entry.agent_id) !== AGENT_ID
    || cleanText(entry.surface) !== ASSISTANT_SURFACE
    || cleanText(entry.created_by_user_id) !== cleanText(userId)
    || cleanText(entry.status) === "cancelled") return null;
  return entry;
}

export async function listAssistantAgents(orgId: string, userId: string) {
  const rows = await listAgentSchedules(AGENT_ID, orgId, {
    surface: ASSISTANT_SURFACE, created_by_user_id: cleanText(userId), statuses: LISTED_STATUSES, limit: 100
  });
  return rows.map(describeAssistantAgent).reverse();
}

/** The configuration chat hides scheduled-run exchanges; they are shown as run history instead. */
export async function readAssistantAgentDetail(orgId: string, userId: string, agentId: string) {
  const entry = await readOwnedAssistantAgent(orgId, userId, agentId);
  if (!entry) return null;
  const messages = (await listAgentMessages(AGENT_ID, orgId, cleanText(entry.origin_thread_id), { limit: 200 })).map(asObject);
  const conversation: JsonObject[] = [];
  const runs: JsonObject[] = [];
  let inRun = false;
  for (const message of messages) {
    const data = asObject(message.data);
    const role = cleanText(message.role);
    if (role === "user") inRun = cleanText(data.kind) === "agent_run";
    if (inRun && role === "user") continue;
    if (inRun && role === "assistant") {
      runs.push({ id: cleanText(message.id), created_at: cleanText(message.created_at), status: cleanText(data.status), content: String(message.content || "") });
      continue;
    }
    conversation.push(message);
  }
  return { agent: describeAssistantAgent(entry), messages: conversation, runs: runs.reverse().slice(0, 10) };
}

// ── Scheduling inputs ───────────────────────────────────────────────────────

async function resolveSchedule(orgId: string, branchId: string, args: JsonObject) {
  const at = cleanText(args.at);
  const cron = cleanText(args.cron);
  if (at && cron) return { error: "Provide only one of 'at' (one-time) or 'cron' (recurring)." };
  if (!at && !cron) return { none: true as const };
  const timezone = await resolveOrganizationTimezone(orgId, branchId);
  if (at) {
    const fireMs = parseScheduleAt(at, timezone);
    if (!Number.isFinite(fireMs)) return { error: "Could not parse 'at'. Write the company's wall-clock time as 'YYYY-MM-DDTHH:MM'." };
    if (fireMs < Date.now() + 30_000) return { error: `'at' must be in the future. It is currently ${new Date().toISOString()} UTC (${timezone} locally).` };
    if (fireMs > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) return { error: `'at' must be within the next ${MAX_SCHEDULE_DAYS} days.` };
    return { kind: "once" as const, fire_at: new Date(fireMs).toISOString(), cron: "", timezone };
  }
  const next = nextCronFire(cron, timezone);
  if (!next) return { error: "That cron expression is invalid or never fires. Use 5 fields: minute hour day-of-month month day-of-week." };
  const following = nextCronFire(cron, timezone, new Date(next));
  if (following && Date.parse(following) - Date.parse(next) < MIN_RECURRING_GAP_MS) {
    return { error: "Agents can run at most every 15 minutes. Choose a less frequent schedule." };
  }
  return { kind: "recurring" as const, fire_at: "", cron, timezone };
}

function cleanTitle(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ");
}

function ownerOnly(run: AgentRun) {
  return run.ctx && run.userId ? true : "Agents belong to a signed-in user and are unavailable here.";
}

// ── panels ───────────────────────────────────────────────────────────────

/** panels from a finished turn go onto the owner's dashboard beside the chat. */
export async function pinTurnPanels(orgId: string, userId: string, threadId: string, result: AgentTurnResult, sourcePrefix = "") {
  const message = asObject(result.assistant_message);
  const messageId = cleanText(message.id);
  const panels = panelsFrom(result.renders);
  for (const [index, panel] of panels.entries()) {
    const key = cleanText(panel.key) || String(index);
    await pinAssistantDashboardItem(orgId, userId, {
      source_key: sourcePrefix ? `${sourcePrefix}:${key}` : `message:${messageId}:${key}`,
      thread_id: threadId, message_id: messageId, panel
    });
  }
  return panels.length ? await listAssistantDashboard(orgId, userId) : null;
}

// ── Tools ───────────────────────────────────────────────────────────────────

const scheduleParameters = {
  at: { type: "string", description: "One-time run as a wall-clock date-time in the COMPANY'S OWN timezone, e.g. '2026-07-30T18:00'. Do not add an offset or convert timezones. Provide at or cron, not both." },
  cron: { type: "string", description: "Recurring 5-field cron 'minute hour day-of-month month day-of-week' in the COMPANY'S OWN timezone (no conversion), e.g. '0 11 * * *' = every day at 11:00am, '0 8 * * 1-5' = weekdays at 8:00am, '0 9 * * 1' = Mondays at 9:00am. Minimum spacing is 15 minutes." }
};

export const assistantAgentTools: AgentTool[] = [
  {
    name: "create_agent",
    description: "Create a personal agent: a named task that runs on its own schedule (recurring via cron, or once via at) and delivers its result to the user's main thread with a push notification. Use for requests like 'every morning tell me yesterday's profit', 'remind me Friday at 3', 'check this every Monday'. Do not use for something the user wants answered right now.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: `Short Title Case name that fits a narrow sidebar, at most ${MAX_TITLE_LENGTH} characters, e.g. 'Daily Profit Tracker', 'Permit Watch', 'Friday Payroll Reminder'.` },
        summary: { type: "string", description: "One plain sentence for the user describing what the agent does and when, e.g. 'Reports yesterday's profit every morning at 11 AM.'" },
        instructions: { type: "string", description: "Instructions for each future run, written to your future self: exactly what to look up (tools, date ranges relative to the run time), how to present it, and when to stop. Say to lead with a one-line headline and to use present_panel for numbers." },
        ...scheduleParameters
      },
      required: ["title", "summary", "instructions"],
      additionalProperties: false
    },
    gate: ownerOnly,
    async execute(run, args) {
      const title = cleanTitle(args.title);
      if (!title) return toolError("title is required.");
      if (title.length > MAX_TITLE_LENGTH) return toolError(`title must be at most ${MAX_TITLE_LENGTH} characters so it fits the sidebar.`);
      const summary = cleanText(args.summary).slice(0, 280);
      const instructions = cleanText(args.instructions).slice(0, 4000);
      if (!summary || !instructions) return toolError("summary and instructions are required.");
      const schedule = await resolveSchedule(run.orgId, run.branchId, args);
      if ("error" in schedule) return toolError(String(schedule.error));
      if ("none" in schedule) return toolError("Provide a schedule: 'cron' for recurring or 'at' for one time.");
      const existing = await listAgentSchedules(AGENT_ID, run.orgId, {
        surface: ASSISTANT_SURFACE, created_by_user_id: run.userId, statuses: ["active", "paused"], limit: MAX_AGENTS_PER_USER
      });
      if (existing.length >= MAX_AGENTS_PER_USER) return toolError(`This user already has ${MAX_AGENTS_PER_USER} agents. Delete or finish one first.`);
      const thread = asObject(await createAgentThread({
        agent_id: AGENT_ID, organization_id: run.orgId, branch_id: run.branchId,
        subject_id: `${AGENT_THREAD_PREFIX}pending`, title, created_by_user_id: run.userId
      }));
      const entry = asObject(await createAgentSchedule({
        agent_id: AGENT_ID, organization_id: run.orgId, branch_id: run.branchId,
        origin_thread_id: cleanText(thread.id), created_by_user_id: run.userId,
        surface: ASSISTANT_SURFACE, title, summary, instructions,
        kind: schedule.kind, fire_at: schedule.fire_at, cron: schedule.cron, timezone: schedule.timezone
      }));
      const agentId = cleanText(entry.id);
      await updateAgentThread(AGENT_ID, run.orgId, cleanText(thread.id), { subject_id: `${AGENT_THREAD_PREFIX}${agentId}` });
      const agent = describeAssistantAgent(entry);
      await appendAgentMessage(AGENT_ID, run.orgId, cleanText(thread.id), {
        role: "assistant",
        content: `I'm set up. ${summary}\n\nSchedule: ${agent.schedule_label} (${agent.timezone}). Tell me here if you want to change what I do or when.`,
        data: { status: "success", kind: "agent_created" }
      });
      run.changeLog.push(`Created the agent "${title}" (${agent.schedule_label}).`);
      run.actions.push({ kind: "agent", agent_id: agentId, label: title });
      return { ok: true, agent_id: agentId, title, schedule: agent.schedule_label, timezone: agent.timezone, next_run_at: agent.next_run_at };
    }
  },
  {
    name: "list_agents",
    description: "List this user's agents (scheduled and recurring tasks) with their schedules, status and latest result. Use before creating one to avoid duplicates, and to find an agent_id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    gate: ownerOnly,
    async execute(run) {
      return { ok: true, agents: await listAssistantAgents(run.orgId, run.userId) };
    }
  },
  {
    name: "update_agent",
    description: "Change one of this user's agents: rename it, change what it does (instructions and summary), change when it runs (cron or at), or pause/resume it (status 'paused' or 'active'). Only include fields that change. When instructions change, rewrite them completely.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        title: { type: "string", description: `At most ${MAX_TITLE_LENGTH} characters.` },
        summary: { type: "string" },
        instructions: { type: "string" },
        status: { type: "string", enum: ["active", "paused"] },
        ...scheduleParameters
      },
      required: ["agent_id"],
      additionalProperties: false
    },
    gate: ownerOnly,
    async execute(run, args) {
      const entry = await readOwnedAssistantAgent(run.orgId, run.userId, cleanText(args.agent_id));
      if (!entry) return toolError("No such agent for this user.");
      const patch: JsonObject = {};
      if (args.title !== undefined) {
        const title = cleanTitle(args.title);
        if (!title || title.length > MAX_TITLE_LENGTH) return toolError(`title must be 1-${MAX_TITLE_LENGTH} characters.`);
        patch.title = title;
      }
      if (args.summary !== undefined) patch.summary = cleanText(args.summary).slice(0, 280);
      if (args.instructions !== undefined) {
        const instructions = cleanText(args.instructions).slice(0, 4000);
        if (!instructions) return toolError("instructions cannot be empty.");
        patch.instructions = instructions;
      }
      const schedule = await resolveSchedule(run.orgId, run.branchId, args);
      if ("error" in schedule) return toolError(String(schedule.error));
      if (!("none" in schedule)) {
        Object.assign(patch, { kind: schedule.kind, cron: schedule.cron, fire_at: schedule.fire_at, last_fired_at: nowIso() });
        if (cleanText(entry.status) === "done") patch.status = "active";
      }
      const status = cleanText(args.status);
      if (status === "paused") patch.status = "paused";
      if (status === "active") {
        patch.status = "active";
        // Resuming must not replay occurrences missed while paused.
        if (cleanText(entry.status) !== "active") patch.last_fired_at = nowIso();
      }
      if (!Object.keys(patch).length) return toolError("Nothing to change.");
      const updated = describeAssistantAgent(asObject(await updateAgentSchedule(cleanText(entry.id), patch)));
      if (patch.title) await updateAgentThread(AGENT_ID, run.orgId, cleanText(entry.origin_thread_id), { title: cleanText(patch.title) });
      run.changeLog.push(`Updated the agent "${updated.title}"${patch.status ? ` (${updated.status})` : ""}.`);
      return { ok: true, agent: updated };
    }
  },
  {
    name: "delete_agent",
    description: "Permanently stop one of this user's agents. Past results stay in the main thread. Confirm first unless the user clearly asked to delete it, or it is the agent you are running as and its task is complete.",
    parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"], additionalProperties: false },
    gate: ownerOnly,
    async execute(run, args) {
      const entry = await readOwnedAssistantAgent(run.orgId, run.userId, cleanText(args.agent_id));
      if (!entry) return toolError("No such agent for this user.");
      await updateAgentSchedule(cleanText(entry.id), { status: "cancelled" });
      run.changeLog.push(`Deleted the agent "${cleanText(entry.title)}".`);
      return { ok: true, agent_id: cleanText(entry.id), status: "cancelled" };
    }
  },
  {
    name: "run_agent_now",
    description: "Queue one of this user's agents to run immediately (a test run), in addition to its schedule. The result arrives in the main thread within about a minute.",
    parameters: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"], additionalProperties: false },
    gate: ownerOnly,
    async execute(run, args) {
      const entry = await readOwnedAssistantAgent(run.orgId, run.userId, cleanText(args.agent_id));
      if (!entry) return toolError("No such agent for this user.");
      await queueAssistantAgentRun(entry);
      run.changeLog.push(`Queued a test run of "${cleanText(entry.title)}".`);
      return { ok: true, queued: true, note: "The result will appear in the main thread within about a minute." };
    }
  },
  {
    name: "present_panel",
    description: "Present a chat panel containing one to six widgets: registered platform widgets, charts, metrics, tables or text. A panel is UI; an artifact is a published digital object. Use platform_widgets to discover registered widgets. Money values use dollars and unit currency. A stable key replaces this agent's previous panel on the dashboard.",
    parameters: { type: "object", properties: {
      title: { type: "string" }, subtitle: { type: "string" }, key: { type: "string" },
      widgets: { type: "array", minItems: 1, maxItems: MAX_WIDGETS_PER_PANEL, items: {
        type: "object", properties: {
          type: { type: "string", enum: ["visualization", "platform_widget"] },
          title: { type: "string" },
          widget: { type: "object", properties: { id: { type: "string" }, version: { type: "string" }, target: { type: "object" }, config: { type: "object" } }, required: ["id", "version", "target"], additionalProperties: false },
        kind: { type: "string", enum: VISUALIZATION_KINDS },
        unit: { type: "string", enum: UNITS },
        currency: { type: "string", description: "ISO currency code; defaults to USD." },
        labels: { type: "array", items: { type: "string" }, description: "Category or date labels for charts." },
        series: { type: "array", items: { type: "object", properties: { name: { type: "string" }, values: { type: "array", items: { type: "number" } } } }, description: "One entry per series; values align with labels. Pie/donut use exactly one series." },
        metrics: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, delta: { type: "string", description: "Signed change with its comparison, e.g. '+12% vs prior day'." }, trend: { type: "string", enum: ["up", "down", "flat"] }, good: { type: "string", enum: ["up", "down"], description: "Which direction is good for this metric." } } } },
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array", items: {} } },
        text: { type: "string", description: "Markdown for a text note." }
        }, required: ["type"], additionalProperties: false
      } }
    }, required: ["title", "widgets"], additionalProperties: false },
    async execute(run, args) {
      if (panelsFrom(run.renders).length >= MAX_PANELS_PER_TURN) return toolError(`At most ${MAX_PANELS_PER_TURN} panels per reply.`);
      if (!cleanText(args.title)) return toolError("title is required.");
      const raw = asArray(args.widgets);
      if (!raw.length || raw.length > MAX_WIDGETS_PER_PANEL) return toolError(`A panel needs one to ${MAX_WIDGETS_PER_PANEL} widgets.`);
      const widgets: JsonObject[] = [];
      for (const value of raw) {
        const child = asObject(value);
        if (child.type === "platform_widget") widgets.push(await authorizePanelWidget(run, asObject(child.widget)));
        else if (child.type === "visualization") {
          const normalized = normalizeVisualizationWidget({ ...child, title: child.title || args.title });
          if (typeof normalized === "string") return toolError(normalized);
          widgets.push(normalized);
        } else return toolError("Unknown panel widget type.");
      }
      const panel = panelEnvelope(args, widgets);
      run.renders.push(panel);
      return { ok: true, panel_id: panel.id, status: "presentation_requested", note: "Panel queued beside the chat; the browser reports widget loading errors." };
    }
  }
];

export const assistantAgentInstructions = `## Agents, scheduling and the main thread
- The user has one main thread plus side chats. You can create personal agents: named tasks that run on their own schedule. Each run's result is posted to the user's main thread and sent as a push notification to the FirstMate app on their phone.
- When the user asks for anything recurring or later ("every morning at 11 tell me how yesterday went", "remind me Friday", "watch this every Monday"), create an agent with create_agent right away when the request is clear. Give it a short Title Case name that fits a narrow sidebar (e.g. "Daily Profit Tracker"). Then confirm in one or two sentences what it will do and when (with the timezone), and offer a test run with run_agent_now.
- Delivery is the main thread plus a push notification. If they ask for a text message (SMS), explain that agents notify through FirstMate push notifications and the main thread, then set it up that way.
- Write agent instructions so each run is self-sufficient: which tools and date ranges to use relative to the run time (for example "yesterday" in the company timezone), a one-line headline first (it becomes the notification), a present_panel panel containing a chart widget for the numbers with a stable key, and a brief comparison with the previous run when useful.
- Use list_agents before creating one to avoid duplicates. Use update_agent to change an agent's name, behavior, schedule, or to pause and resume it, and delete_agent to stop it.
- Use present_panel with visualization widgets to show numbers visually on the dashboard beside the chat. Do not repeat every number in the text: state the headline and refer to the chart.`;

// ── Configuration conversations ─────────────────────────────────────────────

export function agentIdFromSubject(subjectId: unknown) {
  const subject = cleanText(subjectId);
  return subject.startsWith(AGENT_THREAD_PREFIX) ? subject.slice(AGENT_THREAD_PREFIX.length) : "";
}

/** Extra context when the user talks to an agent's configuration chat. */
export async function agentConfigurationTurnNote(orgId: string, userId: string, thread: JsonObject) {
  const entry = await readOwnedAssistantAgent(orgId, userId, agentIdFromSubject(thread.subject_id));
  if (!entry) return "";
  const agent = describeAssistantAgent(entry);
  return `\n\n(This is the configuration chat for the user's agent "${agent.title}" (agent_id ${agent.id}). Current setup:
- Summary: ${agent.summary}
- Schedule: ${agent.schedule_label} (${agent.timezone}); status ${agent.status}
- Instructions for each run: ${agent.instructions}
When the user asks to change what it does or when it runs, call update_agent with agent_id ${agent.id} (rewrite the instructions in full and refresh the summary). Keep replies short and confirm the new setup in a sentence.)`;
}

// ── Scheduled runs ──────────────────────────────────────────────────────────

export async function queueAssistantAgentRun(entry: JsonObject) {
  const firedAt = nowIso();
  return await enqueueAgentWakeup(`schedule:${cleanText(entry.id)}:manual:${firedAt}`, "assistant_agent", entry, {
    recurring: cleanText(entry.kind) === "recurring", firedAt, manual: true
  });
}

function headline(text: string) {
  const line = String(text || "").split(/\r?\n/).map((part) => part.replace(/[#*_`>]/g, "").replace(/^[-•]\s*/, "").trim()).find(Boolean) || "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runWhenIdle(input: Parameters<typeof runAgentTurn>[1]) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runAgentTurn(AGENT_ID, input);
    } catch (error) {
      const code = cleanText((error as { code?: string }).code);
      if (code !== "agent_thread_busy" || attempt >= 6) throw error;
      await wait(10_000);
      assertAgentWakeupLease();
    }
  }
}

/** Wakeup job handler for surface 'assistant' schedules. Runs on the worker. */
export async function runAssistantAgentJob(record: JsonObject, event: JsonObject): Promise<void | "cancelled"> {
  const current = await readAgentSchedule(cleanText(record.id));
  if (!current || cleanText(current.status) === "cancelled") return "cancelled";
  const manual = event.manual === true;
  if (!manual && cleanText(current.status) === "paused") return "cancelled";
  const orgId = cleanText(current.organization_id);
  const userId = cleanText(current.created_by_user_id);
  const branchId = cleanText(current.branch_id) || "default";
  const { isCapabilityEnabled } = await import("../../platform/capabilities.js");
  if (!await isCapabilityEnabled(orgId, "apps.assistant")) return "cancelled";
  const agentThreadId = cleanText(current.origin_thread_id);
  if (!userId || !agentThreadId || !await readAgentThread(AGENT_ID, orgId, agentThreadId)) {
    await updateAgentSchedule(cleanText(current.id), { status: "cancelled" });
    return "cancelled";
  }
  // The platform worker process may not have loaded the assistant declaration yet.
  await import("./definition.js");
  const { backgroundAuthContext, can } = await import("../../platform/auth.js");
  const ctx = await backgroundAuthContext(orgId, userId);
  if (!await can(ctx, "apps.assistant")) return "cancelled";
  assertAgentWakeupLease();

  const agent = describeAssistantAgent(current);
  const firedAt = cleanText(event.firedAt) || nowIso();
  const message = `[${manual ? "Test run" : "Scheduled run"} of "${agent.title}" at ${describeInstant(firedAt, agent.timezone)} (${agent.timezone})]\n\n${agent.instructions}`;
  const turnNote = `\n\n(You are the user's agent "${agent.title}" (agent_id ${agent.id}), running on its own${manual ? " as a test the user requested" : ` on schedule: ${agent.schedule_label}`}. Nobody is waiting in this chat. Do the work now with your tools. Your final reply is delivered to the user's main thread and its first line becomes a push notification, so open with a one-line headline, then brief detail. Use present_panel${agent.id ? ` with a stable key` : ""} when numbers are involved. ${agent.kind === "once" ? "This is a one-time agent." : "If the task is permanently complete or no longer makes sense, you may pause it with update_agent."})`;
  const result = await runWhenIdle({
    orgId, branchId, threadId: agentThreadId, message, ctx,
    actorUserId: userId, actorName: cleanText(asObject(ctx.user).name),
    input: { kind: "agent_run", agent_id: agent.id, manual }, turnNote
  });
  assertAgentWakeupLease();

  const reply = cleanText(asObject(result.assistant_message).content);
  const failed = result.status === "failed";
  const main = await ensureAssistantMainThread(orgId, userId, branchId);
  const mainThreadId = cleanText(main.id);
  const panels = panelsFrom(result.renders);
  const delivered = asObject(await appendAgentMessage(AGENT_ID, orgId, mainThreadId, {
    role: "assistant",
    content: reply || (failed ? `${agent.title} couldn't finish this run.` : "Done."),
    data: {
      status: failed ? "failed" : "success", source: "agent", agent_id: agent.id, agent_title: agent.title, manual,
      renders: panels, actions: result.actions, changes: result.changes
    }
  }));
  for (const [index, panel] of panels.entries()) {
    await pinAssistantDashboardItem(orgId, userId, {
      source_key: `agent:${agent.id}:${cleanText(panel.key) || index}`,
      thread_id: mainThreadId, message_id: cleanText(delivered.id), panel: { ...panel, source_label: agent.title }
    });
  }
  const summary = headline(reply);
  await updateAgentSchedule(agent.id, { last_run_at: nowIso(), last_run_status: failed ? "failed" : "success", last_result: summary });
  try {
    const { createPlatformNotification } = await import("../../platform/api.js");
    await createPlatformNotification(orgId, {
      id: `assistant_agent_${cleanText(delivered.id)}`,
      title: failed ? `${agent.title} needs attention` : agent.title,
      body: summary || (failed ? "This run could not finish." : "New update in your main thread."),
      kind: "assistant",
      source: "assistant_agent",
      channel: "passive",
      push: true,
      manual_dismissible: true,
      branch_id: branchId,
      target_user_ids: [userId],
      frontend_action: { kind: "open_assistant", thread_id: mainThreadId, message_id: cleanText(delivered.id), agent_id: agent.id }
    });
  } catch {
    /* The main-thread delivery above is the durable result. */
  }
}

// ── Dedicated lane ──────────────────────────────────────────────────────────

let laneRunning = false;
let laneTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Every process that serves the assistant and can reach the model runs this
 * lane, so agents work where no platform worker is installed. Schedule and job
 * claims are transactional, so several web replicas and a platform worker can
 * all run it without duplicating an occurrence.
 */
export function startAssistantAgentLane(log?: { warn: (value: unknown, message?: string) => void }) {
  if (laneTimer || env.isTest || process.env.ASSISTANT_AGENT_LANE_DISABLED === "1" || !cleanText(env.openaiApiKey)) return false;
  laneTimer = setInterval(() => {
    void runAssistantAgentLane().catch((error) => log?.warn({ err: error }, "Assistant agent lane failed."));
  }, 15_000);
  laneTimer.unref?.();
  return true;
}

/** Sweeps and runs only personal assistant agents; dormant Channels wakeups are left alone. */
export async function runAssistantAgentLane(now = new Date(), limit = 3) {
  if (laneRunning) return { queued: 0, handled: 0, skipped: true };
  laneRunning = true;
  try {
    const { sweepAgentSchedules } = await import("../../channels/agent.js");
    const queued = await sweepAgentSchedules(now, { surface: ASSISTANT_SURFACE });
    const handled = await drainAgentWakeups(async (job) => {
      const payload = asObject(job.payload);
      return await runAssistantAgentJob(asObject(payload.record), asObject(payload.event));
    }, limit, "assistant_agent");
    await reportInterruptedAssistantRuns();
    return { queued, handled, skipped: false };
  } finally {
    laneRunning = false;
  }
}

/** An interrupted run is reported in the owner's main thread instead of being replayed. */
async function reportInterruptedAssistantRuns() {
  const db = getAgentsDatabase();
  const rows = await db.prepare("SELECT * FROM agent_wakeup_jobs WHERE kind='assistant_agent' AND state='uncertain' AND notified_at='' ORDER BY updated_at LIMIT 10").all();
  for (const row of rows) {
    const record = asObject(asObject(JSON.parse(cleanText(row.payload_json) || "{}")).record);
    const orgId = cleanText(row.organization_id);
    const userId = cleanText(record.created_by_user_id);
    if (userId) {
      const main = await ensureAssistantMainThread(orgId, userId, cleanText(record.branch_id) || "default");
      await appendAgentMessage(AGENT_ID, orgId, cleanText(main.id), {
        role: "assistant",
        content: `${cleanText(record.title) || "An agent"} was interrupted before it could confirm it finished. Check anything it may already have done before running it again.`,
        data: { status: "failed", source: "agent", agent_id: cleanText(record.id), agent_title: cleanText(record.title) }
      });
    }
    await db.prepare("UPDATE agent_wakeup_jobs SET notified_at=? WHERE id=?").run(nowIso(), cleanText(row.id));
  }
}
