import { badRequest, notFound } from "../../platform/errors.js";
import { readDocument, type JsonObject } from "../../platform/storage.js";
import type { PlatformAuthContext } from "../../platform/auth.js";
import { currentChangeSource } from "../../history/source.js";
import { FMDocModel } from "../schemas.js";
import {
  listDocumentTemplateVersions,
  readDocumentInstance,
  readDocumentSnapshot,
  readDocumentTemplateVersion
} from "../storage.js";
import { currentDocumentChange, withDocumentChange } from "./context.js";
import {
  COALESCING_CUTS,
  hasRevisions,
  listRevisions,
  readRevisionRecord,
  reconstructRevision,
  recordRevision,
  type RevisionRecord
} from "./history.js";
import { cloneJson, stableStringify } from "./patch.js";

/**
 * Document history: what every document system records through, and what the
 * History panel reads. The revision log itself is history.ts; this file says
 * what a document's state is, which cut a save is, and how two versions read
 * side by side. See docs/architecture/document-history.md.
 */

export const DOCUMENT_SUBJECT = "document";
/** Template, theme and workflow assets record under their own kind. */
export const ASSET_SUBJECTS = ["document_template", "document_theme", "document_workflow"];

/** Fields that change on every save and say nothing about the document; kept on the revision row instead. */
const VOLATILE_FIELDS = ["revision", "updated_at", "updated_by_user_id"];

const STATUS_CUTS: Record<string, string> = {
  issued: "issue",
  sent: "send",
  viewed: "view",
  partially_signed: "sign",
  signed: "sign",
  completed: "complete",
  declined: "decline",
  void: "void",
  expired: "expire"
};
const EXECUTED_STATUSES = new Set(["signed", "completed"]);

