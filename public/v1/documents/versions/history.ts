import { createHash } from "node:crypto";
import path from "node:path";

import { env } from "../../src/config/env.js";
import { openSqlStore, type SqlStore } from "../../platform/sql_store.js";
import type { ChangeSource } from "../../history/source.js";
import { CURRENT_ENCODING, REVISION_FORMAT, decodePayload, encodePayload } from "./codec.js";
import { applyPatch, diffJson, stableStringify, touchedSections, type PatchOp } from "./patch.js";

/**
 * The revision log every document system writes through
 * (docs/architecture/document-history.md).
 *
 * A subject (a document, a template, a theme, a workflow) has revisions
 * numbered 1, 2, 3… Each stores either its full state (a checkpoint) or a
 * structural patch from the revision before it. Revision 1, every signed or
 * executed state, and the first revision after CHECKPOINT_EVERY patches or
 * after the patches since the last checkpoint outweigh a full copy, are
 * checkpoints, so any revision is rebuilt from one checkpoint and a bounded run
 * of patches and checked against its sha256.
 *
 * Saves are folded into the newest revision instead of cutting a new one when
 * they belong to the same operation (one send that saves three times), or are
 * edits by the same person within IDLE_MS of the last and SPAN_MS of the first.
 * Lifecycle cuts (send, sign, present…) never take later saves of another
 * operation, so each one stays its own revision.
 *
 * A head row per subject keeps the newest state and the one before it, so a
 * save diffs without replaying the chain and a fold can recompute its patch.
 * The head is a cache: it can be rebuilt from the revisions.
 */

export type RevisionKind = "checkpoint" | "patch";

export type RevisionRecord = {
  subject_type: string;
  subject_id: string;
  seq: number;
  kind: RevisionKind;
  base_seq: number;
  encoding: string;
  format: number;
  state_bytes: number;
  stored_bytes: number;
  checksum: string;
  cut: string;
  label: string;
  operation_id: string;
  source: ChangeSource;
  actor_label: string;
  status: string;
  subject_revision: number;
  snapshot_id: string;
  sections: string[];
  attributes: Record<string, unknown>;
  edits: number;
  created_at: string;
  updated_at: string;
};

export type RecordRevisionInput = {
  orgId: string;
  subjectType: string;
  subjectId: string;
  state: Record<string, unknown>;
  cut: string;
  label?: string;
  operationId?: string;
  source: ChangeSource;
  actorLabel?: string;
  status?: string;
  subjectRevision?: number;
  snapshotId?: string;
  attributes?: Record<string, unknown>;
  /** Store the full state even when a patch would do (signed and executed states). */
  checkpoint?: boolean;
  /** Record a revision even when the state did not change (presenting, a named version). */
  marker?: boolean;
  /** Never fold into the newest revision. */
  standalone?: boolean;
  /** The state before this save, for a subject that has no history yet. */
  baseline?: Record<string, unknown> | null;
  /** Fill a state field from the newest recorded state when the writer did not supply it. */
  inherit?: string[];
  /** Decide the cut from the state before this save (null for the first save). */
  decide?: (previous: Record<string, unknown> | null, next: Record<string, unknown>) => { cut?: string; checkpoint?: boolean; actorLabel?: string } | null;
};

/** Cuts that fold repeated saves by the same actor into one revision. */
export const COALESCING_CUTS = new Set(["edit", "view", "response"]);
/** Cuts whose state is stored whole so it is rebuilt from one row. */
export const CHECKPOINT_CUTS = new Set(["sign", "complete", "baseline", "created"]);
export const CHECKPOINT_EVERY = 32;
export const IDLE_MS = 5 * 60 * 1000;
export const SPAN_MS = 30 * 60 * 1000;

let database: SqlStore | null = null;
let databasePath = "";

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "document_versions.sqlite");
}

export async function closeDocumentHistoryDatabase() {
  await database?.close(); database = null; databasePath = "";
}

