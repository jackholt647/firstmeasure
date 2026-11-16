// The project window's tabs (desktop and phone) put tabs in use first, then "Setup required", then "New", then
// "Coming soon"; the organization's listed order applies within each (FM-502). Runs tab-guides.js order() in a stub
// window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/libraries/tab-guides/tab-guides.js'), 'utf8');

function guides({ order = [], pills = {}, seen = [], offered = [], setups = {} } = {}){
  const window = {
    PlatformAPI: { appFlags: { projectTabs: () => ({ order, pills }) } },
    Portal: {
      currentUser: {
        identity: { preferences: { seen_tabs: seen } },
        appEntitlements: offered.map((id) => ({ id, offered: true }))
      },
      appSetup: { pendingFor: (id) => setups[id] || null }
    }
  };
  vm.runInNewContext(source, { window, console });
  return window.FirstMateTabGuides;
}

const tab = (id, extra = {}) => ({ id, appId: `project.${id}`, ...extra });
const ids = (tabs) => tabs.map((t) => t.id);

test('tabs not started yet sit after the tabs in use', () => {
  const tabs = [tab('map'), tab('photos'), tab('docs'), tab('money'), tab('schedule'), tab('notes'), tab('materials', { app: { promoBadge: 'Coming soon' } })];
  const g = guides({
    pills: { 'project.photos': 'new', 'project.notes': 'coming_soon' },
    offered: ['project.docs'],
    setups: { 'project.money': { key: 'payments' } },
    seen: ['setup:payments']
  });
  assert.deepEqual(ids(g.order(tabs)), ['map', 'schedule', 'money', 'photos', 'docs', 'notes', 'materials']);
});

test('the listed order applies within each group, and an opened New tab takes its listed place', () => {
  const tabs = [tab('map'), tab('photos'), tab('docs'), tab('schedule'), tab('comms')];
  const order = ['project.map', 'project.photos', 'project.docs', 'project.comms'];
  const pills = { 'project.photos': 'new', 'project.docs': 'new' };
  assert.deepEqual(ids(guides({ order, pills }).order(tabs)), ['map', 'comms', 'schedule', 'photos', 'docs']);
  assert.deepEqual(ids(guides({ order, pills, seen: ['project.photos'] }).order(tabs)), ['map', 'photos', 'comms', 'schedule', 'docs']);
});

test('with no pills and no listed order the tabs keep their order', () => {
  const tabs = [tab('map'), tab('b'), tab('a')];
  assert.deepEqual(ids(guides().order(tabs)), ['map', 'b', 'a']);
});

test('the project window builds its tab strip and first tab from order()', () => {
  const app = fs.readFileSync(path.join(root, 'public/libraries/apps/project-request/app.js'), 'utf8');
  const body = (name) => app.slice(app.indexOf(`function ${name}(`), app.indexOf('\n  }\n', app.indexOf(`function ${name}(`)));
  assert.match(body('projectViewerTabs'), /FirstMateTabGuides\?\.order\?\.\(apps\)/);
  assert.match(body('projectDefaultPreviewTab'), /FirstMateTabGuides\?\.order\?\.\(apps\)/);
});
