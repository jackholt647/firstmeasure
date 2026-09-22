import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, '..', '..');
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
  vm.runInNewContext(searchSource, { window });
  return { api:window.FirstMateSettingsSearch, navigations };
}

function artifactHarness(){
  const navigations = [];
  const window = {
    Portal:{ navigation:{ navigate:(route, options) => navigations.push({ route, options }) } },
    PlatformAPI:{
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
  return { api:window.FirstMateArtifactSearch, navigations };
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
  const { api } = artifactHarness();
  const [invoice] = await api.search('INV-1042', { orgId:'org-1', branchId:'branch-1', types:['document'] });
  const [receipt] = await api.search('Northside Supply', { orgId:'org-1', branchId:'branch-1', types:['document'] });
  assert.equal(invoice.type, 'document');
  assert.match(invoice.subtitle, /^Invoice/);
  assert.equal(receipt.type, 'document');
  assert.match(receipt.subtitle, /^Receipt/);
});

test('users and equipment providers return routed global-search results', async () => {
  const { api, navigations } = artifactHarness();
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

test('global and settings-only search surfaces share the catalogue contract', () => {
  assert.match(portalIndex, /settings\/search\.js[\s\S]{0,240}scripts\/topbar-artifacts\.js[\s\S]{0,120}scripts\/topbar\.js/);
  assert.doesNotMatch(portalIndex, /placeholder="Search projects and contacts"/i);
  assert.match(portalIndex, /data-platform-search-input[^>]+placeholder="Search"/);
  assert.match(topbarSource, /enabledSearchTypes/);
  assert.match(topbarSource, /class="ptb-search-filter/);
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.search/);
  assert.match(topbarSource, /FirstMateArtifactSearch\?\.open/);
  assert.match(portalIndex, /\.ptb-search-filterbar\{position:sticky/);
  assert.match(portalIndex, /\.ptb-search-filters\{display:grid;grid-template-columns:repeat\(5,max-content\)/);
  assert.match(settingsSource, /data-settings-search placeholder="Search settings"/);
  assert.match(settingsSource, /FirstMateSettingsSearch\?\.search/);
  assert.match(settingsSource, /FirstMateSettingsSearch\?\.open/);
});
