/**
 * Punch lists — customer-authored lists of remaining work, with sign-offs on
 * both ends.
 *
 * Contract: docs/customer-portal-v2-spec.md §8.2.
 *
 * THE SHAPE OF THE THING. A punch list is NOT a company checklist the customer
 * can see. The customer writes it:
 *
 *   1. requested      the company asks; the customer walks the job and adds items
 *   2. submitted      the customer signs off "this is everything that's left"
 *   3. work_complete  the company does the work and marks the items done
 *   4. accepted       the customer signs off "yes, these are done"
 *
 * The value is in step 2: the customer committing to a *bounded* list, so the
 * company knows what closing out actually costs. A company-authored list
 * inverts that and loses the point.
 *
 * DATA-DRIVEN THROUGHOUT. Nothing here assumes "one punch list, at the end of
 * the project". Instances are created by the `punchlist.request.v1` work
 * automation, which a scope template can bind to ANY node — so a project can
 * have several, at phase boundaries, concurrent or sequential. Every gate
 * (either signature, whether the customer may add or edit, photo/comment
 * requirements, whether it is required at all) is per-instance config.
 *
 * TERMINOLOGY IS NOT ASSUMED. "Punch list" is not universal across trades, so
 * every customer-visible string resolves through resolvePunchLabels():
 * instance labels -> org defaults -> built-in copy. Nothing user-facing is
 * hardcoded in a renderer.
 *
 * STORAGE. A punch list is a `crew_checklists` row whose `metadata.punch` block
 * exists. That reuses items, attachments, evidence requirements, and the
 * customer item-CRUD routes the portal already has. The `kind` column is
 * deliberately left alone — it is clamped to todo|quality and other code
 * branches on it.
 */

