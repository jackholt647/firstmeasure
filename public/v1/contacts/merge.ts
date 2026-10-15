import { randomBytes } from "node:crypto";
import { badRequest, conflict } from "../platform/errors.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
import type { JsonObject } from "../platform/storage.js";
import { contactStore } from "./store.js";
import { nameKey } from "./normalize.js";
import { contactReferenceAdapters } from "./references.js";
import { contactProjectIds, findExactMatches, projectContactLinks, readContact, readContacts, refreshProjections, setProjectContactLinks, updateContact, type ContactPoint, type ContactRecord } from "./records.js";

// Contact merge and duplicate suggestions (docs/architecture/contacts.md "Merge").
// Nothing here runs on its own: duplicates are suggested, a person merges.

const text = (value: unknown) => String(value ?? "").trim();
const now = () => new Date().toISOString();
const SCALARS = ["contact_kind", "name", "first_name", "last_name", "company", "notes", "birthday", "time_zone"] as const;
export type MergePreference = Record<string, "survivor" | "merged">;

function unionPoints(first: ContactPoint[], second: ContactPoint[]) {
  const seen = new Set(first.map(p => p.normalized));
  return [...first.map(p => ({ value: p.value, label: p.label, primary: p.primary })), ...second.filter(p => !seen.has(p.normalized)).map(p => ({ value: p.value, label: p.label, primary: false }))];
}

/** What the survivor becomes. `prefer` picks a side per field (`name`, or `fields.<custom field key>`); by default the survivor's value wins and the merged contact fills blanks. */
export function mergedValues(survivor: ContactRecord, merged: ContactRecord, prefer: MergePreference = {}) {
  const pick = (key: string, a: unknown, b: unknown) => prefer[key] === "merged" ? (text(b) ? b : a) : (text(a) ? a : b);
  const patch: JsonObject = {};
  for (const key of SCALARS) patch[key] = pick(key, survivor[key], merged[key]);
  patch.tags = [...new Set([...survivor.tags, ...merged.tags])].filter(tag => tag !== "org");
  // A contact with no branches is in every branch, so the union of "every branch" and anything is every branch.
  patch.branch_ids = !survivor.branch_ids.length || !merged.branch_ids.length ? [] : [...new Set([...survivor.branch_ids, ...merged.branch_ids])];
  const values: JsonObject = {};
  for (const key of new Set([...Object.keys(survivor.custom_field_values), ...Object.keys(merged.custom_field_values)])) {
    const a = survivor.custom_field_values[key], b = merged.custom_field_values[key];
    const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    values[key] = prefer[`fields.${key}`] === "merged" ? (empty(b) ? a : b) : (empty(a) ? b : a);
  }
  patch.custom_field_values = values;
  patch.emails = unionPoints(survivor.emails, merged.emails);
  patch.phones = unionPoints(survivor.phones, merged.phones);
  patch.addresses = unionPoints(survivor.addresses, merged.addresses);
  return patch;
}