export function documentHistoryDatabase(): SqlStore {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  if (database) throw new Error("Close document history before changing its directory.");
  // Schema 2 adds the revision log. Schema 1's document_checkpoints table is
  // left in place unused (it held editor-only checkpoints; see the doc).
  database = openSqlStore({ id: "document-checkpoints", filename: nextPath, schemaVersion: 2, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  const blob = db.isPostgres ? "BYTEA" : "BLOB";
  await db.exec(`
    CREATE TABLE IF NOT EXISTS document_revisions (
      organization_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      base_seq INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      format INTEGER NOT NULL,
      payload ${blob} NOT NULL,
      state_bytes INTEGER NOT NULL DEFAULT 0,
      stored_bytes INTEGER NOT NULL DEFAULT 0,
      chain_bytes INTEGER NOT NULL DEFAULT 0,
      checksum TEXT NOT NULL,
      cut TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      operation_id TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      actor_key TEXT NOT NULL DEFAULT '',
      actor_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      subject_revision INTEGER NOT NULL DEFAULT 0,
      snapshot_id TEXT NOT NULL DEFAULT '',
      sections_json TEXT NOT NULL DEFAULT '[]',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      edits INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, subject_type, subject_id, seq)
    );
    CREATE TABLE IF NOT EXISTS document_revision_heads (
      organization_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      state ${blob} NOT NULL,
      parent_state ${blob},
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, subject_type, subject_id)
    );
  `);
}

const text = (value: unknown) => String(value ?? "").trim();

function parse<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

export function stateChecksum(state: unknown) {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

function actorKey(source: ChangeSource, actorLabel = "") {
  return `${source.kind}:${text(source.user_id) || text(source.generator) || text(actorLabel)}`;
}

function rowToRecord(row: Record<string, unknown>): RevisionRecord {
  return {
    subject_type: text(row.subject_type),
    subject_id: text(row.subject_id),
    seq: Number(row.seq || 0),
    kind: (text(row.kind) || "patch") as RevisionKind,
    base_seq: Number(row.base_seq || 0),
    encoding: text(row.encoding),
    format: Number(row.format || 0),
    state_bytes: Number(row.state_bytes || 0),
    stored_bytes: Number(row.stored_bytes || 0),
    checksum: text(row.checksum),
    cut: text(row.cut),
    label: text(row.label),
    operation_id: text(row.operation_id),
    source: parse(row.source_json, { kind: "system" } as ChangeSource),
    actor_label: text(row.actor_label),
    status: text(row.status),
    subject_revision: Number(row.subject_revision || 0),
    snapshot_id: text(row.snapshot_id),
    sections: parse(row.sections_json, [] as string[]),
    attributes: parse(row.attributes_json, {} as Record<string, unknown>),
    edits: Number(row.edits || 1),
    created_at: text(row.created_at),
    updated_at: text(row.updated_at)
  };
}

const SUMMARY_COLUMNS = `subject_type, subject_id, seq, kind, base_seq, encoding, format, state_bytes, stored_bytes, checksum, cut, label,
  operation_id, source_json, actor_label, status, subject_revision, snapshot_id, sections_json, attributes_json, edits, created_at, updated_at`;

async function readHead(db: SqlStore, orgId: string, subjectType: string, subjectId: string) {
  return await db.prepare(`SELECT * FROM document_revision_heads WHERE organization_id=? AND subject_type=? AND subject_id=?`)
    .get(orgId, subjectType, subjectId);
}

/** Whether a subject has any recorded history yet. */
export async function hasRevisions(orgId: string, subjectType: string, subjectId: string) {
  return !!(await readHead(documentHistoryDatabase(), orgId, subjectType, subjectId));
}

function lockKey(orgId: string, subjectType: string, subjectId: string) {
  return `${orgId}:${subjectType}:${subjectId}`;
}

async function insertRevision(db: SqlStore, orgId: string, row: Record<string, unknown>) {
  await db.prepare(`INSERT INTO document_revisions (organization_id, subject_type, subject_id, seq, kind, base_seq, encoding, format, payload,
    state_bytes, stored_bytes, chain_bytes, checksum, cut, label, operation_id, source_json, actor_key, actor_label, status, subject_revision,
    snapshot_id, sections_json, attributes_json, edits, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    orgId, row.subject_type as string, row.subject_id as string, row.seq as number, row.kind as string, row.base_seq as number,
    row.encoding as string, row.format as number, row.payload as Buffer, row.state_bytes as number, row.stored_bytes as number,
    row.chain_bytes as number, row.checksum as string, row.cut as string, row.label as string, row.operation_id as string,
    row.source_json as string, row.actor_key as string, row.actor_label as string, row.status as string, row.subject_revision as number,
    row.snapshot_id as string, row.sections_json as string, row.attributes_json as string, row.edits as number,
    row.created_at as string, row.updated_at as string
  );
}

async function writeHead(db: SqlStore, orgId: string, subjectType: string, subjectId: string, seq: number, state: Buffer, parent: Buffer | null, now: string) {
  await db.prepare(`INSERT INTO document_revision_heads (organization_id, subject_type, subject_id, seq, encoding, state, parent_state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, subject_type, subject_id) DO UPDATE SET seq=excluded.seq, encoding=excluded.encoding,
      state=excluded.state, parent_state=excluded.parent_state, updated_at=excluded.updated_at`)
    .run(orgId, subjectType, subjectId, seq, CURRENT_ENCODING, state, parent, now);
}

/**
 * Record a save of a subject. Returns the revision it landed in (new or
 * folded), or null when nothing changed and no marker was asked for.
 */
export async function recordRevision(input: RecordRevisionInput): Promise<RevisionRecord | null> {
  const db = documentHistoryDatabase();
  const { orgId, subjectType, subjectId } = input;
  return await db.transaction(async () => {
    const now = new Date().toISOString();
    let head = await readHead(db, orgId, subjectType, subjectId);
    let state = input.state;
    if (head && input.inherit?.length) {
      const previous = decodePayload(head.state, text(head.encoding)) as Record<string, unknown>;
      state = { ...state };
      for (const key of input.inherit) if (state[key] === undefined && previous[key] !== undefined) state[key] = previous[key];
    }
    if (!head && input.baseline && stableStringify(input.baseline) !== stableStringify(state)) {
      // A subject saved before history existed: its stored state is revision 1.
      const encoded = encodePayload(input.baseline);
      const bytes = Buffer.byteLength(JSON.stringify(input.baseline), "utf8");
      await insertRevision(db, orgId, {
        subject_type: subjectType, subject_id: subjectId, seq: 1, kind: "checkpoint", base_seq: 1, encoding: CURRENT_ENCODING,
        format: REVISION_FORMAT, payload: encoded, state_bytes: bytes, stored_bytes: encoded.length, chain_bytes: 0,
        checksum: stateChecksum(input.baseline), cut: "baseline", label: "", operation_id: "", source_json: JSON.stringify({ kind: "system" }),
        actor_key: "system:", actor_label: "", status: text(input.baseline.status), subject_revision: Number(input.baseline.revision || 0),
        snapshot_id: "", sections_json: "[]", attributes_json: "{}", edits: 1,
        created_at: text(input.baseline.updated_at) || now, updated_at: now
      });
      await writeHead(db, orgId, subjectType, subjectId, 1, encoded, null, now);
      head = await readHead(db, orgId, subjectType, subjectId);
    }
    const tip = head ? await db.prepare(`SELECT * FROM document_revisions WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`)
      .get(orgId, subjectType, subjectId, Number(head.seq)) : undefined;
    const tipState = head ? decodePayload(head.state, text(head.encoding)) as Record<string, unknown> : null;
    const ops: PatchOp[] = head ? diffJson(tipState, state) : [];
    if (head && !ops.length && !input.marker) return null;
    const decided = input.decide?.(tipState, state) || null;
    input = { ...input, cut: decided?.cut || input.cut, checkpoint: input.checkpoint || decided?.checkpoint, actorLabel: input.actorLabel || decided?.actorLabel };

    const key = actorKey(input.source, input.actorLabel);
    const encodedState = encodePayload(state);
    const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    const checksum = stateChecksum(state);
    const sameOperation = !!input.operationId && !!tip && text(tip.operation_id) === input.operationId;
    const sameRun = !!tip && !input.standalone && !input.marker && COALESCING_CUTS.has(input.cut) && text(tip.cut) === input.cut
      && text(tip.actor_key) === key && Date.parse(now) - Date.parse(text(tip.updated_at)) <= IDLE_MS
      && Date.parse(now) - Date.parse(text(tip.created_at)) <= SPAN_MS;

    if (tip && head && (sameOperation || sameRun) && !(input.marker && !sameOperation)) {
      // Fold this save into the newest revision.
      const seq = Number(tip.seq);
      const parentState = head.parent_state ? decodePayload(head.parent_state, text(head.encoding)) : null;
      const asCheckpoint = text(tip.kind) === "checkpoint" || !!input.checkpoint || CHECKPOINT_CUTS.has(text(tip.cut));
      const foldedOps = parentState === null ? [] : diffJson(parentState, state);
      const payload = asCheckpoint ? encodedState : encodePayload(foldedOps);
      const attributes = { ...parse(tip.attributes_json, {} as Record<string, unknown>), ...(input.attributes || {}) };
      const sections = parentState === null ? touchedSections(diffJson({}, state)) : touchedSections(foldedOps);
      const previousChain = Number(tip.chain_bytes || 0) - Number(tip.stored_bytes || 0);
      await db.prepare(`UPDATE document_revisions SET kind=?, base_seq=?, payload=?, state_bytes=?, stored_bytes=?, chain_bytes=?, checksum=?,
        label=?, status=?, subject_revision=?, snapshot_id=?, sections_json=?, attributes_json=?, edits=edits+1, updated_at=?
        WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`).run(
        asCheckpoint ? "checkpoint" : "patch", asCheckpoint ? seq : Number(tip.base_seq), payload, stateBytes, payload.length,
        asCheckpoint ? 0 : previousChain + payload.length, checksum, text(input.label) || text(tip.label),
        text(input.status), Number(input.subjectRevision || 0), text(input.snapshotId) || text(tip.snapshot_id),
        JSON.stringify(sections), JSON.stringify(attributes), now, orgId, subjectType, subjectId, seq
      );
      await writeHead(db, orgId, subjectType, subjectId, seq, encodedState, (head.parent_state as Buffer | null) ?? null, now);
      return rowToRecord((await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_revisions WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`)
        .get(orgId, subjectType, subjectId, seq))!);
    }

    const seq = head ? Number(head.seq) + 1 : 1;
    const encodedOps = head ? encodePayload(ops) : null;
    const chainBefore = tip && text(tip.kind) === "patch" ? Number(tip.chain_bytes || 0) : 0;
    const patchesSince = tip ? (text(tip.kind) === "checkpoint" ? 0 : seq - 1 - Number(tip.base_seq)) : 0;
    const asCheckpoint = !head || !!input.checkpoint || CHECKPOINT_CUTS.has(input.cut)
      || patchesSince + 1 >= CHECKPOINT_EVERY
      || chainBefore + (encodedOps?.length || 0) >= encodedState.length;
    const payload = asCheckpoint ? encodedState : encodedOps!;
    const baseSeq = asCheckpoint ? seq : (text(tip?.kind) === "checkpoint" ? Number(tip!.seq) : Number(tip!.base_seq));
    const sections = head ? touchedSections(ops) : touchedSections(diffJson({}, state));
    await insertRevision(db, orgId, {
      subject_type: subjectType, subject_id: subjectId, seq, kind: asCheckpoint ? "checkpoint" : "patch", base_seq: baseSeq,
      encoding: CURRENT_ENCODING, format: REVISION_FORMAT, payload, state_bytes: stateBytes, stored_bytes: payload.length,
      chain_bytes: asCheckpoint ? 0 : chainBefore + payload.length, checksum, cut: input.cut, label: text(input.label),
      operation_id: text(input.operationId), source_json: JSON.stringify(input.source), actor_key: key, actor_label: text(input.actorLabel),
      status: text(input.status), subject_revision: Number(input.subjectRevision || 0), snapshot_id: text(input.snapshotId),
      sections_json: JSON.stringify(sections), attributes_json: JSON.stringify(input.attributes || {}), edits: 1, created_at: now, updated_at: now
    });
    await writeHead(db, orgId, subjectType, subjectId, seq, encodedState, head ? (head.state as Buffer) : null, now);
    return rowToRecord((await db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_revisions WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`)
      .get(orgId, subjectType, subjectId, seq))!);
  }, lockKey(orgId, subjectType, subjectId));
}

/** Revisions without their payloads, newest first. */
export async function listRevisions(orgId: string, subjectType: string, subjectId: string): Promise<RevisionRecord[]> {
  const rows = await documentHistoryDatabase().prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_revisions
    WHERE organization_id=? AND subject_type=? AND subject_id=? ORDER BY seq DESC`).all(orgId, subjectType, subjectId);
  return rows.map(rowToRecord);
}

export async function readRevisionRecord(orgId: string, subjectType: string, subjectId: string, seq: number): Promise<RevisionRecord | null> {
  const row = await documentHistoryDatabase().prepare(`SELECT ${SUMMARY_COLUMNS} FROM document_revisions
    WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`).get(orgId, subjectType, subjectId, seq);
  return row ? rowToRecord(row) : null;
}

export class RevisionIntegrityError extends Error {}

/** The exact state of a revision, rebuilt from its checkpoint and patches and checked against its checksum. */
export async function reconstructRevision(orgId: string, subjectType: string, subjectId: string, seq: number): Promise<{ record: RevisionRecord; state: Record<string, unknown> } | null> {
  const db = documentHistoryDatabase();
  const target = await db.prepare(`SELECT base_seq FROM document_revisions WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq=?`)
    .get(orgId, subjectType, subjectId, seq);
  if (!target) return null;
  const rows = await db.prepare(`SELECT seq, kind, encoding, payload FROM document_revisions
    WHERE organization_id=? AND subject_type=? AND subject_id=? AND seq>=? AND seq<=? ORDER BY seq`)
    .all(orgId, subjectType, subjectId, Number(target.base_seq), seq);
  let state: unknown = null;
  for (const row of rows) {
    const value = decodePayload(row.payload, text(row.encoding));
    state = text(row.kind) === "checkpoint" ? value : applyPatch(state, value as PatchOp[]);
  }
  const record = (await readRevisionRecord(orgId, subjectType, subjectId, seq))!;
  if (stateChecksum(state) !== record.checksum) {
    throw new RevisionIntegrityError(`Revision ${seq} of ${subjectType} ${subjectId} does not match its checksum.`);
  }
  return { record, state: state as Record<string, unknown> };
}

/** Bytes stored for a subject's history, and what the same revisions would take as full copies. */
export async function revisionStorage(orgId: string, subjectType: string, subjectId: string) {
  const row = await documentHistoryDatabase().prepare(`SELECT COUNT(*) AS revisions, SUM(stored_bytes) AS stored, SUM(state_bytes) AS full_json,
    SUM(CASE WHEN kind='checkpoint' THEN 1 ELSE 0 END) AS checkpoints
    FROM document_revisions WHERE organization_id=? AND subject_type=? AND subject_id=?`).get(orgId, subjectType, subjectId);
  const head = await documentHistoryDatabase().prepare(`SELECT state, parent_state FROM document_revision_heads WHERE organization_id=? AND subject_type=? AND subject_id=?`)
    .get(orgId, subjectType, subjectId);
  const headBytes = head ? Buffer.from(head.state as Uint8Array).length + (head.parent_state ? Buffer.from(head.parent_state as Uint8Array).length : 0) : 0;
  return {
    revisions: Number(row?.revisions || 0),
    checkpoints: Number(row?.checkpoints || 0),
    stored_bytes: Number(row?.stored || 0),
    head_bytes: headBytes,
    full_json_bytes: Number(row?.full_json || 0)
  };
}
