import { contactSettings } from "../../contacts/service.js";
import { importContactPhoto } from "../../contacts/photo-import.js";
// Contact import pipeline: upload/preview -> commit -> history/undo.
//
// Imported rows become records in the contact store (docs/architecture/contacts.md),
// written through the contact service. Each import is recorded in the private
// `contact_imports` collection with the applied tags, per-row outcomes, and the
// created contact ids so the whole batch can be undone.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";

import { requirePlatformAuth } from "../auth.js";
import { createContact, listContacts, readContact, removeUnusedContact, updateContact } from "../../contacts/records.js";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../storage.js";
import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_ROW_LIMIT,
  parseContactFile,
  type ContactParseResult,
  type ImportedContactRow
} from "./parse.js";

const PREVIEW_ROW_RESPONSE_LIMIT = 500;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const COMMIT_WRITE_CONCURRENCY = 16;

type ContactImportDeps = {
  invalidateSearchCache: (orgId: string) => void;
};

type RowStatus = "new" | "duplicate" | "invalid";

type ClassifiedRow = {
  index: number;
  status: RowStatus;
  reason: string;
  contact: ImportedContactRow;
  match: { kind: "existing" | "file"; contact_id: string; name: string } | null;
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

function getParam(params: unknown, key: string) {
  return cleanText(params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "");
}

function randomToken(bytes = 4) {
  return randomBytes(bytes).toString("hex");
}

function normalizedTagList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const entry of raw) {
    const tag = cleanText(entry).replace(/\s+/g, " ").slice(0, 80);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 64);
}

function mergeTagLists(...lists: unknown[]) {
  return normalizedTagList(lists.flatMap((list) => normalizedTagList(list)));
}

// Identity keys mirror the client-side contactKey precedence:
// email -> phone digits -> normalized name.
function contactIdentityKeys(contact: { name?: unknown; email?: unknown; phone?: unknown }) {
  const keys: string[] = [];
  const email = cleanText(contact.email).toLowerCase();
  if (email) keys.push(`email:${email}`);
  const phone = cleanText(contact.phone).replace(/\D+/g, "");
  if (phone.length >= 7) keys.push(`phone:${phone}`);
  const name = cleanText(contact.name).toLowerCase().replace(/\s+/g, " ");
  if (name) keys.push(`name:${name}`);
  return keys;
}

type ExistingContactRef = { contact_id: string; name: string };

async function buildExistingContactIndex(orgId: string) {
  const index = new Map<string, ExistingContactRef>();
  let after = "";
  do {
    const page = await listContacts(orgId, { limit: 200, after });
    for (const contact of page.items) {
      const ref: ExistingContactRef = { contact_id: contact.id, name: contact.name };
      for (const key of contactIdentityKeys(contact)) {
        if (!index.has(key)) index.set(key, ref);
      }
    }
    after = page.next || "";
  } while (after);
  return index;
}

function classifyRows(rows: ImportedContactRow[], existing: Map<string, ExistingContactRef>): ClassifiedRow[] {
  const seenInFile = new Map<string, number>();
  return rows.map((contact, index) => {
    const keys = contactIdentityKeys(contact);
    if (!keys.length) {
      return { index, status: "invalid" as const, reason: "The row has no name, email, or phone.", contact, match: null };
    }
    const fileMatchIndex = keys.map((key) => seenInFile.get(key)).find((value) => value !== undefined);
    if (fileMatchIndex !== undefined) {
      return {
        index,
        status: "duplicate" as const,
        reason: `Duplicates row ${fileMatchIndex + 1} of this file.`,
        contact,
        match: { kind: "file" as const, contact_id: "", name: cleanText(rows[fileMatchIndex]?.name) }
      };
    }
    for (const key of keys) seenInFile.set(key, index);
    const existingMatch = keys.map((key) => existing.get(key)).find(Boolean);
    if (existingMatch) {
      return {
        index,
        status: "duplicate" as const,
        reason: `Matches existing contact ${existingMatch.name || existingMatch.contact_id}.`,
        contact,
        match: { kind: "existing" as const, ...existingMatch }
      };
    }
    return { index, status: "new" as const, reason: "", contact, match: null };
  });
}

