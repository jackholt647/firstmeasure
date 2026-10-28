/** The terminology namespaces in the checked-in config library snapshot (docs/architecture/terminology.md), for
 * build scripts and source checks that run without the server: [{id, title, note, position, terms}], in order.
 * The server and pages read the live library instead. */
import fs from 'node:fs';
import path from 'node:path';

export const terminologySnapshotDir = path.resolve(import.meta.dirname, '../config-library/snapshot/terminology_namespace');
export function terminologyNamespaces(dir = terminologySnapshotDir) {
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
    .map((entry) => ({ id: entry.id, ...entry.data }))
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** What GET /v1/config-library/read/terminology_namespace answers, from the snapshot (browser test fixtures). */
export function terminologyReadResponse(dir = terminologySnapshotDir) {
  const entries = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
    .sort((a, b) => (a.id < b.id ? -1 : 1)).map((entry) => ({ id: entry.id, revision: entry.revision, title: entry.title, data: entry.data }));
  return { ok: true, kind: 'terminology_namespace', version: 1, entries };
}
/** Every term as `<namespace>.<key>`. */
export function terminologyKeys(dir = terminologySnapshotDir) {
  return terminologyNamespaces(dir).flatMap((section) => section.terms.map((term) => `${section.id}.${term.key}`));
}
