import { createHash, randomUUID } from "node:crypto";

import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  createPayment,
  ensureReceivablesForSignedProposal,
  listProjectObligations,
  listProjectPayments
} from "../payments/storage.js";
import { renderInvoiceDocumentPdf } from "../payments/invoices.js";
import {
  listDocuments,
  listOrganizations,
  readBranchModule,
  readDocument,
  readOrganization,
  readMediaFile,
  storeMediaUpload,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { ensurePipelinePlanForProject } from "../scopes/router.js";
import { emitWorkEvent } from "../work/engine.js";
import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import { env } from "../src/config/env.js";
import { renderProposalTemplatePdf } from "./document_artifacts.js";
import {
  findScopeItem,
  moneyCents as scopeMoneyCents,
  moneyDisplay as scopeMoneyDisplay,
  normalizeProposalScope,
  proposalScopeWithEnrichedPieces,
  proposalScopeTotalCents,
  publicScopeLineItems
} from "./scope.js";
import {
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
  type ProposalStatus
} from "./schemas.js";

export const PROPOSAL_COLLECTION = "proposals";
export const PROPOSAL_SNAPSHOT_COLLECTION = "proposal_snapshots";
export const PROPOSAL_EVENT_COLLECTION = "proposal_events";

export type ProposalDocumentData = JsonObject & {
  id: string;
  schema_version: number;
  organization_id: string;
  branch_id: string;
  project_id: string;
  contacts: JsonObject[];
  title: string;
  status: ProposalStatus;
  editable: JsonObject;
  delivery: JsonObject;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(value: unknown, fallbackPrefix: string) {
  const cleaned = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
  return cleaned || `${fallbackPrefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

function hashId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function proposalId(input: JsonObject = {}) {
  const explicit = cleanText(input.id);
  if (explicit) return normalizeId(explicit, "proposal");
  return `proposal_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function snapshotId(proposalIdValue: string, snapshotNumber: number) {
  return `proposal_snapshot_${hashId(`${proposalIdValue}:${snapshotNumber}:${randomUUID()}`)}`;
}

function eventId(proposalIdValue: string, type: string) {
  return `proposal_event_${hashId(`${proposalIdValue}:${type}:${Date.now()}:${randomUUID()}`)}`;
}

function normalizeStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function moneyCents(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = asObject(value);
    if (Number.isFinite(Number(input.amount_cents))) return Math.round(Number(input.amount_cents));
    if (Number.isFinite(Number(input.cents))) return Math.round(Number(input.cents));
    if (Number.isFinite(Number(input.amount))) return Math.round(Number(input.amount) * 100);
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : 0;
}

function moneyDisplay(cents: number, currency = "USD") {
  return (Math.round(Number(cents || 0)) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: cleanText(currency) || "USD"
  });
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactObject(value: JsonObject) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === null || entry === undefined || entry === "") return false;
    if (Array.isArray(entry)) return entry.length > 0;
    if (typeof entry === "object") return Object.keys(asObject(entry)).length > 0;
    return true;
  }));
}

function signatureGeo(value: unknown) {
  const source = asObject(value);
  const latitude = numberOrNull(source.latitude ?? source.lat);
  const longitude = numberOrNull(source.longitude ?? source.lng ?? source.lon);
  const accuracy = numberOrNull(source.accuracy ?? source.accuracy_meters ?? source.accuracyMeters);
  const altitude = numberOrNull(source.altitude);
  const heading = numberOrNull(source.heading);
  const speed = numberOrNull(source.speed);
  const geo = compactObject({
    latitude,
    longitude,
    accuracy_meters: accuracy,
    altitude,
    heading,
    speed,
    country: cleanText(source.country),
    region: cleanText(source.region),
    city: cleanText(source.city),
    postal_code: cleanText(source.postal_code || source.postalCode),
    captured_at: cleanText(source.captured_at || source.capturedAt || source.timestamp),
    source: cleanText(source.source)
  });
  return latitude !== null || longitude !== null || Object.keys(geo).length ? geo : {};
}

function signatureEvidence(input: JsonObject = {}, metadata: JsonObject = {}, occurredAt = nowIso()) {
  const inputMetadata = asObject(input.metadata);
  const clientEvidence = asObject(input.evidence || input.signature_evidence || inputMetadata.evidence);
  const requestGeo = signatureGeo(asObject(metadata).geo);
  const clientGeo = signatureGeo(input.geolocation || input.geo || input.location || clientEvidence.geolocation || clientEvidence.geo || clientEvidence.location || inputMetadata.geolocation || inputMetadata.geo || inputMetadata.location);
  return compactObject({
    captured_at: occurredAt,
    ip_address: cleanText(metadata.ip_address),
    user_agent: cleanText(metadata.user_agent),
    accept_language: cleanText(metadata.accept_language),
    referrer: cleanText(metadata.referrer),
    forwarded_for: cleanText(metadata.forwarded_for),
    request_id: cleanText(metadata.request_id),
    path: cleanText(input.path || clientEvidence.path || inputMetadata.path),
    href: cleanText(input.href || clientEvidence.href || inputMetadata.href),
    timezone: cleanText(input.timezone || clientEvidence.timezone || inputMetadata.timezone),
    locale: cleanText(input.locale || clientEvidence.locale || inputMetadata.locale),
    device: compactObject(asObject(clientEvidence.device || inputMetadata.device)),
    viewport: compactObject(asObject(clientEvidence.viewport || inputMetadata.viewport)),
    geolocation: clientGeo,
    approximate_location: requestGeo
  });
}

function workflowAuditEntry(type: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const occurredAt = nowIso();
  return {
    id: `proposal_audit_${hashId(`${type}:${Date.now()}:${randomUUID()}`)}`,
    type,
    occurred_at: occurredAt,
    signer_name: cleanText(input.signer_name || asObject(input.signature).signer_name),
    session_id: cleanText(input.session_id),
    visitor_session_id: cleanText(input.visitor_session_id || input.visitorSessionId),
    metadata: asObject(input.metadata),
    request: asObject(metadata),
    evidence: signatureEvidence(input, metadata, occurredAt)
  };
}

function normalizeContacts(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((entry, index) => {
      const contact = asObject(entry);
      const name = cleanText(contact.name || contact.full_name);
      const email = cleanText(contact.email).toLowerCase();
      const phone = cleanText(contact.phone || (Array.isArray(contact.phones) ? contact.phones[0] : ""));
      return {
        ...contact,
        id: cleanText(contact.id) || "",
        role: cleanText(contact.role || "customer") || "customer",
        name,
        email,
        phone,
        source: cleanText(contact.source || "project_contact") || "project_contact",
        index: Number(contact.index ?? index)
      };
    })
    .filter((contact) => contact.name || contact.email || contact.phone || contact.id);
}

function inputContacts(input: JsonObject, project: JsonObject = {}) {
  const direct = normalizeContacts(input.contacts);
  if (direct.length) return direct;
  const legacyParticipants = normalizeContacts(input.participants);
  if (legacyParticipants.length) return legacyParticipants;
  return normalizeContacts(project.contacts);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function documentData(document: JsonObject) {
  return asObject(document.data);
}

function proposalDocumentView(document: JsonObject): JsonObject {
  const data = documentData(document);
  return {
    ...data,
    id: cleanText(data.id || document.id),
    revision: Number(document.revision || 0),
    created_at: cleanText(document.created_at || data.created_at),
    updated_at: cleanText(document.updated_at || data.updated_at)
  };
}

function snapshotDocumentView(document: JsonObject): JsonObject {
  const data = documentData(document);
  return {
    ...data,
    id: cleanText(data.id || document.id),
    revision: Number(document.revision || 0),
    created_at: cleanText(document.created_at || data.created_at),
    updated_at: cleanText(document.updated_at || data.updated_at)
  };
}

function proposalStatus(value: unknown): ProposalStatus {
  const status = cleanText(value).toLowerCase();
  if (["sent", "viewed", "signed", "expired", "archived", "void"].includes(status)) return status as ProposalStatus;
  return "draft";
}

function nextProposalStatus(current: ProposalStatus, incoming: unknown, edited = false): ProposalStatus {
  const status = cleanText(incoming).toLowerCase();
  if (status) return proposalStatus(status);
  if (edited && current !== "draft") return current;
  return current || "draft";
}

function editableContent(input: JsonObject = {}, fallbackTitle = "Proposal") {
  const editable = asObject(input.editable);
  const source = Object.keys(editable).length ? editable : input;
  const scope = normalizeProposalScope(source.scope);
  return {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    title: cleanText(source.title || fallbackTitle) || fallbackTitle,
    pages: Array.isArray(source.pages) ? source.pages : [],
    scope,
    theme: asObject(source.theme),
    pricing: asObject(source.pricing),
    measurements: asObject(source.measurements),
    payment: asObject(source.payment),
    signatures: asObject(source.signatures),
    variables: asObject(source.variables),
    resources: asObject(source.resources),
    bindings: {
      refresh_until_status: "sent",
      project_fields: ["title", "address", "contacts", "project_type", "photos", "measurement", "measurement_project"],
      ...asObject(asObject(source.bindings))
    },
    ...source
  };
}

function proposalContentWithScopeSnapshot(value: unknown): JsonObject {
  const content = asObject(value);
  const scope = normalizeProposalScope(content.scope);
  return {
    ...content,
    scope: proposalScopeWithEnrichedPieces({
      ...scope,
      // Proposal-level measurements are the editable, user-entered values. A
      // scope created before manual entry may still contain its original zeros.
      measurements: { ...asObject(scope.measurements), ...asObject(content.measurements) }
    })
  };
}

function deliveryState(input: unknown = {}) {
  const delivery = asObject(input);
  return {
    state: cleanText(delivery.state || "not_sent") || "not_sent",
    send_count: Math.max(0, Math.round(Number(delivery.send_count || delivery.sendCount || 0) || 0)),
    sent_at: cleanText(delivery.sent_at || delivery.sentAt),
    first_viewed_at: cleanText(delivery.first_viewed_at || delivery.firstViewedAt),
    last_viewed_at: cleanText(delivery.last_viewed_at || delivery.lastViewedAt),
    signed_at: cleanText(delivery.signed_at || delivery.signedAt),
    current_snapshot_id: cleanText(delivery.current_snapshot_id || delivery.currentSnapshotId),
    current_public_token: cleanText(delivery.current_public_token || delivery.currentPublicToken),
    recipients: Array.isArray(delivery.recipients) ? delivery.recipients.map(asObject) : [],
    include_pdf: delivery.include_pdf !== false,
    include_portal: delivery.include_portal !== false,
    has_unpublished_changes: delivery.has_unpublished_changes === true
  };
}

function isSignedProposalLike(value: JsonObject = {}) {
  const delivery = deliveryState(value.delivery);
  const status = cleanText(value.status).toLowerCase();
  return status === "signed"
    || cleanText(delivery.state).toLowerCase() === "signed"
    || !!cleanText(delivery.signed_at || value.signed_at || value.customer_signed_at);
}

function proposalContentDocument(proposal: JsonObject = {}, snapshot: JsonObject = {}) {
  const editable = asObject(proposal.editable);
  if (Object.keys(editable).length) return editable;
  const content = asObject(snapshot.content);
  return Object.keys(content).length ? content : editable;
}

function proposalCustomerSignatureForPage(snapshot: JsonObject = {}, page: JsonObject = {}, index = 0) {
  const signatures = asObject(snapshot.signatures);
  const slots = asObject(signatures.slots);
  const customer = asObject(signatures.customer);
  const pageId = cleanText(page.id) || `page_${index + 1}`;
  const slot = asObject(slots[`${pageId}:customer_signature`]);
  const signature = Object.keys(asObject(slot.signature)).length ? asObject(slot.signature) : customer;
  const signedAt = cleanText(slot.signed_at || customer.signed_at || deliveryState(snapshot.delivery).signed_at || snapshot.signed_at || snapshot.customer_signed_at);
  if (!signedAt) return null;
  const signerName = cleanText(slot.signer_name || signature.signer_name || signature.text || page.customerPrintedNameValue || page.customer_printed_name || "Customer") || "Customer";
  const imageData = signatureImageData(signature);
  return {
    signer: "customer",
    role: "customer",
    type: imageData ? "draw" : cleanText(signature.type || "typed") || "typed",
    text: cleanText(signature.text || signature.name || signerName) || signerName,
    name: signerName,
    signer_name: signerName,
    signerName,
    style: cleanText(signature.style || "style-classic") || "style-classic",
    ...(imageData ? { dataUrl: imageData, image_data: imageData } : {}),
    evidence: asObject(slot.evidence || customer.evidence),
    signedAt,
    signed_at: signedAt
  };
}

function proposalContentWithSignedSlots(content: JsonObject = {}, snapshot: JsonObject = {}) {
  const next = cloneJson(content);
  next.status = "signed";
  if (next.bindings && typeof next.bindings === "object" && !Array.isArray(next.bindings)) {
    next.bindings = { ...asObject(next.bindings), refresh_until_status: "signed" };
  }
  next.pages = asArray(next.pages).map((pageValue, index) => {
    const page = asObject(pageValue);
    const kind = cleanText(page.kind).toLowerCase();
    if (kind !== "signature" && kind !== "fine_print") return page;
    if (kind === "fine_print" && page.requireCustomerSignature === false) return page;
    const signature = proposalCustomerSignatureForPage(snapshot, page, index);
    if (!signature) return page;
    return {
      ...page,
      customerPrintedNameValue: cleanText(page.customerPrintedNameValue || signature.signerName || "Customer"),
      signedSlots: {
        ...asObject(page.signedSlots),
        customerSignature: signature
      }
    };
  });
  return next;
}

function proposalSignedCompatibilityFields(signedAt: string, signatures: JsonObject = {}) {
  const at = cleanText(signedAt);
  if (!at) return {};
  const customer = asObject(signatures.customer);
  return {
    signed_at: at,
    customer_signed_at: at,
    delivery_status: "signed",
    is_editable: false,
    locked: true,
    locked_reason: "signed",
    signatures: {
      ...signatures,
      customer: {
        ...customer,
        signed_at: cleanText(customer.signed_at) || at
      }
    }
  };
}

function proposalViewedCompatibilityFields(delivery: JsonObject = {}) {
  const firstViewed = cleanText(delivery.first_viewed_at);
  const lastViewed = cleanText(delivery.last_viewed_at || firstViewed);
  return {
    viewed_at: lastViewed,
    first_viewed_at: firstViewed,
    last_viewed_at: lastViewed,
    customer_viewed_at: firstViewed,
    delivery_status: cleanText(delivery.state) === "signed" ? "signed" : "viewed"
  };
}

async function requireProposalFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "proposals"))) {
    throw forbidden("app_flag_disabled", "Proposals are not enabled for this organization.");
  }
}

