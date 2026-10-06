import { createHash } from "node:crypto";
import { hasPermission, requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden, badRequest, conflict } from "../platform/errors.js";
import { runModuleCode } from "../documents/modules/runtime.js";
import { contentHash } from "../platform/publication/validation.js";
import {
  db,
  id,
  list,
  read,
  requireObject,
  save,
  immutable,
  now,
  claimRun,
  finishRun,
} from "./storage.js";
import {
  parseConnector,
  object,
  validateValue,
  at,
  type Connector,
  type Obj,
} from "./contracts.js";
import { authIdentity, secrets, hasCredentials } from "./credentials.js";
import { requestExternal, redact, safeUrl } from "./transport.js";

export function manage(ctx: PlatformAuthContext) {
  if (!hasPermission(ctx, "manage_company_settings"))
    throw forbidden(
      "connection_manage",
      "Company settings permission is required.",
    );
}
export async function connection(
  ctx: PlatformAuthContext,
  key: string,
  operation?: string,
  effect = "read",
) {
  await requireCapability(ctx, "platform.connections");
  const c = await requireObject(ctx.orgId, "connection", key);
  const owner = c.owner === ctx.userId;
  const administrator =
    c.visibility === "organization" &&
    hasPermission(ctx, "manage_company_settings");
  const grant = object(object(c.grants)[ctx.userId]);
  const permitted = Array.isArray(grant[effect]) ? grant[effect] : [];
  if (
    !owner &&
    !administrator &&
    !(operation
      ? permitted.includes(operation)
      : ["read", "write"].some(
          (kind) => Array.isArray(grant[kind]) && grant[kind].length,
        ))
  )
    throw forbidden(
      "connection_access",
      "This connection is not available to you.",
    );
  if (
    operation &&
    (!c.enabled || !c.activeVersion || !c.enabledOperations.includes(operation))
  )
    throw forbidden(
      "connection_operation",
      "This connection operation is disabled.",
    );
  return c;
}
export async function definition(
  org: string,
  c: Obj,
  version?: string,
): Promise<Connector> {
  return parseConnector(
    (
      await requireObject(
        org,
        "connector-version",
        `${c.id}:${version || c.activeVersion || c.draftVersion}`,
      )
    ).definition,
  );
}
export async function listConnections(ctx: PlatformAuthContext):Promise<Obj[]> {
  const results = [];
  for (const c of await list(ctx.orgId, "connection")) {
    try {
      await connection(ctx, c.id);
      results.push({
        ...c,
        hasCredentials: await hasCredentials(ctx.orgId, c.id),
        leadSource:!!(await definition(ctx.orgId,c,c.draftVersion)).leadImport,
      });
    } catch {}
  }
  return results;
}
export async function saveConnection(ctx: PlatformAuthContext, input: Obj) {
  manage(ctx);
  const prior = input.id ? await connection(ctx, input.id) : null;
  if (prior && prior.owner !== ctx.userId && prior.visibility === "personal")
    throw forbidden(
      "connection_owner",
      "Only the owner can change a personal connection.",
    );
  const key = prior?.id || id("conn");
  let draftVersion = prior?.draftVersion || "";
  if (input.definition) {
    const d = parseConnector(input.definition);
    await safeUrl(d.baseUrl);
    if (d.auth.kind === "oauth2") {
      await safeUrl(d.auth.authorizationUrl!);
      await safeUrl(d.auth.tokenUrl!);
    }
    draftVersion = contentHash(d);
    await immutable(ctx.orgId, "connector-version", `${key}:${draftVersion}`, {
      definition: d,
      version: draftVersion,
      createdAt: now(),
      author: ctx.userId,
    });
  }
  if (!draftVersion)
    throw badRequest(
      "connector_required",
      "A connector definition is required.",
    );
  const name = String(
    input.name || prior?.name || input.definition?.name || "Connection",
  )
    .trim()
    .slice(0, 120);
  const visibility = input.visibility || prior?.visibility || "organization";
  if (!["organization", "personal"].includes(visibility))
    throw badRequest(
      "connection_visibility",
      "Choose personal or organization.",
    );
  const logo =
    prior?.logo ||
    (!prior
      ? await (
          await import("./branding.js")
        ).findLogo(String(input.definition?.baseUrl || ""))
      : "");
  const c = {
    ...prior,
    name,
    logo,
    description: String(input.description ?? prior?.description ?? "").slice(
      0,
      3000,
    ),
    owner: prior?.owner || ctx.userId,
    visibility,
    grants: prior?.grants || {},
    enabled: prior?.enabled || false,
    enabledOperations: prior?.enabledOperations || [],
    activeVersion: prior?.activeVersion || "",
    draftVersion,
    createdAt: prior?.createdAt || now(),
  };
  return save(
    ctx.orgId,
    "connection",
    key,
    c,
    prior ? Number(input.expectedRevision) : 0,
  );
}
export async function activate(
  ctx: PlatformAuthContext,
  key: string,
  expected: number,
  enabledOperations: string[],
  grants: Obj = {},
) {
  manage(ctx);
  const c = await connection(ctx, key);
  if (c.revision !== expected)
    throw conflict("integration_revision", "Connection changed; reload it.");
  const d = await definition(ctx.orgId, c, c.draftVersion);
  if(d.leadImport)await (await import('./lead-intake.js')).authorizeLeadImport(ctx,d.leadImport.branchId);
  if (enabledOperations.some((o) => !d.operations.some((x) => x.id === o)))
    throw badRequest("connection_grants", "Unknown operation.");
  for (const [user, grant] of Object.entries(grants)) {
    if (!user || !grant || typeof grant !== "object")
      throw badRequest("connection_grants", "Invalid user grant.");
    for (const effect of ["read", "write"]) {
      const entries = object(grant)[effect] || [];
      if (
        !Array.isArray(entries) ||
        entries.some(
          (k) =>
            !enabledOperations.includes(k) ||
            !d.operations.some((o) => o.id === k && o.effect === effect),
        )
      )
        throw badRequest(
          "connection_grants",
          "Grant does not match an enabled operation.",
        );
    }
  }
  if (d.auth.kind !== "none" || d.credentialFields.length)
    await secrets(ctx.orgId, key, d);
  return save(
    ctx.orgId,
    "connection",
    key,
    {
      ...c,
      activeVersion: c.draftVersion,
      enabled: true,
      enabledOperations,
      grants,
    },
    expected,
  );
}
export async function pause(
  ctx: PlatformAuthContext,
  key: string,
  expected: number,
  disconnect = false,
) {
  manage(ctx);
  const c = await connection(ctx, key);
  const result = await save(
    ctx.orgId,
    "connection",
    key,
    { ...c, enabled: false },
    expected,
  );
  if (disconnect)
    await db()
      .prepare(
        "DELETE FROM integration_secrets WHERE organization_id=? AND connection_id=?",
      )
      .run(ctx.orgId, key);
  return result;
}
function template(value: any, inputs: Obj): any {
  if (Array.isArray(value)) return value.map((v) => template(v, inputs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, template(v, inputs)]),
    );
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{\{([A-Za-z0-9_.-]+)\}\}$/);
  if (exact) return at(inputs, exact[1]!) ?? null;
  return value.replace(/\{\{([A-Za-z0-9_.-]+)\}\}/g, (_, key) =>
    encodeURIComponent(String(at(inputs, key) ?? "")),
  );
}
const noBroker = {
  read: async () => {
    throw new Error("Connector transformations cannot read platform data.");
  },
  invoke: async () => {
    throw new Error("Connector transformations cannot invoke actions.");
  },
};
export async function execute(
  ctx: PlatformAuthContext,
  key: string,
  opId: string,
  input: Obj,
  options: { version?: string; receipt?: string; preview?: boolean } = {},
) {
  let c = await connection(ctx, key);
  const version =
    options.version || (options.preview ? c.draftVersion : c.activeVersion);
  const d = await definition(ctx.orgId, c, version);
  const op = d.operations.find((o) => o.id === opId);
  if (!op) throw badRequest("connection_operation", "Unknown operation.");
  if (options.preview) {
    manage(ctx);
    if (op.effect !== "read")
      throw forbidden(
        "connection_preview",
        "Setup previews may only use read operations.",
      );
  } else {
    c = await connection(ctx, key, opId, op.effect);
    if (c.activeVersion !== version)
      throw conflict(
        "connection_version_unavailable",
        "This connector version is no longer active.",
      );
  }
  validateValue(op.inputSchema, input);
  let credentials = await secrets(ctx.orgId, key, d);
  if (
    d.auth.kind === "oauth2" &&
    credentials.accessToken &&
    Number(credentials.expiresAt) < Date.now() + 60000
  )
    credentials = await (
      await import("./oauth.js")
    ).refreshOAuthCredentials(ctx, key, d);
  if (d.auth.kind === "oauth2" && !credentials.accessToken)
    throw conflict(
      "connection_oauth_required",
      "Complete OAuth authorization first.",
    );
  let request = template(op.request, input);
  if (op.requestCode) {
    const result = await runModuleCode(
      { source: op.requestCode, inputs: { input, request }, mode: "evaluate" },
      noBroker,
    );
    request = object(result.outputs.request);
  }
  const url = new URL(
    String(request.path || ""),
    d.baseUrl.endsWith("/") ? d.baseUrl : d.baseUrl + "/",
  );
  if (url.origin !== new URL(d.baseUrl).origin)
    throw forbidden(
      "connection_origin",
      "An operation cannot change the connection destination.",
    );
  for (const [k, v] of Object.entries(object(request.query)))
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  const method = String(request.method || op.request.method).toUpperCase();
  if (method !== op.request.method)
    throw forbidden(
      "connection_method",
      "An operation cannot change its declared HTTP method.",
    );
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [k, v] of Object.entries(object(request.headers))) {
    if (
      /^(authorization|proxy-authorization|host|cookie|connection|content-length|transfer-encoding)$/i.test(
        k,
      )
    )
      throw forbidden("connection_header", "Reserved header.");
    if (typeof v !== "string" || /[\r\n]/.test(k + v))
      throw badRequest("connection_header", "Invalid header.");
    headers[k] = v;
  }
  if (d.auth.kind === "bearer")
    headers.Authorization = `Bearer ${credentials.token}`;
  if (d.auth.kind === "header") headers[d.auth.header!] = credentials.token;
  if (d.auth.kind === "basic")
    headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
  if (d.auth.kind === "oauth2")
    headers.Authorization = `Bearer ${credentials.accessToken}`;
  if (op.idempotencyHeader && options.receipt)
    headers[op.idempotencyHeader] = options.receipt;
  let body: string | undefined;
  if (request.body !== undefined && request.body !== null) {
    body =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body);
    headers["Content-Type"] ||= "application/json";
    if (Buffer.byteLength(body!) > 1_000_000)
      throw badRequest("connection_body", "Request is too large.");
  }
  // Never persist inputs or provider error bodies: either may contain customer secrets.
  const runKey = options.receipt
    ? `external_${createHash("sha256").update(`${ctx.orgId}:${key}:${opId}:${options.receipt}`).digest("hex")}`
    : id("request");
  if (
    !(await claimRun(ctx.orgId, key, opId, runKey, {
      operation: opId,
      version,
    }))
  )
    throw conflict(
      "connection_outcome_uncertain",
      "This request was already dispatched; inspect its receipt before retrying.",
    );
  try {
    const result = await requestExternal(url.href, { method, headers, body });
    if (result.status < 200 || result.status >= 300)
      throw badRequest(
        "connection_remote_status",
        `External service returned HTTP ${result.status}.`,
      );
    let raw: any = result.body;
    try {
      raw = JSON.parse(result.body);
    } catch {}
    const safe = redact(raw, { ...credentials, basic: headers.Authorization });
    const transformed = await runModuleCode(
      {
        source: op.code,
        inputs: { input, response: safe, status: result.status },
        mode: "evaluate",
      },
      noBroker,
    );
    const value = redact(transformed.outputs.value, credentials);
    validateValue(op.outputSchema, value);
    await finishRun(runKey, "succeeded", {
      operation: opId,
      version,
      status: result.status,
    });
    return value;
  } catch (error) {
    await finishRun(runKey, op.effect === "write" ? "uncertain" : "failed", {
      operation: opId,
      version,
      message:
        "External request or transformation failed. Inspect configuration and retry reads; reconcile writes.",
    });
    throw error;
  }
}
export async function readResource(
  ctx: PlatformAuthContext,
  key: string,
  resourceId: string,
  args: Obj = {},
  revision?: string,
) {
  const c = await connection(ctx, key);
  const d = await definition(ctx.orgId, c);
  const r = d.resources.find((r) => r.id === resourceId);
  if (!r) throw badRequest("connection_resource", "Unknown resource.");
  await connection(ctx, key, r.operation, "read");
  if (r.mode === "live") {
    if (revision)
      throw conflict(
        "connection_history",
        "Live lookups cannot recreate a historical revision.",
      );
    return {
      value: await execute(ctx, key, r.operation, args),
      provenance: { connectionId: key, observedAt: now() },
    };
  }
  const state = await read(ctx.orgId, "resource", `${key}:${r.id}`);
  if (!revision && (!state || state.version !== c.activeVersion))
    return {
      status: "pending" as const,
      code: "connection_sync_required",
      message: "The first synchronization has not completed.",
    };
  const generation = revision || state!.generation;
  const snapshot = await read(
    ctx.orgId,
    "snapshot",
    `${key}:${r.id}:${generation}`,
  );
  if (!snapshot || snapshot.version !== c.activeVersion)
    throw conflict(
      "connection_history",
      "This retained revision is unavailable.",
    );
  const rows = await db()
    .prepare(
      "SELECT record_id,value_json FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=? ORDER BY record_id LIMIT 201",
    )
    .all(ctx.orgId, key, r.id, generation);
  if (rows.length > 200)
    throw badRequest(
      "connection_use_list",
      "Use paginated listing for this resource.",
    );
  return {
    value: rows.map((row) => JSON.parse(String(row.value_json))),
    revision: generation,
    provenance: {
      connectionId: key,
      observedAt: snapshot.observedAt,
      complete: true,
    },
  };
}
export async function listResource(
  ctx: PlatformAuthContext,
  key: string,
  resourceId: string,
  page: { limit: number; cursor?: string },
) {
  const c = await connection(ctx, key),
    d = await definition(ctx.orgId, c),
    r = d.resources.find((r) => r.id === resourceId);
  if (!r || r.mode !== "sync")
    throw badRequest(
      "connection_list",
      "This resource does not support local listing.",
    );
  await connection(ctx, key, r.operation);
  const state = await read(ctx.orgId, "resource", `${key}:${r.id}`);
  if (!page.cursor && (!state || state.version !== c.activeVersion))
    throw conflict(
      "connection_sync_required",
      "Synchronization has not completed.",
    );
  let generation = state?.generation,
    after = "";
  if (page.cursor) {
    try {
      const p = JSON.parse(Buffer.from(page.cursor, "base64url").toString());
      if (
        p.connection !== key ||
        p.resource !== r.id ||
        typeof p.after !== "string"
      )
        throw Error();
      generation = p.generation;
      after = p.after;
    } catch {
      throw badRequest("connection_cursor", "Invalid continuation cursor.");
    }
  }
  const snapshot = await read(
    ctx.orgId,
    "snapshot",
    `${key}:${r.id}:${generation}`,
  );
  if (!snapshot || snapshot.version !== c.activeVersion)
    throw conflict(
      "connection_history",
      "This revision is unavailable for the active connector.",
    );
  const rows = await db()
    .prepare(
      "SELECT record_id,value_json FROM integration_rows WHERE organization_id=? AND connection_id=? AND resource=? AND generation=? AND record_id>? ORDER BY record_id LIMIT ?",
    )
    .all(ctx.orgId, key, r.id, generation, after, page.limit + 1);
  const items = rows.slice(0, page.limit);
  return {
    items: items.map((x) => JSON.parse(String(x.value_json))),
    ...(rows.length > page.limit
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              connection: key,
              resource: r.id,
              generation,
              after: items.at(-1)!.record_id,
            }),
          ).toString("base64url"),
        }
      : {}),
  };
}
