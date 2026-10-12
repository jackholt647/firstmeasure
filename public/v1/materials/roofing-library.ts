import type { PlatformAuthContext } from '../platform/auth.js';
import { getOrganizationPricebook, saveOrganizationCatalog } from '../pricebook/storage.js';
import { ROOFING_LIBRARY_ITEMS, ROOFING_LIBRARY_SUPPLIERS } from './roofing-library-data.js';
import { listSuppliers, saveSupplier, saveSupplierLocation } from './suppliers.js';

/**
 * Gives a development test organization a working roofing price book and supplier list: estimating items with
 * manufacturer codes, and four suppliers whose catalogues point at those items. Safe to run again: items are
 * matched by id, suppliers and locations by name, and anything the organization added is left alone.
 */
export async function seedInstantRoofingLibrary(orgId: string, auth: PlatformAuthContext) {
  const current = await getOrganizationPricebook(orgId);
  const existing = current.catalog.items;
  const ids = new Set(ROOFING_LIBRARY_ITEMS.map(([id]) => id));
  const items = [
    ...existing.filter((item) => !ids.has(String(item.id))),
    ...ROOFING_LIBRARY_ITEMS.map(([id, name, code, type, manufacturer, unit, cost, price, note]) => ({
      id, kind: 'atomic', name, code, type, category: 'shingle_roofs', segment: 'all', manufacturer, unit,
      internal_cost: cost, unit_price: price, base_price: price, description: note, external_description: note,
      metadata: { source: 'roofing_library' }
    }))
  ];
  await saveOrganizationCatalog(orgId, { ...current.catalog, items }, Number(current.manifest.revision));

  const before = await listSuppliers(orgId);
  for (const entry of ROOFING_LIBRARY_SUPPLIERS) {
    const match = before.find((row) => row.name === entry.name);
    const supplier = await saveSupplier(orgId, {
      ...(match ? { id: match.id } : {}), name: entry.name,
      delivery_fee: entry.delivery_fee_cents == null ? null : { amount_cents: entry.delivery_fee_cents, free_above_cents: null },
      offerings: entry.offerings.map(([item_id, sku, price_cents]) => ({ item_id, sku, price_cents }))
    }, auth);
    for (const [name, address, phone] of entry.locations) {
      const known = supplier.locations.find((row) => row.name === name);
      await saveSupplierLocation(orgId, { ...(known ? { id: known.id } : {}), supplier_id: supplier.id, name, address, phone }, auth);
    }
  }
  return { items: ROOFING_LIBRARY_ITEMS.length, suppliers: ROOFING_LIBRARY_SUPPLIERS.length };
}
