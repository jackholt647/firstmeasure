import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { badRequest, forbidden } from "../../platform/errors.js";
import type { JsonObject } from "../../platform/storage.js";

export const object = (v: unknown): JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
export const text = (v: unknown) => String(v ?? "").trim();
export function digest(v: unknown): string {
  const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;
  return createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
}
export const token = () => randomBytes(32).toString("base64url");
export const tokenHash = (v: string) => createHash("sha256").update(v).digest("hex");
export function party(def: JsonObject): "customer" | "company" {
  return ["internal", "company"].includes(text(def.party || def.signer)) ? "company" : "customer";
}
export function signatureDefinitions(defs: unknown): Record<string, JsonObject> {
  return Object.fromEntries(Object.entries(object(defs)).filter(([, d]) => object(d).type === "signature").map(([k, d]) => [k, object(d)]));
}
export type Signer = { id: string; name: string; email: string; user_id: string; party: "customer" | "company"; order: number; capacity: string; fields: string[]; required: boolean };
export type SigningReceipt = { id: string; field: string; signer_id: string; content_hash: string; signed_at: string; value: JsonObject; evidence: JsonObject; request_hash: string };
export type SigningPackage = {
  id: string; organization_id: string; document_id: string; snapshot_id: string; status: "open" | "completed" | "void" | "superseded" | "declined" | "expired";
  signers: Signer[]; fields: Record<string, JsonObject>; receipts: Record<string, SigningReceipt>;
  created_at: string; expires_at: string; content_hash: string; source_hash: string; content: JsonObject;
  /** signingSource as last rendered, to tell the signer's own responses from a company change. */
  source?: JsonObject;
  review_pdf: string; final_pdf: string; final_pdf_hash: string; disclosure: { version: string; text: string; hash: string };
  challenges: Record<string, { id: string; content_hash: string; expires_at: string }>;
  completed_at?: string; retention_until?: string; legal_hold?: boolean;
  /** Pending until the executed copy carries its certification seal (seal.ts). */
  seal?: { status: "pending" | "sealed"; sealed_at?: string; unsealed_sha256?: string; certificate_sha256?: string; certificate_subject?: string; provider?: string; development?: boolean;
    timestamp?: { time: string; authority: string; serial: string } | null; ledger_seq?: number };
};

/** Field identity is independent of geometry: repeated placements share one field;
 * different people at the same position use different keys in output_keys. */
export function inferSignatureDefinitions(definition: JsonObject, existing: JsonObject): JsonObject {
  const defs = { ...existing };
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const node = object(value), props = object(node.props), config = object(props.config);
    const widget = typeof props.widget === "string" ? props.widget : object(props.widget).id;
    if (node.type === "widget" && widget === "doc.signature") {
      const keys = Array.isArray(config.output_keys) ? config.output_keys.map(text) : text(config.output_keys).split(",").map(text).filter(Boolean);
      const signerIds = Array.isArray(config.signer_ids) ? config.signer_ids.map(text) : text(config.signer_ids).split(",").map(text);
      for (const [index, key] of (keys.length ? keys : [text(config.output_key) || "sig_customer"]).entries()) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(key)) throw badRequest("signature_field_key", "Signature field keys must be stable identifiers.");
        if (defs[key] && object(defs[key]).type !== "signature") throw badRequest("signature_field_conflict", `Field '${key}' is not a signature.`);
        defs[key] = { type: "signature", required: true, signer: text(config.signer) || "customer", ...object(defs[key]),
          ...(typeof config.required === "boolean" ? { required: config.required } : {}),
          ...(text(signerIds[index] || config.signer_id) ? { signer_id: text(signerIds[index] || config.signer_id) } : {}) };
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(definition);
  return defs;
}

export function signerPlan(defs: JsonObject, recipients: JsonObject[]): Signer[] {
  const plan = new Map<string, Signer>();
  for (const [key, def] of Object.entries(signatureDefinitions(defs))) {
    const role = party(def), id = text(def.signer_id) || (role === "company" ? "company" : "customer");
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(id)) throw badRequest("signature_signer_id", "Signer IDs must be stable identifiers.");
    const matches = recipients.filter(r => text(r.signer_id || r.role || "customer") === id || (!r.signer_id && [role, role === "company" ? "internal" : "customer"].includes(text(r.role)) && id === role));
    if (matches.length > 1) throw badRequest("signature_recipient_ambiguous", `Assign exactly one recipient to signer '${id}'. Use separate signer IDs for multiple people.`);
    const recipient = matches[0] || {};
    const signer: Signer = plan.get(id) || { id, name: text(recipient.name), email: text(recipient.email).toLowerCase(), user_id: text(recipient.user_id), party: role, order: Number(recipient.order ?? def.signing_order ?? 0), capacity: text(recipient.capacity), fields: [], required: false };
    if (signer.party !== role) throw badRequest("signature_party_conflict", `Signer '${id}' has inconsistent parties.`);
    if (!Number.isSafeInteger(signer.order) || signer.order < 0 || signer.order > 1000) throw badRequest("signature_order", "Signing order must be an integer from 0 to 1000.");
    if (signer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signer.email)) throw badRequest("signature_email", `Enter a valid email for '${id}'.`);
    signer.fields.push(key); signer.required ||= def.required === true || def.required_for === "signed" || def.required_for === "completed";
    plan.set(id, signer);
  }
  if (plan.size > 50) throw badRequest("signature_signer_limit", "A signing package supports up to 50 signers.");
  return [...plan.values()];
}

