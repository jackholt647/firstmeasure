const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/measure/internal/portal_scripts/customers.js', 'utf8');

/** One top-level function of the portal script's closure, by its source text. */
function fn(signature) {
  const start = source.indexOf(`  ${signature}`);
  assert.notEqual(start, -1, signature);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

/** Runs the real export on these organizations and returns the downloaded TSV as rows of cells. */
async function exportTsv(organizations) {
  const blobs = [];
  const context = {
    alert: message => { throw new Error(message); },
    setTimeout: () => {},
    apiServer: () => '/api',
    Blob: class { constructor(parts) { blobs.push(parts.join('')); } },
    URL: { createObjectURL: () => 'blob:export', revokeObjectURL() {} },
    document: {
      getElementById: () => null,
      body: { appendChild() {} },
      createElement: () => ({ click() {}, remove() {} })
    },
    window: { Portal: { apiPost: async () => ({ success: true, organizations, next_cursor: null }) } }
  };
  vm.runInNewContext([
    'function tsvCell', 'function tsvList', 'function emailDomain', 'function userPermissionLevel',
    'function userContactInfo', 'function orgAdminContacts', 'function adminContactTsvFields',
    'async function fetchOrganizationsForExport', 'async function exportUsersTsv'
  ].map(name => fn(`${name}(`)).join('\n') + '\nthis.exportUsersTsv = exportUsersTsv;', context);
  await context.exportUsersTsv();
  assert.equal(blobs.length, 1);
  return blobs[0].split('\r\n').map(line => line.split('\t'));
}

const user = { id: 'u1', name: 'Pat', email: 'pat@example.com' };

test('users export ends with the organization country, code then name', async () => {
  const [header, row] = await exportTsv([{ id: 'o1', name: 'Maple Roofing', country: 'CA', country_name: 'Canada', users: [user] }]);
  assert.deepEqual(header.slice(-2), ['organization_country', 'organization_country_name']);
  assert.deepEqual(row.slice(-2), ['CA', 'Canada']);
  assert.equal(row.length, header.length, 'every row has one cell per header column');
});

test('users export keeps its existing columns and their order', async () => {
  const [header, row] = await exportTsv([{ id: 'o1', name: 'Maple Roofing', country: 'CA', country_name: 'Canada', users: [user] }]);
  assert.deepEqual(header.slice(0, 3), ['organization_id', 'organization_name', 'organization_is_test']);
  assert.equal(header.length, 64);
  assert.equal(header[61], 'user_matches_org_contact_email');
  assert.deepEqual(row.slice(0, 2), ['o1', 'Maple Roofing']);
  assert.equal(row[header.indexOf('user_email')], 'pat@example.com');
  assert.equal(row[61], 'No');
});

test('users export leaves country blank when the row has none', async () => {
  const [header, row] = await exportTsv([{ id: 'o1', name: 'Old Org', users: [user] }]);
  assert.equal(row.length, header.length);
  assert.deepEqual(row.slice(-2), ['', '']);
});
