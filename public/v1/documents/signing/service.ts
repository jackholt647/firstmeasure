import { documentTags } from "../tags.js";
import { validateDeliverables, publishAcceptedMaterials } from "../../materials/calculus.js";
import { randomUUID, createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { badRequest, conflict, forbidden, notFound } from "../../platform/errors.js";
import { hasPermission, type PlatformAuthContext } from "../../platform/auth.js";
import { readOrganization, readMediaFile, type JsonObject } from "../../platform/storage.js";
import { readDocumentInstance, readDocumentSnapshot, saveDocumentInstance, saveDocumentSnapshot, recordDocumentEvent } from "../storage.js";
import { FMDocModel } from "../schemas.js";
import { buildRenderHarnessHtml } from "../render.js";
import { renderDocumentPdf } from "../pdf.js";
import { documentCapabilityState, documentCapabilityEnabled, DOCUMENT_CAPABILITIES } from "../capability_policy.js";
import { object, text, digest, token, signatureDefinitions, signerPlan, disclosure, validateSignature, assertRouting, signaturesComplete, publicSignatureOutputs, type SigningPackage, type Signer } from "./model.js";
import { withSigningLock, signingStore, readPackage, savePackage, packagesForDocument, packageForSnapshot, addInvitation, resolveSigningInvitation, queueSigningEvent } from "./store.js";

export function signingSource(document: JsonObject) {
  const defs = object(document.output_defs);
  return { title: document.title, project_id: document.project_id, branch_id: document.branch_id, document_type: document.document_type, ...(document.tags !== undefined ? { tags: documentTags(document.tags) } : {}), ingestion: document.ingestion, params: document.params, overrides: document.overrides, template_ref: document.template_ref,
    workflow_ref: document.workflow_ref, theme_ref: document.theme_ref, theme_overrides: document.theme_overrides,
    output_defs: defs, module_ref: document.module_ref, module_resolved: document.module_resolved, materials_deliverables: document.materials_deliverables,
    outputs: Object.fromEntries(Object.entries(object(document.outputs)).filter(([key]) => !["signature", "payment"].includes(text(object(defs[key]).type)))) };
}
/** Last line of defense for domain adapters that persist document projections. */
export async function assertSigningWrite(orgId: string, documentId: string, next: JsonObject) {
  for (const pkg of await packagesForDocument(orgId, documentId)) {
    if (!Object.keys(pkg.receipts).length) continue;
    if (digest(signingSource(next)) !== pkg.source_hash) throw conflict("document_locked_signed", "Accepted contract content cannot change. Create a replacement or amendment.");
    for (const [field, receipt] of Object.entries(pkg.receipts)) {
      const value = object(object(next.outputs)[field]);
      if (digest(value) !== digest(publicReceipts(pkg)[field])) throw conflict("signature_immutable", "Accepted signatures cannot be removed or replaced.");
    }
  }
}
export async function assertSigningEditable(orgId: string, documentId: string) {
  const packages = await packagesForDocument(orgId, documentId);
  if (packages.some(p => Object.keys(p.receipts).length)) throw conflict("document_locked_signed", "This document has accepted signatures. Create an amendment or a replacement document.");
}
export async function revokeSigningPackages(orgId: string, documentId: string, state: "void" | "superseded" | "declined" = "void") {
  for (const pkg of await packagesForDocument(orgId, documentId)) {
    if (pkg.status === "open") { pkg.status = state; await savePackage(pkg); await queueSigningEvent(pkg, `document.signing.${state}`, "", {}); }
  }
}

export async function validateSigningIssue(orgId: string, document: JsonObject, recipients: JsonObject[], input: JsonObject = {}) {
  validateDeliverables(document.materials_deliverables);
  const fields = signatureDefinitions(document.output_defs);
  if (!Object.keys(fields).length) return null;
  if (["signed", "completed"].includes(text(document.status))) throw conflict("document_locked_signed", "Create a replacement or amendment rather than reissuing an executed document.");
  await assertSigningEditable(orgId, text(document.id));
  const signers = signerPlan(fields, recipients);
  const org = object(await readOrganization(orgId));
  const contact = text(input.consent_contact || object(document.metadata).consent_contact || org.email || object(org.data).email || input.consent_contact_fallback);
  if (!contact) throw badRequest("signature_contact_required", "Set an organization contact or consent_contact for signing support and paper copies.");
  for (const signer of signers) {
    if (signer.required && !signer.email && !signer.user_id) throw badRequest("signature_recipient_required", `Assign an email recipient or organization user to required signer '${signer.id}'.`);
  }
  const expires = text(input.expires_at) || new Date(Date.now() + 30 * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) <= Date.now()) throw badRequest("signature_expiry", "Signing expiry must be a future date.");
  return { fields, signers, contact, expires: new Date(expires).toISOString() };
}
export async function issueSigningPackage(orgId: string, document: JsonObject, snapshot: JsonObject, recipients: JsonObject[], input: JsonObject = {}) {
  const plan = await validateSigningIssue(orgId, document, recipients, input);
  if (!plan) return { pkg: null, invitations: [] as JsonObject[] };
  const { fields, signers, contact, expires } = plan;
  await revokeSigningPackages(orgId, text(document.id), "superseded");
  const pkg: SigningPackage = { id: `sign_${randomUUID()}`, organization_id: orgId, document_id: text(document.id), snapshot_id: text(snapshot.id), status: "open", signers, fields,
    receipts: {}, created_at: new Date().toISOString(), expires_at: expires, content_hash: "", source_hash: "", content: {}, review_pdf: "", final_pdf: "", final_pdf_hash: "", disclosure: disclosure(contact), challenges: {} };
  await savePackage(pkg);
  const invitations: JsonObject[] = [];
  for (const signer of signers) {
    if (!signer.email && !signer.user_id) continue;
    const raw = token(); await addInvitation(raw, pkg.id, signer.id);
    invitations.push({ signer_id: signer.id, name: signer.name, email: signer.email, user_id: signer.user_id, token: raw });
  }
  return { pkg, invitations };
}

