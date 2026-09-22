import { drainAgentWakeups, assertAgentWakeupLease } from "../agents/wakeups.js";
import { platformBackgroundAllowed } from "../platform/runtime.js";
// AI agents as channels teammates. An @-mention in any channel (including
// project-notes channels) or any message in a DM with an agent wakes it; it
// answers with the full assistant tool surface — running AS the triggering
// user, so their permission set applies — and posts its reply back into the
// channel (top-level after notes; threaded when the trigger was threaded).
//
// The agent can also reach out itself: the send_dm tool finds/creates a DM
// with a teammate, and an optional await-reply window records that the agent
// is waiting. The reply (any DM message from the target) re-opens the ORIGIN
// conversation thread so the agent can relay the answer back to whoever asked;
// the timeout scheduler nudges the target once, then reports back that no
// answer came.
//
// Beyond awaits, the agent can schedule FUTURE INSTANCES of itself: the
// schedule_wakeup tool stores instructions plus either a one-time fire time
// or a recurring cron, and the same scheduler re-enters the origin
// conversation when due — full history included — so "send me the numbers at
// 6" or "check on this every Tuesday" just work. Recurring schedules run
// until cancel_wakeup (which the woken instance itself can call once the
// underlying task is done).

import type { PlatformAuthContext } from "../platform/auth.js";
import { runAgentTurn } from "../agents/runtime.js";
import type { AgentTool } from "../agents/types.js";
import {
  advanceAgentAwait,
  enqueueAgentWakeup,
  getAgentsDatabase,
  claimDueOnceAgentSchedule,
  claimRecurringAgentScheduleFire,
  createAgentAwait,
  createAgentSchedule,
  createAgentThread,
  listActiveRecurringAgentSchedules,
  listAgentSchedules,
  listAgentThreads,
  listDueAgentAwaits,
  listDueOnceAgentSchedules,
  listOpenAwaitsForDmChannel,
  readAgentSchedule,
  readAgentThread,
  resetStuckAgentThreads,
  updateAgentAwait,
  updateAgentSchedule
} from "../agents/storage.js";
import { cronMatches, latestCronFire } from "../work/cron.js";
import { resolveOrganizationTimezone, zonedInstant } from "../platform/timezone.js";
import { loadAgentSettings } from "../agents/settings.js";
import {
  agentIdForChannelUser,
  channelUserIdForAgent,
  isAgentChannelUser
} from "../agents/participants.js";
import { asArray, asObject, cleanText, toolError, type JsonObject } from "../agents/util.js";
import {
  listChannelMembers,
  listMessageRecords,
  readChannelRecord,
  readMessageRecord,
  type ChannelRow,
  type MessageRow
} from "./storage.js";
import { ensureAgentDmChannel, postAgentMessage, userDirectory } from "./service.js";

const TRANSCRIPT_MESSAGES = 12;
const MIN_AWAIT_HOURS = 1;
const MAX_AWAIT_HOURS = 24 * 7;
const MIN_SCHEDULE_LEAD_MS = 30_000;
const MAX_SCHEDULE_DAYS = 366;
const MAX_ACTIVE_SCHEDULES_PER_THREAD = 12;

/**
 * First minute strictly after `from` that matches the cron expression in the
 * given timezone, or "" when nothing matches within maxDays (invalid or
 * never-firing expressions).
 */
function nextCronFire(expression: string, timezone: string, from = new Date(), maxDays = MAX_SCHEDULE_DAYS) {
  if (String(expression || "").trim().split(/\s+/).length !== 5) return "";
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const end = from.getTime() + maxDays * 86_400_000;
  for (let minute = start; minute <= end; minute += 60_000) {
    if (cronMatches(expression, new Date(minute), timezone || undefined)) return new Date(minute).toISOString();
  }
  return "";
}

const EXPLICIT_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parse the model's 'at' argument. Wall-clock times (no offset) resolve in
 * the company's timezone so the model never does timezone math itself;
 * explicit offsets are honored as written.
 */
function parseScheduleAt(value: string, timezone: string) {
  if (EXPLICIT_OFFSET_RE.test(value)) return Date.parse(value);
  const match = WALL_CLOCK_RE.exec(value);
  if (!match) return NaN;
  return zonedInstant(
    Number(match[1]), Number(match[2]), Number(match[3]),
    Number(match[4]), Number(match[5]), timezone
  ).getTime();
}

