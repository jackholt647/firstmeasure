import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { registerAction, invokeAction } from '../platform/publication/actions.js';
import type { PublicationContext } from '../platform/publication/contracts.js';
import { backendImplementationDigest } from '../platform/publication/implementation.js';
import { badRequest, forbidden } from '../platform/errors.js';
import { listSuppliers } from '../materials/suppliers.js';
import { listResourceTypes, saveResourceType } from '../materials/resource-types.js';
import { laborSetupInputSchema } from '../labor/labor-setup.js';
import { mutateGlobal, type JsonObject } from '../platform/storage.js';
import { flattenGroupedValues, groupCapabilityValues, isCapabilityEnabled, saveCapabilityValues } from '../platform/capabilities.js';
import { hasPermission } from '../platform/auth.js';
import { EQUIPMENT_VIEW } from '../equipment/access.js';
import { offeredAppIds } from '../platform/app-experience/offers.js';
import { readProgress } from '../guided-experiences/store.js';
import { operationsDocumentReady } from './documents.js';

const documentInput = z.object({ operations_document_id: z.string().trim().max(200).optional(), document_id: z.string().trim().max(200).optional() }).passthrough();
const supplierInput = z.object({ suppliers: z.array(z.object({ name: z.string().trim().min(1).max(200) }).passthrough()).min(1).max(40) }).passthrough();
const workforceInput = z.object({ labor: laborSetupInputSchema, include_labor: z.boolean().optional() }).passthrough();

/** The first scope setup starts with materials. Existing configured columns are never reset. */
export async function initializeOperationsResources(ctx: PublicationContext) {
  if (!ctx.auth || ctx.auth.orgId !== ctx.organizationId || !hasPermission(ctx.auth, 'manage_projects')) throw forbidden('operations_setup_denied', 'Project management access is required.');
  // Operations offers Equipment without enabling its operational capability. Previously activated fleets stay on.
  await mutateGlobal(ctx.organizationId, current => {
    const data = (current.data || {}) as Record<string, unknown>;
    const flags = flattenGroupedValues((data.app_flags || data.feature_flags || {}) as JsonObject);
    const pending = offeredAppIds(data.app_offers);
    if ((data.app_activations as Record<string, unknown> | undefined)?.['portal.equipment']) return { data: {} };
    if (flags['apps.equipment'] === true && !pending.includes('portal.equipment')) return { data: {} };
    return { data: { app_flags: groupCapabilityValues({ ...flags, 'apps.equipment': true }), app_offers: [...new Set([...pending, 'portal.equipment'])] } };
  });
  const labor = (await listResourceTypes(ctx.organizationId, { includeHidden: true })).find(row => row.id === 'labor');
  if (!labor || labor.revision || !ctx.auth) return;
  const { revision, ...fields } = labor;
  try { await saveResourceType(ctx.organizationId, { ...fields, shown: 'when_configured', expected_revision: revision }, ctx.auth); }
  catch (error: any) { if (error?.statusCode !== 409) throw error; }
}

export async function operationsSetupStatus(ctx: PublicationContext, value: unknown) {
  const input = documentInput.parse(value);
  const documentId = input.operations_document_id || input.document_id || '';
  const ready = documentId ? await operationsDocumentReady(ctx, documentId) : null;
  const equipmentReady = async () => {
    if (!ctx.auth || !hasPermission(ctx.auth, EQUIPMENT_VIEW) || !await isCapabilityEnabled(ctx.organizationId, 'apps.equipment')) return false;
    const result = await invokeAction({ ...ctx, mode: 'evaluate' }, { action: 'equipment.fleet.list', target: { scope: 'organization', organizationId: ctx.organizationId } }, {}) as { value?: unknown };
    return Array.isArray(result.value) && result.value.length > 0;
  };
  const [suppliers, equipment, workforce, proposal] = await Promise.all([
    listSuppliers(ctx.organizationId), equipmentReady(),
    readProgress(ctx.organizationId, '', 'operations.workforce.setup'),
    readProgress(ctx.organizationId, '', 'operations.proposal.setup')
  ]);
  return { scope_ready: !!ready?.ready, document_id: documentId,
    setup: { materials: { complete: !!ready?.ready }, suppliers: { complete: suppliers.length > 0 },
      equipment: { complete: equipment }, workforce: { complete: workforce?.status === 'completed' },
      proposals: { complete: ready?.path === 'proposal' && ready.ready || proposal?.status === 'completed' } } };
}

export async function completeOperationsSetup(ctx: PublicationContext, value: unknown) {
  const input = documentInput.parse(value), id = input.operations_document_id || input.document_id;
  if (!id) throw badRequest('operations_scope_required', 'Build your scope of work first.');
  const ready = await operationsDocumentReady(ctx, id);
  if (!ready.ready) throw badRequest('operations_scope_unpublished', 'Finish publishing your scope of work first.');
  return ready;
}

