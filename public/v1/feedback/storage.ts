// Feedback system storage: normalized branch-module settings plus tokenized
// feedback request records. A feedback request is one customer's invitation to
// rate a completed project; the public token in its data is the only
// credential a customer needs to open the rating page.

import { createHash, randomUUID } from "node:crypto";

import { notFound } from "../platform/errors.js";
import {
  listDocuments,
  readBranchModule,
  readDocument,
  saveBranchModule,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { resolvePublicLink } from "../public-links/service.js";

export const FEEDBACK_COLLECTION = "feedback_requests";
export const FEEDBACK_MODULE_ID = "feedback_system";

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// ── Settings ────────────────────────────────────────────────────────────────

export type FeedbackDestination = {
  id: string;
  label: string;
  url: string;
  icon: string;
  enabled: boolean;
};

const DEFAULT_SMS_TEXT = "Hi {{customer_first_name}}, thanks for choosing {{company_name}}! We'd love to hear how everything went: {{link}}";
const DEFAULT_EMAIL_SUBJECT = "How did we do, {{customer_first_name}}?";
const DEFAULT_EMAIL_BODY = "Hi {{customer_first_name}},\n\nThank you for choosing {{company_name}} for {{project_title}}. We'd really appreciate a moment of your time to tell us how everything went.\n\nShare your experience here: {{link}}\n\nThank you,\nThe {{company_name}} team";
const DEFAULT_PORTAL_TITLE = "How did we do?";
const DEFAULT_PORTAL_BODY = "Tell us how everything went — it only takes a few seconds.";
const DEFAULT_PORTAL_CTA = "Leave feedback";

export function normalizeFeedbackDestination(value: unknown, index = 0): FeedbackDestination {
  const raw = asObject(value);
  const label = cleanText(raw.label || raw.name) || "Review site";
  return {
    id: cleanText(raw.id) || `destination_${index + 1}`,
    label,
    url: cleanText(raw.url || raw.link),
    icon: cleanText(raw.icon) || "fa-star",
    enabled: raw.enabled !== false
  };
}

export function normalizeFeedbackSettings(value: unknown): JsonObject {
  const raw = asObject(value);
  const survey = asObject(raw.survey);
  const review = asObject(raw.review);
  const channels = asObject(raw.channels);
  const messages = asObject(raw.messages);
  const delivery = asObject(raw.delivery);
  const mode = cleanText(review.mode).toLowerCase();
  const trigger = cleanText(delivery.trigger).toLowerCase();
  return {
    enabled: raw.enabled !== false,
    delivery: {
      trigger: ["workflow", "project_completed", "final_payment", "crew_completed", "manual"].includes(trigger) ? trigger : "workflow"
    },
    survey: {
      question: cleanText(survey.question) || "How did we do?",
      scale: clampInt(survey.scale, 3, 10, 5),
      comment_prompt: cleanText(survey.comment_prompt) || "Anything you'd like us to know?",
      // Shown instead of comment_prompt when the selected rating is below the
      // review threshold — pulls specific, actionable detail from unhappy customers.
      low_comment_prompt: cleanText(survey.low_comment_prompt) || "What could we have done better?",
      thank_you: cleanText(survey.thank_you) || "Thank you! Your feedback helps us keep getting better."
    },
    review: {
      // "threshold" shows review destinations at/above review.threshold,
      // "always" shows them for every rating, "never" keeps feedback private.
      mode: mode === "always" || mode === "never" ? mode : "threshold",
      threshold: clampInt(review.threshold, 1, 10, 4),
      prompt: cleanText(review.prompt) || "Would you share your experience? It means the world to a local business.",
      low_note: cleanText(review.low_note) || "Your feedback went straight to our team — thank you for helping us improve.",
      destinations: asArray(review.destinations).map((entry, index) => normalizeFeedbackDestination(entry, index)).slice(0, 8)
    },
    channels: {
      sms: channels.sms !== false,
      email: channels.email !== false,
      portal: channels.portal === true
    },
    messages: {
      sms_text: cleanText(messages.sms_text) || DEFAULT_SMS_TEXT,
      email_subject: cleanText(messages.email_subject) || DEFAULT_EMAIL_SUBJECT,
      email_body: cleanText(messages.email_body) || DEFAULT_EMAIL_BODY,
      portal_title: cleanText(messages.portal_title) || DEFAULT_PORTAL_TITLE,
      portal_body: cleanText(messages.portal_body) || DEFAULT_PORTAL_BODY,
      portal_cta: cleanText(messages.portal_cta) || DEFAULT_PORTAL_CTA
    }
  };
}

export async function readFeedbackSettings(orgId: string, branchId: string) {
  const normalizedBranch = cleanText(branchId) || "default";
  const module = await readBranchModule(orgId, normalizedBranch, FEEDBACK_MODULE_ID).catch(() => (
    normalizedBranch === "default" ? null : readBranchModule(orgId, "default", FEEDBACK_MODULE_ID).catch(() => null)
  ));
  return {
    settings: normalizeFeedbackSettings(asObject(module?.data)),
    revision: Number(module?.revision ?? 0)
  };
}

export async function writeFeedbackSettings(orgId: string, branchId: string, input: JsonObject) {
  const settings = normalizeFeedbackSettings(input);
  const saved = await saveBranchModule(orgId, cleanText(branchId) || "default", FEEDBACK_MODULE_ID, {
    data: settings,
    metadata: { kind: "feedback_system", source: cleanText(input.source) || "company_settings" },
    ...(input.expected_revision ? { expected_revision: input.expected_revision } : {})
  }, { replace: true });
  return { settings: normalizeFeedbackSettings(asObject(saved.data)), revision: Number(saved.revision ?? 0) };
}

// ── Feedback request records ────────────────────────────────────────────────

function requestDocumentId(projectId: string, sourceKey: string) {
  return `feedback_${createHash("sha256").update(`${projectId}:${sourceKey}`).digest("hex").slice(0, 20)}`;
}

export type EnsureFeedbackRequestInput = {
  project_id: string;
  branch_id?: string;
  source_key?: string;
  contact?: JsonObject;
  source?: JsonObject;
  metadata?: JsonObject;
};

export async function ensureFeedbackRequestRecord(orgId: string, input: EnsureFeedbackRequestInput) {
  const projectId = cleanText(input.project_id);
  if (!projectId) throw notFound("feedback_project_required", "A project id is required for a feedback request.");
  const sourceKey = cleanText(input.source_key) || "default";
  const id = requestDocumentId(projectId, sourceKey);
  const existing = await readDocument(orgId, FEEDBACK_COLLECTION, id).catch(() => null);
  if (existing) return { document: existing, created: false };
  const now = new Date().toISOString();
  const document = await upsertDocument(orgId, FEEDBACK_COLLECTION, {
    id,
    data: {
      id,
      project_id: projectId,
      branch_id: cleanText(input.branch_id) || "default",
      source_key: sourceKey,
      public_token: randomUUID(),
      status: "created",
      contact: asObject(input.contact),
      sends: [],
      rating: null,
      rating_scale: 0,
      comment: "",
      opened_at: "",
      rated_at: "",
      destination_clicks: [],
      source: asObject(input.source),
      created_at: now,
      updated_at: now
    },
    metadata: { kind: "feedback_request", ...asObject(input.metadata) }
  });
  return { document, created: true };
}

export async function readFeedbackRequestRecord(orgId: string, requestId: string) {
  return await readDocument(orgId, FEEDBACK_COLLECTION, requestId);
}

export async function listFeedbackRequestRecords(orgId: string, filters: { project_id?: string } = {}) {
  const documents = await listDocuments(orgId, FEEDBACK_COLLECTION).catch(() => []);
  const projectId = cleanText(filters.project_id);
  return documents.filter((document) => !projectId || cleanText(asObject(document.data).project_id) === projectId);
}

export async function patchFeedbackRequestRecord(orgId: string, requestId: string, patch: JsonObject) {
  const document = await readDocument(orgId, FEEDBACK_COLLECTION, requestId);
  return await upsertDocument(orgId, FEEDBACK_COLLECTION, {
    id: requestId,
    data: { ...asObject(document.data), ...patch, updated_at: new Date().toISOString() },
    metadata: document.metadata
  }, { replace: true });
}

export async function findFeedbackRequestByToken(publicToken: string, action = "view") {
  const token = cleanText(publicToken);
  if (!token) throw notFound("feedback_request_not_found", "Feedback request was not found.");
  if (token.startsWith("pl1.")) {
    const resolved = await resolvePublicLink(token, { kind: "feedback", action });
    if (cleanText(resolved.data.resource_type) !== "feedback_request") {
      throw notFound("feedback_request_not_found", "Feedback request was not found.");
    }
    const document = await readDocument(resolved.orgId, FEEDBACK_COLLECTION, cleanText(resolved.data.resource_id));
    return { orgId: resolved.orgId, document };
  }
  // Compatibility for links created before the reusable public-link API.
  const { listOrganizations } = await import("../platform/storage.js");
  const organizations = await listOrganizations();
  for (const organization of organizations) {
    const orgId = cleanText(asObject(organization).id);
    if (!orgId) continue;
    const documents = await listDocuments(orgId, FEEDBACK_COLLECTION).catch(() => []);
    for (const document of documents) {
      if (cleanText(asObject(document.data).public_token) === token) {
        return { orgId, document };
      }
    }
  }
  throw notFound("feedback_request_not_found", "Feedback request was not found.");
}