export type SigningAccess = { pkg: SigningPackage; signer: Signer; authentication: string; userId: string };
export async function publicSigningAccess(raw: string): Promise<SigningAccess> {
  const found = await resolveSigningInvitation(raw);
  if (!found) throw forbidden("signature_invitation_required", "Use your individual signing invitation. Shared document links are read-only for signatures.");
  const signer = found.pkg.signers.find(s => s.id === found.signerId)!;
  if (signer.user_id) throw forbidden("signature_login_required", "This signer must sign in with their assigned organization account.");
  return { pkg: found.pkg, signer, authentication: "individual_invitation", userId: "" };
}
export async function internalSigningAccess(orgId: string, documentId: string, signerId: string, ctx: PlatformAuthContext): Promise<SigningAccess> {
  if (ctx.orgId !== orgId || !hasPermission(ctx, "sign_documents") || ctx.userId === "system_automation") throw forbidden("signature_permission", "You need document-signing permission and an assigned signer role.");
  const packages = await packagesForDocument(orgId, documentId);
  const pkg = packages.find(p => ["open", "completed"].includes(p.status) && p.signers.some(s => s.id === signerId && s.user_id === ctx.userId));
  if (!pkg) throw forbidden("signature_assignment", "This signature is not assigned to your account.");
  return { pkg, signer: pkg.signers.find(s => s.id === signerId)!, authentication: "organization_session", userId: ctx.userId };
}
/** Trusted field adapter only: its route checks crew.signatures.present and project assignment. */
export async function presentedSigningAccess(orgId: string, documentId: string, field: string, ctx: PlatformAuthContext): Promise<SigningAccess> {
  if (ctx.orgId !== orgId || !ctx.userId || ctx.userId === "system_automation") throw forbidden("signature_presenter_required", "An authenticated, assigned presenter is required.");
  const pkg = (await packagesForDocument(orgId, documentId)).find(p => ["open", "completed"].includes(p.status));
  const signer = pkg?.signers.find(s => s.fields.includes(field) && s.party === "customer" && !s.user_id);
  if (!pkg || !signer) throw forbidden("signature_assignment", "Issue this agreement with named customer signers before presenting it in person.");
  return { pkg, signer, authentication: "presenter_witnessed_in_person", userId: ctx.userId };
}
async function activePackage(access: SigningAccess, routing = true) {
  const pkg = await readPackage(access.pkg.id);
  if (!pkg) throw notFound("signature_package_missing", "Signing package not found.");
  const document = await readDocumentInstance(pkg.organization_id, pkg.document_id);
  if (pkg.status !== "open" || ["void", "declined", "expired"].includes(text(document.status))) throw conflict("signature_package_closed", "This signing package is no longer accepting signatures.");
  if (Date.parse(pkg.expires_at) <= Date.now()) throw conflict("signature_package_expired", "This signing invitation has expired.");
  if (object(document.delivery).current_snapshot_id !== pkg.snapshot_id) throw conflict("signature_package_superseded", "Use the invitation for the current document revision.");
  if (digest(signatureDefinitions(document.output_defs)) !== digest(pkg.fields)) throw conflict("signature_assignments_changed", "Signature fields changed after issuance. Reissue this agreement with its current signer assignments.");
  const capabilities = await documentCapabilityState(pkg.organization_id);
  if (!documentCapabilityEnabled(capabilities, DOCUMENT_CAPABILITIES.esign) || !documentCapabilityEnabled(capabilities, DOCUMENT_CAPABILITIES.app)) throw forbidden("document_feature_disabled", "Electronic signing is unavailable; required signatures remain outstanding.");
  if (routing) assertRouting(pkg, access.signer);
  return { pkg, document };
}