function describeSchedule(entry: JsonObject) {
  const kind = cleanText(entry.kind);
  return {
    schedule_id: cleanText(entry.id),
    kind,
    status: cleanText(entry.status),
    instructions: cleanText(entry.instructions),
    ...(kind === "recurring"
      ? { cron: cleanText(entry.cron), next_fire_at: nextCronFire(cleanText(entry.cron), cleanText(entry.timezone)), fired_so_far: Number(entry.fire_count || 0) }
      : { fires_at: cleanText(entry.fire_at) }),
    timezone: cleanText(entry.timezone) || undefined,
    created_at: cleanText(entry.created_at)
  };
}

// ── Trigger detection ──────────────────────────────────────────────────────

function mentionedAgentId(message: MessageRow): string | null {
  for (const entry of asArray(message.mention_users as unknown)) {
    const id = cleanText(asObject(entry).id || asObject(entry).user_id);
    const agentId = agentIdForChannelUser(id);
    if (agentId) return agentId;
  }
  return null;
}

async function dmAgentId(channel: ChannelRow): Promise<string | null> {
  if (channel.type !== "dm" && channel.type !== "group_dm") return null;
  for (const member of (await listChannelMembers(channel.id))) {
    const agentId = agentIdForChannelUser(member.user_id);
    if (agentId) return agentId;
  }
  return null;
}

/**
 * Called (fire-and-forget) from channels postMessage for every user-posted
 * message. Never throws; never blocks the posting path.
 */
export async function maybeTriggerChannelAgent(ctx: PlatformAuthContext, channel: ChannelRow, message: MessageRow) {
  try {
    if (isAgentChannelUser(message.author_id)) return;
    const agentId = mentionedAgentId(message) ?? (await dmAgentId(channel));
    if (!agentId) return;
    await enqueueAgentWakeup(`channel:${message.id}:${agentId}`, "channel", {
      organization_id: ctx.orgId, branch_id: ctx.branchId, agent_id: agentId,
      origin_channel_id: channel.id, message_id: message.id, session_id: ctx.sessionId,
      created_by_user_id: ctx.userId
    });
  } catch {
    /* never disturb the message path */
  }
}

// ── Channel context helpers ────────────────────────────────────────────────

function channelLabel(channel: ChannelRow) {
  if (channel.type === "project") return `the notes feed of a project (project_id: ${cleanText(channel.project_id)})`;
  if (channel.type === "dm") return "a direct-message conversation";
  if (channel.type === "group_dm") return "a group direct-message conversation";
  return `the #${cleanText(channel.name) || "untitled"} channel`;
}

async function channelTranscript(orgId: string, channel: ChannelRow, uptoMessageId: string) {
  const directory = await userDirectory(orgId);
  const messages = (await listMessageRecords(orgId, channel.id, { limit: TRANSCRIPT_MESSAGES + 20 }))
    .filter((message) => !message.deleted_at && message.kind !== "system")
    .slice(-TRANSCRIPT_MESSAGES - 1);
  const lines: string[] = [];
  for (const message of messages) {
    if (message.id === uptoMessageId) continue; // the trigger is the turn's user message
    const author = directory.get(message.author_id);
    const name = isAgentChannelUser(message.author_id) ? "You" : (author?.name || "Teammate");
    lines.push(`${name}: ${cleanText(message.text).slice(0, 500)}`);
  }
  return lines.slice(-TRANSCRIPT_MESSAGES).join("\n");
}

async function ensureChannelThread(agentId: string, orgId: string, branchId: string, channelId: string, authorId: string) {
  const existing = (await listAgentThreads(agentId, orgId, { subject_id: channelId, limit: 1 }));
  const first = existing[0];
  if (first) return cleanText(first.id);
  const thread = (await createAgentThread({
    agent_id: agentId,
    organization_id: orgId,
    branch_id: branchId,
    subject_id: channelId,
    title: `Channel conversation ${channelId}`,
    created_by_user_id: authorId
  }));
  return cleanText(asObject(thread).id);
}

