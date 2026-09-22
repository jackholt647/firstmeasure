import { renderTemplatedArtifact } from "../documents/artifacts.js";
import type { JsonObject } from "../platform/storage.js";
import { normalizeProposalScope } from "./scope.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function proposalContentBlocks(content: JsonObject) {
  const explicit = asArray(content.content_blocks).map(asObject);
  if (explicit.length) return explicit;
  return asArray(content.pages).map(asObject)
    .filter((page) => asObject(page).enabled !== false)
    .filter((page) => !["pricing", "signature", "payment_schedule", "fine_print"].includes(cleanText(page.kind).toLowerCase()))
    .map((page) => ({
      id: cleanText(page.id),
      title: cleanText(page.title || page.name),
      body: cleanText(page.body || page.description || page.text),
      media: asObject(page.media || page.image || page.photo)
    }))
    .filter((block) => block.title || block.body || Object.keys(block.media).length);
}

function signatureOutput(snapshot: JsonObject) {
  const signatures = asObject(snapshot.signatures);
  const customer = asObject(signatures.customer);
  const adopted = asObject(signatures.adopted_signature);
  const value = Object.keys(customer).length ? customer : adopted;
  const signedAt = cleanText(value.signed_at || value.adopted_at || signatures.completed_at);
  if (!signedAt) return {};
  return {
    sig_customer: {
      type: cleanText(value.type || "typed"),
      text: cleanText(value.text || value.signer_name),
      signer_name: cleanText(value.signer_name || value.text),
      style: cleanText(value.style || "style-classic"),
      image_data: cleanText(value.image_data),
      signed_at: signedAt
    }
  };
}

/** Converts the legacy proposal record into the canonical proposal template
 * contract. Browser-supplied HTML is intentionally not accepted here. */
export async function renderProposalTemplatePdf(orgId: string, input: {
  proposal?: JsonObject;
  snapshot?: JsonObject | null;
  title?: string;
}) {
  const proposal = asObject(input.proposal);
  const snapshot = asObject(input.snapshot);
  const content = Object.keys(asObject(snapshot.content)).length ? asObject(snapshot.content) : asObject(proposal.editable);
  const scope = normalizeProposalScope(content.scope);
  const project = Object.keys(asObject(snapshot.project_snapshot)).length
    ? asObject(snapshot.project_snapshot)
    : asObject(content.project);
  const contacts = asArray(asObject(snapshot.contact_snapshot).contacts).length
    ? asArray(asObject(snapshot.contact_snapshot).contacts)
    : asArray(snapshot.contacts || proposal.contacts);
  const customer = asObject(contacts[0]);
  const payment = asObject(content.payment);
  const paymentSchedule = asArray(content.payment_schedule || payment.payment_schedule || payment.schedule || payment.items);
  const title = cleanText(input.title || snapshot.title || proposal.title || "Proposal") || "Proposal";
  const sourceId = cleanText(snapshot.id || proposal.id) || `legacy_${Date.now()}`;
  const rendered = await renderTemplatedArtifact({
    orgId,
    documentId: `doc_legacy_proposal_${sourceId}`,
    documentType: "proposal",
    templateId: cleanText(content.document_template_id || content.documents_template_id) || "tpl_proposal_default",
    projectId: cleanText(snapshot.project_id || proposal.project_id),
    branchId: cleanText(snapshot.branch_id || proposal.branch_id || "default"),
    actorUserId: cleanText(snapshot.updated_by_user_id || proposal.updated_by_user_id || "system_proposal"),
    title,
    params: {
      project,
      customer,
      scope_items: scope.root_items,
      measurements: asObject(scope.measurements),
      payment_schedule: paymentSchedule,
      deposit_cents: Number(payment.deposit_cents || payment.deposit_amount_cents || 0),
      hero_photo: asObject(content.hero_photo || content.cover_photo),
      tax_percent: Number(content.tax_percent || 0),
      content_blocks: proposalContentBlocks(content),
      pricing_adjustments: asArray(content.pricing_adjustments)
    },
    outputs: signatureOutput(snapshot),
    metadata: {
      source_system: "legacy_proposals",
      source_proposal_id: cleanText(snapshot.proposal_id || proposal.id),
      source_snapshot_id: cleanText(snapshot.id)
    }
  });
  return { bytes: rendered.bytes, fileName: rendered.fileName, pageCount: rendered.pageCount };
}
