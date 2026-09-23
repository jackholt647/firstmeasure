import { companyDocumentLanguage } from "../platform/localization/documents.js";
import { serverLanguage } from "../platform/localization/server.js";
import { resolveContext, type LanguageSnapshot } from "../platform/localization/core.js";
import { randomUUID } from "node:crypto";

import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readBranchModule,
  readDocument,
  readGlobal,
  readMediaFile,
  readMediaMetadata,
  readOrganization,
  storeMediaUpload,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { listProjectObligations, listProjectPayments } from "../payments/storage.js";
import { normalizeScheduleRows, resolveScheduleItems } from "../payments/schedule_terms.js";
import { moneyCents, scopeItemPriceResult, scopeItemSelected } from "../proposals/scope.js";
import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import { sendProjectSms } from "../comms/service.js";
import { DOCUMENT_SCHEMA_VERSION, DOCUMENT_SNAPSHOT_SCHEMA_VERSION, FMDocModel, type DocumentStatus } from "./schemas.js";
import {
  documentInstanceId,
  listDocumentSnapshots,
  listProjectDocuments,
  readDocumentInstance,
  readDocumentSnapshot,
  readDocumentTemplate,
  readDocumentTemplateVersion,
  readDocumentThemeVersion,
  recordDocumentEvent,
  saveDocumentInstance,
  saveDocumentSnapshot,
  findPublicDocumentSnapshot,
  listDocumentTemplates,
  readDocumentWorkflow,
  readDocumentWorkflowVersion,
  readDocumentFolderItem
} from "./storage.js";
import { documentType, type DocumentTypeDefinition } from "./types/registry.js";
import { registerBuiltinDocumentWidgetResolvers, publicDocumentPortalUrl } from "./widgets/builtins.js";
import {
  resolveDocumentWidgetData,
  documentWidgetResolver,
  type DocumentWidgetServices,
  type WidgetResolveContext
} from "./widgets/registry.js";
import {
  collectSourceIds,
  resolveDocumentSource,
  rewriteSourceStrings,
  sourceIdFromString,
  DOCUMENT_SOURCES_PARAM_KEY
} from "./sources/registry.js";
import { registerBuiltinDocumentSources } from "./sources/builtins.js";
import { buildRenderHarnessHtml } from "./render.js";
import { renderDocumentFallbackPdf, renderDocumentPdf } from "./pdf.js";
import { ensureDefaultDocumentAssets } from "./seeds.js";
import { documentRequirementsStatus, documentSignatureRequirement, normalizeCustomerDocumentPresentation } from "./presentation.js";
import {
  DOCUMENT_CAPABILITIES,
  documentCapabilityEnabled,
  documentCapabilityState,
  documentOutputCapability,
  filterDocumentDefinitionByCapabilities,
  filterOutputDefinitionsByCapabilities,
  filterParamDefinitionsByCapabilities,
  publicDocumentCapabilityState,
  filterWorkflowByCapabilities,
  requireDocumentTypeEnabled
} from "./capability_policy.js";

registerBuiltinDocumentWidgetResolvers();
registerBuiltinDocumentSources();

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function compactObject(value: JsonObject) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === null || entry === undefined || entry === "") return false;
    if (Array.isArray(entry)) return entry.length > 0;
    if (typeof entry === "object") return Object.keys(asObject(entry)).length > 0;
    return true;
  }));
}

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  needs_review: 0,
  issued: 1,
  sent: 2,
  viewed: 3,
  signed: 4,
  completed: 5,
  declined: 9,
  expired: 9,
  void: 9
};

function advanceStatus(current: unknown, next: DocumentStatus): DocumentStatus {
  const currentStatus = cleanText(current) || "draft";
  if (["declined", "expired", "void"].includes(currentStatus)) return currentStatus as DocumentStatus;
  const currentRank = STATUS_RANK[currentStatus] ?? 0;
  const nextRank = STATUS_RANK[next] ?? 0;
  return nextRank >= currentRank ? next : (currentStatus as DocumentStatus);
}

function isLockedSigned(documentValue: JsonObject) {
  return ["signed", "completed"].includes(cleanText(documentValue.status));
}

/** Keep the project-list projection small but sufficient for conditional app tabs. */
async function syncProjectSignatureRequirements(orgId: string, projectId: string) {
  const cleanedProjectId = cleanText(projectId);
  if (!cleanedProjectId) return null;
  const capabilityState = await documentCapabilityState(orgId);
  const documents = (await listProjectDocuments(orgId, cleanedProjectId).catch(() => []))
    .map((document): JsonObject => ({
      ...document,
      output_defs: filterOutputDefinitionsByCapabilities(asObject(document.output_defs), capabilityState)
    }));
  const actionable = documents.filter((document) => {
    const status = cleanText(document.status);
    if (["draft", "declined", "expired", "void", "signed", "completed"].includes(status)) return false;
    return Number(documentSignatureRequirement(document).pending_count || 0) > 0;
  });
  const projectDoc = await readDocument(orgId, "projects", cleanedProjectId).catch(() => null);
  if (!projectDoc) return null;
  const projectData = asObject(projectDoc.data);
  const projection = {
    required: actionable.length > 0,
    pending_count: actionable.reduce((sum, document) => sum + Number(documentSignatureRequirement(document).pending_count || 0), 0),
    document_count: actionable.length,
    document_ids: actionable.map((document) => cleanText(document.id)).filter(Boolean),
    updated_at: nowIso()
  };
  // Payment-aware companion projection: includes signed-but-unpaid documents,
  // which the signature badge intentionally drops once signing is done.
  const outstanding = documents
    .map((document) => ({ document, status: documentRequirementsStatus(document) }))
    .filter(({ document, status }) => {
      const docStatus = cleanText(document.status);
      if (["draft", "needs_review", "void", "declined", "expired"].includes(docStatus)) return false;
      return Number(status.pending_count || 0) > 0;
    });
  const workProjection = {
    document_count: outstanding.length,
    document_ids: outstanding.map(({ document }) => cleanText(document.id)).filter(Boolean),
    pending_customer_signatures: outstanding.reduce((sum, { status }) => sum + Number(status.pending_customer_signatures || 0), 0),
    pending_company_signatures: outstanding.reduce((sum, { status }) => sum + Number(status.pending_company_signatures || 0), 0),
    pending_payments: outstanding.reduce((sum, { status }) => sum + Number(status.pending_payments || 0), 0),
    waiting_on: [...new Set(outstanding.flatMap(({ status }) => (Array.isArray(status.waiting_on) ? status.waiting_on : [])))],
    updated_at: nowIso()
  };
  await upsertDocument(orgId, "projects", {
    id: cleanedProjectId,
    data: { ...projectData, signature_requirements: projection, work_requirements: workProjection },
    metadata: { ...asObject(projectDoc.metadata), source: "document_signature_projection" }
  }, { replace: true });
  return projection;
}

function deliveryState(value: unknown) {
  const delivery = asObject(value);
  return {
    ...delivery,
    public_token: cleanText(delivery.public_token),
    sent_at: cleanText(delivery.sent_at),
    first_viewed_at: cleanText(delivery.first_viewed_at),
    last_viewed_at: cleanText(delivery.last_viewed_at),
    current_snapshot_id: cleanText(delivery.current_snapshot_id),
    send_count: Math.max(0, Math.round(Number(delivery.send_count || 0) || 0)),
    recipients: asArray(delivery.recipients).map(asObject)
  };
}

/**
 * Checkout variables for the pricing scope (spec 10.4). Callers pass
 * options.checkout = { payment_method, processing_fee_percent }; defaults are
 * { payment_method: null, processing_fee_percent: 3 } so card-fee formulas
 * always have a percent to work with.
 */
function normalizedCheckout(value: unknown): JsonObject {
  const checkout = asObject(value);
  const method = cleanText(checkout.payment_method || checkout.method).toLowerCase();
  const feeRaw = Number(checkout.processing_fee_percent);
  return {
    ...checkout,
    payment_method: method || null,
    processing_fee_percent: Number.isFinite(feeRaw) && checkout.processing_fee_percent !== null && cleanText(checkout.processing_fee_percent) !== "" ? feeRaw : 3
  };
}

/**
 * The `doc` pricing-scope entity: identity plus delivery timing so
 * expressions like days_since(doc.sent_at) and expiry hints resolve.
 */
function documentDocScope(documentValue: JsonObject): JsonObject {
  const delivery = deliveryState(documentValue.delivery);
  const metadata = asObject(documentValue.metadata);
  return {
    id: cleanText(documentValue.id),
    status: cleanText(documentValue.status),
    title: cleanText(documentValue.title),
    document_type: cleanText(documentValue.document_type),
    sent_at: delivery.sent_at,
    first_viewed_at: delivery.first_viewed_at,
    last_viewed_at: delivery.last_viewed_at,
    signed_at: cleanText((delivery as JsonObject).signed_at),
    // Expiry hints: instance metadata wins over anything the delivery carries.
    expires_at: cleanText(metadata.expires_at || asObject(documentValue.delivery).expires_at),
    valid_days: Number(metadata.valid_days || 0) || null
  };
}

// ---------------------------------------------------------------------------
// Widget services + scope data
// ---------------------------------------------------------------------------

function widgetServices(): DocumentWidgetServices {
  return {
    pricebook: {},
    payments: {
      listProjectObligations: async (orgId, projectId) => await listProjectObligations(orgId, projectId, { skipFlag: true }),
      listProjectPayments: async (orgId, projectId) => await listProjectPayments(orgId, projectId, { skipFlag: true })
    },
    media: {
      readMediaMetadata: async (orgId, mediaId) => await readMediaMetadata(orgId, mediaId),
      fileUrl: (orgId, mediaId, variant = "original") => (
        `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(variant)}`
      ),
      readMediaFile: async (orgId, mediaId, variant = "original") => {
        const file = await readMediaFile(orgId, mediaId, variant);
        return { contentType: cleanText(file.contentType), bytes: file.bytes };
      }
    },
    platform: {
      readDocument: async (orgId, collection, documentId) => await readDocument(orgId, collection, documentId),
      listDocuments: async (orgId, collection) => await listDocuments(orgId, collection)
    }
  };
}

/**
 * Org branding for theme token resolution, mirroring how proposals read
 * presentation settings: organization manifest branding, layered with branch
 * branding and the branch `presentation_style` module.
 */
export async function organizationBranding(orgId: string, branchId = "default") {
  const org = await readOrganization(orgId).catch(() => ({} as JsonObject));
  // The org manifest rarely carries branding — real orgs store it on the
  // global document (data.branding), the same base layer invoices read.
  // Missing this layer made every theme fall back to the stock blue.
  const globalDoc = await readGlobal(orgId).catch(() => ({} as JsonObject));
  const globalBranding = asObject(asObject(asObject(globalDoc).data).branding);
  let branding: JsonObject = { ...globalBranding, colors: { ...asObject(globalBranding.colors) } };
  const orgBranding = asObject(asObject(org).branding);
  if (Object.keys(orgBranding).length) {
    branding = { ...branding, ...orgBranding, colors: { ...asObject(branding.colors), ...asObject(orgBranding.colors) } };
  }
  const branch = await readDocument(orgId, "branch", branchId || "default").catch(() => null);
  const branchBranding = asObject(asObject(asObject(branch).data).branding);
  if (Object.keys(branchBranding).length) {
    branding = { ...branding, ...branchBranding, colors: { ...asObject(branding.colors), ...asObject(branchBranding.colors) } };
  }
  const style = await readBranchModule(orgId, branchId || "default", "presentation_style").catch(() => null);
  const styleBranding = asObject(asObject(asObject(style).data).branding);
  if (Object.keys(styleBranding).length) {
    branding = { ...branding, ...styleBranding, colors: { ...asObject(branding.colors), ...asObject(styleBranding.colors) } };
  }
  return branding;
}

async function documentScopeEntities(orgId: string, documentValue: JsonObject, params: JsonObject) {
  const projectId = cleanText(documentValue.project_id);
  const projectDoc = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  const project: JsonObject = projectDoc ? { id: projectId, ...asObject(projectDoc.data) } : asObject(params.project);
  const paramCustomer = asObject(params.customer);
  const customer = Object.keys(paramCustomer).length
    ? paramCustomer
    : asObject(asArray(project.contacts).map(asObject).find((contact) => contact.primary === true) || asArray(project.contacts).map(asObject)[0]);
  const org = await readOrganization(orgId).catch(() => ({} as JsonObject));
  const orgRecord = asObject(org);
  // Real orgs keep branding (and the logo URL) on the global document, not
  // the manifest — layer both, manifest values winning where present.
  const globalDoc = await readGlobal(orgId).catch(() => ({} as JsonObject));
  const globalData = asObject(asObject(globalDoc).data);
  const globalBranding = asObject(globalData.branding);
  const manifestBranding = asObject(orgRecord.branding);
  const branding = {
    ...globalBranding,
    ...manifestBranding,
    colors: { ...asObject(globalBranding.colors), ...asObject(manifestBranding.colors) }
  };
  return {
    project,
    customer,
    org: {
      id: orgId,
      name: cleanText(orgRecord.name || globalData.company_name),
      branding,
      // Raw logo candidates carried through so resolveDocumentInstance can
      // produce org.logo_url (invoices read the same fields).
      logo_media_id: cleanText(orgRecord.logo_media_id || orgRecord.logoMediaId),
      logo_url: cleanText(orgRecord.logo_url || orgRecord.logoUrl || globalBranding.logo_node_url || globalBranding.logo),
      logo: orgRecord.logo ?? globalBranding.logo ?? null
    }
  };
}

// ---------------------------------------------------------------------------
// Theme font stacks — mirror of FMDocRenderer.fontStackFor. Theme font vars
// that hold bare family names ("Montserrat") are expanded to full fallback
// stacks so every render surface (portal, editor, PDF harness) degrades to the
// same system equivalents instead of the browser default.
// ---------------------------------------------------------------------------

const GENERIC_SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const GENERIC_SERIF = 'Georgia, "Times New Roman", Times, serif';

const FONT_STACKS: Record<string, string> = {
  montserrat: `"Montserrat", "Trebuchet MS", ${GENERIC_SANS}`,
  inter: `"Inter", "Segoe UI", ${GENERIC_SANS}`,
  roboto: `"Roboto", "Segoe UI", ${GENERIC_SANS}`,
  "open sans": `"Open Sans", "Segoe UI", ${GENERIC_SANS}`,
  lato: `"Lato", "Segoe UI", ${GENERIC_SANS}`,
  poppins: '"Poppins", "Century Gothic", "Segoe UI", Arial, sans-serif',
  "source sans 3": `"Source Sans 3", "Source Sans Pro", "Segoe UI", ${GENERIC_SANS}`,
  georgia: GENERIC_SERIF,
  serif: GENERIC_SERIF,
  "sans-serif": GENERIC_SANS
};

