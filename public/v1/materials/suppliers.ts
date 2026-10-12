import { z } from 'zod';
import { hasPermission, type PlatformAuthContext } from '../platform/auth.js';
import { isAppFlagEnabled } from '../platform/app_flags.js';
import { badRequest, forbidden } from '../platform/errors.js';
import { listDocuments, upsertDocument, type JsonObject } from '../platform/storage.js';
import { archiveOrganizationConnection, createOrganizationConnection, listOrganizationConnections, patchOrganizationConnection, readOrganizationConnection } from '../connections/storage.js';

// A supplier is an external organization connection holding one of these roles. Its catalogue, order
// contact and delivery fee live beside the connection; a location records only how it differs.
export const SUPPLIER_ROLES = ['material_supplier', 'equipment_rental'] as const;
export const SUPPLIER_COLLECTION = 'material_suppliers';
export const SUPPLIER_LOCATION_COLLECTION = 'material_supplier_locations';

const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const cents = z.number().int().min(0).max(1_000_000_000);
const email = z.string().trim().max(320).email().or(z.literal(''));
// A small image kept with the supplier: an https address, or an inline PNG, JPEG or WebP the editor has already scaled down.
const logo = z.string().trim().max(120_000).regex(/^(https:\/\/[^\s"'<>]+|data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)$/, 'A logo is an https address or a small PNG, JPEG or WebP image.').or(z.literal(''));
const deliveryFeeSchema = z.object({ amount_cents: cents, free_above_cents: cents.nullable().optional() }).strict();
// price_cents null or absent means the supplier carries the item at a price we do not know.
const offeringSchema = z.object({ item_id: id, sku: z.string().trim().max(120).optional(), price_cents: cents.nullable().optional() }).strict();
// carried false removes an inherited item at one location; true adds one the supplier does not otherwise list.
const overrideSchema = z.object({ item_id: id, carried: z.boolean().optional(), sku: z.string().trim().max(120).optional(), price_cents: cents.nullable().optional() }).strict();
const unique = <T extends { item_id: string }>(rows: T[], context: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const row of rows) { if (seen.has(row.item_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Item ${row.item_id} is listed twice.` }); seen.add(row.item_id); }
};
export const supplierInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  roles: z.array(z.enum(SUPPLIER_ROLES)).min(1).max(SUPPLIER_ROLES.length).optional(),
  logo: logo.optional(),
  order_email: email.optional(),
  phone: z.string().trim().max(80).optional(),
  address: z.string().trim().max(500).optional(),
  delivery_fee: deliveryFeeSchema.nullable().optional(),
  offerings: z.array(offeringSchema).max(20000).superRefine(unique).optional(),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();
export const supplierLocationInputSchema = z.object({
  id: id.optional(),
  supplier_id: id,
  name: z.string().trim().min(1).max(200),
  order_email: email.optional(),
  phone: z.string().trim().max(80).optional(),
  address: z.string().trim().max(500).optional(),
  // null inherits the supplier's fee.
  delivery_fee: deliveryFeeSchema.nullable().optional(),
  overrides: z.array(overrideSchema).max(20000).superRefine(unique).optional(),
  expected_revision: z.number().int().nonnegative().optional()
}).strict();
export const supplierArchiveSchema = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict();

export type SupplierOffering = { item_id: string; sku: string; price_cents: number | null };
export type SupplierOverride = { item_id: string; carried?: boolean; sku?: string; price_cents?: number | null };
export type DeliveryFee = { amount_cents: number; free_above_cents: number | null };
export type SupplierLocation = { id: string; supplier_id: string; name: string; order_email: string; phone: string; address: string; delivery_fee: DeliveryFee | null; overrides: SupplierOverride[]; revision: number };
export type Supplier = { id: string; name: string; roles: string[]; logo: string; order_email: string; phone: string; address: string; delivery_fee: DeliveryFee | null; offerings: SupplierOffering[]; locations: SupplierLocation[]; revision: number; connection_revision: number };

const text = (value: unknown) => String(value ?? '').trim();
const feeOf = (value: unknown): DeliveryFee | null => {
  const fee = value && typeof value === 'object' ? value as JsonObject : null;
  return fee && Number.isFinite(Number(fee.amount_cents)) ? { amount_cents: Number(fee.amount_cents), free_above_cents: fee.free_above_cents == null ? null : Number(fee.free_above_cents) } : null;
};
const priceOf = (value: unknown) => (value == null || !Number.isFinite(Number(value)) ? null : Number(value));

/** What one supplier, or one of its locations, offers for an item. A location answers from its own differences first. */
export function effectiveSupplierOffer(supplier: Pick<Supplier, 'offerings'>, location: Pick<SupplierLocation, 'overrides'> | null, itemId: string) {
  const base = supplier.offerings.find((row) => row.item_id === itemId) || null;
  const override = location?.overrides.find((row) => row.item_id === itemId) || null;
  const carried = override?.carried ?? !!base;
  if (!carried) return { carried: false, sku: '', price_cents: null as number | null, inherited: !override };
  return {
    carried: true,
    sku: override?.sku !== undefined ? override.sku : base?.sku || '',
    price_cents: override && Object.prototype.hasOwnProperty.call(override, 'price_cents') ? priceOf(override.price_cents) : base?.price_cents ?? null,
    inherited: !override
  };
}
export function effectiveDeliveryFee(supplier: Pick<Supplier, 'delivery_fee'>, location: Pick<SupplierLocation, 'delivery_fee'> | null) {
  return location?.delivery_fee || supplier.delivery_fee || null;
}
/**
 * Prices one delivery from one supplier or location. Lines with no item reference cannot be matched to a
 * catalogue and count as not carried. The subtotal and total are null while any carried line is unpriced.
 */
export function quoteSupplierDelivery(supplier: Pick<Supplier, 'offerings' | 'delivery_fee'>, location: Pick<SupplierLocation, 'overrides' | 'delivery_fee'> | null, lines: { item_id: string; quantity: number }[], options: { delivery?: boolean } = {}) {
  const missing: string[] = [], unpriced: string[] = [];
  let subtotal = 0;
  for (const line of lines) {
    const offer = line.item_id ? effectiveSupplierOffer(supplier, location, line.item_id) : { carried: false, price_cents: null };
    if (!offer.carried) missing.push(line.item_id);
    else if (offer.price_cents == null) unpriced.push(line.item_id);
    else subtotal += Math.round(offer.price_cents * Math.max(0, Number(line.quantity) || 0));
  }
  const fee = effectiveDeliveryFee(supplier, location);
  const priced = unpriced.length === 0;
  const waived = !!fee && fee.free_above_cents != null && priced && subtotal >= fee.free_above_cents;
  const delivery = options.delivery === false || !fee || waived ? 0 : fee.amount_cents;
  return { covers_all: missing.length === 0, missing_item_ids: missing, unpriced_item_ids: unpriced, subtotal_cents: priced ? subtotal : null, delivery_cents: delivery, delivery_waived: waived, total_cents: priced ? subtotal + delivery : null };
}

async function requireMaterials(orgId: string) {
  if (!await isAppFlagEnabled(orgId, 'platform', 'materials')) throw forbidden('app_flag_disabled', 'Materials are not enabled for this organization.');
}
function requireWrite(orgId: string, auth: PlatformAuthContext) {
  if (!auth || auth.orgId !== orgId || !hasPermission(auth, 'manage_company_settings')) throw forbidden('supplier_write_denied', 'Supplier editing requires company settings access.');
}
const isSupplier = (connection: JsonObject) => (Array.isArray(connection.relationship_type_ids) ? connection.relationship_type_ids : []).some((role) => (SUPPLIER_ROLES as readonly string[]).includes(String(role)));

function locationRow(document: { id: string; revision?: number; data: JsonObject }): SupplierLocation {
  const data = document.data;
  return {
    id: document.id, supplier_id: text(data.supplier_id), name: text(data.name), order_email: text(data.order_email), phone: text(data.phone), address: text(data.address),
    delivery_fee: feeOf(data.delivery_fee),
    overrides: (Array.isArray(data.overrides) ? data.overrides as JsonObject[] : []).map((row) => ({ item_id: text(row.item_id), ...(typeof row.carried === 'boolean' ? { carried: row.carried } : {}), ...(row.sku !== undefined ? { sku: text(row.sku) } : {}), ...(Object.prototype.hasOwnProperty.call(row, 'price_cents') ? { price_cents: priceOf(row.price_cents) } : {}) })),
    revision: Number(document.revision || 0)
  };
}

/** Every active supplier with its catalogue and its locations' differences. */
export async function listSuppliers(orgId: string): Promise<Supplier[]> {
  await requireMaterials(orgId);
  const [connections, catalogues, locations] = await Promise.all([
    listOrganizationConnections(orgId, { relationship_scope: 'suppliers' }),
    listDocuments(orgId, SUPPLIER_COLLECTION),
    listDocuments(orgId, SUPPLIER_LOCATION_COLLECTION)
  ]);
  const activeLocations = locations.filter((document) => !document.data.archived_at).map(locationRow);
  return connections.map((connection) => {
    const connectionId = text(connection.id);
    const catalogue = catalogues.find((document) => document.id === connectionId);
    const data = (catalogue?.data || {}) as JsonObject;
    return {
      id: connectionId, name: text(connection.name),
      roles: (connection.relationship_type_ids as unknown[]).map(String).filter((role) => (SUPPLIER_ROLES as readonly string[]).includes(role)),
      logo: text(data.logo), order_email: text(data.order_email), phone: text(data.phone), address: text(data.address),
      delivery_fee: feeOf(data.delivery_fee),
      offerings: (Array.isArray(data.offerings) ? data.offerings as JsonObject[] : []).map((row) => ({ item_id: text(row.item_id), sku: text(row.sku), price_cents: priceOf(row.price_cents) })),
      locations: activeLocations.filter((location) => location.supplier_id === connectionId).sort((a, b) => a.name.localeCompare(b.name)),
      revision: Number(catalogue?.revision || 0), connection_revision: Number(connection.revision || 0)
    };
  });
}
async function readSupplier(orgId: string, supplierId: string) {
  const supplier = (await listSuppliers(orgId)).find((row) => row.id === supplierId);
  if (!supplier) throw badRequest('supplier_unknown', 'This supplier is unavailable.');
  return supplier;
}

/** Creates a supplier, or replaces the name, contact, fee and catalogue of an existing one. Omitted fields are kept. */
export async function saveSupplier(orgId: string, input: unknown, auth: PlatformAuthContext) {
  await requireMaterials(orgId); requireWrite(orgId, auth);
  const parsed = supplierInputSchema.parse(input);
  let supplierId = parsed.id || '';
  const existing = supplierId ? (await listSuppliers(orgId)).find((row) => row.id === supplierId) || null : null;
  if (supplierId && !existing) throw badRequest('supplier_unknown', 'This supplier is unavailable.');
  if (!existing) {
    const connection = await createOrganizationConnection(orgId, { name: parsed.name, relationship_type_ids: parsed.roles || ['material_supplier'] });
    supplierId = text(connection.id);
  } else {
    const connection = await readOrganizationConnection(orgId, supplierId);
    const others = (connection.relationship_type_ids as unknown[]).map(String).filter((role) => !(SUPPLIER_ROLES as readonly string[]).includes(role));
    const roles = [...others, ...(parsed.roles || existing.roles)];
    if (text(connection.name) !== parsed.name || JSON.stringify(connection.relationship_type_ids) !== JSON.stringify(roles)) await patchOrganizationConnection(orgId, supplierId, { name: parsed.name, relationship_type_ids: roles, expected_revision: Number(connection.revision) });
  }
  const has = (key: keyof typeof parsed) => Object.prototype.hasOwnProperty.call(parsed, key);
  await upsertDocument(orgId, SUPPLIER_COLLECTION, {
    id: supplierId, ...(existing ? { expected_revision: parsed.expected_revision ?? existing.revision } : {}),
    data: {
      logo: has('logo') ? parsed.logo : existing?.logo || '',
      order_email: has('order_email') ? parsed.order_email : existing?.order_email || '',
      phone: has('phone') ? parsed.phone : existing?.phone || '',
      address: has('address') ? parsed.address : existing?.address || '',
      delivery_fee: has('delivery_fee') ? parsed.delivery_fee ?? null : existing?.delivery_fee ?? null,
      offerings: has('offerings') ? (parsed.offerings || []).map((row) => ({ item_id: row.item_id, sku: row.sku || '', price_cents: row.price_cents ?? null })) : existing?.offerings || [],
      updated_by_user_id: auth.userId
    },
    metadata: { kind: 'material_supplier' }
  }, { replace: true });
  return readSupplier(orgId, supplierId);
}

/** Removes the supplier roles. A connection that is nothing else is archived; one that also provides work stays. */
export async function archiveSupplier(orgId: string, input: unknown, auth: PlatformAuthContext) {
  await requireMaterials(orgId); requireWrite(orgId, auth);
  const parsed = supplierArchiveSchema.parse(input);
  await readSupplier(orgId, parsed.id);
  const connection = await readOrganizationConnection(orgId, parsed.id);
  const others = (connection.relationship_type_ids as unknown[]).map(String).filter((role) => !(SUPPLIER_ROLES as readonly string[]).includes(role));
  if (others.length) await patchOrganizationConnection(orgId, parsed.id, { relationship_type_ids: others, expected_revision: Number(connection.revision) });
  else await archiveOrganizationConnection(orgId, parsed.id, Number(connection.revision));
  return { id: parsed.id, archived: true };
}

export async function saveSupplierLocation(orgId: string, input: unknown, auth: PlatformAuthContext) {
  await requireMaterials(orgId); requireWrite(orgId, auth);
  const parsed = supplierLocationInputSchema.parse(input);
  const supplier = await readSupplier(orgId, parsed.supplier_id);
  const existing = parsed.id ? supplier.locations.find((location) => location.id === parsed.id) || null : null;
  if (parsed.id && !existing) throw badRequest('supplier_location_unknown', 'This supplier location is unavailable.');
  const has = (key: keyof typeof parsed) => Object.prototype.hasOwnProperty.call(parsed, key);
  const document = await upsertDocument(orgId, SUPPLIER_LOCATION_COLLECTION, {
    ...(existing ? { id: existing.id, expected_revision: parsed.expected_revision ?? existing.revision } : {}),
    data: {
      supplier_id: supplier.id, name: parsed.name,
      order_email: has('order_email') ? parsed.order_email : existing?.order_email || '',
      phone: has('phone') ? parsed.phone : existing?.phone || '',
      address: has('address') ? parsed.address : existing?.address || '',
      delivery_fee: has('delivery_fee') ? parsed.delivery_fee ?? null : existing?.delivery_fee ?? null,
      overrides: has('overrides') ? parsed.overrides || [] : existing?.overrides || [],
      updated_by_user_id: auth.userId
    },
    metadata: { kind: 'material_supplier_location', supplier_id: supplier.id }
  }, { replace: true });
  return locationRow(document as { id: string; revision?: number; data: JsonObject });
}

export async function archiveSupplierLocation(orgId: string, input: unknown, auth: PlatformAuthContext) {
  await requireMaterials(orgId); requireWrite(orgId, auth);
  const parsed = supplierArchiveSchema.parse(input);
  const document = (await listDocuments(orgId, SUPPLIER_LOCATION_COLLECTION)).find((row) => row.id === parsed.id && !row.data.archived_at);
  if (!document) throw badRequest('supplier_location_unknown', 'This supplier location is unavailable.');
  await upsertDocument(orgId, SUPPLIER_LOCATION_COLLECTION, { id: parsed.id, expected_revision: parsed.expected_revision ?? Number(document.revision || 0), data: { ...document.data, archived_at: new Date().toISOString(), archived_by_user_id: auth.userId }, metadata: { kind: 'material_supplier_location' } }, { replace: true });
  return { id: parsed.id, archived: true };
}