async function projectData(orgId: string, projectId: string) {
  const project = await readDocument(orgId, "projects", projectId);
  return { document: project, data: documentData(project) };
}

async function patchProjectProposalRefs(orgId: string, projectId: string, proposalIdValue: string) {
  const project = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!project) return;
  const data = documentData(project);
  const proposalIds = normalizeStringArray(data.proposal_ids);
  if (!proposalIds.includes(proposalIdValue)) proposalIds.push(proposalIdValue);
  const workflow = cleanText(data.workflow_state).toLowerCase();
  const now = nowIso();
  const nextData = {
    proposal_ids: proposalIds,
    active_proposal_id: cleanText(data.active_proposal_id) || proposalIdValue,
    workflow_state: !workflow || workflow === "draft" || workflow === "contact_only" ? "proposal_only" : data.workflow_state,
    has_meaningful_activity: true,
    last_activity_at: now,
    updated_at: now
  };
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: nextData,
    metadata: {
      kind: "platform_project",
      proposal_ref_source: "proposals_api"
    }
  }, { replace: false });
  await ensurePipelinePlanForProject(orgId, { id: projectId, ...data, ...nextData });
}

export async function listProjectProposals(orgId: string, projectId: string) {
  await requireProposalFlag(orgId);
  const docs = await listDocuments(orgId, PROPOSAL_COLLECTION);
  return docs
    .map(proposalDocumentView)
    .filter((proposal) => cleanText(proposal.project_id) === projectId)
    .sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)));
}

export async function readProposal(orgId: string, proposalIdValue: string) {
  await requireProposalFlag(orgId);
  const document = await readDocument(orgId, PROPOSAL_COLLECTION, proposalIdValue);
  const proposal = proposalDocumentView(document);
  if (cleanText(proposal.organization_id) !== orgId) throw notFound("proposal_not_found", "Proposal was not found.");
  return proposal;
}

export async function createProposal(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireProposalFlag(orgId);
  const { data: project } = await projectData(orgId, projectId);
  const id = proposalId(input);
  const now = nowIso();
  const title = cleanText(input.title || asObject(input.editable).title || project.title || project.address || "Proposal") || "Proposal";
  const data: ProposalDocumentData = {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(input.branch_id || project.branch_id || ctx.branchId || "default") || "default",
    project_id: projectId,
    contacts: inputContacts(input, project),
    title,
    status: "draft",
    editable: editableContent(input, title),
    resources: asObject(input.resources),
    delivery: deliveryState({}),
    pdf: {},
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const document = await upsertDocument(orgId, PROPOSAL_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "proposal",
      project_id: projectId,
      branch_id: data.branch_id,
      status: data.status,
      ...(asObject(input.metadata))
    }
  }, { replace: true });
  await patchProjectProposalRefs(orgId, projectId, id);
  await recordProposalEvent(orgId, id, "proposal.created", { project_id: projectId }, ctx);
  return proposalDocumentView(document);
}

export async function patchProposal(orgId: string, proposalIdValue: string, patch: JsonObject, ctx: PlatformAuthContext) {
  await requireProposalFlag(orgId);
  const currentDoc = await readDocument(orgId, PROPOSAL_COLLECTION, proposalIdValue);
  const current = proposalDocumentView(currentDoc);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(currentDoc.revision || 0)) {
    throw conflict("proposal_revision_conflict", "Proposal revision does not match.");
  }
  if (isSignedProposalLike(current)) {
    throw conflict("proposal_locked_signed", "Signed proposals cannot be edited. Create a change order to make changes.");
  }
  const editablePatch = asObject(patch.editable);
  const hasEditablePatch = Object.keys(editablePatch).length > 0;
  const currentDelivery = deliveryState(current.delivery);
  const data = {
    ...current,
    title: cleanText(patch.title || current.title || editablePatch.title) || "Proposal",
    status: nextProposalStatus(proposalStatus(current.status), patch.status, hasEditablePatch),
    contacts: Object.prototype.hasOwnProperty.call(patch, "contacts") || Object.prototype.hasOwnProperty.call(patch, "participants")
      ? inputContacts(patch)
      : normalizeContacts(current.contacts || current.participants),
    editable: hasEditablePatch ? editableContent({ editable: { ...asObject(current.editable), ...editablePatch } }, cleanText(patch.title || current.title || editablePatch.title) || "Proposal") : asObject(current.editable),
    resources: Object.prototype.hasOwnProperty.call(patch, "resources") ? { ...asObject(current.resources), ...asObject(patch.resources) } : asObject(current.resources),
    delivery: {
      ...currentDelivery,
      ...asObject(patch.delivery),
      has_unpublished_changes: hasEditablePatch && cleanText(currentDelivery.current_snapshot_id) ? true : currentDelivery.has_unpublished_changes === true
    },
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  const document = await upsertDocument(orgId, PROPOSAL_COLLECTION, {
    id: proposalIdValue,
    expected_revision: expectedRevision || undefined,
    data,
    metadata: {
      kind: "proposal",
      project_id: cleanText(current.project_id),
      branch_id: cleanText(current.branch_id),
      status: data.status,
      ...(asObject(patch.metadata))
    }
  }, { replace: true });
  await recordProposalEvent(orgId, proposalIdValue, "proposal.updated", { fields: Object.keys(patch) }, ctx);
  return proposalDocumentView(document);
}

export async function duplicateProposal(orgId: string, proposalIdValue: string, input: JsonObject, ctx: PlatformAuthContext) {
  const source = await readProposal(orgId, proposalIdValue);
  const projectId = cleanText(input.project_id || source.project_id);
  if (!projectId) throw badRequest("missing_project_id", "A project id is required to duplicate this proposal.");
  const title = cleanText(input.title || `${cleanText(source.title || "Proposal") || "Proposal"} Copy`);
  const duplicate = await createProposal(orgId, projectId, {
    ...input,
    title,
    branch_id: cleanText(input.branch_id || source.branch_id || ctx.branchId || "default"),
    contacts: cloneJson(normalizeContacts(source.contacts || source.participants)),
    editable: cloneJson(asObject(source.editable)),
    resources: cloneJson(asObject(source.resources)),
    metadata: {
      ...asObject(input.metadata),
      source_proposal_id: proposalIdValue,
      duplicated_from_revision: Number(source.revision || 0)
    }
  }, ctx);
  await recordProposalEvent(orgId, proposalIdValue, "proposal.duplicated", {
    duplicate_id: cleanText(duplicate.id),
    project_id: projectId
  }, ctx);
  return duplicate;
}

export async function archiveProposal(orgId: string, proposalIdValue: string, input: JsonObject, ctx: PlatformAuthContext) {
  const current = await readProposal(orgId, proposalIdValue);
  const currentDelivery = deliveryState(current.delivery);
  const voidPublicLink = input.void_public_link === true;
  if (voidPublicLink && cleanText(currentDelivery.current_snapshot_id)) {
    const snapshot = await readProposalSnapshot(orgId, cleanText(currentDelivery.current_snapshot_id)).catch(() => null);
    if (snapshot) {
      await upsertDocument(orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
        id: cleanText(snapshot.id),
        data: {
          ...snapshot,
          status: "void",
          delivery: {
            ...deliveryState(snapshot.delivery),
            state: "void"
          },
          updated_at: nowIso()
        },
        metadata: {
          kind: "proposal_snapshot",
          proposal_id: proposalIdValue,
          status: "void"
        }
      }, { replace: true });
    }
  }
  const proposal = await patchProposal(orgId, proposalIdValue, {
    expected_revision: input.expected_revision,
    status: "archived",
    delivery: voidPublicLink
      ? {
          ...currentDelivery,
          state: "void",
          current_public_token: ""
        }
      : currentDelivery,
    metadata: {
      archive_reason: cleanText(input.reason)
    }
  }, ctx);
  await recordProposalEvent(orgId, proposalIdValue, "proposal.archived", {
    reason: cleanText(input.reason),
    void_public_link: voidPublicLink
  }, ctx);
  return proposal;
}

export async function listProposalSnapshots(orgId: string, proposalIdValue: string) {
  await requireProposalFlag(orgId);
  const docs = await listDocuments(orgId, PROPOSAL_SNAPSHOT_COLLECTION);
  return docs
    .map(snapshotDocumentView)
    .filter((snapshot) => cleanText(snapshot.proposal_id) === proposalIdValue)
    .sort((a, b) => Number(a.snapshot_number || 0) - Number(b.snapshot_number || 0));
}

export async function readProposalSnapshot(orgId: string, snapshotIdValue: string) {
  await requireProposalFlag(orgId);
  const document = await readDocument(orgId, PROPOSAL_SNAPSHOT_COLLECTION, snapshotIdValue);
  return snapshotDocumentView(document);
}

