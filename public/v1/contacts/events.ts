import type { JsonObject } from "../platform/storage.js";
import type { ContactRecord } from "./records.js";

// Contact events (docs/architecture/contacts.md, "Contact events"): the contact writers emit them after a
// write commits, so organization rules can start from a contact the way they start from a project.
// contact.created, contact.updated (with the fields that changed), contact.tagged (one per tag added)
// and contact.merged; the scheduler adds contact.date for rules on a date such as a birthday.
// Events carry the contact id and no project; the engine loads the contact for conditions and actions.

const text = (value: unknown) => String(value ?? "").trim();

/** What a rule sees as `contact` in its conditions and `{{contact.*}}` in its inputs. */
export function contactView(record: ContactRecord): JsonObject {
  return {
    id: record.id, kind: record.contact_kind, name: record.name, first_name: record.first_name, last_name: record.last_name,
    email: record.email, phone: record.phone, address: record.address,
    emails: record.emails.map((point) => point.value), phones: record.phones.map((point) => point.value), addresses: record.addresses.map((point) => point.value),
    tags: record.tags, branch_ids: record.branch_ids, birthday: record.birthday, company: record.company, time_zone: record.time_zone,
    custom_field_values: record.custom_field_values, cf: record.custom_field_values,
    created_at: record.created_at, updated_at: record.updated_at
  };
}

/** The fields an update changed, by the names a rule's conditions use (`email`, `tags`, `cf.<path>`). */
export function changedContactFields(previous: ContactRecord, next: ContactRecord) {
  const changed: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const key of ["contact_kind", "name", "first_name", "last_name", "time_zone", "birthday", "company", "notes"] as const) if (!same(previous[key], next[key])) changed.push(key === "contact_kind" ? "kind" : key);
  for (const [key, points] of [["emails", "emails"], ["phones", "phones"], ["addresses", "addresses"]] as const) {
    if (!same(previous[points].map((p) => [p.normalized, p.primary]), next[points].map((p) => [p.normalized, p.primary]))) changed.push(key);
  }
  if (!same([...previous.tags].sort(), [...next.tags].sort())) changed.push("tags");
  if (!same([...previous.branch_ids].sort(), [...next.branch_ids].sort())) changed.push("branch_ids");
  const before = previous.custom_field_values || {}, after = next.custom_field_values || {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!same(before[key], after[key])) changed.push(`cf.${key}`);
  return changed;
}

async function emit(org: string, record: ContactRecord, type: string, payload: JsonObject, key: string) {
  const { emitWorkEvent } = await import("../work/engine.js");
  const { currentChangeSource } = await import("../history/source.js");
  const source = currentChangeSource() as JsonObject;
  await emitWorkEvent({
    organization_id: org,
    // Organization rules are read per branch; a contact in several branches runs its first branch's rules.
    branch_id: record.branch_ids[0] || "default",
    type,
    idempotency_key: key,
    payload: { contact_id: record.id, ...payload },
    context: { contact_id: record.id, change_source: text(source.kind), ...(text(source.user_id) ? { actor_user_id: text(source.user_id) } : {}) }
  });
}

export async function emitContactCreated(org: string, record: ContactRecord) {
  await emit(org, record, "contact.created", { name: record.name, tags: record.tags }, `contact.created:${record.id}`);
  for (const tag of record.tags) await emit(org, record, "contact.tagged", { tag }, `contact.tagged:${record.id}:${tag}:${record.revision}`);
}

export async function emitContactUpdated(org: string, previous: ContactRecord, record: ContactRecord) {
  const changed = changedContactFields(previous, record);
  if (!changed.length) return;
  const added = record.tags.filter((tag) => !previous.tags.includes(tag));
  const removed = previous.tags.filter((tag) => !record.tags.includes(tag));
  await emit(org, record, "contact.updated", { changed_fields: changed, tags_added: added, tags_removed: removed, revision: record.revision }, `contact.updated:${record.id}:${record.revision}`);
  for (const tag of added) await emit(org, record, "contact.tagged", { tag }, `contact.tagged:${record.id}:${tag}:${record.revision}`);
}

export async function emitContactMerged(org: string, survivor: ContactRecord, mergedId: string) {
  await emit(org, survivor, "contact.merged", { merged_contact_id: mergedId }, `contact.merged:${survivor.id}:${mergedId}`);
}

/** A contact's date by a rule's field name: `birthday`, or `cf.<path>` for a date custom field. */
export function contactDate(record: ContactRecord, field: string) {
  const name = text(field);
  if (name === "birthday") return text(record.birthday);
  if (name.startsWith("cf.")) {
    const value = name.slice(3).split(".").reduce<unknown>((node, part) => node && typeof node === "object" ? (node as JsonObject)[part] : undefined, record.custom_field_values);
    return text(value);
  }
  return "";
}