function expandFontStack(value: string) {
  const raw = cleanText(value);
  if (!raw || raw.includes(",") || raw.includes("var(")) return raw; // already a stack / token ref
  const bare = raw.replace(/^["']|["']$/g, "").trim();
  const stack = FONT_STACKS[bare.toLowerCase()];
  if (stack) return stack;
  if (/serif/i.test(bare) && !/sans/i.test(bare)) return `"${bare}", ${GENERIC_SERIF}`;
  return `"${bare}", ${GENERIC_SANS}`;
}

function expandThemeFontVars(vars: Record<string, string>) {
  const out: Record<string, string> = { ...vars };
  for (const name of Object.keys(out)) {
    if (name.startsWith("--fm-font-") || name === "--fm-body-font" || name === "--fm-display-font") {
      out[name] = expandFontStack(out[name] ?? "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Org logo + media URL resolution for resolved documents. Interactive renders
// get platform media file URLs (the editor/portal session can fetch them);
// static/PDF renders inline small images as data URIs, matching the
// widgets/builtins.ts behavior for doc.photo.
// ---------------------------------------------------------------------------

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

function platformMediaFileUrl(orgId: string, mediaId: string, variant = "original") {
  return `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(variant)}`;
}

async function mediaFileDataUri(orgId: string, mediaId: string, variant = "original") {
  try {
    const file = await readMediaFile(orgId, mediaId, variant);
    if (!file.bytes.length || file.bytes.length > MAX_INLINE_IMAGE_BYTES) return "";
    const contentType = cleanText(file.contentType);
    if (!contentType.startsWith("image/")) return "";
    return `data:${contentType};base64,${file.bytes.toString("base64")}`;
  } catch {
    return "";
  }
}

function logoMediaIdFrom(value: unknown) {
  if (typeof value === "string") return "";
  const source = asObject(value);
  return cleanText(source.media_id || source.mediaId || source.logo_media_id || source.logoMediaId);
}

function logoUrlFrom(value: unknown) {
  if (typeof value === "string") return cleanText(value);
  const source = asObject(value);
  return cleanText(source.src || source.url || source.original || source.file_url || source.fileUrl || source.logo_url || source.logoUrl);
}

/**
 * Resolve the org's logo to a URL usable by the document renderer, walking the
 * same candidate chain as proposals/invoices (layered branding first, then the
 * organization record). Static targets return a data URI so the Playwright
 * harness and frozen snapshots never depend on authenticated media routes.
 */
export async function organizationLogoUrl(orgId: string, branding: JsonObject, orgEntity: JsonObject, staticTarget: boolean) {
  const candidates: unknown[] = [
    { media_id: branding.logo_media_id || branding.logoMediaId },
    asObject(branding.logo_media || branding.logoMedia),
    // The canonical logo media slot (replaceSlot upload id) beats raw logo
    // strings: legacy branding often stores measure-internal relative paths
    // ("organizations/<org>/logo.png") that no renderer can load.
    { media_id: `organization_${orgId}_logo` },
    branding.logo,
    branding.logo_url,
    branding.logoUrl,
    branding.logo_node_url,
    branding.companyLogo,
    branding.brandLogo,
    { media_id: orgEntity.logo_media_id },
    orgEntity.logo,
    orgEntity.logo_url
  ];
  for (const candidate of candidates) {
    const mediaId = logoMediaIdFrom(candidate);
    if (mediaId) {
      if (staticTarget) {
        const dataUri = await mediaFileDataUri(orgId, mediaId);
        if (dataUri) return dataUri;
        continue;
      }
      // Interactive: only emit slot URLs whose media actually exists so a
      // missing slot falls through to the next candidate.
      const exists = await readMediaMetadata(orgId, mediaId).then(() => true).catch(() => false);
      if (exists) return platformMediaFileUrl(orgId, mediaId);
      continue;
    }
    const url = logoUrlFrom(candidate);
    if (!url) continue;
    if (/^data:image\//i.test(url)) return url;
    // Legacy measure-internal keys ("organizations/<org>/logo.png"): map to
    // the static route the portal uses; unreadable for PDF inlining, skip.
    if (!/^(https?:)?\//i.test(url)) {
      if (staticTarget) continue;
      return `/storage/measure/internal/${url.replace(/^\/+/, "")}`;
    }
    if (staticTarget) {
      // Platform media URLs can be re-read locally and inlined; anything the
      // harness cannot fetch without a session is skipped.
      const mediaMatch = url.match(/\/media\/([^/?]+)\//i);
      if (mediaMatch?.[1]) {
        const dataUri = await mediaFileDataUri(orgId, decodeURIComponent(mediaMatch[1]));
        if (dataUri) return dataUri;
      }
      if (/^https?:\/\//i.test(url)) return url;
      continue;
    }
    return url;
  }
  return "";
}

/**
 * Post-binding pass over resolved image nodes: {media_id, variant} refs from
 * the media picker get a concrete url (data URI for static/PDF renders) so
 * FMDocRenderer.resolveMediaUrl always has something loadable.
 */
async function attachImageMediaUrls(orgId: string, definition: JsonObject, staticTarget: boolean) {
  const attachRef = async (ref: JsonObject) => {
    const mediaId = cleanText(ref.media_id || ref.mediaId || ref.id);
    if (mediaId && !cleanText(ref.url)) {
      const variant = cleanText(ref.variant) || "original";
      const dataUri = staticTarget ? await mediaFileDataUri(orgId, mediaId, variant) : "";
      ref.url = dataUri || platformMediaFileUrl(orgId, mediaId, variant);
    }
  };
  const visit = async (nodeValue: unknown): Promise<void> => {
    if (!nodeValue || typeof nodeValue !== "object" || Array.isArray(nodeValue)) return;
    const node = nodeValue as JsonObject;
    if (cleanText(node.type) === "image" && node.props && typeof node.props === "object" && !Array.isArray(node.props)) {
      const props = node.props as JsonObject;
      const media = props.media;
      if (media && typeof media === "object" && !Array.isArray(media)) {
        await attachRef(media as JsonObject);
      }
    }
    // Image fills (contracts §10): ANY node may carry style.fill =
    // { type: "image", media: { media_id } } — resolve the url exactly like an
    // image node's props.media so the renderer always has something loadable.
    if (node.style && typeof node.style === "object" && !Array.isArray(node.style)) {
      const fill = (node.style as JsonObject).fill;
      if (fill && typeof fill === "object" && !Array.isArray(fill) && cleanText((fill as JsonObject).type) === "image") {
        const fillMedia = (fill as JsonObject).media;
        if (fillMedia && typeof fillMedia === "object" && !Array.isArray(fillMedia)) {
          await attachRef(fillMedia as JsonObject);
        }
      }
    }
    for (const child of asArray(node.children)) await visit(child);
  };
  for (const page of asArray(definition.pages)) {
    for (const child of asArray(asObject(page).children)) await visit(child);
  }
  return definition;
}

function typeDefinitionFor(documentTypeId: string): DocumentTypeDefinition {
  return documentType(documentTypeId) || {
    id: cleanText(documentTypeId).toLowerCase() || "generic",
    label: cleanText(documentTypeId) || "Document",
    icon: "fa-file-lines",
    param_schema: {},
    output_schema: {}
  };
}

// ---------------------------------------------------------------------------
// Param resolution (contract §3): explicit values → {{...}} interpolation
// against { project, customer, org } → template defaults → paramDefaultValue.
// ---------------------------------------------------------------------------

export function resolveDocumentParams(paramDefs: JsonObject, explicit: JsonObject, scope: JsonObject) {
  const params: JsonObject = {};
  const interpolationScope = {
    project: asObject(scope.project),
    customer: asObject(scope.customer),
    org: asObject(scope.org)
  };
  const resolveValue = (value: unknown): unknown => {
    if (typeof value === "string" && FMDocModel.hasInterpolation(value)) {
      return FMDocModel.interpolate(value, interpolationScope);
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === "object") {
      const out: JsonObject = {};
      for (const [key, entry] of Object.entries(value as JsonObject)) out[key] = resolveValue(entry);
      return out;
    }
    return value;
  };
  for (const [key, defValue] of Object.entries(paramDefs)) {
    const def = asObject(defValue);
    const provided = explicit[key];
    if (provided !== undefined && provided !== null && provided !== "") {
      params[key] = resolveValue(provided);
      continue;
    }
    const fallback = FMDocModel.paramDefaultValue(def);
    params[key] = typeof fallback === "string" && FMDocModel.hasInterpolation(fallback)
      ? resolveValue(fallback)
      : fallback;
  }
  // Preserve extra caller-supplied params that the schema does not declare.
  for (const [key, value] of Object.entries(explicit)) {
    if (!(key in params)) params[key] = resolveValue(value);
  }
  return params;
}

// ---------------------------------------------------------------------------
// Instance lifecycle
// ---------------------------------------------------------------------------

async function resolveTemplateForCreate(orgId: string, input: JsonObject, typeDef: DocumentTypeDefinition) {
  if (input.template_id === null || (typeof input.template_id === "string" && cleanText(input.template_id) === "")) {
    return { template: null, version: 0 };
  }
  const explicitTemplateId = cleanText(input.template_id);
  if (explicitTemplateId) {
    const template = await readDocumentTemplate(orgId, explicitTemplateId);
    const version = Number(input.template_version || template.current_version || 0);
    return { template, version };
  }
  const candidates = await listDocumentTemplates(orgId, { document_type: typeDef.id });
  const active = candidates.filter((template) => cleanText(template.status) === "active" && Number(template.current_version || 0) > 0);
  const preferred = active.find((template) => asObject(template.metadata).default_for_type === true)
    || active.find((template) => asObject(template.metadata).default === true)
    || active.find((template) => (typeDef.seeded_templates || []).includes(cleanText(template.id)))
    || active[0]
    || null;
  if (!preferred) return { template: null, version: 0 };
  return { template: preferred, version: Number(preferred.current_version || 0) };
}

/**
 * Workflow selection for a new instance: explicit workflow_id → the template's
 * metadata.default_workflow_id → the type's default_workflow_id. Passing
 * workflow_id: null opts out entirely. Instances pin the workflow version at
 * creation exactly like template_ref, so published workflow updates never
 * change in-flight documents.
 */
async function resolveWorkflowForCreate(orgId: string, input: JsonObject, template: JsonObject | null, typeDef: DocumentTypeDefinition) {
  if (Object.prototype.hasOwnProperty.call(input, "workflow_id") && (input.workflow_id === null || cleanText(input.workflow_id) === "")) {
    return { workflow_ref: null, workflow_state: null };
  }
  if (asObject(asObject(template).metadata).disable_default_workflow === true) {
    return { workflow_ref: null, workflow_state: null };
  }
  const workflowId = cleanText(input.workflow_id)
    || cleanText(asObject(asObject(template).metadata).default_workflow_id)
    || cleanText(typeDef.default_workflow_id);
  if (!workflowId) return { workflow_ref: null, workflow_state: null };
  const workflow = await readDocumentWorkflow(orgId, workflowId).catch(() => null);
  const version = Number(asObject(workflow).current_version || 0);
  if (!workflow || !version) return { workflow_ref: null, workflow_state: null };
  const workflowVersion = await readDocumentWorkflowVersion(orgId, workflowId, version).catch(() => null);
  const steps = asArray(asObject(asObject(workflowVersion).definition).steps).map(asObject);
  return {
    workflow_ref: { workflow_id: workflowId, version },
    workflow_state: { current_step: cleanText(asObject(steps[0]).id), completed_steps: [] as string[] }
  };
}

export async function createDocumentInstance(orgId: string, projectId: string, input: JsonObject, ctx: PlatformAuthContext, options: { createOnly?: boolean } = {}) {
  await ensureDefaultDocumentAssets(orgId).catch(() => null);
  const capabilityState = await documentCapabilityState(orgId);
  const typeDef = typeDefinitionFor(cleanText(input.document_type));
  requireDocumentTypeEnabled(capabilityState, typeDef.id);
  const { template, version } = await resolveTemplateForCreate(orgId, input, typeDef);
  const templateVersion = template && version ? await readDocumentTemplateVersion(orgId, cleanText(template.id), version) : null;
  const definition = filterDocumentDefinitionByCapabilities(asObject(asObject(templateVersion).definition), capabilityState);
  const paramDefs = filterParamDefinitionsByCapabilities({ ...typeDef.param_schema, ...asObject(definition.params) }, capabilityState);
  const outputDefs = filterOutputDefinitionsByCapabilities({ ...typeDef.output_schema, ...asObject(definition.outputs) }, capabilityState);
  const id = documentInstanceId(input);
  const now = nowIso();
  const projectData = projectId ? asObject(asObject(await readDocument(orgId, "projects", projectId).catch(() => null)).data) : {};
  const scaffold: JsonObject = { project_id: projectId };
  const entities = await documentScopeEntities(orgId, scaffold, asObject(input.params));
  const params = resolveDocumentParams(paramDefs, asObject(input.params), entities);
  const missing = FMDocModel.missingRequiredParams(Object.fromEntries(Object.entries(paramDefs).filter(([, definition]) => asObject(definition).disabled !== true)), params);
  const workflow = await resolveWorkflowForCreate(orgId, input, template, typeDef);
  const templateMetadata = asObject(asObject(template).metadata);
  const inputMetadata = asObject(input.metadata);
  const customerPresentation = normalizeCustomerDocumentPresentation(
    {
      ...asObject(templateMetadata.customer_presentation),
      ...asObject(inputMetadata.customer_presentation)
    },
    typeDef.id
  );
  const data: JsonObject = {
    schema_version: DOCUMENT_SCHEMA_VERSION,
    id,
    organization_id: orgId,
    branch_id: cleanText(projectData.branch_id || ctx.branchId || "default") || "default",
    project_id: projectId,
    document_type: typeDef.id,
    title: cleanText(input.title || asObject(template).name || projectData.title || typeDef.label) || typeDef.label,
    template_ref: template ? { template_id: cleanText(template.id), version } : null,
    theme_ref: Object.keys(asObject(input.theme_ref)).length
      ? asObject(input.theme_ref)
      : (cleanText(asObject(definition.theme_ref).theme_id) ? asObject(definition.theme_ref) : (typeDef.default_theme_id ? { theme_id: typeDef.default_theme_id } : null)),
    theme_overrides: asObject(input.theme_overrides),
    contact_ids: asArray(input.contact_ids).map(cleanText).filter(Boolean),
    params,
    param_defs: paramDefs,
    output_defs: outputDefs,
    workflow_ref: workflow.workflow_ref,
    workflow_state: workflow.workflow_state,
    overrides: [],
    outputs: {},
    status: "draft" as DocumentStatus,
    delivery: {},
    pdf: {},
    source: "generated",
    metadata: {
      ...inputMetadata,
      customer_presentation: customerPresentation
    },
    created_by_user_id: ctx.userId,
    updated_by_user_id: ctx.userId,
    created_at: now,
    updated_at: now
  };
  const document = await saveDocumentInstance(orgId, id, data, options);
  await recordDocumentEvent(orgId, document, "document.created", { project_id: projectId }, ctx, { emit: false });
  await syncProjectSignatureRequirements(orgId, projectId).catch(() => null);
  return { document, missing_params: missing };
}

/**
 * Draft re-template (rail card variant flows): resolve patch.template_ref /
 * patch.workflow_ref against published assets and return the field updates to
 * merge into the instance. Rules:
 *   - drafts only (anything issued/sent/signed conflicts);
 *   - the target template/workflow must exist with a published version
 *     (version defaults to current);
 *   - the new template definition's params/outputs MERGE into the instance's
 *     param_defs/output_defs (template wins over stale defs); existing param
 *     VALUES are untouched;
 *   - workflow_state resets current_step to the new workflow's first step and
 *     prunes completed_steps to steps that still exist.
 */
async function resolveRetemplatePatch(orgId: string, current: JsonObject, patch: JsonObject): Promise<JsonObject> {
  const wantsTemplate = Object.prototype.hasOwnProperty.call(patch, "template_ref");
  const wantsWorkflow = Object.prototype.hasOwnProperty.call(patch, "workflow_ref");
  if (!wantsTemplate && !wantsWorkflow) return {};
  const status = cleanText(current.status) || "draft";
  if (status !== "draft") {
    throw conflict("document_not_draft", "Only draft documents can switch templates or workflows.");
  }
  const updates: JsonObject = {};
  if (wantsTemplate) {
    const ref = asObject(patch.template_ref);
    const templateId = cleanText(ref.template_id);
    if (!templateId) throw badRequest("document_template_ref_invalid", "template_ref.template_id is required.");
    const template = await readDocumentTemplate(orgId, templateId); // 404s when missing
    const version = Number(ref.version || 0) || Number(template.current_version || 0);
    const templateVersion = version
      ? await readDocumentTemplateVersion(orgId, templateId, version).catch(() => null)
      : null;
    if (!templateVersion) {
      throw badRequest("document_template_version_not_found", `Template '${templateId}' has no published version${Number(ref.version || 0) ? ` ${ref.version}` : ""}.`);
    }
    const definition = asObject(asObject(templateVersion).definition);
    const typeDef = typeDefinitionFor(cleanText(current.document_type));
    updates.template_ref = { template_id: templateId, version: Number(asObject(templateVersion).version || version) };
    updates.param_defs = { ...typeDef.param_schema, ...asObject(current.param_defs), ...asObject(definition.params) };
    updates.output_defs = { ...typeDef.output_schema, ...asObject(current.output_defs), ...asObject(definition.outputs) };
    // Applying a template to an existing draft must also apply defaults for
    // params the draft does not already carry. This is especially important
    // for payment_schedule: the definition alone renders an empty widget.
    const explicitParams = { ...asObject(current.params), ...asObject(patch.params) };
    const entities = await documentScopeEntities(orgId, current, explicitParams);
    updates.params = resolveDocumentParams(asObject(updates.param_defs), explicitParams, entities);
  }
  if (wantsWorkflow) {
    const ref = asObject(patch.workflow_ref);
    const workflowId = cleanText(ref.workflow_id);
    if (!workflowId) throw badRequest("document_workflow_ref_invalid", "workflow_ref.workflow_id is required.");
    const workflow = await readDocumentWorkflow(orgId, workflowId); // 404s when missing
    const version = Number(ref.version || 0) || Number(workflow.current_version || 0);
    const workflowVersion = version
      ? await readDocumentWorkflowVersion(orgId, workflowId, version).catch(() => null)
      : null;
    if (!workflowVersion) {
      throw badRequest("document_workflow_version_not_found", `Workflow '${workflowId}' has no published version${Number(ref.version || 0) ? ` ${ref.version}` : ""}.`);
    }
    const steps = asArray(asObject(asObject(workflowVersion).definition).steps).map(asObject);
    const stepIds = steps.map((step) => cleanText(step.id)).filter(Boolean);
    const previous = normalizedWorkflowState(current);
    updates.workflow_ref = { workflow_id: workflowId, version: Number(asObject(workflowVersion).version || version) };
    updates.workflow_state = {
      current_step: stepIds[0] || "",
      completed_steps: previous.completed_steps.filter((id) => stepIds.includes(id))
    };
  }
  return updates;
}

export async function patchDocumentInstance(orgId: string, documentId: string, patch: JsonObject, ctx: PlatformAuthContext) {
  const current = await readDocumentInstance(orgId, documentId);
  const expectedRevision = Number(patch.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) {
    throw conflict("document_revision_conflict", "Document revision does not match.");
  }
  const statusPatch = cleanText(patch.status);
  const contentKeys = ["params", "overrides", "title", "theme_ref", "theme_overrides", "contact_ids"];
  const editsContent = contentKeys.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (editsContent && isLockedSigned(current)) {
    throw conflict("document_locked_signed", "Signed documents cannot be edited. Amend with a change order instead.");
  }
  if (cleanText(asObject(current.module_ref).execution_id) && ["params", "overrides", "template_ref", "workflow_ref", "theme_ref", "theme_overrides"].some(key => Object.prototype.hasOwnProperty.call(patch, key))) {
    throw conflict("document_module_owned", "Update the module inputs, evaluate, and explicitly attach the new result to this draft.");
  }
  const retemplate = await resolveRetemplatePatch(orgId, current, patch);
  // Attach a standalone document to a project (doc-first flows). One-way:
  // documents already scoped to a project never move between projects here.
  const attach: JsonObject = {};
  const attachProjectId = cleanText(patch.project_id);
  if (attachProjectId && attachProjectId !== cleanText(current.project_id)) {
    if (cleanText(current.project_id)) {
      throw conflict("document_already_attached", "This document already belongs to a project.");
    }
    const projectData = asObject(asObject(await readDocument(orgId, "projects", attachProjectId)).data);
    attach.project_id = attachProjectId;
    attach.branch_id = cleanText(projectData.branch_id || current.branch_id || "default") || "default";
  }
  const data: JsonObject = {
    ...current,
    ...attach,
    title: Object.prototype.hasOwnProperty.call(patch, "title") ? cleanText(patch.title) || cleanText(current.title) : current.title,
    params: Object.prototype.hasOwnProperty.call(patch, "params") ? { ...asObject(current.params), ...asObject(patch.params) } : current.params,
    overrides: Object.prototype.hasOwnProperty.call(patch, "overrides") ? asArray(patch.overrides).map(asObject) : current.overrides,
    theme_ref: Object.prototype.hasOwnProperty.call(patch, "theme_ref") ? (patch.theme_ref === null ? null : asObject(patch.theme_ref)) : current.theme_ref,
    theme_overrides: Object.prototype.hasOwnProperty.call(patch, "theme_overrides") ? asObject(patch.theme_overrides) : current.theme_overrides,
    contact_ids: Object.prototype.hasOwnProperty.call(patch, "contact_ids") ? asArray(patch.contact_ids).map(cleanText).filter(Boolean) : current.contact_ids,
    metadata: { ...asObject(current.metadata), ...asObject(patch.metadata) },
    ...retemplate,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  };
  if (statusPatch && ["declined", "expired"].includes(statusPatch)) {
    data.status = statusPatch;
  }
  let document = await saveDocumentInstance(orgId, documentId, data, { expectedRevision: expectedRevision || undefined });
  if (statusPatch === "declined") await recordDocumentEvent(orgId, document, "document.declined", {}, ctx);
  // Voiding always goes through the full cancellation path (token revocation
  // + cancellation record + event) — never a bare status flip.
  if (statusPatch === "void") document = await voidDocumentInstance(orgId, documentId, ctx, asObject(patch.cancellation));
  await syncProjectSignatureRequirements(orgId, cleanText(document.project_id)).catch(() => null);
  return document;
}

/** Revoke every live public token minted for this document's snapshots so
 *  old links stop resolving. The original token is kept for audit. */
async function revokeDocumentSnapshotTokens(orgId: string, documentId: string) {
  const snapshots = await listDocumentSnapshots(orgId, documentId).catch(() => []);
  for (const snapshot of snapshots) {
    const token = cleanText(snapshot.public_token);
    if (!token) continue;
    await saveDocumentSnapshot(orgId, cleanText(snapshot.id), {
      ...snapshot,
      public_token: "",
      revoked_public_token: token,
      updated_at: nowIso()
    }).catch(() => null);
  }
}

export async function voidDocumentInstance(
  orgId: string,
  documentId: string,
  ctx: PlatformAuthContext,
  input: JsonObject = {}
) {
  const current = await readDocumentInstance(orgId, documentId);
  const metadataDefaults = asObject(asObject(current.metadata).cancellation_defaults);
  const visibility = cleanText(input.customer_visibility)
    || cleanText(metadataDefaults.customer_visibility)
    || "visible";
  const document = await saveDocumentInstance(orgId, documentId, {
    ...current,
    status: "void",
    delivery: { ...deliveryState(current.delivery), public_token: "" },
    cancellation: compactObject({
      canceled_at: nowIso(),
      canceled_by_user_id: ctx.userId,
      reason: cleanText(input.reason),
      customer_visibility: visibility === "hidden" ? "hidden" : "visible"
    }),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  });
  await revokeDocumentSnapshotTokens(orgId, documentId);
  await recordDocumentEvent(orgId, document, "document.voided", {
    reason: cleanText(input.reason),
    customer_visibility: visibility === "hidden" ? "hidden" : "visible"
  }, ctx);
  await syncProjectSignatureRequirements(orgId, cleanText(document.project_id)).catch(() => null);
  return document;
}

/**
 * Field-level edits for UPLOADED documents only: paper uploads may reshape
 * their own field contract (free-form uploads start with none), so param/
 * output DEFINITIONS are editable here — generated documents never allow that.
 */
export async function updateUploadedDocumentFields(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const current = await readDocumentInstance(orgId, documentId);
  if (cleanText(current.source) !== "uploaded") {
    throw badRequest("document_not_uploaded", "Only uploaded documents can edit their field definitions.");
  }
  const document = await saveDocumentInstance(orgId, documentId, {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(input, "title") && cleanText(input.title) ? { title: cleanText(input.title) } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "param_defs") ? { param_defs: asObject(input.param_defs) } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "output_defs") ? { output_defs: asObject(input.output_defs) } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "params") ? { params: { ...asObject(current.params), ...asObject(input.params) } } : {}),
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  });
  return document;
}

/**
 * Human review sign-off for a paper upload. Applies any final field edits,
 * then re-records the confirmed outputs THROUGH recordDocumentOutput so the
 * standard machinery runs: document.signed fires, receivables mint, scope
 * triggers complete — identical to a signature captured on any other surface.
 * An unsigned upload advances to `issued` (a live document that can still be
 * sent for signature later).
 */
export async function confirmUploadedDocument(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const current = await readDocumentInstance(orgId, documentId);
  if (cleanText(current.source) !== "uploaded") {
    throw badRequest("document_not_uploaded", "Only uploaded documents can be confirmed from review.");
  }
  if (["void", "declined", "expired"].includes(cleanText(current.status))) {
    throw conflict("document_not_active", "This document is no longer active.");
  }
  let document = await updateUploadedDocumentFields(orgId, documentId, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.param_defs !== undefined ? { param_defs: input.param_defs } : {}),
    ...(input.output_defs !== undefined ? { output_defs: input.output_defs } : {}),
    ...(input.params !== undefined ? { params: input.params } : {})
  }, ctx);

  // Reviewer verdicts: explicit null removes a mis-detected output (e.g. the
  // agent thought it was signed and the reviewer says it is not).
  const supplied = asObject(input.outputs);
  const removals = Object.entries(supplied).filter(([, value]) => value === null).map(([key]) => key);
  if (removals.length) {
    const outputs = { ...asObject(document.outputs) };
    for (const key of removals) delete outputs[key];
    document = await saveDocumentInstance(orgId, documentId, { ...document, outputs, updated_at: nowIso() });
  }

  // Re-record every confirmed output through the standard path.
  const outputDefs = asObject(document.output_defs);
  const stored = asObject(document.outputs);
  const keys = [...new Set([...Object.keys(stored), ...Object.keys(supplied)])]
    .filter((key) => !removals.includes(key) && Object.keys(asObject(outputDefs[key])).length);
  for (const key of keys) {
    const value = supplied[key] !== undefined ? supplied[key] : stored[key];
    if (!FMDocModel.outputValueSatisfies(asObject(outputDefs[key]), value)) continue;
    const result = await recordDocumentOutput(orgId, documentId, key, {
      value,
      evidence: { capture_mode: "imported", method: "uploaded_scan", witnessed_by_user_id: ctx.userId }
    }, {}, ctx, { surface: "internal" });
    document = result.document;
  }

  if (cleanText(document.status) === "needs_review") {
    document = await saveDocumentInstance(orgId, documentId, {
      ...document,
      status: "issued",
      updated_by_user_id: ctx.userId,
      updated_at: nowIso()
    });
  }
  document = await saveDocumentInstance(orgId, documentId, {
    ...document,
    metadata: {
      ...asObject(document.metadata),
      upload_review: { confirmed_at: nowIso(), confirmed_by_user_id: ctx.userId }
    },
    updated_at: nowIso()
  });
  await recordDocumentEvent(orgId, document, "document.upload.confirmed", {
    output_keys: keys,
    removed_output_keys: removals
  }, ctx);
  await syncProjectSignatureRequirements(orgId, cleanText(document.project_id)).catch(() => null);
  return document;
}

export async function issueDocument(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const current = await readDocumentInstance(orgId, documentId);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(current.revision || 0)) {
    throw conflict("document_revision_conflict", "Document revision does not match.");
  }
  const paramDefs = asObject(current.param_defs);
  const entities = await documentScopeEntities(orgId, current, asObject(current.params));
  const params = resolveDocumentParams(paramDefs, { ...asObject(current.params), ...asObject(input.params) }, entities);
  const missing = FMDocModel.missingRequiredParams(Object.fromEntries(Object.entries(paramDefs).filter(([, definition]) => asObject(definition).disabled !== true)), params);
  const canIssue = missing.length === 0;
  const document = await saveDocumentInstance(orgId, documentId, {
    ...current,
    params,
    status: canIssue ? advanceStatus(current.status, "issued") : current.status,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  });
  if (canIssue) await recordDocumentEvent(orgId, document, "document.issued", {}, ctx);
  await syncProjectSignatureRequirements(orgId, cleanText(document.project_id)).catch(() => null);
  return { document, missing_params: missing };
}

/**
 * Entry point for the `documents.issue.v1` work automation. Creates the
 * instance, runs param resolution, and (params permitting) issues it and
 * optionally creates the portal snapshot. Idempotent per the automation's
 * idempotency key so event redelivery never duplicates documents.
 */
export async function issueDocumentFromAutomation(orgId: string, input: {
  document_type?: string;
  template_id?: string;
  workflow_id?: string | null;
  project_id: string;
  params?: JsonObject;
  deliver?: "portal" | "email" | "none";
  title?: string;
  assign_fill_to?: string;
  customer_presentation?: JsonObject;
  source?: JsonObject;
}) {
  const source = asObject(input.source);
  const idempotencyKey = cleanText(source.idempotency_key);
  const projectId = cleanText(input.project_id);
  if (idempotencyKey) {
    const existing = (await listProjectDocuments(orgId, projectId)).find((item) => (
      cleanText(asObject(asObject(item.metadata).source).idempotency_key) === idempotencyKey
    ));
    if (existing) return { document: existing, missing_params: [], duplicate: true };
  }
  const systemCtx = {
    orgId,
    branchId: "default",
    userId: "system_automation",
    identityId: "system_automation",
    permissions: {},
    role: "system"
  } as unknown as PlatformAuthContext;
  let documentTypeId = cleanText(input.document_type);
  if (!documentTypeId && cleanText(input.template_id)) {
    const template = await readDocumentTemplate(orgId, cleanText(input.template_id)).catch(() => null);
    documentTypeId = cleanText(asObject(template).document_type) || "generic";
  }
  const created = await createDocumentInstance(orgId, projectId, {
    document_type: documentTypeId || "generic",
    template_id: cleanText(input.template_id) || undefined,
    ...(Object.prototype.hasOwnProperty.call(input, "workflow_id") ? { workflow_id: input.workflow_id } : {}),
    title: cleanText(input.title) || undefined,
    params: asObject(input.params),
    metadata: {
      source,
      ...(Object.keys(asObject(input.customer_presentation)).length ? { customer_presentation: asObject(input.customer_presentation) } : {}),
      ...(cleanText(input.assign_fill_to) ? { assign_fill_to: cleanText(input.assign_fill_to) } : {})
    }
  }, systemCtx);
  const issued = await issueDocument(orgId, cleanText(created.document.id), {}, systemCtx);
  if (issued.missing_params.length || cleanText(input.deliver || "none") === "none") {
    return { document: issued.document, missing_params: issued.missing_params };
  }
  // "portal" and "email" both create the public snapshot; email delivery is
  // the caller's concern (Postmark path) — the engine produces the artifact.
  const sent = await sendDocument(orgId, cleanText(created.document.id), {
    include_pdf: cleanText(input.deliver) === "email",
    include_portal: true
  }, systemCtx);
  return { document: sent.document, snapshot: sent.snapshot, missing_params: [] };
}

// ---------------------------------------------------------------------------
// Resolution — overrides → bindings → widget data → theme
// ---------------------------------------------------------------------------

async function resolveInstanceTheme(orgId: string, documentValue: JsonObject) {
  const typeDef = typeDefinitionFor(cleanText(documentValue.document_type));
  const themeRef = asObject(documentValue.theme_ref);
  const themeId = cleanText(themeRef.theme_id) || cleanText(typeDef.default_theme_id) || "thm_margin";
  const version = Number(themeRef.version || 0) || undefined;
  const themeVersion = await readDocumentThemeVersion(orgId, themeId, version).catch(() => null);
  const theme = asObject(asObject(themeVersion).definition);
  return {
    theme,
    theme_ref: { theme_id: themeId, version: Number(asObject(themeVersion).version || 0) || null }
  };
}

/** The pinned workflow definition for a document instance (null when none). */
async function workflowDefinitionForDocument(orgId: string, documentValue: JsonObject): Promise<JsonObject | null> {
  const ref = asObject(documentValue.workflow_ref);
  const workflowId = cleanText(ref.workflow_id);
  if (!workflowId) return null;
  // Drafts follow the workflow's CURRENT published version (same rule as
  // templates) so seeded workflow upgrades reach unsent documents; anything
  // sent/signed keeps its pinned version.
  const pinned = Number(ref.version || 0) || undefined;
  const isDraft = cleanText(documentValue.status) === "draft" || !cleanText(documentValue.status);
  const version = isDraft ? undefined : pinned;
  const workflowVersion = await readDocumentWorkflowVersion(orgId, workflowId, version).catch(() => null);
  const definition = asObject(asObject(workflowVersion).definition);
  return Object.keys(definition).length ? definition : null;
}

/**
 * Scope/line item lists arrive in proposal shape (unit_price in dollars, no
 * amounts). Repeater components and doc.computed totals bind against cents
 * fields, so resolution enriches each row with unit_price_cents/amount_cents
 * using the exact pricing math the doc.line_items widget uses
 * (proposals/scope.ts). Enrichment is resolution-time only — never persisted —
 * and additive, so the legacy widget resolver keeps working on the same rows.
 */
function enrichScopeRow(row: unknown): JsonObject | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const item = asObject(row);
  const price = scopeItemPriceResult(item);
  let amountCents = price.amount_cents;
  // Discount rows carry an explicit (often NEGATIVE) amount_cents that the
  // proposal pricing math ignores (it only honors positive dollar amounts).
  // When the standard math yields 0 and the row declares a nonzero explicit
  // amount, the explicit amount wins so negative line items survive.
  if (!amountCents && scopeItemSelected(item)) {
    const explicit = Number(item.amount_cents);
    if (Number.isFinite(explicit) && Math.round(explicit) !== 0) amountCents = Math.round(explicit);
  }
  return {
    ...item,
    selected: scopeItemSelected(item),
    unit_price_cents: moneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice),
    amount_cents: amountCents
  };
}