export async function createProposalSnapshot(orgId: string, proposalIdValue: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireProposalFlag(orgId);
  const proposalDoc = await readDocument(orgId, PROPOSAL_COLLECTION, proposalIdValue);
  const proposal = proposalDocumentView(proposalDoc);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(proposalDoc.revision || 0)) {
    throw conflict("proposal_revision_conflict", "Proposal revision does not match.");
  }
  if (isSignedProposalLike(proposal)) {
    throw conflict("proposal_locked_signed", "Signed proposals cannot be sent or edited. Create a change order to make changes.");
  }
  const snapshots = await listProposalSnapshots(orgId, proposalIdValue);
  const snapshotNumber = snapshots.length + 1;
  const id = snapshotId(proposalIdValue, snapshotNumber);
  const now = nowIso();
  const reason = cleanText(input.reason || "manual") || "manual";
  const includePortal = input.include_portal !== false && asObject(input.delivery).include_portal !== false;
  // A field user may need to hand the customer a signing link in person even
  // when there is no email/SMS recipient. In that case create a public portal
  // snapshot without representing the proposal as delivered.
  const publicToken = (reason === "send" || input.create_portal_link === true) && includePortal ? randomUUID() : "";
  const snapshotDelivery = {
    ...deliveryState(proposal.delivery),
    ...asObject(input.delivery),
    ...(Array.isArray(input.recipients) ? { recipients: input.recipients.map(asObject) } : {}),
    ...(publicToken ? { public_token: publicToken } : {})
  };
  const portalDefaults = await proposalPortalDefaultsForSnapshot(orgId, cleanText(proposal.branch_id || "default"));
  const frozenContent = proposalContentWithScopeSnapshot(asObject(proposal.editable));
  const data = {
    schema_version: PROPOSAL_SNAPSHOT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(proposal.branch_id),
    project_id: cleanText(proposal.project_id),
    proposal_id: proposalIdValue,
    snapshot_number: snapshotNumber,
    reason,
    title: cleanText(input.title || proposal.title) || "Proposal",
    status: reason === "sign" ? "signed" : reason === "send" ? "sent" : cleanText(proposal.status || "draft"),
    source_revision: Number(proposalDoc.revision || 0),
    content: cloneJson(frozenContent),
    completion_message: portalDefaults.completion_message,
    show_portal_price_comparison: portalDefaults.show_portal_price_comparison,
    allow_multiple_proposal_selection: input.allow_multiple_proposal_selection === true,
    resources: JSON.parse(JSON.stringify(asObject(proposal.resources))),
    contacts: cloneJson(normalizeContacts(proposal.contacts || proposal.participants)),
    delivery: snapshotDelivery,
    document_html: cleanText(input.document_html || input.html),
    project_snapshot: await proposalProjectSnapshot(orgId, cleanText(proposal.project_id)),
    contact_snapshot: {
      contacts: cloneJson(normalizeContacts(proposal.contacts || proposal.participants)),
      recipients: cloneJson(deliveryState(snapshotDelivery).recipients)
    },
    signatures: asObject(asObject(proposal.editable).signatures),
    pdf: {},
    locked: true,
    locked_at: now,
    created_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const document = await upsertDocument(orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "proposal_snapshot",
      proposal_id: proposalIdValue,
      project_id: cleanText(proposal.project_id),
      reason,
      ...(publicToken ? { public_token: publicToken } : {})
    }
  }, { replace: true });
  await recordProposalEvent(orgId, proposalIdValue, "proposal.snapshot_created", { snapshot_id: id, reason }, ctx);
  if (input.generate_pdf === true) {
    await generateProposalPdf(orgId, proposalIdValue, { snapshot_id: id, store: true, html: cleanText(input.document_html || input.html) }, ctx);
  }
  return snapshotDocumentView(document);
}

async function proposalProjectSnapshot(orgId: string, projectId: string) {
  const project = await readDocument(orgId, "projects", projectId).catch(() => null);
  const data = documentData(project || {});
  return {
    id: projectId,
    title: cleanText(data.title),
    address: cleanText(data.address),
    project_type: cleanText(data.project_type),
    contacts: Array.isArray(data.contacts) ? data.contacts.map(asObject) : [],
    photos: Array.isArray(data.photos) ? data.photos.map(asObject) : []
  };
}

export async function sendProposal(orgId: string, proposalIdValue: string, input: JsonObject, ctx: PlatformAuthContext) {
  const createdSnapshot = await createProposalSnapshot(orgId, proposalIdValue, {
    ...input,
    reason: "send",
    generate_pdf: input.include_pdf !== false
  }, ctx);
  const snapshot = await readProposalSnapshot(orgId, cleanText(createdSnapshot.id));
  const proposal = await readProposal(orgId, proposalIdValue);
  await patchProjectProposalRefs(orgId, cleanText(proposal.project_id), proposalIdValue);
  const delivery = deliveryState(proposal.delivery);
  const sentAt = nowIso();
  const recipients = Array.isArray(input.recipients) ? input.recipients.map(asObject) : delivery.recipients;
  const emailRecipients = recipients
    .map((recipient) => ({ email: cleanText(recipient.email || recipient.address).toLowerCase(), name: cleanText(recipient.name) }))
    .filter((recipient, index, values) => recipient.email && values.findIndex((value) => value.email === recipient.email) === index);
  const publicToken = cleanText(asObject(snapshot.delivery).public_token);
  const portalUrl = publicToken ? `${env.publicBaseUrl.replace(/\/+$/, "")}/v1/proposals/public/${encodeURIComponent(publicToken)}/app` : "";
  const organization = asObject(await readOrganization(orgId).catch(() => ({})));
  const organizationName = cleanText(organization.name) || "our team";
  let pdfAttachment: { name: string; contentType: string; content: Uint8Array } | undefined;
  if (input.include_pdf !== false) {
    const pdf = asObject(snapshot.pdf);
    const mediaId = cleanText(pdf.media_id || asObject(pdf.media_ref).media_id);
    if (mediaId) {
      const file = await readMediaFile(orgId, mediaId, "original");
      pdfAttachment = { name: file.fileName || `${cleanText(snapshot.title) || "proposal"}.pdf`, contentType: file.contentType || "application/pdf", content: file.bytes };
    }
  }
  const emailResults = [];
  for (const recipient of emailRecipients) {
    const greeting = recipient.name ? `Hi ${recipient.name},` : "Hello,";
    const textBody = [
      greeting,
      "",
      cleanText(input.message) || `Your proposal from ${organizationName} is ready to review.`,
      ...(portalUrl ? ["", `Review and respond here: ${portalUrl}`] : [])
    ].join("\n");
    const result = await sendOrganizationTransactionalEmail({
      organizationId: orgId,
      branchId: cleanText(proposal.branch_id || "default") || "default",
      to: recipient.email,
      subject: cleanText(input.subject) || cleanText(snapshot.title) || "Your proposal",
      textBody,
      purpose: "transactional",
      projectId: cleanText(proposal.project_id),
      tags: ["proposal-send"],
      source: { type: "user", id: "proposal_delivery", user_id: ctx.userId },
      metadata: { proposal_id: proposalIdValue, snapshot_id: cleanText(snapshot.id) },
      idempotencyKey: `proposal_email:${cleanText(snapshot.id)}:${recipient.email}`,
      attachments: pdfAttachment ? [pdfAttachment] : undefined
    }, ctx);
    emailResults.push({ email: recipient.email, message_id: cleanText(result.message.id), ok: result.ok });
  }
  if (emailResults.some((result) => !result.ok)) throw badRequest("proposal_email_failed", "The proposal email could not be sent.");
  const updated = await patchProposal(orgId, proposalIdValue, {
    status: "sent",
    delivery: {
      ...delivery,
      state: "sent",
      send_count: Number(delivery.send_count || 0) + 1,
      sent_at: sentAt,
      current_snapshot_id: cleanText(snapshot.id),
      current_public_token: cleanText(asObject(snapshot.delivery).public_token),
      recipients,
      include_pdf: input.include_pdf !== false,
      include_portal: input.include_portal !== false,
      has_unpublished_changes: false
    }
  }, ctx);
  await recordProposalEvent(orgId, proposalIdValue, "proposal.sent", {
    snapshot_id: cleanText(snapshot.id),
    recipients,
    include_pdf: input.include_pdf !== false,
    include_portal: input.include_portal !== false,
    email_results: emailResults
  }, ctx);
  await patchProjectSharedProposal(orgId, {
    ...snapshot,
    status: "sent",
    delivery: {
      ...deliveryState(snapshot.delivery),
      sent_at: sentAt,
      public_token: cleanText(asObject(snapshot.delivery).public_token)
    }
  }, cleanText(asObject(snapshot.delivery).public_token)).catch(() => null);
  return { proposal: updated, snapshot, emailed: emailResults };
}

export async function generateProposalPdf(orgId: string, proposalIdValue: string, input: JsonObject, ctx: PlatformAuthContext) {
  await requireProposalFlag(orgId);
  const proposal = await readProposal(orgId, proposalIdValue);
  const snapshotIdValue = cleanText(input.snapshot_id || asObject(proposal.delivery).current_snapshot_id);
  const snapshot = snapshotIdValue ? await readProposalSnapshot(orgId, snapshotIdValue).catch(() => null) : null;
  const rendered = await renderProposalTemplatePdf(orgId, {
    proposal,
    snapshot,
    title: cleanText(input.title || asObject(snapshot || {}).title || proposal.title)
  });
  if (input.store === false) {
    await recordProposalEvent(orgId, proposalIdValue, "proposal.pdf_rendered", { stored: false }, ctx);
    return { ...rendered, media: null, snapshot };
  }
  const media = await storeMediaUpload(orgId, {
    ownerType: "proposal",
    ownerId: proposalIdValue,
    slot: snapshotIdValue ? `pdf_${snapshotIdValue}` : "pdf_current",
    collection: PROPOSAL_COLLECTION,
    scope: "proposal",
    fileName: rendered.fileName,
    contentType: "application/pdf",
    bytes: rendered.bytes,
    metadata: {
      proposal_id: proposalIdValue,
      snapshot_id: snapshotIdValue,
      source: "proposals_api"
    },
    thumbnails: false,
    compression: false
  });
  const pdfRef = {
    kind: "media_reference",
    media_id: cleanText(media.id),
    variant: "original",
    file_name: cleanText(media.file_name),
    content_type: cleanText(media.content_type),
    size_bytes: Number(media.size_bytes || rendered.bytes.length),
    owner: asObject(media.owner),
    metadata: asObject(media.metadata),
    created_at: cleanText(media.created_at),
    updated_at: cleanText(media.updated_at)
  };
  if (snapshotIdValue && snapshot) {
    await upsertDocument(orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
      id: snapshotIdValue,
      data: {
        ...snapshot,
        pdf: {
          ...asObject(snapshot.pdf),
          media_id: cleanText(media.id),
          media_ref: pdfRef,
          generated_at: nowIso(),
          page_count: rendered.pageCount
        }
      },
      metadata: { kind: "proposal_snapshot", proposal_id: proposalIdValue }
    }, { replace: true });
  }
  await upsertDocument(orgId, PROPOSAL_COLLECTION, {
    id: proposalIdValue,
    data: {
      ...proposal,
      pdf: {
        ...asObject(proposal.pdf),
        latest_media_id: cleanText(media.id),
        latest_media_ref: pdfRef,
        latest_snapshot_id: snapshotIdValue,
        generated_at: nowIso(),
        page_count: rendered.pageCount
      }
    },
    metadata: { kind: "proposal", project_id: cleanText(proposal.project_id), status: cleanText(proposal.status) }
  }, { replace: true });
  await recordProposalEvent(orgId, proposalIdValue, "proposal.pdf_generated", {
    media_id: cleanText(media.id),
    snapshot_id: snapshotIdValue,
    page_count: rendered.pageCount
  }, ctx);
  return { ...rendered, media, media_ref: pdfRef, snapshot };
}

export async function readProposalPdfFile(orgId: string, proposalIdValue: string, mediaId?: string, snapshotId?: string) {
  await requireProposalFlag(orgId);
  const proposal = await readProposal(orgId, proposalIdValue);
  const explicitMediaId = cleanText(mediaId);
  const requestedSnapshotId = cleanText(snapshotId);
  const pdf = asObject(proposal.pdf);
  const signedRef = asObject(pdf.signed_media_ref);
  const latestRef = asObject(pdf.latest_media_ref);
  const signedMediaId = cleanText(pdf.signed_media_id || signedRef.media_id || signedRef.id);
  const latestMediaId = cleanText(pdf.latest_media_id || latestRef.media_id || latestRef.id);
  const explicitSnapshot = requestedSnapshotId ? await readProposalSnapshot(orgId, requestedSnapshotId).catch(() => null) : null;
  const signed = isSignedProposalLike(proposal) || (!!explicitSnapshot && isSignedProposalLike(explicitSnapshot));
  const resolvedMediaId = explicitMediaId || (signed ? signedMediaId : latestMediaId) || latestMediaId;
  if (!explicitMediaId && signed && (!signedMediaId || explicitSnapshot)) {
    const snapshotIdValue = requestedSnapshotId || cleanText(deliveryState(proposal.delivery).current_snapshot_id || pdf.latest_snapshot_id);
    const snapshot = explicitSnapshot || (snapshotIdValue ? await readProposalSnapshot(orgId, snapshotIdValue).catch(() => null) : null);
    if (snapshot) {
      const signedSnapshot: JsonObject = {
        ...snapshot,
        delivery: { ...deliveryState(snapshot.delivery), ...deliveryState(proposal.delivery) },
        signatures: Object.keys(asObject(snapshot.signatures)).length ? asObject(snapshot.signatures) : asObject(proposal.signatures),
        status: signed ? "signed" : cleanText(proposal.status || snapshot.status)
      };
      const rendered = await renderProposalTemplatePdf(orgId, {
        proposal,
        snapshot: signedSnapshot,
        title: cleanText(signedSnapshot.title || proposal.title || "Signed Proposal")
      });
      return {
        contentType: "application/pdf",
        fileName: rendered.fileName.replace(/\.pdf$/i, "-signed.pdf"),
        bytes: rendered.bytes
      };
    }
  }
  if (!resolvedMediaId) throw notFound("proposal_pdf_not_found", "No generated PDF is available for this proposal.");
  return await readMediaFile(orgId, resolvedMediaId, "original");
}

