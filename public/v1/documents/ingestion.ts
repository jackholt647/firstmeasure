import path from "node:path";

import { storeMediaUpload, type JsonObject } from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import { DOCUMENT_SCHEMA_VERSION } from "./schemas.js";
import {
  documentInstanceId,
  readDocumentTemplate,
  readDocumentTemplateVersion,
  recordDocumentEvent,
  saveDocumentInstance
} from "./storage.js";
import { documentType, listDocumentTypes } from "./types/registry.js";

/**
 * Document ingestion v1 — the full pipeline shape with the extraction call
 * stubbed. Uploads land in the media store and become `source: "uploaded"`
 * document instances in `needs_review`, exactly like generated documents
 * answer the same queries once confirmed.
 *
 * The LLM classify/extract pass (modeled on payments/receipt_extraction.ts:
 * strict json-schema, hardened untrusted-content prompt, retries, heuristic
 * fallback) plugs in through registerDocumentExtractor — nothing here calls a
 * model provider yet.
 */

export const DOCUMENT_INGESTION_SCHEMA_VERSION = 1;
export const DOCUMENT_INGESTION_LIMIT_BYTES = 49 * 1024 * 1024;

export type DocumentExtractionInput = {
  bytes: Buffer;
  fileName: string;
  contentType: string;
  organizationId: string;
  projectId?: string;
  documentTypeHint?: string;
  /** Template-declared fields: when present the extractor fills EXACTLY these. */
  paramDefs?: JsonObject;
  outputDefs?: JsonObject;
};

export type DocumentExtractionResult = JsonObject & {
  document_type: string;
  confidence: number;
  params: JsonObject;
  outputs?: JsonObject;
  method: string;
  warnings?: string[];
};

export type DocumentExtractor = (input: DocumentExtractionInput) => Promise<DocumentExtractionResult>;

let extractor: DocumentExtractor | null = null;

/** Plug in the real classify+extract pass (LLM-backed) without touching this pipeline. */
export function registerDocumentExtractor(fn: DocumentExtractor) {
  extractor = fn;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

const TYPE_HINTS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /change[\s_-]*order|\bco[\s_-]*\d/i, type: "change_order" },
  { pattern: /invoice|\binv[\s_-]*\d/i, type: "invoice" },
  { pattern: /proposal|estimate|quote|bid/i, type: "proposal" },
  { pattern: /contract|agreement|terms/i, type: "contract" },
  { pattern: /work[\s_-]*order|\bwo[\s_-]*\d/i, type: "work_order" }
];

/** Heuristic fallback: file name / type keywords → registered document type. */
export function guessDocumentType(fileName: string, contentType: string, hint = "") {
  const explicit = cleanText(hint).toLowerCase();
  if (explicit && documentType(explicit)) return explicit;
  const haystack = `${cleanText(fileName)} ${cleanText(contentType)}`;
  for (const entry of TYPE_HINTS) {
    if (entry.pattern.test(haystack) && documentType(entry.type)) return entry.type;
  }
  return "generic";
}

function heuristicExtraction(input: DocumentExtractionInput): DocumentExtractionResult {
  const guessed = guessDocumentType(input.fileName, input.contentType, input.documentTypeHint);
  return {
    schema_version: DOCUMENT_INGESTION_SCHEMA_VERSION,
    document_type: guessed,
    confidence: guessed === "generic" ? 0.2 : 0.4,
    params: {},
    outputs: {},
    method: "heuristic_filename",
    warnings: ["Automatic extraction is not configured; review and fill the document fields manually."],
    known_types: listDocumentTypes().map((type) => type.id)
  };
}