// ── Conversation tools (send_dm + self-scheduling) ─────────────────────────

function buildChannelTools(options: {
  agentId: string;
  orgId: string;
  branchId: string;
  originThreadId: string;
  originChannelId: string;
}): AgentTool[] {
  return [
    {
      name: "send_dm",
      description: "Send a direct message to a TEAMMATE (internal, not a customer). Use when asked to check with someone or pass something on. If you need their answer to finish the request, set await_reply_hours — you'll be woken when they reply (or when the window expires) so you can follow up and report back here.",
      parameters: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "The teammate's user id (from get_workspace_context users)." },
          message: { type: "string" },
          await_reply_hours: { type: "number", description: "Optional. Hours to wait for their reply before you get woken to follow up (1-168)." }
        },
        required: ["user_id", "message"],
        additionalProperties: false
      },
      allowSystem: true,
      async execute(run, args) {
        const targetUserId = cleanText(args.user_id);
        const text = cleanText(args.message);
        if (!targetUserId || !text) return toolError("user_id and message are both required.");
        if (isAgentChannelUser(targetUserId)) return toolError("You cannot DM another AI agent.");
        const directory = await userDirectory(options.orgId);
        const target = directory.get(targetUserId);
        if (!target) return toolError(`No teammate with id '${targetUserId}' exists. Use get_workspace_context to find the right user id.`);

        const agentUserId = channelUserIdForAgent(options.agentId);
        const dmChannel = (await ensureAgentDmChannel(options.orgId, agentUserId, targetUserId));
        await postAgentMessage(options.orgId, cleanText(dmChannel.id), {
          author_id: agentUserId,
          text
        });
        // Make sure the teammate actually notices the DM.
        try {
          const { createPlatformNotification } = await import("../platform/api.js");
          const agentName = directory.get(agentUserId)?.name || "The AI assistant";
          await createPlatformNotification(options.orgId, {
            title: `${agentName} sent you a message`,
            body: text.length > 160 ? `${text.slice(0, 157)}…` : text,
            kind: "mention",
            channel: "passive",
            manual_dismissible: true,
            source: "channels_agent",
            target_user_ids: [targetUserId],
            frontend_action: { kind: "open_channel_message", channel_id: cleanText(dmChannel.id) }
          });
        } catch {
          /* best effort */
        }

        let awaiting = false;
        const awaitHours = Number(args.await_reply_hours);
        if (Number.isFinite(awaitHours) && awaitHours > 0) {
          const hours = Math.min(MAX_AWAIT_HOURS, Math.max(MIN_AWAIT_HOURS, awaitHours));
          (await createAgentAwait({
            agent_id: options.agentId,
            organization_id: options.orgId,
            branch_id: options.branchId,
            origin_thread_id: options.originThreadId,
            origin_channel_id: options.originChannelId,
            dm_channel_id: cleanText(dmChannel.id),
            target_user_id: targetUserId,
            created_by_user_id: run.userId,
            note: text.slice(0, 500),
            timeout_at: new Date(Date.now() + hours * 3_600_000).toISOString()
          }));
          awaiting = true;
        }
        run.changeLog.push(`Sent a DM to ${target.name}${awaiting ? " (waiting for their reply)" : ""}.`);
        return { ok: true, dm_channel_id: dmChannel.id, awaiting_reply: awaiting };
      }
    },
    {
      name: "schedule_wakeup",
      description: "Schedule a future instance of yourself to wake up in THIS conversation and carry out instructions — once at a specific time ('at'), or on a recurring cron schedule ('cron'). Use when asked to do something later ('send me the numbers at 6pm', 'check on this every Tuesday until it's done'). The woken instance re-enters this conversation with its full history plus your instructions, and its reply posts here; it has the same tools you do, so it can DM people, run reports, and cancel its own recurring schedule when the task is complete.",
      parameters: {
        type: "object",
        properties: {
          instructions: { type: "string", description: "What the woken instance should do, written to your future self — include any context it needs beyond this conversation." },
          at: { type: "string", description: "One-time fire time as a plain wall-clock date-time in the COMPANY'S OWN timezone, e.g. '2026-07-30T18:00'. Timezone conversion is automatic — write the clock time the user means and do NOT add a UTC offset or convert anything yourself. Provide exactly one of at / cron." },
          cron: { type: "string", description: "Recurring 5-field cron 'minute hour day-of-month month day-of-week' in the COMPANY'S OWN timezone — no conversion needed (e.g. '0 14 * * *' = every day at 2:00pm their time, '0 9 * * 2' = Tuesdays at 9:00am their time). Provide exactly one of at / cron." }
        },
        required: ["instructions"],
        additionalProperties: false
      },
      allowSystem: true,
      async execute(run, args) {
        const instructions = cleanText(args.instructions);
        if (!instructions) return toolError("instructions is required.");
        const at = cleanText(args.at);
        const cron = cleanText(args.cron);
        if ((at && cron) || (!at && !cron)) return toolError("Provide exactly one of 'at' (one-time) or 'cron' (recurring).");
        const timezone = await resolveOrganizationTimezone(options.orgId, options.branchId);
        const active = (await listAgentSchedules(options.agentId, options.orgId, {
          origin_thread_id: options.originThreadId, status: "active", limit: MAX_ACTIVE_SCHEDULES_PER_THREAD
        }));
        if (active.length >= MAX_ACTIVE_SCHEDULES_PER_THREAD) {
          return toolError(`This conversation already has ${MAX_ACTIVE_SCHEDULES_PER_THREAD} active wakeups. Cancel one with cancel_wakeup first.`);
        }
        const base = {
          agent_id: options.agentId,
          organization_id: options.orgId,
          branch_id: options.branchId,
          origin_thread_id: options.originThreadId,
          origin_channel_id: options.originChannelId,
          created_by_user_id: run.userId,
          instructions: instructions.slice(0, 4000)
        };
        if (at) {
          const fireMs = parseScheduleAt(at, timezone);
          if (!Number.isFinite(fireMs)) return toolError("Could not parse 'at'. Write the wall-clock time in the company's timezone as 'YYYY-MM-DDTHH:MM', e.g. '2026-07-30T18:00'.");
          if (fireMs < Date.now() + MIN_SCHEDULE_LEAD_MS) return toolError(`'at' must be at least a minute in the future — it is currently ${new Date().toISOString()} UTC (${timezone} locally).`);
          if (fireMs > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) return toolError(`'at' must be within the next ${MAX_SCHEDULE_DAYS} days.`);
          const fireAt = new Date(fireMs).toISOString();
          const schedule = asObject((await createAgentSchedule({ ...base, kind: "once", fire_at: fireAt, timezone })));
          run.changeLog.push(`Scheduled a one-time wakeup for ${at} (${timezone}).`);
          return { ok: true, schedule_id: cleanText(schedule.id), kind: "once", fires_at: fireAt, timezone };
        }
        const next = nextCronFire(cron, timezone);
        if (!next) return toolError("That cron expression is invalid or never fires. Use 5 fields: minute hour day-of-month month day-of-week.");
        const schedule = asObject((await createAgentSchedule({ ...base, kind: "recurring", cron, timezone })));
        run.changeLog.push(`Scheduled a recurring wakeup (cron '${cron}', ${timezone}).`);
        return {
          ok: true, schedule_id: cleanText(schedule.id), kind: "recurring", cron, timezone, next_fire_at: next,
          note: "This repeats until cancelled — call cancel_wakeup with this schedule_id once the task is complete or no longer needed."
        };
      }
    },
    {
      name: "list_wakeups",
      description: "List your active scheduled wakeups (one-time and recurring) for this conversation — or across all conversations with all_conversations. Use before scheduling (to avoid duplicates) and to find the schedule_id to cancel.",
      parameters: {
        type: "object",
        properties: {
          all_conversations: { type: "boolean", description: "List active wakeups from every conversation, not just this one." }
        },
        additionalProperties: false
      },
      allowSystem: true,
      async execute(_run, args) {
        const schedules = (await listAgentSchedules(options.agentId, options.orgId, {
          status: "active",
          ...(args.all_conversations === true ? {} : { origin_thread_id: options.originThreadId })
        }));
        return { ok: true, wakeups: schedules.map(describeSchedule) };
      }
    },
    {
      name: "cancel_wakeup",
      description: "Cancel a scheduled wakeup by schedule_id (from schedule_wakeup or list_wakeups). Cancel recurring schedules yourself as soon as their underlying task is complete or no longer needed.",
      parameters: {
        type: "object",
        properties: { schedule_id: { type: "string" } },
        required: ["schedule_id"],
        additionalProperties: false
      },
      allowSystem: true,
      async execute(run, args) {
        const scheduleId = cleanText(args.schedule_id);
        if (!scheduleId) return toolError("schedule_id is required.");
        const schedule = (await readAgentSchedule(scheduleId));
        if (!schedule
          || cleanText(schedule.organization_id) !== options.orgId
          || cleanText(schedule.agent_id) !== options.agentId) {
          return toolError("No such wakeup schedule.");
        }
        if (cleanText(schedule.status) !== "active") {
          return { ok: true, schedule_id: scheduleId, status: cleanText(schedule.status), note: "That schedule was already inactive." };
        }
        (await updateAgentSchedule(scheduleId, { status: "cancelled" }));
        run.changeLog.push("Cancelled a scheduled wakeup.");
        return { ok: true, schedule_id: scheduleId, status: "cancelled" };
      }
    }
  ];
}