// ---------------------------------------------------------------------------
// Conditional pricing (spec 10.4). Rows may carry, same framework as any
// other line item field:
//   condition   - expression string evaluated against the pricing scope
//                 (params/checkout/doc/now/org/project/customer/outputs);
//                 falsy -> the row is EXCLUDED (0 cents, dropped from the
//                 flat projection).
//   expires_at  - ISO timestamp; condition sugar for AND now < expires_at
//                 (unparseable values never expire).
//   pricing     - { formula } expression whose result is CENTS (rounded, may
//                 be negative); when present it overrides amount_cents.
//   badge       - short label carried through for rendering ("Expires 6/1").
//   discount    - true flags the row for distinct (negative) styling.
//
// Evaluation ORDER (two passes):
//   1. BASE pass - every non-conditional row (no condition/expires_at/
//      formula) prices normally; the top-level sum of those base amounts
//      becomes rows_subtotal_cents.
//   2. FORMULA pass - formula rows evaluate with the pricing scope extended
//      by rows_subtotal_cents (also aliased as computed.subtotal_cents), so
//      percent-style formulas ("round(rows_subtotal_cents * 3 / 100)")
//      always reference the base subtotal, never each other. Conditional
//      non-formula rows (fixed discounts) also resolve here, outside the
//      base sum.
// The EFFECTIVE amount is written onto each enriched tree row (0 when the
// condition fails) so the seeded computed expressions -
// sum(params.scope_items[].amount_cents) - stay correct without seed changes.
// ---------------------------------------------------------------------------

