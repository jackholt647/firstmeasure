/** Shared, permission-filtered publication tools for every human-initiated agent. */
import type { AgentRun, AgentTool } from "./types.js";
import { asObject, cleanText, type JsonObject } from "./util.js";
import { backgroundAuthContext } from "../platform/auth.js";
import { forbidden, badRequest } from "../platform/errors.js";
import { initializePublication } from "../platform/publication/bootstrap.js";
import { authorizePublication, userPublicationContext } from "../platform/publication/context.js";
import type { AccessPolicy, DataBinding, SourceRef, TargetRef } from "../platform/publication/contracts.js";
import { listActions, describeAction, invokeAction } from "../platform/publication/actions.js";
import { listDataProviders, describeDataProvider, readPublishedData, listPublishedData } from "../platform/publication/providers.js";
import { resolveDataBinding } from "../platform/publication/bindings.js";

const string = { type: "string" };
const object = { type: "object" };
const targetSchema = { type: "object", properties: { scope: { type: "string", enum: ["global", "organization", "project"] }, organizationId: string, projectId: string, branchId: string, id: string }, required: ["scope"], additionalProperties: false };
const sourceSchema = { type: "object", properties: { provider: string, export: string, version: string, target: targetSchema, args: object, path: string, revision: string }, required: ["provider", "export", "target"], additionalProperties: false };

export const platformAgentInstructions = `## Platform data and actions
You may work across apps through one published catalog, regardless of which app opened this conversation. Search with platform_search, inspect a selected contract with platform_describe, then use platform_read/platform_list or platform_invoke. Search again when the first term misses; app names and business concepts are useful queries. Project operations need an explicit project id. Use platform_resolve_binding when an artifact needs a live or frozen data reference, and put the returned source identity in the artifact's declared binding rather than flattening provenance into anonymous text. Never guess action inputs or record ids; inspect schemas and read current records first. The server filters discovery and rechecks every operation against the current human user, enabled apps, target resource and any extra agent restriction. An unavailable operation is unavailable to you. Effects need an explicit user request; confirm hard-to-reverse external effects in the conversation before invoking them. Do not claim an operation succeeded when its tool reports failure or an uncertain outcome.`;

function target(value: unknown, orgId: string): TargetRef {
  const raw = asObject(value);
  const scope = cleanText(raw.scope);
  if (!["global", "organization", "project"].includes(scope)) throw badRequest("agent_target_invalid", "Choose global, organization, or project scope.");
  if (scope !== "global" && cleanText(raw.organizationId) !== orgId) throw forbidden("agent_tenant_denied", "The requested target is outside this company.");
  if (scope === "project" && !cleanText(raw.projectId)) throw badRequest("agent_project_required", "A project id is required.");
  return raw as TargetRef;
}

function source(value: unknown, orgId: string): SourceRef {
  const raw = asObject(value);
  if (!cleanText(raw.provider) || !cleanText(raw.export)) throw badRequest("agent_source_invalid", "A provider and export are required.");
  return { ...raw, target: target(raw.target, orgId) } as SourceRef;
}

function permittedSource(run: AgentRun, value: unknown): SourceRef {
  const ref = source(value, run.orgId);
  if (!allowedByAgent(run, `${ref.provider}.${ref.export}`)) throw forbidden("agent_data_denied", "This data source is unavailable to this agent.");
  return ref;
}

async function context(run: AgentRun, mode: "evaluate" | "command" = "evaluate") {
  if (!run.ctx || !run.userId) throw forbidden("agent_user_required", "Platform publication requires a current human user.");
  // Rebuild from the current membership on every call. A role or app revocation
  // during a long model turn must take effect before the next tool invocation.
  const auth = await backgroundAuthContext(run.orgId, run.userId);
  return userPublicationContext(auth, { executionKind: "agent", mode });
}

function allowedByAgent(run: AgentRun, id: string, effect: string = "read") {
  if (run.agentId !== "assistant") return true;
  const scope = asObject(run.settings.data_scope);
  const area = id.startsWith("customers.") ? "contacts"
    : id.startsWith("stats.") ? "stats"
    : id.startsWith("documents.") || id.startsWith("document-modules.") ? "documents"
    : id.startsWith("calendar.") || id.startsWith("scheduling.") ? "schedule"
    : id.startsWith("projects.") || id.startsWith("work.") || id.startsWith("datasets.") ? "projects"
    : "";
  if (area && scope[area] === false) return false;
  if ((effect === "write" || effect === "external") && (run.settings.allow_actions === false || run.scratch.actionsAllowed === false)) return false;
  if (effect === "external" && (id.startsWith("comms.") || id.startsWith("chat.")) && (run.settings.allow_messaging !== true || run.scratch.messagingAllowed === false)) return false;
  return true;
}

async function discover(run: AgentRun, policy: AccessPolicy, scopes: readonly TargetRef["scope"][], operation: string) {
  if (!allowedByAgent(run, operation)) return false;
  const ctx = await context(run);
  for (const scope of scopes) {
    const candidate: TargetRef = scope === "global" ? { scope }
      : scope === "project" ? { scope, organizationId: run.orgId, projectId: "$project" }
      : { scope, organizationId: run.orgId };
    try {
      // Discovery checks grants, not ownership of a resource that has not yet
      // been selected. Reads and invocations use the full policy.
      await authorizePublication(ctx, candidate, { ...policy, authorize: undefined }, operation);
      return true;
    } catch { /* Another supported scope may be available. */ }
  }
  return false;
}

const businessActions = () => listActions().filter(action => action.executionKinds.includes("agent") && !action.id.startsWith("agent."));

