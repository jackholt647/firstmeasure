// Feedback system service: composes and sends review invitations, resolves
// company branding for the public rating page, records ratings back onto the
// project (custom_fields.feedback_rating → stats attr, automations, and
// commission logic all read it), and emits feedback.* work events so scope
// sets can chain further automations off every step.

import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import { sendCommunication } from "../messaging/communications_service.js";
import { sendCommunicationSchema } from "../messaging/schemas.js";
import { badRequest, notFound } from "../platform/errors.js";
import {
  readBranchModule,
  readDocument,
  readGlobal,
  readOrganization,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { createPublicLink, publicLinkUrl } from "../public-links/service.js";
import { emitWorkEvent } from "../work/engine.js";
import {
  asArray,
  asObject,
  cleanText,
  ensureFeedbackRequestRecord,
  findFeedbackRequestByToken,
  listFeedbackRequestRecords,
  patchFeedbackRequestRecord,
  readFeedbackRequestRecord,
  readFeedbackSettings,
  writeFeedbackSettings,
  type EnsureFeedbackRequestInput
} from "./storage.js";

export { readFeedbackSettings, writeFeedbackSettings, listFeedbackRequestRecords };

// ── Project helpers ─────────────────────────────────────────────────────────

function projectPrimaryContact(project: JsonObject) {
  const contacts = asArray(project.contacts).map(asObject);
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary") || contacts[0] || {};
  const customer = asObject(project.customer);
  return {
    id: cleanText(primary.id || primary.contact_id || customer.id || customer.contact_id || project.contact_id),
    name: cleanText(primary.name || customer.name || project.customer_name || project.customerName || project.primary_contact_name),
    phone: cleanText(primary.phone || asArray(primary.phones)[0] || customer.phone || project.customer_phone || project.primary_contact_phone),
    email: cleanText(primary.email || customer.email || project.customer_email || project.primary_contact_email).toLowerCase()
  };
}

function projectTitle(project: JsonObject) {
  return cleanText(project.title || project.project_title || project.name || project.address || "your project") || "your project";
}

// ── Branding ────────────────────────────────────────────────────────────────

function brandColor(fallback: string, ...values: unknown[]) {
  for (const value of values) {
    let text = cleanText(value);
    if (!text) continue;
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(text)) return text.toUpperCase();
  }
  return fallback;
}

function brandingLogoUrl(branding: JsonObject, orgId: string) {
  for (const value of [branding.logo, branding.logo_node_url, branding.logo_url, branding.logoUrl]) {
    const logo = cleanText(value);
    if (!logo) continue;
    if (/^https?:\/\//i.test(logo) || logo.startsWith("/")) return logo;
    if (logo.startsWith("organizations/")) return `/v1/platform/${logo}`;
  }
  const mediaId = cleanText(branding.logo_media_id || branding.logoMediaId);
  if (mediaId) return `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/logo`;
  return "";
}

export async function feedbackBranding(orgId: string, branchId: string) {
  const [organization, global] = await Promise.all([
    readOrganization(orgId).catch(() => ({} as JsonObject)),
    readGlobal(orgId).catch(() => null)
  ]);
  const globalData = asObject(global?.data);
  let branding = { ...asObject(organization.branding), ...asObject(globalData.branding) };
  const normalizedBranch = cleanText(branchId) || "default";
  try {
    const branch = await readDocument(orgId, "branch", normalizedBranch);
    const branchBranding = asObject(asObject(branch.data).branding);
    branding = { ...branding, ...branchBranding, colors: { ...asObject(branding.colors), ...asObject(branchBranding.colors) } };
  } catch { /* branch branding is optional */ }
  try {
    const style = await readBranchModule(orgId, normalizedBranch, "presentation_style");
    const styleBranding = asObject(asObject(style.data).branding);
    branding = { ...branding, ...styleBranding, colors: { ...asObject(branding.colors), ...asObject(styleBranding.colors) } };
  } catch { /* presentation style is optional */ }
  const colors = asObject(branding.colors);
  return {
    company_name: cleanText(organization.name || globalData.name) || "Our team",
    logo: brandingLogoUrl(branding, orgId),
    colors: {
      primary: brandColor("#2563EB", colors.primary, branding.primary, colors.accent, branding.accent),
      secondary: brandColor("#111111", colors.secondary, branding.secondary)
    }
  };
}

// ── Link + merge fields ─────────────────────────────────────────────────────

export function feedbackPublicUrl(token: string, baseUrl = "") {
  return publicLinkUrl(token, baseUrl);
}

function firstName(value: string) {
  return cleanText(value).split(/\s+/)[0] || "";
}

function mergeFields(template: string, vars: Record<string, string>) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] ?? "" : match
  )).trim();
}