type PricedRowNode = {
  raw: JsonObject;
  item: JsonObject;
  condition: string;
  expires_at: string;
  formula: string;
  conditional: boolean;
  included: boolean;
  depth: number;
  children: PricedRowNode[];
};

function rowExpired(expiresAt: string) {
  const cleaned = cleanText(expiresAt);
  if (!cleaned) return false;
  const at = Date.parse(cleaned);
  return Number.isFinite(at) ? Date.now() >= at : false;
}

function conditionTruthy(expr: string, scope: JsonObject) {
  const value = FMDocModel.evaluateSafe(expr, scope, false);
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

function buildPricedRows(rows: unknown[], scope: JsonObject, depth = 0): PricedRowNode[] {
  const out: PricedRowNode[] = [];
  for (const rowValue of rows) {
    if (!rowValue || typeof rowValue !== "object" || Array.isArray(rowValue)) continue;
    const raw = rowValue as JsonObject;
    const item = enrichScopeRow(raw);
    if (!item) continue;
    const condition = cleanText(raw.condition);
    const expiresAt = cleanText(raw.expires_at);
    const formula = cleanText(asObject(raw.pricing).formula);
    const conditional = Boolean(condition || expiresAt || formula);
    let included = condition ? conditionTruthy(condition, scope) : true;
    if (included && rowExpired(expiresAt)) included = false;
    out.push({
      raw,
      item,
      condition,
      expires_at: expiresAt,
      formula,
      conditional,
      included,
      depth,
      children: buildPricedRows(asArray(raw.children), scope, depth + 1)
    });
  }
  return out;
}

/** Own (non-child) cents for a row, honoring explicit negative amounts. */
function pricedOwnCents(node: PricedRowNode): number {
  const price = scopeItemPriceResult(node.raw);
  let own = price.own_amount_cents;
  if (!own && !node.children.length && node.item.selected !== false) {
    const explicit = Number(node.raw.amount_cents);
    if (Number.isFinite(explicit) && Math.round(explicit) !== 0) own = Math.round(explicit);
  }
  return own;
}

/** Pass 1: rolled-up cents for a subtree, formula rows deferred as 0. */
function basePricedCents(node: PricedRowNode): number {
  if (!node.included || node.item.selected === false) return 0;
  if (node.formula) return 0;
  return pricedOwnCents(node) + node.children.reduce((sum, child) => sum + basePricedCents(child), 0);
}

/**
 * Pass 2: write the EFFECTIVE amount onto every enriched row. Formula rows
 * evaluate against the pricing scope + rows_subtotal_cents; excluded rows
 * become 0 so tree sums (computed subtotal/tax/total) stay correct.
 */
function finalizePricedCents(node: PricedRowNode, scope: JsonObject, rowsSubtotalCents: number): number {
  const childrenTotal = node.children.reduce((sum, child) => sum + finalizePricedCents(child, scope, rowsSubtotalCents), 0);
  let own = 0;
  if (node.formula) {
    const formulaScope: JsonObject = {
      ...scope,
      rows_subtotal_cents: rowsSubtotalCents,
      computed: { ...asObject(scope.computed), subtotal_cents: rowsSubtotalCents },
      row: node.item
    };
    own = Math.round(Number(FMDocModel.evaluateSafe(node.formula, formulaScope, 0)) || 0);
  } else {
    own = pricedOwnCents(node);
  }
  let total = own + childrenTotal;
  if (!node.included || node.item.selected === false) total = 0;
  node.item.amount_cents = total;
  if (node.conditional) node.item.condition_met = node.included;
  node.item.children = node.children.map((child) => child.item);
  return total;
}

function collectPricedProjection(nodes: PricedRowNode[]) {
  const flat: JsonObject[] = [];
  const conditional: JsonObject[] = [];
  // Conditional inventory covers EVERY condition-bearing row (even under an
  // excluded parent) so interactive surfaces can re-evaluate client-side with
  // the same expressions when checkout variables change (frozen but reactive).
  const inventory = (node: PricedRowNode) => {
    if (node.conditional) {
      conditional.push({ ...node.item, children: undefined, depth: node.depth, included: node.included });
    }
    node.children.forEach(inventory);
  };
  // Flat projection mirrors the legacy flattening: parents keep the rolled-up
  // amount, included children display "Included"; deselected AND
  // condition-excluded rows (plus their subtrees) are dropped.
  const project = (node: PricedRowNode) => {
    if (!node.included || node.item.selected === false) return;
    const includedChild = node.item.included === true && node.depth > 0;
    flat.push({
      ...node.item,
      children: undefined,
      depth: node.depth,
      show_amount: !includedChild,
      indent_label: node.depth > 0 ? "    · " : ""
    });
    node.children.forEach(project);
  };
  nodes.forEach(inventory);
  nodes.forEach(project);
  return { flat, conditional };
}

/**
 * Full conditional-pricing enrichment for one scope/line item tree. Returns
 * the enriched tree (effective amounts written on), the flat projection, the
 * conditional-row inventory, and totals.
 *
 * options.formulaBaseCents overrides the rows_subtotal_cents the formula pass
 * sees — params.pricing_adjustments lists are ALL conditional (their own base
 * is 0), so their percent formulas evaluate against the scope/line item base
 * subtotal instead of themselves.
 */
function enrichConditionalRows(rows: unknown[], pricingScope: JsonObject, options: { formulaBaseCents?: number } = {}) {
  const nodes = buildPricedRows(asArray(rows), pricingScope);
  // rows_subtotal_cents = sum of top-level NON-conditional base amounts. All
  // condition-bearing rows sit outside this sum so formula rows never feed
  // each other and evaluation stays order-independent.
  const ownBaseCents = nodes.reduce((sum, node) => sum + (node.conditional ? 0 : basePricedCents(node)), 0);
  const baseSubtotalCents = Number.isFinite(Number(options.formulaBaseCents)) && options.formulaBaseCents !== undefined
    ? Math.round(Number(options.formulaBaseCents))
    : ownBaseCents;
  let totalCents = 0;
  for (const node of nodes) totalCents += finalizePricedCents(node, pricingScope, baseSubtotalCents);
  const { flat, conditional } = collectPricedProjection(nodes);
  return {
    tree: nodes.map((node) => node.item),
    rows: flat,
    conditional_rows: conditional,
    base_subtotal_cents: baseSubtotalCents,
    total_cents: totalCents
  };
}

/**
 * Option-slot normalization (spec 10.3, three-option workflows): the seeded
 * three-option workflow collects params.option_a_items/option_b_items/
 * option_c_items through three plain line_items_review steps (client kinds
 * cannot write into array indices). When params.proposal_options is absent,
 * resolution/solidify synthesize it from those slots so templates and
 * outputs.option_choice work off one canonical list. Explicit
 * proposal_options always wins; the synthesized list is resolution-time
 * derived data, never persisted back onto the instance params.
 */
const PROPOSAL_OPTION_SLOTS: Array<[slot: string, fallbackLabel: string]> = [
  ["option_a", "Good"],
  ["option_b", "Better"],
  ["option_c", "Best"]
];

/**
 * Apply customer selection-group picks to a scope-items tree. The value is the
 * doc.line_items / choice_group output shape: { selections: { <group_id>:
 * <item_id>, <item_id>: bool }, selected_ids: [...] } (bare maps accepted).
 * Only customer-selectable choice/optional rows are touched — fixed scope and
 * internal-only selections never move.
 */
function applyScopeSelections(items: unknown[], rawValue: unknown): unknown[] {
  const value = asObject(rawValue);
  const map = asObject(value.selections && typeof value.selections === "object" ? value.selections : value);
  const selectedIds = asArray(value.selected_ids).map(cleanText).filter(Boolean);
  const hasIds = selectedIds.length > 0;
  const apply = (itemValue: unknown): unknown => {
    const item = asObject(itemValue);
    const selection = asObject(item.selection);
    const mode = cleanText(selection.mode);
    const customerSelectable = asArray(selection.selectable_by).map(cleanText).includes("customer");
    let next = item;
    if (customerSelectable && (mode === "choice" || mode === "optional")) {
      const itemId = cleanText(item.id);
      const groupId = cleanText(selection.group_id);
      let selected: boolean | null = null;
      if (mode === "choice" && groupId && map[groupId] !== undefined) selected = cleanText(map[groupId]) === itemId;
      else if (mode === "optional" && typeof map[itemId] === "boolean") selected = map[itemId] === true;
      else if (hasIds) selected = selectedIds.includes(itemId);
      if (selected !== null) next = { ...item, selection: { ...selection, selected } };
    }
    if (Array.isArray(next.children) && next.children.length) {
      next = { ...next, children: next.children.map(apply) };
    }
    return next;
  };
  return items.map(apply);
}

function normalizedProposalOptions(params: JsonObject): unknown[] {
  const explicit = asArray(params.proposal_options);
  if (explicit.length) return explicit;
  const synthesized: JsonObject[] = [];
  for (const [slot, fallbackLabel] of PROPOSAL_OPTION_SLOTS) {
    const items = asArray(params[`${slot}_items`]);
    if (!items.length) continue;
    synthesized.push(compactObject({
      id: slot,
      label: cleanText(params[`${slot}_label`]) || fallbackLabel,
      summary: cleanText(params[`${slot}_summary`]),
      items
    }));
  }
  return synthesized;
}

/**
 * Scope items are a TREE (an assembly like "Roof Replacement" with 30
 * children). Repeaters stamp one instance per ROW, so resolution also emits a
 * flat, depth-annotated projection under `scope_rows`/`line_rows` (parent
 * rows carry the rolled-up amount, included children display "Included",
 * show_amount=false) plus the `conditional_rows`/`line_conditional_rows`
 * inventory for client-side re-evaluation.
 */
function enrichLineItemParams(params: JsonObject, pricingScope: JsonObject): JsonObject {
  const next = { ...params };
  const scope: JsonObject = { ...pricingScope, params: next };
  let itemsBaseCents: number | null = null;
  for (const key of ["scope_items", "line_items"]) {
    const rows = next[key];
    if (!Array.isArray(rows) || !rows.length) continue;
    const priced = enrichConditionalRows(rows, scope);
    if (itemsBaseCents === null) itemsBaseCents = priced.base_subtotal_cents;
    // Flat projection for repeaters (resolution-time only, never persisted).
    next[key] = priced.tree;
    next[key === "scope_items" ? "scope_rows" : "line_rows"] = priced.rows;
    next[key === "scope_items" ? "conditional_rows" : "line_conditional_rows"] = priced.conditional_rows;
  }
  // Pricing adjustments (spec 10.4 seeded examples): a dedicated list of
  // conditional rows (ACH discount / card fee / early-signing discount) that
  // never pollutes the scope editor. Formulas evaluate against the scope/line
  // item base subtotal; the projection lands under params.pricing_rows +
  // params.pricing_conditional_rows for the seeded adjustments repeater.
  const adjustments = next.pricing_adjustments;
  if (Array.isArray(adjustments) && adjustments.length) {
    const priced = enrichConditionalRows(adjustments, scope, { formulaBaseCents: itemsBaseCents ?? 0 });
    next.pricing_adjustments = priced.tree;
    next.pricing_rows = priced.rows;
    next.pricing_conditional_rows = priced.conditional_rows;
  }
  // Option groups (spec 10.3): each option's items enrich exactly like
  // scope_items, plus a per-option flat projection and total so templates can
  // bind {{params.proposal_options[0].total_cents | money}} or page-repeat
  // over params.proposal_options. Slot params (option_a_items...) synthesize
  // the list when it is absent (three-option workflow).
  const optionsValue = normalizedProposalOptions(next);
  if (Array.isArray(optionsValue) && optionsValue.length) {
    next.proposal_options = optionsValue.map((value) => {
      const option = asObject(value);
      if (!Array.isArray(option.items) || !option.items.length) return option;
      const priced = enrichConditionalRows(option.items, scope);
      return {
        ...option,
        items: priced.tree,
        rows: priced.rows,
        conditional_rows: priced.conditional_rows,
        total_cents: priced.total_cents,
        // doc.choice_group option-shape aliases so summary pages can feed
        // "{{params.proposal_options}}" straight into the widget config.
        price_cents: priced.total_cents,
        description: cleanText(option.description) || cleanText(option.summary)
      };
    });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Contract spec derivation (one-page legal agreement, spec §10.5). The legal
// template's specification checkboxes derive from the SELECTED scope rows
// (params.scope_rows — the flat projection, already filtered to selected /
// included rows) with robust name/ref matching, and the template binds each
// glyph as coalesce(params.spec.X, params.spec_derived.X) so explicit
// workflow overrides always win. Matching runs against a combined haystack of
// pricebook ref ids (underscores normalized to spaces), name, display name,
// description and selection group id — pricebook ids are stable where they
// exist, and the regexes cover org-renamed rows.
// ---------------------------------------------------------------------------

const CONTRACT_SPEC_MATCHERS: Array<[key: string, pattern: RegExp]> = [
  ["tear_off", /tear[\s_-]?off|remove existing roof/],
  ["haul_debris", /tear[\s_-]?off|haul|debris|disposal/],
  ["renail_deck", /re[\s_-]?nail/],
  ["replace_plywood", /plywood|decking|sheathing|\bosb\b/],
  ["ice_water_shield", /ice\s*&?\s*water|weather[\s_-]?watch|weather[\s_-]?lock/],
  ["ridge_vent", /ridge[\s_-]?vent/],
  ["box_vents", /box[\s_-]?vent/],
  ["intake_vents", /soffit|intake[\s_-]?vent/],
  ["flashing_valleys", /valley/],
  ["flashing_pipes", /pipe[\s_-]?(boot|flash)/],
  ["drip_edge", /drip[\s_-]?edge/],
  ["counter_flashing", /counter[\s_-]?flash|head[\s_-]?wall|side[\s_-]?wall/],
  ["furnace_flashing", /furnace/],
  ["gutters_5in", /gutter(?![\s_-]?(cover|guard|screen))|downspout/],
  ["gutter_covers", /gutter[\s_-]?(cover|guard|screen)/],
  ["install_shingle_system", /shingle|roof[\s_-]?replacement/]
];

/** Underlayment TYPE (the agreement's three-way select) — specific first. */
const CONTRACT_UNDERLAYMENT_MATCHERS: Array<[value: string, pattern: RegExp]> = [
  ["tiger_paw", /tiger[\s_-]?paw/],
  ["safeguard", /safe[\s_-]?guard/],
  ["synthetic", /synthetic|felt[\s_-]?buster|shingle[\s_-]?mate|underlayment/]
];

function contractSpecHaystack(rowValue: unknown) {
  const row = asObject(rowValue);
  const ref = asObject(row.pricebook_ref);
  return [
    cleanText(ref.item_id),
    cleanText(ref.catalog_item_id),
    cleanText(row.item_id),
    cleanText(row.name),
    cleanText(row.display_name),
    cleanText(row.description),
    cleanText(asObject(row.selection).group_id)
  ].filter(Boolean).join(" ").replace(/_/g, " ").toLowerCase();
}

/**
 * Derive the one-page agreement's spec booleans (+ underlayment type) from the
 * flat scope-row projection. Only TRUE keys are emitted — absent and false
 * behave identically under the template's coalesce override binding.
 */
export function deriveContractSpec(scopeRows: unknown[]): JsonObject {
  const haystacks = asArray(scopeRows).map(contractSpecHaystack).filter(Boolean);
  const derived: JsonObject = {};
  for (const [key, pattern] of CONTRACT_SPEC_MATCHERS) {
    if (haystacks.some((haystack) => pattern.test(haystack))) derived[key] = true;
  }
  for (const [value, pattern] of CONTRACT_UNDERLAYMENT_MATCHERS) {
    if (haystacks.some((haystack) => pattern.test(haystack))) {
      derived.underlayment = value;
      break;
    }
  }
  return derived;
}

/**
 * Resolve every "source:<id>" reference found across the given values.
 * Returns { "<id>": rows } — unknown/failing sources resolve to [].
 */
async function resolveSourcesFor(ctx: WidgetResolveContext, values: unknown[]): Promise<Record<string, unknown[]>> {
  const sources: Record<string, unknown[]> = {};
  for (const id of collectSourceIds(values)) {
    sources[id] = await resolveDocumentSource(id, ctx);
  }
  return sources;
}

/** Params whose value is exactly "source:<id>" get the resolved rows directly. */
function replaceSourceParamValues(params: JsonObject, sources: Record<string, unknown[]>): JsonObject {
  const next = { ...params };
  for (const [key, value] of Object.entries(next)) {
    if (key === DOCUMENT_SOURCES_PARAM_KEY) continue;
    const id = sourceIdFromString(value);
    if (id && sources[id] !== undefined) next[key] = sources[id];
  }
  return next;
}

async function templateDefinitionFor(orgId: string, documentValue: JsonObject): Promise<JsonObject> {
  // Opt-in module materialization stores a validated render result. Reading,
  // signing and PDF generation never execute tenant code or refresh bindings.
  if (cleanText(asObject(documentValue.module_ref).execution_id) && Object.keys(asObject(documentValue.module_render)).length) {
    return cloneJson(asObject(documentValue.module_render));
  }
  const templateRef = asObject(documentValue.template_ref);
  const templateId = cleanText(templateRef.template_id);
  if (templateId) {
    // Drafts follow the template's CURRENT published version so preset
    // upgrades reach unsent documents; everything sent/signed keeps its pin
    // (snapshots freeze content anyway).
    const pinned = Number(templateRef.version || 0) || undefined;
    const isDraft = cleanText(documentValue.status) === "draft" || !cleanText(documentValue.status);
    const version = isDraft ? undefined : pinned;
    const templateVersion = await readDocumentTemplateVersion(orgId, templateId, version).catch(() => null);
    const definition = asObject(asObject(templateVersion).definition);
    if (Object.keys(definition).length) return definition;
  }
  // Template-free documents open as a ready-to-type Letter document with a
  // paginating body flow and editable header/footer regions.
  const fallback = (FMDocModel.createBlankDocument || FMDocModel.createDocument)({
    metadata: { document_type: cleanText(documentValue.document_type) }
  });
  return asObject(fallback);
}

export async function resolveDocumentInstance(
  orgId: string,
  documentValue: JsonObject,
  options: {
    params?: JsonObject;
    overrides?: unknown[];
    themeRef?: JsonObject | null;
    themeOverrides?: JsonObject;
    snapshot?: JsonObject | null;
    target?: "static" | "interactive";
    /** Pricing scope checkout variables ({ payment_method, processing_fee_percent }). */
    checkout?: JsonObject;
  } = {}
) {
  if (cleanText(asObject(documentValue.module_ref).execution_id) && Object.keys(asObject(documentValue.module_resolved)).length) {
    const captured = cloneJson(asObject(documentValue.module_resolved)) as {
      resolved_definition: JsonObject; widget_data: Record<string, unknown>; theme: JsonObject;
      theme_ref: JsonObject; theme_vars: Record<string, string>; theme_context: JsonObject;
      scope: JsonObject; sources: Record<string, unknown>; skipped_overrides: unknown[];
    };
    captured.resolved_definition = filterDocumentDefinitionByCapabilities(captured.resolved_definition, await documentCapabilityState(orgId));
    const refs = FMDocModel.widgetRefs(captured.resolved_definition);
    const allowedNodes = new Set(refs.map(ref => ref.node_id));
    captured.widget_data = Object.fromEntries(Object.entries(captured.widget_data).filter(([key]) => allowedNodes.has(key)));
    // Lifecycle overlays may change signature evidence, due-payment status and
    // this delivery's portal link. They must not reprice/refetch frozen inputs.
    const nodes = new Map<string, JsonObject>();
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = asObject(value); if (cleanText(node.id)) nodes.set(cleanText(node.id), node);
      Object.values(node).forEach(visit);
    };
    visit(captured.resolved_definition);
    const ctx: WidgetResolveContext = { organizationId: orgId, document: documentValue,
      params: asObject(captured.scope.params), project: asObject(captured.scope.project),
      snapshot: options.snapshot || null, target: options.target || "interactive", services: widgetServices() };
    for (const ref of refs) {
      if (!["doc.signature", "doc.qr", "doc.pay_now"].includes(ref.id)) continue;
      const resolver = documentWidgetResolver(ref.id);
      if (resolver) captured.widget_data[ref.node_id] = await resolver(ctx, asObject(asObject(asObject(nodes.get(ref.node_id)).props).config));
    }
    return captured;
  }
  const capabilityState = await documentCapabilityState(orgId);
  const definition = filterDocumentDefinitionByCapabilities(await templateDefinitionFor(orgId, documentValue), capabilityState);
  const rawWorkflowDefinition = await workflowDefinitionForDocument(orgId, documentValue).catch(() => null);
  const workflowDefinition = rawWorkflowDefinition ? filterWorkflowByCapabilities(rawWorkflowDefinition, capabilityState) : null;
  const overrides = options.overrides !== undefined ? asArray(options.overrides) : asArray(documentValue.overrides);
  const applied = FMDocModel.applyOverrides(definition, overrides);
  let params: JsonObject = { ...asObject(documentValue.params), ...asObject(options.params) };
  const outputs = asObject(documentValue.outputs);
  const entities = await documentScopeEntities(orgId, documentValue, params);
  // Cents enrichment for scope/line item lists (repeater + computed bindings),
  // evaluated against the full pricing scope so conditional rows (spec 10.4)
  // see checkout/doc/now alongside params and entities.
  const checkout = normalizedCheckout(options.checkout);
  const docScope = documentDocScope(documentValue);
  const pricingScope: JsonObject = {
    outputs,
    checkout,
    doc: docScope,
    org: entities.org,
    project: entities.project,
    customer: entities.customer,
    now: nowIso(),
    computed: {}
  };
  params = enrichLineItemParams(params, pricingScope);
  // One-page legal agreements (document_type contract): derive the spec
  // checkboxes from the enriched flat scope rows. Resolution-time only —
  // never persisted; explicit params.spec.* overrides win in the template's
  // coalesce bindings.
  if (cleanText(documentValue.document_type) === "contract") {
    params = { ...params, spec_derived: deriveContractSpec(asArray(params.scope_rows)) };
  }
  const branding = await organizationBranding(orgId, cleanText(documentValue.branch_id || "default"));
  const staticTarget = options.target === "static";
  const logoUrl = await organizationLogoUrl(orgId, branding, asObject(entities.org), staticTarget);
  // Named data sources: pre-scan the working definition + workflow + params
  // for "source:<id>" strings, resolve each unique source server-side, inject
  // the rows under params.__sources and rewrite the sugar strings to
  // "{{params.__sources['<id>']}}" expressions (see sources/registry.ts).
  let workingDefinition = applied.document;
  const sourceCtx: WidgetResolveContext = {
    organizationId: orgId,
    document: documentValue,
    params,
    project: entities.project,
    snapshot: options.snapshot || null,
    target: options.target || "interactive",
    services: widgetServices()
  };
  const sources = await resolveSourcesFor(sourceCtx, [workingDefinition, workflowDefinition, params]);
  if (Object.keys(sources).length) {
    workingDefinition = rewriteSourceStrings(workingDefinition);
    params = replaceSourceParamValues(params, sources);
    params = { ...params, [DOCUMENT_SOURCES_PARAM_KEY]: sources };
  }
  const scopeData: JsonObject = {
    params,
    outputs,
    org: { ...entities.org, branding, logo_url: logoUrl },
    project: entities.project,
    customer: entities.customer,
    // Extended doc entity (sent_at/first_viewed_at/expiry hints) flows into
    // FMDocModel.resolveBindings via buildScope's doc passthrough so template
    // expressions like days_since(doc.sent_at) evaluate server-side too.
    doc: docScope,
    // checkout rides on the returned scope for client-side re-evaluation of
    // conditional rows (portal pay flow); server-side row evaluation already
    // happened in enrichLineItemParams with this same object.
    checkout,
    // Component defs visible during resolution: template defs merged under the
    // working (override-applied) document's own defs. An org component library
    // collection can layer in here later without changing the call shape.
    components: FMDocModel.mergedComponents(workingDefinition, asObject(definition.components))
  };
  const resolvedDefinition = FMDocModel.resolveBindings(workingDefinition, scopeData);
  // Media picker refs ({media_id, variant}) become loadable URLs; static/PDF
  // resolution inlines them as data URIs like widget static renders do.
  await attachImageMediaUrls(orgId, resolvedDefinition, staticTarget);
  const widgetCtx: WidgetResolveContext = {
    organizationId: orgId,
    document: documentValue,
    params,
    project: entities.project,
    snapshot: options.snapshot || null,
    target: options.target || "interactive",
    services: widgetServices()
  };
  const widgetData = await resolveDocumentWidgetData(resolvedDefinition, widgetCtx);
  const themed = options.themeRef !== undefined
    ? { theme: asObject(asObject(await readDocumentThemeVersion(orgId, cleanText(asObject(options.themeRef).theme_id), Number(asObject(options.themeRef).version || 0) || undefined).catch(() => null)).definition), theme_ref: asObject(options.themeRef) }
    : await resolveInstanceTheme(orgId, documentValue);
  const themeContext = {
    branding,
    overrides: { ...asObject(documentValue.theme_overrides), ...asObject(options.themeOverrides) }
  };
  // Bare font family names in theme tokens expand to the renderer's exact
  // fallback stacks so fonts stay consistent across every page and surface.
  const themeVars = expandThemeFontVars(FMDocModel.resolveThemeTokens(themed.theme, themeContext));
  return {
    resolved_definition: resolvedDefinition,
    widget_data: widgetData,
    theme: themed.theme,
    theme_ref: themed.theme_ref,
    theme_vars: themeVars,
    theme_context: themeContext,
    scope: scopeData,
    sources,
    skipped_overrides: applied.skipped
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function createSnapshot(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext | null) {
  const document = await readDocumentInstance(orgId, documentId);
  const capabilityState = await documentCapabilityState(orgId);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(document.revision || 0)) {
    throw conflict("document_revision_conflict", "Document revision does not match.");
  }
  const reason = cleanText(input.reason || "manual") || "manual";
  // The public token is minted BEFORE widget resolution so doc.qr/doc.pay_now
  // can compute the portal URL that gets frozen into the snapshot.
  const publicToken = randomUUID();
  // Snapshots freeze data for BOTH print and portal, so widgets resolve in
  // static mode (small images inline as data URIs the PDF harness can load).
  const resolved = await resolveDocumentInstance(orgId, document, {
    target: "static",
    snapshot: { public_token: publicToken }
  });
  const snapshots = await listDocumentSnapshots(orgId, documentId);
  const snapshotNumber = snapshots.length + 1;
  const id = `document_snapshot_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = nowIso();
  const data: JsonObject = {
    schema_version: DOCUMENT_SNAPSHOT_SCHEMA_VERSION,
    language_snapshot: await companyDocumentLanguage(orgId, cleanText(document.branch_id || "default")),
    id,
    organization_id: orgId,
    branch_id: cleanText(document.branch_id || "default") || "default",
    project_id: cleanText(document.project_id),
    document_id: documentId,
    document_type: cleanText(document.document_type),
    title: cleanText(document.title),
    status: cleanText(document.status),
    snapshot_number: snapshotNumber,
    reason,
    resolved_definition: cloneJson(resolved.resolved_definition),
    widget_data: cloneJson(resolved.widget_data),
    sources: cloneJson(resolved.sources || {}),
    theme: cloneJson(resolved.theme),
    theme_vars: cloneJson(resolved.theme_vars),
    params: cloneJson(asObject(document.params)),
    output_defs: cloneJson(filterOutputDefinitionsByCapabilities(asObject(document.output_defs), capabilityState)),
    outputs: cloneJson(asObject(document.outputs)),
    evidence: {},
    public_token: publicToken,
    pdf: {},
    locked: true,
    locked_at: now,
    created_by_user_id: ctx?.userId || "",
    created_at: now,
    updated_at: now,
    metadata: asObject(input.metadata)
  };
  const snapshot = await saveDocumentSnapshot(orgId, id, data);
  await saveDocumentInstance(orgId, documentId, {
    ...document,
    delivery: {
      ...deliveryState(document.delivery),
      current_snapshot_id: id,
      public_token: publicToken
    },
    updated_at: now
  });
  await recordDocumentEvent(orgId, document, "document.snapshot_created", { snapshot_id: id, reason }, ctx, { emit: false });
  if (input.generate_pdf === true) {
    await generateDocumentPdf(orgId, documentId, { snapshot_id: id, store: true }, ctx).catch(() => null);
  }
  return snapshot;
}

export async function sendDocument(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const snapshot = await createSnapshot(orgId, documentId, {
    ...input,
    reason: "send",
    generate_pdf: input.include_pdf === true
  }, ctx);
  const document = await readDocumentInstance(orgId, documentId);
  const now = nowIso();
  const delivery = deliveryState(document.delivery);
  const recipients = asArray(input.recipients).map(asObject);
  const updated = await saveDocumentInstance(orgId, documentId, {
    ...document,
    status: advanceStatus(document.status, "sent"),
    delivery: {
      ...delivery,
      sent_at: now,
      send_count: delivery.send_count + 1,
      current_snapshot_id: cleanText(snapshot.id),
      public_token: cleanText(snapshot.public_token),
      recipients: recipients.length ? recipients : delivery.recipients,
      include_pdf: input.include_pdf === true,
      include_portal: input.include_portal !== false
    },
    updated_by_user_id: ctx.userId,
    updated_at: now
  });
  await recordDocumentEvent(orgId, updated, "document.sent", {
    snapshot_id: cleanText(snapshot.id),
    recipients: recipients.map((recipient) => compactObject({
      name: cleanText(recipient.name),
      email: cleanText(recipient.email),
      phone: cleanText(recipient.phone)
    }))
  }, ctx);
  const portalUrl = publicDocumentPortalUrl(cleanText(snapshot.public_token));
  const emailed: JsonObject[] = [];
  const attachment = input.include_pdf === true
    ? await readDocumentPdfFile(orgId, documentId, "", cleanText(snapshot.id)).catch(() => null)
    : null;
  if ((input.include_portal !== false && portalUrl) || attachment) {
    const typeDef = typeDefinitionFor(cleanText(updated.document_type));
    const language = await serverLanguage(resolveContext(), ["notifications"], snapshot.language_snapshot as LanguageSnapshot | undefined);
    for (const recipient of recipients) {
      const email = cleanText(recipient.email);
      if (!email) continue;
      const result = await sendOrganizationTransactionalEmail({
        organizationId: orgId,
        branchId: cleanText(updated.branch_id || "default") || "default",
        to: email,
        subject: `${typeDef.label}: ${cleanText(updated.title) || typeDef.label}`,
        textBody: [
          language.text("notifications", "document_greeting", `Hi ${cleanText(recipient.name) || "there"},`, {name:cleanText(recipient.name) || "there"}),
          "",
          cleanText(input.message) || language.text("notifications", "document_ready", `Your ${typeDef.label.toLowerCase()} is ready to review.`, {type:typeDef.label.toLowerCase()}),
          "",
          language.text("notifications", "document_link", `Review and respond here: ${portalUrl}`, {url:portalUrl})
        ].join("\n"),
        purpose: "transactional",
        projectId: cleanText(updated.project_id),
        tags: ["document-send"],
        source: { type: "user", id: "document_delivery", user_id: ctx.userId },
        metadata: { document_id: cleanText(updated.id), snapshot_id: cleanText(snapshot.id) },
        idempotencyKey: `document_email:${cleanText(snapshot.id)}:${email}`,
        attachments: attachment ? [{ name: attachment.fileName, contentType: attachment.contentType, content: attachment.bytes }] : undefined
      }).catch((error) => ({ ok: false, success: false, error: error instanceof Error ? error.message : "email_failed" }));
      emailed.push(compactObject({ email, ...asObject(result) }));
    }
  }
  // SMS delivery rides the consolidated comms engine. When the SMS transport
  // (Telnyx) is not yet provisioned the message is still recorded on the
  // project conversation and the send is a graceful no-op — flipping the
  // transport on later makes this path live without further changes here.
  const texted: JsonObject[] = [];
  if (input.include_portal !== false && portalUrl && cleanText(updated.project_id)) {
    const typeDef = typeDefinitionFor(cleanText(updated.document_type));
    for (const recipient of recipients) {
      const phone = cleanText(recipient.phone);
      if (!phone) continue;
      const result = await sendProjectSms(
        orgId,
        cleanText(updated.branch_id || "default") || "default",
        cleanText(updated.project_id),
        {
          to: phone,
          text: `${cleanText(input.message) || `Your ${typeDef.label.toLowerCase()} "${cleanText(updated.title) || typeDef.label}" is ready to review.`} ${portalUrl}`,
          source: { type: "user", id: "document_delivery", user_id: ctx.userId },
          idempotency_key: `document_sms:${cleanText(snapshot.id)}:${phone}`
        },
        ctx
      ).catch((error) => ({ ok: false, success: false, error: error instanceof Error ? error.message : "sms_failed" }));
      texted.push(compactObject({ phone, ...(asObject(result).ok !== undefined || asObject(result).error ? asObject(result) : { queued: true }) }));
    }
  }
  await syncProjectSignatureRequirements(orgId, cleanText(updated.project_id)).catch(() => null);
  return { document: updated, snapshot, portal_url: portalUrl, emailed, texted };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function fallbackPagesFromDefinition(definition: JsonObject) {
  const pages: Array<{ title?: string; body?: string }> = [];
  for (const pageValue of asArray(definition.pages)) {
    const page = asObject(pageValue);
    const lines: string[] = [];
    const visit = (nodeValue: unknown) => {
      const node = asObject(nodeValue);
      if (node.type === "text") {
        for (const block of asArray(asObject(node.props).blocks)) {
          const text = asArray(asObject(block).runs).map((run) => cleanText(asObject(run).text)).join("");
          if (cleanText(text)) lines.push(text);
        }
      }
      asArray(node.children).forEach(visit);
    };
    asArray(page.children).forEach(visit);
    pages.push({ title: cleanText(page.name || page.role) || undefined, body: lines.join("\n") });
  }
  return pages;
}

export async function generateDocumentPdf(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext | null) {
  const document = await readDocumentInstance(orgId, documentId);
  let snapshotId = cleanText(input.snapshot_id || deliveryState(document.delivery).current_snapshot_id);
  let snapshot = snapshotId ? await readDocumentSnapshot(orgId, snapshotId).catch(() => null) : null;
  if (!snapshot) {
    snapshot = await createSnapshot(orgId, documentId, { reason: "pdf" }, ctx);
    snapshotId = cleanText(snapshot.id);
  }
  const resolvedDefinition = asObject(snapshot.resolved_definition);
  const paper = FMDocModel.paperDimensions(resolvedDefinition);
  const title = cleanText(input.title || snapshot.title || document.title || "Document") || "Document";
  let rendered: { bytes: Buffer; fileName: string; pageCount: number };
  try {
    const html = await buildRenderHarnessHtml({
      resolved_definition: resolvedDefinition,
      language_snapshot: snapshot.language_snapshot as LanguageSnapshot | undefined,
      theme: asObject(snapshot.theme),
      themeContext: { branding: await organizationBranding(orgId, cleanText(document.branch_id || "default")), overrides: asObject(document.theme_overrides) },
      widgetData: asObject(snapshot.widget_data) as Record<string, unknown>,
      scope: { params: asObject(snapshot.params), outputs: asObject(snapshot.outputs) },
      title
    });
    rendered = await renderDocumentPdf({ html, paper, title });
  } catch {
    // Renderer libraries not present yet (or browser render failed): degrade
    // to the typed pdf-lib fallback so the pipeline still produces a file.
    rendered = await renderDocumentFallbackPdf({
      title,
      paper,
      pages: fallbackPagesFromDefinition(resolvedDefinition),
      meta: `Document: ${documentId}  Snapshot: ${snapshotId}`
    });
  }
  if (input.store === false) {
    return { ...rendered, media: null, media_ref: null, snapshot };
  }
  const media = await storeMediaUpload(orgId, {
    ownerType: "document",
    ownerId: documentId,
    slot: `pdf_${snapshotId}`,
    collection: "documents",
    scope: "document",
    fileName: rendered.fileName,
    contentType: "application/pdf",
    bytes: rendered.bytes,
    metadata: {
      document_id: documentId,
      snapshot_id: snapshotId,
      source: "documents_api"
    },
    thumbnails: false,
    compression: false
  });
  const mediaRef = {
    kind: "media_reference",
    media_id: cleanText(media.id),
    variant: "original",
    file_name: cleanText(media.file_name),
    content_type: cleanText(media.content_type),
    size_bytes: Number(media.size_bytes || rendered.bytes.length)
  };
  const now = nowIso();
  await saveDocumentSnapshot(orgId, snapshotId, {
    ...snapshot,
    pdf: { media_id: cleanText(media.id), media_ref: mediaRef, page_count: rendered.pageCount, generated_at: now },
    updated_at: now
  });
  const latest = await readDocumentInstance(orgId, documentId);
  await saveDocumentInstance(orgId, documentId, {
    ...latest,
    pdf: {
      ...asObject(latest.pdf),
      latest_media_id: cleanText(media.id),
      latest_media_ref: mediaRef,
      latest_snapshot_id: snapshotId,
      page_count: rendered.pageCount,
      generated_at: now
    },
    updated_at: now
  });
  return { ...rendered, media, media_ref: mediaRef, snapshot };
}

/**
 * PDF for a Doc Studio folder item (marketing materials). No instance or
 * snapshot machinery — folder items are unversioned, so the raw definition
 * renders through the same harness `generateDocumentPdf` uses, with an empty
 * scope (marketing docs declare no params/outputs). Never stored.
 */
export async function generateFolderItemPdf(orgId: string, itemId: string) {
  const item = await readDocumentFolderItem(orgId, itemId);
  if (!["document", "visual_document"].includes(cleanText(item.item_type))) {
    throw badRequest("document_folder_item_not_renderable", "Only designed documents can export a PDF; uploads download their original file.");
  }
  const definition = asObject(item.definition);
  if (!Object.keys(definition).length) {
    throw badRequest("document_folder_item_empty", "This item has no content to render yet.");
  }
  const paper = FMDocModel.paperDimensions(definition);
  const title = cleanText(item.name) || "Document";
  try {
    const html = await buildRenderHarnessHtml({
      resolved_definition: definition,
      language_snapshot: await companyDocumentLanguage(orgId),
      theme: {},
      themeContext: { branding: await organizationBranding(orgId, "default") },
      widgetData: {},
      scope: { params: {}, outputs: {} },
      title
    });
    return await renderDocumentPdf({ html, paper, title });
  } catch {
    return await renderDocumentFallbackPdf({
      title,
      paper,
      pages: fallbackPagesFromDefinition(definition),
      meta: `Folder item: ${itemId}`
    });
  }
}

export async function readDocumentPdfFile(orgId: string, documentId: string, mediaId = "", snapshotId = "") {
  const document = await readDocumentInstance(orgId, documentId);
  const pdf = asObject(document.pdf);
  let resolvedMediaId = cleanText(mediaId);
  if (!resolvedMediaId && cleanText(snapshotId)) {
    const snapshot = await readDocumentSnapshot(orgId, cleanText(snapshotId)).catch(() => null);
    resolvedMediaId = cleanText(asObject(asObject(snapshot).pdf).media_id);
  }
  if (!resolvedMediaId) resolvedMediaId = cleanText(pdf.latest_media_id || asObject(pdf.latest_media_ref).media_id);
  if (!resolvedMediaId) {
    const generated = await generateDocumentPdf(orgId, documentId, { store: true }, null);
    return { contentType: "application/pdf", fileName: generated.fileName, bytes: generated.bytes };
  }
  const file = await readMediaFile(orgId, resolvedMediaId, "original");
  return { contentType: file.contentType || "application/pdf", fileName: file.fileName, bytes: file.bytes };
}

export async function readPublicDocumentPdfFile(publicToken: string) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const pdf = asObject(found.snapshot.pdf);
  const mediaId = cleanText(pdf.media_id || asObject(pdf.media_ref).media_id);
  if (mediaId) {
    const file = await readMediaFile(found.orgId, mediaId, "original");
    return { contentType: file.contentType || "application/pdf", fileName: file.fileName, bytes: file.bytes };
  }
  const generated = await generateDocumentPdf(found.orgId, cleanText(found.snapshot.document_id), {
    snapshot_id: cleanText(found.snapshot.id),
    store: true
  }, null);
  return { contentType: "application/pdf", fileName: generated.fileName, bytes: generated.bytes };
}

// ---------------------------------------------------------------------------
// Outputs, views, public workflow
// ---------------------------------------------------------------------------

function outputEvidence(clientEvidence: JsonObject, audit: JsonObject, occurredAt: string) {
  return compactObject({
    captured_at: occurredAt,
    ip_address: cleanText(audit.ip_address),
    user_agent: cleanText(audit.user_agent),
    accept_language: cleanText(audit.accept_language),
    referrer: cleanText(audit.referrer),
    forwarded_for: cleanText(audit.forwarded_for),
    request_id: cleanText(audit.request_id),
    path: cleanText(clientEvidence.path),
    href: cleanText(clientEvidence.href),
    timezone: cleanText(clientEvidence.timezone),
    locale: cleanText(clientEvidence.locale),
    capture_mode: cleanText(clientEvidence.capture_mode),
    witnessed_by_user_id: cleanText(clientEvidence.witnessed_by_user_id),
    device: compactObject(asObject(clientEvidence.device)),
    viewport: compactObject(asObject(clientEvidence.viewport)),
    geolocation: compactObject(asObject(clientEvidence.geolocation || clientEvidence.geo)),
    approximate_location: compactObject(asObject(audit.geo))
  });
}

function normalizeOutputValue(def: JsonObject, value: unknown, evidence: JsonObject, occurredAt: string): unknown {
  if (cleanText(def.type) === "signature") {
    const signature = asObject(value);
    return compactObject({
      type: cleanText(signature.type || "typed") || "typed",
      text: cleanText(signature.text || signature.signer_name),
      signer_name: cleanText(signature.signer_name || signature.text),
      style: cleanText(signature.style || "style-classic") || "style-classic",
      image_data: cleanText(signature.image_data || signature.imageData || signature.data_url || signature.dataUrl),
      signed_at: cleanText(signature.signed_at) || occurredAt,
      evidence
    });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...asObject(value), recorded_at: occurredAt, ...(Object.keys(evidence).length ? { evidence } : {}) };
  }
  return value;
}

function documentPaymentTransactionId(documentId: string, outputKey: string) {
  return `payment_doc_${`${documentId}_${outputKey}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 140)}`;
}

/**
 * Phase 0 gap fix: the public document-payment path used to emit
 * document.payment.received without ever writing a payment_transactions row.
 * When the org resolves a payment provider AND the submitted envelope carries
 * a tokenized (or saved) payment method, the charge runs through the SAME
 * provider charge path the intake modal uses; otherwise the legacy/mock path
 * records the transaction through createPayment with method type
 * "mock_document" (the document twin of the portal's mock_customer_portal).
 *
 * Idempotent per output: keyed by `${documentId}:${outputKey}` — the mock path
 * uses a stable transaction id and the provider path is guarded by a
 * metadata.document_output_id lookup, so replayed outputs never double-create
 * (or double-charge).
 */
async function recordDocumentPaymentTransaction(
  orgId: string,
  document: JsonObject,
  params: JsonObject,
  outputKey: string,
  submitted: JsonObject,
  amountCents: number,
  ctx?: PlatformAuthContext | null
): Promise<JsonObject | null> {
  const amount = Math.max(0, Math.round(amountCents));
  if (amount <= 0) return null;
  const documentId = cleanText(document.id);
  const projectId = cleanText(document.project_id);
  const outputRef = `${documentId}:${outputKey}`;
  const paymentId = documentPaymentTransactionId(documentId, outputKey);
  const paymentsStorage = await import("../payments/storage.js");
  const existing = await readDocument(orgId, paymentsStorage.PAYMENT_TRANSACTION_COLLECTION, paymentId).catch(() => null);
  if (existing) return asObject(asObject(existing).data);
  const priorProviderCharge = projectId
    ? (await paymentsStorage.listProjectPayments(orgId, projectId, { skipFlag: true }).catch(() => []))
      .find((payment) => cleanText(asObject(payment.metadata).document_output_id) === outputRef)
    : null;
  if (priorProviderCharge) return priorProviderCharge;
  const entities = await documentScopeEntities(orgId, document, params)
    .catch(() => ({ project: {} as JsonObject, customer: {} as JsonObject, org: {} as JsonObject }));
  const customer = asObject(entities.customer);
  const contactRef = {
    ...(cleanText(customer.id) ? { id: cleanText(customer.id) } : {}),
    ...(cleanText(customer.name) ? { name: cleanText(customer.name) } : {}),
    ...(cleanText(customer.email) ? { email: cleanText(customer.email).toLowerCase() } : {})
  };
  const paymentCtx = {
    userId: ctx?.userId || "document_public",
    branchId: cleanText(document.branch_id || "default") || "default"
  } as unknown as PlatformAuthContext;
  const metadata: JsonObject = {
    document_id: documentId,
    document_output_key: outputKey,
    document_output_id: outputRef,
    source: "document_engine"
  };
  const token = cleanText(submitted.payment_method_id);
  const savedMethodId = cleanText(submitted.saved_payment_method_id || submitted.saved_method_id);
  try {
    if (token || savedMethodId) {
      const { getPaymentProvider } = await import("../payments/providers/index.js");
      const provider = await getPaymentProvider(orgId).catch(() => null);
      if (provider) {
        const { recordProviderChargedPayment, findSavedMethod } = await import("../payments/intake.js");
        // Legacy fake saved-method ids never resolve; fall back to the mock
        // record path instead of failing the payment (portal convention).
        const savedResolvable = !savedMethodId || token || !!(await findSavedMethod(orgId, savedMethodId));
        if (savedResolvable) {
          const charged = await recordProviderChargedPayment(orgId, provider, {
            amount_cents: amount,
            payment_method_id: token,
            saved_method_id: token ? "" : savedMethodId,
            method: cleanText(submitted.payment_method || submitted.method),
            project_id: projectId,
            branch_id: cleanText(document.branch_id || "default") || "default",
            save_payment_method: submitted.save_payment_method === true,
            // The document's authoritative pricing already carries its own
            // processing-fee rows; never stack the org surcharge on top.
            apply_surcharge: false,
            contact_ref: contactRef,
            payment: {
              kind: "customer_payment",
              currency: "USD",
              metadata: { ...metadata, provider: provider.provider },
              allocation_mode: "document_payment"
            }
          }, paymentCtx);
          return asObject(charged.payment);
        }
      }
    }
    const result = await paymentsStorage.createPayment(orgId, {
      id: paymentId,
      direction: "inbound",
      kind: "customer_payment",
      status: "settled",
      amount_cents: amount,
      currency: "USD",
      project_id: projectId,
      contact_ref: contactRef,
      method: { type: "mock_document", label: "Document Payment" },
      metadata: { ...metadata, mock: true },
      allocation_mode: "document_payment"
    }, paymentCtx);
    return asObject(result.payment);
  } catch (error) {
    // Money app off — keep the legacy event-only behavior instead of failing
    // the customer's checkout. Everything else (declines included) surfaces.
    if ((error as { code?: string }).code === "app_flag_disabled") return null;
    throw error;
  }
}

export async function recordDocumentOutput(
  orgId: string,
  documentId: string,
  key: string,
  input: JsonObject,
  audit: JsonObject = {},
  ctx?: PlatformAuthContext | null,
  options: { snapshotId?: string; surface?: "public" | "internal" | "field" } = {}
) {
  const document = await readDocumentInstance(orgId, documentId);
  const currentStatus = cleanText(document.status);
  if (["void", "declined", "expired"].includes(currentStatus)) {
    throw conflict("document_not_active", `This document is ${currentStatus} and can no longer accept signatures, payments, or other responses.`);
  }
  const outputDefs = asObject(document.output_defs);
  const outputKey = cleanText(key);
  const def = asObject(outputDefs[outputKey]);
  if (!Object.keys(def).length) {
    throw badRequest("document_output_unknown", `The document does not declare an output named '${outputKey}'.`);
  }
  // Party enforcement: outputs declared for the company (signer: "internal")
  // can never be recorded through the customer's public link. Internal and
  // field (witnessed in-person) surfaces may record either party.
  const surface = options.surface || (ctx ? "internal" : "public");
  const outputCapabilityState = await documentCapabilityState(orgId);
  const outputCapability = documentOutputCapability(def);
  const importedWetSignature = outputCapability === DOCUMENT_CAPABILITIES.esign
    && cleanText(asObject(input.evidence).capture_mode) === "imported";
  if (outputCapability && !importedWetSignature) {
    if (!documentCapabilityEnabled(outputCapabilityState, outputCapability)) {
      throw forbidden("document_feature_disabled", `The '${outputCapability}' capability is disabled for this organization.`, { capability: outputCapability });
    }
  }
  if (surface === "public" && outputCapability === DOCUMENT_CAPABILITIES.payments
    && !documentCapabilityEnabled(outputCapabilityState, DOCUMENT_CAPABILITIES.portalPayments)) {
    throw forbidden("document_feature_disabled", "Customer-portal payments are disabled for this organization.", { capability: DOCUMENT_CAPABILITIES.portalPayments });
  }
  if (surface === "public" && cleanText(def.type) === "signature" && cleanText(def.signer) === "internal") {
    throw forbidden("document_output_company_only", "This signature must be completed by the company and cannot be recorded through the customer link.");
  }
  const now = nowIso();
  const evidence = outputEvidence(asObject(input.evidence), audit, now);
  let value = normalizeOutputValue(def, input.value, evidence, now);
  let params = asObject(document.params);
  // Payment outputs (mock deposit/payment path): the charged amount is
  // recomputed server-side through the same conditional-pricing evaluation
  // as the public preview — client-sent totals are never trusted. A fixed
  // deposit param wins; otherwise the effective document total under the
  // submitted payment method is authoritative.
  if (cleanText(def.type) === "payment") {
    const submitted = asObject(input.value);
    const submittedMethod = cleanText(submitted.payment_method || submitted.method || asObject(submitted.checkout).payment_method);
    if (!submittedMethod) {
      throw badRequest("payment_not_completed", "Choose a payment method and complete checkout before recording this payment.");
    }
    // deposit_cents is ALREADY cents (currency param) — no dollar conversion.
    const depositCents = Math.max(0, Math.round(Number(params.deposit_cents) || 0));
    const hasPaymentSchedule = normalizeScheduleRows(params.payment_schedule).length > 0;
    const hasPricingBasis = asArray(params.scope_items).length > 0 || depositCents > 0 || hasPaymentSchedule;
    if (hasPricingBasis) {
      const pricing = await documentCheckoutPricing(orgId, document, params, {
        payment_method: submitted.payment_method ?? submitted.method,
        processing_fee_percent: submitted.processing_fee_percent
      }).catch(() => null);
      if (pricing) {
        const scheduleRows = normalizeScheduleRows(params.payment_schedule);
        // Percentage obligations divide the signed contract value, not a
        // payment-method-adjusted checkout total. This is the same basis used
        // by ensureReceivablesForSignedDocument, keeping preview, capture and
        // the eventual obligation ledger identical.
        const scopeSubtotalCents = Math.max(0,
          Math.round(Number(pricing.totals.subtotal_cents || 0))
          - Math.round(Number(pricing.totals.adjustments_cents || 0))
        );
        const taxPercent = Math.max(0, Number(params.tax_percent) || 0);
        const contractTotalCents = scheduleRows.length
          ? scopeSubtotalCents + Math.round(scopeSubtotalCents * taxPercent / 100)
          : Math.max(0, pricing.totals.total_cents);
        const scheduled = resolveScheduleItems(scheduleRows, {
          total_cents: contractTotalCents
        });
        const scheduledDue = scheduled.find((item) => item.due_rule === "on_signature" && item.amount_cents > 0)
          || scheduled.find((item) => item.payment_kind === "deposit" && item.amount_cents > 0)
          || scheduled.find((item) => item.amount_cents > 0);
        const authoritativeCents = depositCents > 0
          ? depositCents
          : (scheduledDue?.amount_cents || contractTotalCents);
        value = {
          ...asObject(value),
          amount_cents: authoritativeCents,
          pricing_totals: pricing.totals,
          checkout: pricing.checkout
        };
      }
    }
    // Record the real money movement (provider charge or mock transaction)
    // BEFORE the output persists, so a declined charge fails the output and
    // a recorded payment always has a payment_transactions row behind it.
    const paymentAmountCents = Math.max(0, Math.round(Number(asObject(value).amount_cents ?? submitted.amount_cents) || 0));
    const paymentTransaction = await recordDocumentPaymentTransaction(orgId, document, params, outputKey, submitted, paymentAmountCents, ctx);
    if (paymentTransaction) {
      value = {
        ...asObject(value),
        amount_cents: Math.max(0, Math.round(Number(paymentTransaction.amount_cents || paymentAmountCents))),
        payment_id: cleanText(paymentTransaction.id),
        ...(cleanText(paymentTransaction.provider) ? { provider: cleanText(paymentTransaction.provider) } : {})
      };
    }
  }
  // Option groups (spec 10.3): recording outputs.option_choice solidifies the
  // chosen option — params.scope_items derive from its items (write-through
  // so receivables/signing use the pick) while proposal_options stay intact.
  let solidifiedOptionId = "";
  if (outputKey === "option_choice") {
    const rawChoice = input.value;
    const choiceId = typeof rawChoice === "string"
      ? cleanText(rawChoice)
      : cleanText(asObject(rawChoice).value ?? asObject(rawChoice).id ?? asObject(rawChoice).option_id);
    // Slot-built documents (three-option workflow) synthesize the option list
    // from params.option_a_items/... exactly like resolution does.
    const optionList = normalizedProposalOptions(params).map(asObject);
    const chosen = optionList.find((option) => cleanText(option.id) === choiceId)
      || optionList.find((option) => cleanText(option.label) === choiceId);
    if (chosen && Array.isArray(chosen.items)) {
      params = { ...params, scope_items: cloneJson(chosen.items) };
      solidifiedOptionId = cleanText(chosen.id) || choiceId;
    }
  }
  // Selection groups: recording a select output that carries group picks
  // (choice_group / doc.line_items "selections") solidifies the flags onto
  // params.scope_items so the AUTHORITATIVE pricing — and the receivables the
  // signature mints — reflect what the customer chose, regardless of which
  // surface recorded it.
  let solidifiedSelections = false;
  if (cleanText(def.type) === "select" && outputKey !== "option_choice" && asArray(params.scope_items).length) {
    const raw = asObject(input.value);
    const hasSelectionShape = (raw.selections && typeof raw.selections === "object")
      || asArray(raw.selected_ids).length > 0
      || cleanText(def.applies) === "scope_selections";
    if (hasSelectionShape) {
      const nextItems = applyScopeSelections(asArray(params.scope_items), input.value);
      if (JSON.stringify(nextItems) !== JSON.stringify(params.scope_items)) {
        params = { ...params, scope_items: nextItems };
        solidifiedSelections = true;
      }
    }
  }
  const outputs = { ...asObject(document.outputs), [outputKey]: value };
  const wasSigned = isLockedSigned(document);
  const effectiveOutputDefs = Object.fromEntries(Object.entries(filterOutputDefinitionsByCapabilities(outputDefs, outputCapabilityState)).filter(([, definition]) => asObject(definition).disabled !== true));
  const signedNow = FMDocModel.requiredOutputsSatisfied(effectiveOutputDefs, outputs);
  const completedNow = signedNow && FMDocModel.requiredOutputsSatisfied(effectiveOutputDefs, outputs, "completed");
  let status = cleanText(document.status) as DocumentStatus;
  if (signedNow) status = advanceStatus(status, "signed");
  if (completedNow) status = advanceStatus(status, "completed");
  const updated = await saveDocumentInstance(orgId, documentId, {
    ...document,
    params,
    outputs,
    status,
    delivery: {
      ...deliveryState(document.delivery),
      ...(signedNow && !wasSigned ? { signed_at: now } : {})
    },
    updated_at: now
  });
  // Freeze the output into the current snapshot as well.
  const snapshotId = cleanText(options.snapshotId || deliveryState(document.delivery).current_snapshot_id);
  let snapshot: JsonObject | null = null;
  if (snapshotId) {
    snapshot = await readDocumentSnapshot(orgId, snapshotId).catch(() => null);
    if (snapshot) {
      let nextSnapshot: JsonObject = {
        ...snapshot,
        outputs: { ...asObject(snapshot.outputs), [outputKey]: value },
        status,
        evidence: { ...asObject(snapshot.evidence), [outputKey]: evidence },
        // Solidified choices must reach the snapshot too: receivables price
        // from "what the customer saw and signed", which is the snapshot.
        ...(solidifiedOptionId || solidifiedSelections ? { params: cloneJson(params) } : {}),
        updated_at: now
      };
      // Hybrid customer experiences intentionally build the final document
      // from the preceding workflow. Until the required outputs are signed,
      // re-resolve the sent snapshot after a selection so the document stage
      // reflects the customer's just-solidified scope instead of the stale
      // pre-workflow preview.
      const presentation = normalizeCustomerDocumentPresentation(
        asObject(updated.metadata).customer_presentation,
        cleanText(updated.document_type)
      );
      if ((solidifiedOptionId || solidifiedSelections) && presentation.mode === "hybrid" && !signedNow) {
        const refreshed = await resolveDocumentInstance(orgId, updated, {
          target: "static",
          snapshot: { ...snapshot, public_token: cleanText(snapshot.public_token) }
        });
        nextSnapshot = {
          ...nextSnapshot,
          resolved_definition: cloneJson(refreshed.resolved_definition),
          widget_data: cloneJson(refreshed.widget_data),
          sources: cloneJson(refreshed.sources || {}),
          theme: cloneJson(refreshed.theme),
          theme_vars: cloneJson(refreshed.theme_vars),
          params: cloneJson(params)
        };
      }
      snapshot = await saveDocumentSnapshot(orgId, snapshotId, nextSnapshot);
    }
  }
  await recordDocumentEvent(orgId, updated, "document.output.recorded", {
    output_key: outputKey,
    output_type: cleanText(def.type),
    snapshot_id: snapshotId,
    ...(solidifiedOptionId ? { option_id: solidifiedOptionId, solidified: true } : {})
  }, ctx);
  if (cleanText(def.type) === "payment") {
    await recordDocumentEvent(orgId, updated, "document.payment.received", {
      output_key: outputKey,
      snapshot_id: snapshotId,
      ...(cleanText(asObject(value).payment_id) ? { payment_id: cleanText(asObject(value).payment_id) } : {})
    }, ctx);
  }
  if (signedNow && !wasSigned) {
    await recordDocumentEvent(orgId, updated, "document.signed", { snapshot_id: snapshotId, output_key: outputKey }, ctx);
  }
  if (completedNow && cleanText(document.status) !== "completed" && status === "completed") {
    await recordDocumentEvent(orgId, updated, "document.completed", { snapshot_id: snapshotId }, ctx);
  }
  await syncProjectSignatureRequirements(orgId, cleanText(updated.project_id)).catch(() => null);
  return { document: updated, snapshot, status };
}

export async function recordPublicDocumentView(publicToken: string, input: JsonObject, audit: JsonObject = {}) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const now = nowIso();
  const snapshot = found.snapshot;
  const documentId = cleanText(snapshot.document_id);
  const document = await readDocumentInstance(found.orgId, documentId);
  const delivery = deliveryState(document.delivery);
  const status = advanceStatus(document.status, "viewed");
  const updated = await saveDocumentInstance(found.orgId, documentId, {
    ...document,
    status,
    delivery: {
      ...delivery,
      first_viewed_at: delivery.first_viewed_at || now,
      last_viewed_at: now
    },
    updated_at: now
  });
  const nextSnapshot = await saveDocumentSnapshot(found.orgId, cleanText(snapshot.id), {
    ...snapshot,
    status,
    first_viewed_at: cleanText(snapshot.first_viewed_at) || now,
    last_viewed_at: now,
    updated_at: now
  });
  if (cleanText(document.status) !== "viewed" && status === "viewed") {
    await recordDocumentEvent(found.orgId, updated, "document.viewed", {
      snapshot_id: cleanText(snapshot.id),
      session_id: cleanText(input.session_id),
      public: true,
      evidence: outputEvidence(asObject(input.metadata), audit, now)
    }, null);
  }
  return { orgId: found.orgId, document: updated, snapshot: nextSnapshot };
}

/**
 * Authoritative conditional-pricing evaluation for a checkout state (spec
 * 10.4): runs the same two-pass row evaluation as document resolution over
 * the given params, returning the flat rows, the conditional inventory, and
 * retotaled subtotal/tax/total. Both the public pricing preview and the mock
 * deposit/payment path go through here — client totals are never trusted.
 */
export async function documentCheckoutPricing(
  orgId: string,
  documentValue: JsonObject,
  paramsValue: JsonObject,
  checkoutInput: unknown
) {
  const params = asObject(paramsValue);
  const entities = await documentScopeEntities(orgId, documentValue, params)
    .catch(() => ({ project: {} as JsonObject, customer: {} as JsonObject, org: {} as JsonObject }));
  const checkout = normalizedCheckout(checkoutInput);
  const scope: JsonObject = {
    params,
    outputs: asObject(documentValue.outputs),
    checkout,
    doc: documentDocScope(documentValue),
    org: entities.org,
    project: entities.project,
    customer: entities.customer,
    now: nowIso(),
    computed: {}
  };
  const priced = enrichConditionalRows(asArray(params.scope_items), scope);
  // Seeded pricing adjustments (ACH discount / card fee / early-signing
  // discount) retotal alongside the scope rows; their percent formulas
  // reference the scope base subtotal, matching enrichLineItemParams.
  const adjustments = enrichConditionalRows(asArray(params.pricing_adjustments), scope, {
    formulaBaseCents: priced.base_subtotal_cents
  });
  // Totals mirror the seeded computed chain: subtotal = effective row sum
  // (conditional rows + adjustments included), tax from params.tax_percent,
  // total = both.
  const taxPercent = Number(params.tax_percent) || 0;
  const subtotalCents = priced.total_cents + adjustments.total_cents;
  const taxCents = Math.round(subtotalCents * taxPercent / 100);
  return {
    checkout,
    rows: [...priced.rows, ...adjustments.rows],
    conditional_rows: [...priced.conditional_rows, ...adjustments.conditional_rows],
    totals: {
      base_subtotal_cents: priced.base_subtotal_cents,
      subtotal_cents: subtotalCents,
      adjustments_cents: adjustments.total_cents,
      tax_cents: taxCents,
      total_cents: subtotalCents + taxCents
    }
  };
}

/**
 * Public pricing preview (POST /public/:token/pricing): evaluates the
 * SNAPSHOT's conditional rows + totals under the supplied checkout scope.
 * The portal pay flow calls this when the customer flips payment method —
 * this response is the authoritative preview and the basis for the
 * mock-payment/deposit amount.
 */
export async function publicDocumentPricingPreview(publicToken: string, input: JsonObject) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const document = await readDocumentInstance(found.orgId, cleanText(found.snapshot.document_id));
  const pricing = await documentCheckoutPricing(found.orgId, document, asObject(found.snapshot.params), asObject(input.checkout));
  return {
    orgId: found.orgId,
    document_id: cleanText(document.id),
    snapshot_id: cleanText(found.snapshot.id),
    ...pricing
  };
}

export async function publicDocumentPaymentSummary(orgId: string, documentValue: JsonObject) {
  const projectId = cleanText(documentValue.project_id);
  if (!projectId) return null;
  const obligations = await listProjectObligations(orgId, projectId, { skipFlag: true }).catch(() => [] as JsonObject[]);
  const inbound = obligations.filter((item) => cleanText(item.direction || "inbound") !== "outbound");
  if (!inbound.length) return null;
  const totalCents = inbound.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amount_cents || 0))), 0);
  const paidCents = inbound.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.allocated_cents || 0))), 0);
  return {
    currency: "USD",
    total_cents: totalCents,
    paid_cents: paidCents,
    due_cents: Math.max(0, totalCents - paidCents),
    obligations: inbound.map((item) => ({
      id: cleanText(item.id),
      label: cleanText(item.label || "Payment"),
      amount_cents: Math.max(0, Math.round(Number(item.amount_cents || 0))),
      allocated_cents: Math.max(0, Math.round(Number(item.allocated_cents || 0))),
      balance_due_cents: Math.max(0, Math.round(Number(item.amount_cents || 0)) - Math.round(Number(item.allocated_cents || 0))),
      due_at: cleanText(item.due_at),
      status: cleanText(item.status)
    }))
  };
}

