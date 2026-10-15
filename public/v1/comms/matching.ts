// Match an inbound address (email or phone) to a contact, and to the project the
// conversation most likely belongs to. Used by the email engine, the Telnyx
// inbound webhook, and the comms simulator.

import { readDocument } from "../platform/storage.js";
import { contactProjectIds, findExactMatches } from "../contacts/records.js";

const cleanText = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export type ProjectContactMatch = {
  project_id: string;
  contact_id: string;
  contact_name: string;
  project_updated_at: string;
};

/**
 * Contacts are found through the contact store's point index. When the contact
 * is on several projects (repeat customers), the most recently updated project
 * that is not archived wins — that is almost always the active conversation. A
 * contact on no project matches with an empty project id.
 */
export async function matchProjectContact(
  organizationId: string,
  address: { email?: string; phone?: string }
): Promise<ProjectContactMatch | null> {
  let contacts: Awaited<ReturnType<typeof findExactMatches>> = [];
  try {
    contacts = await findExactMatches(organizationId, { email: cleanText(address.email), phone: cleanText(address.phone) });
  } catch {
    return null;
  }
  const matches: ProjectContactMatch[] = [];
  for (const contact of contacts) {
    const projects: ProjectContactMatch[] = [];
    for (const projectId of await contactProjectIds(organizationId, contact.id)) {
      const project = await readDocument(organizationId, "projects", projectId).catch(() => null);
      const data = asObject(project?.data);
      const status = cleanText(data.status).toLowerCase();
      if (!project || status === "archived" || status === "deleted") continue;
      projects.push({ project_id: projectId, contact_id: contact.id, contact_name: contact.name, project_updated_at: cleanText(data.updated_at || project.updated_at) });
    }
    matches.push(...(projects.length ? projects : [{ project_id: "", contact_id: contact.id, contact_name: contact.name, project_updated_at: "" }]));
  }
  if (!matches.length) return null;
  matches.sort((a, b) => (a.project_updated_at < b.project_updated_at ? 1 : -1));
  return matches[0] ?? null;
}
