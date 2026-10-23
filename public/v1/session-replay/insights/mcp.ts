import { GUIDE, callTool, toolManifest } from "./tools.js";

/**
 * The session replay search tools as an MCP server over Streamable HTTP (JSON responses only, no event stream), so a
 * coding agent connects with one URL and a key (docs/architecture/session-replay-search.md, "Access for coding agents").
 * Handles initialize, ping, tools/list and tools/call; notifications are accepted and ignored.
 */
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const reply = (id: JsonRpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const failure = (id: JsonRpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(message: JsonRpc, context: { origin: string; log: (tool: string, ms: number, ok: boolean) => void }) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return failure(message?.id, -32600, "Invalid JSON-RPC request.");
  }
  const isNotification = message.id === undefined || message.id === null;
  switch (message.method) {
    case "initialize": {
      const requested = String(message.params?.protocolVersion || "");
      return reply(message.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "firstmate-session-replay", title: "FirstMate session replay search", version: "1" },
        instructions: GUIDE
      });
    }
    case "ping": return reply(message.id, {});
    case "tools/list":
      return reply(message.id, { tools: toolManifest().tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) });
    case "tools/call": {
      const name = String(message.params?.name || "");
      const started = Date.now();
      try {
        const result = await callTool(name, message.params?.arguments ?? {}, { origin: context.origin });
        const isError = !!(result && typeof result === "object" && "error" in (result as object));
        context.log(name, Date.now() - started, !isError);
        return reply(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], isError });
      } catch (error) {
        context.log(name, Date.now() - started, false);
        return reply(message.id, { content: [{ type: "text", text: `The tool failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
      }
    }
    default:
      if (isNotification || message.method.startsWith("notifications/")) return null;
      return failure(message.id, -32601, `Method not found: ${message.method}`);
  }
}

/** One POST body (a message or a batch); null means accepted with no body (notifications only). */
export async function handleMcp(body: unknown, context: { origin: string; log: (tool: string, ms: number, ok: boolean) => void }) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map((message) => handle(message as JsonRpc, context)))).filter(Boolean);
    return out.length ? out : null;
  }
  return await handle(body as JsonRpc, context);
}
