import path from "node:path";
import { env } from "../../src/config/env.js";
import { openSqlStore, type SqlStore } from "../sql_store.js";
import { badRequest, conflict, forbidden } from "../errors.js";
import { authorizeSource, authorizeSourceSnapshot, readPublishedData } from "./providers.js";
import { authorizeAction, describeAction, invokeAction } from "./actions.js";
import { contentHash, jsonClone, readPointer, validateJson } from "./validation.js";
import type { ActionBinding, BindingDefinition, CodeBinding, DataBinding, DataResult, InvocationOptions, PublicationContext, SourceRef } from "./contracts.js";

type Capture = { kind: "data" | "action" | "code"; value: unknown; capturedAt: string; digest: string };
export type CodeArtifact = { id: string; version: string; source: string; engine: string; digest: string; contract?: Record<string, unknown> };
export type CodeResolver = (id: string, version?: string) => Promise<CodeArtifact>;
let store: SqlStore | undefined;
function db() {
  return store ??= openSqlStore({ id: "publication_bindings", filename: path.resolve(process.cwd(), env.platformStorageRoot, "publication-bindings.sqlite"), initialize: async connection => {
    await connection.exec(`CREATE TABLE IF NOT EXISTS publication_binding_captures (
      organization_id TEXT NOT NULL, consumer_id TEXT NOT NULL, binding_name TEXT NOT NULL,
      definition_hash TEXT NOT NULL, capture_json TEXT NOT NULL,
      PRIMARY KEY (organization_id, consumer_id, binding_name, definition_hash))`);
  } });
}

function captureKey(ctx: PublicationContext, consumerId: string, name: string, definition: BindingDefinition) {
  if (!ctx.organizationId || !consumerId || !name || consumerId.length > 200 || name.length > 120) throw badRequest("binding_identity_invalid", "A consumer and named binding are required.");
  return [ctx.organizationId, consumerId, name, contentHash(definition)] as const;
}

async function savedCapture(key: readonly string[]): Promise<Capture | null> {
  const row = await db().prepare("SELECT capture_json FROM publication_binding_captures WHERE organization_id=? AND consumer_id=? AND binding_name=? AND definition_hash=?").get(...key);
  if (!row) return null;
  const capture = JSON.parse(String(row.capture_json)) as Capture;
  if (capture.digest !== contentHash(capture.value)) throw conflict("binding_capture_corrupt", "The retained binding failed its integrity check.");
  return capture;
}

async function retainCapture(key: readonly string[], kind: Capture["kind"], value: unknown): Promise<Capture> {
  const capture: Capture = { kind, value: jsonClone(value), capturedAt: new Date().toISOString(), digest: contentHash(value) };
  // Atomic first-writer-wins, on both local SQLite and shared PostgreSQL. Never
  // hold a database transaction while fetching a provider or performing an action.
  await db().prepare("INSERT INTO publication_binding_captures (organization_id,consumer_id,binding_name,definition_hash,capture_json) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING").run(...key, JSON.stringify(capture));
  return (await savedCapture(key))!;
}

type DataLoader = (ref: SourceRef) => Promise<DataResult>;
async function dataBindingResult(ctx: PublicationContext, consumerId: string, name: string, binding: DataBinding, load: DataLoader): Promise<DataResult> {
  await authorizeSource(ctx, binding.source); // Authorization is checked even on frozen replay.
  if (binding.policy === "live") return await load(binding.source);
  if (binding.policy !== "frozen") throw badRequest("binding_policy_invalid", "Binding policy must be live or frozen.");
  const key = captureKey(ctx, consumerId, name, binding);
  const existing = await savedCapture(key);
  if (existing) {
    const result = existing.value as DataResult;
    if (existing.kind !== "data" || result.status !== "ready") throw conflict("binding_capture_invalid", "The frozen data binding is invalid.");
    await authorizeSourceSnapshot(ctx, binding.source, result);
    return jsonClone(result);
  }
  const result = await load(binding.source);
  // Transient errors and optional absence are not permanent snapshots.
  if (result.status !== "ready") return result;
  const retained = (await retainCapture(key, "data", result)).value as Extract<DataResult, { status: "ready" }>;
  // A different authorized caller may win the first capture. Recheck the actual
  // retained subjects, not just the values this caller fetched locally.
  await authorizeSourceSnapshot(ctx, binding.source, retained);
  return jsonClone(retained);
}

export async function resolveDataBinding(ctx: PublicationContext, consumerId: string, name: string, binding: DataBinding): Promise<DataResult> {
  return dataBindingResult(ctx, consumerId, name, binding, ref => readPublishedData(ctx, ref));
}

export async function resolveActionBinding(ctx: PublicationContext, consumerId: string, name: string, binding: ActionBinding) {
  const key = captureKey(ctx, consumerId, name, binding);
  if (binding.policy !== "live" && binding.policy !== "frozen") throw badRequest("binding_policy_invalid", "Binding policy must be live or frozen.");
  const prior = binding.policy === "frozen" ? await savedCapture(key) : null;
  const current = describeAction(binding.action.action, binding.action.version);
  if (!prior && !current) throw badRequest("action_version_unavailable", "The requested action implementation is unavailable.");
  const resolved = prior?.value as { action: string; version: string; implementation: string; effect: string } | undefined
    || { action: current!.id, version: current!.version, implementation: current!.implementation, effect: current!.effect };
  await authorizeAction(ctx, { action: resolved.action, version: resolved.version, target: binding.action.target });
  const selected = binding.policy === "frozen" && !prior ? (await retainCapture(key, "action", resolved)).value as typeof resolved : resolved;
  const available = describeAction(selected.action, selected.version);
  if (!available || available.implementation !== selected.implementation) throw conflict("action_version_unavailable", "The pinned action implementation is unavailable; latest will not be substituted.");
  await authorizeAction(ctx, { action: selected.action, version: selected.version, target: binding.action.target });
  return { ...selected, target: jsonClone(binding.action.target) };
}

