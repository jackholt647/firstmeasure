import { z } from "zod";
import { assertSafeTenantSchema } from "../platform/publication/tenant-schema.js";
import { validateJson } from "../platform/publication/validation.js";

export type Obj = Record<string, any>;
export const object = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const schema = z.record(z.unknown()).default({});
const request = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    path: z.string().min(1).max(2000),
    headers: z.record(z.string().max(2000)).default({}),
    query: z.record(z.unknown()).default({}),
    body: z.unknown().optional(),
  })
  .strict();
export const connectorSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(4000).default(""),
    baseUrl: z.string().url().max(2000),
    auth: z
      .object({
        kind: z.enum(["none", "bearer", "header", "basic", "oauth2"]),
        header: z
          .string()
          .regex(/^[A-Za-z0-9-]+$/)
          .optional(),
        authorizationUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
        scopes: z.array(z.string()).max(30).default([]),
      })
      .strict(),
    credentialFields: z
      .array(
        z
          .object({
            key,
            label: z.string().min(1).max(100),
            secret: z.boolean().default(true),
            required: z.boolean().default(true),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    operations: z
      .array(
        z
          .object({
            id: key,
            title: z.string().min(1).max(160),
            description: z.string().max(4000).default(""),
            effect: z.enum(["read", "write"]),
            inputSchema: schema,
            outputSchema: schema,
            request,
            code: z
              .string()
              .max(64000)
              .default("return { outputs: { value: inputs.response } };"),
            requestCode: z.string().max(64000).optional(),
            idempotencyHeader: z
              .string()
              .regex(/^[A-Za-z0-9-]+$/)
              .optional(),
          })
          .strict(),
      )
      .min(0)
      .max(60),
    resources: z
      .array(
        z
          .object({
            id: key,
            title: z.string().min(1).max(160),
            description: z.string().max(4000).default(""),
            operation: key,
            schema,
            mode: z.enum(["live", "sync"]).default("sync"),
            itemsPath: z.string().max(300).default(""),
            idPath: z.string().max(300).default("id"),
            cursorPath: z.string().max(300).default(""),
            cursorInput: key.default("cursor"),
            checkpointPath: z.string().max(300).default(""),
            checkpointInput: key.default("since"),
            syncMode: z.enum(["snapshot", "incremental"]).default("snapshot"),
            deletedPath: z.string().max(300).default(""),
            intervalSeconds: z.number().int().min(60).max(604800).default(300),
          })
          .strict(),
      )
      .max(40)
      .default([]),
    notes: z.string().max(12000).default(""),
    leadImport:z.object({
      mode:z.enum(["webhook","resource"]),resource:key.optional(),branchId:z.string().min(1).max(120).default("default"),
      externalIdPath:z.string().max(300).default("id"),provider:z.string().max(160).default(""),
      code:z.string().max(64000).default("const {id,...lead}=inputs.record; return {outputs:{lead}};"),
      notificationRoleIds:z.array(z.string().max(120)).max(50).optional(),
    }).strict().optional(),
    webhook: z
      .object({
        secretField: key,
        verification:z.enum(["hmac_sha256","header_token","body_token"]).default("hmac_sha256"),
        tokenPath:z.string().max(300).default("google_key"),
        defaultEvent:z.string().regex(/^[a-zA-Z0-9_.-]+$/).optional(),
        testPath:z.string().max(300).default("is_test"),
        signatureHeader: z
          .string()
          .regex(/^[a-zA-Z0-9-]+$/)
          .default("x-webhook-signature"),
        eventIdPath: z.string().max(300).default("id"),
        eventTypePath: z.string().max(300).default("type"),
        projectIdPath: z.string().max(300).default(""),
        allowedEvents: z
          .array(z.string().regex(/^[a-zA-Z0-9_.-]+$/))
          .min(1)
          .max(30),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Connector = z.infer<typeof connectorSchema>;
export function parseConnector(raw: unknown): Connector {
  const c = connectorSchema.parse(raw);
  if(!c.operations.length&&!c.webhook)throw new Error("Declare an operation or webhook.");
  if(c.leadImport?.mode==="webhook"&&!c.webhook)throw new Error("Webhook lead intake requires a webhook.");
  if(c.leadImport?.mode==="resource"&&!c.resources.some(r=>r.id===c.leadImport?.resource&&r.mode==="sync"))throw new Error("Polling lead intake requires a synchronized resource.");
  if(c.webhook?.defaultEvent&&!c.webhook.allowedEvents.includes(c.webhook.defaultEvent))throw new Error("The default webhook event must be allowed.");
  for (const entries of [c.operations, c.resources])
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error("Identifiers must be unique.");
  if (
    new Set(c.credentialFields.map((f) => f.key)).size !==
    c.credentialFields.length
  )
    throw new Error("Credential fields must be unique.");
  for (const op of c.operations)
    for (const s of [op.inputSchema, op.outputSchema])
      assertSafeTenantSchema(s);
  for (const r of c.resources) {
    assertSafeTenantSchema(r.schema);
    if (!c.operations.some((o) => o.id === r.operation && o.effect === "read"))
      throw new Error("A resource must reference a read operation.");
  }
  if (c.auth.kind === "header" && !c.auth.header)
    throw new Error("An authentication header is required.");
  if (
    c.auth.header &&
    /^(host|cookie|connection|content-length|transfer-encoding|proxy-authorization)$/i.test(
      c.auth.header,
    )
  )
    throw new Error("Reserved authentication header.");
  const required =
    c.auth.kind === "basic"
      ? ["username", "password"]
      : ["bearer", "header"].includes(c.auth.kind)
        ? ["token"]
        : c.auth.kind === "oauth2"
          ? ["clientId", "clientSecret"]
          : [];
  for (const name of required)
    if (!c.credentialFields.some((f) => f.key === name))
      throw new Error(`Credential field ${name} is required.`);
  if (
    c.auth.kind === "oauth2" &&
    (!c.auth.authorizationUrl || !c.auth.tokenUrl)
  )
    throw new Error("OAuth authorization and token URLs are required.");
  if (
    c.webhook &&
    !c.credentialFields.some(
      (f) => f.key === c.webhook!.secretField && f.secret,
    )
  )
    throw new Error(
      "Declare a secret credential field for webhook verification.",
    );
  return c;
}
export function validateValue(s: Obj, value: unknown) {
  validateJson(s, value, "connection value");
}
export function at(value: any, path: string): any {
  return path
    ? path
        .split(".")
        .reduce(
          (v, k) =>
            v != null && Object.hasOwn(Object(v), k) ? v[k] : undefined,
          value,
        )
    : value;
}
export const automationSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1).max(180),
    description: z.string().max(3000).default(""),
    enabled: z.boolean().default(false),
    events: z.array(z.string().min(1).max(150)).max(30).default([]),
    projectId: z.string().max(200).default(""),
    intervalSeconds: z.number().int().min(60).max(604800).optional(),
    conditions: z.record(z.unknown()).default({}),
    settings: z.record(z.unknown()).default({}),
    source: z.string().min(1).max(128000),
    bindings: z.record(z.unknown()),
    expectedRevision: z.number().int().optional(),
  })
  .strict();
