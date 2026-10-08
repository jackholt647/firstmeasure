import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../src/config/env.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { readMediaMetadata } from "../platform/storage.js";

const allowedTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function signature(orgId: string, mediaId: string) {
  return createHmac("sha256", env.platformSessionSecret)
    .update(`${orgId}:${mediaId}:sms-image`)
    .digest("base64url");
}

export function smsImagePublicUrl(orgId: string, mediaId: string) {
  return `${env.publicBaseUrl}/v1/comms/public/sms-images/${encodeURIComponent(orgId)}/${encodeURIComponent(mediaId)}/${signature(orgId, mediaId)}`;
}

export function validSmsImageToken(orgId: string, mediaId: string, token: string) {
  const expected = Buffer.from(signature(orgId, mediaId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function validateSmsImage(orgId: string, mediaId: string, userId: string) {
  const media = await readMediaMetadata(orgId, mediaId);
  const owner = media.owner && typeof media.owner === "object" ? media.owner as Record<string, unknown> : {};
  if (owner.type !== "user" || owner.id !== userId || owner.slot !== "sms_image") {
    throw forbidden("sms_image_owner", "Choose an image you attached to this message.");
  }
  if (!allowedTypes.has(String(media.content_type)) || Number(media.size_bytes) > 5 * 1024 * 1024) {
    throw badRequest("invalid_sms_image", "Attach a JPG, PNG, GIF, or WebP image under 5 MB.");
  }
  return { media_id: mediaId, file_name: String(media.file_name || "image"), content_type: String(media.content_type) };
}
