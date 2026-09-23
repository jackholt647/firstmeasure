import type { AgentRun, AgentTool } from "../../agents/types.js";
import type { PublicationContext } from "./contracts.js";
import { objectSchema } from "./contracts.js";
import { registerAction, invokeAction } from "./actions.js";
import { systemPublicationContext, userPublicationContext } from "./context.js";
import { contentHash } from "./validation.js";
import { forbidden } from "../errors.js";
import { backendImplementationDigest } from "./implementation.js";

const invocations = new WeakMap<PublicationContext, { run: AgentRun; tool: AgentTool }>();
/** Runtime facilities are deliberately absent from the business action inventory. */
export const agentRuntimeTools = new Set(["report_result", "render_widget", "suggest_navigation"]);
export async function invokeAgentAction(run: AgentRun, tool: AgentTool, args: Record<string, unknown>, idempotencyKey: string) {
  const id = `agent.${run.agentId}.${tool.name}`;
  const implementation = contentHash({ artifact: backendImplementationDigest(), handler: tool.execute.toString(), gate: tool.gate?.toString() || "", permission: tool.permission || "", allowSystem: tool.allowSystem === true });
  // Agent-specific closure adapters have content-addressed versions, not a silently mutable v1.
  const version = tool.publication?.version || implementation;
  registerAction({ id, version, implementation, domain: run.agentId, description: tool.description,
    inputSchema: tool.parameters, outputSchema: tool.publication?.outputSchema || objectSchema,
    effect: tool.publication?.effect || "write", executionKinds: ["agent"], idempotency: "required",
    policy: { scopes: ["organization"], applications: false, permissions: tool.permission ? [tool.permission] : [],
      systemKinds: !tool.permission || tool.allowSystem ? ["agent"] : [],
      authorize(ctx) {
        const invocation = invocations.get(ctx);
        if (!invocation) throw forbidden("action_agent_context_required", "This action requires its agent runtime context.");
        const verdict = invocation.tool.gate?.(invocation.run) ?? true;
        if (verdict !== true) throw forbidden("action_agent_gate_denied", String(verdict));
      }
    },
    execute(ctx, _target, input) {
      const invocation = invocations.get(ctx)!;
      return invocation.tool.execute(invocation.run, input);
    }
  });
  const ctx = run.ctx
    ? userPublicationContext(run.ctx, { executionKind: "agent", mode: "command" })
    : systemPublicationContext({ kind: "agent", organizationId: run.orgId, branchId: run.branchId, operations: [id], mode: "command" });
  if (ctx.organizationId !== run.orgId) throw forbidden("publication_tenant_denied", "Agent execution context does not match its principal.");
  invocations.set(ctx, { run, tool });
  try { return (await invokeAction(ctx, { action: id, version, target: { scope: "organization", organizationId: run.orgId } }, args, { idempotencyKey })).value; }
  finally { invocations.delete(ctx); }
}
