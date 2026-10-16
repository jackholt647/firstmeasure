import { badRequest } from "../platform/errors.js";
import { upsertDocument, readDocument, type JsonObject } from "../platform/storage.js";
import { emitWorkEvent } from "../work/engine.js";
import { routeNewLead } from "../scopes/router.js";
import { contactSettings } from "../contacts/service.js";
import { createContact, findExactMatches, refreshProjections, setProjectContactLinks, type ContactRecord } from "../contacts/records.js";
import { normalizePhone } from "../contacts/normalize.js";

// The one way a lead arrives (docs/architecture/opportunities.md). Every source
// (forms, email, Connections, chat, canvassing, the API, the published action)
// builds a LeadSubmission and calls receiveLead; delivery idempotency stays with
// the source's own ledger (leads/intake.ts) or project id.

export type LeadContactInput = {
  name?: string; first_name?: string; last_name?: string; contact_kind?: "human" | "org";
  email?: string; emails?: string[]; phone?: string; phones?: string[]; role?: string;
};
export type LeadSubmission = {
  branch_id?: string;
  /** Stable id for retries; a second submission with the same id is refused. */
  project_id?: string;
  source: { kind: string; provider?: string; confidence?: number; provider_fields?: JsonObject; raw?: JsonObject } & JsonObject;
  contacts?: LeadContactInput[];
  address?: string; title?: string; summary?: string;
  /** Extra project fields the source owns, such as a form submission record. */
  project_data?: JsonObject;
  /** The person asked to be texted. `disclosure_text` is what they agreed to. */
  consent?: { sms?: boolean; disclosure_text?: string; evidence?: JsonObject };
  /**
   * What the source suggests telling the team (`title`, `body`, `target_role_ids`, `context`),
   * carried on `lead.received` as `payload.notice`; `false` asks for no notification. The
   * organization's rules on `lead.received` decide what is sent.
   */
  notification?: false | JsonObject;
};

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const strings = (value: unknown) => (Array.isArray(value) ? value : []).map(text).filter(Boolean);

function leadContacts(input: unknown): LeadContactInput[] {
  return (Array.isArray(input) ? input : []).map(object).map(c => ({
    name: text(c.name), first_name: text(c.first_name), last_name: text(c.last_name),
    contact_kind: (text(c.contact_kind) === "org" ? "org" : "human") as "human" | "org",
    email: text(c.email).toLowerCase(), emails: strings(c.emails), phone: text(c.phone || strings(c.phones)[0]), phones: strings(c.phones), role: text(c.role)
  })).filter(c => c.name || c.first_name || c.last_name || c.email || c.emails.length || c.phone);
}

/**
 * An inbound lead never changes an existing contact: a matched person keeps the
 * details on file, and what the lead said stays on the project's lead source.
 * (Anyone can type someone else's phone number into a web form.)
 */
async function contactFor(org: string, branchId: string, input: LeadContactInput, autoAttach: boolean): Promise<{ contact: ContactRecord; matched: boolean }> {
  const match = autoAttach ? (await findExactMatches(org, input))[0] : undefined;
  if (match) return { contact: match, matched: true };
  const { role: _role, ...fields } = input;
  return { contact: await createContact(org, { ...fields, branch_ids: [branchId] }), matched: false };
}

