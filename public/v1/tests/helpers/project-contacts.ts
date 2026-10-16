import type { JsonObject } from "../../platform/storage.js";

// A project's contacts are written through the contact service, never with the project
// (docs/architecture/contacts.md). Tests that set up a project with contacts write the
// project without them and then link the contacts, as the contacts API does.

/** Writes a project and then its `data.contacts` (entries as `saveProjectContacts` takes them). */
export async function upsertProjectWithContacts(orgId: string, input: JsonObject & { id: string; data?: JsonObject }, options: Parameters<typeof import("../../platform/storage.js").upsertDocument>[3] = {}) {
  const storage = await import("../../platform/storage.js");
  const { contacts, ...data } = (input.data || {}) as JsonObject;
  const saved = await storage.upsertDocument(orgId, "projects", { ...input, data }, options);
  if (Array.isArray(contacts)) {
    const { saveProjectContacts } = await import("../../contacts/records.js");
    await saveProjectContacts(orgId, String(saved.id), contacts);
    return storage.readDocument(orgId, "projects", String(saved.id));
  }
  return saved;
}

/** The same through the HTTP API: a client with `request(method, path, body)`. */
export async function putProjectContacts(client: { request: (method: string, path: string, body?: unknown) => Promise<any> }, orgId: string, projectId: string, contacts: unknown[]) {
  return client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${encodeURIComponent(projectId)}/contacts`, { contacts });
}
