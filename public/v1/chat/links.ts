import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../src/config/env.js";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function signature(orgId: string, mediaId: string) {
  return createHmac("sha256", env.platformSessionSecret)
    .update(`${clean(orgId)}:${clean(mediaId)}:chat-page-snapshot`)
    .digest("base64url");
}

export function pageSnapshotPublicUrl(orgId: string, mediaId: string) {
  return `${env.publicBaseUrl}/v1/chat/public/page-snapshots/${encodeURIComponent(orgId)}/${encodeURIComponent(mediaId)}/${signature(orgId, mediaId)}`;
}

export function validPageSnapshotToken(orgId: string, mediaId: string, token: string) {
  const expected = Buffer.from(signature(orgId, mediaId));
  const actual = Buffer.from(clean(token));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
