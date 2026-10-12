import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('an Instant Full Org starts with the roofing price book library and its suppliers', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'roofing-library-'));
  Object.assign(process.env, { NODE_ENV: 'test', PLATFORM_STORAGE_ROOT: root, PRICEBOOK_STORAGE_ROOT: path.join(root, 'pricebook'), PLATFORM_HEARTBEAT_DISABLED: '1', SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, 'sandbox'), FIRSTMEASURE_DATA_ENVIRONMENT: 'development' });
  const signup = await import('../signup-sandbox/service.js');
  await signup.ensureSeedData();
  const { authContext: ctx } = await signup.createTestInstance('swf_instant_full_org');
  const { ROOFING_LIBRARY_ITEMS, ROOFING_LIBRARY_SUPPLIERS } = await import('../materials/roofing-library-data.js');
  const { seedInstantRoofingLibrary } = await import('../materials/roofing-library.js');
  const { getOrganizationPricebook } = await import('../pricebook/storage.js');
  const { listSuppliers, quoteSupplierDelivery } = await import('../materials/suppliers.js');

  const catalog = (await getOrganizationPricebook(ctx.orgId)).catalog.items;
  const shingle = catalog.find((item) => item.id === 'lib-shingle-gaf-hdz');
  assert.equal(shingle?.name, 'GAF Timberline HDZ Architectural Shingles'); assert.equal(shingle?.code, '0489180'); assert.equal(shingle?.unit, 'bundle');
  assert.ok(Number(shingle?.internal_cost) > 0 && Number(shingle?.unit_price) > Number(shingle?.internal_cost));
  assert.equal(catalog.filter((item) => String(item.id).startsWith('lib-')).length, ROOFING_LIBRARY_ITEMS.length);
  assert.ok(catalog.some((item) => !String(item.id).startsWith('lib-')), 'the template price book items are kept');

  const suppliers = await listSuppliers(ctx.orgId);
  assert.deepEqual(suppliers.map((row) => row.name).sort(), ROOFING_LIBRARY_SUPPLIERS.map((row) => row.name).sort());
  const ids = new Set(catalog.map((item) => String(item.id)));
  for (const supplier of suppliers) {
    assert.ok(supplier.offerings.length > 20, supplier.name);
    assert.ok(supplier.offerings.every((row) => ids.has(row.item_id)), `${supplier.name} only lists price book items`);
    assert.equal(supplier.order_email, '', 'real suppliers get no order email in test data');
  }
  const depot = suppliers.find((row) => row.name === 'The Home Depot')!;
  assert.equal(depot.offerings.find((row) => row.item_id === 'lib-shingle-gaf-hdz')?.sku, '309755006');
  assert.equal(depot.delivery_fee?.amount_cents, 7900);
  const srs = suppliers.find((row) => row.name === 'SRS Building Products')!;
  assert.equal(srs.locations.length, 5); assert.ok(srs.offerings.every((row) => row.price_cents == null), 'no distributor price was observed');
  const quote = quoteSupplierDelivery(depot, null, [{ item_id: 'lib-ridge-gaf-seal-a-ridge', quantity: 2 }]);
  assert.equal(quote.covers_all, true); assert.equal(quote.total_cents, 2 * 5997 + 7900);

  // Running it again changes nothing an organization would notice.
  await seedInstantRoofingLibrary(ctx.orgId, ctx);
  assert.equal((await getOrganizationPricebook(ctx.orgId)).catalog.items.length, catalog.length);
  const again = await listSuppliers(ctx.orgId);
  assert.equal(again.length, suppliers.length); assert.equal(again.find((row) => row.name === "Lowe's")?.locations.length, 5);
});