export async function mergeContacts(org: string, survivorId: string, mergedId: string, options: { prefer?: MergePreference; actor_user_id?: string } = {}) {
  if (!text(survivorId) || !text(mergedId) || survivorId === mergedId) throw badRequest("contact_merge_same", "Choose two different contacts to merge.");
  const survivor = await readContact(org, survivorId, { follow: false }), merged = await readContact(org, mergedId, { follow: false });
  if (survivor.merged_into || merged.merged_into) throw conflict("contact_already_merged", "One of these contacts was already merged into another.");
  // The survivor is written first, so a value the field rules refuse stops the merge before anything moves.
  await updateContact(org, survivor.id, mergedValues(survivor, merged, options.prefer), { projections: false });

  const moved: Record<string, number> = {};
  const projects = await contactProjectIds(org, merged.id);
  for (const projectId of projects) {
    const links = await projectContactLinks(org, projectId);
    const mergedLink = links.find(link => link.contact_id === merged.id)!;
    const next = links.some(link => link.contact_id === survivor.id)
      ? links.filter(link => link.contact_id !== merged.id).map(link => link.contact_id === survivor.id ? { ...link, primary: link.primary || mergedLink.primary } : link)
      : links.map(link => link.contact_id === merged.id ? { ...link, contact_id: survivor.id } : link);
    await setProjectContactLinks(org, projectId, next);
  }
  moved.contact_links = projects.length;
  for (const adapter of contactReferenceAdapters()) moved[adapter.id] = await adapter.repoint(org, merged.id, survivor.id);

  const db = contactStore(), time = now();
  await db.prepare("UPDATE contacts SET merged_into=?, revision=revision+1, updated_at=? WHERE organization_id=? AND id=?").run(survivor.id, time, org, merged.id);
  await db.prepare("UPDATE contact_duplicates SET status='merged', updated_at=? WHERE organization_id=? AND kind='contact' AND (first_id=? OR second_id=?)").run(time, org, merged.id, merged.id);
  const id = `merge_${randomBytes(8).toString("hex")}`;
  await db.prepare("INSERT INTO contact_merges(organization_id,id,kind,survivor_id,merged_id,actor_user_id,before_json,moved_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(org, id, "contact", survivor.id, merged.id, text(options.actor_user_id), JSON.stringify({ survivor, merged }), JSON.stringify(moved), time);
  const survivorProjects = await contactProjectIds(org, survivor.id);
  await refreshProjections(org, survivorProjects);
  // Now that both people are one, their open opportunities may be one sale.
  for (const projectId of survivorProjects) await suggestOpportunityDuplicates(org, projectId);
  await publishRealtimeEvent({ organization_id: org, topic: "contact.merged", payload: { contact_id: survivor.id, merged_id: merged.id } });
  return { merge_id: id, contact: await readContact(org, survivor.id), moved };
}

// ---- Duplicate suggestions -------------------------------------------------

async function recordPair(org: string, kind: "contact" | "project", a: string, b: string, reasons: string[]) {
  if (!a || !b || a === b || !reasons.length) return;
  const [first, second] = [a, b].sort() as [string, string], time = now(), db = contactStore();
  const existing = await db.prepare("SELECT status, reasons_json FROM contact_duplicates WHERE organization_id=? AND kind=? AND first_id=? AND second_id=?").get(org, kind, first, second);
  if (existing) {
    // A dismissed or merged pair stays that way; new evidence is added to an open one.
    if (text(existing.status) !== "open") return;
    let known: string[] = []; try { known = JSON.parse(text(existing.reasons_json)); } catch { known = []; }
    await db.prepare("UPDATE contact_duplicates SET reasons_json=?, updated_at=? WHERE organization_id=? AND kind=? AND first_id=? AND second_id=?").run(JSON.stringify([...new Set([...known, ...reasons])]), time, org, kind, first, second);
    return;
  }
  await db.prepare("INSERT INTO contact_duplicates(organization_id,kind,first_id,second_id,reasons_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'open',?,?)").run(org, kind, first, second, JSON.stringify(reasons), time, time);
}

/** Looks for people who may be this contact: the same email or phone, or the same name (and address). */
export async function suggestContactDuplicates(org: string, contactId: string) {
  const contact = await readContact(org, contactId, { follow: false }).catch(() => null);
  if (!contact || contact.merged_into) return [];
  const reasons = new Map<string, Set<string>>();
  const add = (id: string, reason: string) => { if (id !== contact.id) (reasons.get(id) || reasons.set(id, new Set()).get(id)!).add(reason); };
  const exact = await findExactMatches(org, { emails: contact.emails.map(p => p.value), phones: contact.phones.map(p => p.value) });
  for (const other of exact) {
    if (other.emails.some(p => contact.emails.some(q => q.normalized === p.normalized))) add(other.id, "same_email");
    if (other.phones.some(p => contact.phones.some(q => q.normalized === p.normalized))) add(other.id, "same_phone");
  }
  const key = nameKey(contact.name);
  if (key.includes(" ")) {
    const rows = await contactStore().prepare("SELECT id FROM contacts WHERE organization_id=? AND merged_into='' AND name_key=? AND id<>? LIMIT 50").all(org, key, contact.id);
    for (const other of await readContacts(org, rows.map(row => text(row.id)))) {
      const sharedAddress = other.addresses.some(p => contact.addresses.some(q => q.normalized === p.normalized));
      add(other.id, sharedAddress ? "same_name_and_address" : "same_name");
    }
  }
  for (const [id, why] of reasons) await recordPair(org, "contact", contact.id, id, [...why]);
  return [...reasons.keys()];
}

/** Two open opportunities for the same person in the same sales scope are probably one sale chased twice. */
export async function suggestOpportunityDuplicates(org: string, projectId: string) {
  const { listPlanRecords } = await import("../work/storage.js");
  const open = async (id: string) => (await listPlanRecords(org, { project_id: id, sales: true })).filter(plan => plan.outcome === "open" && !["completed", "canceled"].includes(text(plan.status)));
  const mine = await open(projectId);
  if (!mine.length) return [];
  const found: string[] = [];
  for (const link of await projectContactLinks(org, projectId)) {
    for (const other of await contactProjectIds(org, link.contact_id)) {
      if (other === projectId || found.includes(other)) continue;
      const theirs = await open(other);
      if (theirs.some(plan => mine.some(own => text(own.template_id) === text(plan.template_id)))) {
        found.push(other);
        await recordPair(org, "project", projectId, other, ["same_contact_same_sales_scope"]);
      }
    }
  }
  return found;
}

export async function listDuplicates(org: string, kind: "contact" | "project", options: { status?: string; limit?: number } = {}) {
  const rows = await contactStore().prepare("SELECT * FROM contact_duplicates WHERE organization_id=? AND kind=? AND status=? ORDER BY updated_at DESC LIMIT ?")
    .all(org, kind, text(options.status) || "open", Math.min(200, Math.max(1, Number(options.limit) || 50)));
  return rows.map(row => {
    let reasons: string[] = []; try { reasons = JSON.parse(text(row.reasons_json)); } catch { reasons = []; }
    return { kind, first_id: text(row.first_id), second_id: text(row.second_id), reasons, status: text(row.status), updated_at: text(row.updated_at) };
  });
}

export async function dismissDuplicate(org: string, kind: "contact" | "project", a: string, b: string) {
  const [first, second] = [text(a), text(b)].sort() as [string, string];
  const result = await contactStore().prepare("UPDATE contact_duplicates SET status='dismissed', updated_at=? WHERE organization_id=? AND kind=? AND first_id=? AND second_id=?").run(now(), org, kind, first, second);
  if (!Number(result.changes)) throw badRequest("duplicate_not_found", "That suggestion no longer exists.");
  return { kind, first_id: first, second_id: second, status: "dismissed" };
}

