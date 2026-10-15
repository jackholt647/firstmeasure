import type { JsonObject } from "../platform/storage.js";
import { asObject, text } from "./contracts.js";
import { contactSettings } from "./service.js";
import { contactProjectIds, createContact, findExactMatches, readContact, projectContactsProjection, resolveContactId, setProjectContactLinks, updateContact, type ContactLink } from "./records.js";

// Temporary bridge (docs/architecture/contacts.md, phase 5 removes it): a project
// write that still carries `contacts` becomes contact-service calls, and the
// project gets the projection back. Only what the writer changed relative to the
// projection it read is applied, so a stale copy never overwrites a newer edit.

const PATCH_GROUPS: string[][] = [
  ["name"], ["first_name"], ["last_name"], ["contact_kind"], ["time_zone"], ["tags"], ["company"], ["notes"], ["birthday"],
  ["email", "emails"], ["phone", "phones", "secondary_phone", "primary_phone_label", "secondary_phone_label"], ["address", "default_address"],
  ["custom_field_values", "contact_custom_field_values"]
];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function changes(incoming: JsonObject, prior: JsonObject) {
  const patch: JsonObject = {};
  for (const group of PATCH_GROUPS) {
    if (!group.some(key => key in incoming && !same(incoming[key], prior[key]))) continue;
    for (const key of group) if (key in incoming) patch[key] = incoming[key];
  }
  return patch;
}
const hasIdentity = (c: JsonObject) => ["name", "first_name", "last_name", "email", "phone", "address"].some(k => text(c[k])) || (Array.isArray(c.phones) && c.phones.some(p => text(p)));
/** Who an entry without an id is, judged the way project contact lists always have: email, then phone, then name. */
function semanticKey(c: JsonObject) {
  const email = text(c.email).toLowerCase();
  if (email) return `email:${email}`;
  const phone = text(c.phone).replace(/\D+/g, "");
  if (phone.length >= 7) return `phone:${phone}`;
  const name = text(c.name || [text(c.first_name), text(c.last_name)].filter(Boolean).join(" ")).toLowerCase().replace(/\s+/g, " ");
  return name ? `name:${name}` : "";
}

export async function syncProjectContactsOnWrite(org: string, projectId: string, data: JsonObject, previous: JsonObject): Promise<{ data: JsonObject; refresh: string[] }> {
  if (!Array.isArray(data.contacts)) return { data, refresh: [] };
  // Re-sending the stored list (a writer that saves the whole document) is not a contact edit: the
  // links stay as the contact service last set them, and the document gets the current projection.
  if (same(data.contacts, previous.contacts)) return { data: { ...data, ...(await projectContactsProjection(org, projectId)) }, refresh: [] };
  const priorList = (Array.isArray(previous.contacts) ? previous.contacts : []).map(asObject);
  const priorById = new Map(priorList.map(c => [text(c.id || c.contact_id), c]));
  // An entry without an id that names someone already on the project (or earlier in this list), or that sits where a
  // previous contact sat, is that contact: writers that drop ids must not turn a rename into a new person.
  const known = new Map<string, string>();
  for (const c of priorList) if (semanticKey(c)) known.set(semanticKey(c), text(c.id || c.contact_id));
  const claimed = new Set((data.contacts as unknown[]).map(asObject).map(c => text(c.id || c.contact_id)).filter(Boolean));
  const branch = text(data.branch_id || previous.branch_id) || "default";
  const topPrimary = text(data.primary_contact_id || data.contact_id);
  const settings = await contactSettings(org);
  const links: ContactLink[] = [], updated: string[] = [];
  for (const [index, raw] of (data.contacts as unknown[]).entries()) {
    const c = asObject(raw);
    let id = text(c.id || c.contact_id);
    if (!id) {
      // Taking the place of a previous contact renames that person, so it is allowed only for someone on no other project.
      let positional = text(priorList[index]?.id || priorList[index]?.contact_id);
      if (positional && (claimed.has(positional) || (await contactProjectIds(org, positional)).some(other => other !== projectId))) positional = "";
      id = known.get(semanticKey(c)) || positional;
      if (id) claimed.add(id);
    }
    let contactId = id ? await resolveContactId(org, id) : "";
    if (contactId && semanticKey(c)) known.set(semanticKey(c), contactId);
    if (contactId) {
      // A copy made from an older revision is stale: the newer contact wins and the copy changes nothing.
      const copied = Number(c.contact_revision) || 0;
      const current = copied ? (await readContact(org, contactId)).revision : 0;
      const patch = copied && copied < current ? {} : changes(c, priorById.get(id) || {});
      if (Object.keys(patch).length) { await updateContact(org, contactId, patch, { projections: false }); updated.push(contactId); }
    } else {
      if (!hasIdentity(c)) continue;
      const match = !id && settings.auto_attach_exact !== false ? (await findExactMatches(org, c))[0] : undefined;
      contactId = match ? match.id : (await createContact(org, { ...c, branch_ids: Array.isArray(c.branch_ids) && c.branch_ids.length ? c.branch_ids : [branch] }, { id })).id;
      if (semanticKey(c)) known.set(semanticKey(c), contactId);
    }
    links.push({ contact_id: contactId, role: text(c.role), primary: c.primary === true || (!!topPrimary && [id, contactId].includes(topPrimary)) });
  }
  await setProjectContactLinks(org, projectId, links);
  const projection = await projectContactsProjection(org, projectId);
  const others = new Set<string>();
  if (updated.length) {
    for (const contactId of updated) for (const other of await contactProjectIds(org, contactId)) if (other !== projectId) others.add(other);
  }
  return { data: { ...data, ...projection }, refresh: [...others] };
}
