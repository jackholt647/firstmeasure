import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const trainingSource = await readFile(path.join(publicRoot, 'libraries/apps/training/app.js'), 'utf8');

test('the routed Training home starts its initial courses request', () => {
  assert.match(
    trainingSource,
    /handle\.applyRoute\(initialRoute\);[\s\S]*?if \(!openCourseId && tab === 'home' && !courses\) void loadTab\(\);/,
    'trainingTab=home must load courses even though it matches the local default tab'
  );
});
