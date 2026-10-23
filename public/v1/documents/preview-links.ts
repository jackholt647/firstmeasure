import { createHmac } from "node:crypto";

import { forbidden } from "../platform/errors.js";
import { env } from "../src/config/env.js";

/**
 * Read-only document links for the customer portal's preview (staff seeing what
 * the customer sees). A preview link is a keyed hash of the snapshot's link: it
 * finds the same document but cannot be turned back into the customer's own
 * link, and every write route refuses it, so nothing is signed, accepted, paid
 * or marked viewed from a preview. Only the staff-session preview payload hands
 * one out.
 */
const PREFIX = "preview_";

export function previewDocumentToken(publicToken: string) {
  return PREFIX + createHmac("sha256", env.platformSessionSecret).update(`document-preview:${publicToken}`).digest("base64url").slice(0, 32);
}

export function isPreviewDocumentToken(token: string) {
  return String(token || "").startsWith(PREFIX);
}

export function refusePreviewDocumentToken(token: string) {
  if (isPreviewDocumentToken(token)) throw forbidden("portal_preview_read_only", "This is a preview of what your customer sees. Nothing can be signed, accepted or paid in a preview.");
}
