import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const [app, company, manifest] = await Promise.all([
  readFile(path.join(publicRoot, 'libraries/apps/equipment/app.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/settings/company.js'), 'utf8'),
  readFile(path.join(publicRoot, 'libraries/apps/firstmate-apps-manifest.js'), 'utf8')
]);

test('equipment exposes Fleet, Timeline and Maintenance without the tier settings view', () => {
  const views = app.slice(app.indexOf('const availableViews = () => {'), app.indexOf('async function loadFleet'));
  assert.match(views, /id:'fleet'/);
  assert.match(views, /id:'timeline'/);
  assert.match(views, /id:'maintenance'/);
  assert.doesNotMatch(views, /id:'settings'/);
  const equipmentManifest = manifest.slice(manifest.indexOf("id: 'portal.equipment'"), manifest.indexOf("id: 'portal.invoices'"));
  assert.doesNotMatch(equipmentManifest, /settingsTabId|settings\/equipment\.js/);
});

test('company settings does not offer equipment tier or behavior controls', () => {
  assert.match(company, /const canEquipment = false/);
});
