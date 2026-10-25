import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, '..', '..');
const indexSource = await readFile(path.join(publicRoot, 'libraries/apps/settings/search-index.js'), 'utf8');
const searchSource = await readFile(path.join(publicRoot, 'libraries/apps/settings/search.js'), 'utf8');
const artifactSource = await readFile(path.join(publicRoot, 'portal/scripts/topbar-artifacts.js'), 'utf8');
const topbarSource = await readFile(path.join(publicRoot, 'portal/scripts/topbar.js'), 'utf8');
const settingsSource = await readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8');
const portalIndex = await readFile(path.join(publicRoot, 'portal/index.php'), 'utf8');

function searchHarness(){
  const navigations = [];
  const window = {
    Portal:{ navigation:{ navigate:(route, options) => navigations.push({ route, options }) } }
  };
  vm.runInNewContext(indexSource, { window });
  vm.runInNewContext(searchSource, { window, setTimeout:() => {} });
  return { api:window.FirstMateSettingsSearch, navigations };
}

const EVERY_SOURCE = ['project', 'contact', 'equipment', 'event', 'invoice', 'receipt', 'document', 'scope', 'channel', 'setting', 'user'];
const EVERY_TYPE = ['project', 'contact', 'equipment', 'event', 'document', 'scope', 'channel', 'setting', 'user'];

function artifactHarness(offer = { types:EVERY_TYPE, sources:EVERY_SOURCE }){
  const navigations = [];
  const calls = [];
  const window = {
    Portal:{ navigation:{ navigate:(route, options) => navigations.push({ route, options }) } },
    addEventListener:() => {},
    PlatformAPI:{
      search:{ types:async (orgId, options) => { calls.push({ orgId, options }); return offer; } },
      users:{ list:async () => ({ users:[{ id:'user-1', name:'Alice Installer', email:'alice@example.com' }] }) },
      calendarEvents:{ list:async () => ({ events:[] }) },
      scopes:{ list:async () => ({ templates:[] }) }
    },
    EquipmentAPI:{ units:async () => ({ units:[{ id:'unit-1', name:'Lift 12', identifier:'L-12', status:'available' }] }) },
    PaymentsAPI:{
      invoices:{ listAll:async () => ({ invoices:[{ id:'invoice-1', number:'INV-1042', customer_name:'June Carter' }] }) },
      receipts:{ listFor:async () => ({ receipts:[{ id:'receipt-1', merchant_name:'Northside Supply' }] }) }
    },
    DocumentsAPI:{ templates:{ list:async () => ({ templates:[] }) }, documents:{ listStandalone:async () => ({ documents:[] }) } },
    ChannelsAPI:{ channels:{ list:async () => ({ channels:[] }) } },
    FirstMateSettingsSearch:{ search:() => [], open:() => true }
  };
  vm.runInNewContext(artifactSource, { window });
  return { api:window.FirstMateArtifactSearch, navigations, calls, window };
}

async function offeredHarness(offer){
  const harness = artifactHarness(offer);
  await harness.api.loadOffered({ orgId:'org-1', branchId:'branch-1' });
  return harness;
}

test('shared settings search finds a specific setting and its nested view', () => {
  const { api } = searchHarness();
  const [result] = api.search('message templates');
  assert.equal(result.title, 'Message templates');
  assert.equal(result.tab, 'Communications');
  assert.equal(result.section, 'comms');
  assert.equal(result.view, 'templates');
});

test('settings search routes through Portal navigation with tab and nested view', () => {
  const { api, navigations } = searchHarness();
  const [result] = api.search('contact import history');
  assert.equal(api.open(result), true);
  assert.deepEqual(JSON.parse(JSON.stringify(navigations[0].route)), {
    tab:'company_settings', sub:'contacts', settingsView:'history', settingsEntity:'',
    scopeTemplateView:'', workflow:'', workflow_step:''
  });
});

test('artifact catalogue exposes the core searchable result types', () => {
  const { api } = artifactHarness();
  assert.deepEqual(Array.from(api.TYPES, ({ id }) => id), [
    'project', 'contact', 'equipment', 'event', 'document', 'scope', 'channel', 'setting', 'user'
  ]);
  assert.equal(api.type('user').label, 'Users');
  assert.equal(api.type('user').singular, 'User');
  assert.equal(api.type('event').label, 'Events');
  assert.equal(api.type('event').singular, 'Event');
});

test('the Documents type includes invoices and receipts', async () => {
  const { api } = await offeredHarness();
  const [invoice] = await api.search('INV-1042', { orgId:'org-1', branchId:'branch-1', types:['document'] });
  const [receipt] = await api.search('Northside Supply', { orgId:'org-1', branchId:'branch-1', types:['document'] });
  assert.equal(invoice.type, 'document');
  assert.match(invoice.subtitle, /^Invoice/);
  assert.equal(receipt.type, 'document');
  assert.match(receipt.subtitle, /^Receipt/);
});