import { badRequest, conflict, forbidden } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function optionalBool(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  const text = cleanText(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function layeredBool(...values: unknown[]) {
  for (const value of values.slice(0, -1)) {
    const resolved = optionalBool(value);
    if (resolved !== undefined) return resolved;
  }
  return values[values.length - 1] === true;
}

export const PUNCH_SCHEMA_VERSION = 1;

export const PUNCH_STATES = ["requested", "submitted", "work_complete", "accepted"] as const;
export type PunchState = (typeof PUNCH_STATES)[number];

function punchState(value: unknown): PunchState {
  const text = cleanText(value).toLowerCase();
  return (PUNCH_STATES as readonly string[]).includes(text) ? (text as PunchState) : "requested";
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Built-in copy. Every string is a fallback, never a hardcode: instance labels
 * and org defaults both override, and `{noun}` interpolates the configured
 * term so an org that calls this a "snag list" or "final walkthrough" reads
 * naturally everywhere without editing each string.
 */
const DEFAULT_LABELS: Record<string, string> = {
  noun: "punch list",
  noun_plural: "punch lists",
  request_title: "Create your {noun}",
  request_body: "Walk the space and add anything you would still like us to take care of. Add a photo or a note to any item so we know exactly what you mean.",
  submit_cta: "Submit my {noun}",
  submit_confirm: "Submitting tells us this is everything still outstanding. You will not be able to add more items afterwards unless we reopen the list.",
  submitted_note: "Thanks — we have your {noun} and will get to work.",
  work_complete_title: "We have finished your {noun}",
  work_complete_body: "Please review the items below and confirm they are complete.",
  accept_cta: "Everything looks good",
  accept_confirm: "Confirming tells us every item on this list is finished to your satisfaction.",
  accepted_note: "Thank you for confirming — this {noun} is closed out.",
  empty_items: "You have not added anything yet."
};

export type PunchLabels = Record<string, string>;

/**
 * Resolve customer-visible copy: instance labels -> org defaults -> built-ins,
 * then interpolate `{noun}` / `{noun_plural}`.
 */
export function resolvePunchLabels(config: JsonObject, orgDefaults: unknown = {}): PunchLabels {
  const org = asObject(asObject(orgDefaults).labels);
  const instance = asObject(config.labels);
  const merged: PunchLabels = {};
  for (const key of Object.keys(DEFAULT_LABELS)) {
    merged[key] = cleanText(instance[key]) || cleanText(org[key]) || DEFAULT_LABELS[key]!;
  }
  const noun = merged.noun || DEFAULT_LABELS.noun!;
  const nounPlural = merged.noun_plural || `${noun}s`;
  for (const key of Object.keys(merged)) {
    merged[key] = merged[key]!
      .replace(/\{noun_plural\}/g, nounPlural)
      .replace(/\{noun\}/g, noun);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type PunchConfig = {
  schema_version: number;
  state: PunchState;
  required: boolean;
  customer_can_add: boolean;
  customer_can_edit: boolean;
  max_items: number;
  require_photo: boolean;
  require_comment: boolean;
  allow_empty: boolean;
  require_submit_signature: boolean;
  require_accept_signature: boolean;
  terminology_key: string;
  labels: JsonObject;
  requested_at: string;
  submitted_at: string;
  work_completed_at: string;
  accepted_at: string;
  submit_signature: JsonObject | null;
  accept_signature: JsonObject | null;
};

/**
 * Normalize a `metadata.punch` block.
 *
 * `orgDefaults` is the org's punch-list defaults (portal settings
 * `punch_list`), so an org can set house rules once — e.g. "we always require
 * an acceptance signature" — without repeating them in every scope template.
 * A scope template that specifies a value wins over the org default.
 */
export function normalizePunchConfig(value: unknown, orgDefaults: unknown = {}): PunchConfig {
  const input = asObject(value);
  const org = asObject(orgDefaults);
  const maxItems = Number(input.max_items ?? org.max_items ?? 0);
  return {
    schema_version: PUNCH_SCHEMA_VERSION,
    state: punchState(input.state),
    required: layeredBool(input.required, org.required, true),
    customer_can_add: layeredBool(input.customer_can_add, org.customer_can_add, true),
    customer_can_edit: layeredBool(input.customer_can_edit, org.customer_can_edit, true),
    // 0 = unlimited. A cap is a courtesy to the crew, not a security control.
    max_items: Number.isFinite(maxItems) ? Math.max(0, Math.min(500, Math.round(maxItems))) : 0,
    require_photo: layeredBool(input.require_photo, org.require_photo, false),
    require_comment: layeredBool(input.require_comment, org.require_comment, false),
    // Submitting an empty list is meaningful — "nothing is outstanding" — so it
    // is allowed by default.
    allow_empty: layeredBool(input.allow_empty, org.allow_empty, true),
    require_submit_signature: layeredBool(input.require_submit_signature, org.require_submit_signature, false),
    require_accept_signature: layeredBool(input.require_accept_signature, org.require_accept_signature, false),
    terminology_key: cleanText(input.terminology_key || org.terminology_key) || "punch_list",
    labels: { ...asObject(org.labels), ...asObject(input.labels) },
    requested_at: cleanText(input.requested_at),
    submitted_at: cleanText(input.submitted_at),
    work_completed_at: cleanText(input.work_completed_at),
    accepted_at: cleanText(input.accepted_at),
    submit_signature: input.submit_signature ? asObject(input.submit_signature) : null,
    accept_signature: input.accept_signature ? asObject(input.accept_signature) : null
  };
}

/** A checklist is a punch list iff it carries a punch block. */
export function isPunchList(checklist: unknown) {
  const metadata = asObject(asObject(checklist).metadata);
  return Boolean(metadata.punch && typeof metadata.punch === "object");
}

export function punchConfigOf(checklist: unknown, orgDefaults: unknown = {}) {
  return normalizePunchConfig(asObject(asObject(checklist).metadata).punch, orgDefaults);
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/**
 * Punch sign-offs use the shared portal signature primitive — the same artifact
 * a completion sign-off and a document signature produce. Re-exported here so
 * punch callers have one import, but there is only one implementation.
 */
export { normalizePortalSignature as normalizePunchSignature } from "../platform/portal_signatures.js";

// ---------------------------------------------------------------------------
// Transition guards
// ---------------------------------------------------------------------------

function itemsOf(checklist: unknown) {
  return asArray(asObject(checklist).items).map(asObject);
}

/**
 * May the customer add or change items right now?
 *
 * Only while the list is still theirs to write — once submitted, the list is a
 * commitment the company is pricing work against, so reopening is the
 * company's call, not a silent client-side edit.
 */
export function customerMayEditPunchItems(checklist: unknown, config: PunchConfig) {
  if (config.state !== "requested") return false;
  return config.customer_can_add || config.customer_can_edit;
}

export function assertCustomerMayAddPunchItem(checklist: unknown, config: PunchConfig) {
  if (config.state !== "requested") {
    throw forbidden("punch_list_locked", "This list has already been submitted. Ask your project team to reopen it if something is missing.");
  }
  if (!config.customer_can_add) {
    throw forbidden("punch_list_add_disabled", "Items cannot be added to this list.");
  }
  const items = itemsOf(checklist);
  if (config.max_items && items.length >= config.max_items) {
    throw forbidden("punch_list_full", `This list is limited to ${config.max_items} items.`);
  }
}

export function assertCustomerMayEditPunchItem(config: PunchConfig) {
  if (config.state !== "requested") {
    throw forbidden("punch_list_locked", "This list has already been submitted.");
  }
  if (!config.customer_can_edit) {
    throw forbidden("punch_list_edit_disabled", "Items on this list cannot be changed.");
  }
}

/** Item-level evidence requirements, checked at submit rather than at add. */
function assertItemRequirements(checklist: unknown, config: PunchConfig, labels: PunchLabels) {
  if (!config.require_photo && !config.require_comment) return;
  for (const item of itemsOf(checklist)) {
    const attachments = asArray(item.attachments).map(asObject);
    if (config.require_photo && !attachments.some((attachment) => ["photo", "video"].includes(cleanText(attachment.kind)))) {
      throw badRequest("punch_item_photo_required", `Add a photo to "${cleanText(item.title)}" before submitting your ${labels.noun}.`);
    }
    if (config.require_comment && !cleanText(item.description) && !cleanText(item.note)) {
      throw badRequest("punch_item_comment_required", `Add a note to "${cleanText(item.title)}" before submitting your ${labels.noun}.`);
    }
  }
}

export function assertCanSubmitPunchList(checklist: unknown, config: PunchConfig, labels: PunchLabels) {
  if (config.state !== "requested") {
    throw conflict("punch_list_not_open", "This list has already been submitted.");
  }
  const items = itemsOf(checklist);
  if (!items.length && !config.allow_empty) {
    throw badRequest("punch_list_empty", `Add at least one item before submitting your ${labels.noun}.`);
  }
  assertItemRequirements(checklist, config, labels);
}

export function assertCanAcceptPunchList(config: PunchConfig) {
  if (config.state === "accepted") {
    throw conflict("punch_list_already_accepted", "This list has already been signed off.");
  }
  if (config.state !== "work_complete") {
    throw conflict("punch_list_not_complete", "Your project team has not marked this list complete yet.");
  }
}

/**
 * Company-side completion. Requires every item done — the point of the gate is
 * that the customer is being asked to confirm finished work, so asking before
 * the work is finished would train them to rubber-stamp it.
 */
export function assertCanCompletePunchWork(checklist: unknown, config: PunchConfig) {
  if (config.state === "requested") {
    throw conflict("punch_list_not_submitted", "The customer has not submitted this list yet.");
  }
  if (config.state === "accepted") {
    throw conflict("punch_list_already_accepted", "This list is already signed off.");
  }
  const items = itemsOf(checklist);
  const outstanding = items.filter((item) => item.completed !== true);
  if (outstanding.length) {
    throw conflict("punch_list_items_outstanding", `${outstanding.length} item${outstanding.length === 1 ? " is" : "s are"} still open.`, {
      outstanding_item_ids: outstanding.map((item) => cleanText(item.id))
    });
  }
}

// ---------------------------------------------------------------------------
// Transitions (pure — callers persist the returned block)
// ---------------------------------------------------------------------------

export function punchTransition(config: PunchConfig, next: PunchState, extra: JsonObject = {}): JsonObject {
  const now = new Date().toISOString();
  const stamps: Record<PunchState, string> = {
    requested: "requested_at",
    submitted: "submitted_at",
    work_complete: "work_completed_at",
    accepted: "accepted_at"
  };
  return {
    ...config,
    state: next,
    [stamps[next]]: now,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

/**
 * What the customer portal sees. Signature *evidence* (ip, user agent) is
 * deliberately dropped — the customer does not need their own audit trail read
 * back to them, and it should not travel further than it must.
 */
export function publicPunchView(checklist: JsonObject, config: PunchConfig, labels: PunchLabels): JsonObject {
  const items = itemsOf(checklist);
  return {
    id: cleanText(checklist.id),
    title: cleanText(checklist.title),
    description: cleanText(checklist.description),
    state: config.state,
    labels,
    required: config.required,
    can_add_items: config.state === "requested" && config.customer_can_add,
    can_edit_items: config.state === "requested" && config.customer_can_edit,
    max_items: config.max_items,
    require_photo: config.require_photo,
    require_comment: config.require_comment,
    requires_submit_signature: config.require_submit_signature,
    requires_accept_signature: config.require_accept_signature,
    item_count: items.length,
    completed_count: items.filter((item) => item.completed === true).length,
    submitted_at: config.submitted_at,
    work_completed_at: config.work_completed_at,
    accepted_at: config.accepted_at,
    submitted_by: cleanText(asObject(config.submit_signature).signer_name),
    accepted_by: cleanText(asObject(config.accept_signature).signer_name)
  };
}