export async function receiveLead(org: string, submission: LeadSubmission) {
  const branchId = text(submission.branch_id) || "default";
  const sourceKind = text(submission.source?.kind) || "manual_lead";
  const contacts = leadContacts(submission.contacts);
  const address = text(submission.address), summary = text(submission.summary);
  if (!address && !contacts.length && !summary && !text(submission.title)) throw badRequest("lead_missing_contact_data", "A lead needs at least an address, contact, title, or summary.");
  const api = await import("../platform/api.js");
  await api.ensureWorkflowModules(org, branchId);

  const settings = await contactSettings(org);
  const resolved = [];
  for (const input of contacts) resolved.push({ ...(await contactFor(org, branchId, input, settings.auto_attach_exact !== false)), role: input.role || "" });

  const now = new Date().toISOString();
  const { provider = "", confidence = 0, provider_fields = {}, raw = {}, ...sourceRest } = submission.source || { kind: sourceKind };
  const projectData = { ...object(submission.project_data) };
  for (const key of ["contacts", "customers", "customer_ids", "primary_customer_id", "customer_id", "contact_id", "primary_contact_id"]) delete projectData[key];
  const projectId = text(submission.project_id);
  const project = await upsertDocument(org, "projects", {
    ...(projectId ? { id: projectId } : {}),
    data: {
      ...projectData,
      branch_id: branchId,
      address, title: text(submission.title || address || summary || contacts[0]?.name || "New lead"), summary,
      events: [], source: sourceKind,
      lead_source: { ...sourceRest, kind: sourceKind, provider: text(provider), confidence: Number(confidence) || 0, provider_fields: object(provider_fields), raw: object(raw), contacts, received_at: now },
      created_at: now, updated_at: now
    },
    metadata: { kind: "platform_project", source: sourceKind, branch_id: branchId }
  }, projectId ? { createOnly: true } : {});
  if (resolved.length) {
    await setProjectContactLinks(org, project.id, resolved.map((r, index) => ({ contact_id: r.contact.id, role: r.role, primary: index === 0 })));
    await refreshProjections(org, [project.id]);
  }

  const sms = submission.consent?.sms === true ? [...new Set(contacts.flatMap(c => [c.phone, ...(c.phones || [])]).map(normalizePhone).filter(Boolean))] : [];
  if (sms.length) {
    const { upsertSmsConsent } = await import("../messaging/communications_storage.js");
    const primary = resolved[0]?.contact.id || "";
    for (const phone of sms) await upsertSmsConsent({
      organization_id: org, phone_number: phone, status: "opted_in", source: sourceKind === "web_form" ? "web_form" : sourceKind,
      consent_id: `lead_${project.id}`, contact_id: primary, occurred_at: now,
      evidence: { ...object(submission.consent?.evidence), checkbox: true, disclosure_text: text(submission.consent?.disclosure_text), consent_obtained_at: now, purposes: ["customer_care"], project_id: project.id }
    });
  }

  // The organization's source catalog names where it came from (crm/sources.ts), before routing reads it.
  await (await import("../crm/sources.js")).stampLeadSource(org, project.id);
  // Routing runs once, here: a scope, or nothing yet (a new lead).
  await routeNewLead(org, { id: project.id, ...object((await readDocument(org, "projects", project.id)).data) });
  await (await import("../work/service.js")).syncProjectWorkProjection(org, project.id);
  await (await import("../contacts/merge.js")).suggestOpportunityDuplicates(org, project.id);
  const fresh = await readDocument(org, "projects", project.id);

  // The source's suggestion; the organization's rules on lead.received decide what is sent.
  const options = object(submission.notification), first = resolved[0]?.contact;
  const notice = submission.notification === false ? { notify: false } : {
    notify: true,
    title: text(options.title) || "Contact new lead",
    body: text(options.body) || [address, first?.name, first?.phone, first?.email].filter(Boolean).join(" · ") || summary || "A new lead came in.",
    target_role_ids: strings(options.target_role_ids),
    target_user_ids: strings(options.target_user_ids),
    source: text(options.source || `${sourceKind}_lead_import`),
    context: object(options.context)
  };
  const payload = { project_id: project.id, source_kind: sourceKind, address, title: text(object(fresh.data).title), contact_ids: resolved.map(r => r.contact.id), matched_contact_ids: resolved.filter(r => r.matched).map(r => r.contact.id), new_lead: object(object(fresh.data).lifecycle).new_lead === true };
  await emitWorkEvent({ organization_id: org, branch_id: branchId, project_id: project.id, type: "project.created", idempotency_key: `project.created:${project.id}`, payload });
  await emitWorkEvent({ organization_id: org, branch_id: branchId, project_id: project.id, type: "lead.received", idempotency_key: `lead.received:${project.id}`, payload: { ...payload, notice } });
  api.invalidatePlatformSearchCache(org);
  return { project: fresh, contacts: resolved.map(r => r.contact), matched_contact_ids: payload.matched_contact_ids };
}