export const platformAgentTools: AgentTool[] = [
  {
    name: "platform_search",
    description: "Search the published data and action catalog across every app permitted for the current user. Returns short matches; call platform_describe for schemas.",
    parameters: { type: "object", properties: { query: string, kind: { type: "string", enum: ["all", "data", "action"] } }, required: ["query"], additionalProperties: false },
    async execute(run, args) {
      initializePublication();
      const query = cleanText(args.query).toLowerCase();
      const kind = cleanText(args.kind) || "all";
      const matches: JsonObject[] = [];
      if (kind !== "action") for (const provider of listDataProviders()) for (const [name, entry] of Object.entries(provider.exports)) {
        const id = `${provider.id}.${name}`;
        if (query && !`${id} ${entry.description} ${provider.apps.join(" ")}`.toLowerCase().includes(query)) continue;
        if (await discover(run, entry.access, entry.access.scopes, id)) matches.push({ kind: "data", id, description: entry.description, scopes: entry.access.scopes });
      }
      if (kind !== "data") for (const action of businessActions()) {
        if (query && !`${action.id} ${action.description} ${action.domain}`.toLowerCase().includes(query)) continue;
        if (allowedByAgent(run, action.id, action.effect) && await discover(run, action.policy, action.policy.scopes, action.id)) matches.push({ kind: "action", id: action.id, effect: action.effect, description: action.description, scopes: action.policy.scopes });
      }
      return { matches: matches.slice(0, 40), more: matches.length > 40 };
    }
  },
  {
    name: "platform_describe",
    description: "Get the selected published data export or action's JSON schemas, effect and supported scopes. Permission internals are omitted.",
    parameters: { type: "object", properties: { kind: { type: "string", enum: ["data", "action"] }, id: string }, required: ["kind", "id"], additionalProperties: false },
    async execute(run, args) {
      initializePublication();
      const id = cleanText(args.id);
      if (args.kind === "action") {
        const action = describeAction(id);
        if (!action || !action.executionKinds.includes("agent") || id.startsWith("agent.") || !allowedByAgent(run, id, action.effect) || !await discover(run, action.policy, action.policy.scopes, id)) return { available: false };
        return { available: true, kind: "action", id, description: action.description, effect: action.effect, scopes: action.policy.scopes, inputSchema: action.inputSchema, outputSchema: action.outputSchema, version: action.version };
      }
      const dot = id.lastIndexOf(".");
      const provider = dot > 0 ? describeDataProvider(id.slice(0, dot)) : null;
      const entry = provider?.exports[id.slice(dot + 1)];
      if (!entry || !await discover(run, entry.access, entry.access.scopes, id)) return { available: false };
      return { available: true, kind: "data", id, description: entry.description, scopes: entry.access.scopes, schema: entry.schema, argsSchema: entry.argsSchema, units: entry.units, listable: entry.listable, version: provider!.version };
    }
  },
  {
    name: "platform_read",
    description: "Read one authorized published data source by provider, export and target. Returns ready, missing, pending, denied or error with source revision and provenance.",
    parameters: { type: "object", properties: { source: sourceSchema }, required: ["source"], additionalProperties: false },
    async execute(run, args) { initializePublication(); return await readPublishedData(await context(run), permittedSource(run, args.source)) as unknown as JsonObject; }
  },
  {
    name: "platform_list",
    description: "List a bounded page of an authorized published data export.",
    parameters: { type: "object", properties: { source: sourceSchema, limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: string }, required: ["source"], additionalProperties: false },
    async execute(run, args) { initializePublication(); return await listPublishedData(await context(run), permittedSource(run, args.source), { limit: args.limit as number | undefined, cursor: cleanText(args.cursor) || undefined }) as unknown as JsonObject; }
  },
  {
    name: "platform_invoke",
    description: "Invoke a published action with its declared target and input. Writes and external effects use a durable receipt; uncertain effects are never automatically repeated.",
    parameters: { type: "object", properties: { action: string, version: string, target: targetSchema, input: object }, required: ["action", "target", "input"], additionalProperties: false },
    async execute(run, args, invocationKey) {
      initializePublication();
      const id = cleanText(args.action);
      const action = describeAction(id, cleanText(args.version) || undefined);
      if (!action || !action.executionKinds.includes("agent") || id.startsWith("agent.") || !allowedByAgent(run, id, action.effect)) throw forbidden("agent_action_denied", "This action is unavailable to this agent.");
      const result = await invokeAction(await context(run, "command"), { action: id, ...(cleanText(args.version) ? { version: cleanText(args.version) } : {}), target: target(args.target, run.orgId) }, asObject(args.input), { idempotencyKey: invocationKey });
      return result as unknown as JsonObject;
    }
  },
  {
    name: "platform_resolve_binding",
    description: "Resolve a live or frozen published data binding for this agent and user. Returns the value with source revision and provenance; use an artifact's own declared binding when creating that artifact.",
    parameters: { type: "object", properties: { name: string, policy: { type: "string", enum: ["live", "frozen"] }, source: sourceSchema }, required: ["name", "policy", "source"], additionalProperties: false },
    async execute(run, args) {
      initializePublication();
      const name = cleanText(args.name);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name)) throw badRequest("agent_binding_name_invalid", "Binding names must start with a letter and be at most 80 characters.");
      const binding: DataBinding = { kind: "data", policy: args.policy as "live" | "frozen", source: permittedSource(run, args.source) };
      return await resolveDataBinding(await context(run), `agent:${run.agentId}:${run.userId}`, name, binding) as unknown as JsonObject;
    }
  }
];
