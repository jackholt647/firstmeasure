import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../../src/config/env.js";
import { openSqlStore, type SqlStore } from "../sql_store.js";
import { badRequest, forbidden, conflict, notFound } from "../errors.js";
import type { AccessPolicy, ActionRef, Effect, ExecutionKind, InvocationOptions, JsonSchema, PublicationContext, TargetRef } from "./contracts.js";
import { authorizePublication } from "./context.js";
import { contentHash, jsonClone, validateJson } from "./validation.js";

export type ActionDefinition = {
  id: string; version: string; implementation: string; domain: string; description: string;
  inputSchema: JsonSchema; outputSchema: JsonSchema; effect: Effect;
  executionKinds: readonly ExecutionKind[]; policy: AccessPolicy;
  /** host is exclusively for compatibility runtimes that already own durable execution receipts. */
  idempotency: "none" | "required" | "host";
  /** Pure validation of refinements that JSON Schema cannot represent; runs before receipt acquisition. */
  validateInput?: (input: Record<string, unknown>) => void;
  execute: (ctx: PublicationContext, target: TargetRef, input: Record<string, unknown>, execution: { receiptId: string; idempotencyKey?: string }) => Promise<unknown> | unknown;
};
export type ActionDescription = Omit<ActionDefinition, "execute" | "validateInput" | "policy"> & { policy: Omit<AccessPolicy, "authorize"> };
const definitions = new Map<string, ActionDefinition>();
const latest = new Map<string, string>();
const fingerprints = new Map<string, string>();
let db: SqlStore | null = null;
let dbPath = "";
export async function closeActionDatabase() { const old = db; db = null; dbPath = ""; await old?.close(); }
function database() {
  const filename = path.resolve(process.cwd(), env.platformStorageRoot, "publication-actions.sqlite");
  if (db && dbPath === filename) return db;
  void closeActionDatabase(); dbPath = filename;
  db = openSqlStore({ id: "publication_actions", filename, schemaVersion: 1, initialize: async store => {
    await store.exec(`CREATE TABLE IF NOT EXISTS publication_action_receipts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT 'null', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  } });
  return db;
}
function describe(def: ActionDefinition): ActionDescription {
  const { execute: _execute, validateInput: _validateInput, policy, ...publicFields } = def;
  const { authorize: _authorize, ...publicPolicy } = policy;
  return jsonClone({ ...publicFields, policy: publicPolicy });
}
export function registerAction(definition: ActionDefinition): void {
  if (!definition.id || !definition.version || !definition.implementation) throw badRequest("action_identity_required", "An action needs an id, version and implementation identity.");
  if ((definition.effect === "write" || definition.effect === "external") && definition.idempotency === "none") throw badRequest("action_receipt_required", "Mutating actions require an execution receipt strategy.");
  const key = `${definition.id}@${definition.version}`;
  const fingerprint = contentHash({ ...describe(definition), handler: definition.execute.toString(), validation: definition.validateInput?.toString() || "", authorization: definition.policy.authorize?.toString() || "" });
  if (definitions.has(key)) {
    if (fingerprints.get(key) !== fingerprint) throw conflict("action_version_immutable", "A registered action version cannot change implementation or contract.");
    return;
  }
  // Copy serializable contracts so later caller mutations cannot change a registered version.
  const description = describe(definition);
  definitions.set(key, { ...description, policy: { ...description.policy, authorize: definition.policy.authorize }, execute: definition.execute, validateInput: definition.validateInput });
  fingerprints.set(key, fingerprint);
  latest.set(definition.id, definition.version);
}
export function describeAction(id: string, version?: string): ActionDescription | null {
  const def = definitions.get(`${id}@${version || latest.get(id)}`);
  return def ? describe(def) : null;
}
export function listActions(): ActionDescription[] { return [...definitions.values()].map(describe).sort((a,b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)); }

export async function authorizeAction(ctx: PublicationContext, ref: ActionRef): Promise<ActionDescription> {
  const def = definitions.get(`${ref.action}@${ref.version || latest.get(ref.action)}`);
  if (!def) throw notFound("action_not_found", "The requested action version is unavailable.");
  if (!def.executionKinds.includes(ctx.executionKind)) throw forbidden("action_execution_kind_denied", "This action is unavailable in this runtime.");
  if (ctx.mode !== "command" && (def.effect === "write" || def.effect === "external")) throw forbidden("action_effect_denied", "Evaluation cannot perform actions with side effects.");
  await authorizePublication(ctx, ref.target, def.policy, def.id);
  return describe(def);
}

/** Reading retained calculation evidence never executes the action. Read/compute
 * actions are data dependencies and must retain their current resource access. */
export async function authorizeActionResult(ctx: PublicationContext, ref: ActionRef) {
  const def = definitions.get(`${ref.action}@${ref.version || latest.get(ref.action)}`);
  if (!def) throw notFound("action_not_found", "The requested action version is unavailable.");
  if (def.effect === "read" || def.effect === "compute") await authorizePublication(ctx, ref.target, def.policy, def.id);
}

export async function invokeAction(ctx: PublicationContext, ref: ActionRef, input: unknown, options: InvocationOptions = {}) {
  const def = definitions.get(`${ref.action}@${ref.version || latest.get(ref.action)}`);
  if (!def) throw notFound("action_not_found", "The requested action version is unavailable.");
  if (options.expectedImplementation && options.expectedImplementation !== def.implementation) throw conflict("action_implementation_changed", "The pinned action implementation does not match.");
  await authorizeAction(ctx, ref);
  const clean = jsonClone(input);
  validateJson(def.inputSchema, clean, "action input");
  if (!clean || typeof clean !== "object" || Array.isArray(clean)) throw badRequest("action_input_object_required", "Action arguments must be a JSON object.");
  def.validateInput?.(clean as Record<string, unknown>);
  let receiptId = ctx.invocationId || randomUUID();
  let store: SqlStore | null = null;
  if (def.idempotency === "required" || (def.idempotency === "host" && options.idempotencyKey)) {
    if (!options.idempotencyKey || options.idempotencyKey.length > 512) throw badRequest("action_idempotency_required", "An idempotency key is required.");
    receiptId = contentHash({ organization: ctx.organizationId, action: def.id, version: def.version, target: ref.target, key: options.idempotencyKey });
    const requestHash = contentHash({ input: clean, implementation: def.implementation, principal: ctx.auth ? { userId: ctx.auth.userId } : { kind: ctx.system!.kind, projectId: ctx.system!.projectId || "" } });
    store = database();
    const now = new Date().toISOString();
    const inserted = await store.prepare("INSERT INTO publication_action_receipts(id,organization_id,request_hash,state,created_at,updated_at) VALUES(?,?,?,'running',?,?) ON CONFLICT(id) DO NOTHING").run(receiptId, ctx.organizationId, requestHash, now, now);
    if (!inserted.changes) {
      const previous = await store.prepare("SELECT * FROM publication_action_receipts WHERE id=? AND organization_id=?").get(receiptId, ctx.organizationId);
      if (!previous || previous.request_hash !== requestHash) throw conflict("action_idempotency_conflict", "This idempotency key was already used with different input.");
      if (previous.state !== "succeeded") throw conflict("action_outcome_uncertain", "This operation is running or its outcome requires reconciliation; it will not be repeated automatically.");
      return { value: JSON.parse(String(previous.result_json)), receipt: { id: receiptId, status: "succeeded" as const, replayed: true, action: def.id, version: def.version, implementation: def.implementation } };
    }
  }
  try {
    const value = jsonClone((await def.execute(ctx, ref.target, clean as Record<string, unknown>, { receiptId, ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}) })) ?? null);
    validateJson(def.outputSchema, value, "action output");
    if (store) await store.prepare("UPDATE publication_action_receipts SET state='succeeded',result_json=?,updated_at=? WHERE id=?").run(JSON.stringify(value), new Date().toISOString(), receiptId);
    return { value, receipt: { id: receiptId, status: "succeeded" as const, replayed: false, action: def.id, version: def.version, implementation: def.implementation } };
  } catch (error) {
    // A thrown error does not prove the effect did not happen (provider timeout, lost DB response).
    if (store) await store.prepare("UPDATE publication_action_receipts SET state='uncertain',updated_at=? WHERE id=?").run(new Date().toISOString(), receiptId).catch(() => undefined);
    throw error;
  }
}