export async function readPublicProposalPdfFile(publicToken: string) {
  const found = await findPublicProposalSnapshot(publicToken);
  const snapshot = found.snapshot;
  const pdf = asObject(snapshot.pdf);
  const mediaRef = asObject(pdf.media_ref);
  const signedMediaRef = asObject(pdf.signed_media_ref);
  const mediaId = cleanText(pdf.signed_media_id || signedMediaRef.media_id || pdf.media_id || mediaRef.media_id);
  if (mediaId) return await readMediaFile(found.orgId, mediaId, "original");
  if (isSignedProposalLike(snapshot)) {
    const rendered = await renderProposalTemplatePdf(found.orgId, {
      proposal: {},
      snapshot,
      title: cleanText(snapshot.title || "Signed Proposal")
    });
    return {
      contentType: "application/pdf",
      fileName: rendered.fileName.replace(/\.pdf$/i, "-signed.pdf"),
      bytes: rendered.bytes
    };
  }
  const rendered = await renderProposalTemplatePdf(found.orgId, {
    proposal: {},
    snapshot,
    title: cleanText(snapshot.title)
  });
  return {
    contentType: "application/pdf",
    fileName: rendered.fileName,
    bytes: rendered.bytes
  };
}

function paymentInvoiceDate(value: unknown) {
  const parsed = new Date(cleanText(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function paymentInvoiceLabel(payment: JsonObject) {
  const metadata = asObject(payment.metadata);
  const explicit = cleanText(metadata.payment_label || payment.label);
  if (explicit) return explicit;
  const kind = cleanText(payment.kind).toLowerCase();
  if (kind.includes("deposit")) return "Deposit";
  if (kind.includes("final")) return "Final Payment";
  if (kind.includes("progress")) return "Progress Payment";
  return "Project Payment";
}

export async function readPublicProposalReceiptPdfFile(publicToken: string, paymentIdValue = "") {
  const found = await findPublicProposalSnapshot(publicToken);
  const snapshot = found.snapshot;
  const projectId = cleanText(snapshot.project_id);
  const requestedPaymentId = cleanText(paymentIdValue);
  const projectPayments = projectId ? await listProjectPayments(found.orgId, projectId, { skipFlag: true }).catch(() => []) : [];
  const settledPayments = projectPayments.filter((item) => {
    const direction = cleanText(item.direction || "inbound").toLowerCase();
    const status = cleanText(item.status).toLowerCase();
    return direction !== "outbound" && ["settled", "partially_refunded", "paid"].includes(status);
  });
  let payment = requestedPaymentId
    ? settledPayments.find((item) => cleanText(item.id) === requestedPaymentId)
    : settledPayments.find((item) => cleanText(item.id) === cleanText(asObject(snapshot.customer_payment).payment_id)) || settledPayments[0];
  if (requestedPaymentId && !payment) throw notFound("payment_receipt_not_found", "That paid invoice is not available for this project.");
  if (!payment) {
    const legacyPayment = asObject(snapshot.customer_payment);
    if (!cleanText(legacyPayment.status).includes("paid") && !cleanText(legacyPayment.paid_at)) {
      throw badRequest("receipt_not_available", "A paid invoice is available after payment.");
    }
    payment = legacyPayment;
  }
  const amountCents = Math.max(0, Math.round(Number(payment.amount_cents || payment.deposit_paid_cents || payment.deposit_amount_cents || 0)));
  if (!amountCents) throw badRequest("receipt_not_available", "A paid invoice is available after payment.");
  const paymentId = cleanText(payment.id || payment.payment_id || snapshot.id);
  const paymentSuffix = paymentId.slice(-8).toUpperCase() || "PAYMENT";
  const paidAt = cleanText(payment.settled_at || payment.received_at || payment.paid_at || payment.created_at);
  const issueDate = paymentInvoiceDate(paidAt);
  const projectDocument = projectId ? await readDocument(found.orgId, "projects", projectId).catch(() => null) : null;
  const project = asObject(asObject(projectDocument).data);
  const contact = asObject(asArray(asObject(snapshot.contact_snapshot).contacts)[0] || asArray(snapshot.contacts)[0] || asArray(project.contacts)[0]);
  const label = paymentInvoiceLabel(payment);
  const invoiceNumber = `INV-${issueDate.replace(/-/g, "").slice(2)}-${paymentSuffix}`;
  const invoice: JsonObject = {
    id: `portal_payment_${paymentId}`,
    invoice_number: invoiceNumber,
    organization_id: found.orgId,
    branch_id: cleanText(snapshot.branch_id || project.branch_id || "default") || "default",
    project_id: projectId,
    project_ref: {
      id: projectId,
      title: cleanText(project.title || snapshot.title || "Project"),
      address: cleanText(project.address || project.project_address)
    },
    proposal_ref: {
      id: cleanText(snapshot.proposal_id),
      snapshot_id: cleanText(snapshot.id),
      title: cleanText(snapshot.title || "Project proposal")
    },
    customer: {
      id: cleanText(contact.id || contact.contact_id),
      name: cleanText(contact.name || project.customer_name || "Customer"),
      email: cleanText(contact.email || project.customer_email),
      address: cleanText(contact.address || project.customer_address || project.address)
    },
    issue_date: issueDate,
    due_date: issueDate,
    status: "paid",
    render_paid_in_full: true,
    line_items: [{ id: `payment_line_${paymentId}`, type: "payment", payment_id: paymentId, description: label, amount_cents: amountCents }],
    subtotal_cents: amountCents,
    tax_enabled: false,
    tax_percent: 0,
    tax_cents: 0,
    total_cents: amountCents,
    amount_paid_cents: amountCents,
    balance_due_cents: 0
  };
  const rendered = await renderInvoiceDocumentPdf(found.orgId, invoice);
  return { contentType: rendered.contentType, fileName: `paid-invoice-${paymentSuffix.toLowerCase()}.pdf`, bytes: rendered.bytes };
}

function proposalPages(snapshot: JsonObject) {
  const content = asObject(snapshot.content);
  return asArray(content.pages).map(asObject).filter((page) => asObject(page).enabled !== false);
}

function proposalSignaturePage(snapshot: JsonObject) {
  return proposalPages(snapshot).find((page) => cleanText(page.kind).toLowerCase() === "signature") || {};
}

function proposalPricingSubtotalCents(snapshot: JsonObject) {
  const content = asObject(snapshot.content);
  const scope = normalizeProposalScope(content.scope);
  const scopeTotal = proposalScopeTotalCents(scope);
  if (scopeTotal > 0 || asArray(scope.root_items).length) return scopeTotal;
  const pricing = asObject(content.pricing);
  const pricingTotal = moneyCents(pricing.subtotal ?? pricing.subtotalValue);
  if (pricingTotal > 0) return pricingTotal;
  return proposalPages(snapshot)
    .filter((page) => cleanText(page.kind).toLowerCase() === "pricing")
    .reduce((sum, page) => {
      const rows = asArray(page.lineItems || page.line_items).map(asObject);
      return sum + rows.reduce((lineSum, row) => lineSum + moneyCents(row.amount ?? row.total), 0);
    }, 0);
}

function proposalTotalCents(snapshot: JsonObject) {
  const content = asObject(snapshot.content);
  const scope = normalizeProposalScope(content.scope);
  const scopeTotal = proposalScopeTotalCents(scope);
  if (scopeTotal > 0 || asArray(scope.root_items).length) return scopeTotal;
  const pricing = asObject(content.pricing);
  const signature = proposalSignaturePage(snapshot);
  for (const value of [
    pricing.total,
    pricing.totalValue,
    pricing.contract_total,
    signature.totalAmount,
    signature.totalValue,
    signature.total,
    signature.contractAmount
  ]) {
    const cents = moneyCents(value);
    if (cents > 0) return cents;
  }
  const subtotal = proposalPricingSubtotalCents(snapshot);
  const tax = signature.showTax === false ? 0 : moneyCents(signature.taxAmount);
  return subtotal + tax;
}

function proposalDepositCents(snapshot: JsonObject) {
  const signature = proposalSignaturePage(snapshot);
  const explicit = moneyCents(signature.depositAmount ?? signature.deposit_amount);
  if (explicit > 0) return explicit;
  const payment = asObject(asObject(snapshot.content).payment);
  const first = asArray(payment.schedule || payment.items || payment.payment_schedule).map(asObject)[0] || {};
  return moneyCents(first);
}

async function proposalPortalDefaultsForSnapshot(orgId: string, branchId: string) {
  const module = await readBranchModule(orgId, branchId || "default", "presentation_style").catch(() => null);
  const data = asObject(asObject(module).data);
  const defaults = asObject(data.proposal_defaults);
  return {
    completion_message: cleanText(defaults.completion_message || "{{company}} will reach out with next steps."),
    show_portal_price_comparison: defaults.show_portal_price_comparison !== false
  };
}

function publicProposalLineItems(page: JsonObject) {
  return asArray(page.lineItems || page.line_items)
    .map(asObject)
    .map((item) => ({
      label: cleanText(item.label || item.name || "Line item"),
      quantity: cleanText(item.quantity || item.qty || "1"),
      unit: cleanText(item.unit),
      unit_price: moneyDisplay(moneyCents(item.unitPrice ?? item.unit_price)),
      amount: moneyDisplay(moneyCents(item.amount ?? item.total))
    }))
    .filter((item) => item.label || item.amount !== "$0.00");
}

function signedSlotIds(snapshot: JsonObject) {
  const signatures = asObject(snapshot.signatures);
  const slots = asObject(signatures.slots);
  return new Set(Object.keys(slots).filter((key) => cleanText(asObject(slots[key]).signed_at)));
}

function customerSignatureSlots(snapshot: JsonObject) {
  const ids = signedSlotIds(snapshot);
  const delivery = deliveryState(snapshot.delivery);
  const snapshotSignedAt = cleanText(delivery.signed_at || snapshot.signed_at || snapshot.customer_signed_at);
  const snapshotSigned = isSignedProposalLike(snapshot) && !!snapshotSignedAt;
  const customerSignature = asObject(asObject(snapshot.signatures).customer);
  return proposalPages(snapshot)
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => ["signature", "fine_print"].includes(cleanText(page.kind).toLowerCase()))
    .filter(({ page }) => cleanText(page.kind).toLowerCase() !== "fine_print" || page.requireCustomerSignature !== false)
    .map(({ page, index }) => {
      const pageId = cleanText(page.id) || `page_${index + 1}`;
      const kind = cleanText(page.kind).toLowerCase();
      const slotId = `${pageId}:customer_signature`;
      const slotData = asObject(asObject(asObject(snapshot.signatures).slots)[slotId]);
      const signature = Object.keys(asObject(slotData.signature)).length ? asObject(slotData.signature) : customerSignature;
      const signedAt = cleanText(slotData.signed_at || (snapshotSigned ? snapshotSignedAt : ""));
      const signerName = cleanText(slotData.signer_name || signature.signer_name || signature.text || page.customerPrintedNameValue || page.customer_printed_name || "Customer");
      return {
        id: slotId,
        page_id: pageId,
        page_index: index,
        signer: "customer",
        role: "customer",
        label: cleanText(page.customerSignatureLabel || page.customer_signature_label || (kind === "fine_print" ? "Customer signature for terms" : "Customer signature")),
        signed: ids.has(slotId) || !!signedAt,
        signer_name: signerName,
        signature,
        signed_at: signedAt
      };
    });
}

function publicProposalPage(pageValue: unknown, snapshot: JsonObject, index: number) {
  const page = asObject(pageValue);
  const kind = cleanText(page.kind || "scope").toLowerCase() || "scope";
  const pageId = cleanText(page.id) || `page_${index + 1}`;
  const content = asObject(snapshot.content);
  const base = {
    id: pageId,
    kind,
    title: cleanText(page.title),
    kicker: cleanText(page.kicker)
  };
  if (kind === "pricing") {
    const scopeView = asObject(page.scope_view || page.scopeView || {
      root_item_id: cleanText(page.scope_root_id || page.scopeRootId || "root") || "root",
      render_depth: Number(page.render_depth ?? page.renderDepth ?? 1) || 1,
      show_included_items: page.show_included_items !== false,
      show_unselected_options: page.show_unselected_options === true
    });
    const scopedItems = publicScopeLineItems(content.scope, scopeView);
    const lineItems = scopedItems.length ? scopedItems : publicProposalLineItems(page);
    return {
      ...base,
      notes: cleanText(page.notes),
      scope_view: scopeView,
      line_items: lineItems,
      total: scopeMoneyDisplay(lineItems.reduce((sum, item) => sum + scopeMoneyCents(asObject(item).amount), 0))
    };
  }
  if (kind === "signature") {
    return {
      ...base,
      summary: cleanText(page.summary),
      pricing_summary_title: cleanText(page.pricingSummaryTitle || "Contract Amount"),
      payment_schedule_title: cleanText(page.paymentScheduleTitle || "Payment Schedule"),
      customer_signature_label: cleanText(page.customerSignatureLabel || "Customer Signature"),
      customer_printed_name: cleanText(page.customerPrintedNameValue),
      company_signature_label: cleanText(page.companySignatureLabel || "Company Representative Signature"),
      company_representative: cleanText(page.companyRepresentativeValue),
      date_label: cleanText(page.dateLabel || "Date"),
      date_value: cleanText(page.dateValue),
      deposit_label: cleanText(page.depositLabel || "Deposit Amount"),
      deposit_amount: moneyDisplay(proposalDepositCents(snapshot)),
      completion_label: cleanText(page.completionLabel || "Balance During Completion"),
      completion_amount: moneyDisplay(moneyCents(page.completionAmount)),
      financed_label: cleanText(page.financedLabel || "Amount Financed"),
      financed_amount: moneyDisplay(moneyCents(page.financedAmount)),
      show_tax: page.showTax !== false,
      tax_amount: moneyDisplay(page.showTax === false ? 0 : moneyCents(page.taxAmount)),
      signed: signedSlotIds(snapshot).has(`${pageId}:customer_signature`) || !!proposalCustomerSignatureForPage(snapshot, page, index)
    };
  }
  if (kind === "fine_print") {
    return {
      ...base,
      summary: cleanText(page.summary),
      body: cleanText(page.body),
      customer_signature_label: cleanText(page.customerSignatureLabel || "Customer Signature"),
      customer_printed_name: cleanText(page.customerPrintedNameValue),
      require_customer_signature: page.requireCustomerSignature !== false,
      signed: signedSlotIds(snapshot).has(`${pageId}:customer_signature`) || !!proposalCustomerSignatureForPage(snapshot, page, index)
    };
  }
  return {
    ...base,
    heading: cleanText(page.heading),
    prepared_for: cleanText(page.preparedFor || page.prepared_for),
    prepared_by: cleanText(page.preparedBy || page.prepared_by),
    date: cleanText(page.date),
    summary: cleanText(page.summary),
    body: cleanText(page.body),
    blocks: asArray(page.blocks).map(asObject)
  };
}

function publicSharedProposalView(snapshot: JsonObject, publicToken = "") {
  const delivery = deliveryState(snapshot.delivery);
  const rawStatus = cleanText(snapshot.status || delivery.state || "sent").toLowerCase() || "sent";
  const signed = isSignedProposalLike(snapshot);
  const signedAt = cleanText(delivery.signed_at || snapshot.signed_at || snapshot.customer_signed_at);
  const status = signed ? "signed" : rawStatus;
  const subtotal = proposalPricingSubtotalCents(snapshot);
  const signature = proposalSignaturePage(snapshot);
  const tax = signature.showTax === false ? 0 : moneyCents(signature.taxAmount);
  const total = proposalTotalCents(snapshot);
  const token = publicToken || cleanText(asObject(snapshot.delivery).public_token);
  const signatures = asObject(snapshot.signatures);
  return {
    id: cleanText(snapshot.id),
    proposal_id: cleanText(snapshot.proposal_id),
    snapshot_id: cleanText(snapshot.id),
    public_token: token,
    app_url: token ? `/v1/proposals/public/${encodeURIComponent(token)}/app` : "",
    title: cleanText(snapshot.title || "Proposal"),
    status,
    created_at: cleanText(snapshot.created_at),
    sent_at: cleanText(delivery.sent_at || snapshot.created_at),
    signed_at: signedAt,
    ...proposalViewedCompatibilityFields(delivery),
    ...(signed ? proposalSignedCompatibilityFields(signedAt, signatures) : {}),
    delivery,
    customer_payment: asObject(snapshot.customer_payment),
    pdf_url: token ? `/v1/proposals/public/${encodeURIComponent(token)}/pdf` : "",
    pdf: asObject(snapshot.pdf),
    document_html: cleanText(snapshot.document_html),
    builder_document: {
      ...asObject(snapshot.content),
      id: cleanText(snapshot.proposal_id),
      title: cleanText(snapshot.title || asObject(snapshot.content).title || "Proposal"),
      status,
      snapshot_id: cleanText(snapshot.id),
      public_token: token,
      sent_at: cleanText(delivery.sent_at || snapshot.created_at)
    },
    totals: {
      subtotal: moneyDisplay(subtotal || Math.max(0, total - tax)),
      tax: moneyDisplay(tax),
      total: moneyDisplay(total)
    },
    workflow: {
      signed,
      customer_signature_slots: customerSignatureSlots(snapshot),
      payment: asObject(snapshot.customer_payment),
      completion_message: cleanText(snapshot.completion_message),
      show_portal_price_comparison: snapshot.show_portal_price_comparison !== false,
      allow_multiple_proposal_selection: snapshot.allow_multiple_proposal_selection === true
    },
    pages: proposalPages(snapshot).map((page, index) => publicProposalPage(page, snapshot, index))
  };
}

function signatureText(signature: JsonObject) {
  return cleanText(signature.text || signature.name || signature.signer_name || "Signed");
}

function signatureImageData(signature: JsonObject) {
  const image = cleanText(signature.image_data || signature.imageData || signature.data_url || signature.dataUrl);
  return /^data:image\//i.test(image) ? image : "";
}

function signedDocumentHtml(snapshot: JsonObject) {
  const html = cleanText(snapshot.document_html);
  if (!html) return "";
  const signatures = asObject(snapshot.signatures);
  const slots = Object.values(asObject(signatures.slots)).map(asObject)
    .filter((slot) => cleanText(slot.signer || slot.role) === "customer" && cleanText(slot.signed_at));
  const customer = asObject(signatures.customer);
  const fallback = customer && cleanText(customer.signed_at) ? [customer] : [];
  const signedSlots = slots.length ? slots : fallback;
  const payload = JSON.stringify(signedSlots.map((slot) => {
    const slotSignature = asObject(slot.signature);
    const signature = Object.keys(slotSignature).length ? slotSignature : slot;
    return {
      text: signatureText(signature) || cleanText(slot.signer_name) || "Signed",
      signer_name: cleanText(slot.signer_name || signature.signer_name || signature.text),
      style: cleanText(signature.style || "style-classic"),
      image_data: signatureImageData(signature),
      signed_at: cleanText(slot.signed_at || customer.signed_at)
    };
  })).replace(/</g, "\\u003c");
  const script = `
<script>
(function(){
  var signatures = ${payload};
  window.__proposalSignedStampsApplied = false;
  window.__proposalPdfCanvasReady = false;
  function apply(){
    var targets = Array.prototype.slice.call(document.querySelectorAll('.r-proposal-signature-box[data-sign-signer="customer"]'));
    targets.forEach(function(target, index){
      var sig = signatures[Math.min(index, signatures.length - 1)];
      if (!sig) return;
      target.classList.add('signed');
      var value = target.querySelector('.r-proposal-signature-value');
      if (!value) {
        value = document.createElement('div');
        value.className = 'r-proposal-signature-value';
        target.insertBefore(value, target.firstChild);
      }
      if (value && sig.image_data) value.innerHTML = '<img class="r-proposal-signature-image" src="' + String(sig.image_data).replace(/"/g, '&quot;') + '" alt="Signature" style="display:block;max-width:260px;max-height:58px;object-fit:contain">';
      else if (value) value.innerHTML = '<span class="r-proposal-signature-script ' + String(sig.style || 'style-classic').replace(/[^a-zA-Z0-9_-]/g, '') + '">' + String(sig.text || 'Signed').replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }) + '</span>';
      var name = target.querySelector('.r-proposal-signature-autofill');
      if (name && sig.signer_name) name.textContent = sig.signer_name;
    });
    window.__proposalSignedStampsApplied = true;
    window.__proposalPdfCanvasReady = true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
</script>`;
  return html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : `${html}${script}`;
}

async function storeSignedProposalPdf(orgId: string, snapshot: JsonObject) {
  const rendered = await renderProposalTemplatePdf(orgId, {
    proposal: {},
    snapshot,
    title: cleanText(snapshot.title || "Signed Proposal")
  });
  const media = await storeMediaUpload(orgId, {
    ownerType: "proposal",
    ownerId: cleanText(snapshot.proposal_id),
    slot: `signed_pdf_${cleanText(snapshot.id)}`,
    collection: PROPOSAL_COLLECTION,
    scope: "proposal",
    fileName: rendered.fileName.replace(/\.pdf$/i, "-signed.pdf"),
    contentType: "application/pdf",
    bytes: rendered.bytes,
    metadata: {
      proposal_id: cleanText(snapshot.proposal_id),
      snapshot_id: cleanText(snapshot.id),
      source: "proposal_public_esign",
      signed: true
    },
    thumbnails: false,
    compression: false
  });
  return {
    kind: "media_reference",
    media_id: cleanText(media.id),
    variant: "original",
    file_name: cleanText(media.file_name),
    content_type: cleanText(media.content_type),
    size_bytes: Number(media.size_bytes || rendered.bytes.length),
    owner: asObject(media.owner),
    metadata: asObject(media.metadata),
    created_at: cleanText(media.created_at),
    updated_at: cleanText(media.updated_at)
  };
}

async function patchProjectSharedProposal(orgId: string, snapshot: JsonObject, publicToken = "") {
  const projectId = cleanText(snapshot.project_id);
  if (!projectId) return null;
  const projectDoc = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (!projectDoc) return null;
  const project = documentData(projectDoc);
  const current = asArray(project.proposals).map(asObject);
  const shared = publicSharedProposalView(snapshot, publicToken);
  const proposalIdValue = cleanText(snapshot.proposal_id);
  const snapshotIdValue = cleanText(snapshot.id);
  const next = [
    shared,
    ...current.filter((item) => cleanText(item.snapshot_id || item.id) !== snapshotIdValue && cleanText(item.proposal_id || item.id) !== proposalIdValue)
  ];
  const doc = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...project, proposals: next },
    metadata: {
      ...asObject(asObject(projectDoc).metadata),
      kind: cleanText(asObject(asObject(projectDoc).metadata).kind) || "platform_project",
      proposal_portal_source: "proposals_api"
    }
  }, { replace: true });
  return documentData(doc);
}

