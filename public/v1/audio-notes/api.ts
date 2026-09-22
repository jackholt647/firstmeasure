import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { readMediaFile, storeMediaUpload } from "../platform/storage.js";
import { audioMediaPublicUrl, validAudioMediaToken } from "./links.js";
import { transcribeAudio } from "./transcription.js";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

export const registerAudioNotesApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, api: "audio-notes" }));

  app.get("/public/:orgId/:mediaId/:token", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const mediaId = getParam(request.params, "mediaId");
    if (!validAudioMediaToken(orgId, mediaId, getParam(request.params, "token"))) {
      throw forbidden("invalid_audio_link", "This audio link is invalid.");
    }
    const file = await readMediaFile(orgId, mediaId);
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Length", String(file.bytes.length));
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("Content-Disposition", `inline; filename="${file.fileName.replace(/["\r\n]/g, "")}"`);
    return reply.send(file.bytes);
  });

  app.post("/organizations/:orgId/transcriptions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, {
      orgId,
      application: ["management", "field"],
      csrf: true
    });

    const typed = request as unknown as {
      parts?: () => AsyncIterable<{
        type: "file" | "field";
        fieldname: string;
        value?: unknown;
        filename?: string;
        mimetype?: string;
        toBuffer?: () => Promise<Buffer>;
      }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Audio transcription must be multipart/form-data.");

    let bytes: Buffer | null = null;
    let fileName = "audio-note.webm";
    let contentType = "audio/webm";
    let language = "";
    let prompt = "";
    for await (const part of parts) {
      if (part.type === "file" && !bytes) {
        bytes = await part.toBuffer?.() ?? null;
        fileName = String(part.filename || fileName);
        contentType = String(part.mimetype || contentType);
      } else if (part.type === "field" && part.fieldname === "language") {
        language = String(part.value ?? "").trim();
      } else if (part.type === "field" && part.fieldname === "prompt") {
        prompt = String(part.value ?? "").trim();
      }
    }
    if (!bytes) throw badRequest("missing_audio", "An audio file field is required.");

    const transcription = await transcribeAudio({ bytes, fileName, contentType, language, prompt });
    return { ok: true, transcription };
  });

  app.post("/organizations/:orgId/uploads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      orgId,
      application: ["management", "field"],
      csrf: true
    });
    const typed = request as unknown as {
      parts?: () => AsyncIterable<{
        type: "file" | "field";
        filename?: string;
        mimetype?: string;
        toBuffer?: () => Promise<Buffer>;
      }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Audio upload must be multipart/form-data.");
    let bytes: Buffer | null = null;
    let fileName = "audio-note.webm";
    let contentType = "audio/webm";
    for await (const part of parts) {
      if (part.type !== "file" || bytes) continue;
      bytes = await part.toBuffer?.() ?? null;
      fileName = String(part.filename || fileName);
      contentType = String(part.mimetype || contentType).toLowerCase();
    }
    if (!bytes) throw badRequest("missing_audio", "An audio file field is required.");
    if (!contentType.startsWith("audio/")) throw badRequest("invalid_audio", "Only audio files can be attached.");
    if (bytes.length > 20 * 1024 * 1024) throw badRequest("audio_too_large", "Audio attachments cannot exceed 20 MB.");
    const media = await storeMediaUpload(orgId, {
      bytes,
      fileName,
      contentType,
      ownerType: "audio_note",
      ownerId: ctx.userId,
      slot: "recording",
      scope: "communications",
      metadata: { source: "audio_notes" }
    });
    return {
      ok: true,
      attachment: {
        media_id: media.id,
        file_name: media.file_name,
        content_type: media.content_type,
        size_bytes: media.size_bytes,
        public_url: audioMediaPublicUrl(orgId, String(media.id))
      }
    };
  });
};