export function publicSnapshotView(snapshot: JsonObject, token: string) {
  return {
    id: cleanText(snapshot.id),
    document_id: cleanText(snapshot.document_id),
    document_type: cleanText(snapshot.document_type),
    title: cleanText(snapshot.title || "Document"),
    status: cleanText(snapshot.status || "sent"),
    snapshot_number: Number(snapshot.snapshot_number || 0),
    resolved_definition: asObject(snapshot.resolved_definition),
    widget_data: asObject(snapshot.widget_data),
    sources: asObject(snapshot.sources),
    theme: asObject(snapshot.theme),
    theme_vars: asObject(snapshot.theme_vars),
    params: asObject(snapshot.params),
    output_defs: asObject(snapshot.output_defs),
    outputs: asObject(snapshot.outputs),
    pdf_url: token ? `/v1/documents/public/${encodeURIComponent(token)}/pdf` : "",
    portal_url: publicDocumentPortalUrl(token),
    created_at: cleanText(snapshot.created_at),
    updated_at: cleanText(snapshot.updated_at)
  };
}

// ---------------------------------------------------------------------------
// Workflow layer (contract §8): definition + state riding on the instance.
// Workflow state IS the document instance's params/outputs — steps only track
// navigation; writes flow through the existing PATCH params / outputs routes.
// ---------------------------------------------------------------------------

