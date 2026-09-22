/**
 * The one signature primitive for customer-portal sign-offs.
 *
 * Punch-list submit/accept, project completion sign-off, and document
 * signatures all produce the SAME artifact shape and the same evidence
 * payload. That is deliberate: a signature is a legal record, and having three
 * near-identical shapes would mean three places to get retention, rendering,
 * and export subtly wrong.
 *
 * Shape matches the document engine's `doc.signature` output
 * (docs/document-engine-contracts.md §2):
 *   { type, text, signer_name, style, image_data?, signed_at, evidence }
 *
 * Contract: docs/customer-portal-v2-spec.md §8.2 / §8.4.
 */

import { badRequest } from "./errors.js";
import type { JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Normalize a customer signature.
 *
 * Throws with a specific code on each rejection so the portal can explain
 * itself — an unexplained refusal on a signature screen reads as broken.
 */
export function normalizePortalSignature(value: unknown, evidence: JsonObject = {}): JsonObject {
  const input = asObject(value);
  const type = cleanText(input.type).toLowerCase() === "drawn" ? "drawn" : "typed";
  const signerName = cleanText(input.signer_name || input.name || input.text);
  if (!signerName) throw badRequest("signature_name_required", "Please enter your name to sign.");
  if (type === "drawn" && !cleanText(input.image_data)) {
    throw badRequest("signature_image_required", "Please draw your signature before submitting.");
  }
  return {
    type,
    text: cleanText(input.text || signerName),
    signer_name: signerName,
    style: cleanText(input.style),
    ...(type === "drawn" ? { image_data: cleanText(input.image_data) } : {}),
    signed_at: new Date().toISOString(),
    evidence
  };
}

/**
 * Evidence captured alongside a portal signature. Same fields the document
 * engine records so the two are comparable in an audit.
 */
export function portalSignatureEvidenceFrom(request: unknown): JsonObject {
  const typed = request as { ip?: string; headers?: JsonObject } | null;
  return {
    ip: cleanText(typed?.ip),
    user_agent: cleanText(asObject(typed?.headers)["user-agent"]),
    captured_at: new Date().toISOString(),
    source: "customer_portal"
  };
}

/** Display-safe projection: the audit fields never travel back to the client. */
export function publicSignatureSummary(value: unknown): JsonObject | null {
  const signature = asObject(value);
  if (!cleanText(signature.signer_name)) return null;
  return {
    signer_name: cleanText(signature.signer_name),
    signed_at: cleanText(signature.signed_at),
    type: cleanText(signature.type) || "typed"
  };
}