test('users and equipment providers return routed global-search results', async () => {
  const { api, navigations } = await offeredHarness();
  const [person] = await api.search('alice', { orgId:'org-1', branchId:'branch-1', types:['user'] });
  const [equipment] = await api.search('lift', { orgId:'org-1', branchId:'branch-1', types:['equipment'] });

  assert.equal(person.type, 'user');
  assert.equal(person.title, 'Alice Installer');
  assert.equal(equipment.type, 'equipment');
  assert.equal(equipment.title, 'Lift 12');

  assert.equal(api.open(person), true);
  assert.equal(api.open(equipment), true);
  assert.deepEqual(JSON.parse(JSON.stringify(navigations.map(({ route }) => route))), [
    { tab:'photos_feed', user:'user-1', userTab:'activity' },
    { tab:'equipment', equipmentView:'fleet', equipmentItem:'unit-1' }
  ]);
});

// The MVP platform: no equipment, no scheduling, channels only behind project notes, one scope.
const MVP_OFFER = { types:['project', 'contact', 'setting', 'user'], sources:['project', 'contact', 'setting', 'user'] };

test('the type filters list only the result types the organization has', async () => {
  const { api, calls } = await offeredHarness(MVP_OFFER);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ orgId:'org-1', options:{ branchId:'branch-1' } }]);
  assert.deepEqual(Array.from(api.available(), ({ id }) => id), ['project', 'contact', 'setting', 'user']);
  for (const id of ['equipment', 'event', 'document', 'scope', 'channel']) assert.equal(api.offered(id), false, id);
  // Asked again for the same organization and branch, the answer is reused.
  await api.loadOffered({ orgId:'org-1', branchId:'branch-1' });
  assert.equal(calls.length, 1);
});

test('a type the organization does not have is never searched, even when asked for', async () => {
  const { api } = await offeredHarness(MVP_OFFER);
  const results = await api.search('lift', { orgId:'org-1', branchId:'branch-1', types:['equipment', 'event', 'scope', 'channel', 'document'] });
  assert.deepEqual(Array.from(results), []);
  const [person] = await api.search('alice', { orgId:'org-1', branchId:'branch-1', types:['user', 'equipment'] });
  assert.equal(person.type, 'user');
});

test('a Documents source the organization lacks is skipped while the others still search', async () => {
  const { api } = await offeredHarness({ types:['document'], sources:['receipt'] });
  assert.deepEqual(Array.from(await api.search('INV-1042', { orgId:'org-1', branchId:'branch-1', types:['document'] })), []);
  const [receipt] = await api.search('Northside Supply', { orgId:'org-1', branchId:'branch-1', types:['document'] });
  assert.match(receipt.subtitle, /^Receipt/);
});

test('until the server answers, or when it cannot, only projects, contacts and settings are offered', async () => {
  const before = artifactHarness();
  assert.deepEqual(Array.from(before.api.available(), ({ id }) => id), ['project', 'contact', 'setting']);
  const failing = artifactHarness();
  failing.window.PlatformAPI.search.types = async () => { throw new Error('offline'); };
  await failing.api.loadOffered({ orgId:'org-1', branchId:'branch-1' });
  assert.deepEqual(Array.from(failing.api.available(), ({ id }) => id), ['project', 'contact', 'setting']);
  assert.deepEqual(Array.from(await failing.api.search('lift', { orgId:'org-1', types:['equipment'] })), []);
});

test('the top bar filters and searches only offered types', () => {
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.available\?\.\(\)/);
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.loadOffered\?\.\(/);
  assert.match(topbarSource, /\['project','contact'\]\.filter\(\(type\) => enabledSearchTypes\.has\(type\) && offered\(type\)\)/);
});

test('global and settings-only search surfaces share the catalogue contract', () => {
  assert.ok(portalIndex.indexOf('settings/search-index.js') < portalIndex.indexOf('settings/search.js'));
  assert.ok(portalIndex.indexOf('settings/search.js') < portalIndex.indexOf('scripts/topbar-artifacts.js'));
  assert.doesNotMatch(portalIndex, /placeholder="Search projects and contacts"/i);
  assert.match(portalIndex, /data-platform-search-input[^>]+placeholder="Search"/);
  assert.match(topbarSource, /enabledSearchTypes/);
  assert.match(topbarSource, /class="ptb-search-filter/);
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.search/);
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.open/);
  assert.match(portalIndex, /\.ptb-search-filterbar\{position:sticky/);
  assert.match(settingsSource, /data-settings-search[^>]*placeholder=/);
  assert.match(settingsSource, /FirstMateSettingsSearch\?\.search/);
  assert.match(settingsSource, /FirstMateSettingsSearch\?\.open/);
});
