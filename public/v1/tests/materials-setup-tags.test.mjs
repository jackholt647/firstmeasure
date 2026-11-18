// FM-619: on the Operations tab a kind of resource that is not set up keeps a way into its setup. Labor before its
// setup (no column), equipment inside the work order, or a minimized column get a tag in the header like a minimized
// column, with a Setup badge; operations.setup.status says which setups are done.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
const start = source.indexOf('  const RESOURCE_SETUPS=');
const end = source.indexOf('  async function openResourceSetup', start);
assert.ok(start > 0 && end > start, 'the setup tags block is found');
const block = source.slice(start, end);

function load({ categories, minimized = [], setup, permissions = { '*': true } }){
  const state = { minimizedTypes: new Set(minimized), setupStatus: setup ? { key: 'org:p1', setup } : null, setupStatusLoading: '', openingSetup: '', mounted: true };
  const window = { Portal: { currentUser: { permissions } } };
  const resourceCategories = () => categories;
  const terms = { labor: { plural: 'Labor', icon: 'fa-helmet-safety' }, equipment: { plural: 'Equipment', icon: 'fa-truck-pickup' }, material: { plural: 'Materials', icon: 'fa-boxes-stacked' } };
  const make = new Function('state', 'window', 'orgId', 'projectId', 'resourceCategories', 'workOrderMerged', 'equipmentOn', 'resourceTerms', 'escapeHtml', 'syncMaterialsGrid', 'workspaceIsEditing',
    `${block}\nreturn { setupPending, renderCategoryTabs, setupPermitted };`);
  return make(state, window, () => 'org', () => 'p1', resourceCategories,
    () => categories.some((row) => row.id === 'labor'), () => categories.some((row) => row.id === 'equipment'),
    (type) => terms[type], (value) => String(value ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'), () => {}, () => false);
}
const material = { id: 'material', name: 'Materials', icon: 'fa-boxes-stacked', color: '#d92d20' };
const labor = { id: 'labor', name: 'Labor', icon: 'fa-helmet-safety', color: '#175cd3' };
const equipment = { id: 'equipment', name: 'Equipment', icon: 'fa-truck-pickup', color: '#0f766e' };
const done = { suppliers: { complete: true }, equipment: { complete: true }, workforce: { complete: true } };
const tabs = (html) => [...html.matchAll(/<span class="mt-setup-tab"[^>]*>(.*?)<\/span>/g)].map((match) => ({
  restore: match[1].match(/data-mt-restore-type="([^"]+)"/)?.[1] || '',
  setup: [...match[1].matchAll(/data-mt-open-setup="([^"]+)"/g)].map((m) => m[1])
}));

test('no labor column and a minimized equipment column that is not set up: both get a Setup tag', () => {
  const tags = load({ categories: [material, equipment], minimized: ['equipment'], setup: { ...done, equipment: { complete: false }, workforce: { complete: false } } });
  assert.deepEqual(tabs(tags.renderCategoryTabs()), [
    { restore: 'equipment', setup: ['equipment'] },
    { restore: '', setup: ['labor', 'labor'] }
  ]);
  assert.equal(tags.setupPending('material'), false);
});

test('the labor column is hidden until someone can do labor, so it needs its setup whatever the card says', () => {
  const tags = load({ categories: [material], setup: done });
  assert.equal(tags.setupPending('labor'), true);
  assert.deepEqual(tabs(tags.renderCategoryTabs()), [{ restore: '', setup: ['labor', 'labor'] }]);
});

test('everything set up: a minimized column is the plain restore tag, and nothing else shows', () => {
  const tags = load({ categories: [material, labor, equipment], minimized: ['material'], setup: done });
  const html = tags.renderCategoryTabs();
  assert.equal(tabs(html).length, 0);
  assert.match(html, /^<button type="button" data-mt-restore-type="material"/);
  assert.equal(['labor', 'equipment', 'material'].some((type) => tags.setupPending(type)), false);
});

test('equipment inside the work order gets its own tag; a visible column is left to its heading badge', () => {
  const tags = load({ categories: [material, labor, equipment], setup: { ...done, equipment: { complete: false }, suppliers: { complete: false } } });
  assert.deepEqual(tabs(tags.renderCategoryTabs()), [{ restore: '', setup: ['equipment', 'equipment'] }]);
  assert.equal(tags.setupPending('material'), true, 'the Materials column shows its badge');
});

test('no Equipment app (no column), no status, or no right to run setups: no Setup tags', () => {
  assert.equal(load({ categories: [material, labor], setup: { ...done, equipment: { complete: false } } }).setupPending('equipment'), false);
  const unread = load({ categories: [material] });
  assert.equal(unread.renderCategoryTabs(), '');
  assert.equal(load({ categories: [material], setup: done, permissions: { manage_projects: true } }).setupPermitted(), false);
});
