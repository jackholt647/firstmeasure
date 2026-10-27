// Markup drawn on a project document that is not a media file (docs/architecture/document-markup.md).
//
// A photo or an uploaded file keeps its markup as a layer on the media record (`saveMediaMarkupLayer`). A project's
// delivered measurement reports, and any other document the project shows from a URL, have no media id, so their
// markup is kept here: one record per project and document key, in the ordinary platform document store (collection
// `project_document_markup`, the file store or Postgres `platform_documents`, no migration).
//
// The record's id is derived from the project and the key, so a read needs no search. Who saved it comes from the
// verified session; the body names only the markup. A project merge moves the merged project's markup to the survivor
// (`projectDocumentMarkupAdapter`, registered in contacts/references.ts).
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { deleteDocument, listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { readProjectForMedia } from "./media-assignment.js";

export const PROJECT_DOCUMENT_MARKUP_COLLECTION = "project_document_markup";
/**
 * The apps that open project documents: the media markup apps plus Project Docs, Documents, Scope, Reports and field
 * Materials. Written out, not spread from MEDIA_APPS, so the access-gates record can read it.
 */
export const PROJECT_DOCUMENT_MARKUP_APPS = ["portal.photos_feed", "project.photos", "contact.media", "portal.viewer", "project.docs", "project.documents", "project.materials", "project.measurements", "project.crew_materials"];
// 100, not more: the router refuses a longer path parameter (Fastify maxParamLength) with 414 before any handler.
export const DOC_KEY_PATTERN = /^[a-z0-9_:.-]{1,100}$/;
export const MAX_MARKUP_PAGE = 5000;
export const MAX_MARKUP_BYTES = 512 * 1024;

type Obj = JsonObject;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const clean = (value: unknown) => String(value ?? "").trim();
const isPlainObject = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** A document key, lower-cased; anything outside `[a-z0-9_:.-]{1,100}` is refused rather than rewritten, so two keys never collide. */
export function normalizeDocKey(value: unknown) {
  const key = clean(value).toLowerCase();
  if (!DOC_KEY_PATTERN.test(key)) throw badRequest("invalid_doc_key", "A document key is 1 to 100 characters of a-z, 0-9, _ : . or -.");
  return key;
}

/**
 * The markup a viewer saves: `{ schema, pages: { "1": [item, ...], ... } }`. Page keys are page numbers 1 to 5000,
 * each page is a list of plain objects (pen strokes, arrows, text), and the whole value is at most 512 KB of JSON.
 * Item contents are the viewer's own and are not interpreted here.
 */
export function validateMarkupData(value: unknown): Obj {
  if (!isPlainObject(value)) throw badRequest("invalid_markup", "Markup data must be an object.");
  const data = value as Obj;
  if (data.schema !== undefined && !(Number.isInteger(data.schema) && Number(data.schema) >= 1)) throw badRequest("invalid_markup", "Markup schema must be a positive whole number.");
  if (!isPlainObject(data.pages)) throw badRequest("invalid_markup", "Markup data needs a pages object.");
  for (const [page, items] of Object.entries(data.pages as Obj)) {
    if (!/^[1-9][0-9]{0,3}$/.test(page) || Number(page) > MAX_MARKUP_PAGE) throw badRequest("invalid_markup_page", `Page keys are page numbers from 1 to ${MAX_MARKUP_PAGE}.`);
    if (!Array.isArray(items) || !items.every(isPlainObject)) throw badRequest("invalid_markup_page", "Each page is a list of markup items.");
  }
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(data), "utf8"); }
  catch { throw badRequest("invalid_markup", "Markup data must be plain JSON."); }
  if (bytes > MAX_MARKUP_BYTES) throw badRequest("markup_too_large", "This markup is larger than 512 KB.");
  return data;
}

/** The record id for a project's document key. */
export function markupDocumentId(projectId: string, docKey: string) {
  return `pdm_${createHash("sha256").update(`${clean(projectId)}\n${docKey}`).digest("hex").slice(0, 40)}`;
}

type StoredLayer = { id: string; revision: number; updated_at: string; data: Obj; metadata?: Obj };

/** What a client gets back. The saver's email stays in the record and is not returned. */
function layerView(stored: StoredLayer) {
  const data = obj(stored.data), metadata = obj(stored.metadata);
  return {
    doc_key: clean(data.doc_key),
    data: obj(data.markup),
    revision: Number(stored.revision) || 0,
    updated_at: clean(stored.updated_at),
    ...(clean(metadata.updated_by_name) ? { updated_by_name: clean(metadata.updated_by_name) } : {})
  };
}

async function readStored(orgId: string, projectId: string, docKey: string): Promise<StoredLayer | null> {
  try { return await readDocument(orgId, PROJECT_DOCUMENT_MARKUP_COLLECTION, markupDocumentId(projectId, docKey)) as unknown as StoredLayer; }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}