function classificationSummary(rows: ClassifiedRow[]) {
  return {
    total: rows.length,
    new_count: rows.filter((row) => row.status === "new").length,
    duplicate_count: rows.filter((row) => row.status === "duplicate").length,
    invalid_count: rows.filter((row) => row.status === "invalid").length
  };
}

function decodeUploadBuffer(buffer: Buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString("utf16le");
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return Buffer.from(buffer.subarray(2)).swap16().toString("utf16le");
  }
  return buffer.toString("utf8");
}

function tryParseJsonField(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return asObject(value);
  const raw = cleanText(value);
  if (!raw.startsWith("{")) return {};
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function parseImportUploadRequest(request: FastifyRequest) {
  const typed = request as FastifyRequest & {
    parts?: () => AsyncIterable<{
      type: "file" | "field";
      fieldname: string;
      value?: unknown;
      filename?: string;
      toBuffer?: () => Promise<Buffer>;
    }>;
  };
  const contentType = cleanText(request.headers["content-type"]);
  if (contentType.includes("multipart/form-data")) {
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_unavailable", "Multipart uploads are unavailable on this route.");
    let bytes: Buffer | null = null;
    let fileName = "";
    const fields: Record<string, unknown> = {};
    for await (const part of parts) {
      if (part.type === "file") {
        const buffer = await part.toBuffer?.();
        if (!buffer || !buffer.length) continue;
        if (!bytes) {
          bytes = buffer;
          fileName = cleanText(part.filename || part.fieldname || "contacts");
        }
        continue;
      }
      fields[part.fieldname] = part.value;
    }
    if (!bytes) throw badRequest("missing_contact_file", "A contact file field is required.");
    if (bytes.length > MAX_UPLOAD_BYTES) throw badRequest("contact_file_too_large", "The contact file exceeds the 64MB limit.");
    return {
      content: decodeUploadBuffer(bytes),
      fileName: cleanText(fields.filename) || fileName,
      mapping: tryParseJsonField(fields.mapping),
      sourceLabel: cleanText(fields.source_label || fields.sourceLabel)
    };
  }
  const body = asObject(request.body);
  const content = String(body.content ?? "");
  if (!content.trim()) throw badRequest("missing_contact_content", "Provide a contact file (multipart) or a 'content' field.");
  if (content.length > MAX_UPLOAD_BYTES) throw badRequest("contact_file_too_large", "The contact content exceeds the 64MB limit.");
  return {
    content,
    fileName: cleanText(body.filename || body.file_name || "contacts"),
    mapping: asObject(body.mapping),
    sourceLabel: cleanText(body.source_label || body.sourceLabel)
  };
}

function sourceLabelForFormat(parseResult: ContactParseResult, fileName: string, explicit: string) {
  if (explicit) return explicit;
  const lower = fileName.toLowerCase();
  if (parseResult.format === "vcard") return "vCard";
  if (/google|takeout/.test(lower)) return "Google Contacts CSV";
  if (/outlook/.test(lower)) return "Outlook CSV";
  return parseResult.delimiter === "\t" ? "Tab-separated file" : "CSV file";
}

function contactNotes(row: ImportedContactRow) {
  const lines = [cleanText(row.notes)];
  for (const email of row.extra_emails) lines.push(`Other email: ${email}`);
  for (const phone of row.extra_phones) lines.push(`Other phone: ${phone}`);
  return lines.filter(Boolean).join("\n");
}

function importedContactInput(row: ImportedContactRow, options: {
  importId: string;
  importedAt: string;
  sourceLabel: string;
  tags: string[];
  branchId: string;
}) {
  return {
    name: cleanText(row.name),
    email: cleanText(row.email).toLowerCase(),
    phone: cleanText(row.phone),
    address: cleanText(row.address),
    company: cleanText(row.company),
    notes: contactNotes(row),
    birthday: cleanText(row.birthday),
    tags: mergeTagLists(row.tags, options.tags),
    imported_at: options.importedAt,
    import_id: options.importId,
    import_source: options.sourceLabel,
    contact_kind: row.contact_kind || "human",
    branch_ids: [options.branchId]
  };
}

/** Fills what the existing contact leaves blank; its own values win. Tags are unioned. */
async function mergeImportedContact(orgId: string, contactId: string, row: ImportedContactRow, options: {
  importId: string;
  importedAt: string;
  sourceLabel: string;
  tags: string[];
}) {
  const current = await readContact(orgId, contactId).catch(() => null);
  if (!current) return "";
  const patch: JsonObject = { tags: mergeTagLists(current.tags, row.tags, options.tags) };
  const fill = (key: "name" | "email" | "phone" | "address" | "company" | "notes" | "birthday" | "imported_at" | "import_id" | "import_source", value: string) => {
    if (!cleanText(current[key]) && value) patch[key] = value;
  };
  fill("name", cleanText(row.name));
  fill("email", cleanText(row.email).toLowerCase());
  fill("phone", cleanText(row.phone));
  fill("address", cleanText(row.address));
  fill("company", cleanText(row.company));
  fill("notes", contactNotes(row));
  fill("birthday", cleanText(row.birthday));
  fill("imported_at", options.importedAt);
  fill("import_id", options.importId);
  fill("import_source", options.sourceLabel);
  await updateContact(orgId, current.id, patch);
  return current.id;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function previewRow(raw:unknown){
 const row=asObject(raw),contact=asObject(row.contact),{photo_source,...rest}=contact;
 return {...row,contact:{...rest,photo_available:!!photo_source}};
}
async function attachImportedPhoto(orgId:string,contactId:string,source:string,importId:string){
 const contact=await readContact(orgId,contactId);
 if(contact.profile_media_id)return false;
 const media=await importContactPhoto(orgId,contact.id,source,importId);
 await updateContact(orgId,contact.id,{custom_field_values:{...contact.custom_field_values,profile_photo:{media_id:cleanText(media.id)}}});
 return true;
}
function importSummaryDocument(document: JsonObject): JsonObject {
  const data = asObject(document.data);
  const { rows: _rows, ...rest } = data;
  return { ...rest, row_count: asArray(data.rows).length || Number(asObject(data.summary).total) || 0 };
}

export async function registerContactImportRoutes(app: FastifyInstance, deps: ContactImportDeps) {
  app.post("/organizations/:orgId/contact-imports/preview", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const upload = await parseImportUploadRequest(request);
    const parsed = parseContactFile(upload.fileName, upload.content, upload.mapping);
    if (!parsed.rows.length) {
      throw badRequest("no_contacts_found", "No contacts could be read from the file. Check the format or the column mapping.", {
        headers: parsed.headers,
        mapping: parsed.mapping,
        format: parsed.format,
        warnings: parsed.warnings
      });
    }
    const existing = await buildExistingContactIndex(orgId);
    const rows = classifyRows(parsed.rows, existing);
    const importId = `import_${Date.now().toString(36)}_${randomToken(3)}`;
    const createdAt = nowIso();
    const record = {
      id: importId,
      status: "pending",
      source_format: parsed.format,
      source_label: sourceLabelForFormat(parsed, upload.fileName, upload.sourceLabel),
      filename: upload.fileName,
      headers: parsed.headers,
      mapping: parsed.mapping,
      delimiter: parsed.delimiter,
      warnings: parsed.warnings,
      summary: classificationSummary(rows),
      rows,
      tags: [],
      counts: {},
      created_contact_ids: [],
      updated_contact_ids: [],
      actor_user_id: ctx.userId,
      actor_email: cleanText(ctx.identity.email),
      created_at: createdAt,
      updated_at: createdAt
    };
    await upsertDocument(orgId, "contact_imports", {
      id: importId,
      data: record,
      metadata: { kind: "contact_import", status: "pending" }
    });
    reply.code(201);
    return {
      ok: true,
      import_id: importId,
      format: parsed.format,
      source_label: record.source_label,
      headers: parsed.headers,
      mapping: parsed.mapping,
      mapping_fields: CONTACT_IMPORT_FIELDS,
      warnings: parsed.warnings,
      summary: record.summary,
      row_limit: CONTACT_IMPORT_ROW_LIMIT,
      rows: rows.slice(0, PREVIEW_ROW_RESPONSE_LIMIT).map(previewRow),
      returned_rows: Math.min(rows.length, PREVIEW_ROW_RESPONSE_LIMIT)
    };
  });

  app.post("/organizations/:orgId/contact-imports/:importId/commit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const importId = getParam(request.params, "importId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const branchId = cleanText(ctx.branchId) || "default";
    const body = asObject(request.body);
    const document = await readDocument(orgId, "contact_imports", importId).catch(() => null);
    if (!document) throw notFound("contact_import_not_found", "The contact import was not found.");
    const record = asObject(document.data);
    if (cleanText(record.status) !== "pending") {
      throw conflict("contact_import_not_pending", "This import has already been committed or undone.");
    }

    const settings=await contactSettings(orgId),available=(settings.tags as JsonObject[]).filter(tag=>tag.enabled!==false);
    const tagIds=new Map(available.flatMap(tag=>[[cleanText(tag.id).toLowerCase(),cleanText(tag.id)],[cleanText(tag.label).toLowerCase(),cleanText(tag.id)]]));
    const requestedTags=normalizedTagList(body.tags);
    if(requestedTags.some(tag=>!tagIds.has(tag.toLowerCase())))throw badRequest("contact_tag_unavailable","Choose batch tags from the contact settings catalog.");
    const tags=requestedTags.map(tag=>tagIds.get(tag.toLowerCase())!);
    const duplicateAction = ["skip", "update", "create"].includes(cleanText(body.duplicate_action))
      ? cleanText(body.duplicate_action)
      : "skip";
    const decisions = asObject(body.decisions);
    const importedAt = nowIso();
    const sourceLabel = cleanText(record.source_label);
    const rows = asArray(record.rows).map(asObject) as unknown as ClassifiedRow[];

    type PlannedAction = { row: ClassifiedRow; action: "create" | "update" | "skip" };
    const planned: PlannedAction[] = rows.map((row) => {
      const decision = cleanText(decisions[String(row.index)]);
      if (row.status === "invalid") return { row, action: "skip" as const };
      if (decision === "skip" || decision === "create") return { row, action: decision as "skip" | "create" };
      if (decision === "update") {
        return { row, action: row.match?.kind === "existing" ? "update" as const : "skip" as const };
      }
      if (row.status === "new") return { row, action: "create" as const };
      // Duplicates within the file never auto-create; existing-contact
      // duplicates follow the caller's duplicate_action.
      if (row.match?.kind === "file") return { row, action: "skip" as const };
      if (duplicateAction === "create") return { row, action: "create" as const };
      if (duplicateAction === "update") return { row, action: "update" as const };
      return { row, action: "skip" as const };
    });

    const createdContactIds: string[] = [];
    const updatedContactIds: string[] = [];
    let skipped = 0;
    let failed = 0,photosImported=0,photosFailed=0;
    const ignoredTags=new Set<string>(),photoErrors:JsonObject[]=[];
    const photosEnabled=body.import_photos===true;
    const importPhoto=async(contactId:string,source:string,index:number)=>{
      if(!photosEnabled || !source)return;
      try{if(await attachImportedPhoto(orgId,contactId,source,importId))photosImported++;}
      catch(e){photosFailed++;if(photoErrors.length<100)photoErrors.push({index,code:cleanText((e as any)?.code)||"contact_photo_import_failed",message:"Contact saved, but its optional photo could not be imported."});}
    };
    await mapWithConcurrency(planned, photosEnabled?4:COMMIT_WRITE_CONCURRENCY, async (entry) => {
      if (entry.action === "skip") {
        skipped += 1;
        return;
      }
      try {
        const source=entry.row.contact.photo_source || "";
        entry.row.contact.tags=entry.row.contact.tags.flatMap(tag=>{const id=tagIds.get(tag.toLowerCase());if(!id){ignoredTags.add(tag);return [];}return [id];});
        if (entry.action === "create") {
          const contact = await createContact(orgId, importedContactInput(entry.row.contact, { importId, importedAt, sourceLabel, tags, branchId }));
          createdContactIds.push(contact.id);
          await importPhoto(contact.id,source,entry.row.index);
          return;
        }
        const mergedId = await mergeImportedContact(orgId, entry.row.match!.contact_id, entry.row.contact, { importId, importedAt, sourceLabel, tags });
        if (mergedId) {updatedContactIds.push(mergedId);await importPhoto(mergedId,source,entry.row.index);}
        else skipped += 1;
      } catch {
        failed += 1;
      }
    });

    const counts = {
      created: createdContactIds.length,
      updated: updatedContactIds.length,
      skipped,
      invalid: rows.filter((row) => row.status === "invalid").length,
      failed,photos_imported:photosImported,photos_failed:photosFailed
    };
    // The committed record keeps outcomes and created ids (for undo) but
    // drops the raw rows so history documents stay small.
    const committed = {
      ...record,
      status: "committed",
      tags,
      duplicate_action: duplicateAction,
      counts,photo_errors:photoErrors,ignored_tags:[...ignoredTags],
      created_contact_ids: createdContactIds,
      updated_contact_ids: [...new Set(updatedContactIds)],
      rows: [],
      committed_at: importedAt,
      updated_at: importedAt
    };
    await upsertDocument(orgId, "contact_imports", {
      id: importId,
      data: committed,
      metadata: { kind: "contact_import", status: "committed" },
      expected_revision: document.revision
    }, { replace: true });
    deps.invalidateSearchCache(orgId);
    return { ok: true, import_id: importId, counts, tags, photo_errors:photoErrors,ignored_tags:[...ignoredTags],status: "committed" };
  });

  app.get("/organizations/:orgId/contact-imports", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const documents = await listDocuments(orgId, "contact_imports");
    const imports = documents
      .map(importSummaryDocument)
      .sort((a, b) => cleanText(b["created_at"]).localeCompare(cleanText(a["created_at"])));
    return { ok: true, imports, count: imports.length, mapping_fields: CONTACT_IMPORT_FIELDS };
  });

  app.get("/organizations/:orgId/contact-imports/:importId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_projects" });
    const document = await readDocument(orgId, "contact_imports", getParam(request.params, "importId")).catch(() => null);
    if (!document) throw notFound("contact_import_not_found", "The contact import was not found.");
    const data = asObject(document.data);
    return {
      ok: true,
      import: {
        ...data,
        rows: asArray(data.rows).slice(0, PREVIEW_ROW_RESPONSE_LIMIT).map(previewRow)
      }
    };
  });

  app.delete("/organizations/:orgId/contact-imports/:importId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const importId = getParam(request.params, "importId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const document = await readDocument(orgId, "contact_imports", importId).catch(() => null);
    if (!document) throw notFound("contact_import_not_found", "The contact import was not found.");
    if (cleanText(asObject(document.data).status) !== "pending") {
      throw conflict("contact_import_not_pending", "Only pending (previewed) imports can be discarded. Use undo for committed imports.");
    }
    await deleteDocument(orgId, "contact_imports", importId);
    return { ok: true, deleted: true };
  });

  app.post("/organizations/:orgId/contact-imports/:importId/undo", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const importId = getParam(request.params, "importId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const document = await readDocument(orgId, "contact_imports", importId).catch(() => null);
    if (!document) throw notFound("contact_import_not_found", "The contact import was not found.");
    const record = asObject(document.data);
    if (cleanText(record.status) !== "committed") {
      throw conflict("contact_import_not_committed", "Only committed imports can be undone.");
    }
    // A contact this import created goes unless something now uses it (a project link) or it was merged.
    const createdIds = asArray(record.created_contact_ids).map(cleanText).filter(Boolean);
    let removed = 0;
    let kept = 0;
    await mapWithConcurrency(createdIds, COMMIT_WRITE_CONCURRENCY, async (contactId) => {
      if (await removeUnusedContact(orgId, contactId, importId)) removed += 1;
      else kept += 1;
    });
    const undoneAt = nowIso();
    await upsertDocument(orgId, "contact_imports", {
      id: importId,
      data: {
        ...record,
        status: "undone",
        undone_at: undoneAt,
        updated_at: undoneAt,
        undo_counts: { removed, kept }
      },
      metadata: { kind: "contact_import", status: "undone" }
    }, { replace: true });
    deps.invalidateSearchCache(orgId);
    return { ok: true, import_id: importId, removed, kept, status: "undone" };
  });
}