export async function prepareSigning(access: SigningAccess) {
  return withSigningLock(access.pkg.organization_id, access.pkg.document_id, async () => {
    const { pkg, document } = await activePackage(access);
    const sourceHash = digest(signingSource(document));
    if (Object.keys(pkg.receipts).length && sourceHash !== pkg.source_hash) throw conflict("signature_content_changed", "The accepted document no longer matches its retained revision. Signing is blocked.");
    if (!pkg.content_hash || sourceHash !== pkg.source_hash) {
      const { resolveDocumentInstance, documentCheckoutPricing } = await import("../service.js");
      const snapshot = await readDocumentSnapshot(pkg.organization_id, pkg.snapshot_id);
      const unsignedOutputs = Object.fromEntries(Object.entries(object(document.outputs)).filter(([key]) => !pkg.fields[key]));
      const resolved = await resolveDocumentInstance(pkg.organization_id, { ...document, outputs: unsignedOutputs }, { target: "static", snapshot });
      const materialsDeliverables = validateDeliverables(snapshot.materials_deliverables || document.materials_deliverables || object(object(resolved.resolved_definition).program).deliverables);
      const content: JsonObject = { ...resolved, document_type: document.document_type, tags: documentTags(document.tags), title: document.title, params: object(resolved.scope.params), outputs: publicSignatureOutputs(unsignedOutputs), module_ref: document.module_ref, module_binding_manifest: document.module_binding_manifest, materials_deliverables: materialsDeliverables };
      const pricing = await documentCheckoutPricing(pkg.organization_id, document, object(content.params), {});
      const subtotal = Number(pricing.totals.subtotal_cents || 0) - Number(pricing.totals.adjustments_cents || 0);
      content.contract_basis_cents = Math.max(0, subtotal + Math.round(subtotal * (Number(object(content.params).tax_percent) || 0) / 100)) || Number(object(content.params).amount_cents || object(content.params).total_cents || 0);
      const html = await buildRenderHarnessHtml({ resolved_definition: object(resolved.resolved_definition), theme: object(resolved.theme), themeContext: object(resolved.theme_context), widgetData: object(resolved.widget_data), scope: { ...resolved.scope, params: content.params, outputs: content.outputs }, title: text(document.title), language_snapshot: snapshot.language_snapshot as any });
      const rendered = await renderDocumentPdf({ html, paper: FMDocModel.paperDimensions(object(resolved.resolved_definition)), title: text(document.title), strict: true });
      const dimensions = FMDocModel.paperDimensions(object(resolved.resolved_definition));
      for (const box of rendered.signaturePlacements) {
        if (box.width < 20 || box.height < 10 || box.x < -1 || box.y < -1 || box.x + box.width > dimensions.w_pt + 1 || box.y + box.height > dimensions.h_pt + 1) throw badRequest("signature_placement_invalid", "A signature field is too small or outside its page. Correct the template before signing.");
        if (rendered.signaturePlacements.some(other => other !== box && other.page === box.page && other.field !== box.field && Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x) > 1 && Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y) > 1)) throw badRequest("signature_placement_overlap", "Different signature fields overlap. Use one signature widget with shared-position field keys, or move the separate fields.");
      }
      pkg.content = { ...content, html, signature_placements: rendered.signaturePlacements, review_pdf_sha256: createHash("sha256").update(rendered.bytes).digest("hex") }; pkg.source_hash = sourceHash;
      pkg.content_hash = digest({ content: pkg.content, signers: pkg.signers, fields: pkg.fields, disclosure: pkg.disclosure });
      pkg.review_pdf = rendered.bytes.toString("base64"); pkg.challenges = {};
    }
    const challenge = { id: token(), content_hash: pkg.content_hash, expires_at: new Date(Date.now() + 30 * 60000).toISOString() };
    pkg.challenges[access.signer.id] = challenge; await savePackage(pkg);
    return { package_id: pkg.id, content_hash: pkg.content_hash, challenge: challenge.id, disclosure: pkg.disclosure, signer: access.signer, fields: access.signer.fields, receipts: publicReceipts(pkg), expires_at: pkg.expires_at };
  });
}
function publicReceipts(pkg: SigningPackage) { return Object.fromEntries(Object.entries(pkg.receipts).map(([key, receipt]) => [key, { ...receipt.value, receipt_id: receipt.id, signer_id: receipt.signer_id, signed_at: receipt.signed_at, content_hash: receipt.content_hash }])); }