/** The project's markup for a document, or null. The caller has already authorized the project. */
export async function readProjectDocumentMarkup(orgId: string, projectId: string, docKeyValue: unknown) {
  const stored = await readStored(orgId, projectId, normalizeDocKey(docKeyValue));
  return stored ? layerView(stored) : null;
}

export type MarkupSaver = { user_id: string; name?: string; email?: string };

/**
 * Replaces the project's markup for a document. `expected_revision`, when given, must match the stored revision
 * (0 for none yet), so a viewer that loaded an older copy is told instead of overwriting.
 */
export async function saveProjectDocumentMarkup(orgId: string, projectId: string, docKeyValue: unknown, dataValue: unknown, saver: MarkupSaver, options: { expected_revision?: number } = {}) {
  const docKey = normalizeDocKey(docKeyValue);
  const markup = validateMarkupData(dataValue);
  const expected = options.expected_revision;
  if (expected !== undefined && !(Number.isInteger(expected) && expected >= 0)) throw badRequest("invalid_expected_revision", "expected_revision must be a whole number.");
  const id = markupDocumentId(projectId, docKey);
  const saved = await upsertDocument(orgId, PROJECT_DOCUMENT_MARKUP_COLLECTION, {
    id,
    ...(expected ? { expected_revision: expected } : {}),
    data: { project_id: clean(projectId), doc_key: docKey, markup },
    metadata: {
      updated_by_user_id: clean(saver.user_id),
      ...(clean(saver.name) ? { updated_by_name: clean(saver.name) } : {}),
      ...(clean(saver.email) ? { updated_by_email: clean(saver.email) } : {})
    }
  }, { replace: true, ...(expected === 0 ? { createOnly: true } : {}) });
  return layerView(saved as unknown as StoredLayer);
}

/**
 * Project merge: the merged project's markup moves to the survivor under the same document key. Where the survivor
 * already has markup for that key, the survivor's stays and the merged project's record is kept under its own id.
 * Reads the collection once per merge (docs/optimization-backlog.md).
 */
export function projectDocumentMarkupAdapter() {
  return {
    id: "project-document-markup",
    async repoint(orgId: string, fromId: string, toId: string) {
      let moved = 0;
      const rows = await listDocuments(orgId, PROJECT_DOCUMENT_MARKUP_COLLECTION).catch(() => []);
      for (const row of rows) {
        const data = obj(row.data);
        if (clean(data.project_id) !== fromId) continue;
        const docKey = clean(data.doc_key);
        if (!DOC_KEY_PATTERN.test(docKey) || await readStored(orgId, toId, docKey)) continue;
        await upsertDocument(orgId, PROJECT_DOCUMENT_MARKUP_COLLECTION, {
          id: markupDocumentId(toId, docKey),
          data: { ...data, project_id: toId, merged_from_project_id: fromId },
          metadata: obj(row.metadata)
        }, { replace: true, createOnly: true });
        await deleteDocument(orgId, PROJECT_DOCUMENT_MARKUP_COLLECTION, clean(row.id));
        moved++;
      }
      return moved;
    }
  };
}

const saveBody = z.object({
  data: z.unknown(),
  expected_revision: z.number().int().min(0).optional()
}).passthrough();

function saverOf(ctx: PlatformAuthContext): MarkupSaver {
  const user = obj(ctx.user), identity = obj(ctx.identity);
  return {
    user_id: clean(ctx.userId),
    name: clean(user.name || identity.name || identity.display_name),
    email: clean(user.email || identity.email)
  };
}

/** Browser routes, inside the /v1/platform plugin (PlatformAPI.projectDocumentMarkup in platform-api.js). */
export function registerProjectDocumentMarkupRoutes(app: FastifyInstance) {
  // The key is checked after the caller and the project, so a refused caller learns nothing from a key's shape.
  const params = (request: FastifyRequest) => {
    const p = obj(request.params);
    return { orgId: clean(p.orgId), projectId: clean(p.projectId), docKey: p.docKey };
  };
  app.get("/organizations/:orgId/projects/:projectId/document-markup/:docKey", async (request) => {
    const { orgId, projectId, docKey } = params(request);
    const ctx = await requirePlatformAuth(request, { app: PROJECT_DOCUMENT_MARKUP_APPS, orgId });
    await readProjectForMedia(ctx, projectId, "view_projects");
    return { ok: true, layer: await readProjectDocumentMarkup(ctx.orgId, projectId, docKey) };
  });
  app.put("/organizations/:orgId/projects/:projectId/document-markup/:docKey", async (request) => {
    const { orgId, projectId, docKey } = params(request);
    const ctx = await requirePlatformAuth(request, { app: PROJECT_DOCUMENT_MARKUP_APPS, orgId, csrf: true });
    await readProjectForMedia(ctx, projectId, "manage_projects");
    const body = saveBody.parse(request.body ?? {});
    return { ok: true, layer: await saveProjectDocumentMarkup(ctx.orgId, projectId, docKey, body.data, saverOf(ctx), { expected_revision: body.expected_revision }) };
  });
}