// ── Turn execution ─────────────────────────────────────────────────────────

async function runChannelAgentTurn(
  orgId: string,
  branchId: string,
  agentId: string,
  channelId: string,
  messageId: string,
  ctx: PlatformAuthContext | null
) {
  const settings = await loadAgentSettings(agentId, orgId, branchId).catch(() => null);
  if (!settings || settings.enabled === false) return;
  const channel = (await readChannelRecord(orgId, channelId));
  if (!channel) return;
  const trigger = (await readMessageRecord(orgId, messageId));
  if (!trigger || trigger.channel_id !== channelId) return;

  // A reply in a DM the agent was WAITING on re-opens the origin conversation
  // instead of running a plain DM turn — that's where the requester context
  // lives, and the reply there is what reports the answer back.
  const awaits = (await listOpenAwaitsForDmChannel(orgId, channelId))
    .filter((entry) => cleanText(entry.target_user_id) === trigger.author_id);
  if (awaits.length) {
    for (const entry of awaits) {
      await advanceAgentAwait(entry, { status: "resolved" }, {
        kind: "reply",
        text: cleanText(trigger.text),
        authorId: trigger.author_id
      });
    }
    return;
  }

  const directory = await userDirectory(orgId);
  const author = directory.get(trigger.author_id);
  const threadId = (await ensureChannelThread(agentId, orgId, branchId, channelId, trigger.author_id));
  const transcript = await channelTranscript(orgId, channel, messageId);
  const turnNote = [
    "",
    "",
    `(You are participating in ${channelLabel(channel)} on the internal team messaging system, as a teammate. The message above was just posted by ${author?.name || "a teammate"}${mentionedAgentId(trigger) ? " and mentions you" : ""}.`,
    channel.type === "project" ? `Project tools apply to project_id ${cleanText(channel.project_id)} unless the conversation says otherwise.` : "",
    transcript ? `Recent conversation:\n${transcript}` : "",
    "Your final reply text will be posted in this conversation for everyone here to see — keep it brief and conversational, like a capable teammate. If something is unclear, ask a short clarifying question instead of guessing. Do not repeat the request back or narrate tool usage.)"
  ].filter(Boolean).join("\n");

  const result = await runAgentTurn(agentId, {
    orgId,
    branchId,
    threadId,
    message: `${author?.name || "Teammate"}: ${cleanText(trigger.text)}`,
    ctx,
    actorUserId: ctx?.userId || trigger.author_id,
    actorName: author?.name || "",
    subjectId: channelId,
    turnNote,
    extraTools: buildChannelTools({ agentId, orgId, branchId, originThreadId: threadId, originChannelId: channelId })
  });

  assertAgentWakeupLease();
  const replyText = cleanText(asObject(result.assistant_message).content);
  if (!replyText) return;
  await postAgentMessage(orgId, channelId, {
    author_id: channelUserIdForAgent(agentId),
    text: replyText,
    // Threaded trigger → reply in that thread; top-level note → top-level
    // reply after it (globally visible), per the notes UX.
    parent_id: trigger.parent_id || null,
    metadata: { agent_id: agentId, turn_status: result.status }
  });
}

