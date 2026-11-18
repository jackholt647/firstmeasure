import { badRequest, forbidden } from "../platform/errors.js";
import { readMediaFile, readMediaMetadata } from "../platform/storage.js";

/**
 * Files a person attaches to an email in a project's Comms tab. The browser
 * uploads each one as the person's own media in this slot and sends only its
 * id; the bytes are read here, so nobody can attach media they did not upload
 * for an email.
 */
export const EMAIL_ATTACHMENT_SLOT = "email_attachment";
export const MAX_EMAIL_ATTACHMENTS = 10;
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const clean = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function loadEmailAttachments(orgId: string, mediaIds: string[], userId: string) {
  const ids = [...new Set(mediaIds.map(clean).filter(Boolean))];
  if (ids.length > MAX_EMAIL_ATTACHMENTS) throw badRequest("too_many_email_attachments", "Attach up to 10 files to one email.");
  const files: Array<{ name: string; content_type: string; content: Uint8Array }> = [];
  const summaries: Array<{ media_id: string; file_name: string; content_type: string; size_bytes: number }> = [];
  let total = 0;
  for (const id of ids) {
    const media = await readMediaMetadata(orgId, id);
    const owner = object(media.owner);
    if (clean(owner.type) !== "user" || clean(owner.id) !== userId || clean(owner.slot) !== EMAIL_ATTACHMENT_SLOT || clean(object(media.metadata).uploaded_by_user_id) !== userId) {
      throw forbidden("email_attachment_owner", "Choose a file you attached to this email.");
    }
    total += Number(media.size_bytes || 0);
    if (total > MAX_EMAIL_ATTACHMENT_BYTES) throw badRequest("email_attachments_too_large", "Attachments can add up to 10 MB per email.");
    const file = await readMediaFile(orgId, id);
    const name = clean(media.file_name) || clean(file.fileName) || "attachment";
    files.push({ name, content_type: clean(file.contentType) || "application/octet-stream", content: new Uint8Array(file.bytes) });
    summaries.push({ media_id: id, file_name: name, content_type: clean(file.contentType), size_bytes: file.bytes.length });
  }
  return { files, summaries };
}
