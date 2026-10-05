import {
  registerDataProvider,
  selectExternalProviderVersion,
} from "../platform/publication/providers.js";
import {
  registerAction,
  selectExternalActionVersion,
} from "../platform/publication/actions.js";
import type {
  PublicationContext,
  AccessPolicy,
} from "../platform/publication/contracts.js";
import { forbidden } from "../platform/errors.js";
import { list } from "./storage.js";
import {
  connection,
  definition,
  execute,
  readResource,
  listResource,
} from "./service.js";

const registered = new Set<string>();
export async function loadConnectionPublications(orgId: string) {
  for (const c of await list(orgId, "connection")) {
    if (!c.activeVersion) continue;
    const version = c.activeVersion,
      key = `${orgId}:${c.id}:${version}`;
    const d = await definition(orgId, c, version),
      provider = `external.${c.id}`;
    if (!registered.has(key)) {
      const policy = (
        operation: string,
        effect: "read" | "write",
      ): AccessPolicy => ({
        scopes: ["organization", "project"],
        applications: false,
        permissions: [],
        authorize: async (ctx, target) => {
          if (
            !ctx.auth ||
            ctx.organizationId !== orgId ||
            target.organizationId !== orgId
          )
            throw forbidden(
              "connection_tenant",
              "This connection is not available in this organization.",
            );
          const current = await connection(ctx.auth, c.id, operation, effect);
          if (current.activeVersion !== version)
            throw forbidden(
              "connection_version",
              "This connector version is not active.",
            );
        },
      });
      const exports: Parameters<typeof registerDataProvider>[0]["exports"] = {};
      for (const resource of d.resources) {
        exports[resource.id] = {
          schema:
            resource.mode === "sync"
              ? { type: "array", items: resource.schema }
              : {},
          schemaVersion: version,
          listItemSchema: resource.schema,
          argsSchema: { type: "object" },
          description: `${c.name}: ${resource.title}. ${resource.description} ${resource.mode === "sync" ? "Synchronized records; use listing for large datasets." : "Live external lookup."}`,
          access: policy(resource.operation, "read"),
          historical: resource.mode === "sync",
          read: async (ctx, ref) =>
            readResource(ctx.auth!, c.id, resource.id, ref.args, ref.revision),
          ...(resource.mode === "sync"
            ? {
                list: async (
                  ctx: PublicationContext,
                  _ref: unknown,
                  page: { limit: number; cursor?: string },
                ) => listResource(ctx.auth!, c.id, resource.id, page),
              }
            : {}),
        };
      }
      if (Object.keys(exports).length)
        registerDataProvider({
          id: provider,
          version,
          apps: ["settings"],
          exports,
        });
      for (const op of d.operations)
        registerAction({
          id: `${provider}.${op.id}`,
          version,
          implementation: `connector:${version}`,
          domain: "connections",
          description: `${c.name}: ${op.title}. ${op.description}`,
          inputSchema: op.inputSchema,
          outputSchema: op.outputSchema,
          effect: op.effect === "read" ? "read" : "external",
          executionKinds: ["api", "agent", "module", "work"],
          policy: policy(op.id, op.effect),
          idempotency: op.effect === "read" ? "none" : "required",
          execute: (ctx, _target, input, execution) =>
            execute(ctx.auth!, c.id, op.id, input, {
              version,
              receipt: op.effect === "write" ? execution.receiptId : undefined,
            }),
        });
      registered.add(key);
    }
    if (d.resources.length) selectExternalProviderVersion(provider, version);
    for (const op of d.operations)
      selectExternalActionVersion(`${provider}.${op.id}`, version);
  }
}
