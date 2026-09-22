import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import {
  deleteDocument,
  listDocuments,
  listOrganizations,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import { getPaymentProvider } from "./providers/index.js";
import {
  declineMessage,
  findSavedMethod,
  normalizeContactRef,
  recordProviderChargedPayment
} from "./intake.js";
import {
  deriveObligationStatus,
  listProjectObligations,
  recordPaymentEvent
} from "./storage.js";

/**
 * Autopay — charge a stored payment method when a payment obligation comes
 * due. Enrollment is per project ("payment_autopay" collection, one record per
 * project), the charge itself reuses the SAME provider charge path the intake
 * modal drives (recordProviderChargedPayment -> createPayment -> allocation ->
 * ledger), and the runner is registered on the shared heartbeat seam the
 * appointment-confirmation scheduler uses (setInterval + env kill switches).
 *
 * Dunning: a declined charge is retried on a later runner pass, at most once
 * per 24h and at most 3 attempts per obligation; the third failure pauses the
 * enrollment. Success and failure both notify the customer through the
 * organization's existing transactional email engine.
 */

export const PAYMENT_AUTOPAY_COLLECTION = "payment_autopay";

export const AUTOPAY_MAX_ATTEMPTS = 3;
export const AUTOPAY_RETRY_SPACING_MS = 24 * 60 * 60 * 1000;
/** An in-flight marker older than this is considered abandoned (crash). */
const AUTOPAY_INFLIGHT_STALE_MS = 15 * 60 * 1000;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function nowIso() {
  return new Date().toISOString();
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function stableId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

/** System actor for runner-driven writes (mirrors PROVIDER_WEBHOOK_CTX). */
export const AUTOPAY_CTX = {
  userId: "system:payment_autopay",
  branchId: "default"
} as unknown as PlatformAuthContext;

function autopayDocId(projectId: string) {
  return `payment_autopay_${stableId(projectId)}`;
}

export function autopayView(record: JsonObject) {
  const status = cleanText(record.status) === "paused" ? "paused" : "active";
  return {
    id: cleanText(record.id),
    project_id: cleanText(record.project_id),
    contact_ref: asObject(record.contact_ref),
    saved_method_id: cleanText(record.saved_method_id),
    method_label: cleanText(record.method_label),
    enrolled_by: cleanText(record.enrolled_by),
    enrolled_at: cleanText(record.enrolled_at),
    status,
    paused_reason: cleanText(record.paused_reason),
    max_amount_cents: Number.isFinite(Number(record.max_amount_cents)) && record.max_amount_cents !== null
      ? Math.max(0, cents(record.max_amount_cents)) || null
      : null,
    last_run_at: cleanText(record.last_run_at),
    failures: asArray(record.failures).map(asObject),
    attempts: asObject(record.attempts),
    created_at: cleanText(record.created_at),
    updated_at: cleanText(record.updated_at)
  };
}

async function readAutopayRecord(orgId: string, projectId: string) {
  const doc = await readDocument(orgId, PAYMENT_AUTOPAY_COLLECTION, autopayDocId(projectId)).catch(() => null);
  return doc ? documentView(doc) : null;
}

async function saveAutopayRecord(orgId: string, record: JsonObject) {
  const doc = await upsertDocument(orgId, PAYMENT_AUTOPAY_COLLECTION, {
    id: cleanText(record.id),
    data: { ...record, updated_at: nowIso() },
    metadata: {
      kind: "payment_autopay",
      project_id: cleanText(record.project_id),
      status: cleanText(record.status),
      saved_method_id: cleanText(record.saved_method_id)
    }
  }, { replace: true });
  return documentView(doc);
}

export async function getProjectAutopay(orgId: string, projectId: string) {
  await requireMoneyFlag(orgId);
  const record = await readAutopayRecord(orgId, projectId);
  return record ? autopayView(record) : null;
}

export type AutopayEnrollInput = {
  saved_method_id?: string;
  contact_ref?: JsonObject;
  max_amount_cents?: number | null;
  status?: string;
};

/**
 * Enroll or update a project's autopay. Enrollment requires the organization
 * to resolve a payment provider and the saved method to exist. Resuming a
 * paused enrollment clears the per-obligation attempt counters so the runner
 * can charge again on its next pass.
 */
export async function upsertProjectAutopay(orgId: string, projectId: string, input: AutopayEnrollInput, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const existing = await readAutopayRecord(orgId, projectId);
  const provider = await getPaymentProvider(orgId).catch(() => null);
  if (!provider) {
    throw badRequest("autopay_provider_required", "Autopay requires a configured payment provider for this organization.");
  }
  const savedMethodId = cleanText(input.saved_method_id) || cleanText(existing?.saved_method_id);
  if (!savedMethodId) throw badRequest("autopay_saved_method_required", "Choose a saved payment method to enroll in autopay.");
  const savedMethod = await findSavedMethod(orgId, savedMethodId);
  if (!savedMethod) throw badRequest("saved_method_not_found", "That saved payment method is no longer available.");
  const contactRef = Object.keys(asObject(input.contact_ref)).length
    ? asObject(input.contact_ref)
    : asObject(existing?.contact_ref);
  const contactKey = normalizeContactRef(contactRef);
  if (contactKey && cleanText(savedMethod.contact_ref) !== contactKey) {
    throw badRequest("autopay_method_contact_mismatch", "That saved payment method belongs to a different customer.");
  }
  const requestedStatus = cleanText(input.status);
  const status = requestedStatus === "paused" ? "paused" : requestedStatus === "active" ? "active" : cleanText(existing?.status) || "active";
  const resuming = cleanText(existing?.status) === "paused" && status === "active";
  const now = nowIso();
  const maxAmount = input.max_amount_cents === undefined
    ? (existing ? existing.max_amount_cents ?? null : null)
    : (input.max_amount_cents === null ? null : Math.max(0, cents(input.max_amount_cents)) || null);
  const record = await saveAutopayRecord(orgId, {
    id: autopayDocId(projectId),
    project_id: projectId,
    contact_ref: contactRef,
    saved_method_id: savedMethodId,
    method_label: cleanText(savedMethod.label),
    enrolled_by: cleanText(existing?.enrolled_by) || ctx.userId,
    enrolled_at: cleanText(existing?.enrolled_at) || now,
    status,
    paused_reason: status === "paused" ? cleanText(existing?.paused_reason) || "manual" : "",
    max_amount_cents: maxAmount,
    last_run_at: cleanText(existing?.last_run_at),
    failures: status === "active" && resuming ? [] : asArray(existing?.failures).map(asObject),
    // Resume (or a method change) resets attempt counters so retries restart.
    attempts: resuming || (existing && savedMethodId !== cleanText(existing.saved_method_id)) ? {} : asObject(existing?.attempts),
    created_at: cleanText(existing?.created_at) || now
  });
  await recordPaymentEvent(orgId, existing ? "autopay.updated" : "autopay.enrolled", {
    project_id: projectId,
    saved_method_id: savedMethodId,
    status,
    ...(maxAmount ? { max_amount_cents: maxAmount } : {})
  }, ctx);
  return autopayView(record);
}

export async function removeProjectAutopay(orgId: string, projectId: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const existing = await readAutopayRecord(orgId, projectId);
  if (!existing) throw notFound("autopay_not_enrolled", "This project is not enrolled in autopay.");
  await deleteDocument(orgId, PAYMENT_AUTOPAY_COLLECTION, autopayDocId(projectId));
  await recordPaymentEvent(orgId, "autopay.unenrolled", { project_id: projectId }, ctx);
  return autopayView(existing);
}

// --- Runner ------------------------------------------------------------------

function attemptState(record: JsonObject, obligationId: string) {
  const attempts = asObject(record.attempts);
  const entry = asObject(attempts[obligationId]);
  return {
    count: Math.max(0, cents(entry.count)),
    last_attempt_at: cleanText(entry.last_attempt_at),
    in_flight_at: cleanText(entry.in_flight_at),
    timestamps: asArray(entry.timestamps).map(cleanText).filter(Boolean)
  };
}

async function patchAttempt(orgId: string, record: JsonObject, obligationId: string, patch: JsonObject | null) {
  const attempts = asObject(record.attempts);
  if (patch === null) delete attempts[obligationId];
  else attempts[obligationId] = { ...asObject(attempts[obligationId]), ...patch };
  record.attempts = attempts;
  return saveAutopayRecord(orgId, record);
}

async function autopayContactEmail(orgId: string, record: JsonObject, projectId: string) {
  const direct = cleanText(asObject(record.contact_ref).email).toLowerCase();
  if (direct) return direct;
  const project = documentView(await readDocument(orgId, "projects", projectId).catch(() => null));
  const contacts = asArray(project.contacts).map(asObject);
  const primary = contacts.find((contact) => contact.primary === true) || contacts.find((contact) => cleanText(contact.email)) || {};
  return cleanText(primary.email || asObject(project.customer).email || project.customer_email).toLowerCase();
}

async function sendAutopayEmail(orgId: string, record: JsonObject, projectId: string, input: {
  subject: string;
  body: string;
  idempotencyKey: string;
  tag: string;
}) {
  const recipient = await autopayContactEmail(orgId, record, projectId).catch(() => "");
  if (!recipient) return { ok: false, skipped: true };
  return sendOrganizationTransactionalEmail({
    organizationId: orgId,
    branchId: "default",
    to: recipient,
    subject: input.subject,
    textBody: input.body,
    htmlBody: `<p>${input.body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`,
    purpose: "billing",
    projectId,
    tags: ["autopay", input.tag],
    source: { type: "system", id: "payment_autopay" },
    idempotencyKey: input.idempotencyKey
  }, AUTOPAY_CTX).catch(() => ({ ok: false }));
}

export type AutopayRunResult = {
  charged: Array<{ project_id: string; obligation_id: string; payment_id: string; amount_cents: number }>;
  failed: Array<{ project_id: string; obligation_id: string; decline_category: string; paused: boolean }>;
  skipped: Array<{ project_id: string; obligation_id?: string; reason: string }>;
};

/**
 * One autopay pass for an organization: charge every due/overdue, unpaid,
 * unheld obligation in actively-enrolled projects through the provider charge
 * path, allocating to the specific obligation. Never double-charges: open
 * balance comes from allocations, and a persisted per-obligation in-flight
 * lock guards the window between charge and record.
 */
export async function runAutopayForOrganization(orgId: string, options: { now?: Date } = {}): Promise<AutopayRunResult> {
  const result: AutopayRunResult = { charged: [], failed: [], skipped: [] };
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) return result;
  const provider = await getPaymentProvider(orgId).catch(() => null);
  if (!provider) return result;
  const now = options.now || new Date();
  const enrollments = (await listDocuments(orgId, PAYMENT_AUTOPAY_COLLECTION)).map(documentView)
    .filter((record) => cleanText(record.status) !== "paused");
  for (const enrollment of enrollments) {
    const projectId = cleanText(enrollment.project_id);
    if (!projectId) continue;
    let record = (await readAutopayRecord(orgId, projectId)) || enrollment;
    if (cleanText(record.status) === "paused") continue;
    const savedMethod = await findSavedMethod(orgId, cleanText(record.saved_method_id));
    if (!savedMethod) {
      result.skipped.push({ project_id: projectId, reason: "saved_method_missing" });
      continue;
    }
    const obligations = (await listProjectObligations(orgId, projectId, { skipFlag: true }).catch(() => []))
      .filter((obligation) => cleanText(obligation.direction) === "inbound")
      .filter((obligation) => ["due", "overdue"].includes(deriveObligationStatus(obligation, now)))
      .filter((obligation) => {
        const metadata = asObject(obligation.metadata);
        return metadata.manual_hold !== true && metadata.autopay_hold !== true;
      });
    for (const obligation of obligations) {
      if (cleanText(record.status) === "paused") break;
      const obligationId = cleanText(obligation.id);
      const open = Math.max(0, cents(obligation.amount_cents) - cents(obligation.allocated_cents));
      if (open <= 0) continue;
      const maxAmount = record.max_amount_cents === null || record.max_amount_cents === undefined
        ? 0
        : Math.max(0, cents(record.max_amount_cents));
      if (maxAmount > 0 && open > maxAmount) {
        result.skipped.push({ project_id: projectId, obligation_id: obligationId, reason: "over_max_amount" });
        continue;
      }
      const attempt = attemptState(record, obligationId);
      const inFlightAt = Date.parse(attempt.in_flight_at);
      if (Number.isFinite(inFlightAt) && now.getTime() - inFlightAt < AUTOPAY_INFLIGHT_STALE_MS) {
        result.skipped.push({ project_id: projectId, obligation_id: obligationId, reason: "charge_in_flight" });
        continue;
      }
      if (attempt.count >= AUTOPAY_MAX_ATTEMPTS) {
        result.skipped.push({ project_id: projectId, obligation_id: obligationId, reason: "attempts_exhausted" });
        continue;
      }
      const lastAttemptAt = Date.parse(attempt.last_attempt_at);
      if (attempt.count > 0 && Number.isFinite(lastAttemptAt)
        && now.getTime() - lastAttemptAt < AUTOPAY_RETRY_SPACING_MS) {
        result.skipped.push({ project_id: projectId, obligation_id: obligationId, reason: "retry_spacing" });
        continue;
      }
      // Persist the in-flight lock BEFORE charging so a concurrent/crashed
      // pass cannot double-charge the same obligation.
      record = await patchAttempt(orgId, record, obligationId, { in_flight_at: now.toISOString() });
      try {
        const charged = await recordProviderChargedPayment(orgId, provider, {
          amount_cents: open,
          saved_method_id: cleanText(record.saved_method_id),
          project_id: projectId,
          branch_id: cleanText(obligation.branch_id || "default") || "default",
          // Autopay charges exactly the obligation's open balance so the
          // allocation satisfies it to the cent; surcharge stays off.
          apply_surcharge: false,
          contact_ref: asObject(record.contact_ref),
          payment: {
            kind: "customer_payment",
            obligation_id: obligationId,
            allocation_mode: "autopay",
            notes: `Autopay charge for ${cleanText(obligation.label) || "scheduled payment"}.`,
            metadata: { autopay: true, autopay_enrollment_id: cleanText(record.id), obligation_id: obligationId }
          }
        }, AUTOPAY_CTX);
        const payment = asObject(charged.payment);
        record = await patchAttempt(orgId, record, obligationId, null);
        record = await saveAutopayRecord(orgId, { ...record, last_run_at: now.toISOString() });
        result.charged.push({
          project_id: projectId,
          obligation_id: obligationId,
          payment_id: cleanText(payment.id),
          amount_cents: cents(payment.amount_cents)
        });
        await recordPaymentEvent(orgId, "autopay.charged", {
          project_id: projectId,
          obligation_id: obligationId,
          payment_id: cleanText(payment.id),
          amount_cents: cents(payment.amount_cents),
          saved_method_id: cleanText(record.saved_method_id)
        }, AUTOPAY_CTX);
        await sendAutopayEmail(orgId, record, projectId, {
          subject: `Payment received — ${cleanText(obligation.label) || "scheduled payment"}`,
          body: `Your automatic payment of $${(cents(payment.amount_cents) / 100).toFixed(2)} for "${cleanText(obligation.label) || "your scheduled payment"}" was charged to ${cleanText(record.method_label) || "your saved payment method"}. Thank you.`,
          idempotencyKey: `autopay_receipt:${cleanText(payment.id)}`,
          tag: "autopay-receipt"
        });
      } catch (error) {
        const platformError = error as { code?: string; details?: JsonObject; message?: string };
        const declineCategory = cleanText(asObject(platformError.details).decline_category)
          || (cleanText(platformError.code) === "payment_declined" ? "generic_decline" : "charge_error");
        const message = cleanText(platformError.message) || declineMessage(declineCategory);
        const nextCount = attempt.count + 1;
        const paused = nextCount >= AUTOPAY_MAX_ATTEMPTS;
        record = await patchAttempt(orgId, record, obligationId, {
          count: nextCount,
          last_attempt_at: now.toISOString(),
          in_flight_at: "",
          timestamps: [...attempt.timestamps, now.toISOString()]
        });
        record = await saveAutopayRecord(orgId, {
          ...record,
          last_run_at: now.toISOString(),
          failures: [
            ...asArray(record.failures).map(asObject),
            { at: now.toISOString(), obligation_id: obligationId, decline_category: declineCategory, message }
          ].slice(-20),
          ...(paused ? { status: "paused", paused_reason: "max_attempts" } : {})
        });
        result.failed.push({ project_id: projectId, obligation_id: obligationId, decline_category: declineCategory, paused });
        await recordPaymentEvent(orgId, "autopay.charge_failed", {
          project_id: projectId,
          obligation_id: obligationId,
          decline_category: declineCategory,
          attempt: nextCount,
          paused
        }, AUTOPAY_CTX);
        if (paused) {
          await recordPaymentEvent(orgId, "autopay.paused", {
            project_id: projectId,
            obligation_id: obligationId,
            reason: "max_attempts"
          }, AUTOPAY_CTX);
        }
        await sendAutopayEmail(orgId, record, projectId, {
          subject: `Automatic payment failed — ${cleanText(obligation.label) || "scheduled payment"}`,
          body: `We could not charge ${cleanText(record.method_label) || "your saved payment method"} for "${cleanText(obligation.label) || "your scheduled payment"}". ${message}${paused ? " Automatic payments are paused for this project — please update your payment method." : " We will retry automatically."}`,
          idempotencyKey: `autopay_failure:${obligationId}:${nextCount}`,
          tag: "autopay-failure"
        });
      }
    }
  }
  return result;
}

// --- Scheduler (same seam as the appointment-confirmation scheduler) --------

let running = false;

export async function runAutopayTick(options: { now?: Date } = {}) {
  if (running) return { organizations: 0, skipped: true };
  running = true;
  try {
    let organizations = 0;
    for (const organization of await listOrganizations()) {
      const orgId = cleanText(asObject(organization).id);
      if (!orgId) continue;
      // Cheap pre-check: only orgs with enrollments do provider work.
      const enrollments = await listDocuments(orgId, PAYMENT_AUTOPAY_COLLECTION).catch(() => []);
      if (!enrollments.length) continue;
      organizations += 1;
      await runAutopayForOrganization(orgId, options).catch(() => null);
    }
    return { organizations, skipped: false };
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
const AUTOPAY_TICK_INTERVAL_MS = 60 * 60 * 1000;

export function startAutopayScheduler() {
  if (timer || process.env.PAYMENT_AUTOPAY_DISABLED === "1" || process.env.PLATFORM_HEARTBEAT_DISABLED === "1") return;
  timer = setInterval(() => void runAutopayTick().catch(() => null), AUTOPAY_TICK_INTERVAL_MS);
  timer.unref?.();
}

export function stopAutopayScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
