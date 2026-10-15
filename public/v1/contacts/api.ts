import { userPublicationContext } from "../platform/publication/context.js";
import { readFields } from "../custom_fields/records.js";
import type { FastifyInstance } from "fastify";
import { requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { readDocument } from "../platform/storage.js";
import { assertManageBranches, assertSeeBranches, branchScope } from "../workforce/branch-scope.js";
import { contactSettings, saveContactSettings, contactOptions } from "./service.js";
import { contactProjectIds, createContact, findExactMatches, listContacts, readContact, refreshProjections, setProjectContactLinks, updateContact, type ContactRecord } from "./records.js";
import { text, asObject } from "./contracts.js";

// A contact with no branches is visible in every branch (docs/architecture/contacts.md).
function visibleBranches(ctx: PlatformAuthContext) { const scope = branchScope(ctx); return scope.restricted_view ? scope.visible_branch_ids : null; }
function assertVisible(ctx: PlatformAuthContext, contact: ContactRecord) { if (contact.branch_ids.length) assertSeeBranches(branchScope(ctx), contact.branch_ids); }
function assertManageable(ctx: PlatformAuthContext, branchIds: string[]) { if (branchIds.length) assertManageBranches(branchScope(ctx), branchIds); }
const params = (request: { params: unknown }) => asObject(request.params);

export function registerContactRoutes(app: FastifyInstance) {
  app.get("/organizations/:orgId/contacts/options", async request => {
    const orgId = text(params(request).orgId); await requirePlatformAuth(request, { orgId, permission: "view_contacts" });
    return { ok: true, contacts: await contactOptions(orgId, text(asObject(request.query).kind) || "either") };
  });
  app.get("/organizations/:orgId/contacts/settings", async request => {
    const orgId = text(params(request).orgId); await requirePlatformAuth(request, { orgId, permission: "view_contacts" });
    return { ok: true, settings: await contactSettings(orgId) };
  });
  app.put("/organizations/:orgId/contacts/settings", async request => {
    const orgId = text(params(request).orgId); await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, settings: await saveContactSettings(orgId, request.body) };
  });
  app.get("/organizations/:orgId/contacts", async request => {
    const orgId = text(params(request).orgId), ctx = await requirePlatformAuth(request, { orgId, permission: "view_contacts" }), query = asObject(request.query);
    const page = await listContacts(orgId, { q: text(query.q), kind: text(query.kind), tag: text(query.tag), after: text(query.after), limit: Number(query.limit) || 50, branch_ids: visibleBranches(ctx) });
    return { ok: true, contacts: page.items, next: page.next };
  });
  app.post("/organizations/:orgId/contacts/match", async request => {
    const orgId = text(params(request).orgId), ctx = await requirePlatformAuth(request, { orgId, permission: "view_contacts" });
    const scope = branchScope(ctx);
    const matches = (await findExactMatches(orgId, asObject(request.body))).filter(c => !c.branch_ids.length || !scope.restricted_view || c.branch_ids.some(b => scope.visible_branch_ids.includes(b)));
    return { ok: true, contacts: matches };
  });
  app.post("/organizations/:orgId/contacts", async request => {
    const orgId = text(params(request).orgId), ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const body = asObject(request.body);
    const branchIds = Array.isArray(body.branch_ids) ? body.branch_ids.map(text).filter(Boolean) : [text(ctx.branchId) || "default"];
    assertManageable(ctx, branchIds);
    return { ok: true, contact: await createContact(orgId, { ...body, branch_ids: branchIds }, {}) };
  });
  app.get("/organizations/:orgId/contacts/:contactId", async request => {
    const orgId = text(params(request).orgId), ctx = await requirePlatformAuth(request, { orgId, permission: "view_contacts" });
    const contact = await readContact(orgId, text(params(request).contactId));
    assertVisible(ctx, contact);
    const fields = await readFields(userPublicationContext(ctx), { scope: "organization", organizationId: orgId, id: contact.id }, "contact");
    return { ok: true, contact: { ...contact, custom_field_values: fields.values }, reference: { contact_id: contact.id }, revision: contact.revision, project_ids: await contactProjectIds(orgId, contact.id) };
  });
  app.patch("/organizations/:orgId/contacts/:contactId", async request => {
    const orgId = text(params(request).orgId), ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    const before = await readContact(orgId, text(params(request).contactId));
    assertManageable(ctx, before.branch_ids);
    const body = asObject(request.body), patch = { ...asObject(body.contact ?? body) };
    delete patch.expected_revision; delete patch.id; delete patch.merged_into;
    if ("branch_ids" in patch) assertManageable(ctx, Array.isArray(patch.branch_ids) ? patch.branch_ids.map(text).filter(Boolean) : []);
    return { ok: true, contact: await updateContact(orgId, before.id, patch, { expectedRevision: Number(body.expected_revision) || undefined }) };
  });
  app.put("/organizations/:orgId/projects/:projectId/contacts", async request => {
    const orgId = text(params(request).orgId), projectId = text(params(request).projectId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_projects" });
    await readDocument(orgId, "projects", projectId);
    const links = (Array.isArray(asObject(request.body).contacts) ? asObject(request.body).contacts as unknown[] : []).map(asObject)
      .map(row => ({ contact_id: text(row.contact_id || row.id), role: text(row.role), primary: row.primary === true }));
    const saved = await setProjectContactLinks(orgId, projectId, links);
    await refreshProjections(orgId, [projectId]);
    return { ok: true, contacts: saved };
  });
}