function normalizedWorkflowState(documentValue: JsonObject) {
  const state = asObject(documentValue.workflow_state);
  return {
    current_step: cleanText(state.current_step),
    completed_steps: asArray(state.completed_steps).map(cleanText).filter(Boolean)
  };
}

/**
 * Audience filtering for a workflow definition: steps must declare the
 * audience (default: internal-only) and survive the audience's hide_steps
 * list. Customer payloads keep only their own audience config so internal
 * staging details never leak into the portal.
 */
export function filterWorkflowForAudience(definition: JsonObject, audience: "internal" | "customer" | "field") {
  const audiences = asObject(definition.audiences);
  const audienceConfig = asObject(audiences[audience]);
  const hidden = new Set(asArray(audienceConfig.hide_steps).map(cleanText).filter(Boolean));
  const steps = asArray(definition.steps).map(asObject).filter((step) => {
    if (hidden.has(cleanText(step.id))) return false;
    const declared = asArray(step.audience).map(cleanText).filter(Boolean);
    const allowed = declared.length ? declared : ["internal"];
    return allowed.includes(audience);
  });
  return { ...definition, steps, audiences: { [audience]: audienceConfig } };
}

async function workflowSourcesFor(orgId: string, documentValue: JsonObject, definition: JsonObject) {
  const entities = await documentScopeEntities(orgId, documentValue, asObject(documentValue.params));
  const ctx: WidgetResolveContext = {
    organizationId: orgId,
    document: documentValue,
    params: asObject(documentValue.params),
    project: entities.project,
    services: widgetServices()
  };
  return await resolveSourcesFor(ctx, [definition]);
}

