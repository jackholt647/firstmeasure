import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const files = [
  '../measure/internal/portal_scripts/qa.js',
  '../measure/internal/editor_scripts/notes_overlay.js'
];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const start = source.indexOf('function normalizeThreadSeverity(');
  const end = source.indexOf('\n  function ', start + 10);
  assert.ok(start >= 0 && end > start, `${file} exposes severity normalization`);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  assert.equal(vm.runInContext("normalizeThreadSeverity('minor')", context), 'minor');
  assert.equal(vm.runInContext("normalizeThreadSeverity('major')", context), 'major');
  assert.equal(vm.runInContext("normalizeThreadSeverity('')", context), 'major');
  assert.match(source, /severity[^\n]+minor/);
  assert.match(source, /severity[^\n]+major/);
}

const reportSource = await readFile('../measure/internal/editor_scripts/report.js', 'utf8');
assert.match(reportSource, /severity:\s*resolveImmediately\s*\?\s*'minor'\s*:\s*'major'/);

console.log('PASS: QA feedback records and displays minor/major severity with a major fallback for legacy threads.');