// ── Requests: ensure + send ─────────────────────────────────────────────────

export async function ensureFeedbackRequest(orgId: string, input: EnsureFeedbackRequestInput) {
  const projectDocument = await readDocument(orgId, "projects", cleanText(input.project_id));
  const project = { id: projectDocument.id, ...asObject(projectDocument.data) };
  const contact = projectPrimaryContact(project);
  let ensured = await ensureFeedbackRequestRecord(orgId, {
    ...input,
    branch_id: cleanText(input.branch_id || (project as JsonObject).branch_id as string) || "default",
    contact
  });
  const requestData = asObject(ensured.document.data);
  if (!cleanText(requestData.public_link_id)) {
    const link = await createPublicLink(orgId, {
      kind: "feedback",
      resource_type: "feedback_request",
      resource_id: ensured.document.id,
      destination_path: "/v1/feedback/public/{token}/app",
      allowed_actions: ["view", "rate", "review_click"],
      metadata: { source: "feedback_system", project_id: project.id }
    });
    const linkedDocument = await patchFeedbackRequestRecord(orgId, ensured.document.id, {
      // Kept on the private request record so invitations can be resent. The
      // public_links record itself stores only a SHA-256 hash of this credential.
      public_token: link.token,
      public_link_id: link.document.id
    });
    ensured = { ...ensured, document: linkedDocument };
  }
  if (ensured.created) {
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: cleanText(asObject(ensured.document.data).branch_id),
      project_id: project.id,
      type: "feedback.request.created",
      payload: { request_id: ensured.document.id },
      idempotency_key: `feedback.request.created:${ensured.document.id}`
    });
  }
  return ensured;
}

export type SendFeedbackRequestOptions = {
  channels?: string[];
  message_overrides?: JsonObject;
  base_url?: string;
  source?: JsonObject;
  resend?: boolean;
};