/** Internal workflow view: pinned definition + navigation state + contract. */
export async function documentWorkflowDetail(orgId: string, documentId: string) {
  const document = await readDocumentInstance(orgId, documentId);
  const ref = asObject(document.workflow_ref);
  if (!cleanText(ref.workflow_id)) {
    throw notFound("document_workflow_not_found", "This document has no workflow attached.");
  }
  const rawDefinition = await workflowDefinitionForDocument(orgId, document);
  if (!rawDefinition) {
    throw notFound("document_workflow_not_found", "The document's workflow version was not found.");
  }
  const definition = filterWorkflowByCapabilities(rawDefinition, await documentCapabilityState(orgId));
  const sources = await workflowSourcesFor(orgId, document, definition).catch(() => ({}));
  return {
    document,
    workflow_ref: { workflow_id: cleanText(ref.workflow_id), version: Number(ref.version || 0) || null },
    definition,
    state: normalizedWorkflowState(document),
    contract: asObject(definition.contract),
    sources
  };
}

/** Update workflow navigation state (current step / completions). */
export async function updateDocumentWorkflowState(orgId: string, documentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const document = await readDocumentInstance(orgId, documentId);
  const expectedRevision = Number(input.expected_revision || 0);
  if (expectedRevision && expectedRevision !== Number(document.revision || 0)) {
    throw conflict("document_revision_conflict", "Document revision does not match.");
  }
  const rawDefinition = await workflowDefinitionForDocument(orgId, document);
  if (!rawDefinition) {
    throw notFound("document_workflow_not_found", "This document has no workflow attached.");
  }
  const definition = filterWorkflowByCapabilities(rawDefinition, await documentCapabilityState(orgId));
  const steps = asArray(definition.steps).map(asObject);
  const stepIds = steps.map((step) => cleanText(step.id)).filter(Boolean);
  const requireStep = (id: string) => {
    if (!stepIds.includes(id)) {
      throw badRequest("document_workflow_step_unknown", `The workflow does not declare a step named '${id}'.`);
    }
  };
  const state = normalizedWorkflowState(document);
  let currentStep = state.current_step;
  let completed = [...state.completed_steps];
  if (Object.prototype.hasOwnProperty.call(input, "completed_steps")) {
    completed = asArray(input.completed_steps).map(cleanText).filter(Boolean);
    completed.forEach(requireStep);
  }
  const completeStep = cleanText(input.complete_step);
  if (completeStep) {
    requireStep(completeStep);
    if (!completed.includes(completeStep)) completed.push(completeStep);
    const nextIndex = stepIds.indexOf(completeStep) + 1;
    if (nextIndex > 0 && nextIndex < stepIds.length) currentStep = stepIds[nextIndex] || currentStep;
  }
  const explicitCurrent = cleanText(input.current_step);
  if (explicitCurrent) {
    requireStep(explicitCurrent);
    currentStep = explicitCurrent;
  }
  if (!currentStep && stepIds.length) currentStep = stepIds[0] || "";
  const workflowState = { current_step: currentStep, completed_steps: completed };

  // generate_document items: completing a step that carries one mints the
  // configured document ONCE and records its ref on this document's outputs
  // (the receipt / follow-up-document case). Idempotent per writes key;
  // generation failures never block workflow navigation.
  const newlyCompleted = completed.filter((id) => !state.completed_steps.includes(id));
  const outputs = { ...asObject(document.outputs) };
  let outputsChanged = false;
  const generatedRefs: JsonObject[] = [];
  for (const step of steps) {
    if (!newlyCompleted.includes(cleanText(step.id))) continue;
    for (const rawItem of asArray(step.items).map(asObject)) {
      if (cleanText(rawItem.kind) !== "generate_document") continue;
      const writes = cleanText(rawItem.writes);
      const key = writes.startsWith("outputs.") ? (writes.slice("outputs.".length).split(/[.[]/)[0] || "") : "";
      if (!key) continue;
      if (cleanText(asObject(outputs[key]).document_id)) continue;
      const config = asObject(rawItem.config);
      try {
        const created = await createDocumentInstance(orgId, cleanText(document.project_id), {
          document_type: cleanText(config.document_type) || "generic",
          ...(cleanText(config.template_id) ? { template_id: cleanText(config.template_id) } : {}),
          workflow_id: cleanText(config.workflow_id) || "",
          title: cleanText(config.title) || `${cleanText(rawItem.label) || "Generated document"} — ${cleanText(document.title) || "Document"}`,
          params: {
            ...(config.copy_params === false ? {} : asObject(document.params)),
            source_document_id: cleanText(document.id)
          },
          metadata: { generated_by: { document_id: cleanText(document.id), step_id: cleanText(step.id), item_kind: "generate_document" } }
        }, ctx);
        const generatedDoc = asObject(asObject(created).document);
        const ref = {
          document_id: cleanText(generatedDoc.id),
          document_type: cleanText(generatedDoc.document_type),
          title: cleanText(generatedDoc.title),
          generated_at: nowIso()
        };
        outputs[key] = ref;
        outputsChanged = true;
        generatedRefs.push({ ...ref, step_id: cleanText(step.id) });
      } catch (error) {
        await recordDocumentEvent(orgId, document, "document.workflow.generate_failed", {
          step_id: cleanText(step.id),
          message: error instanceof Error ? error.message : String(error)
        }, ctx, { emit: false }).catch(() => null);
      }
    }
  }

  const updated = await saveDocumentInstance(orgId, documentId, {
    ...document,
    ...(outputsChanged ? { outputs } : {}),
    workflow_state: workflowState,
    updated_by_user_id: ctx.userId,
    updated_at: nowIso()
  }, { expectedRevision: expectedRevision || undefined });
  await recordDocumentEvent(orgId, updated, "document.workflow.updated", {
    current_step: currentStep,
    completed_steps: completed,
    ...(generatedRefs.length ? { generated_documents: generatedRefs } : {})
  }, ctx, { emit: false });
  return { document: updated, state: workflowState };
}

/**
 * Public (token) workflow view for the portal wizard: the CUSTOMER-audience
 * filtered definition + state. Documents without a workflow 404 so the portal
 * can fall back to the plain snapshot experience.
 */
export async function publicDocumentWorkflowDefinition(publicToken: string) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const document = await readDocumentInstance(found.orgId, cleanText(found.snapshot.document_id));
  const ref = asObject(document.workflow_ref);
  if (!cleanText(ref.workflow_id)) {
    throw notFound("document_workflow_not_found", "This document has no workflow attached.");
  }
  const definition = await workflowDefinitionForDocument(found.orgId, document);
  if (!definition) {
    throw notFound("document_workflow_not_found", "The document's workflow version was not found.");
  }
  const capabilityState = publicDocumentCapabilityState(await documentCapabilityState(found.orgId));
  const filtered = filterWorkflowByCapabilities(filterWorkflowForAudience(definition, "customer"), capabilityState);
  const sources = await workflowSourcesFor(found.orgId, document, filtered).catch(() => ({}));
  return {
    orgId: found.orgId,
    document,
    workflow_ref: { workflow_id: cleanText(ref.workflow_id), version: Number(ref.version || 0) || null },
    definition: filtered,
    state: normalizedWorkflowState(document),
    contract: asObject(definition.contract),
    params: asObject(document.params),
    outputs: asObject(document.outputs),
    sources,
    capabilities: capabilityState.effectiveByKey
  };
}

