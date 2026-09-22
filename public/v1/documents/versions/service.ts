import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, type SqlStore } from "../../platform/sql_store.js";
import { gunzipSync, gzipSync } from "node:zlib";

import { env } from "../../src/config/env.js";
import { badRequest, notFound } from "../../platform/errors.js";
import type { JsonObject } from "../../platform/storage.js";
import type { PlatformAuthContext } from "../../platform/auth.js";
import { FMDocModel } from "../schemas.js";
import {
  readDocumentInstance,
  readDocumentTemplateVersion,
  recordDocumentEvent
} from "../storage.js";

/**
 * Document version history (roadmap Tranche D "Version history browser").
 *
 * Storage policy (agreed with the owner in docs/doc-editor-parity-roadmap.md):
 * CHECKPOINT-based, never per-keystroke. A checkpoint freezes the document's
 * WORKING definition — the pinned/current template definition with the
 * instance's override ops applied, BEFORE binding/widget resolution — which is
 * exactly what the editor edits and what carries the stable node/block ids.
 * Definitions are small JSON; media rides by reference ({media_id, variant})
 * and is never duplicated, so a checkpoint costs a few KB gzipped.
 *
 * This deliberately does NOT reuse document_snapshots: snapshots are frozen
 * customer-facing renders (post-binding resolved_definition + widget_data +
 * theme + public_token + pdf refs) and are expensive to produce. It also does
 * not reuse document_template_versions, which version ASSETS on publish, not
 * per-document edit history. The platform JSON store's collection list is a
 * closed union, so checkpoints use the shared PostgreSQL pool in clustered environments, with
 * a local SQLite backend for development. Compressed definitions use BYTEA.
 */

export type CheckpointReason = "manual" | "send" | "publish" | "auto";

export const CHECKPOINT_REASONS: CheckpointReason[] = ["manual", "send", "publish", "auto"];

/** Auto-checkpoint retention: keep the newest N autos unconditionally... */
export const AUTO_KEEP_RECENT = 10;
/** ...then one auto per day for this many days; older autos are deleted. */
export const AUTO_KEEP_DAILY_DAYS = 30;

export type CheckpointSummary = {
  id: string;
  doc_id: string;
  organization_id: string;
  name: string;
  reason: CheckpointReason;
  actor_id: string;
  size_bytes: number;
  checksum: string;
  created_at: string;
};

export type CheckpointDetail = CheckpointSummary & { definition: JsonObject };

export type WordDiffSegment = { type: "same" | "add" | "del"; text: string };

export type CheckpointDiff = {
  added_blocks: Array<{ node_id: string; block_id: string; text: string }>;
  removed_blocks: Array<{ node_id: string; block_id: string; text: string }>;
  changed_blocks: Array<{
    node_id: string;
    block_id: string;
    before_text: string;
    after_text: string;
    word_diff: WordDiffSegment[];
  }>;
  other_changes: number;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

export function newCheckpointId() {
  return `docchk_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// ---------------------------------------------------------------------------
// SQLite (module-owned, same conventions as equipment/agents storage)
// ---------------------------------------------------------------------------

let database: SqlStore | null = null;
let databasePath = "";

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "document_versions.sqlite");
}

export async function closeDocumentCheckpointsDatabase() {
  await database?.close(); database = null; databasePath = "";
}
export function getDocumentCheckpointsDatabase(): SqlStore {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  if (database) throw new Error("Close document checkpoints before changing their directory.");
  database = openSqlStore({ id: "document-checkpoints", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}
async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS document_checkpoints (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT 'manual',
      actor_id TEXT NOT NULL DEFAULT '',
      definition_json ${db.isPostgres ? "BYTEA" : "BLOB"} NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_document_checkpoints_doc
      ON document_checkpoints (organization_id, doc_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_document_checkpoints_reason
      ON document_checkpoints (organization_id, doc_id, reason, created_at);
  `));
}

function rowToSummary(row: JsonObject): CheckpointSummary {
  return {
    id: cleanText(row.id),
    doc_id: cleanText(row.doc_id),
    organization_id: cleanText(row.organization_id),
    name: cleanText(row.name),
    reason: (cleanText(row.reason) || "manual") as CheckpointReason,
    actor_id: cleanText(row.actor_id),
    size_bytes: Number(row.size_bytes || 0),
    checksum: cleanText(row.checksum),
    created_at: cleanText(row.created_at)
  };
}

