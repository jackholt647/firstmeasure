import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../../libraries/apps/payroll/app.js', import.meta.url), 'utf8');

test('payroll exports use plain-language coverage selection and report guidance', () => {
  assert.match(app, /A specific payroll run/);
  assert.match(app, /A date range/);
  assert.match(app, /id="fmpExportBatch"/);
  assert.match(app, /id="fmpExportFrom"/);
  assert.match(app, /report\.description/);
  assert.match(app, /report\.purpose/);
  assert.doesNotMatch(app, /<small>\$\{esc\(report\.type\)/);
  assert.doesNotMatch(app, />\$\{esc\(report\.scope\)\}</);
});

test('every report offers CSV and printable PDF while saved files explain coverage', () => {
  assert.match(app, /Download CSV/);
  assert.match(app, /Download PDF/);
  assert.match(app, /Prepare all CSVs/);
  assert.match(app, /Prepare all PDFs/);
  assert.match(app, /metadata\.coverage_label/);
  assert.match(app, /no duplicate was created/);
  assert.match(app, /Download again/);
});