/**
 * Public payment-intake config over a DOCUMENT token (the document twin of
 * the proposals public intake-config route). The portal's doc-widget checkout
 * only ever talks to the documents public API, so the org — and the customer
 * whose saved methods should surface — resolve from the document token. When
 * no provider is configured (or anything fails) this answers provider:null
 * and the portal keeps the legacy mock flow untouched.
 */
export async function publicDocumentPaymentIntakeConfig(publicToken: string) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const empty = { provider: null as string | null, tokenization: null, surcharge: null, saved_methods: [] as JsonObject[] };
  try {
    const document = await readDocumentInstance(found.orgId, cleanText(found.snapshot.document_id));
    const entities = await documentScopeEntities(found.orgId, document, asObject(document.params))
      .catch(() => ({ project: {} as JsonObject, customer: {} as JsonObject, org: {} as JsonObject }));
    const customer = asObject(entities.customer);
    const contactRef = {
      ...(cleanText(customer.id) ? { id: cleanText(customer.id) } : {}),
      ...(cleanText(customer.email) ? { email: cleanText(customer.email).toLowerCase() } : {})
    };
    const { paymentIntakeConfig } = await import("../payments/intake.js");
    return await paymentIntakeConfig(found.orgId, contactRef, cleanText(document.branch_id || "default") || "default");
  } catch {
    return empty;
  }
}

/** Provider tokenization over a DOCUMENT token (mock providers tokenize server-side). */
export async function publicDocumentPaymentMethodIntent(publicToken: string, input: JsonObject) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const { getPaymentProvider } = await import("../payments/providers/index.js");
  const provider = await getPaymentProvider(found.orgId).catch(() => null);
  if (!provider) {
    throw badRequest("merchant_not_configured", "Online card processing is not available for this organization.");
  }
  const { tokenizePaymentMethod } = await import("../payments/intake.js");
  return await tokenizePaymentMethod(found.orgId, provider, {
    type: cleanText(input.type),
    card: asObject(input.card),
    bank: asObject(input.bank),
    billing_details: asObject(input.billing_details)
  });
}

export async function publicDocumentWorkflow(publicToken: string) {
  const found = await findPublicDocumentSnapshot(publicToken);
  const document = await readDocumentInstance(found.orgId, cleanText(found.snapshot.document_id));
  const capabilityState = publicDocumentCapabilityState(await documentCapabilityState(found.orgId));
  const paymentSummary = documentCapabilityEnabled(capabilityState, DOCUMENT_CAPABILITIES.payments)
    ? await publicDocumentPaymentSummary(found.orgId, document).catch(() => null)
    : null;
  return {
    orgId: found.orgId,
    snapshot: {
      ...found.snapshot,
      resolved_definition: filterDocumentDefinitionByCapabilities(asObject(found.snapshot.resolved_definition), capabilityState),
      output_defs: filterOutputDefinitionsByCapabilities(asObject(found.snapshot.output_defs), capabilityState)
    } as JsonObject,
    document,
    capabilities: capabilityState.effectiveByKey,
    workflow: {
      ...(paymentSummary ? { payment_summary: paymentSummary } : {})
    }
  };
}

export { listProjectDocuments, readDocumentInstance };