function decodeDefinition(value: unknown): JsonObject {
  if (value === null || value === undefined) return {};
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
  // Definitions are stored gzip-compressed; tolerate plain JSON for safety.
  let text: string;
  try {
    text = gunzipSync(buffer).toString("utf8");
  } catch {
    text = buffer.toString("utf8");
  }
  try {
    return asObject(JSON.parse(text));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Working definition (mirrors service.ts templateDefinitionFor + applyOverrides
// — that helper is private to service.ts, and this module cannot edit existing
// files, so the small draft-follows-current / sent-keeps-pin rule is mirrored
// here with a pointer back to the original).
// ---------------------------------------------------------------------------

async function templateDefinitionFor(orgId: string, documentValue: JsonObject): Promise<JsonObject> {
  const templateRef = asObject(documentValue.template_ref);
  const templateId = cleanText(templateRef.template_id);
  if (templateId) {
    const pinned = Number(templateRef.version || 0) || undefined;
    const isDraft = cleanText(documentValue.status) === "draft" || !cleanText(documentValue.status);
    const version = isDraft ? undefined : pinned;
    const templateVersion = await readDocumentTemplateVersion(orgId, templateId, version).catch(() => null);
    const definition = asObject(asObject(templateVersion).definition);
    if (Object.keys(definition).length) return definition;
  }
  const fallback = (FMDocModel.createBlankDocument || FMDocModel.createDocument)({
    metadata: { document_type: cleanText(documentValue.document_type) }
  });
  return asObject(fallback);
}

/** The live editable definition: template definition + instance override ops. */
export async function currentWorkingDefinition(orgId: string, documentValue: JsonObject): Promise<JsonObject> {
  const definition = await templateDefinitionFor(orgId, documentValue);
  const applied = FMDocModel.applyOverrides(definition, asArray(documentValue.overrides));
  return asObject(applied.document);
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export async function createCheckpoint(
  orgId: string,
  docId: string,
  input: { name?: string; reason?: string } = {},
  actor: PlatformAuthContext | null
): Promise<CheckpointSummary> {
  const reason = (cleanText(input.reason) || "manual") as CheckpointReason;
  if (!CHECKPOINT_REASONS.includes(reason)) {
    throw badRequest("document_checkpoint_reason_invalid", `reason must be one of: ${CHECKPOINT_REASONS.join(", ")}.`);
  }
  const document = await readDocumentInstance(orgId, docId); // 404s across orgs
  const definition = await currentWorkingDefinition(orgId, document);
  const json = JSON.stringify(definition);
  const checksum = createHash("sha256").update(json).digest("hex");
  const id = newCheckpointId();
  const createdAt = nowIso();
  const db = getDocumentCheckpointsDatabase();
  (await db.prepare(`
    INSERT INTO document_checkpoints (id, organization_id, doc_id, name, reason, actor_id, definition_json, size_bytes, checksum, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    orgId,
    docId,
    cleanText(input.name).slice(0, 200),
    reason,
    actor?.userId || "",
    gzipSync(Buffer.from(json, "utf8")),
    Buffer.byteLength(json, "utf8"),
    checksum,
    createdAt
  ));
  if (reason === "auto") {
    (await pruneAutoCheckpoints(orgId, docId));
  } else {
    // Named/send/publish checkpoints join the document's audit trail (no work
    // engine emission — checkpoints are an editor concern, not a workflow one).
    await recordDocumentEvent(orgId, document, "document.checkpoint_created", {
      checkpoint_id: id,
      reason,
      name: cleanText(input.name)
    }, actor, { emit: false }).catch(() => null);
  }
  return rowToSummary({
    id,
    organization_id: orgId,
    doc_id: docId,
    name: cleanText(input.name).slice(0, 200),
    reason,
    actor_id: actor?.userId || "",
    size_bytes: Buffer.byteLength(json, "utf8"),
    checksum,
    created_at: createdAt
  });
}

/**
 * Retention for reason:"auto" (manual/send/publish rows are kept forever):
 *   1. the AUTO_KEEP_RECENT newest autos always survive;
 *   2. older autos collapse to one per UTC day (the newest of each day) for
 *      AUTO_KEEP_DAILY_DAYS days;
 *   3. autos older than that are deleted.
 * Runs as a prune step inside createCheckpoint for auto checkpoints.
 */
export async function pruneAutoCheckpoints(orgId: string, docId: string, now = Date.now()) {
  const db = getDocumentCheckpointsDatabase();
  const rows = (await db.prepare(`
    SELECT id, created_at FROM document_checkpoints
    WHERE organization_id = ? AND doc_id = ? AND reason = 'auto'
    ORDER BY created_at DESC, id DESC
  `).all(orgId, docId)) as Array<{ id: string; created_at: string }>;
  const cutoff = now - AUTO_KEEP_DAILY_DAYS * 24 * 60 * 60 * 1000;
  const doomed: string[] = [];
  const seenDays = new Set<string>();
  rows.forEach((row, index) => {
    if (index < AUTO_KEEP_RECENT) return;
    const createdMs = Date.parse(row.created_at);
    if (!Number.isFinite(createdMs) || createdMs < cutoff) {
      doomed.push(row.id);
      return;
    }
    const day = row.created_at.slice(0, 10);
    if (seenDays.has(day)) doomed.push(row.id);
    else seenDays.add(day);
  });
  if (doomed.length) {
    const remove = db.prepare("DELETE FROM document_checkpoints WHERE id = ?");
    for (const id of doomed) (await remove.run(id));
  }
  return doomed.length;
}

/** Checkpoint rows without their definitions, newest first. */
export async function listCheckpoints(orgId: string, docId: string): Promise<CheckpointSummary[]> {
  await readDocumentInstance(orgId, docId); // 404s across orgs
  const db = getDocumentCheckpointsDatabase();
  const rows = (await db.prepare(`
    SELECT id, organization_id, doc_id, name, reason, actor_id, size_bytes, checksum, created_at
    FROM document_checkpoints
    WHERE organization_id = ? AND doc_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(orgId, docId)) as JsonObject[];
  return rows.map(rowToSummary);
}

/**
 * One checkpoint with its definition. "current" resolves to the live working
 * definition (same shape, synthetic row).
 */
export async function getCheckpoint(orgId: string, docId: string, checkpointId: string): Promise<CheckpointDetail> {
  const document = await readDocumentInstance(orgId, docId); // 404s across orgs
  if (cleanText(checkpointId) === "current") {
    const definition = await currentWorkingDefinition(orgId, document);
    return {
      id: "current",
      doc_id: docId,
      organization_id: orgId,
      name: "Current document",
      reason: "manual",
      actor_id: "",
      size_bytes: Buffer.byteLength(JSON.stringify(definition), "utf8"),
      checksum: "",
      created_at: cleanText(document.updated_at) || nowIso(),
      definition
    };
  }
  const db = getDocumentCheckpointsDatabase();
  const row = (await db.prepare(`
    SELECT * FROM document_checkpoints
    WHERE organization_id = ? AND doc_id = ? AND id = ?
  `).get(orgId, docId, cleanText(checkpointId))) as JsonObject | undefined;
  if (!row) throw notFound("document_checkpoint_not_found", "The requested checkpoint was not found.");
  return { ...rowToSummary(row), definition: decodeDefinition(row.definition_json) };
}

// ---------------------------------------------------------------------------
// Block-level structural diff over stable DocModel node/block ids
// ---------------------------------------------------------------------------

type TextBlock = { node_id: string; block_id: string; text: string };

function blockText(block: JsonObject) {
  return asArray(block.runs).map((run) => String(asObject(run).text ?? "")).join("");
}

/**
 * Every text block in the definition keyed by "nodeId::blockId", in document
 * walk order (pages -> children, depth-first; view docs walk root.children).
 */
function collectTextBlocks(definition: JsonObject) {
  const order: string[] = [];
  const map = new Map<string, TextBlock>();
  const visitNode = (node: unknown) => {
    const value = asObject(node);
    if (cleanText(value.type) === "text") {
      const nodeId = cleanText(value.id);
      for (const blockValue of asArray(asObject(value.props).blocks)) {
        const block = asObject(blockValue);
        const blockId = cleanText(block.id);
        if (!nodeId || !blockId) continue;
        const key = `${nodeId}::${blockId}`;
        if (map.has(key)) continue;
        map.set(key, { node_id: nodeId, block_id: blockId, text: blockText(block) });
        order.push(key);
      }
    }
    for (const child of asArray(value.children)) visitNode(child);
  };
  for (const page of asArray(definition.pages)) {
    for (const child of asArray(asObject(page).children)) visitNode(child);
  }
  // kind:"view" documents keep their tree under root.children.
  for (const child of asArray(asObject(definition.root).children)) visitNode(child);
  return { order, map };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

type EntitySignature = { sig: string; isText: boolean };

/**
 * Structural signatures for the "other changes" count: the doc root (minus
 * pages), each page (children collapsed to ids), and each node (children
 * collapsed to ids; text nodes drop their blocks — text edits are reported
 * block-by-block, not here).
 */
function collectEntitySignatures(definition: JsonObject) {
  const map = new Map<string, EntitySignature>();
  const visitNode = (node: unknown) => {
    const value = asObject(node);
    const id = cleanText(value.id);
    const isText = cleanText(value.type) === "text";
    if (id) {
      const stripped: JsonObject = {
        ...value,
        children: asArray(value.children).map((child) => cleanText(asObject(child).id))
      };
      if (isText) stripped.props = { ...asObject(value.props), blocks: undefined };
      map.set(`node:${id}`, { sig: stableStringify(stripped), isText });
    }
    for (const child of asArray(value.children)) visitNode(child);
  };
  for (const page of asArray(definition.pages)) {
    const value = asObject(page);
    const id = cleanText(value.id);
    if (id) {
      map.set(`page:${id}`, {
        sig: stableStringify({ ...value, children: asArray(value.children).map((child) => cleanText(asObject(child).id)) }),
        isText: false
      });
    }
    for (const child of asArray(value.children)) visitNode(child);
  }
  for (const child of asArray(asObject(definition.root).children)) visitNode(child);
  map.set("doc:root", { sig: stableStringify({ ...definition, pages: undefined, root: undefined }), isText: false });
  return map;
}

/** Simple LCS word diff over whitespace tokens (no dependencies). */
export function wordDiff(before: string, after: string): WordDiffSegment[] {
  const a = cleanText(before) ? cleanText(before).split(/\s+/) : [];
  const b = cleanText(after) ? cleanText(after).split(/\s+/) : [];
  const segments: WordDiffSegment[] = [];
  const push = (type: WordDiffSegment["type"], token: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += ` ${token}`;
    else segments.push({ type, text: token });
  };
  // Guard pathological inputs: fall back to a coarse replace instead of an
  // O(n*m) table over huge documents.
  if (a.length * b.length > 1_000_000) {
    if (a.length) segments.push({ type: "del", text: a.join(" ") });
    if (b.length) segments.push({ type: "add", text: b.join(" ") });
    return segments;
  }
  // LCS length table (a.length+1 x b.length+1); table[i*cols+j] is the LCS of
  // the suffixes a[i..] / b[j..].
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  const at = (i: number, j: number) => table[i * cols + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j]
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const tokenA = a[i] ?? "";
    const tokenB = b[j] ?? "";
    if (tokenA === tokenB) {
      push("same", tokenA);
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      push("del", tokenA);
      i += 1;
    } else {
      push("add", tokenB);
      j += 1;
    }
  }
  while (i < a.length) push("del", a[i++] ?? "");
  while (j < b.length) push("add", b[j++] ?? "");
  return segments;
}

export function diffDefinitions(before: JsonObject, after: JsonObject): CheckpointDiff {
  const a = collectTextBlocks(before);
  const b = collectTextBlocks(after);
  const added: CheckpointDiff["added_blocks"] = [];
  const removed: CheckpointDiff["removed_blocks"] = [];
  const changed: CheckpointDiff["changed_blocks"] = [];
  for (const key of b.order) {
    if (!a.map.has(key)) {
      const block = b.map.get(key)!;
      added.push({ node_id: block.node_id, block_id: block.block_id, text: block.text });
    }
  }
  for (const key of a.order) {
    const beforeBlock = a.map.get(key)!;
    const afterBlock = b.map.get(key);
    if (!afterBlock) {
      removed.push({ node_id: beforeBlock.node_id, block_id: beforeBlock.block_id, text: beforeBlock.text });
      continue;
    }
    if (beforeBlock.text !== afterBlock.text) {
      changed.push({
        node_id: beforeBlock.node_id,
        block_id: beforeBlock.block_id,
        before_text: beforeBlock.text,
        after_text: afterBlock.text,
        word_diff: wordDiff(beforeBlock.text, afterBlock.text)
      });
    }
  }
  // Non-text structural changes: added/removed/changed pages + nodes and
  // doc-level fields. Text-node adds/removes are excluded — their content is
  // already reported through added_blocks/removed_blocks.
  const entitiesA = collectEntitySignatures(before);
  const entitiesB = collectEntitySignatures(after);
  let otherChanges = 0;
  for (const [key, entity] of entitiesA) {
    const other = entitiesB.get(key);
    if (!other) {
      if (!entity.isText) otherChanges += 1;
    } else if (other.sig !== entity.sig) {
      otherChanges += 1;
    }
  }
  for (const [key, entity] of entitiesB) {
    if (!entitiesA.has(key) && !entity.isText) otherChanges += 1;
  }
  return { added_blocks: added, removed_blocks: removed, changed_blocks: changed, other_changes: otherChanges };
}

/**
 * Diff two checkpoints of a document (a -> b). Either id may be "current",
 * meaning the live working definition.
 */
export async function diffCheckpoints(orgId: string, docId: string, aId: string, bId: string): Promise<CheckpointDiff> {
  const a = await getCheckpoint(orgId, docId, aId);
  const b = await getCheckpoint(orgId, docId, bId);
  return diffDefinitions(a.definition, b.definition);
}