export async function sendFeedbackRequest(orgId: string, requestId: string, options: SendFeedbackRequestOptions = {}) {
  const document = await readFeedbackRequestRecord(orgId, requestId);
  const data = asObject(document.data);
  const branchId = cleanText(data.branch_id) || "default";
  const { settings } = await readFeedbackSettings(orgId, branchId);
  if (settings.enabled === false) return { skipped: true, reason: "feedback_disabled" };
  const previousSends = asArray(data.sends).map(asObject);
  if (previousSends.length && options.resend !== true) {
    return { skipped: true, reason: "already_sent", request_id: requestId };
  }

  const projectDocument = await readDocument(orgId, "projects", cleanText(data.project_id));
  const project = { id: projectDocument.id, ...asObject(projectDocument.data) };
  const contact = projectPrimaryContact(project);
  const branding = await feedbackBranding(orgId, branchId);
  const link = feedbackPublicUrl(cleanText(data.public_token), options.base_url);
  const vars = {
    customer_name: contact.name || "there",
    customer_first_name: firstName(contact.name) || "there",
    company_name: branding.company_name,
    project_title: projectTitle(project),
    link
  };

  const configuredChannels = asObject(settings.channels);
  const requested = asArray(options.channels).map((entry) => cleanText(entry).toLowerCase()).filter(Boolean);
  const useSms = (requested.length ? requested.includes("sms") : configuredChannels.sms !== false) && !!contact.phone;
  const useEmail = (requested.length ? requested.includes("email") : configuredChannels.email !== false) && !!contact.email;
  const usePortal = requested.length ? requested.includes("portal") : configuredChannels.portal === true;
  if (!useSms && !useEmail && !usePortal) {
    return { skipped: true, reason: "no_reachable_channel", request_id: requestId };
  }

  // Per-run overrides let a scope-set automation own its copy without changing
  // the branch defaults used by every other feedback request.
  const messages = { ...asObject(settings.messages), ...asObject(options.message_overrides) };
  const now = new Date().toISOString();
  const sends: JsonObject[] = [];

  if (useSms) {
    const parsed = sendCommunicationSchema.parse({
      channel: "sms",
      purpose: "customer_care",
      branch_id: branchId,
      recipients: [{ address: contact.phone, name: contact.name, contact_id: contact.id, project_id: project.id }],
      content: { text: mergeFields(cleanText(messages.sms_text), vars) },
      context: { project_id: project.id },
      source: { type: "automation", automation_id: "feedback.requestReview.v1", ...asObject(options.source) },
      tags: ["feedback_request"],
      idempotency_key: `feedback_sms:${requestId}:${previousSends.length}`
    });
    const result = await sendCommunication(orgId, parsed, { branchId });
    sends.push({ channel: "sms", at: now, message_id: cleanText(asObject(asObject(result).message).id), to: contact.phone });
  }

  if (useEmail) {
    const emailResult = await sendOrganizationTransactionalEmail({
      organizationId: orgId,
      branchId,
      to: contact.email,
      subject: mergeFields(cleanText(messages.email_subject), vars),
      textBody: mergeFields(cleanText(messages.email_body), vars),
      purpose: "customer_care",
      projectId: cleanText(project.id),
      tags: ["feedback_request"],
      source: { type: "automation", automation_id: "feedback.requestReview.v1", ...asObject(options.source) },
      metadata: { feedback_request_id: requestId },
      idempotencyKey: `feedback_email:${requestId}:${previousSends.length}`
    });
    sends.push({ channel: "email", at: now, to: contact.email, delivered: emailResult.success !== false });
  }

  if (usePortal) {
    // The portal reads the project request directly; recording availability as
    // a send keeps response reporting and resend/idempotency behavior aligned.
    sends.push({ channel: "portal", at: now, delivered: true });
  }

  await patchFeedbackRequestRecord(orgId, requestId, {
    status: "sent",
    sends: [...previousSends, ...sends],
    delivery_channels: [useSms ? "sms" : "", useEmail ? "email" : "", usePortal ? "portal" : ""].filter(Boolean),
    message_overrides: asObject(options.message_overrides),
    contact,
    last_sent_at: now
  });

  await emitWorkEvent({
    organization_id: orgId,
    branch_id: branchId,
    project_id: project.id,
    type: "feedback.request.sent",
    payload: {
      request_id: requestId,
      channels: sends.map((send) => cleanText(send.channel)),
      link
    },
    context: asObject(options.source),
    idempotency_key: `feedback.request.sent:${requestId}:${previousSends.length}`
  });

  return { ok: true, request_id: requestId, sends, link };
}

export async function requestProjectFeedback(orgId: string, input: EnsureFeedbackRequestInput & SendFeedbackRequestOptions) {
  const ensured = await ensureFeedbackRequest(orgId, input);
  const sent = await sendFeedbackRequest(orgId, ensured.document.id, input);
  return { request_id: ensured.document.id, created: ensured.created, ...sent };
}

// Built-in delivery timing is intentionally narrow. The default "workflow"
// mode remains under the scope/automation engine's control; these opt-in modes
// turn well-defined work events into one idempotent feedback request.
export async function handleFeedbackDeliveryEvent(event: JsonObject) {
  const orgId = cleanText(event.organization_id);
  const projectId = cleanText(event.project_id);
  if (!orgId || !projectId) return { skipped: true, reason: "missing_scope" };
  const branchId = cleanText(event.branch_id) || "default";
  const { settings } = await readFeedbackSettings(orgId, branchId);
  if (settings.enabled === false) return { skipped: true, reason: "feedback_disabled" };
  const trigger = cleanText(asObject(settings.delivery).trigger) || "workflow";
  const eventType = cleanText(event.type || event.event);
  const payload = asObject(event.payload);
  const matches = trigger === "project_completed"
    ? eventType === "work.plan.completed"
    : trigger === "final_payment"
      ? eventType === "payment.received" && cleanText(payload.payment_kind).toLowerCase() === "final"
      : trigger === "crew_completed"
        ? eventType === "crew.checklist.completed"
        : false;
  if (!matches) return { skipped: true, reason: "delivery_trigger_not_matched" };
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  if (!(await isCapabilityEnabled(orgId, "feedback.review_requests").catch(() => false))) {
    return { skipped: true, reason: "app_flag_disabled" };
  }
  return await requestProjectFeedback(orgId, {
    project_id: projectId,
    branch_id: branchId,
    source_key: `delivery:${trigger}:${projectId}`,
    source: {
      type: "system",
      id: "feedback_delivery_trigger",
      trigger,
      trigger_event_id: cleanText(event.id)
    }
  });
}