async function certificatePdf(pkg: SigningPackage, bytes: Buffer) {
  const pdf = await PDFDocument.load(bytes), font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([612, 792]), y = 750;
  const line = (value: string) => {
    // The executed document retains Unicode names; this auxiliary WinAnsi appendix uses escapes.
    const ascii = value.replace(/[^\x20-\x7E]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    for (let offset = 0; offset < ascii.length; offset += 94) {
      if (y < 45) { page = pdf.addPage([612, 792]); y = 750; }
      page.drawText(ascii.slice(offset, offset + 94), { x: 36, y, size: 9, font, color: rgb(0.1, 0.1, 0.1) }); y -= 15;
    }
  };
  line("Electronic signature record"); line(`Package: ${pkg.id}`); line(`Accepted content SHA-256: ${pkg.content_hash}`);
  line(`Disclosure: ${pkg.disclosure.version} / ${pkg.disclosure.hash}`);
  line(pkg.disclosure.text);
  for (const r of Object.values(pkg.receipts)) {
    line(`Field ${r.field}: ${text(r.value.signer_name)} (${r.signer_id})`); line(`Accepted at ${r.signed_at}; receipt ${r.id}`);
    if (r.value.type === "drawn") {
      if (y < 130) { page = pdf.addPage([612,792]); y = 750; }
      const img = await pdf.embedPng(Buffer.from(text(r.value.image_data).split(",")[1]!, "base64"));
      const scale = Math.min(220 / img.width, 65 / img.height);
      page.drawImage(img, { x: 36, y: y - 70, width: img.width * scale, height: img.height * scale }); y -= 85;
    }
  }
  return Buffer.from(await pdf.save());
}
async function stampSignaturePlacements(pkg: SigningPackage) {
  const pdf = await PDFDocument.load(Buffer.from(pkg.review_pdf, "base64"));
  const sharp = (await import("sharp")).default;
  const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
  for (const placement of Array.isArray(pkg.content.signature_placements) ? pkg.content.signature_placements : []) {
    const box = object(placement), receipt = pkg.receipts[text(box.field)]; if (!receipt) continue;
    const page = pdf.getPage(Number(box.page)), width = Number(box.width), height = Number(box.height);
    if (!(width > 0 && height > 0) || Number(box.x) < -1 || Number(box.y) < -1 || Number(box.y) + height > page.getHeight() + 1) throw conflict("signature_placement_invalid", "A signature placement falls outside its page. Correct the template and reissue before signing.");
    const bytes = receipt.value.type === "drawn" ? Buffer.from(text(receipt.value.image_data).split(",")[1]!, "base64")
      : await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1200,text(receipt.value.signer_name).length * 80)}" height="120"><text x="4" y="80" font-size="72" font-family="cursive" fill="#111827">${escape(text(receipt.value.signer_name))}</text></svg>`)).trim().png().toBuffer();
    const image = await pdf.embedPng(bytes), scale = Math.min(width / image.width, (height - 2) / image.height);
    page.drawImage(image, { x: Number(box.x), y: page.getHeight() - Number(box.y) - height + 2, width: image.width * scale, height: image.height * scale });
  }
  return Buffer.from(await pdf.save());
}
export async function acceptSigning(access: SigningAccess, field: string, input: JsonObject, audit: JsonObject = {}, options: { deferOutbox?: boolean } = {}) {
  const value = await validateSignature(input.value);
  const requestHash = digest({ field, value, content_hash: input.content_hash, consent: input.consent });
  const result = await withSigningLock(access.pkg.organization_id, access.pkg.document_id, async () => {
    const retained = await readPackage(access.pkg.id);
    const prior = retained?.receipts[field];
    if (prior) {
      if (prior.signer_id !== access.signer.id || prior.request_hash !== requestHash) throw conflict("signature_already_recorded", "This signature is immutable. Create an amendment to change the agreement.");
      return { pkg: retained!, receipt: prior, duplicate: true };
    }
    const { pkg, document } = await activePackage(access);
    if (!access.signer.fields.includes(field)) throw forbidden("signature_field_assignment", "This signature field belongs to another signer.");
    const challenge = pkg.challenges[access.signer.id], consent = object(input.consent);
    if (!challenge || challenge.id !== input.challenge || Date.parse(challenge.expires_at) <= Date.now() || input.content_hash !== pkg.content_hash || challenge.content_hash !== pkg.content_hash) throw conflict("signature_review_required", "Review the current document before signing.");
    if (digest(signingSource(document)) !== pkg.source_hash) throw conflict("signature_content_changed", "The document changed. Review its new revision before signing.");
    if (consent.intent !== true || consent.electronic_records !== true || consent.can_access_and_retain !== true || consent.disclosure_hash !== pkg.disclosure.hash) throw badRequest("signature_consent_required", "Confirm your intent, electronic-record consent, and ability to access and retain the review copy.");
    if (access.authentication === "presenter_witnessed_in_person" && consent.presenter_witnessed !== true) throw badRequest("signature_witness_required", "The presenter must attest that the assigned signer personally reviewed and signed the agreement in their presence.");
    const now = new Date().toISOString();
    const receipt = { id: `sig_${randomUUID()}`, field, signer_id: access.signer.id, content_hash: pkg.content_hash, signed_at: now, value: { ...value, signed_at: now }, request_hash: requestHash,
      evidence: { authentication: access.authentication, actor_user_id: access.userId, recipient_email: access.signer.email, capacity: access.signer.capacity, disclosure: pkg.disclosure, consent, server_received_at: now, ip_address: text(audit.ip_address), user_agent: text(audit.user_agent), request_id: text(audit.request_id) } };
    pkg.receipts[field] = receipt;
    if (signaturesComplete(pkg)) {
      // Stamp only signature rectangles on the retained PDF. Never re-evaluate contract
      // code, bindings, conditional pages or pricing while assembling an executed copy.
      const final = await certificatePdf(pkg, await stampSignaturePlacements(pkg));
      pkg.final_pdf = final.toString("base64"); pkg.final_pdf_hash = createHash("sha256").update(final).digest("hex");
      pkg.status = "completed"; pkg.completed_at = now;
    }
    await signingStore().prepare("INSERT INTO document_signing_receipts(id,package_id,field_key,value_json) VALUES(?,?,?,?)").run(receipt.id, pkg.id, field, JSON.stringify(receipt));
    await savePackage(pkg);
    await queueSigningEvent(pkg, "document.signature.accepted", field, { output_key: field, output_type: "signature", signer_id: access.signer.id, receipt_id: receipt.id, signed_at: now });
    await queueSigningEvent(pkg, "document.output.recorded", field, { output_key: field, output_type: "signature", signer_id: access.signer.id, receipt_id: receipt.id });
    if (pkg.status === "completed") await queueSigningEvent(pkg, "document.signed", "", { signed_at: now });
    if (pkg.status === "completed") for (const signer of pkg.signers.filter(s => s.email)) await queueSigningEvent(pkg, "document.signing.deliver_copy", signer.id, { signer_id: signer.id });
    return { pkg, receipt, duplicate: false };
  });
  // SQL receipts/outbox are authoritative; interrupted projection is repaired by the worker.
  await projectSigningPackage(result.pkg.id);
  if (!options.deferOutbox) await drainSigningOutbox();
  return { receipt: { ...result.receipt.value, receipt_id: result.receipt.id, content_hash: result.receipt.content_hash }, duplicate: result.duplicate, document: await readDocumentInstance(result.pkg.organization_id, result.pkg.document_id) };
}