/** Re-open the origin conversation after a DM reply / timeout / expiry. */
async function scheduledAgentContext(orgId: string, agentId: string, threadId: string, channelId: string, authorId = "") {
  const { backgroundAuthContext, can } = await import("../platform/auth.js");
  const { forbidden } = await import("../platform/errors.js");
  const thread = await readAgentThread(agentId, orgId, threadId);
  const ctx = await backgroundAuthContext(orgId, authorId || cleanText(thread?.created_by_user_id));
  if (!await can(ctx, "apps.channels")) throw forbidden("background_author_unavailable", "The task author no longer has access to Channels.");
  if (channelId) {
    const { requireChannelAccess } = await import("./service.js");
    await requireChannelAccess(ctx, channelId);
  }
  return ctx;
}

async function runOriginFollowUp(
  orgId: string,
  branchId: string,
  agentId: string,
  awaitRecord: JsonObject,
  event: { kind: "reply" | "nudge" | "expired"; text?: string; authorId?: string }
) {
  const originThreadId = cleanText(awaitRecord.origin_thread_id);
  const originChannelId = cleanText(awaitRecord.origin_channel_id);
  if (!originThreadId || !(await readAgentThread(agentId, orgId, originThreadId))) return;
  const ctx = await scheduledAgentContext(orgId, agentId, originThreadId, originChannelId, cleanText(awaitRecord.created_by_user_id));
  const directory = await userDirectory(orgId);
  const targetName = directory.get(cleanText(awaitRecord.target_user_id))?.name || "the teammate";

  const message = event.kind === "reply"
    ? `${targetName} replied to your DM: "${cleanText(event.text).slice(0, 1500)}"`
    : event.kind === "nudge"
      ? `You are still waiting on ${targetName} — the reply window passed with no answer. Send them ONE brief, polite nudge with send_dm (do not set a new await; one is already tracked), and post a short status note here so the requester knows.`
      : `${targetName} never replied to your DM, even after a nudge. Let the requester here know you could not get an answer and suggest what they might do instead.`;

  const turnNote = event.kind === "reply"
    ? `\n\n(This is the answer you were waiting on. Thank ${targetName} briefly via send_dm if appropriate, and report the answer back in this conversation for the person who originally asked. Your reply text posts in the ORIGINAL conversation.)`
    : "\n\n(Your reply text posts in the ORIGINAL conversation where the request came from.)";

  const result = await runAgentTurn(agentId, {
    orgId,
    branchId,
    threadId: originThreadId,
    message,
    ctx,
    actorUserId: ctx.userId,
    actorName: cleanText(ctx.user.name),
    subjectId: originChannelId,
    turnNote,
    extraTools: buildChannelTools({ agentId, orgId, branchId, originThreadId, originChannelId })
  });

  assertAgentWakeupLease();
  const replyText = cleanText(asObject(result.assistant_message).content);
  if (replyText && originChannelId && (await readChannelRecord(orgId, originChannelId))) {
    await postAgentMessage(orgId, originChannelId, {
      author_id: channelUserIdForAgent(agentId),
      text: replyText,
      metadata: { agent_id: agentId, await_id: cleanText(awaitRecord.id), await_event: event.kind }
    });
  }
}

