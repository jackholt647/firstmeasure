import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// GP-113: Financials' views, its header and how it opens a project or a receipt.
const app = readFileSync(new URL('../public/libraries/apps/financials/app.js', import.meta.url), 'utf8');
const windows = readFileSync(new URL('../public/libraries/window-manager/project-windows.js', import.meta.url), 'utf8');

function groupMembers(){
  const start = app.indexOf("window.AppChrome.registerGroup({id:'financials'");
  assert.ok(start > 0, 'Financials registers its app group');
  const block = app.slice(app.indexOf('members:[', start), app.indexOf('mount:(view,context)', start));
  return [...block.matchAll(/\{id:'([a-z]+)'/g)].map((match) => match[1]);
}

test('Financials views: Reconcile is part of Payouts, and Receipts is a view', () => {
  assert.deepEqual(groupMembers(), ['projects', 'cashflow', 'payouts', 'receipts', 'disputes']);
  assert.match(app, /const legacyView = \(value\) => String\(value \?\? ''\)\.trim\(\) === 'reconcile' \? 'payouts' : value;/, 'old Reconcile links land on Payouts');
});

test('Financials opens a project with navigate, which opens the project window (push only changed the address)', () => {
  const body = app.slice(app.indexOf('function openProject(projectId){'), app.indexOf('function openInvoice('));
  assert.match(body, /navigation\?\.navigate\?\.\(\{ project:projectId, projectTab:'money' \}/);
  assert.doesNotMatch(body, /navigation\?\.push/);
  const receipt = app.slice(app.indexOf('function openReceipt(receiptId){'), app.indexOf('function openSettings('));
  assert.match(receipt, /navigation\?\.navigate\?\.\(\{ project:projectId, projectTab:'money', receipt:receipt\.id \}/);
});

test('a project window carries the receipt to open into its Finances tab', () => {
  assert.match(windows, /PROJECT_SCOPED_ROUTE_KEYS=\[[^\]]*'receipt'[^\]]*\]/);
  assert.match(windows, /if\(params\.moneyView \|\| params\.receipt\)navigation\.applyCurrent/);
});

test('the Financials header has the period controls, filters and its own settings, not the app layout', () => {
  const header = app.slice(app.indexOf('    function headerHtml(){'), app.indexOf('    function projectNames('));
  assert.match(header, /tabs:`\$\{dateControlsHtml\(\)\}\$\{standalone \? '' : window\.AppChrome\.tabs\('financials'/, 'Today and the period sit left of the views');
  assert.match(header, /filterButtonHtml\(\)/);
  assert.match(header, /data-fn-settings/);
  assert.doesNotMatch(header, /data-app-layout-open/);
});

test('a project row names the customer or project and its address, never the record id', () => {
  const body = app.slice(app.indexOf('function projectNames(project = {}){'), app.indexOf('function profitabilityHtml('));
  const projectNames = new Function('clean', `${body.slice(0, body.lastIndexOf('}') + 1)}; return projectNames;`)((value) => String(value ?? '').trim());
  assert.deepEqual(projectNames({ id:'project_1', title:'New Project', address:'12 Oak St' }), { primary:'12 Oak St', secondary:'' });
  assert.deepEqual(projectNames({ id:'project_1', title:'New Project', customer_name:'Avery Rivera', address:'12 Oak St' }), { primary:'Avery Rivera', secondary:'12 Oak St' });
  assert.deepEqual(projectNames({ id:'project_1', title:'Smith re-roof', address:'12 Oak St' }), { primary:'Smith re-roof', secondary:'12 Oak St' });
  assert.deepEqual(projectNames({ id:'project_1', title:'12 Oak St', address:'12 Oak St' }), { primary:'12 Oak St', secondary:'' });
});
