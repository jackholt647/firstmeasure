import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-channels-agent-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.OPENAI_API_KEY = "test-openai-key";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { stopChannelAgentScheduler } = await import("../channels/agent.js");
  stopChannelAgentScheduler();
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
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
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Olive Owner",
    company: "Channels Agent Test Co",
    organization_id: `org_chagent_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string, userId: data.user?.id || data.membership?.user_id || "" };
}

function mockOpenAI(script: Array<Record<string, unknown>>) {
  const original = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body || "{}")));
    const payload = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function functionCall(name: string, args: Record<string, unknown>, callId: string) {
  return { type: "function_call", name, arguments: JSON.stringify(args), call_id: callId };
}

function messageOutput(text: string) {
  return { type: "message", content: [{ type: "output_text", text }] };
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    const value = await probe();
    if (value) return value as T;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string) {
  const lead = await client.request("POST", `/v1/platform/organizations/${orgId}/leads`, {
    name: "Nora Notes",
    email: "nora@example.test",
    phone: "+15550001111",
    address: "9 Channel Way",
    source: "manual_lead"
  });
  return String(lead.project?.id || lead.document?.id || "");
}

const AGENT_MENTION = [{ id: "agent_assistant", name: "FirstMate Assistant" }];

function agentMessagesIn(messages: any[]) {
  return (messages || []).filter((message: any) => message.author?.id === "agent_assistant" || message.author_id === "agent_assistant");
}

test("an enabled FirstMate Assistant always has a default direct-message conversation", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const participants = await client.request("GET", `/v1/agents/organizations/${orgId}/participants`);
  assert.equal(participants.participants.length, 1);
  assert.equal(participants.participants[0].id, "agent_assistant");
  assert.ok(participants.participants[0].name.length > 0);

  const firstList = await client.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  const assistantDm = firstList.channels.find((channel: any) =>
    channel.type === "dm" && channel.members.some((member: any) => member.id === "agent_assistant")
  );
  assert.ok(assistantDm, "the enabled assistant has a seeded DM before the user sends a message");
  assert.equal(assistantDm.display_name, participants.participants[0].name);

  const secondList = await client.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  assert.equal(
    secondList.channels.filter((channel: any) =>
      channel.type === "dm" && channel.members.some((member: any) => member.id === "agent_assistant")
    ).length,
    1,
    "reloading Channels does not create duplicate assistant DMs"
  );
});

test("a disabled FirstMate Assistant does not seed a direct-message conversation", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PUT", `/v1/agents/organizations/${orgId}/agents/assistant/settings`, {
    settings: { enabled: false }
  });

  const listed = await client.request("GET", `/v1/channels/organizations/${orgId}/channels`);
  assert.equal(
    listed.channels.some((channel: any) =>
      channel.type === "dm" && channel.members.some((member: any) => member.id === "agent_assistant")
    ),
    false
  );
});

test("@-mentioning the agent in a project channel creates the to-do and posts a visible reply", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = await createProject(client, orgId);
  const channelData = await client.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`, {});
  const channelId = channelData.channel.id as string;

  const mock = mockOpenAI([
    { output: [functionCall("create_task", { title: "Order the dumpster", project_id: projectId }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Added the to-do." }, "call_2"),
        messageOutput("Done — I added \"Order the dumpster\" to this project's to-dos.")
      ]
    },
    { output: [messageOutput("Done — I added \"Order the dumpster\" to this project's to-dos.")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${channelId}/messages`, {
      text: "@FirstMate Assistant can you add a to-do to order the dumpster?",
      mention_users: AGENT_MENTION
    });
    const reply = await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${channelId}/messages?limit=50`);
      return agentMessagesIn(data.messages)[0];
    }, "agent reply in project channel");
    assert.match(String(reply.text), /Order the dumpster/);
    assert.equal(reply.parent_id ?? null, null, "reply is top-level, after the note");
    assert.ok(String(reply.author?.name || "").length > 0);
    assert.notEqual(reply.author?.name, "Unknown", "agent author resolves through the directory");

    const todos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?include_all=1`);
    assert.ok((todos.action_items || []).some((item: any) => item.title === "Order the dumpster"));
    // The turn ran against the shared framework thread for this channel.
    const system = String((mock.calls[0] as any).input[0].content);
    assert.match(system, /FirstMate/);
  } finally {
    mock.restore();
  }
});

test("DMing the agent triggers a reply without a mention", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const dm = await client.request("POST", `/v1/channels/organizations/${orgId}/channels`, {
    type: "dm", name: "", topic: "", member_user_ids: ["agent_assistant"]
  });
  const dmChannelId = dm.channel.id as string;

  const mock = mockOpenAI([
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Said hello." }, "call_1"),
        messageOutput("Hi! Ask me anything about your projects, schedule, or stats.")
      ]
    },
    { output: [messageOutput("Hi! Ask me anything about your projects, schedule, or stats.")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${dmChannelId}/messages`, { text: "hello there" });
    const reply = await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${dmChannelId}/messages?limit=20`);
      return agentMessagesIn(data.messages)[0];
    }, "agent reply in DM");
    assert.match(String(reply.text), /Ask me anything/);
  } finally {
    mock.restore();
  }
});

test("send_dm with an await: reply relays back to the origin channel; timeout nudges then expires", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = await createProject(client, orgId);
  const channelData = await client.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`, {});
  const originChannelId = channelData.channel.id as string;
  const targetUserId = userId || (await client.request("GET", `/v1/platform/organizations/${orgId}/documents/users`)).documents[0].id;

  // Turn 1: the agent DMs the teammate with a 2h await, then reports.
  const mock = mockOpenAI([
    { output: [functionCall("send_dm", { user_id: targetUserId, message: "Quick one — what did you quote for the Nora Notes gutters?", await_reply_hours: 2 }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Asked and waiting." }, "call_2"),
        messageOutput("I've DMed them and will report back when they reply.")
      ]
    },
    { output: [messageOutput("I've DMed them and will report back when they reply.")] }
  ]);
  let dmChannelId = "";
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages`, {
      text: "@FirstMate Assistant can you check what was quoted for the gutters?",
      mention_users: AGENT_MENTION
    });
    await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
      return agentMessagesIn(data.messages).find((message: any) => /report back/.test(message.text));
    }, "origin acknowledgment");

    // The DM channel now exists and holds the agent's question.
    const channels = await client.request("GET", `/v1/channels/organizations/${orgId}/channels`);
    const dm = (channels.channels || []).find((channel: any) => channel.type === "dm");
    assert.ok(dm, "agent DM channel exists");
    dmChannelId = dm.id;
    const dmMessages = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${dmChannelId}/messages?limit=20`);
    assert.ok(agentMessagesIn(dmMessages.messages).some((message: any) => /gutters/.test(message.text)));
  } finally {
    mock.restore();
  }

  // Turn 2: the teammate replies in the DM → the origin conversation re-opens
  // and the agent relays the answer there.
  const relayMock = mockOpenAI([
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Relayed the answer." }, "call_3"),
        messageOutput("They said the gutters were quoted at $2,400 — passing that along!")
      ]
    },
    { output: [messageOutput("They said the gutters were quoted at $2,400 — passing that along!")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${dmChannelId}/messages`, { text: "It was $2,400 all-in." });
    const relay = await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
      return agentMessagesIn(data.messages).find((message: any) => /2,400/.test(message.text));
    }, "relayed answer in origin channel");
    assert.match(String(relay.text), /passing that along/);
  } finally {
    relayMock.restore();
  }

  // The await resolved, so a sweep far in the future does nothing.
  const { sweepAgentAwaits } = await import("../channels/agent.js");
  const noopMock = mockOpenAI([{ output: [messageOutput("(should not run)")] }]);
  try {
    const swept = await sweepAgentAwaits(new Date(Date.now() + 100 * 3_600_000));
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    assert.equal(swept, 0, "resolved awaits are not swept");
  } finally {
    noopMock.restore();
  }
});

test("an unanswered await nudges once, then expires with a report to the requester", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = await createProject(client, orgId);
  const channelData = await client.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`, {});
  const originChannelId = channelData.channel.id as string;
  const targetUserId = userId || (await client.request("GET", `/v1/platform/organizations/${orgId}/documents/users`)).documents[0].id;

  const mock = mockOpenAI([
    { output: [functionCall("send_dm", { user_id: targetUserId, message: "Ping — need the permit number.", await_reply_hours: 1 }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Asked." }, "call_2"),
        messageOutput("Asked for the permit number — I'll follow up.")
      ]
    },
    { output: [messageOutput("Asked for the permit number — I'll follow up.")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages`, {
      text: "@FirstMate Assistant get the permit number please",
      mention_users: AGENT_MENTION
    });
    await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
      return agentMessagesIn(data.messages).find((message: any) => /follow up/.test(message.text));
    }, "origin acknowledgment");
  } finally {
    mock.restore();
  }

  const { sweepAgentAwaits } = await import("../channels/agent.js");

  // First sweep after the window: nudge.
  const nudgeMock = mockOpenAI([
    { output: [functionCall("send_dm", { user_id: targetUserId, message: "Gentle nudge — still need that permit number when you have a sec." }, "call_3")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Nudged." }, "call_4"),
        messageOutput("Still waiting on the permit number — I sent a nudge.")
      ]
    },
    { output: [messageOutput("Still waiting on the permit number — I sent a nudge.")] }
  ]);
  try {
    const swept = await sweepAgentAwaits(new Date(Date.now() + 2 * 3_600_000));
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    assert.equal(swept, 1);
    const origin = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
    assert.ok(agentMessagesIn(origin.messages).some((message: any) => /nudge/.test(message.text)));
  } finally {
    nudgeMock.restore();
  }

  // Second sweep after the re-armed window: expire + report back.
  const expireMock = mockOpenAI([
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Reported no answer." }, "call_5"),
        messageOutput("No luck — they haven't replied about the permit number. You may want to catch them directly.")
      ]
    },
    { output: [messageOutput("No luck — they haven't replied about the permit number. You may want to catch them directly.")] }
  ]);
  try {
    const swept = await sweepAgentAwaits(new Date(Date.now() + 100 * 3_600_000));
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    assert.equal(swept, 1);
    const origin = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
    assert.ok(agentMessagesIn(origin.messages).some((message: any) => /haven't replied/.test(message.text)));
  } finally {
    expireMock.restore();
  }
});

test("schedule_wakeup (one-time): a future instance wakes in the origin conversation and reports", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = await createProject(client, orgId);
  const channelData = await client.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`, {});
  const originChannelId = channelData.channel.id as string;
  // The model writes a plain wall-clock time (no offset); the system resolves
  // it against the company timezone (test orgs fall back to the system zone).
  const target = new Date(Date.now() + 3_600_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const atWallClock = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
  const fireAt = new Date(target.getFullYear(), target.getMonth(), target.getDate(), target.getHours(), target.getMinutes()).toISOString();

  // Turn 1: the agent schedules a one-time wakeup for "tonight".
  const mock = mockOpenAI([
    { output: [functionCall("schedule_wakeup", { instructions: "Post today's job numbers in this conversation.", at: atWallClock }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Scheduled." }, "call_2"),
        messageOutput("Will do — I'll post the numbers here tonight.")
      ]
    },
    { output: [messageOutput("Will do — I'll post the numbers here tonight.")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages`, {
      text: "@FirstMate Assistant before tomorrow starts, post today's numbers here",
      mention_users: AGENT_MENTION
    });
    await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
      return agentMessagesIn(data.messages).find((message: any) => /tonight/.test(message.text));
    }, "scheduling acknowledgment");
  } finally {
    mock.restore();
  }

  const { listAgentSchedules } = await import("../agents/storage.js");
  const active = (await listAgentSchedules("assistant", orgId, { status: "active" })) as any[];
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, "once");
  assert.equal(active[0].fire_at, fireAt, "wall-clock 'at' resolved against the company timezone");
  assert.equal(active[0].timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);

  // The wakeup fires once its time passes; the reply posts in the origin channel.
  const { sweepAgentSchedules } = await import("../channels/agent.js");
  const wakeMock = mockOpenAI([
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Posted the numbers." }, "call_3"),
        messageOutput("Tonight's numbers: 5 estimates sent, 2 signed, $18,400 booked.")
      ]
    },
    { output: [messageOutput("Tonight's numbers: 5 estimates sent, 2 signed, $18,400 booked.")] }
  ]);
  try {
    const fired = await sweepAgentSchedules(new Date(Date.now() + 2 * 3_600_000));
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    assert.equal(fired, 1);
    // The woken instance saw its own instructions in the turn input.
    assert.match(JSON.stringify((wakeMock.calls[0] as any).input), /Post today's job numbers/);
    const origin = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
    assert.ok(agentMessagesIn(origin.messages).some((message: any) => /18,400 booked/.test(message.text)));
  } finally {
    wakeMock.restore();
  }

  assert.equal((await listAgentSchedules("assistant", orgId, { status: "active" })).length, 0);
  assert.equal((await listAgentSchedules("assistant", orgId, { status: "done" })).length, 1);

  // One-time schedules never fire twice.
  const noopMock = mockOpenAI([{ output: [messageOutput("(should not run)")] }]);
  try {
    assert.equal(await sweepAgentSchedules(new Date(Date.now() + 100 * 3_600_000)), 0);
  } finally {
    noopMock.restore();
  }
});

test("schedule_wakeup (recurring): fires on the cron and the woken instance can cancel itself", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = await createProject(client, orgId);
  const channelData = await client.request("POST", `/v1/channels/organizations/${orgId}/channels/project/${projectId}`, {});
  const originChannelId = channelData.channel.id as string;
  // Daily at the local time two hours from now, so the real 60s scheduler
  // can't reach it during the test but a fast-forwarded sweep can.
  const target = new Date(Date.now() + 2 * 3_600_000);
  const cron = `${target.getMinutes()} ${target.getHours()} * * *`;

  const mock = mockOpenAI([
    { output: [functionCall("schedule_wakeup", { instructions: "Check whether the permit came through; report here. Cancel this schedule once it has.", cron }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Recurring check scheduled." }, "call_2"),
        messageOutput("I'll check on the permit every day and report here.")
      ]
    },
    { output: [messageOutput("I'll check on the permit every day and report here.")] }
  ]);
  try {
    await client.request("POST", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages`, {
      text: "@FirstMate Assistant check on the permit daily until it's in",
      mention_users: AGENT_MENTION
    });
    await waitFor(async () => {
      const data = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
      return agentMessagesIn(data.messages).find((message: any) => /every day/.test(message.text));
    }, "recurring scheduling acknowledgment");
  } finally {
    mock.restore();
  }

  const { listAgentSchedules } = await import("../agents/storage.js");
  const active = (await listAgentSchedules("assistant", orgId, { status: "active" })) as any[];
  assert.equal(active.length, 1);
  assert.equal(active[0].kind, "recurring");
  const scheduleId = String(active[0].id);

  // First fire: the task turns out to be done, so the woken instance cancels
  // its own recurrence.
  const { sweepAgentSchedules } = await import("../channels/agent.js");
  const wakeMock = mockOpenAI([
    { output: [functionCall("cancel_wakeup", { schedule_id: scheduleId }, "call_3")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Permit is in; cancelled the recurring check." }, "call_4"),
        messageOutput("Good news — the permit came through, so I've stopped the daily check.")
      ]
    },
    { output: [messageOutput("Good news — the permit came through, so I've stopped the daily check.")] }
  ]);
  try {
    const fired = await sweepAgentSchedules(new Date(Date.now() + 3 * 3_600_000));
    await (await import("../channels/agent.js")).drainChannelAgentJobs();
    assert.equal(fired, 1);
    const origin = await client.request("GET", `/v1/channels/organizations/${orgId}/channels/${originChannelId}/messages?limit=50`);
    assert.ok(agentMessagesIn(origin.messages).some((message: any) => /stopped the daily check/.test(message.text)));
  } finally {
    wakeMock.restore();
  }

  assert.equal((await listAgentSchedules("assistant", orgId, { status: "cancelled" })).length, 1);

  // Cancelled recurrences never fire again, even a day later.
  const noopMock = mockOpenAI([{ output: [messageOutput("(should not run)")] }]);
  try {
    assert.equal(await sweepAgentSchedules(new Date(Date.now() + 27 * 3_600_000)), 0);
  } finally {
    noopMock.restore();
  }
});

test("cron and wall-clock scheduling math respects an explicit timezone, not the server's", async () => {
  const { cronMatches, latestCronFire } = await import("../work/cron.js");
  const { zonedInstant } = await import("../platform/timezone.js");

  // 6:00pm in New York on 2026-07-31 (EDT, UTC-4) is 22:00 UTC — a Friday.
  const instant = zonedInstant(2026, 7, 31, 18, 0, "America/New_York");
  assert.equal(instant.toISOString(), "2026-07-31T22:00:00.000Z");
  assert.equal(cronMatches("0 18 * * *", instant, "America/New_York"), true);
  assert.equal(cronMatches("0 18 * * 5", instant, "America/New_York"), true, "weekday comes from the zone's civil date");
  assert.equal(cronMatches("0 18 * * *", instant, "UTC"), false, "22:00 UTC is not 18:00 UTC");

  // The sweep finds the New York 6pm minute even when scanning in UTC instants.
  const fire = latestCronFire(
    "0 18 * * *",
    new Date(instant.getTime() - 3_600_000).toISOString(),
    new Date(instant.getTime() + 60_000),
    "America/New_York"
  );
  assert.equal(fire, instant.toISOString());

  // Winter (EST, UTC-5): the same wall-clock cron shifts with DST.
  const winter = zonedInstant(2026, 12, 15, 18, 0, "America/New_York");
  assert.equal(winter.toISOString(), "2026-12-15T23:00:00.000Z");
  assert.equal(cronMatches("0 18 * * *", winter, "America/New_York"), true);
});


test("scheduled agent work is cancelled when its author loses access", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const storage = await import("../platform/storage.js");
  const agents = await import("../agents/storage.js");
  const channelAgent = await import("../channels/agent.js");
  const thread = await agents.createAgentThread({ agent_id: "assistant", organization_id: orgId, created_by_user_id: userId });
  const schedule = await agents.createAgentSchedule({ agent_id: "assistant", organization_id: orgId,
    origin_thread_id: thread!.id, created_by_user_id: userId, fire_at: new Date().toISOString(), instructions: "Do not execute after revocation" });
  await agents.claimDueOnceAgentSchedule(String(schedule!.id), new Date().toISOString());
  const user = await storage.readDocument(orgId, "users", userId);
  await storage.patchIdentity(String(user.data.identity_id), { status: "disabled" });
  const mock = mockOpenAI([{ output: [messageOutput("Should never be sent")] }]);
  try {
    await channelAgent.drainChannelAgentJobs();
    const rows = await agents.getAgentsDatabase().prepare("SELECT state FROM agent_wakeup_jobs WHERE organization_id=?").all(orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, "cancelled");
    assert.equal(mock.calls.length, 0);
  } finally { mock.restore(); }
});
