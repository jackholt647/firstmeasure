import { assertAgentWakeupLease } from "./wakeups.js";
import { invokeAgentAction, agentRuntimeTools } from "../platform/publication/agent-actions.js";
import { platformAgentTools, platformAgentInstructions } from "./platform_tools.js";
import { validateJson } from "../platform/publication/validation.js";
// The shared agent runtime: ONE implementation of the OpenAI Responses tool
// loop (history replay, function-call parsing, per-tool permission gates,
// trace, report_result contract, failure epilogue + revert hook, usage
// accounting, daily caps) executing any registered AgentDefinition.

import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import {
  isRetryableOpenAIStatus,
  openAIErrorMessage,
  requestOpenAIResponse
} from "../src/openai/responses.js";
import { backgroundAuthContext, hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, notFound } from "../platform/errors.js";
import { requireAgentDefinition } from "./registry.js";
import { loadAgentSettings } from "./settings.js";
import {
  acquireAgentThread,
  renewAgentThread,
  releaseAgentThread,
  appendAgentMessage,
  countAgentRunsToday,
  createAgentThread,
  listAgentMessages,
  listAgentThreads,
  readAgentThread,
  recordAgentRun,
  updateAgentThread
} from "./storage.js";
import type { AgentDefinition, AgentRun, AgentTool, AgentTurnResult } from "./types.js";
import { asArray, asObject, cleanText, errorMessage, traceValue, truncateJson, type JsonObject } from "./util.js";

const REPORT_RESULT_TOOL: AgentTool = {
  name: "report_result",
  description: "REQUIRED final call before answering: report whether the run succeeded. Use status 'failed' when you could not do what was asked — side effects from a failed run are rolled back where possible.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "failed"] },
      summary: { type: "string", description: "One or two plain-language sentences for the customer." }
    },
    required: ["status", "summary"],
    additionalProperties: false
  },
  execute: () => ({ acknowledged: true })
};

function declaredTools(definition: AgentDefinition, run: AgentRun): AgentTool[] {
  const local = typeof definition.tools === "function" ? definition.tools(run) : definition.tools;
  const tools = run.ctx ? [...local, ...platformAgentTools] : local;
  const withReport = definition.loop?.reportResult === false
    ? tools
    : [...tools.filter((tool) => tool.name !== "report_result"), REPORT_RESULT_TOOL];
  return withReport;
}

function openAIToolDeclarations(tools: AgentTool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false
  }));
}

