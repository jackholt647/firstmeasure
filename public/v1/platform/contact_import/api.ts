// Contact import pipeline: upload/preview -> commit -> history/undo.
//
// Imported contacts become `contact_only` project documents (the platform's
// standalone-contact shape), so they surface everywhere contacts already do:
// the My Contacts tab, global search, the contact modal, and portal links.
// Each import is recorded in the private `contact_imports` collection with
// the applied tags, per-row outcomes, and the created document ids so the
// whole batch can be undone.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";

import { requirePlatformAuth } from "../auth.js";
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
  match: { kind: "existing" | "file"; project_id: string; contact_id: string; name: string } | null;
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

type ExistingContactRef = { project_id: string; contact_id: string; name: string };

async function buildExistingContactIndex(orgId: string) {
  const index = new Map<string, ExistingContactRef>();
  const documents = await listDocuments(orgId, "projects");
  for (const document of documents) {
    const data = asObject(document.data);
    const projectId = cleanText(data.id || document.id);
    for (const entry of asArray(data.contacts)) {
      const contact = asObject(entry);
      const ref: ExistingContactRef = {
        project_id: projectId,
        contact_id: cleanText(contact.id || contact.contact_id),
        name: cleanText(contact.name)
      };
      for (const key of contactIdentityKeys(contact)) {
        if (!index.has(key)) index.set(key, ref);
      }
    }
  }
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
        match: { kind: "file" as const, project_id: "", contact_id: "", name: cleanText(rows[fileMatchIndex]?.name) }
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

function contactOnlyProjectRecord(row: ImportedContactRow, options: {
  importId: string;
  importedAt: string;
  sourceLabel: string;
  tags: string[];
  sequence: number;
}) {
  const suffix = `${Date.now().toString(36)}_${options.sequence.toString(36)}${randomToken(3)}`;
  const projectId = `project_${suffix}`;
  const contactId = `contact_${suffix}`;
  const title = cleanText(row.name) || cleanText(row.email) || cleanText(row.phone) || "Imported contact";
  const contact = {
    id: contactId,
    contact_id: contactId,
    name: cleanText(row.name),
    email: cleanText(row.email).toLowerCase(),
    phone: cleanText(row.phone),
    address: cleanText(row.address),
    default_address: cleanText(row.address),
    company: cleanText(row.company),
    notes: contactNotes(row),
    birthday: cleanText(row.birthday),
    tags: mergeTagLists(row.tags, options.tags),
    imported_at: options.importedAt,
    import_id: options.importId,
    import_source: options.sourceLabel,
    primary: true
  };
  return {
    id: projectId,
    data: {
      id: projectId,
      title,
      project_title: title,
      contacts: [contact],
      address: cleanText(row.address),
      project_type: "residential",
      workflow_state: "contact_only",
      measurement: {},
      measurement_project: {},
      events: [],
      proposals: [],
      created_at: options.importedAt,
      updated_at: options.importedAt
    },
    metadata: {
      kind: "platform_project",
      workflow_state: "contact_only",
      source: "contact_import",
      import_id: options.importId
    }
  };
}

async function mergeImportedContactIntoProject(orgId: string, match: ExistingContactRef, row: ImportedContactRow, options: {
  importId: string;
  importedAt: string;
  sourceLabel: string;
  tags: string[];
}) {
  const document = await readDocument(orgId, "projects", match.project_id);
  const data = asObject(document.data);
  const contacts = asArray(data.contacts).map(asObject);
  const keys = new Set(contactIdentityKeys(row));
  const index = contacts.findIndex((contact) => (
    (match.contact_id && cleanText(contact.id || contact.contact_id) === match.contact_id)
    || contactIdentityKeys(contact).some((key) => keys.has(key))
  ));
  if (index < 0) return false;
  const current = contacts[index]!;
  contacts[index] = {
    ...current,
    name: cleanText(current.name) || cleanText(row.name),
    email: cleanText(current.email) || cleanText(row.email).toLowerCase(),
    phone: cleanText(current.phone) || cleanText(row.phone),
    address: cleanText(current.address) || cleanText(row.address),
    default_address: cleanText(current.default_address) || cleanText(row.address),
    company: cleanText(current.company) || cleanText(row.company),
    notes: cleanText(current.notes) || contactNotes(row),
    birthday: cleanText(current.birthday) || cleanText(row.birthday),
    tags: mergeTagLists(current.tags, row.tags, options.tags),
    imported_at: cleanText(current.imported_at) || options.importedAt,
    import_id: cleanText(current.import_id) || options.importId,
    import_source: cleanText(current.import_source) || options.sourceLabel
  };
  await upsertDocument(orgId, "projects", {
    id: match.project_id,
    data: { ...data, contacts, updated_at: options.importedAt },
    metadata: asObject(document.metadata)
  }, { replace: true });
  return true;
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
      created_project_ids: [],
      updated_project_ids: [],
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
      rows: rows.slice(0, PREVIEW_ROW_RESPONSE_LIMIT),
      returned_rows: Math.min(rows.length, PREVIEW_ROW_RESPONSE_LIMIT)
    };
  });

  app.post("/organizations/:orgId/contact-imports/:importId/commit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const importId = getParam(request.params, "importId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = asObject(request.body);
    const document = await readDocument(orgId, "contact_imports", importId).catch(() => null);
    if (!document) throw notFound("contact_import_not_found", "The contact import was not found.");
    const record = asObject(document.data);
    if (cleanText(record.status) !== "pending") {
      throw conflict("contact_import_not_pending", "This import has already been committed or undone.");
    }

    const tags = normalizedTagList(body.tags);
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

    const createdProjectIds: string[] = [];
    const updatedProjectIds: string[] = [];
    let skipped = 0;
    let failed = 0;
    await mapWithConcurrency(planned, COMMIT_WRITE_CONCURRENCY, async (entry, sequence) => {
      if (entry.action === "skip") {
        skipped += 1;
        return;
      }
      try {
        if (entry.action === "create") {
          const projectRecord = contactOnlyProjectRecord(entry.row.contact, { importId, importedAt, sourceLabel, tags, sequence });
          await upsertDocument(orgId, "projects", projectRecord);
          createdProjectIds.push(projectRecord.id);
          return;
        }
        const merged = await mergeImportedContactIntoProject(orgId, entry.row.match!, entry.row.contact, { importId, importedAt, sourceLabel, tags });
        if (merged) updatedProjectIds.push(entry.row.match!.project_id);
        else skipped += 1;
      } catch {
        failed += 1;
      }
    });

    const counts = {
      created: createdProjectIds.length,
      updated: updatedProjectIds.length,
      skipped,
      invalid: rows.filter((row) => row.status === "invalid").length,
      failed
    };
    // The committed record keeps outcomes and created ids (for undo) but
    // drops the raw rows so history documents stay small.
    const committed = {
      ...record,
      status: "committed",
      tags,
      duplicate_action: duplicateAction,
      counts,
      created_project_ids: createdProjectIds,
      updated_project_ids: [...new Set(updatedProjectIds)],
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
    return { ok: true, import_id: importId, counts, tags, status: "committed" };
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
        rows: asArray(data.rows).slice(0, PREVIEW_ROW_RESPONSE_LIMIT)
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
    const createdIds = asArray(record.created_project_ids).map(cleanText).filter(Boolean);
    let removed = 0;
    let kept = 0;
    await mapWithConcurrency(createdIds, COMMIT_WRITE_CONCURRENCY, async (projectId) => {
      const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
      if (!projectDocument) return;
      const data = asObject(projectDocument.data);
      const metadata = asObject(projectDocument.metadata);
      // Only remove records this import created that are still bare
      // contacts: untouched workflow state and no attached work.
      const untouched = cleanText(metadata.import_id) === importId
        && cleanText(data.workflow_state) === "contact_only"
        && !asArray(data.events).length
        && !asArray(data.proposals).length;
      if (!untouched) {
        kept += 1;
        return;
      }
      await deleteDocument(orgId, "projects", projectId);
      removed += 1;
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
