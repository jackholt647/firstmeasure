import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from './helpers/platform-fixture.js';
const dir = await mkdtemp(path.join(os.tmpdir(), 'operations-onboarding-'));
Object.assign(process.env, { NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: path.join(dir, 'platform'), PRICEBOOK_STORAGE_ROOT: path.join(dir, 'pricebook'), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, 'firstmeasure'), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, 'index.sqlite'), PLATFORM_HEARTBEAT_DISABLED: '1', FIRSTMEASURE_JOB_WORKERS: '0' });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }); });

test('Operations offers equipment without activating it, keeps labor hidden, and saves optional suppliers through their writer', async () => {
  const storage = await import('../platform/storage.js');
  const orgId = 'org_operations_onboarding';
  await storage.createOrganization({ id: orgId, name: 'Operations test' });
  const flags = { 'platform.materials': true, 'platform.pricebook': true, 'apps.crew': true, 'apps.equipment': false, 'platform.people_access': true, 'platform.expanded_access': true };
  await enableExpandedPlatformFixture(orgId, flags);
  const auth = { orgId, userId: 'owner', role: 'owner', permissions: { '*': true }, branchId: 'default', capabilities: { effectiveByKey: flags } } as any;
  const { userPublicationContext } = await import('../platform/publication/context.js');
  const ctx = userPublicationContext(auth, { mode: 'command', projectId: 'project_a' });
  const setup = await import('../operations/onboarding.js');
  const { initializePublication } = await import('../platform/publication/bootstrap.js'); initializePublication();
  const { invokeAction } = await import('../platform/publication/actions.js');
  const { listResourceTypes } = await import('../materials/resource-types.js');
  await setup.initializeOperationsResources(ctx);
  const caps = await (await import('../platform/capabilities.js')).effectiveCapabilities(orgId);
  assert.equal(caps.effectiveByKey['apps.equipment'], false);
  assert.ok(((await storage.readGlobal(orgId)).data.app_offers as string[]).includes('portal.equipment'));
  assert.equal((await listResourceTypes(orgId)).some(row => row.id === 'labor'), false);
  assert.equal((await listResourceTypes(orgId, {includeHidden:true})).find(row=>row.id==='labor')?.shown,'when_configured');
  await (await import('../platform/capabilities.js')).saveCapabilityValues(orgId, {'apps.crew':false});
  assert.equal((await listResourceTypes(orgId)).some(row=>row.id==='labor'),false,'the initial Labor column stays hidden when workforce is off');
  await setup.initializeOperationsResources(ctx);
  assert.equal((await listResourceTypes(orgId, { includeHidden: true })).find(row => row.id === 'labor')?.revision, 1, 'preparing again does not overwrite configuration');
  await assert.rejects(() => setup.completeOperationsSetup(ctx, { operations_scope_ready: true }), /scope of work first/i, 'a browser boolean cannot finish setup');
  await assert.rejects(() => setup.initializeOperationsResources({ ...ctx, auth: null }), /access is required/i);
  const target = { scope: 'organization' as const, organizationId: orgId };
  const ref = { action: 'operations.suppliers.setup.apply', target };
  const input = { suppliers: [{ name: 'My supplier' }] };
  await invokeAction(ctx, ref, input, { idempotencyKey: 'supplier-setup' });
  await invokeAction(ctx, ref, input, { idempotencyKey: 'supplier-setup' });
  assert.equal((await (await import('../materials/suppliers.js')).listSuppliers(orgId)).length, 1);
  const status = await setup.operationsSetupStatus(ctx, {});
  assert.equal(status.setup.suppliers.complete, true);
  assert.equal(status.setup.equipment.complete, false);
  assert.equal(status.setup.workforce.complete, false);
  assert.equal(status.scope_ready, false);
  await assert.rejects(() => invokeAction(ctx, { action: 'operations.workforce.setup.apply', target }, { labor: { assignees: [] } }, { idempotencyKey: 'empty-workforce' }), /Add someone/);
  const { listResourceGroups } = await import('../workforce/storage.js');
  const { listPaySheets } = await import('../labor/pay-sheets.js');
  const workforceRef = { action: 'operations.workforce.setup.apply', target };
  const workforceInput = { labor: { assignees: [{ kind: 'resource_group', name: 'Installation team', pay: { method: 'hourly', rate: 45 } }] } };
  for (const permission of ['manage_projects', 'manage_company_settings']) {
    const denied = userPublicationContext({ ...auth, userId: 'restricted', role: 'member', permissions: { '*': true, [permission]: false }, accessProfile: { roles: [], app_restrictions: [] } } as any, { mode: 'command' });
    await assert.rejects(() => invokeAction(denied, workforceRef, workforceInput, { idempotencyKey: 'denied-' + permission }), /not permitted|access is required/i);
    assert.equal((await listResourceGroups(orgId, {})).length, 0, 'denial precedes assignee mutation');
    assert.equal((await listPaySheets(orgId)).length, 0, 'denial precedes pay mutation');
    assert.equal((await listResourceTypes(orgId)).some(row => row.id === 'labor'), false);
  }
  await invokeAction(ctx, workforceRef, workforceInput, { idempotencyKey: 'workforce-setup' });
  await invokeAction(ctx, workforceRef, workforceInput, { idempotencyKey: 'workforce-setup' });
  assert.equal((await listResourceGroups(orgId, {})).length, 1);
  const sheets = await listPaySheets(orgId);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0]!.entries[0]!.rate_cents, 4500);
  assert.equal((await listResourceTypes(orgId)).find(row => row.id === 'labor')?.shown, 'always');
  await setup.initializeOperationsResources(ctx);
  assert.equal((await listResourceTypes(orgId)).find(row => row.id === 'labor')?.shown, 'always', 'reopening preserves configured labor');
});

