// Keep each export request below the PHP/proxy timeout even on a cold cache.
// Cursor by immutable ID, not name/page offset: renames cannot skip customers.
export function customerExportBatch<T extends { id?: unknown }>(organizations: T[], after: string, internalId: string) {
  const sorted = organizations
    .filter(org => String(org.id ?? '').toLowerCase() !== internalId.toLowerCase())
    .filter(org => String(org.id ?? '') > after)
    .sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  const batch = sorted.slice(0, 25);
  return { batch, next_cursor: sorted.length > batch.length ? String(batch.at(-1)!.id) : null };
}
