import { createHash } from "node:crypto";
import { deleteDocument, listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { asObject, text } from "./contracts.js";
import { createContact, projectContactLinks, projectContactsProjection, resolveContactId, setProjectContactLinks, type ContactLink } from "./records.js";

/**
 * One-time copy of contacts embedded in projects into the contact store. Idempotent:
 * a project that already has links is left alone, and a contact id that already
 * exists is linked, not rewritten. Standalone (`contact_only`) records go first so
 * their copy of a shared contact id wins, and their record-level field values move
 * onto the contact.
 */
export async function migrateOrganizationContacts(org: string) {
  const projects = (await listDocuments(org, "projects"))
    .sort((a, b) => Number(asObject(b.data).workflow_state === "contact_only") - Number(asObject(a.data).workflow_state === "contact_only"));
  const counts = { projects: 0, contacts_created: 0, links: 0, skipped: 0 };
  for (const project of projects) {
    const data = asObject(project.data);
    const embedded = (Array.isArray(data.contacts) ? data.contacts : []).map(asObject);
    // Older projects named their customer only in top-level fields.
    const alias = { id: text(data.contact_id || data.primary_contact_id), name: text(data.customer_name || data.primary_contact_name || data.resident_name), email: text(data.customer_email || data.primary_contact_email || data.resident_email), phone: text(data.customer_phone || data.primary_contact_phone || data.resident_phone), primary: true };
    if (!embedded.length && (alias.name || alias.email || alias.phone)) embedded.push(alias);
    if (!embedded.length || (await projectContactLinks(org, project.id)).length) { counts.skipped++; continue; }
    const primaryId = text(data.primary_contact_id || data.contact_id);
    const links: ContactLink[] = [];
    for (const [index, contact] of embedded.entries()) {
      // Contacts saved without an id were shown with this derived id, and other records may already point at it.
      const id = text(contact.id || contact.contact_id) || `contact_${createHash("sha256").update(`${project.id}:contact:${index}`).digest("hex").slice(0, 16)}`;
      let contactId = id ? await resolveContactId(org, id) : "";
      if (!contactId) {
        const anchorValues = data.workflow_state === "contact_only" && index === 0 ? asObject(data.contact_custom_field_values) : {};
        const record: JsonObject = { ...contact, custom_field_values: { ...anchorValues, ...asObject(contact.custom_field_values || contact.contact_custom_field_values) }, branch_ids: [text(data.branch_id) || "default"] };
        if (!["name", "first_name", "last_name", "email", "phone", "address"].some(k => text(record[k])) && !(Array.isArray(record.phones) && record.phones.length)) continue;
        contactId = (await createContact(org, record, { id, migration: true })).id;
        counts.contacts_created++;
      }
      links.push({ contact_id: contactId, role: text(contact.role), primary: contact.primary === true || (!!primaryId && primaryId === id) });
    }
    await setProjectContactLinks(org, project.id, links);
    await upsertDocument(org, "projects", { id: project.id, data: await projectContactsProjection(org, project.id) }, { contactsProjection: true, mustExist: true });
    counts.projects++; counts.links += links.length;
  }
  return counts;
}

/**
 * Removes the standalone (`contact_only`) project records contacts used to live in. Run after
 * `migrateOrganizationContacts`, which copies their contacts into the store. Idempotent. A record
 * that gathered work (events or proposals) is kept as a draft project; a bare one is deleted and
 * loses its links, so its contacts remain as records of their own.
 */
export async function removeStandaloneContactRecords(org: string) {
  const counts = { removed: 0, kept_as_draft: 0 };
  for (const project of await listDocuments(org, "projects")) {
    const data = asObject(project.data);
    if (data.workflow_state !== "contact_only") continue;
    const used = ["events", "proposals"].some(key => Array.isArray(data[key]) && (data[key] as unknown[]).length);
    if (used) {
      await upsertDocument(org, "projects", { id: project.id, data: { workflow_state: "draft" } });
      counts.kept_as_draft++;
      continue;
    }
    await setProjectContactLinks(org, project.id, []);
    await deleteDocument(org, "projects", project.id);
    counts.removed++;
  }
  return counts;
}