/** Wake a future instance in the origin conversation with its instructions. */
async function runScheduledWakeup(schedule: JsonObject, event: { recurring: boolean; firedAt: string }) {
  const orgId = cleanText(schedule.organization_id);
  const branchId = cleanText(schedule.branch_id || "default") || "default";
  const agentId = cleanText(schedule.agent_id);
  const scheduleId = cleanText(schedule.id);
  const originThreadId = cleanText(schedule.origin_thread_id);
  const originChannelId = cleanText(schedule.origin_channel_id);
  if (!originThreadId || !(await readAgentThread(agentId, orgId, originThreadId))) {
    // The origin conversation is gone — retire the schedule instead of
    // sweeping it forever.
    (await updateAgentSchedule(scheduleId, { status: "cancelled" }));
    return;
  }

  const ctx = await scheduledAgentContext(orgId, agentId, originThreadId, originChannelId, cleanText(schedule.created_by_user_id));
  const instructions = cleanText(schedule.instructions);
  const message = event.recurring
    ? `[Scheduled wakeup — recurring] It's time for your recurring task:\n\n${instructions}`
    : `[Scheduled wakeup] It's time for the task you scheduled:\n\n${instructions}`;
  const turnNote = [
    "",
    "",
    "(This is a scheduled wakeup you set for yourself earlier in this conversation — nobody just messaged you. Carry out the instructions now using your tools; your reply text posts in the ORIGINAL conversation where the schedule was created.",
    event.recurring
      ? `This schedule is RECURRING (schedule_id ${scheduleId}, cron '${cleanText(schedule.cron)}', fired ${Number(schedule.fire_count || 0)} time(s) so far). If the underlying task is complete or no longer needed, call cancel_wakeup with that schedule_id so it stops firing.`
      : "This was a one-time schedule; it will not fire again.",
    ")"
  ].filter(Boolean).join("\n");

  const result = await runAgentTurn(agentId, {
    orgId,
    branchId,
    threadId: originThreadId,
    message,
    ctx,
    actorUserId: ctx.userId,
    actorName: cleanText(ctx.user.name),
    subjectId: originChannelId,
    turnNote,
    extraTools: buildChannelTools({ agentId, orgId, branchId, originThreadId, originChannelId })
  });

  assertAgentWakeupLease();
  const replyText = cleanText(asObject(result.assistant_message).content);
  if (!replyText) return;
  if (originChannelId && (await readChannelRecord(orgId, originChannelId))) {
    await postAgentMessage(orgId, originChannelId, {
      author_id: channelUserIdForAgent(agentId),
      text: replyText,
      metadata: { agent_id: agentId, schedule_id: scheduleId, schedule_event: event.recurring ? "recurring_fire" : "once_fire" }
    });
    return;
  }
  // Origin channel deleted (or never existed): the reply still landed in the
  // agent thread — surface it to whoever created the schedule.
  const creatorId = cleanText(schedule.created_by_user_id);
  if (!creatorId) return;
  try {
    const { createPlatformNotification } = await import("../platform/api.js");
    await createPlatformNotification(orgId, {
      title: "Your scheduled task ran",
      body: replyText.length > 160 ? `${replyText.slice(0, 157)}…` : replyText,
      kind: "mention",
      channel: "passive",
      manual_dismissible: true,
      source: "channels_agent",
      target_user_ids: [creatorId]
    });
  } catch {
    /* best effort */
  }
}