async function expireSiblingProposalOptions(orgId: string, signedSnapshot: JsonObject) {
  if (signedSnapshot.allow_multiple_proposal_selection === true) return;
  const projectId = cleanText(signedSnapshot.project_id);
  const signedProposalId = cleanText(signedSnapshot.proposal_id);
  if (!projectId || !signedProposalId) return;
  const now = nowIso();
  const isExpirable = (item: JsonObject) => {
    const status = cleanText(item.status).toLowerCase();
    const rawDelivery = asObject(item.delivery);
    const delivery = deliveryState(item.delivery);
    const deliveryStatus = cleanText(delivery.state).toLowerCase();
    if (cleanText(item.proposal_id || item.id) === signedProposalId) return false;
    if (["signed", "archived", "void", "discarded"].includes(status)) return false;
    if (["signed", "void"].includes(deliveryStatus)) return false;
    return ["sent", "viewed", "expired"].includes(status) || ["sent", "viewed", "expired"].includes(deliveryStatus) || !!cleanText(delivery.current_public_token || rawDelivery.public_token);
  };
  const expireItem = (item: JsonObject) => ({
    ...item,
    status: "expired",
    expired_at: cleanText(item.expired_at) || now,
    expired_by_proposal_id: signedProposalId,
    delivery: {
      ...deliveryState(item.delivery),
      state: "expired",
      expired_at: cleanText(asObject(item.delivery).expired_at) || now,
      expired_by_proposal_id: signedProposalId
    }
  });
  const projectDoc = await readDocument(orgId, "projects", projectId).catch(() => null);
  if (projectDoc) {
    const project = documentData(projectDoc);
    let changed = false;
    const proposals = asArray(project.proposals).map(asObject).map((item) => {
      if (!isExpirable(item)) return item;
      changed = true;
      return expireItem(item);
    });
    if (changed) {
      await upsertDocument(orgId, "projects", {
        id: projectId,
        data: { ...project, proposals },
        metadata: {
          ...asObject(asObject(projectDoc).metadata),
          kind: cleanText(asObject(asObject(projectDoc).metadata).kind) || "platform_project",
          proposal_portal_source: "proposals_api"
        }
      }, { replace: true });
    }
  }
  const proposalDocs = await listDocuments(orgId, PROPOSAL_COLLECTION).catch(() => []);
  for (const doc of proposalDocs) {
    const proposal = proposalDocumentView(doc);
    if (cleanText(proposal.project_id) !== projectId || !isExpirable(proposal)) continue;
    const next = expireItem(proposal);
    await upsertDocument(orgId, PROPOSAL_COLLECTION, {
      id: cleanText(proposal.id || doc.id),
      data: next,
      metadata: { ...asObject(doc.metadata), kind: "proposal", project_id: projectId, status: "expired" }
    }, { replace: true });
  }
}

