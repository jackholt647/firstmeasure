import { createHash } from "node:crypto";
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { requirePlatformAuth } from '../platform/auth.js';
import { listDocuments, upsertDocument } from '../platform/storage.js';
import { documentTags } from './tags.js';
import { DOCUMENT_CAPABILITIES } from './capability_policy.js';

const catalogId = (id:string) => `tag_${createHash("sha256").update(id).digest("hex")}`;
// IDs remain stable when labels change or tags are retired: signed artifacts and
// notification selectors must never be silently rewritten by catalog maintenance.
export async function listDocumentTags(orgId: string) {
  const catalog = await listDocuments(orgId, 'document_tags');
  const tags = new Map(catalog.map(row => [String(row.data.tag_id), { id: String(row.data.tag_id), label: String(row.data.label), archived: row.data.archived === true, revision: row.revision }]));
  for (const collection of ['document_templates', 'document_workflows', 'document_modules', 'document_folder_items', 'documents']) {
    for (const row of await listDocuments(orgId, collection)) for (const id of documentTags(row.data.tags)) {
      if (!tags.has(id)) tags.set(id, { id, label: id, archived: false, revision: 0 });
    }
  }
  return [...tags.values()].sort((a, b) => a.label.localeCompare(b.label));
}
const label = z.string().trim().min(1).max(80);
export function registerDocumentTagRoutes(app: FastifyInstance) {
  app.get('/organizations/:orgId/tags', async request => {
    const { orgId } = request.params as { orgId: string };
    await requirePlatformAuth(request, { orgId, permission: 'view_documents', capability: DOCUMENT_CAPABILITIES.app });
    return { tags: await listDocumentTags(orgId) };
  });
  app.post('/organizations/:orgId/tags', async request => {
    const { orgId } = request.params as { orgId: string };
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: 'manage_company_settings', capability: DOCUMENT_CAPABILITIES.studio });
    const body = z.object({ label }).strict().parse(request.body);
    const id = documentTags([body.label])[0]!;
    const row = await upsertDocument(orgId, 'document_tags', { id:catalogId(id), data: { tag_id:id, label: body.label, archived: false, updated_by: ctx.userId } }, { createOnly: true });
    return { tag: { id, ...row.data, revision: row.revision } };
  });
  app.patch('/organizations/:orgId/tags/:tagId', async request => {
    const { orgId, tagId } = request.params as { orgId: string; tagId: string };
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: 'manage_company_settings', capability: DOCUMENT_CAPABILITIES.studio });
    const body = z.object({ label: label.optional(), archived: z.boolean().optional(), expected_revision: z.number().int().min(0) }).strict().parse(request.body);
    // Revision zero represents a discovered legacy tag that has no catalog row.
    const row = await upsertDocument(orgId, 'document_tags', { id: catalogId(tagId), expected_revision: body.expected_revision || undefined, data: { tag_id:tagId, ...(body.label ? { label: body.label } : body.expected_revision === 0 ? { label: tagId } : {}), ...(body.archived === undefined ? {} : { archived: body.archived }), updated_by: ctx.userId } }, { ...(body.expected_revision === 0 ? { createOnly: true } : {}) });
    return { tag: { id: tagId, ...row.data, revision: row.revision } };
  });
}