// ── Public rating page flows ────────────────────────────────────────────────

function reviewOutcome(settings: JsonObject, rating: number) {
  const review = asObject(settings.review);
  const mode = cleanText(review.mode) || "threshold";
  const threshold = Number(review.threshold) || 4;
  const qualifies = mode === "always" || (mode === "threshold" && rating >= threshold);
  const destinations = asArray(review.destinations).map(asObject)
    .filter((destination) => destination.enabled !== false && cleanText(destination.url));
  const showReview = qualifies && destinations.length > 0;
  // Exactly one closing message ever reaches the customer: the review
  // invitation (when destinations are shown), the private low-rating note, or
  // the default thank-you.
  const message = showReview
    ? cleanText(review.prompt)
    : rating < threshold
      ? cleanText(review.low_note)
      : cleanText(asObject(settings.survey).thank_you);
  return {
    show_review: showReview,
    met_threshold: mode !== "never" && rating >= threshold,
    destinations: showReview ? destinations : [],
    message
  };
}

export async function publicFeedbackView(publicToken: string) {
  const found = await findFeedbackRequestByToken(publicToken);
  const data = asObject(found.document.data);
  const branchId = cleanText(data.branch_id) || "default";
  const [{ settings }, branding] = await Promise.all([
    readFeedbackSettings(found.orgId, branchId),
    feedbackBranding(found.orgId, branchId)
  ]);
  const rating = Number(data.rating) || 0;
  const rated = rating > 0;
  const outcome = rated ? reviewOutcome(settings, rating) : null;
  return {
    branding,
    // low_comment_below lets the page swap in the low-rating comment prompt
    // the moment a below-threshold star is tapped.
    survey: { ...asObject(settings.survey), low_comment_below: Number(asObject(settings.review).threshold) || 4 },
    state: {
      rated,
      rating,
      comment: cleanText(data.comment),
      contact_first_name: firstName(cleanText(asObject(data.contact).name))
    },
    ...(outcome ? { review: outcome, message: outcome.message } : {})
  };
}

export async function recordFeedbackOpen(publicToken: string, audit: JsonObject = {}) {
  const found = await findFeedbackRequestByToken(publicToken);
  const data = asObject(found.document.data);
  if (cleanText(data.opened_at)) return { ok: true, already_opened: true };
  const now = new Date().toISOString();
  await patchFeedbackRequestRecord(found.orgId, found.document.id, {
    opened_at: now,
    status: cleanText(data.status) === "rated" ? "rated" : "opened",
    audit: { ...asObject(data.audit), opened: audit }
  });
  await emitWorkEvent({
    organization_id: found.orgId,
    branch_id: cleanText(data.branch_id),
    project_id: cleanText(data.project_id),
    type: "feedback.request.opened",
    payload: { request_id: found.document.id },
    idempotency_key: `feedback.request.opened:${found.document.id}`
  });
  return { ok: true, already_opened: false };
}

export async function submitFeedbackRating(publicToken: string, input: JsonObject, audit: JsonObject = {}) {
  const found = await findFeedbackRequestByToken(publicToken, "rate");
  const data = asObject(found.document.data);
  const branchId = cleanText(data.branch_id) || "default";
  const { settings } = await readFeedbackSettings(found.orgId, branchId);
  const scale = Number(asObject(settings.survey).scale) || 5;
  const rating = Math.round(Number(input.rating));
  if (!Number.isFinite(rating) || rating < 1 || rating > scale) {
    throw badRequest("invalid_rating", `Rating must be between 1 and ${scale}.`);
  }
  const comment = cleanText(input.comment).slice(0, 4000);
  const now = new Date().toISOString();
  const alreadyRated = Number(data.rating) > 0;

  await patchFeedbackRequestRecord(found.orgId, found.document.id, {
    status: "rated",
    rating,
    rating_scale: scale,
    comment,
    rated_at: cleanText(data.rated_at) || now,
    audit: { ...asObject(data.audit), rated: audit }
  });

  const outcome = reviewOutcome(settings, rating);
  const projectId = cleanText(data.project_id);

  // The rating is a first-class project variable: numeric custom fields flow
  // into the stats warehouse as attr:feedback_rating automatically, and
  // project.feedback.* is addressable from automation conditions, {{template}}
  // interpolation, and commission code sandboxes.
  if (projectId) {
    try {
      const projectDocument = await readDocument(found.orgId, "projects", projectId);
      const projectData = asObject(projectDocument.data);
      await upsertDocument(found.orgId, "projects", {
        id: projectId,
        data: {
          ...projectData,
          custom_fields: {
            ...asObject(projectData.custom_fields),
            feedback_rating: rating,
            feedback_rating_scale: scale
          },
          feedback: {
            ...asObject(projectData.feedback),
            rating,
            scale,
            comment,
            rated_at: cleanText(data.rated_at) || now,
            met_review_threshold: outcome.met_threshold,
            request_id: found.document.id
          },
          updated_at: now
        },
        metadata: projectDocument.metadata
      }, { replace: true });
    } catch { /* the rating record itself is the source of truth; project write is best-effort */ }
  }

  await emitWorkEvent({
    organization_id: found.orgId,
    branch_id: branchId,
    project_id: projectId,
    type: "feedback.rating.recorded",
    payload: {
      request_id: found.document.id,
      rating,
      scale,
      comment,
      met_review_threshold: outcome.met_threshold,
      updated: alreadyRated
    },
    idempotency_key: `feedback.rating.recorded:${found.document.id}:${rating}:${comment.length}`
  });

  return {
    ok: true,
    rating,
    message: outcome.message,
    review: outcome
  };
}

