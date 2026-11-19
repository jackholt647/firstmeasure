import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

// The project Docs tab's "Items shown" menu (GP-38): proposals and reports are separate
// categories, listed first, in the order Proposals, Reports, Receipts, Invoices, Other.
const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(path.join(root, 'public/libraries/apps/docs/project.js'), 'utf8');

function slice(start, end){
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `missing end of ${start}`);
  return source.slice(from, to + end.length);
}

function categories(globals = {}){
  const code = [
    slice('  const docsTerm =', ';\n'),
    slice('  const DOCUMENT_CATEGORIES = [', '  ];\n'),
    slice('  function cleanText(', '\n'),
    slice('  function firstText(', '\n  }\n'),
    slice('  function docType(', '\n  }\n'),
    slice('  function isReceiptDoc(', '\n  }\n'),
    slice('  function documentCategory(', '\n  }\n'),
    'globalThis.result = { DOCUMENT_CATEGORIES, documentCategory };'
  ].join('\n');
  const context = vm.createContext({ ...globals });
  vm.runInContext(code, context);
  return context.result;
}

test('the Docs filter menu lists proposals, reports, receipts, invoices, other', () => {
  const { DOCUMENT_CATEGORIES } = categories();
  assert.deepEqual(Array.from(DOCUMENT_CATEGORIES, (category) => category.id), ['proposal', 'report', 'receipt', 'invoice', 'other']);
  assert.deepEqual(Array.from(DOCUMENT_CATEGORIES, (category) => category.label), ['Proposals', 'Reports', 'Receipts', 'Invoices', 'Other']);
  assert.ok(!source.includes("'proposal_report'"), 'no combined proposal and report category is left');
  assert.ok(!/visibleDocumentCategories(?::| =) new Set\(\[/.test(source), 'default categories come from DOCUMENT_CATEGORIES');
});

test('proposal and report labels follow the organization terminology when drawn', () => {
  const terms = { 'proposals.proposals': 'Estimates' };
  const { DOCUMENT_CATEGORIES } = categories({ PlatformTerminology: { get: (key, fallback) => terms[key] || fallback } });
  assert.equal(DOCUMENT_CATEGORIES[0].label, 'Estimates');
  terms['reports.reports'] = 'Inspections';
  assert.equal(DOCUMENT_CATEGORIES[1].label, 'Inspections');
});

test('documents fall into their own category', () => {
  const { documentCategory } = categories();
  assert.equal(documentCategory({ document_type: 'proposal' }), 'proposal');
  assert.equal(documentCategory({ document_type: 'change_order' }), 'proposal');
  assert.equal(documentCategory({ type: 'Change Order' }), 'proposal');
  assert.equal(documentCategory({ document_type: 'roof_report' }), 'report');
  assert.equal(documentCategory({ document_type: 'weather_report' }), 'report');
  assert.equal(documentCategory({ document_type: 'invoice' }), 'invoice');
  assert.equal(documentCategory({ document_type: 'proposal', metadata: { invoice_id: 'inv_1' } }), 'invoice');
  assert.equal(documentCategory({ document_type: 'receipt' }), 'receipt');
  assert.equal(documentCategory({ document_type: 'contract' }), 'other');
  assert.equal(documentCategory({}), 'other');
});
