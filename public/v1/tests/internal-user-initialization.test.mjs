import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../internal/storage.ts', import.meta.url), 'utf8');
const body = source.split('async function initializePostgresUserIndex() {')[1]
  .split('async function importPostgresInternalDocumentsWithClient')[0]
  .trim().replace(/}\s*$/, '').replaceAll('client.query<{ migrated: boolean }>', 'client.query');
const execute = new Function('env', 'ensureInternalStorage', 'bootstrapPostgresApplicationUser', 'withPostgresClient', 'rebuildPostgresUserIndexWithClient', 'importPostgresInternalDocumentsWithClient', `return (async () => {${body}})()`);

test('migrated PostgreSQL user storage needs no local legacy filesystem', async () => {
  const forbiddenFilesystem = async () => { throw new Error('Unexpected filesystem access'); };
  const client = { query: async () => ({ rows: [{ migrated: true }] }) };
  await execute({ deploymentTopology: 'cluster', clusterNodeRole: 'web' }, forbiddenFilesystem, async () => {}, fn => fn(client), forbiddenFilesystem, forbiddenFilesystem);
});

test('unmigrated web node fails closed instead of importing an empty user directory', async () => {
  const forbiddenFilesystem = async () => { throw new Error('Unexpected filesystem access'); };
  const client = { query: async () => ({ rows: [{ migrated: false }] }) };
  await assert.rejects(execute({ deploymentTopology: 'cluster', clusterNodeRole: 'web' }, forbiddenFilesystem, async () => {}, fn => fn(client), forbiddenFilesystem, forbiddenFilesystem), /migration must run on the compatibility host/);
});
