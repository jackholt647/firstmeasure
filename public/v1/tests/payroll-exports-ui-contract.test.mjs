import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../../libraries/apps/payroll/app.js', import.meta.url), 'utf8');
const exportsSource = await readFile(new URL('../payroll/exports.ts', import.meta.url), 'utf8');

test('each pay run is copied out from the pay run itself, in the files the server offers for it', () => {
  // The files of one pay run are in that pay run, under Copy out, and made from its id.
  assert.match(app, /id:'export', label:t\('copy_out', 'Copy out'\)/);
  assert.match(app, /entry\.group === 'pay_run_file'/);
  assert.match(app, /artifacts\.create\(state\.orgId, \{ type:exportButton\.dataset\.export, format:exportButton\.dataset\.format, batch_id:current\.batch\.id/);
  for (const type of ['pay_run_summary', 'gusto_employees', 'gusto_contractors', 'quickbooks_payroll', 'quickbooks_bills']) {
    assert.match(app, new RegExp(`type:'${type}'`), type);
    assert.match(exportsSource, new RegExp(`type: "${type}"`), type);
  }
  // A pay run has to be drafted before its files exist.
  assert.match(app, /Draft the pay run first/);
});

test('reports for a date range are their own view, and every prepared file can be downloaded again', () => {
  assert.match(app, /data-report-from/);
  assert.match(app, /data-report-through/);
  assert.match(app, /entry\.group !== 'pay_run_file' && entry\.scope !== 'payroll_run'/);
  assert.match(app, /artifacts\.downloadUrl\(state\.orgId, artifact\.id\)/);
  // Titles show; what a report holds is its tooltip.
  assert.match(app, /info\(`\$\{report\.description\} \$\{report\.purpose\}`\)/);
});

test('the app asks for nothing with window.prompt and says "pay run", never "batch"', () => {
  assert.doesNotMatch(app, /window\.prompt|prompt\(/);
  const visible = [...app.matchAll(/t\('[a-z_0-9]+', '([^']*)'/g)].map((match) => match[1]);
  assert.ok(visible.length > 200);
  assert.deepEqual(visible.filter((text) => /\bbatch/i.test(text)), []);
});