export async function listProposalEvents(orgId: string, proposalIdValue: string) {
  await requireProposalFlag(orgId);
  const docs = await listDocuments(orgId, PROPOSAL_EVENT_COLLECTION);
  return docs
    .map((doc): JsonObject => ({ ...documentData(doc), id: cleanText(documentData(doc).id || doc.id), revision: Number(doc.revision || 0) }))
    .filter((event) => cleanText(event.proposal_id) === proposalIdValue)
    .sort((a, b) => cleanText(a.created_at).localeCompare(cleanText(b.created_at)));
}

export async function findPublicProposalSnapshot(publicToken: string) {
  const token = cleanText(publicToken);
  if (!token) throw notFound("proposal_snapshot_not_found", "Proposal snapshot was not found.");
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    const snapshots = await listDocuments(orgId, PROPOSAL_SNAPSHOT_COLLECTION).catch(() => []);
    for (const doc of snapshots) {
      const snapshot = snapshotDocumentView(doc);
      const delivery = asObject(snapshot.delivery);
      if (cleanText(delivery.public_token) === token || cleanText(doc.metadata && asObject(doc.metadata).public_token) === token) {
        return { orgId, snapshot };
      }
    }
  }
  throw notFound("proposal_snapshot_not_found", "Proposal snapshot was not found.");
}

export async function recordPublicProposalView(publicToken: string, input: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const delivery = deliveryState(snapshot.delivery);
  const alreadySigned = isSignedProposalLike(snapshot);
  const nextDelivery = {
    ...delivery,
    state: alreadySigned ? "signed" : "viewed",
    signed_at: alreadySigned ? cleanText(delivery.signed_at || snapshot.signed_at || snapshot.customer_signed_at) : delivery.signed_at,
    first_viewed_at: delivery.first_viewed_at || now,
    last_viewed_at: now
  };
  const nextStatus = alreadySigned ? "signed" : "viewed";
  const signedFields = alreadySigned ? proposalSignedCompatibilityFields(cleanText(nextDelivery.signed_at), asObject(snapshot.signatures)) : {};
  const nextSnapshot: JsonObject = {
    ...snapshot,
    status: nextStatus,
    delivery: nextDelivery,
    ...proposalViewedCompatibilityFields(nextDelivery),
    ...signedFields,
    updated_at: now
  };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken }
  }, { replace: true });
  const proposal = await readDocument(found.orgId, PROPOSAL_COLLECTION, cleanText(snapshot.proposal_id)).catch(() => null);
  if (proposal) {
    const proposalData = proposalDocumentView(proposal);
    const proposalDelivery = deliveryState(proposalData.delivery);
    const nextProposalStatus = alreadySigned || isSignedProposalLike(proposalData) ? "signed" : "viewed";
    await upsertDocument(found.orgId, PROPOSAL_COLLECTION, {
      id: cleanText(snapshot.proposal_id),
      data: {
        ...proposalData,
        status: nextProposalStatus,
        ...(Object.keys(asObject(nextSnapshot.customer_payment)).length ? {
          customer_payment: asObject(nextSnapshot.customer_payment),
          payment: {
            ...asObject(proposalData.payment),
            customer_payment: asObject(nextSnapshot.customer_payment)
          }
        } : {}),
        editable: nextProposalStatus === "signed"
          ? proposalContentWithSignedSlots(proposalContentDocument(proposalData, nextSnapshot), nextSnapshot)
          : proposalContentDocument(proposalData, nextSnapshot),
        ...proposalViewedCompatibilityFields(nextDelivery),
        ...(nextProposalStatus === "signed" ? signedFields : {}),
        delivery: {
          ...proposalDelivery,
          state: nextProposalStatus === "signed" ? "signed" : "viewed",
          ...(nextProposalStatus === "signed" ? { signed_at: cleanText(nextDelivery.signed_at || proposalDelivery.signed_at) } : {}),
          first_viewed_at: proposalDelivery.first_viewed_at || now,
          last_viewed_at: now
        }
      },
      metadata: { kind: "proposal", project_id: cleanText(proposalData.project_id), status: nextProposalStatus }
    }, { replace: true });
  }
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.viewed", {
    snapshot_id: cleanText(snapshot.id),
    public: true,
    metadata: asObject(input.metadata),
    session_id: cleanText(input.session_id)
  }, null);
  return { orgId: found.orgId, snapshot: nextSnapshot };
}

async function proposalPaymentSummary(orgId: string, snapshot: JsonObject) {
  const projectId = cleanText(snapshot.project_id);
  const proposalIdValue = cleanText(snapshot.proposal_id);
  const snapshotIdValue = cleanText(snapshot.id);
  const signature = proposalSignaturePage(snapshot);
  const taxCents = signature.showTax === false ? 0 : moneyCents(signature.taxAmount);
  const subtotalCents = proposalPricingSubtotalCents(snapshot);
  const totalCents = proposalTotalCents(snapshot);
  const expectedDepositCents = proposalDepositCents(snapshot);
  // A transient listing failure must not report the deposit as unpaid (an
  // empty list makes deposit_due_cents fall back to the full snapshot
  // deposit, resurrecting "Pay deposit" for money already collected
  // staff-side) — retry once before degrading.
  const obligations = projectId
    ? await listProjectObligations(orgId, projectId, { skipFlag: true })
      .catch(() => listProjectObligations(orgId, projectId, { skipFlag: true }))
      .catch(() => [])
    : [];
  const sourceObligations = obligations
    .filter((item) => cleanText(asObject(item.source).id) === proposalIdValue && cleanText(asObject(item.source).snapshot_id) === snapshotIdValue)
    .filter((item) => cleanText(item.direction) === "inbound");
  const deposit = sourceObligations.find((item) => /deposit/i.test(cleanText(item.label))) || sourceObligations[0] || {};
  const customerPayment = asObject(snapshot.customer_payment);
  const customerPaymentStatus = cleanText(customerPayment.status);
  const customerPaidCents = !sourceObligations.length && customerPaymentStatus.includes("paid")
    ? Math.max(0, Math.round(Number(customerPayment.amount_cents || customerPayment.deposit_paid_cents || customerPayment.deposit_amount_cents || 0)))
    : 0;
  const depositAmountCents = Math.max(expectedDepositCents, Math.round(Number(deposit.amount_cents || 0)));
  const paidCents = Math.max(0, Math.round(Number(deposit.allocated_cents || 0)), customerPaidCents);
  const openCents = Math.max(0, depositAmountCents - paidCents);
  const payments = projectId
    ? await listProjectPayments(orgId, projectId, { skipFlag: true })
      .catch(() => listProjectPayments(orgId, projectId, { skipFlag: true }))
      .catch(() => [])
    : [];
  return {
    currency: "USD",
    subtotal_cents: subtotalCents || Math.max(0, totalCents - taxCents),
    tax_cents: taxCents,
    total_cents: totalCents,
    deposit_amount_cents: depositAmountCents,
    deposit_due_cents: openCents,
    deposit_paid_cents: paidCents,
    status: customerPaymentStatus,
    payment_id: cleanText(customerPayment.payment_id),
    paid_at: cleanText(customerPayment.paid_at),
    amount_cents: Math.max(0, Math.round(Number(customerPayment.amount_cents || paidCents || 0))),
    remaining_cents: Math.max(0, totalCents - sourceObligations.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0)),
    obligation_id: cleanText(deposit.id),
    schedule_id: cleanText(deposit.schedule_id),
    obligations: sourceObligations.map((item) => ({
      id: cleanText(item.id),
      label: cleanText(item.label || "Payment"),
      amount_cents: Math.max(0, Math.round(Number(item.amount_cents || 0))),
      allocated_cents: Math.max(0, Math.round(Number(item.allocated_cents || 0))),
      balance_due_cents: Math.max(0, Math.round(Number(item.amount_cents || 0)) - Math.round(Number(item.allocated_cents || 0))),
      due_at: cleanText(item.due_at),
      due_rule: cleanText(item.due_rule),
      status: cleanText(item.status),
      invoice_id: cleanText(asObject(item.metadata).invoice_id)
    })),
    payments: payments
      .filter((payment) => cleanText(asObject(payment.metadata).proposal_id) === proposalIdValue || cleanText(payment.project_id) === projectId)
      .slice(0, 12)
  };
}

export async function publicProposalWorkflow(publicToken: string) {
  const found = await findPublicProposalSnapshot(publicToken);
  const workflow = {
    proposal: publicSharedProposalView(found.snapshot, publicToken),
    payment: await proposalPaymentSummary(found.orgId, found.snapshot)
  };
  return { orgId: found.orgId, snapshot: found.snapshot, workflow };
}

function findRawScopeItemContext(items: unknown, itemId: string, parent: JsonObject | null = null): { item: JsonObject; parent: JsonObject | null; items: JsonObject[] } | null {
  const needle = cleanText(itemId);
  if (!needle) return null;
  const list = asArray(items).filter((item) => item && typeof item === "object" && !Array.isArray(item)) as JsonObject[];
  for (const item of list) {
    if (cleanText(item.id) === needle) return { item, parent, items: list };
    const found = findRawScopeItemContext(item.children, needle, item);
    if (found) return found;
  }
  return null;
}

function selectionAllowsCustomer(selection: JsonObject = {}) {
  const selectableBy = asArray(selection.selectable_by || selection.selectableBy).map(cleanText);
  if (selection.customer_visible === true) return true;
  if (selection.customer_visible === false) return false;
  return selectableBy.includes("customer");
}