// ── Timeout + wakeup scheduler ─────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Fire due self-scheduled wakeups (one-time and recurring). */
export async function sweepAgentSchedules(now = new Date()) {
  let queued = 0;
  for (const entry of await listDueOnceAgentSchedules(now.toISOString())) {
    if (await claimDueOnceAgentSchedule(cleanText(entry.id), now.toISOString())) queued++;
  }
  for (const entry of await listActiveRecurringAgentSchedules()) {
    const after = cleanText(entry.last_fired_at) || cleanText(entry.created_at);
    const fireAt = latestCronFire(cleanText(entry.cron), after, now, cleanText(entry.timezone) || undefined);
    if (fireAt && await claimRecurringAgentScheduleFire(cleanText(entry.id), cleanText(entry.last_fired_at), fireAt)) queued++;
  }
  return queued;
}

export async function sweepAgentAwaits(now = new Date()) {
  let queued = 0;
  for (const entry of await listDueAgentAwaits(now.toISOString())) {
    if (cleanText(entry.status) === "pending") {
      const windowMs = Math.min(MAX_AWAIT_HOURS * 3600000, Math.max(MIN_AWAIT_HOURS * 3600000,
        Date.parse(cleanText(entry.timeout_at)) - Date.parse(cleanText(entry.created_at)) || 24 * 3600000));
      if (await advanceAgentAwait(entry, { status: "nudged", nudged_at: now.toISOString(), timeout_at: new Date(now.getTime()+windowMs).toISOString() }, { kind: "nudge" })) queued++;
    } else if (await advanceAgentAwait(entry, { status: "expired" }, { kind: "expired" })) queued++;
  }
  return queued;
}