export async function projectSigningPackage(id: string) {
  const initial = await readPackage(id); if (!initial) return;
  await withSigningLock(initial.organization_id, initial.document_id, async () => {
    const pkg = (await readPackage(id))!, document = await readDocumentInstance(pkg.organization_id, pkg.document_id);
    if (!Object.keys(pkg.receipts).length) return;
    const outputs = { ...object(document.outputs), ...publicReceipts(pkg) };
    const completed = pkg.status === "completed" && FMDocModel.requiredOutputsSatisfied(object(document.output_defs), outputs, "completed");
    const terminal = ["void", "declined", "expired"].includes(text(document.status));
    const status = terminal ? document.status : pkg.status === "completed" ? completed ? "completed" : "signed" : document.status;
    const updated = await saveDocumentInstance(pkg.organization_id, pkg.document_id, { ...document, outputs, status,
      signing: { package_id: pkg.id, content_hash: pkg.content_hash, completed_at: pkg.completed_at || null, final_pdf_hash: pkg.final_pdf_hash },
      delivery: { ...object(document.delivery), ...(pkg.completed_at ? { signed_at: pkg.completed_at } : {}) } }, { expectedRevision: Number(document.revision) });
    const snapshot = await readDocumentSnapshot(pkg.organization_id, pkg.snapshot_id);
    await saveDocumentSnapshot(pkg.organization_id, pkg.snapshot_id, { ...snapshot, resolved_definition: pkg.content.resolved_definition, widget_data: pkg.content.widget_data,
      theme: pkg.content.theme, theme_vars: pkg.content.theme_vars, params: pkg.content.params, outputs, status, signing_package_id: pkg.id });
    if (completed && !terminal) await queueSigningEvent(pkg, "document.completed", "", {});
    return updated;
  });
}
let draining: Promise<void> | null = null;
let drainRequested = false;
export function drainSigningOutbox(): Promise<void> {
  drainRequested = true;
  if (!draining) draining = (async () => {
    // A caller may enqueue/expire a package after the current pass took its snapshot.
    do { drainRequested = false; await deliverSigningOutbox(); } while (drainRequested);
  })().finally(() => { draining = null; });
  return draining;
}
async function deliverSigningOutbox() {
    for (const row of await signingStore().prepare("SELECT id,organization_id,document_id FROM document_signing_packages WHERE status='open' AND expires_at<>'' AND expires_at<=? LIMIT 100").all(new Date().toISOString())) {
      try {
      await withSigningLock(String(row.organization_id),String(row.document_id),async () => {
        const pkg = await readPackage(String(row.id)); if (!pkg || pkg.status !== "open" || Date.parse(pkg.expires_at) > Date.now()) return;
        pkg.status = "expired"; await savePackage(pkg);
        const document = await readDocumentInstance(pkg.organization_id,pkg.document_id);
        await saveDocumentInstance(pkg.organization_id,pkg.document_id,{...document,outputs:{...object(document.outputs),...publicReceipts(pkg)},status:"expired"});
        await queueSigningEvent(pkg,"document.signing.expired","",{});
      });
      } catch (error) {
        console.error("Signing expiry projection will retry",String(row.id),error instanceof Error ? error.message : "expiry_failed");
      }
    }
    const pending = await signingStore().prepare("SELECT * FROM document_signing_outbox WHERE delivered=0 ORDER BY attempted_at, CASE event_type WHEN 'document.signature.accepted' THEN 0 WHEN 'document.output.recorded' THEN 1 WHEN 'document.signed' THEN 2 WHEN 'document.completed' THEN 3 ELSE 4 END, id LIMIT 100").all();
    for (const entry of pending) {
      try {
      await signingStore().prepare("UPDATE document_signing_outbox SET attempted_at=?,attempts=attempts+1 WHERE id=?").run(new Date().toISOString(),String(entry.id));
      const pkg = await readPackage(String(entry.package_id)); if (!pkg) continue;
      await projectSigningPackage(pkg.id);
      const document = await readDocumentInstance(pkg.organization_id, pkg.document_id);
      const payload = { snapshot_id: pkg.snapshot_id, package_id: pkg.id, content_hash: pkg.content_hash, ...JSON.parse(String(entry.payload_json)) };
      if (entry.event_type === "document.signed") await publishAcceptedMaterials(pkg.organization_id, text(document.project_id), pkg.document_id, pkg.snapshot_id);
      if (entry.event_type === "document.signing.deliver_copy") {
        const signer = pkg.signers.find(s => s.id === payload.signer_id);
        if (signer?.email && pkg.final_pdf) {
          const { sendOrganizationTransactionalEmail } = await import("../../email/organization_outbound.js");
          const result = await sendOrganizationTransactionalEmail({ organizationId: pkg.organization_id, branchId: text(document.branch_id) || "default", projectId: text(document.project_id), to: signer.email,
            subject: `Executed copy: ${text(pkg.content.title) || "Agreement"}`, textBody: "All required signatures have been recorded. Your executed agreement and signature record are attached. Please retain this copy.", purpose: "transactional",
            source: { type: "system", id: "document_signing" }, tags: ["document-executed"], metadata: { package_id: pkg.id }, idempotencyKey: String(entry.id),
            attachments: [{ name: "executed-agreement.pdf", contentType: "application/pdf", content: Buffer.from(pkg.final_pdf, "base64") }] });
          if (!result.ok) throw new Error("Executed-copy email delivery failed.");
        }
        await signingStore().prepare("UPDATE document_signing_outbox SET delivered=1 WHERE id=?").run(String(entry.id));
        continue;
      }
      await recordDocumentEvent(pkg.organization_id, document, String(entry.event_type), payload, null, { emit: false, eventId: String(entry.id) });
      const { emitWorkEvent } = await import("../../work/engine.js");
      await emitWorkEvent({ organization_id: pkg.organization_id, branch_id: text(document.branch_id) || "default", ...(document.project_id ? { project_id: text(document.project_id) } : {}), type: String(entry.event_type), idempotency_key: String(entry.id),
        payload: { document_id: pkg.document_id, document_type: pkg.content.document_type || document.document_type, document_tags: documentTags(pkg.content.tags ?? document.tags), template_id: object(document.template_ref).template_id, workflow_id: object(document.workflow_ref).workflow_id, project_id: document.project_id, ...payload }, context: { source: "document_signing" } });
      await signingStore().prepare("UPDATE document_signing_outbox SET delivered=1 WHERE id=?").run(String(entry.id));
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0,1000) : "delivery_failed";
        await signingStore().prepare("UPDATE document_signing_outbox SET last_error=? WHERE id=?").run(reason,String(entry.id));
        console.error("Signing outbox delivery will retry", String(entry.id), reason);
      }
    }
}
export async function signingPdf(orgId: string, snapshotId: string, finalOnly = false) {
  const pkg = await packageForSnapshot(orgId, snapshotId);
  if (!pkg) return null;
  const encoded = pkg.final_pdf || (finalOnly ? "" : pkg.review_pdf);
  if (!encoded && !finalOnly && !Object.keys(pkg.receipts).length) return null;
  if (!encoded) throw conflict("signature_pdf_not_ready", "Prepare the signing review before downloading its retained copy.");
  return { bytes: Buffer.from(encoded, "base64"), fileName: pkg.final_pdf ? "executed-agreement.pdf" : "agreement-for-review.pdf", contentType: "application/pdf" };
}
export async function signingStatus(orgId: string, snapshotId: string, rawToken = "") {
  const pkg = await packageForSnapshot(orgId, snapshotId); if (!pkg) return null;
  const invitation = rawToken ? await resolveSigningInvitation(rawToken) : null;
  return { package_id: pkg.id, status: pkg.status === "open" && Date.parse(pkg.expires_at) <= Date.now() ? "expired" : pkg.status, content_hash: pkg.content_hash, expires_at: pkg.expires_at, signer_id: invitation?.signerId || null,
    signers: pkg.signers.map(s => ({ id: s.id, name: s.name, party: s.party, order: s.order, fields: s.fields, required: s.required, signed_fields: s.fields.filter(f => pkg.receipts[f]) })), receipts: publicReceipts(pkg) };
}
export async function signingEvidence(orgId: string, documentId: string, ctx: PlatformAuthContext, includeFiles = false) {
  if (ctx.orgId !== orgId || !hasPermission(ctx, "manage_documents")) throw forbidden("signature_evidence_permission", "Document management permission is required to export private signing evidence.");
  return Promise.all((await packagesForDocument(orgId, documentId)).map(async ({ review_pdf: review, final_pdf: final, challenges: _challenges, ...pkg }) => ({ ...pkg,
    deliveries: await signingStore().prepare("SELECT event_type,delivered,attempted_at,attempts,last_error FROM document_signing_outbox WHERE package_id=?").all(pkg.id),
    ...(includeFiles ? { review_pdf_base64: review, final_pdf_base64: final } : {}) })));
}