export async function recordPublicProposalChoiceSelection(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const snapshot = found.snapshot;
  if (isSignedProposalLike(snapshot)) throw conflict("proposal_already_signed", "Signed proposals cannot be changed.");
  const requestedGroupId = cleanText(input.group_id || input.groupId);
  const optionId = cleanText(input.option_id || input.optionId || input.scope_item_id || input.scopeItemId);
  if (!optionId) throw badRequest("choice_option_required", "A choice option is required.");
  const content = cloneJson(asObject(snapshot.content));
  const scope = asObject(content.scope);
  const roots = asArray(scope.root_items || scope.rootItems || scope.items);
  const context = findRawScopeItemContext(roots, optionId);
  if (!context) throw notFound("choice_option_not_found", "That proposal choice option was not found.");
  const optionSelection = asObject(context.item.selection);
  const groupId = cleanText(optionSelection.group_id || optionSelection.groupId);
  if (!groupId || cleanText(optionSelection.mode) !== "choice") throw badRequest("invalid_choice_option", "That item is not a selectable proposal option.");
  if (requestedGroupId && requestedGroupId !== groupId) throw badRequest("choice_group_mismatch", "That option does not belong to the requested choice group.");
  if (!selectionAllowsCustomer(optionSelection) && optionSelection.selected !== true) throw forbidden("choice_option_not_customer_selectable", "That option is not available for customer selection.");
  const now = nowIso();
  let groupCount = 0;
  context.items.forEach((item) => {
    const selection = asObject(item.selection);
    if (cleanText(selection.mode) !== "choice") return;
    if (cleanText(selection.group_id || selection.groupId) !== groupId) return;
    groupCount += 1;
    const selected = cleanText(item.id) === optionId;
    const selectableBy = new Set(asArray(selection.selectable_by || selection.selectableBy).map(cleanText).filter(Boolean));
    if (selected) {
      selectableBy.add("internal");
      selectableBy.add("customer");
    }
    item.selection = {
      ...selection,
      mode: "choice",
      group_id: groupId,
      group_behavior: cleanText(selection.group_behavior || selection.groupBehavior || "single") || "single",
      selected,
      default_selected: selected,
      selected_by: selected ? "customer" : cleanText(selection.selected_by || selection.selectedBy),
      selected_at: selected ? now : cleanText(selection.selected_at || selection.selectedAt),
      customer_visible: selected ? true : selection.customer_visible,
      selectable_by: Array.from(selectableBy)
    };
  });
  if (groupCount < 2) throw badRequest("choice_group_not_selectable", "That proposal choice group is not selectable.");
  const signatures = asObject(snapshot.signatures);
  const audit = workflowAuditEntry("proposal.choice.selected", input, metadata);
  const nextSnapshot = {
    ...snapshot,
    content,
    document_html: "",
    signatures: {
      ...signatures,
      audit_log: [...asArray(signatures.audit_log).map(asObject), audit]
    },
    updated_at: now
  };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken, status: cleanText(snapshot.status) }
  }, { replace: true });
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.choice.selected", {
    snapshot_id: cleanText(snapshot.id),
    group_id: groupId,
    option_id: optionId,
    public: true,
    audit
  }, null);
  return { orgId: found.orgId, snapshot: nextSnapshot };
}

export async function recordPublicProposalSignatureAdoption(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const signatures = asObject(snapshot.signatures);
  const rawSignature = asObject(input.signature);
  const signature = {
    id: `signature_adoption_${hashId(`${publicToken}:${now}:${cleanText(input.signer_name)}`)}`,
    type: cleanText(rawSignature.type || input.type || "typed") || "typed",
    text: cleanText(rawSignature.text || input.text || input.signer_name),
    signer_name: cleanText(input.signer_name || rawSignature.signer_name || rawSignature.text),
    style: cleanText(rawSignature.style || input.style || "signature"),
    image_data: signatureImageData(rawSignature),
    adopted_at: now,
    evidence: signatureEvidence(input, metadata, now)
  };
  const audit = workflowAuditEntry("proposal.esign.signature_adopted", input, metadata);
  const nextSignatures = {
    ...signatures,
    adopted_signature: signature,
    audit_log: [...asArray(signatures.audit_log).map(asObject), audit],
    updated_at: now
  };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: { ...snapshot, signatures: nextSignatures, updated_at: now },
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken }
  }, { replace: true });
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.esign.signature_adopted", {
    snapshot_id: cleanText(snapshot.id),
    public: true,
    signer_name: signature.signer_name,
    audit
  }, null);
  return { orgId: found.orgId, snapshot: { ...snapshot, signatures: nextSignatures, updated_at: now }, signature };
}

export async function recordPublicProposalSignatureSlot(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const signatures = asObject(snapshot.signatures);
  const slots = asObject(signatures.slots);
  const rawSignature = asObject(input.signature);
  const adopted = asObject(signatures.adopted_signature);
  const slotId = cleanText(input.slot_id || input.slotId)
    || `${cleanText(input.page_id || input.pageId || "signature")}:customer_signature`;
  const slot = {
    id: slotId,
    page_id: cleanText(input.page_id || input.pageId || slotId.split(":")[0]),
    page_index: Number.isFinite(Number(input.page_index ?? input.pageIndex)) ? Math.round(Number(input.page_index ?? input.pageIndex)) : 0,
    slot_key: cleanText(input.slot_key || input.slotKey || "customer_signature"),
    signer: "customer",
    role: "customer",
    signer_name: cleanText(input.signer_name || rawSignature.signer_name || adopted.signer_name || adopted.text),
    signature: Object.keys(rawSignature).length ? rawSignature : adopted,
    signed_at: now,
    evidence: signatureEvidence(input, metadata, now),
    audit: workflowAuditEntry("proposal.esign.slot_signed", input, metadata)
  };
  const nextSignatures = {
    ...signatures,
    slots: { ...slots, [slotId]: slot },
    audit_log: [...asArray(signatures.audit_log).map(asObject), slot.audit],
    updated_at: now
  };
  const nextSnapshot = { ...snapshot, signatures: nextSignatures, updated_at: now };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken }
  }, { replace: true });
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.esign.slot_signed", {
    snapshot_id: cleanText(snapshot.id),
    slot_id: slotId,
    public: true,
    signer_name: slot.signer_name,
    audit: slot.audit
  }, null);
  return { orgId: found.orgId, snapshot: nextSnapshot, slot };
}

async function finalizePublicProposalSignature(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const signatures = asObject(snapshot.signatures);
  const adopted = asObject(signatures.adopted_signature);
  const inputSignature = asObject(input.signature);
  const delivery = deliveryState(snapshot.delivery);
  const existingSlots = asObject(signatures.slots);
  const inputSlots = asArray(input.slots).map(asObject);
  const mergedSlots = { ...existingSlots };
  for (const item of inputSlots) {
    const slotId = cleanText(item.id || item.slot_id || item.slotId || `${cleanText(item.page_id || item.pageId || "signature")}:customer_signature`);
    if (!slotId) continue;
    const prior = asObject(mergedSlots[slotId]);
    const priorEvidence = asObject(prior.evidence);
    const priorAudit = asObject(prior.audit);
    mergedSlots[slotId] = {
      ...prior,
      ...item,
      id: slotId,
      signer: "customer",
      role: "customer",
      signed_at: cleanText(item.signed_at) || now,
      evidence: Object.keys(priorEvidence).length ? priorEvidence : signatureEvidence({ ...input, ...item }, metadata, now),
      audit: Object.keys(priorAudit).length ? priorAudit : workflowAuditEntry("proposal.esign.slot_signed", { ...input, ...item }, metadata)
    };
  }
  if (!Object.keys(mergedSlots).length) {
    const slotId = "signature:customer_signature";
    mergedSlots[slotId] = {
      id: slotId,
      page_id: "signature",
      slot_key: "customer_signature",
      signer: "customer",
      role: "customer",
      signer_name: cleanText(input.signer_name || inputSignature.signer_name || adopted.signer_name || adopted.text),
      signature: Object.keys(inputSignature).length ? inputSignature : adopted,
      signed_at: now,
      evidence: signatureEvidence(input, metadata, now),
      audit: workflowAuditEntry("proposal.esign.slot_signed", input, metadata)
    };
  }
  const signerName = cleanText(input.signer_name || inputSignature.signer_name || adopted.signer_name || adopted.text);
  const completionAudit = workflowAuditEntry("proposal.esign.completed", { ...input, signer_name: signerName }, metadata);
  const nextSignatures = {
    ...signatures,
    slots: mergedSlots,
    customer: {
      ...asObject(signatures.customer),
      ...(Object.keys(inputSignature).length ? inputSignature : adopted),
      signed_at: now,
      signer_name: signerName,
      slots: Object.values(mergedSlots),
      evidence: signatureEvidence({ ...input, signer_name: signerName }, metadata, now)
    },
    audit_log: [...asArray(signatures.audit_log).map(asObject), completionAudit],
    completed_at: now,
    updated_at: now
  };
  const nextDelivery = {
    ...delivery,
    state: "signed",
    signed_at: delivery.signed_at || now,
    first_viewed_at: delivery.first_viewed_at || now,
    last_viewed_at: now
  };
  let nextSnapshot: JsonObject = {
    ...snapshot,
    status: "signed",
    content: proposalContentWithScopeSnapshot(snapshot.content),
    signatures: nextSignatures,
    delivery: nextDelivery,
    ...proposalViewedCompatibilityFields(nextDelivery),
    ...proposalSignedCompatibilityFields(cleanText(nextDelivery.signed_at), nextSignatures),
    updated_at: now
  };
  const signedPdfRef = await storeSignedProposalPdf(found.orgId, nextSnapshot).catch(() => null);
  if (signedPdfRef) {
    nextSnapshot = {
      ...nextSnapshot,
      pdf: {
        ...asObject(nextSnapshot.pdf),
        signed_media_id: cleanText(signedPdfRef.media_id),
        signed_media_ref: signedPdfRef,
        signed_at: now
      }
    };
  }
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken, status: "signed" }
  }, { replace: true });
  const proposal = await readDocument(found.orgId, PROPOSAL_COLLECTION, cleanText(snapshot.proposal_id)).catch(() => null);
  if (proposal) {
    const proposalData = proposalDocumentView(proposal);
    await upsertDocument(found.orgId, PROPOSAL_COLLECTION, {
      id: cleanText(snapshot.proposal_id),
      data: {
        ...proposalData,
        status: "signed",
        pdf: {
          ...asObject(proposalData.pdf),
          ...(signedPdfRef ? {
            signed_media_id: cleanText(signedPdfRef.media_id),
            signed_media_ref: signedPdfRef,
            signed_at: now
          } : {})
        },
        editable: proposalContentWithSignedSlots(proposalContentDocument(proposalData, nextSnapshot), nextSnapshot),
        ...proposalViewedCompatibilityFields(nextDelivery),
        ...proposalSignedCompatibilityFields(cleanText(nextDelivery.signed_at || now), nextSignatures),
        delivery: {
          ...deliveryState(proposalData.delivery),
          state: "signed",
          signed_at: cleanText(nextDelivery.signed_at || now),
          current_snapshot_id: cleanText(snapshot.id)
        }
      },
      metadata: { kind: "proposal", project_id: cleanText(proposalData.project_id), status: "signed" }
    }, { replace: true });
  }
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await expireSiblingProposalOptions(found.orgId, nextSnapshot).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.signed", {
    snapshot_id: cleanText(snapshot.id),
    public: true,
    signer_name: signerName,
    audit: completionAudit
  }, null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.esign.completed", {
    snapshot_id: cleanText(snapshot.id),
    public: true,
    signer_name: signerName,
    audit: completionAudit
  }, null);
  // Production scopes are instantiated by the pipeline template's
  // `scopes.activateFromProposal.v1` binding when the `proposal.signed` work
  // event (emitted by recordProposalEvent above) completes the signature node.
  // Receivables are created by the default organization automation rule
  // (payments.ensureReceivables.v1 on proposal.signed).
  return { orgId: found.orgId, snapshot: nextSnapshot };
}

export async function completePublicProposalESign(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  return finalizePublicProposalSignature(publicToken, input, metadata);
}

export async function recordPublicProposalSignature(publicToken: string, input: JsonObject = {}) {
  return finalizePublicProposalSignature(publicToken, input, {});
}