/** Shared queue also carries immediate DM/mention turns off clustered web replicas. */
export async function drainChannelAgentJobs() {
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  const count = await drainAgentWakeups(async job => {
    const payload = asObject(job.payload), entry = asObject(payload.record), event = asObject(payload.event);
    const orgId = cleanText(entry.organization_id);
    if (!await isCapabilityEnabled(orgId, "apps.channels")) return "cancelled";
    assertAgentWakeupLease();
    if (job.kind === "schedule") {
      const current = await readAgentSchedule(cleanText(entry.id));
      if (!current || current.status === "cancelled") return "cancelled";
      await runScheduledWakeup(entry, { recurring: event.recurring === true, firedAt: cleanText(event.firedAt) });
    } else if (job.kind === "await") {
      await runOriginFollowUp(orgId, cleanText(entry.branch_id) || "default", cleanText(entry.agent_id), entry,
        { kind: cleanText(event.kind) as "reply" | "nudge" | "expired", text: cleanText(event.text), authorId: cleanText(event.authorId) });
    } else if (job.kind === "channel") {
      const { buildAuthContext, can } = await import("../platform/auth.js");
      const { readAuthSession } = await import("../platform/storage.js");
      const sessionId = cleanText(entry.session_id);
      const session = await readAuthSession(sessionId).catch(() => null);
      if (!session) throw new Error("The requesting user's session ended before this task started.");
      const ctx = await buildAuthContext(sessionId, session);
      if (ctx.orgId !== orgId || !await can(ctx, "apps.channels")) throw new Error("The requesting user no longer has access to Channels.");
      await runChannelAgentTurn(orgId, cleanText(entry.branch_id) || "default", cleanText(entry.agent_id), cleanText(entry.origin_channel_id), cleanText(entry.message_id), ctx);
    }
  });
  const db = getAgentsDatabase();
  for (const job of await db.prepare("SELECT * FROM agent_wakeup_jobs WHERE state='uncertain' AND notified_at='' ORDER BY updated_at LIMIT 20").all()) {
    const entry = asObject(asObject(JSON.parse(cleanText(job.payload_json))).record);
    const channelId = cleanText(entry.origin_channel_id), orgId = cleanText(job.organization_id);
    if (channelId && await readChannelRecord(orgId, channelId)) {
      await postAgentMessage(orgId, channelId, {
        author_id: channelUserIdForAgent(cleanText(entry.agent_id)),
        client_msg_id: `wakeup-interrupted:${job.id}`,
        text: "This task was interrupted before completion could be confirmed. Please check the conversation and any actions already taken before asking me to continue.",
        metadata: { wakeup_job_id: job.id, task_status: "uncertain" }
      });
    } else {
      const thread = await readAgentThread(cleanText(entry.agent_id), orgId, cleanText(entry.origin_thread_id));
      const userId = cleanText(entry.created_by_user_id || thread?.created_by_user_id);
      if (!userId) continue; // Keep visible as unacknowledged until an owner can be found.
      const { createPlatformNotification } = await import("../platform/api.js");
      await createPlatformNotification(orgId, { id: `wakeup_interrupted_${job.id}`, title: "Scheduled task needs review",
        body: "This task stopped before completion could be confirmed. Review any actions already taken before restarting it.",
        kind: "mention", channel: "passive", manual_dismissible: true, source: "channels_agent", target_user_ids: [userId] });
    }
    await db.prepare("UPDATE agent_wakeup_jobs SET notified_at=? WHERE id=?").run(new Date().toISOString(), cleanText(job.id));
  }
  return count;
}

export async function startChannelAgentScheduler() {
  if (!platformBackgroundAllowed()) return;
  if (schedulerTimer) return;
  // A restart kills in-flight turns; un-wedge their threads at boot.
  try { (await resetStuckAgentThreads()); } catch {}
  schedulerTimer = setInterval(() => {
    void sweepAgentAwaits().catch(() => null);
    void sweepAgentSchedules().catch(() => null);
    void drainChannelAgentJobs().catch(() => null);
  }, 60_000);
  schedulerTimer.unref?.();
}

export function stopChannelAgentScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