test('Labor setup visibility preserves legacy plain lines, existing work and explicit settings',async()=>{
  const storage=await import('../platform/storage.js'),types=await import('../materials/resource-types.js'),setup=await import('../operations/onboarding.js');
  const orgId='org_operations_labor_visibility';await storage.createOrganization({id:orgId});
  const flags={'platform.materials':true,'platform.pricebook':true,'apps.crew':false};await enableExpandedPlatformFixture(orgId,flags);
  const auth={orgId,userId:'owner',role:'owner',permissions:{'*':true},branchId:'default',capabilities:{effectiveByKey:flags}} as any;
  const ctx=(await import('../platform/publication/context.js')).userPublicationContext(auth,{mode:'command'});
  await setup.initializeOperationsResources(ctx);
  assert.equal(await types.laborColumnShown(orgId,{shown:'when_configured'}),false);
  assert.equal(await types.laborColumnShown(orgId,{shown:'with_assignees'}),true,'legacy plain-line fallback remains');
  const row=(await types.listResourceTypes(orgId,{includeHidden:true})).find(row=>row.id==='labor')!;
  const {revision,...resourceInput}=row;
  assert.equal(types.resourceTypeInputSchema.parse({...resourceInput,expected_revision:revision}).shown,'when_configured');
  await storage.upsertDocument(orgId,'material_lists',{id:'legacy_labor',data:{resource_type:'labor',project_id:'project_a',status:'draft'}});
  assert.equal(await types.laborColumnShown(orgId,{shown:'when_configured'}),true,'existing work is never hidden');
  await types.saveResourceType(orgId,{...resourceInput,shown:'always',expected_revision:revision},auth);
  await setup.initializeOperationsResources(ctx);
  assert.equal((await types.listResourceTypes(orgId,{includeHidden:true})).find(row=>row.id==='labor')?.shown,'always');
});

test('Operations initialization preserves already active Equipment', async () => {
  const storage = await import('../platform/storage.js');
  const orgId = 'org_operations_equipment_active';
  await storage.createOrganization({ id: orgId, name: 'Active Equipment' });
  const flags = { 'platform.materials': true, 'platform.pricebook': true, 'apps.crew': true, 'apps.equipment': true, 'platform.expanded_access': true };
  await enableExpandedPlatformFixture(orgId, flags);
  const auth = { orgId, userId: 'owner', role: 'owner', permissions: { '*': true }, branchId: 'default', capabilities: { effectiveByKey: flags } } as any;
  const ctx = (await import('../platform/publication/context.js')).userPublicationContext(auth, { mode: 'command' });
  await (await import('../operations/onboarding.js')).initializeOperationsResources(ctx);
  assert.equal((await (await import('../platform/capabilities.js')).effectiveCapabilities(orgId)).effectiveByKey['apps.equipment'], true);
  assert.equal(((await storage.readGlobal(orgId)).data.app_offers as string[] | undefined)?.includes('portal.equipment') || false, false);
});

test('workforce opt-in checks both permissions before changing organization features', async () => {
  const storage = await import('../platform/storage.js');
  const orgId = 'org_operations_workforce_optin';
  await storage.createOrganization({ id: orgId, name: 'Optional workforce' });
  const flags = { 'platform.materials': true, 'platform.pricebook': true, 'apps.crew': false, 'platform.people_access': false, 'platform.expanded_access': true };
  await enableExpandedPlatformFixture(orgId, flags);
  const auth = { orgId, userId: 'owner', role: 'owner', permissions: { '*': true }, branchId: 'default', capabilities: { effectiveByKey: flags } } as any;
  const { userPublicationContext } = await import('../platform/publication/context.js');
  const { invokeAction } = await import('../platform/publication/actions.js');
  const { effectiveCapabilities } = await import('../platform/capabilities.js');
  const ref = { action: 'operations.workforce.setup.start', target: { scope: 'project' as const, organizationId: orgId, projectId: 'project_a' } };
  for (const permission of ['manage_projects', 'manage_company_settings']) {
    const denied = userPublicationContext({ ...auth, userId: 'restricted', role: 'member', permissions: { '*': true, [permission]: false }, accessProfile: { roles: [], app_restrictions: [] } } as any, { mode: 'command' });
    await assert.rejects(() => invokeAction(denied, ref, {}, { idempotencyKey: 'denied-' + permission }), /not permitted|access is required/i);
    assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['apps.crew'], false);
    assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['platform.people_access'], false);
  }
  await invokeAction(userPublicationContext(auth, { mode: 'command' }), ref, {}, { idempotencyKey: 'workforce-optin' });
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['apps.crew'], true);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['platform.people_access'], true);
  assert.equal((await (await import('../workforce/storage.js')).listResourceGroups(orgId, {})).length, 0);
  assert.equal((await (await import('../guided-experiences/store.js')).readProgress(orgId, '', 'operations.workforce.setup'))?.status === 'completed', false);
});