export async function invokeActionBinding(ctx: PublicationContext, consumerId: string, name: string, binding: ActionBinding, input: unknown, options: InvocationOptions = {}) {
  const action = await resolveActionBinding(ctx, consumerId, name, binding);
  return invokeAction(ctx, { action: action.action, version: action.version, target: action.target }, input, { ...options, expectedImplementation: action.implementation });
}

export async function resolveCodeBinding(ctx: PublicationContext, consumerId: string, name: string, binding: CodeBinding, resolver: CodeResolver): Promise<CodeArtifact> {
  const key = captureKey(ctx, consumerId, name, binding);
  if (binding.policy !== "live" && binding.policy !== "frozen") throw badRequest("binding_policy_invalid", "Binding policy must be live or frozen.");
  const prior = binding.policy === "frozen" ? await savedCapture(key) : null;
  if (prior) {
    // Resolver must authorize the source, even when retained source code is used.
    const captured = prior.value as CodeArtifact;
    validateArtifact(captured, binding.moduleId);
    if (prior.kind !== "code") throw conflict("binding_capture_invalid", "The frozen code binding is invalid.");
    await resolver(captured.id, captured.version);
    return jsonClone(captured);
  }
  const artifact = jsonClone(await resolver(binding.moduleId, binding.version));
  validateArtifact(artifact, binding.moduleId);
  if (binding.version && artifact.version !== binding.version) throw conflict("code_version_unavailable", "The requested code version is unavailable.");
  if (binding.policy === "live") return artifact;
  return jsonClone((await retainCapture(key, "code", artifact)).value as CodeArtifact);
}

function validateArtifact(artifact: CodeArtifact, id: string) {
  validateJson({ type: "object", required: ["id", "version", "source", "engine", "digest"], additionalProperties: false,
    properties: { id: { type: "string", minLength: 1 }, version: { type: "string", minLength: 1 }, source: { type: "string", maxLength: 128000 }, engine: { type: "string", minLength: 1 }, digest: { type: "string", minLength: 1 }, contract: { type: "object" } }
  }, artifact, "code artifact");
  if (artifact.id !== id || artifact.digest !== contentHash({ source: artifact.source, engine: artifact.engine })) throw conflict("code_artifact_invalid", "The code artifact identity or integrity is invalid.");
}

/** One evaluation sees each live export once, including fields selected from it.
 * Freeze related values as one dataset/object binding for an atomic group capture.
 * Separate field bindings deliberately retain their independent capture histories.
 */
export function createBindingSession(ctx: PublicationContext, consumerId: string, definitions: Record<string, BindingDefinition>) {
  const bindings = jsonClone(definitions);
  const reads = new Map<string, Promise<DataResult>>();
  const evidence = new Map<string, unknown>();
  const load: DataLoader = async ref => {
    const { path: pointer, ...wholeRef } = ref;
    const key = contentHash(wholeRef);
    let pending = reads.get(key);
    if (!pending) { pending = readPublishedData(ctx, wholeRef); reads.set(key, pending); }
    const result = await pending;
    if (result.status !== "ready" || !pointer) return result;
    const value = readPointer(result.value, pointer);
    return value === undefined ? { status: "missing", code: "source_path_missing", message: "The published field is absent." }
      : { ...result, value: jsonClone(value), source: { ...result.source, path: pointer } };
  };
  const named = (name: string, kind: BindingDefinition["kind"]) => {
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    if (!binding || binding.kind !== kind) throw forbidden("module_binding_denied", "This module has not declared that binding.");
    return binding;
  };
  let calls = 0;
  return {
    async readResult(name: string) {
      const binding = named(name, "data") as DataBinding;
      const result = await dataBindingResult(ctx, consumerId, name, binding, load);
      evidence.set(name, { kind: "data", policy: binding.policy, result });
      return jsonClone(result);
    },
    async read(name: string) {
      const binding = named(name, "data") as DataBinding;
      const result = await this.readResult(name);
      if (result.status === "ready") return result.value;
      if (result.status === "missing" && binding.required === false) return null;
      throw badRequest(`binding_${result.status}`, result.message, { binding: name, code: result.code });
    },
    async invoke(name: string, input: unknown) {
      const binding = named(name, "action") as ActionBinding;
      const action = await resolveActionBinding(ctx, consumerId, name, binding);
      if (["write", "external"].includes(action.effect) && (!ctx.invocationId || ctx.mode !== "command")) throw forbidden("module_effect_denied", "Effects require an explicit command execution identity.");
      const options = ctx.invocationId ? { idempotencyKey: `${ctx.invocationId}:${name}:${calls++}` } : {};
      const result = await invokeActionBinding(ctx, consumerId, name, binding, input, options);
      evidence.set(`${name}:${calls}`, { kind: "action", policy: binding.policy, action, receipt: result.receipt });
      return result.value;
    },
    manifest() { return jsonClone(Object.fromEntries(evidence)); }
  };
}

export async function closeBindingStoreForTests() { if (store) await store.close(); store = undefined; }
