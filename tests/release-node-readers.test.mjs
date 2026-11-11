// The production run fast path (FM-388, DEPLOYMENT.md "Production run fast path") skips the Node restart
// only when nothing Node reads changed. Node reads some files under public/measure/internal and public/portal
// (the PDF runtime's editor scripts, the solar key, landing pages); deploy/digitalocean/release-node-fingerprint.py
// lists them. This keeps that list true on canonical; tests/release-fast-path.test.mjs tests the tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const FINGERPRINT = path.join(root, 'deploy/digitalocean/release-node-fingerprint.py');
const python = (...args) => spawnSync('python3', [FINGERPRINT, ...args], { encoding: 'utf8' });
const classify = (...names) => JSON.parse(python('classify', ...names).stdout);

// Every public/v1 source that reads into measure/ or portal/ is listed, and the editor files the known
// readers name are on Node's side.
test('canonical: every Node read under measure/ or portal/ is classified', () => {
  const { readers, unclassified } = JSON.parse(python('readers', root).stdout);
  assert.deepEqual(unclassified, [], `classify these reads in ${path.relative(root, FINGERPRINT)} (READERS, NODE_READS)`);
  const rules = JSON.parse(python('rules').stdout);
  assert.deepEqual(readers, [...rules.readers].sort(), 'a listed reader no longer reads there: drop it from READERS');

  const pdfRuntime = fs.readFileSync(path.join(root, 'public/v1/firstmeasure/pdf_runtime.ts'), 'utf8');
  const editorFiles = new Set([...pdfRuntime.matchAll(/"editor_scripts",\s*"([^"]+)"/g)].map(m => m[1]));
  for (const list of pdfRuntime.matchAll(/for \(const file of \[([^\]]+)\]\)/g)) {
    for (const m of list[1].matchAll(/'([^']+)'/g)) editorFiles.add(m[1]);
  }
  assert.ok(editorFiles.has('pdf.js') && editorFiles.has('exterior_pdf.js'), [...editorFiles].join(', '));
  const pdfClasses = classify(...[...editorFiles].map(name => `public/measure/internal/editor_scripts/${name}`));
  for (const [name, kind] of Object.entries(pdfClasses)) assert.equal(kind, 'node', `${name} is read by the PDF runtime`);

  const solar = fs.readFileSync(path.join(root, 'public/v1/forms/solar.ts'), 'utf8');
  const keyFiles = [...new Set([...solar.matchAll(/"\.\.\/(?:\.\.\/)?measure\/internal\/([^"]+)"/g)].map(m => m[1]))];
  assert.ok(keyFiles.includes('editor.php'), keyFiles.join(', '));
  for (const [name, kind] of Object.entries(classify(...keyFiles.map(name => `public/measure/internal/${name}`)))) {
    assert.equal(kind, 'key', `${name} is read by forms/solar.ts for its key`);
  }
  assert.match(fs.readFileSync(path.join(root, 'public/v1/internal/crm/api.ts'), 'utf8'), /path\.join\(cursor, "portal", "landing"\)/);
  assert.equal(classify('public/portal/landing/variants/x/index.php')['public/portal/landing/variants/x/index.php'], 'node');
});
