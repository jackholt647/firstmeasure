import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../src/config/env.js";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function signature(orgId: string, mediaId: string) {
  return createHmac("sha256", env.platformSessionSecret)
    .update(`${clean(orgId)}:${clean(mediaId)}:audio-note`)
    .digest("base64url");
}

export function audioMediaPublicUrl(orgId: string, mediaId: string) {
  const token = signature(orgId, mediaId);
  return `${env.publicBaseUrl}/v1/audio-notes/public/${encodeURIComponent(orgId)}/${encodeURIComponent(mediaId)}/${token}`;
}

export function validAudioMediaToken(orgId: string, mediaId: string, token: string) {
  const expected = Buffer.from(signature(orgId, mediaId));
  const actual = Buffer.from(clean(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