function text(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

/** The versioned state of a document record. */
export function documentState(record: JsonObject): JsonObject {
  const state = cloneJson(asObject(record));
  for (const key of VOLATILE_FIELDS) delete state[key];
  return state;
}

/** Who signed in this save, for a revision recorded without a signed-in user. */
function newSigners(previous: JsonObject | null, next: JsonObject) {
  const before = asObject(previous?.outputs);
  const names: string[] = [];
  for (const [key, value] of Object.entries(asObject(next.outputs))) {
    const output = asObject(value);
    if (!text(output.signed_at) || stableStringify(before[key]) === stableStringify(value)) continue;
    const name = text(output.name || output.signer_name || output.typed_name || output.full_name);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

/**
 * Which cut a save is: the operation it runs in, unless the status moved to a
 * lifecycle state under a plain edit; otherwise a change of responses or an edit.
 */
export function inferDocumentCut(previous: JsonObject | null, next: JsonObject, declared = "", existed = false) {
  if (!previous) return { cut: existed ? "baseline" : "created" };
  const before = text(previous.status), after = text(next.status);
  const statusCut = before !== after ? STATUS_CUTS[after] : "";
  const executed = before !== after && EXECUTED_STATUSES.has(after);
  let cut = declared;
  if (statusCut && (!declared || declared === "edit" || COALESCING_CUTS.has(declared))) cut = statusCut;
  // The e-sign seal replaces the executed PDF's hash after signing: the final, sealed state.
  const sealed = !cut && stableStringify(asObject(previous.signing).final_pdf_hash) !== stableStringify(asObject(next.signing).final_pdf_hash)
    && stableStringify({ ...previous, signing: null }) === stableStringify({ ...next, signing: null });
  if (sealed) return { cut: "seal", checkpoint: true, actorLabel: "" };
  if (!cut) cut = stableStringify(previous.outputs) !== stableStringify(next.outputs) ? "response" : "edit";
  const signers = cut === "sign" || cut === "complete" || executed ? newSigners(previous, next) : "";
  return { cut, checkpoint: executed, actorLabel: signers };
}

/**
 * Run a document save and record it. Called by saveDocumentInstance, the one
 * writer of document records, so nothing that changes a document is missed.
 * Recording never blocks the save: a failure is logged and the next save
 * diffs against the last recorded state.
 */
export async function recordDocumentSave(orgId: string, documentId: string, save: () => Promise<JsonObject>, readExisting: () => Promise<JsonObject | null>) {
  let recorded = true;
  try { recorded = await hasRevisions(orgId, DOCUMENT_SUBJECT, documentId); } catch (error) { console.error("Document history unavailable", error); return await save(); }
  const existing = recorded ? null : await readExisting();
  const saved = await save();
  const change = currentDocumentChange(documentId);
  const userId = text(change?.userId) || (!existing && !recorded ? text(saved.created_by_user_id) : "");
  try {
    await recordRevision({
      orgId,
      subjectType: DOCUMENT_SUBJECT,
      subjectId: documentId,
      state: documentState(saved),
      cut: change?.cut || "edit",
      label: change?.label,
      operationId: change?.operationId,
      source: currentChangeSource(userId),
      actorLabel: change?.actorLabel,
      status: text(saved.status),
      subjectRevision: Number(saved.revision || 0),
      snapshotId: text(asObject(saved.delivery).current_snapshot_id),
      attributes: change?.attributes,
      checkpoint: change?.checkpoint,
      baseline: existing ? documentState(existing) : null,
      decide: (previous, next) => inferDocumentCut(previous, next, change?.cut || "", !!existing)
    });
  } catch (error) {
    console.error(`Document history could not record ${documentId}`, error);
  }
  return saved;
}

/** Record a template, theme or workflow save. A save without a definition keeps the last recorded one. */
export async function recordAssetSave(orgId: string, kind: string, record: JsonObject, cut: string, userId: string, definition?: JsonObject) {
  try {
    const state = documentState(record);
    if (definition) state.definition = cloneJson(definition);
    await recordRevision({
      orgId,
      subjectType: kind,
      subjectId: text(record.id),
      state,
      cut,
      source: currentChangeSource(userId),
      status: text(record.status),
      subjectRevision: Number(record.revision || 0),
      label: cut === "publish" ? `v${Number(record.current_version || 0)}` : "",
      inherit: ["definition"],
      standalone: cut === "publish"
    });
  } catch (error) {
    console.error(`Document history could not record ${kind} ${text(record.id)}`, error);
  }
}

// ---------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------

export type RevisionView = RevisionRecord & { actor_name: string };

async function actorNames(orgId: string, revisions: RevisionRecord[]): Promise<RevisionView[]> {
  const ids = [...new Set(revisions.map((revision) => text(revision.source.user_id)).filter(Boolean))];
  const names = new Map<string, string>();
  await Promise.all(ids.map(async (id) => {
    const user = asObject(asObject(await readDocument(orgId, "users", id).catch(() => null)).data);
    names.set(id, text(user.name || user.display_name || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email));
  }));
  return revisions.map((revision) => ({ ...revision, actor_name: names.get(text(revision.source.user_id)) || "" }));
}

/** A document's revisions, newest first. A document saved before history existed starts with its current state. */
export async function listDocumentRevisions(orgId: string, documentId: string) {
  const document = await readDocumentInstance(orgId, documentId);
  if (!(await hasRevisions(orgId, DOCUMENT_SUBJECT, documentId))) {
    await recordRevision({
      orgId, subjectType: DOCUMENT_SUBJECT, subjectId: documentId, state: documentState(document), cut: "baseline",
      source: { kind: "system" }, status: text(document.status), subjectRevision: Number(document.revision || 0),
      snapshotId: text(asObject(document.delivery).current_snapshot_id)
    });
  }
  return { document, revisions: await actorNames(orgId, await listRevisions(orgId, DOCUMENT_SUBJECT, documentId)) };
}

function parseSeq(value: unknown) {
  const seq = Number(text(value));
  if (!Number.isInteger(seq) || seq < 1) throw badRequest("document_revision_invalid", "Name a revision by its number.");
  return seq;
}

async function revisionState(orgId: string, subjectType: string, subjectId: string, ref: string) {
  if (text(ref) === "current" && subjectType === DOCUMENT_SUBJECT) {
    const document = await readDocumentInstance(orgId, subjectId);
    return { record: null as RevisionRecord | null, state: documentState(document), at: text(document.updated_at) || new Date().toISOString() };
  }
  const found = await reconstructRevision(orgId, subjectType, subjectId, parseSeq(ref));
  if (!found) throw notFound("document_revision_not_found", "That revision was not found.");
  return { record: found.record, state: found.state as JsonObject, at: found.record.updated_at };
}

/** The template version a document rendered on at a time: its pin once sent, else the version current then. */
async function templateVersionAt(orgId: string, state: JsonObject, at: string) {
  const ref = asObject(state.template_ref);
  const templateId = text(ref.template_id);
  if (!templateId) return 0;
  const isDraft = !text(state.status) || text(state.status) === "draft";
  if (!isDraft && Number(ref.version || 0)) return Number(ref.version);
  const versions = await listDocumentTemplateVersions(orgId, templateId).catch(() => []);
  const when = Date.parse(at);
  const match = versions.find((version) => Number.isFinite(when) && Date.parse(text(version.published_at)) <= when);
  return Number(asObject(match || versions[0]).version || 0);
}

/** The editable definition of a version: its template version with its overrides applied. */
async function workingDefinitionAt(orgId: string, state: JsonObject, at: string): Promise<JsonObject> {
  if (text(asObject(state.module_ref).execution_id) && Object.keys(asObject(state.module_render)).length) {
    return asObject(FMDocModel.applyOverrides(asObject(state.module_render), asArray(state.overrides)).document);
  }
  const templateId = text(asObject(state.template_ref).template_id);
  const version = await templateVersionAt(orgId, state, at);
  let definition: JsonObject = {};
  if (templateId) definition = asObject(asObject(await readDocumentTemplateVersion(orgId, templateId, version || undefined).catch(() => null)).definition);
  if (!Object.keys(definition).length) {
    definition = asObject((FMDocModel.createBlankDocument || FMDocModel.createDocument)({ metadata: { document_type: text(state.document_type) } }));
  }
  return asObject(FMDocModel.applyOverrides(definition, asArray(state.overrides)).document);
}

/** One revision: its record, exact state and editable definition. */
export async function readDocumentRevision(orgId: string, documentId: string, ref: string) {
  await readDocumentInstance(orgId, documentId);
  const { record, state, at } = await revisionState(orgId, DOCUMENT_SUBJECT, documentId, ref);
  const [view] = record ? await actorNames(orgId, [record]) : [null];
  return { revision: view, state, definition: await workingDefinitionAt(orgId, state, at), template_version: await templateVersionAt(orgId, state, at) };
}

/**
 * What a revision looked like. A sent or signed version shows its frozen
 * snapshot, which for a signed document is the sealed content; any other
 * version renders its state on the template version it was written against.
 */
export async function viewDocumentRevision(orgId: string, documentId: string, ref: string) {
  const document = await readDocumentInstance(orgId, documentId);
  const { record, state, at } = await revisionState(orgId, DOCUMENT_SUBJECT, documentId, ref);
  const frozen = record && ["send", "sign", "seal", "complete", "snapshot", "pdf"].includes(record.cut) && record.snapshot_id
    ? await readDocumentSnapshot(orgId, record.snapshot_id).catch(() => null)
    : null;
  if (frozen && Object.keys(asObject(frozen.resolved_definition)).length) {
    return {
      frozen: true,
      snapshot_id: record!.snapshot_id,
      resolved: { resolved_definition: frozen.resolved_definition, theme: asObject(frozen.theme), theme_vars: asObject(frozen.theme_vars), widget_data: asObject(frozen.widget_data) }
    };
  }
  const { resolveDocumentInstance } = await import("../service.js");
  const resolved = await resolveDocumentInstance(orgId, { ...state, id: documentId, revision: document.revision }, {
    target: "interactive",
    templateVersion: (await templateVersionAt(orgId, state, at)) || undefined
  });
  return {
    frozen: false,
    snapshot_id: "",
    resolved: { resolved_definition: resolved.resolved_definition, theme: resolved.theme, theme_vars: resolved.theme_vars, widget_data: resolved.widget_data }
  };
}

// ---------------------------------------------------------------------------
// Readable differences between two versions
// ---------------------------------------------------------------------------

export type FieldChange = {
  section: string;
  path: string[];
  change: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

/** Sections the History panel shows, in order. Content (the editable definition) is diffed by text block instead. */
const SECTION_ORDER = ["title", "status", "params", "outputs", "workflow_state", "delivery", "contact_ids", "tags", "theme_ref", "theme_overrides", "template_ref", "metadata"];
const HIDDEN_FIELDS = new Set(["overrides", "param_defs", "output_defs", "module_render", "module_resolved", "materials_deliverables"]);
const SECRET_KEY = /token|secret|password|credential/i;
const MAX_FIELD_CHANGES = 400;

function elementName(value: unknown, index: number) {
  const item = asObject(value);
  return text(item.name || item.title || item.label || item.description || item.id) || `#${index + 1}`;
}

function shown(value: unknown, key: string): unknown {
  if (SECRET_KEY.test(key)) return value === undefined ? undefined : "••••";
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  return value;
}

function compareInto(section: string, path: string[], a: unknown, b: unknown, out: FieldChange[]) {
  if (out.length >= MAX_FIELD_CHANGES) return;
  const key = path[path.length - 1] || section;
  if (a === undefined && b === undefined) return;
  if (a === undefined) { out.push({ section, path, change: "added", after: shown(b, key) }); return; }
  if (b === undefined) { out.push({ section, path, change: "removed", before: shown(a, key) }); return; }
  if (stableStringify(a) === stableStringify(b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const byId = (list: unknown[]) => list.every((item) => text(asObject(item).id));
    if (byId(a) && byId(b)) {
      const before = new Map(a.map((item, index) => [text(asObject(item).id), { item, index }]));
      const after = new Map(b.map((item, index) => [text(asObject(item).id), { item, index }]));
      for (const [id, entry] of before) if (!after.has(id)) compareInto(section, [...path, elementName(entry.item, entry.index)], entry.item, undefined, out);
      for (const [id, entry] of after) compareInto(section, [...path, elementName(entry.item, entry.index)], before.get(id)?.item, entry.item, out);
      return;
    }
    if (a.every((item) => item === null || typeof item !== "object") && b.every((item) => item === null || typeof item !== "object")) {
      out.push({ section, path, change: "changed", before: shown(a, key), after: shown(b, key) });
      return;
    }
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      compareInto(section, [...path, elementName(b[index] ?? a[index], index)], a[index], b[index], out);
    }
    return;
  }
  const objectA = a && typeof a === "object" && !Array.isArray(a), objectB = b && typeof b === "object" && !Array.isArray(b);
  if (objectA && objectB) {
    const keys = [...new Set([...Object.keys(a as JsonObject), ...Object.keys(b as JsonObject)])];
    for (const child of keys) compareInto(section, [...path, child], (a as JsonObject)[child], (b as JsonObject)[child], out);
    return;
  }
  out.push({ section, path, change: "changed", before: shown(a, key), after: shown(b, key) });
}

/** Field-by-field changes between two document states, grouped by section. */
export function describeStateChanges(before: JsonObject, after: JsonObject): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = [...new Set([...SECTION_ORDER, ...Object.keys(before), ...Object.keys(after)])].filter((key) => !HIDDEN_FIELDS.has(key));
  for (const key of keys) compareInto(key, [], before[key], after[key], out);
  return out;
}

/** Differences between two revisions of a document (a → b); either may be "current". */
export async function diffDocumentRevisions(orgId: string, documentId: string, aRef: string, bRef: string) {
  await readDocumentInstance(orgId, documentId);
  const a = await revisionState(orgId, DOCUMENT_SUBJECT, documentId, aRef);
  const b = await revisionState(orgId, DOCUMENT_SUBJECT, documentId, bRef);
  const fields = describeStateChanges(a.state, b.state);
  const content = diffDefinitions(await workingDefinitionAt(orgId, a.state, a.at), await workingDefinitionAt(orgId, b.state, b.at));
  return { a: aRef, b: bRef, fields, truncated: fields.length >= MAX_FIELD_CHANGES, content };
}

/** Revisions of a template, theme or workflow, and the difference between two of them. */
export async function listAssetRevisions(orgId: string, kind: string, assetId: string) {
  if (!ASSET_SUBJECTS.includes(kind)) throw badRequest("document_revision_subject_invalid", "That kind of document has no history.");
  return await actorNames(orgId, await listRevisions(orgId, kind, assetId));
}

export async function diffAssetRevisions(orgId: string, kind: string, assetId: string, aRef: string, bRef: string) {
  if (!ASSET_SUBJECTS.includes(kind)) throw badRequest("document_revision_subject_invalid", "That kind of document has no history.");
  const a = await revisionState(orgId, kind, assetId, aRef);
  const b = await revisionState(orgId, kind, assetId, bRef);
  const strip = (state: JsonObject) => { const copy = { ...state }; delete copy.definition; return copy; };
  return {
    a: aRef, b: bRef,
    fields: describeStateChanges(strip(a.state), strip(b.state)),
    content: diffDefinitions(asObject(a.state.definition), asObject(b.state.definition))
  };
}

// ---------------------------------------------------------------------------
// Named versions and restore
// ---------------------------------------------------------------------------

/** A revision that marks a moment without changing the document: a named version, a presentation. */
export async function markDocumentRevision(orgId: string, documentId: string, input: { cut: string; label?: string; userId?: string; attributes?: JsonObject }) {
  const document = await readDocumentInstance(orgId, documentId);
  const record = await recordRevision({
    orgId, subjectType: DOCUMENT_SUBJECT, subjectId: documentId, state: documentState(document), cut: input.cut,
    label: text(input.label).slice(0, 200), source: currentChangeSource(text(input.userId)), status: text(document.status),
    subjectRevision: Number(document.revision || 0), snapshotId: text(asObject(document.delivery).current_snapshot_id),
    attributes: input.attributes, marker: true
  });
  return record ? (await actorNames(orgId, [record]))[0] : null;
}

/** Put an earlier version's content back as a new revision. Delivery, responses and status are never rolled back. */
export async function restoreDocumentRevision(orgId: string, documentId: string, ref: string, ctx: PlatformAuthContext) {
  const seq = parseSeq(ref);
  const found = await reconstructRevision(orgId, DOCUMENT_SUBJECT, documentId, seq);
  if (!found) throw notFound("document_revision_not_found", "That revision was not found.");
  const service = await import("../service.js");
  const content = Object.fromEntries(service.RESTORABLE_DOCUMENT_FIELDS.map((key) => [key, (found.state as JsonObject)[key]]));
  const document = await withDocumentChange({ cut: "restore", documentId, userId: ctx.userId, label: `${seq}`, attributes: { restored_from: seq } },
    () => service.restoreDocumentInstanceContent(orgId, documentId, content, ctx));
  return { document, revision: (await listRevisions(orgId, DOCUMENT_SUBJECT, documentId))[0] || null };
}

export async function readRevisionSummary(orgId: string, documentId: string, seq: number) {
  return await readRevisionRecord(orgId, DOCUMENT_SUBJECT, documentId, seq);
}

// ---------------------------------------------------------------------------
// Block-level text diff over stable DocModel node/block ids
// ---------------------------------------------------------------------------

export type WordDiffSegment = { type: "same" | "add" | "del"; text: string };

export type DefinitionDiff = {
  added_blocks: Array<{ node_id: string; block_id: string; text: string }>;
  removed_blocks: Array<{ node_id: string; block_id: string; text: string }>;
  changed_blocks: Array<{ node_id: string; block_id: string; before_text: string; after_text: string; word_diff: WordDiffSegment[] }>;
  other_changes: number;
};

type TextBlock = { node_id: string; block_id: string; text: string };

function blockText(block: JsonObject) {
  return asArray(block.runs).map((run) => String(asObject(run).text ?? "")).join("");
}

/** Every text block keyed by "nodeId::blockId", in document order (pages, then a view document's root). */
function collectTextBlocks(definition: JsonObject) {
  const order: string[] = [];
  const map = new Map<string, TextBlock>();
  const visitNode = (node: unknown) => {
    const value = asObject(node);
    if (text(value.type) === "text") {
      const nodeId = text(value.id);
      for (const blockValue of asArray(asObject(value.props).blocks)) {
        const block = asObject(blockValue);
        const blockId = text(block.id);
        if (!nodeId || !blockId) continue;
        const key = `${nodeId}::${blockId}`;
        if (map.has(key)) continue;
        map.set(key, { node_id: nodeId, block_id: blockId, text: blockText(block) });
        order.push(key);
      }
    }
    for (const child of asArray(value.children)) visitNode(child);
  };
  for (const page of asArray(definition.pages)) for (const child of asArray(asObject(page).children)) visitNode(child);
  for (const child of asArray(asObject(definition.root).children)) visitNode(child);
  return { order, map };
}

type EntitySignature = { sig: string; isText: boolean };

/** Structural signatures for the "other changes" count; text nodes drop their blocks (reported block by block). */
function collectEntitySignatures(definition: JsonObject) {
  const map = new Map<string, EntitySignature>();
  const visitNode = (node: unknown) => {
    const value = asObject(node);
    const id = text(value.id);
    const isText = text(value.type) === "text";
    if (id) {
      const stripped: JsonObject = { ...value, children: asArray(value.children).map((child) => text(asObject(child).id)) };
      if (isText) stripped.props = { ...asObject(value.props), blocks: undefined };
      map.set(`node:${id}`, { sig: stableStringify(stripped), isText });
    }
    for (const child of asArray(value.children)) visitNode(child);
  };
  for (const page of asArray(definition.pages)) {
    const value = asObject(page);
    const id = text(value.id);
    if (id) map.set(`page:${id}`, { sig: stableStringify({ ...value, children: asArray(value.children).map((child) => text(asObject(child).id)) }), isText: false });
    for (const child of asArray(value.children)) visitNode(child);
  }
  for (const child of asArray(asObject(definition.root).children)) visitNode(child);
  map.set("doc:root", { sig: stableStringify({ ...definition, pages: undefined, root: undefined }), isText: false });
  return map;
}

/** LCS word diff over whitespace tokens. */
export function wordDiff(before: string, after: string): WordDiffSegment[] {
  const a = text(before) ? text(before).split(/\s+/) : [];
  const b = text(after) ? text(after).split(/\s+/) : [];
  const segments: WordDiffSegment[] = [];
  const push = (type: WordDiffSegment["type"], token: string) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += ` ${token}`;
    else segments.push({ type, text: token });
  };
  if (a.length * b.length > 1_000_000) {
    if (a.length) segments.push({ type: "del", text: a.join(" ") });
    if (b.length) segments.push({ type: "add", text: b.join(" ") });
    return segments;
  }
  const cols = b.length + 1;
  const table = new Uint32Array((a.length + 1) * cols);
  const at = (i: number, j: number) => table[i * cols + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]!); i += 1; j += 1; }
    else if (at(i + 1, j) >= at(i, j + 1)) { push("del", a[i]!); i += 1; }
    else { push("add", b[j]!); j += 1; }
  }
  while (i < a.length) push("del", a[i++] ?? "");
  while (j < b.length) push("add", b[j++] ?? "");
  return segments;
}