export function disclosure(contact: string) {
  if (!contact) throw badRequest("signature_contact_required", "Provide a contact for paper copies and electronic-record consent withdrawal.");
  // Every element 15 U.S.C. 7001(c)(1)(B) and (C) asks to be disclosed before
  // consent, in sections a person can scan. Changing this text changes the
  // version: each signature records the exact disclosure it was given.
  const value = [
    "Electronic records and signature disclosure",
    "",
    "Your agreement",
    "By checking the box and selecting Adopt & sign, you agree to receive this agreement and its records electronically and to sign it electronically. Your electronic signature is as binding as a handwritten one. This applies to this agreement only.",
    "",
    "Paper instead",
    `You may sign on paper instead, and you may ask for a paper copy of any record at no charge, by contacting ${contact}.`,
    "",
    "Withdrawing consent",
    `You may withdraw your consent to electronic records, or change the contact details we use, at any time at no charge by contacting ${contact}. Withdrawing does not undo a signature already given.`,
    "",
    "What you need",
    "A device with a current web browser and internet access, and the ability to open and save PDF files. You can download the signed agreement when signing is complete. Checking the box confirms you can view this disclosure on your device."
  ].join("\n");
  return { version: "us-electronic-records-3", text: value, hash: digest(value) };
}

export async function validateSignature(value: unknown): Promise<JsonObject> {
  const input = object(value), type = text(input.type || "typed"), name = text(input.signer_name || input.text);
  if (!["typed", "drawn"].includes(type)) throw badRequest("signature_type", "Choose a typed or drawn electronic signature.");
  if (!name || name.length > 200) throw badRequest("signature_name_required", "Enter your full name (up to 200 characters).");
  let image = "";
  if (type === "drawn") {
    image = text(input.image_data);
    if (image.length > 700000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(image)) throw badRequest("signature_image", "A drawn signature must be a PNG image under 500 KB.");
    try {
      const bytes = Buffer.from(image.split(",")[1]!, "base64");
      const picture = sharp(bytes, { limitInputPixels: 2000000 });
      const meta = await picture.metadata();
      if (meta.format !== "png" || !meta.width || !meta.height || meta.width > 2000 || meta.height > 1000) throw new Error("dimensions");
      const { data, info } = await picture.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let ink = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i + 3]! > 20 && (data[i]! < 240 || data[i + 1]! < 240 || data[i + 2]! < 240)) ink++;
      if (ink < 3) throw new Error("blank");
      image = `data:image/png;base64,${(await sharp(bytes).png().toBuffer()).toString("base64")}`;
    } catch { throw badRequest("signature_image", "Draw a valid, nonempty signature."); }
  }
  return { type, signer_name: name, text: type === "typed" ? name : "", style: ["script", "elegant", "casual", "classic", "formal", "modern"].includes(text(input.style)) ? text(input.style) : "script", ...(image ? { image_data: image } : {}) };
}

export function assertRouting(pkg: SigningPackage, signer: Signer) {
  if (pkg.signers.some(s => s.required && s.order < signer.order && s.fields.some(f => (pkg.fields[f]?.required === true || ["signed", "completed"].includes(text(pkg.fields[f]?.required_for))) && !pkg.receipts[f]))) throw forbidden("signature_waiting_for_signer", "An earlier required signer must finish first.");
}
export function signaturesComplete(pkg: SigningPackage) {
  const required = Object.entries(pkg.fields).filter(([, d]) => d.required === true || ["signed", "completed"].includes(text(d.required_for)));
  return (required.length ? required : Object.entries(pkg.fields)).every(([key]) => !!pkg.receipts[key]);
}
export function publicSignatureOutputs(outputs: JsonObject) {
  return Object.fromEntries(Object.entries(outputs).map(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [key, value];
    const { evidence: _evidence, ...safe } = object(value);
    return [key, safe];
  }));
}
