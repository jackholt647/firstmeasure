// FM-619: on the Operations tab a kind of resource that is not set up is not a list: it is a tab in the header,
// coloured like a minimized column's, with a Setup tag on its corner. Labor is set up once its column shows, equipment
// once operations.setup.status says the fleet has a unit; materials never get a Setup tag.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
const start = source.indexOf('  const RESOURCE_SETUPS=');
const end = source.indexOf('  async function openResourceSetup', start);
assert.ok(start > 0 && end > start, 'the setup tags block is found');
const block = source.slice(start, end);

function load({ categories, setup, lists = [], permissions = { '*': true }, loaded = true }){
  const state = { lists, minimizedTypes: new Set(), setupStatus: loaded ? { key: 'org:p1', setup } : null, setupStatusLoading: '', openingSetup: '', mounted: true };
  const window = { Portal: { currentUser: { permissions } }, PlatformAPI: { publication: { invoke: async () => ({}) } } };
  const make = new Function('state', 'window', 'orgId', 'projectId', 'resourceCategories', 'equipmentOn', 'resourceType', 'listItems', 'escapeHtml', 'syncMaterialsGrid', 'workspaceIsEditing',
    `${block}\nreturn { setupPending, equipmentListed, renderSetupTabs, setupPermitted };`);
  return make(state, window, () => 'org', () => 'p1', () => categories, () => categories.some((row) => row.id === 'equipment'),
    (list) => list?.resource_type || 'material', (list) => list?.current_items || [],
    (value) => String(value ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'), () => {}, () => false);
}
const material = { id: 'material', name: 'Materials', icon: 'fa-boxes-stacked', color: '#d92d20' };
const labor = { id: 'labor', name: 'Labor', icon: 'fa-helmet-safety', color: '#175cd3' };
const equipment = { id: 'equipment', name: 'Equipment', icon: 'fa-truck-pickup', color: '#0f766e' };
const done = { suppliers: { complete: false }, equipment: { complete: true }, workforce: { complete: true } };
const tabs = (html) => [...html.matchAll(/<button type="button" class="mt-setup-tab" data-mt-open-setup="([^"]+)" style="--tab-color:([^"]+)"[^>]*>(.*?)<\/button>/g)].map((m) => ({ type: m[1], color: m[2], badge: /<span class="mt-setup-badge"[^>]*>Setup<\/span>$/.test(m[3]) }));

test('no labor column and no equipment fleet: both are header tabs with a Setup tag, and equipment is not a list', () => {
  const tags = load({ categories: [material, equipment], setup: { ...done, equipment: { complete: false } } });
  assert.deepEqual(tabs(tags.renderSetupTabs()), [{ type: 'labor', color: '#2563eb', badge: true }, { type: 'equipment', color: '#0f766e', badge: true }]);
  assert.equal(tags.equipmentListed(), false);
  assert.equal(tags.setupPending('material'), false, 'materials never get a Setup tag (suppliers are not asked for)');
});

test('set up: labor has its column, equipment has a unit; no tabs and equipment is a list', () => {
  const tags = load({ categories: [material, labor, equipment], setup: done });
  assert.equal(tags.renderSetupTabs(), '');
  assert.equal(tags.equipmentListed(), true);
});

test('equipment already on this project\'s lists stays a list; while the status loads equipment waits', () => {
  const pending = { ...done, equipment: { complete: false } };
  assert.equal(load({ categories: [material, equipment], setup: pending, lists: [{ resource_type: 'equipment', current_items: [{ id: 'i1' }] }] }).equipmentListed(), true);
  assert.equal(load({ categories: [material, equipment], loaded: false }).equipmentListed(), false);
});

test('no Equipment app, a status that could not be read, or no right to run setups: nothing changes', () => {
  assert.equal(load({ categories: [material, labor], setup: { ...done, equipment: { complete: false } } }).setupPending('equipment'), false);
  const unread = load({ categories: [material, equipment], setup: null });
  assert.equal(unread.renderSetupTabs(), '');
  assert.equal(unread.equipmentListed(), true);
  const staff = load({ categories: [material, equipment], loaded: false, permissions: { manage_projects: true } });
  assert.equal(staff.setupPermitted(), false);
  assert.equal(staff.equipmentListed(), true);
});