export function diffDefinitions(before: JsonObject, after: JsonObject): DefinitionDiff {
  const a = collectTextBlocks(before);
  const b = collectTextBlocks(after);
  const added: DefinitionDiff["added_blocks"] = [];
  const removed: DefinitionDiff["removed_blocks"] = [];
  const changed: DefinitionDiff["changed_blocks"] = [];
  for (const key of b.order) {
    if (!a.map.has(key)) { const block = b.map.get(key)!; added.push({ node_id: block.node_id, block_id: block.block_id, text: block.text }); }
  }
  for (const key of a.order) {
    const beforeBlock = a.map.get(key)!;
    const afterBlock = b.map.get(key);
    if (!afterBlock) { removed.push({ node_id: beforeBlock.node_id, block_id: beforeBlock.block_id, text: beforeBlock.text }); continue; }
    if (beforeBlock.text !== afterBlock.text) {
      changed.push({ node_id: beforeBlock.node_id, block_id: beforeBlock.block_id, before_text: beforeBlock.text, after_text: afterBlock.text, word_diff: wordDiff(beforeBlock.text, afterBlock.text) });
    }
  }
  const entitiesA = collectEntitySignatures(before);
  const entitiesB = collectEntitySignatures(after);
  let otherChanges = 0;
  for (const [key, entity] of entitiesA) {
    const other = entitiesB.get(key);
    if (!other) { if (!entity.isText) otherChanges += 1; } else if (other.sig !== entity.sig) otherChanges += 1;
  }
  for (const [key, entity] of entitiesB) if (!entitiesA.has(key) && !entity.isText) otherChanges += 1;
  return { added_blocks: added, removed_blocks: removed, changed_blocks: changed, other_changes: otherChanges };
}