export async function recordFeedbackDestinationClick(publicToken: string, destinationId: string) {
  const found = await findFeedbackRequestByToken(publicToken, "review_click");
  const data = asObject(found.document.data);
  const branchId = cleanText(data.branch_id) || "default";
  const { settings } = await readFeedbackSettings(found.orgId, branchId);
  const destinations = asArray(asObject(settings.review).destinations).map(asObject);
  const destination = destinations.find((entry) => cleanText(entry.id) === cleanText(destinationId));
  if (!destination) throw notFound("feedback_destination_not_found", "Review destination was not found.");
  const now = new Date().toISOString();
  const clicks = asArray(data.destination_clicks).map(asObject);
  await patchFeedbackRequestRecord(found.orgId, found.document.id, {
    destination_clicks: [...clicks, { id: cleanText(destination.id), label: cleanText(destination.label), at: now }]
  });
  await emitWorkEvent({
    organization_id: found.orgId,
    branch_id: branchId,
    project_id: cleanText(data.project_id),
    type: "feedback.review.link_clicked",
    payload: {
      request_id: found.document.id,
      destination_id: cleanText(destination.id),
      destination_label: cleanText(destination.label),
      rating: Number(data.rating) || 0
    },
    idempotency_key: `feedback.review.link_clicked:${found.document.id}:${cleanText(destination.id)}:${clicks.length}`
  });
  return { ok: true, url: cleanText(destination.url) };
}

// ── Summary for the settings page ───────────────────────────────────────────

export async function feedbackRequestSummary(orgId: string, filters: { project_id?: string } = {}) {
  const documents = await listFeedbackRequestRecords(orgId, filters);
  const projectTitles = new Map<string, string>();
  for (const document of documents) {
    const projectId = cleanText(asObject(document.data).project_id);
    if (!projectId || projectTitles.has(projectId)) continue;
    const projectDocument = await readDocument(orgId, "projects", projectId).catch(() => null);
    projectTitles.set(projectId, projectDocument ? projectTitle(asObject(projectDocument.data)) : "");
  }
  const requests = documents.map((document) => {
    const data = asObject(document.data);
    const projectId = cleanText(data.project_id);
    return {
      id: document.id,
      project_id: projectId,
      project_title: projectTitles.get(projectId) || "",
      status: cleanText(data.status),
      contact: asObject(data.contact),
      rating: Number(data.rating) || 0,
      rating_scale: Number(data.rating_scale) || 0,
      comment: cleanText(data.comment),
      sends: asArray(data.sends),
      destination_clicks: asArray(data.destination_clicks),
      last_sent_at: cleanText(data.last_sent_at),
      opened_at: cleanText(data.opened_at),
      rated_at: cleanText(data.rated_at),
      created_at: cleanText(data.created_at)
    };
  });
  const rated = requests.filter((request) => request.rating > 0);
  return {
    requests,
    totals: {
      sent: requests.filter((request) => request.sends.length > 0).length,
      rated: rated.length,
      average_rating: rated.length ? Math.round((rated.reduce((total, request) => total + request.rating, 0) / rated.length) * 100) / 100 : 0,
      review_clicks: requests.reduce((total, request) => total + request.destination_clicks.length, 0)
    }
  };
}
