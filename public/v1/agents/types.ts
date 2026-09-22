// Type contracts for the centralized agent framework. An agent is a
// DECLARATION (id, model, prompt, tools, settings, limits) executed by the
// shared runtime in runtime.ts — modules register definitions instead of
// re-implementing the OpenAI Responses loop.

import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "./util.js";

/** Everything a tool or prompt builder can see about the current turn. */
export type AgentRun = {
  agentId: string;
  orgId: string;
  branchId: string;
  userId: string;
  userName: string;
  /**
   * The authenticated caller when the turn was started from an HTTP request.
   * Null for system-initiated runs (auto-responses, schedulers) — tools that
   * declare `permission` are skipped for null ctx unless `allowSystem`.
   */
  ctx: PlatformAuthContext | null;
  /** Normalized settings for this agent (common core + agent extras). */
  settings: JsonObject;
  /** Optional focus id (stats view, scope template, project, conversation). */
  subjectId: string;
  /** Free-form user input metadata forwarded by the caller (references etc). */
  input: JsonObject;
  /** Plain-language descriptions of every mutation made this turn. */
  changeLog: string[];
  /** Navigation chips / UI actions surfaced with the reply. */
  actions: JsonObject[];
  /** Per-call execution trace, persisted on the assistant message. */
  trace: JsonObject[];
  /** Structured extras rendered by the client (e.g. stats widget renders). */
  renders: JsonObject[];
  /** Agent-private scratch space (baselines, created ids, counters...). */
  scratch: JsonObject;
};

export type AgentToolResult = JsonObject;

export type AgentTool = {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: JsonObject;
  /**
   * Pipe-delimited permission key(s) the CALLING USER must hold (checked via
   * platform hasPermission, owner/admin bypass included). Enforced by the
   * runtime before execute() — this is the "agent acts as the user" gate.
   */
  permission?: string;
  /** Set to allow system-initiated (ctx=null) runs to use a permission-gated tool. */
  allowSystem?: boolean;
  /**
   * Extra gate for settings/capability checks. Return true to allow or a
   * customer-readable refusal string the model relays.
   */
  gate?: (run: AgentRun) => true | string;
  execute: (run: AgentRun, args: JsonObject) => Promise<AgentToolResult> | AgentToolResult;
};

export type AgentModelConfig = {
  model: string;
  effort?: string;
  timeoutMs?: number;
};

export type AgentLoopConfig = {
  /** Max tool rounds per turn. Default 16. */
  maxRounds?: number;
  /** Max output tokens per round. Default 8000. */
  maxOutputTokens?: number;
  /** Retry a round once on retryable OpenAI statuses (429/5xx). Default true. */
  retryOnRetryable?: boolean;
  /** Require the report_result contract (auto-added tool). Default true. */
  reportResult?: boolean;
  /** How much history to replay into the conversation. Default 40 messages. */
  historyLimit?: number;
};

export type AgentSettingsAdapter = {
  /** Defaults for this agent's settings (common core + extras). */
  defaults: () => JsonObject;
  /** Normalize raw stored/user input into the full settings shape. */
  normalize: (raw: unknown) => JsonObject;
  /**
   * Optional custom storage (e.g. comms keeps its settings inside the
   * comms_settings branch module). Omit both to use the shared
   * `agent_settings` branch module keyed by agent id.
   */
  load?: (orgId: string, branchId: string) => Promise<JsonObject>;
  save?: (orgId: string, branchId: string, value: JsonObject) => Promise<JsonObject>;
};

export type AgentDefinition = {
  id: string;
  title: string;
  description: string;
  /** Capability key gating this agent (checked at the route layer). */
  capability?: string;
  /** Pipe-delimited permission string required to chat with this agent. */
  usePermission?: string;
  /** Resolve model/effort/timeout (usually from env keys). */
  model: () => AgentModelConfig;
  loop?: AgentLoopConfig;
  /**
   * Optional pre-turn hook: resolve capability state, load focus records,
   * seed run.scratch — runs before the system prompt and any tool executes.
   */
  prepare?: (run: AgentRun) => Promise<void> | void;
  /**
   * Build the system prompt for a turn. Receives the run so it can embed
   * settings (custom instructions), focus summaries, and dynamic catalogs.
   */
  systemPrompt: (run: AgentRun) => Promise<string> | string;
  /** Static tool list, or a builder for per-run dynamic tool sets. */
  tools: AgentTool[] | ((run: AgentRun) => AgentTool[]);
  /**
   * Revert side effects after a failed run. Returns plain-language notes of
   * what was rolled back (appended to the failure reply data).
   */
  revert?: (run: AgentRun) => Promise<string[]> | string[];
  /** Per-org daily turn cap (counted from agent_runs). Unlimited if absent. */
  dailyOrgLimit?: number;
  settings: AgentSettingsAdapter;
  /** "user": threads are personal (listed per creator). "org": shared. */
  threadScope?: "user" | "org";
};

export type AgentTurnResult = {
  thread: JsonObject | null;
  user_message: JsonObject | null;
  assistant_message: JsonObject | null;
  status: "success" | "failed";
  changes: string[];
  actions: JsonObject[];
  renders: JsonObject[];
  reverted: string[];
};