export async function declineSigning(access: SigningAccess, reason: string) {
  await withSigningLock(access.pkg.organization_id, access.pkg.document_id, async () => {
    const { pkg, document } = await activePackage(access, false);
    pkg.status = "declined";
    await savePackage(pkg);
    const receipts = publicReceipts(pkg);
    await saveDocumentInstance(pkg.organization_id, pkg.document_id, { ...document, outputs: { ...object(document.outputs), ...receipts }, status: "declined" });
    await queueSigningEvent(pkg, "document.declined", "", { signer_id: access.signer.id, reason: reason.slice(0, 1000), occurred_at: new Date().toISOString() });
  });
  await drainSigningOutbox();
  return { status: "declined" };
}

/** Rotation preserves accepted content and receipts; it only revokes this role's old invitations. */
export async function reissueSigningInvitation(orgId: string, documentId: string, signerId: string, ctx: PlatformAuthContext) {
  if (ctx.orgId !== orgId || !hasPermission(ctx, "issue_documents")) throw forbidden("signature_issue_permission", "Issuing permission is required.");
  return withSigningLock(orgId, documentId, async () => {
    const pkg = (await packagesForDocument(orgId, documentId)).find(p => p.status === "open");
    const signer = pkg?.signers.find(s => s.id === signerId);
    if (!pkg || !signer) throw notFound("signature_assignment", "No active signer assignment exists.");
    if (Date.parse(pkg.expires_at) <= Date.now()) throw conflict("signature_package_expired", "Expired packages require a replacement agreement.");
    const raw = token();
    await signingStore().prepare("DELETE FROM document_signing_invitations WHERE package_id=? AND signer_id=?").run(pkg.id, signer.id);
    await addInvitation(raw, pkg.id, signer.id);
    delete pkg.challenges[signer.id]; await savePackage(pkg);
    await queueSigningEvent(pkg, "document.signing.invitation_reissued", token(), { signer_id: signer.id, actor_user_id: ctx.userId });
    return { package_id: pkg.id, signer_id: signer.id, token: raw, email: signer.email, user_id: signer.user_id };
  });
}