export function registerOperationsSetupPublication() {
  const base = { version: '1', domain: 'materials', implementation: backendImplementationDigest(), outputSchema: { type: 'object' }, executionKinds: ['api', 'agent', 'module'] as const };
  registerAction({ ...base, id: 'operations.workforce.setup.start', description: 'Opt into workforce setup while leaving labor unconfigured until assignees are saved.',
    inputSchema: { type: 'object', additionalProperties: false },
    policy: { scopes: ['project'], permissions: ['manage_company_settings', 'manage_projects'], capabilities: ['platform.materials'] }, effect: 'write', idempotency: 'required',
    execute: async ctx => {
      if (!ctx.auth || !hasPermission(ctx.auth, 'manage_projects')) throw forbidden('operations_workforce_denied', 'Project management access is required.');
      await saveCapabilityValues(ctx.organizationId, { 'apps.crew': true, 'platform.people_access': true });
      return { started: true };
    } });
  registerAction({ ...base, id: 'operations.setup.status', description: 'Read the Operations setup checklist from saved scope and setup records.',
    inputSchema: zodToJsonSchema(documentInput, { $refStrategy: 'none' }) as Record<string, unknown>,
    policy: { scopes: ['project'], permissions: ['manage_projects'], capabilities: ['platform.materials'] }, effect: 'read', idempotency: 'none',
    execute: (ctx, target, input) => operationsSetupStatus({ ...ctx, projectId: target.projectId }, input) });
  registerAction({ ...base, id: 'operations.setup.complete', description: 'Finish Operations setup only after its own project scope has been published.',
    inputSchema: zodToJsonSchema(documentInput, { $refStrategy: 'none' }) as Record<string, unknown>,
    policy: { scopes: ['project'], permissions: ['manage_projects'], capabilities: ['platform.materials'] }, effect: 'write', idempotency: 'required',
    execute: (ctx, target, input) => completeOperationsSetup({ ...ctx, projectId: target.projectId }, input) });
  registerAction({ ...base, id: 'operations.suppliers.setup.apply', description: 'Save the suppliers chosen in Operations through the ordinary supplier writer.',
    inputSchema: zodToJsonSchema(supplierInput, { $refStrategy: 'none' }) as Record<string, unknown>,
    policy: { scopes: ['organization'], permissions: ['manage_company_settings'], capabilities: ['platform.materials'] }, effect: 'write', idempotency: 'required',
    validateInput: input => { supplierInput.parse(input); },
    execute: async (ctx, target, input, execution) => {
      const current = await listSuppliers(ctx.organizationId), saved = [], seen = new Set<string>();
      for (const [index, entry] of supplierInput.parse(input).suppliers.entries()) {
        const nameKey = entry.name.toLowerCase();
        if (seen.has(nameKey)) continue;
        seen.add(nameKey);
        const existing = current.find(row => row.name.toLowerCase() === nameKey);
        const result = await invokeAction({ ...ctx, mode: 'command' }, { action: 'suppliers.supplier.save', target },
          { name: entry.name, ...(existing ? { id: existing.id, expected_revision: existing.revision } : {}) },
          { idempotencyKey: `${execution.receiptId}:supplier:${index}` });
        saved.push(result);
      }
      return { suppliers: saved };
    } });
  registerAction({ ...base, id: 'operations.workforce.setup.apply', description: 'Save the assignees and pay sheets, then enable their work-order column.',
    inputSchema: zodToJsonSchema(workforceInput, { $refStrategy: 'none' }) as Record<string, unknown>,
    policy: { scopes: ['organization'], permissions: ['manage_company_settings', 'manage_projects'], capabilities: ['platform.materials', 'apps.crew'] }, effect: 'write', idempotency: 'required',
    validateInput: input => { const parsed = workforceInput.parse(input); if (!parsed.labor.assignees.length) throw badRequest('operations_workforce_required', 'Add someone who will do the work, or return to setup.'); },
    execute: async (ctx, target, input, execution) => {
      if (!ctx.auth || !hasPermission(ctx.auth, 'manage_projects')) throw forbidden('operations_workforce_denied', 'Project management access is required.');
      const result = await invokeAction({ ...ctx, mode: 'command' }, { action: 'labor.setup.apply', target }, workforceInput.parse(input).labor, { idempotencyKey: `${execution.receiptId}:labor` });
      const labor = (await listResourceTypes(ctx.organizationId, { includeHidden: true })).find(row => row.id === 'labor')!;
      const { revision, ...fields } = labor;
      await saveResourceType(ctx.organizationId, { ...fields, shown: 'always', expected_revision: revision }, ctx.auth!);
      return result;
    } });
}