async function executeTool(run: AgentRun, tools: AgentTool[], name: string, args: JsonObject, invocationKey: string, usePermission?: string): Promise<JsonObject> {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) return { error: `Unknown tool '${name}'.` };
  if (run.ctx) {
    try {
      // Recheck the human principal for local editor tools as well as the shared
      // publication tools. A grant revoked during a model turn cannot linger.
      run.ctx = await backgroundAuthContext(run.orgId, run.userId);
    } catch (error) { return { error: errorMessage(error) }; }
    if (usePermission && !hasPermission(run.ctx, usePermission)) return { error: "This user no longer has access to this agent." };
  }
  // "The agent acts as the user": permission-gated tools require the calling
  // user to hold the permission, exactly like the equivalent HTTP route.
  if (tool.permission) {
    if (run.ctx) {
      if (!hasPermission(run.ctx, tool.permission)) {
        return {
          ok: false,
          errors: [`${run.userName || "This user"} does not have the '${tool.permission.split("|")[0]}' permission, so you cannot do this for them. Suggest they ask an administrator.`]
        };
      }
    } else if (!tool.allowSystem) {
      return { ok: false, errors: ["This tool is not available in automatic runs."] };
    }
  }
  if (tool.gate) {
    const verdict = tool.gate(run);
    if (verdict !== true) return { ok: false, errors: [cleanText(verdict) || "This action is turned off."] };
  }
  try {
    validateJson(tool.parameters, args, "agent tool input");
    return asObject(agentRuntimeTools.has(name) ? await tool.execute(run, args, invocationKey) : await invokeAgentAction(run, tool, args, invocationKey));
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

type LoopOutcome = {
  finalText: string;
  reported: { status: string; summary: string } | null;
  loopError: string;
  rounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
};

async function executeLoop(
  definition: AgentDefinition,
  run: AgentRun,
  tools: AgentTool[],
  conversation: JsonObject[],
  options: { maxRounds: number; maxOutputTokens: number; retryOnRetryable: boolean; checkLease?: () => void }
): Promise<LoopOutcome> {
  const actionTurnId = randomUUID();
  const model = definition.model();
  const outcome: LoopOutcome = {
    finalText: "",
    reported: null,
    loopError: "",
    rounds: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0
  };
  const toolDeclarations = openAIToolDeclarations(tools);
  let previousCallBatch = "";
  let repeatedBatches = 0;
  const requestPayload = () => ({
    model: model.model,
    ...(model.effort ? { reasoning: { effort: model.effort } } : {}),
    input: conversation,
    tools: toolDeclarations,
    tool_choice: "auto" as const,
    max_output_tokens: options.maxOutputTokens
  });

  for (let round = 0; round < options.maxRounds; round += 1) {
    options.checkLease?.();
    outcome.rounds = round + 1;
    let result = await requestOpenAIResponse(requestPayload(), { timeoutMs: model.timeoutMs ?? 120_000 });
    if (!result.ok && options.retryOnRetryable && isRetryableOpenAIStatus(result.status)) {
      result = await requestOpenAIResponse(requestPayload(), { timeoutMs: model.timeoutMs ?? 120_000 });
    }
    if (!result.ok) {
      outcome.loopError = openAIErrorMessage(result, `${definition.title} is unavailable right now.`);
      break;
    }
    options.checkLease?.();
    const usage = asObject(asObject(result.json).usage);
    outcome.inputTokens += Math.max(0, Number(usage.input_tokens) || 0);
    outcome.outputTokens += Math.max(0, Number(usage.output_tokens) || 0);

    const output = asArray(asObject(result.json).output);
    const functionCalls = output.filter((item) => cleanText(asObject(item).type) === "function_call");
    const messageText = output
      .filter((item) => cleanText(asObject(item).type) === "message")
      .flatMap((item) => asArray(asObject(item).content))
      .map((part) => cleanText(asObject(part).text))
      .filter(Boolean)
      .join("\n");

    if (!functionCalls.length) {
      outcome.finalText = messageText;
      if (definition.loop?.reportResult !== false && !outcome.reported) outcome.loopError = "The agent ended without reporting a result.";
      break;
    }
    const callBatch = JSON.stringify(functionCalls.map((call) => {
      const item = asObject(call);
      return [cleanText(item.name), cleanText(item.arguments)];
    }));
    repeatedBatches = callBatch === previousCallBatch ? repeatedBatches + 1 : 0;
    previousCallBatch = callBatch;
    if (repeatedBatches >= 3) {
      outcome.loopError = "The agent repeated the same tool calls and was stopped.";
      break;
    }
    if (outcome.toolCalls + functionCalls.length > 64) {
      outcome.loopError = "The agent reached its tool-call limit and was stopped.";
      break;
    }
    conversation.push(...output.map((item) => asObject(item)));
    for (const call of functionCalls) {
      options.checkLease?.();
      const callObject = asObject(call);
      const name = cleanText(callObject.name);
      let args: JsonObject = {};
      try {
        args = asObject(JSON.parse(String(callObject.arguments || "{}")));
      } catch {}
      if (name === "report_result") {
        outcome.reported = { status: cleanText(args.status) === "failed" ? "failed" : "success", summary: cleanText(args.summary) };
      }
      outcome.toolCalls += 1;
      const toolOutput = await executeTool(run, tools, name, args, `${actionTurnId}:${cleanText(callObject.call_id) || outcome.toolCalls}`, definition.usePermission);
      run.trace.push({
        tool: name,
        args: traceValue(args, 4_000),
        ok: toolOutput.error === undefined && toolOutput.ok !== false,
        ...(toolOutput.error !== undefined || toolOutput.errors !== undefined
          ? { error: traceValue(toolOutput.error ?? toolOutput.errors, 2_000) }
          : {}),
        at: new Date().toISOString()
      });
      conversation.push({ type: "function_call_output", call_id: callObject.call_id, output: truncateJson(toolOutput, 80_000) });
    }
  }
  if (!outcome.finalText && !outcome.loopError && outcome.rounds >= options.maxRounds) {
    outcome.loopError = "The agent reached its turn limit and was stopped.";
  }
  return outcome;
}

export type AgentTurnInput = {
  orgId: string;
  branchId?: string;
  threadId: string;
  message: string;
  ctx?: PlatformAuthContext | null;
  actorUserId?: string;
  actorName?: string;
  subjectId?: string;
  input?: JsonObject;
  /** Extra system-prompt suffix for this turn only (e.g. references note). */
  turnNote?: string;
  /** Extra tools for this turn only (e.g. channel-context tools). */
  extraTools?: AgentTool[];
};

export async function runAgentTurn(agentId: string, turn: AgentTurnInput): Promise<AgentTurnResult> {
  const token = randomUUID();
  if (!await acquireAgentThread(agentId, turn.orgId, turn.threadId, token)) {
    if (!await readAgentThread(agentId, turn.orgId, turn.threadId)) throw notFound("agent_thread_not_found", "This conversation was not found.");
    throw badRequest("agent_thread_busy", "This conversation is already working on a request.");
  }
  let valid = true;
  let renewal: Promise<void> | undefined;
  const checkLease = () => { assertAgentWakeupLease(); if (!valid) throw new Error("The agent conversation lease was lost; the turn was stopped."); };
  const timer = setInterval(() => {
    if (renewal) return;
    renewal = renewAgentThread(agentId, turn.orgId, turn.threadId, token)
      .then(renewed => { if (!renewed) valid = false; })
      .catch(() => { valid = false; })
      .finally(() => { renewal = undefined; });
  }, 30_000);
  timer.unref?.();
  try { return await runClaimedAgentTurn(agentId, turn, checkLease); }
  finally {
    clearInterval(timer);
    await renewal;
    await releaseAgentThread(agentId, turn.orgId, turn.threadId, token);
  }
}

async function runClaimedAgentTurn(agentId: string, turn: AgentTurnInput, checkLease: () => void): Promise<AgentTurnResult> {
  const definition = requireAgentDefinition(agentId);
  const startedAt = Date.now();
  const thread = (await readAgentThread(agentId, turn.orgId, turn.threadId));
  if (!thread) throw notFound("agent_thread_not_found", "This conversation was not found.");

  const branchId = cleanText(thread.branch_id || turn.branchId || "default") || "default";
  const settings = await loadAgentSettings(agentId, turn.orgId, branchId);
  if (settings.enabled === false) {
    throw badRequest("agent_disabled", `${definition.title} is turned off for this company.`);
  }
  if (definition.dailyOrgLimit && (await countAgentRunsToday(agentId, turn.orgId)) >= definition.dailyOrgLimit) {
    throw badRequest("agent_daily_limit", `${definition.title} has reached its daily usage limit for this company.`);
  }

  const run: AgentRun = {
    agentId,
    orgId: turn.orgId,
    branchId,
    userId: cleanText(turn.actorUserId || turn.ctx?.userId),
    userName: cleanText(turn.actorName),
    ctx: turn.ctx ?? null,
    settings,
    subjectId: cleanText(turn.subjectId || thread.subject_id),
    input: asObject(turn.input),
    changeLog: [],
    actions: [],
    trace: [],
    renders: [],
    scratch: {}
  };

  if (definition.prepare) await definition.prepare(run);

  const tools = [...declaredTools(definition, run), ...(turn.extraTools ?? [])];
  const loop = definition.loop ?? {};
  const maxRounds = Math.max(1, loop.maxRounds ?? 16);

  checkLease();
  const userMessage = (await appendAgentMessage(agentId, turn.orgId, turn.threadId, {
    role: "user",
    content: cleanText(turn.message),
    data: asObject(turn.input)
  }));
  (await updateAgentThread(agentId, turn.orgId, turn.threadId, { status: "working" }));

  const history = (await listAgentMessages(agentId, turn.orgId, turn.threadId, { limit: loop.historyLimit ?? 40 }))
    .map((message) => asObject(message))
    .filter((message) => ["user", "assistant"].includes(cleanText(message.role)))
    .map((message) => ({ role: cleanText(message.role), content: String(message.content || "") }));
  const last = history[history.length - 1];
  if (last && cleanText(turn.turnNote) && last.role === "user") {
    last.content = `${last.content}${turn.turnNote}`;
  }

  const conversation: JsonObject[] = [
    { role: "system", content: `${await definition.systemPrompt(run)}${run.ctx ? `\n\n${platformAgentInstructions}` : ""}` },
    ...history
  ];

  const { finalText: loopText, reported, loopError, rounds, toolCalls: toolCallCount, inputTokens, outputTokens } =
    await executeLoop(definition, run, tools, conversation, {
      maxRounds,
      maxOutputTokens: loop.maxOutputTokens ?? 8_000,
      retryOnRetryable: loop.retryOnRetryable !== false,
      checkLease
    });
  let finalText = loopError ? "" : loopText;

  const failed = loopError !== "" || (reported ? reported.status === "failed" : false);
  let reverted: string[] = [];
  if (failed && definition.revert) {
    try {
      reverted = [...await definition.revert(run)];
    } catch {
      // Best effort — report whatever state remains.
    }
  }
  if (!finalText) {
    finalText = failed
      ? (reported?.summary || loopError || "I wasn't able to complete that. Anything I changed along the way has been rolled back where possible.")
      : (reported?.summary || "Done.");
  }

  checkLease();
  const assistantMessage = (await appendAgentMessage(agentId, turn.orgId, turn.threadId, {
    role: "assistant",
    content: finalText,
    data: {
      status: failed ? "failed" : "success",
      changes: run.changeLog,
      actions: failed ? [] : run.actions,
      renders: failed ? [] : run.renders,
      reverted,
      trace: run.trace
    }
  }));
  (await updateAgentThread(agentId, turn.orgId, turn.threadId, {
    status: "idle",
    title: cleanText(thread.title) || cleanText(turn.message).slice(0, 60)
  }));
  (await recordAgentRun({
    agent_id: agentId,
    organization_id: turn.orgId,
    branch_id: branchId,
    thread_id: turn.threadId,
    user_id: run.userId,
    status: failed ? "failed" : "success",
    rounds,
    tool_calls: toolCallCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_ms: Date.now() - startedAt
  }));

  return {
    thread: (await readAgentThread(agentId, turn.orgId, turn.threadId)),
    user_message: userMessage,
    assistant_message: assistantMessage,
    status: failed ? "failed" : "success",
    changes: run.changeLog,
    actions: failed ? [] : run.actions,
    renders: failed ? [] : run.renders,
    reverted
  };
}

// ── Threadless runs (auto-responses, external-conversation agents) ─────────

export type AgentOnceInput = {
  orgId: string;
  branchId?: string;
  /** The full conversation to run over ({role, content} entries). */
  messages: { role: string; content: string }[];
  ctx?: PlatformAuthContext | null;
  actorUserId?: string;
  actorName?: string;
  subjectId?: string;
  input?: JsonObject;
  /** Pre-resolved settings (e.g. per-project overrides); loaded when omitted. */
  settings?: JsonObject;
  /** Extra tools for this run only (e.g. propose_reply in auto-responses). */
  extraTools?: AgentTool[];
  maxRounds?: number;
  /** Skip the enabled check (callers that gate themselves). Default false. */
  skipEnabledCheck?: boolean;
};

/**
 * Run an agent over a caller-supplied conversation with no thread storage:
 * used for auto-responses and agents that live inside external conversations
 * (live chat). Usage is still recorded in agent_runs; daily caps still apply.
 */
export async function runAgentOnce(agentId: string, input: AgentOnceInput) {
  const definition = requireAgentDefinition(agentId);
  const startedAt = Date.now();
  const branchId = cleanText(input.branchId || "default") || "default";
  const settings = input.settings ?? await loadAgentSettings(agentId, input.orgId, branchId);
  if (!input.skipEnabledCheck && settings.enabled === false) {
    throw badRequest("agent_disabled", `${definition.title} is turned off for this company.`);
  }
  if (definition.dailyOrgLimit && (await countAgentRunsToday(agentId, input.orgId)) >= definition.dailyOrgLimit) {
    throw badRequest("agent_daily_limit", `${definition.title} has reached its daily usage limit for this company.`);
  }

  const run: AgentRun = {
    agentId,
    orgId: input.orgId,
    branchId,
    userId: cleanText(input.actorUserId || input.ctx?.userId),
    userName: cleanText(input.actorName),
    ctx: input.ctx ?? null,
    settings,
    subjectId: cleanText(input.subjectId),
    input: asObject(input.input),
    changeLog: [],
    actions: [],
    trace: [],
    renders: [],
    scratch: {}
  };
  if (definition.prepare) await definition.prepare(run);

  const tools = [...declaredTools(definition, run), ...(input.extraTools ?? [])];
  const loop = definition.loop ?? {};
  const conversation: JsonObject[] = [
    { role: "system", content: `${await definition.systemPrompt(run)}${run.ctx ? `\n\n${platformAgentInstructions}` : ""}` },
    ...input.messages.map((message) => ({ role: cleanText(message.role) || "user", content: String(message.content ?? "") }))
  ];

  const outcome = await executeLoop(definition, run, tools, conversation, {
    maxRounds: Math.max(1, input.maxRounds ?? loop.maxRounds ?? 16),
    maxOutputTokens: loop.maxOutputTokens ?? 8_000,
    retryOnRetryable: loop.retryOnRetryable !== false
  });
  const failed = outcome.loopError !== "" || (outcome.reported ? outcome.reported.status === "failed" : false);
  (await recordAgentRun({
    agent_id: agentId,
    organization_id: input.orgId,
    branch_id: branchId,
    thread_id: "",
    user_id: run.userId,
    status: failed ? "failed" : "success",
    rounds: outcome.rounds,
    tool_calls: outcome.toolCalls,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    duration_ms: Date.now() - startedAt
  }));
  return {
    run,
    finalText: outcome.finalText,
    reported: outcome.reported,
    loopError: outcome.loopError,
    failed,
    rounds: outcome.rounds,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens
  };
}

// ── Thread helpers shared by every agent's API ─────────────────────────────

export async function createThreadForAgent(agentId: string, input: {
  orgId: string; branchId?: string; subjectId?: string; actorUserId?: string; title?: string;
}) {
  requireAgentDefinition(agentId);
  return (await createAgentThread({
    agent_id: agentId,
    organization_id: input.orgId,
    branch_id: cleanText(input.branchId || "default") || "default",
    subject_id: cleanText(input.subjectId),
    title: cleanText(input.title),
    created_by_user_id: cleanText(input.actorUserId)
  }));
}

export async function listThreadsForAgent(agentId: string, orgId: string, options: { actorUserId?: string; subjectId?: string; limit?: number } = {}) {
  const definition = requireAgentDefinition(agentId);
  return (await listAgentThreads(agentId, orgId, {
    ...(definition.threadScope === "user" ? { created_by_user_id: cleanText(options.actorUserId) } : {}),
    ...(options.subjectId !== undefined ? { subject_id: options.subjectId } : {}),
    ...(options.limit ? { limit: options.limit } : {})
  }));
}

export async function readThreadForAgent(agentId: string, orgId: string, threadId: string, actorUserId?: string) {
  const definition = requireAgentDefinition(agentId);
  const thread = (await readAgentThread(agentId, orgId, threadId));
  if (!thread) throw notFound("agent_thread_not_found", "This conversation was not found.");
  if (definition.threadScope === "user") {
    const owner = cleanText(thread.created_by_user_id);
    if (owner && owner !== cleanText(actorUserId)) {
      throw notFound("agent_thread_not_found", "This conversation was not found.");
    }
  }
  return { thread, messages: (await listAgentMessages(agentId, orgId, threadId)) };
}