/** Paper imports are reviewer attestations, never fabricated electronic-signing sessions. */
export async function importSigningEvidence(orgId: string, documentId: string, values: JsonObject, ctx: PlatformAuthContext, attested: boolean) {
  if (ctx.orgId !== orgId || !hasPermission(ctx, "import_document_signatures")) throw forbidden("signature_import_forbidden", "Signature-import permission is required.");
  if (!attested) throw badRequest("signature_import_attestation", "Confirm that you reviewed the original file and that the recorded signatures are present on it.");
  return withSigningLock(orgId, documentId, async () => {
    await assertSigningEditable(orgId, documentId);
    const document = await readDocumentInstance(orgId, documentId);
    if (document.source !== "uploaded") throw badRequest("signature_import_source", "Signature imports require a retained original upload.");
    const fields = signatureDefinitions(document.output_defs);
    const original = await readMediaFile(orgId, text(object(document.ingestion).media_id));
    let originalPdf: Buffer;
    if (original.contentType === "application/pdf") { await PDFDocument.load(original.bytes); originalPdf = original.bytes; }
    else {
      const sharp = (await import("sharp")).default;
      const image = await sharp(original.bytes, { limitInputPixels: 40000000 }).png().toBuffer();
      const pdf = await PDFDocument.create(), embedded = await pdf.embedPng(image);
      const page = pdf.addPage([612, 792]), scale = Math.min(576 / embedded.width, 756 / embedded.height);
      page.drawImage(embedded, { x: 18, y: 792 - 18 - embedded.height * scale, width: embedded.width * scale, height: embedded.height * scale });
      originalPdf = Buffer.from(await pdf.save());
    }
    const { createSnapshot } = await import("../service.js");
    const snapshot = await createSnapshot(orgId, documentId, { reason: "manual" }, ctx);
    const current = await readDocumentInstance(orgId, documentId), now = new Date().toISOString();
    const content: JsonObject = { kind: "reviewed_paper_upload", document_type: document.document_type, tags: documentTags(document.tags), title: document.title, params: document.params, resolved_definition: snapshot.resolved_definition, widget_data: snapshot.widget_data, theme: snapshot.theme, theme_vars: snapshot.theme_vars,
      original_file: { name: original.fileName, content_type: original.contentType, sha256: createHash("sha256").update(original.bytes).digest("hex"), bytes_base64: original.bytes.toString("base64") } };
    const statement = "The authenticated reviewer attests that they inspected the retained original and the recorded signatures are present. This is an imported signature, not an electronic signature collected by this platform.";
    const pkg: SigningPackage = { id: `sign_${randomUUID()}`, organization_id: orgId, document_id: documentId, snapshot_id: text(snapshot.id), status: "open", signers: signerPlan(fields, []), fields, receipts: {}, created_at: now, expires_at: now, source_hash: digest(signingSource(current)), content_hash: digest(content), content,
      review_pdf: originalPdf.toString("base64"), final_pdf: "", final_pdf_hash: "", disclosure: { version: "reviewed-paper-import-1", text: statement, hash: digest(statement) }, challenges: {} };
    for (const [field, def] of Object.entries(fields)) {
      if (!FMDocModel.outputValueSatisfies(def, values[field])) continue;
      const supplied = object(values[field]), signerId = text(def.signer_id) || (text(def.signer) === "internal" ? "company" : "customer");
      pkg.receipts[field] = { id: `sig_${randomUUID()}`, field, signer_id: signerId, content_hash: pkg.content_hash, signed_at: now,
        value: { type: "imported", signer_name: text(supplied.signer_name || supplied.text) || "Signature present on original", signed_at: now, claimed_signed_at: text(supplied.signed_at), source: "reviewed_paper_upload" },
        evidence: { authentication: "reviewer_attestation", actor_user_id: ctx.userId, attestation: statement, source_sha256: object(content.original_file).sha256, claimed_signed_at: text(supplied.signed_at), server_received_at: now }, request_hash: digest(values[field]) };
    }
    if (!signaturesComplete(pkg)) throw badRequest("signature_import_incomplete", "Confirm every required signature on the original before accepting it as an executed contract. Partial or unsigned uploads may remain in review.");
    pkg.status = "completed"; pkg.completed_at = now;
    const final = await certificatePdf(pkg, originalPdf); pkg.final_pdf = final.toString("base64"); pkg.final_pdf_hash = createHash("sha256").update(final).digest("hex");
    await savePackage(pkg);
    for (const receipt of Object.values(pkg.receipts)) {
      await signingStore().prepare("INSERT INTO document_signing_receipts(id,package_id,field_key,value_json) VALUES(?,?,?,?)").run(receipt.id, pkg.id, receipt.field, JSON.stringify(receipt));
      await queueSigningEvent(pkg, "document.signature.accepted", receipt.field, { output_key: receipt.field, receipt_id: receipt.id, capture_mode: "reviewed_paper_upload", actor_user_id: ctx.userId });
    }
    await queueSigningEvent(pkg, "document.signed", "", { signed_at: now, capture_mode: "reviewed_paper_upload" });
    await projectSigningPackage(pkg.id);
    return readDocumentInstance(orgId, documentId);
  });
}
