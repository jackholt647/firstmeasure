import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const settings = await readFile(path.join(publicRoot, 'libraries/apps/settings/equipment.js'), 'utf8');
const tiersSource = settings.slice(settings.indexOf('const TIERS = ['), settings.indexOf('const KNOBS = ['));

function tierSource(id) {
  const start = tiersSource.indexOf(`id:'${id}'`);
  assert.notEqual(start, -1, `${id} tier is declared`);
  const next = tiersSource.indexOf("\n    {", start + 1);
  return tiersSource.slice(start, next === -1 ? tiersSource.length : next);
}

test('equipment complexity has only Simple, Standard, and Advanced tiers', () => {
  assert.deepEqual(
    [...tiersSource.matchAll(/id:'([^']+)', label:'([^']+)'/g)].map((match) => [match[1], match[2]]),
    [['simple', 'Simple'], ['standard', 'Standard'], ['advanced', 'Advanced']]
  );
  assert.doesNotMatch(tiersSource, /'apps\.equipment'/);
});

test('each equipment tier writes a complete feature preset', () => {
  const featureKeys = [
    'equipment.scheduling',
    'equipment.requirements',
    'equipment.maintenance',
    'equipment.meters',
    'equipment.operators',
    'equipment.costing',
    'equipment.custody'
  ];

  for (const id of ['simple', 'standard', 'advanced']) {
    const source = tierSource(id);
    for (const key of featureKeys) assert.match(source, new RegExp(`'${key.replace('.', '\\.')}'\\s*:`));
  }

  assert.match(tierSource('standard'), /'equipment\.scheduling':true[\s\S]*'equipment\.requirements':true/);
  assert.match(tierSource('standard'), /'equipment\.maintenance':true/);
  assert.match(tierSource('advanced'), /'equipment\.maintenance':true[\s\S]*'equipment\.meters':true/);
});

test('tier changes refresh module settings and update all feature flags together', () => {
  const applyTier = settings.slice(settings.indexOf('async function applyTier'), settings.indexOf('async function toggleFeature'));
  assert.match(applyTier, /EquipmentAPI\.settings\(orgId\)/);
  assert.match(applyTier, /saveSettings\(orgId, \{[\s\S]*\.\.\.tier\.settings/);
  assert.match(applyTier, /capabilities\.update\(orgId, tier\.capabilities\)/);
  assert.doesNotMatch(applyTier, /tier\.id\s*!==\s*'off'|tier\.id\s*===\s*'off'/);
});