export function inferDocumentContentType(fileName: string, supplied: string, bytes?: Buffer) {
  const header = bytes?.subarray(0, 16);
  if (header?.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (header?.length && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header?.length && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const normalized = cleanText(supplied).toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized.split(";")[0] || normalized;
  const ext = path.extname(cleanText(fileName)).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

/** Resolve an upload template's field declarations (type schema + published definition). */
async function uploadTemplateFields(orgId: string, templateId: string) {
  const template = await readDocumentTemplate(orgId, templateId);
  const record = asObject(template);
  const version = Number(record.current_version || 0);
  const published = version
    ? asObject(await readDocumentTemplateVersion(orgId, templateId, version).catch(() => null))
    : {};
  const definition = Object.keys(asObject(published.definition)).length
    ? asObject(published.definition)
    : asObject(record.definition);
  const typeId = cleanText(record.document_type) || "generic";
  const typeDef = documentType(typeId);
  return {
    template: record,
    documentType: typeId,
    version,
    paramDefs: { ...asObject(typeDef?.param_schema), ...asObject(definition.params) },
    outputDefs: { ...asObject(typeDef?.output_schema), ...asObject(definition.outputs) }
  };
}

export async function ingestDocumentUpload(
  orgId: string,
  input: {
    bytes: Buffer;
    fileName: string;
    contentType?: string;
    projectId?: string;
    documentType?: string;
    templateId?: string;
    title?: string;
    metadata?: JsonObject;
  },
  ctx: PlatformAuthContext
) {
  if (!Buffer.isBuffer(input.bytes) || !input.bytes.length) {
    throw badRequest("empty_document_upload", "The uploaded document file is empty.");
  }
  if (input.bytes.length > DOCUMENT_INGESTION_LIMIT_BYTES) {
    throw badRequest("document_upload_too_large", "Uploaded documents must be under 50 MB.");
  }
  // Template-driven paper upload: the template declares which fields matter;
  // the extractor targets exactly those and the instance carries them.
  const templateFields = cleanText(input.templateId)
    ? await uploadTemplateFields(orgId, cleanText(input.templateId))
    : null;
  const contentType = inferDocumentContentType(input.fileName, cleanText(input.contentType), input.bytes);
  const media = await storeMediaUpload(orgId, {
    ownerType: "document",
    ownerId: cleanText(input.projectId) || orgId,
    slot: `ingest_${Date.now()}`,
    collection: "documents",
    scope: "document",
    fileName: input.fileName,
    contentType,
    bytes: input.bytes,
    metadata: {
      source: "documents_ingestion",
      ...(cleanText(input.projectId) ? { project_id: cleanText(input.projectId) } : {}),
      ...asObject(input.metadata)
    }
  });

  const extractionInput: DocumentExtractionInput = {
    bytes: input.bytes,
    fileName: input.fileName,
    contentType,
    organizationId: orgId,
    projectId: cleanText(input.projectId) || undefined,
    documentTypeHint: cleanText(input.documentType) || (templateFields ? templateFields.documentType : undefined),
    ...(templateFields ? { paramDefs: templateFields.paramDefs, outputDefs: templateFields.outputDefs } : {})
  };
  const attempts: JsonObject[] = [];
  let extraction: DocumentExtractionResult;
  if (extractor) {
    try {
      extraction = await extractor(extractionInput);
      attempts.push({ method: cleanText(extraction.method || "registered_extractor"), at: nowIso(), ok: true });
    } catch (error) {
      attempts.push({ method: "registered_extractor", at: nowIso(), ok: false, error: error instanceof Error ? error.message : "extraction failed" });
      extraction = heuristicExtraction(extractionInput);
    }
  } else {
    // TODO: extraction call — classify against registered types, then run the
    // type's extraction schema (see docs/document-engine-spec.md §12).
    extraction = heuristicExtraction(extractionInput);
    attempts.push({ method: extraction.method, at: nowIso(), ok: true });
  }

  const typeId = templateFields
    ? templateFields.documentType
    : guessDocumentType(input.fileName, contentType, cleanText(extraction.document_type || input.documentType));
  const typeDef = documentType(typeId);
  const paramDefs = templateFields ? templateFields.paramDefs : asObject(typeDef?.param_schema);
  const outputDefs = templateFields ? templateFields.outputDefs : asObject(typeDef?.output_schema);
  // Template mode: only declared fields land on the instance.
  const extractedParams = asObject(extraction.params);
  const params = templateFields
    ? Object.fromEntries(Object.entries(extractedParams).filter(([key]) => Object.prototype.hasOwnProperty.call(paramDefs, key)))
    : extractedParams;
  const extractedOutputs = asObject(extraction.outputs);
  const outputs = templateFields
    ? Object.fromEntries(Object.entries(extractedOutputs).filter(([key]) => Object.prototype.hasOwnProperty.call(outputDefs, key)))
    : extractedOutputs;
  const id = documentInstanceId({});
  const now = nowIso();
  const document = await saveDocumentInstance(orgId, id, {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(ctx.branchId || "default") || "default",
    project_id: cleanText(input.projectId),
    document_type: typeId,
    title: cleanText(input.title) || cleanText((extraction as JsonObject).title) || cleanText(input.fileName).replace(/\.[^.]+$/, "") || (typeDef?.label ?? "Uploaded document"),
    template_ref: templateFields ? { template_id: cleanText(input.templateId), version: templateFields.version || 1 } : null,
    theme_ref: null,
    theme_overrides: {},
    contact_ids: [],
    params,
    param_defs: paramDefs,
    output_defs: outputDefs,
    overrides: [],
    outputs,
    status: "needs_review",
    delivery: {},
    pdf: {},
    source: "uploaded",
    ingestion: {
      schema_version: DOCUMENT_INGESTION_SCHEMA_VERSION,
      media_id: cleanText(media.id),
      file_name: cleanText(input.fileName),
      content_type: contentType,
      size_bytes: input.bytes.length,
      extraction,
      attempts,
      confidence: Math.max(0, Math.min(1, Number(extraction.confidence || 0) || 0)),
      ingested_at: now
    },
    metadata: { ...asObject(input.metadata), intake: "upload" },
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  });
  await recordDocumentEvent(orgId, document, "document.ingested", {
    media_id: cleanText(media.id),
    confidence: Number(extraction.confidence || 0) || 0,
    method: cleanText(extraction.method)
  }, ctx);
  return { document, media, extraction };
}
