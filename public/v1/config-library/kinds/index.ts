/**
 * Every config library kind, registered once. One import and one call per kind file; a kind's file belongs to the
 * domain that reads its entries.
 */
let registered = false;
export function registerAllLibraryKinds() {
  if (registered) return;
  registered = true;
}