export async function recordPublicProposalPayLater(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const audit = workflowAuditEntry("proposal.payment.pay_later", input, metadata);
  const signatures = asObject(snapshot.signatures);
  const signedAt = cleanText(deliveryState(snapshot.delivery).signed_at || snapshot.signed_at || snapshot.customer_signed_at);
  const nextSnapshot: JsonObject = {
    ...snapshot,
    ...(isSignedProposalLike(snapshot) ? {
      status: "signed",
      ...proposalSignedCompatibilityFields(signedAt, signatures)
    } : {}),
    customer_payment: {
      ...asObject(snapshot.customer_payment),
      status: "pay_later",
      pay_later_at: now,
      audit
    },
    signatures: {
      ...signatures,
      audit_log: [...asArray(signatures.audit_log).map(asObject), audit]
    },
    updated_at: now
  };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken, status: cleanText(snapshot.status) }
  }, { replace: true });
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.payment.pay_later", {
    snapshot_id: cleanText(snapshot.id),
    public: true,
    audit
  }, null);
  return { orgId: found.orgId, snapshot: nextSnapshot };
}

export async function recordPublicProposalMockDepositPayment(publicToken: string, input: JsonObject = {}, metadata: JsonObject = {}) {
  const found = await findPublicProposalSnapshot(publicToken);
  const snapshot = found.snapshot;
  const delivery = deliveryState(snapshot.delivery);
  const isSigned = cleanText(snapshot.status) === "signed" || cleanText(delivery.state) === "signed";
  if (isSigned) {
    await ensureReceivablesForSignedProposal(found.orgId, cleanText(snapshot.proposal_id), cleanText(snapshot.id), {
      signed_at: cleanText(delivery.signed_at) || nowIso(),
      source: "proposal_public_mock_payment"
    }).catch((error) => {
      if (error?.code === "app_flag_disabled") return null;
      throw error;
    });
  }
  const summary = await proposalPaymentSummary(found.orgId, snapshot);
  const requestedObligationId = cleanText(input.obligation_id);
  const summaryObligations = asArray(summary.obligations).map(asObject);
  const targetObligation = requestedObligationId
    ? summaryObligations.find((item) => cleanText(item.id) === requestedObligationId)
    : summaryObligations.find((item) => cleanText(item.id) === cleanText(summary.obligation_id));
  if (requestedObligationId && !targetObligation) throw badRequest("payment_obligation_not_found", "That payment is not available for this proposal.");
  const targetBalance = targetObligation
    ? Math.max(0, Math.round(Number(targetObligation.balance_due_cents || 0)))
    : Math.max(0, Math.round(Number(summary.deposit_due_cents || summary.deposit_amount_cents || 0)));
  const amount = Math.max(0, Math.round(Number(input.amount_cents || targetBalance)));
  if (amount <= 0) throw badRequest("payment_not_due", "There is no open balance for this payment.");
  const paymentLabel = cleanText(targetObligation?.label || "Deposit");
  const isDepositPayment = !targetObligation || /deposit/i.test(paymentLabel);
  const ctx = {
    orgId: found.orgId,
    branchId: cleanText(snapshot.branch_id || "default") || "default",
    userId: "customer_portal",
    identityId: "customer_portal",
    membership: {},
    permissions: []
  } as unknown as PlatformAuthContext;
  const paymentKind = isDepositPayment ? "customer_deposit" : /final|completion/i.test(paymentLabel) ? "customer_final" : "customer_progress";
  const paymentMetadata = {
    public_token: publicToken,
    proposal_id: cleanText(snapshot.proposal_id),
    snapshot_id: cleanText(snapshot.id),
    obligation_id: cleanText(targetObligation?.id),
    payment_label: paymentLabel,
    source: "customer_portal"
  };
  const contactRef = asObject(asArray(asObject(snapshot.contact_snapshot).contacts)[0] || asArray(snapshot.contacts)[0]);
  // Provider charge path: when the portal submitted a tokenized payment
  // method (or a saved one) AND the org resolves a payment provider, charge
  // through the adapter and let the shared intake flow write the transaction
  // with provider fee fields. Otherwise the legacy mock-record behavior below
  // is untouched.
  const providerToken = cleanText(input.payment_method_id);
  const savedMethodId = cleanText(input.saved_payment_method_id);
  let paymentResult: { payment: JsonObject; allocations: JsonObject[] } | null = null;
  let providerCharged = false;
  const { getPaymentProvider } = await import("../payments/providers/index.js");
  const provider = providerToken || savedMethodId ? await getPaymentProvider(found.orgId).catch(() => null) : null;
  if (provider) {
    const { recordProviderChargedPayment, findSavedMethod } = await import("../payments/intake.js");
    // Legacy fake saved-method ids (test_card_on_file) never resolve; keep
    // the mock record path for those instead of failing the payment.
    const savedResolvable = !savedMethodId || providerToken || !!(await findSavedMethod(found.orgId, savedMethodId));
    if (savedResolvable) {
      const charged = await recordProviderChargedPayment(found.orgId, provider, {
        amount_cents: amount,
        payment_method_id: providerToken,
        saved_method_id: providerToken ? "" : savedMethodId,
        method: cleanText(input.payment_method || input.method),
        project_id: cleanText(snapshot.project_id),
        branch_id: cleanText(snapshot.branch_id || "default") || "default",
        save_payment_method: input.save_payment_method === true,
        contact_ref: contactRef,
        payment: {
          kind: paymentKind,
          currency: "USD",
          metadata: { ...paymentMetadata, provider: provider.provider },
          allocation_mode: isDepositPayment ? "customer_portal_deposit" : "customer_portal_invoice",
          obligation_id: cleanText(targetObligation?.id)
        }
      }, ctx);
      paymentResult = { payment: asObject(charged.payment), allocations: asArray(charged.allocations).map(asObject) };
      providerCharged = true;
    }
  }
  if (!paymentResult) {
    paymentResult = await createPayment(found.orgId, {
      direction: "inbound",
      kind: paymentKind,
      status: "settled",
      amount_cents: amount,
      currency: "USD",
      project_id: cleanText(snapshot.project_id),
      contact_ref: contactRef,
      method: {
        type: "mock_customer_portal",
        label: "Customer Portal Mock Payment"
      },
      metadata: { ...paymentMetadata, mock: true },
      allocation_mode: isDepositPayment ? "customer_portal_deposit" : "customer_portal_invoice",
      obligation_id: cleanText(targetObligation?.id)
    }, ctx);
  }
  const now = nowIso();
  const audit = workflowAuditEntry("proposal.payment.mock_succeeded", input, metadata);
  const signedAt = cleanText(delivery.signed_at || snapshot.signed_at || snapshot.customer_signed_at);
  const nextDelivery = isSigned ? { ...delivery, state: "signed", signed_at: signedAt || now } : delivery;
  const nextSnapshot: JsonObject = {
    ...snapshot,
    status: isSigned ? "signed" : cleanText(snapshot.status),
    delivery: nextDelivery,
    customer_payment: {
      status: isDepositPayment ? "deposit_paid" : "payment_paid",
      payment_id: cleanText(paymentResult.payment.id),
      obligation_id: cleanText(targetObligation?.id),
      label: paymentLabel,
      amount_cents: Math.max(0, Math.round(Number(paymentResult.payment.amount_cents || amount))),
      paid_at: now,
      mock: !providerCharged,
      ...(providerCharged ? { provider: cleanText(paymentResult.payment.provider) } : {}),
      audit
    },
    ...proposalViewedCompatibilityFields(nextDelivery),
    ...(isSigned ? proposalSignedCompatibilityFields(signedAt || now, asObject(snapshot.signatures)) : {}),
    updated_at: now
  };
  await upsertDocument(found.orgId, PROPOSAL_SNAPSHOT_COLLECTION, {
    id: cleanText(snapshot.id),
    data: nextSnapshot,
    metadata: { kind: "proposal_snapshot", proposal_id: cleanText(snapshot.proposal_id), public_token: publicToken, status: cleanText(nextSnapshot.status) }
  }, { replace: true });
  const proposal = await readDocument(found.orgId, PROPOSAL_COLLECTION, cleanText(snapshot.proposal_id)).catch(() => null);
  if (proposal) {
    const proposalData = proposalDocumentView(proposal);
    const deliveryData = deliveryState(proposalData.delivery);
    const canonicalSignedAt = cleanText(deliveryData.signed_at || signedAt);
    await upsertDocument(found.orgId, PROPOSAL_COLLECTION, {
      id: cleanText(snapshot.proposal_id),
      data: {
        ...proposalData,
        status: isSigned ? "signed" : cleanText(proposalData.status),
        pdf: {
          ...asObject(proposalData.pdf),
          signed_media_id: cleanText(asObject(nextSnapshot.pdf).signed_media_id || asObject(asObject(nextSnapshot.pdf).signed_media_ref).media_id || asObject(proposalData.pdf).signed_media_id),
          signed_media_ref: Object.keys(asObject(asObject(nextSnapshot.pdf).signed_media_ref)).length
            ? asObject(asObject(nextSnapshot.pdf).signed_media_ref)
            : asObject(asObject(proposalData.pdf).signed_media_ref),
          signed_at: cleanText(asObject(nextSnapshot.pdf).signed_at || asObject(proposalData.pdf).signed_at)
        },
        editable: proposalContentWithSignedSlots(proposalContentDocument(proposalData, nextSnapshot), nextSnapshot),
        customer_payment: asObject(nextSnapshot.customer_payment),
        payment: {
          ...asObject(proposalData.payment),
          customer_payment: asObject(nextSnapshot.customer_payment)
        },
        ...proposalViewedCompatibilityFields(isSigned ? { ...deliveryData, state: "signed", signed_at: canonicalSignedAt } : deliveryData),
        ...(isSigned ? proposalSignedCompatibilityFields(canonicalSignedAt, asObject(nextSnapshot.signatures)) : {}),
        delivery: {
          ...deliveryData,
          ...(isSigned ? { state: "signed", signed_at: canonicalSignedAt } : {}),
          current_snapshot_id: cleanText(snapshot.id)
        }
      },
      metadata: { kind: "proposal", project_id: cleanText(proposalData.project_id), status: isSigned ? "signed" : cleanText(proposalData.status) }
    }, { replace: true });
  }
  await patchProjectSharedProposal(found.orgId, nextSnapshot, publicToken).catch(() => null);
  await recordProposalEvent(found.orgId, cleanText(snapshot.proposal_id), "proposal.payment.mock_succeeded", {
    snapshot_id: cleanText(snapshot.id),
    payment_id: cleanText(paymentResult.payment.id),
    amount_cents: amount,
    public: true,
    audit
  }, null);
  return { orgId: found.orgId, snapshot: nextSnapshot, payment: paymentResult.payment, allocations: paymentResult.allocations };
}

export async function recordProposalEvent(orgId: string, proposalIdValue: string, type: string, payload: JsonObject = {}, ctx?: PlatformAuthContext | null) {
  const now = nowIso();
  const id = eventId(proposalIdValue, type);
  const data = {
    schema_version: PROPOSAL_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    proposal_id: proposalIdValue,
    type,
    actor_user_id: ctx?.userId || cleanText(payload.actor_user_id),
    payload,
    created_at: now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PROPOSAL_EVENT_COLLECTION, {
    id,
    data,
    metadata: {
      kind: "proposal_event",
      proposal_id: proposalIdValue,
      type
    }
  }, { replace: true });
  {
    const proposalDoc = await readDocument(orgId, PROPOSAL_COLLECTION, proposalIdValue).catch(() => null);
    const proposal = proposalDoc ? documentData(proposalDoc) : {};
    const projectId = cleanText(payload.project_id || proposal.project_id);
    if (projectId) {
      // `proposal.signed` drives the pipeline transition: it completes the
      // pipeline template's signature node, whose binding instantiates the
      // signed production scopes.
      await emitWorkEvent({
        organization_id: orgId,
        branch_id: cleanText(proposal.branch_id || "default"),
        project_id: projectId,
        type,
        idempotency_key: `${type}:${proposalIdValue}:${cleanText(payload.snapshot_id || data.id)}`,
        payload: { proposal_id: proposalIdValue, ...payload },
        context: { actor_user_id: ctx?.userId || cleanText(payload.actor_user_id) }
      });
    }
  }
  return { ...documentData(doc), id: cleanText(doc.id) };
}
