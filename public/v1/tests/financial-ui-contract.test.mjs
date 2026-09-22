import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('../../libraries/apps/financials/app.js', import.meta.url);
const manifestUrl = new URL('../../libraries/apps/firstmate-apps-manifest.js', import.meta.url);
const moneyUrl = new URL('../../libraries/apps/money/project.js', import.meta.url);
const crewUrl = new URL('../../libraries/apps/crew/app.js', import.meta.url);
const receiptsUrl = new URL('../../libraries/apps/receipts/app.js', import.meta.url);
const paymentsApiUrl = new URL('../../libraries/payments-api/payments-api.js', import.meta.url);
const financialsApiUrl = new URL('../../libraries/financials-api/financials-api.js', import.meta.url);

test('global financials registers as a routed portal app', async () => {
  const [app, manifest] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(manifestUrl, 'utf8')
  ]);
  assert.match(app, /id:'portal\.financials'/);
  assert.match(app, /registerHandler\?\.\(`financials-route:/);
  assert.match(manifest, /financialView:\s*\{\s*default:'projects',\s*history:'push'/);
  assert.match(manifest, /financialGrain:\s*\{\s*default:'month',\s*history:'replace'/);
  assert.match(manifest, /financialDate:\s*\{\s*history:'replace'/);
});

test('financials uses the portal navigation owner and aggregate financial read API', async () => {
  const [app, client, manifest] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(financialsApiUrl, 'utf8'),
    readFile(manifestUrl, 'utf8')
  ]);
  assert.doesNotMatch(app, /history\.(?:pushState|replaceState)\s*\(/);
  assert.match(app, /Portal\?\.navigation\?\.push/);
  assert.match(app, /history === 'push' \? 'push' : 'replace'/);
  assert.match(app, /FinancialsAPI\.projects/);
  assert.match(app, /FinancialsAPI\.cashFlow/);
  assert.match(app, /data-fn-action="load-more"/);
  assert.doesNotMatch(app, /PaymentsAPI\?\.projects\?\.summary/);
  assert.match(client, /orgPath\(orgId, '\/projects'\)/);
  assert.match(client, /orgPath\(orgId, '\/cash-flow'\)/);
  assert.match(manifest, /financials-api\/financials-api\.js/);
  assert.match(app, /Material payment/);
  assert.match(app, /clearing-hours/);
});

test('cash-flow chart separates available, expected, and safe-to-spend cash', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /fn-line available/);
  assert.match(app, /fn-line expected/);
  assert.match(app, /fn-line safe/);
  assert.match(app, /Undated exposure reserved/);
  assert.match(app, /datedExposureCents/);
  assert.match(app, /undatedExposureCents/);
  assert.match(app, /opening-balance-cents/);
  assert.match(app, /data-fn-node/);
  assert.match(app, /tabindex=\"0\"/);
});

test('cash-flow transactions cross-highlight the chart', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /fn-transaction-list/);
  assert.match(app, /data-fn-transaction=/);
  assert.match(app, /data-fn-transaction-ids=/);
  assert.match(app, /highlightTransactions/);
  assert.match(app, /showTransactionDetail/);
});

test('cash-flow workspace fills available height and node tooltips escape chart clipping', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /\.fn-content\.fn-content-cash\{overflow:hidden\}/);
  assert.match(app, /\.fn-cash-workspace\{position:relative;flex:1;/);
  assert.match(app, /\.fn-transaction-rail\{min-height:0;height:auto;/);
  assert.match(app, /\.fn-chart-card\{min-width:0;min-height:0;display:flex;/);
  assert.match(app, /\.fn-tooltip\{position:fixed;z-index:2147483640;/);
  assert.match(app, /<div class="fn-tooltip" data-fn-tooltip role="tooltip"><\/div><div class="fn-tx-popover"/);
  assert.match(app, /root\.querySelector\('\[data-fn-tooltip\]'\)/);
  assert.match(app, /window\.innerWidth - tooltipRect\.width/);
  assert.match(app, /window\.innerHeight - tooltipRect\.height/);
});

test('optional source failures stay diagnostic-only', async () => {
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /console\.warn\('\[Financials\] Optional source skipped'/);
  assert.doesNotMatch(app, /state\.warnings/);
  assert.doesNotMatch(app, /fn-notice/);
});

test('crew earnings separates summary totals from project earnings', async () => {
  const crew = await readFile(crewUrl, 'utf8');
  assert.match(crew, /\[data-earnings\],\[data-project-earnings\]\{display:grid;align-content:start;gap:16px\}/);
  assert.match(crew, /<section class="crew-card"><div class="crew-card-title"><h3>\$\{esc\(title\)\}<\/h3>/);
});

test('receipt intake supports mixed-file parallel batches across Money and Crew', async () => {
  const [money, crew, paymentsApi] = await Promise.all([
    readFile(moneyUrl, 'utf8'),
    readFile(crewUrl, 'utf8'),
    readFile(paymentsApiUrl, 'utf8')
  ]);
  assert.match(paymentsApi, /async function runReceiptBatch/);
  assert.match(paymentsApi, /Promise\.all\(Array\.from\(\{ length:concurrency \}/);
  assert.match(paymentsApi, /receipt_batch_index:item\.index/);
  assert.match(paymentsApi, /uploadBatchFor\(orgId, files/);
  assert.match(money, /data-money-receipt-input multiple/);
  assert.match(money, /uploadBatch\(requestedOrgId, requestedProjectId, files/);
  assert.match(money, /Match uploaded receipts/);
  assert.match(money, /Suggested match:/);
  assert.match(crew, /data-file-input/);
  assert.match(crew, /multiple accept="\$\{RECEIPT_ACCEPT\}"/);
  assert.match(crew, /uploadBatchFor\(orgId\(context\), files/);
  assert.match(crew, /receiptBatchHtml\(receiptBatchItems, \{ review:true \}\)/);
});

test('receipt intake exposes gated reimbursement choices and an office settlement queue', async () => {
  const [crew, receipts, paymentsApi] = await Promise.all([
    readFile(crewUrl, 'utf8'),
    readFile(receiptsUrl, 'utf8'),
    readFile(paymentsApiUrl, 'utf8')
  ]);
  assert.match(crew, /can_request_reimbursement/);
  assert.match(crew, /data-funding-source/);
  assert.match(crew, /company_card/);
  assert.match(crew, /PaymentsAPI\.reimbursements\.submit/);
  assert.match(receipts, /Employee reimbursements/);
  assert.match(receipts, /Approve for payroll/);
  assert.match(receipts, /Approve off-cycle/);
  assert.match(receipts, /data-reimbursement-action="mark_paid"/);
  assert.match(paymentsApi, /reimbursement-request/);
});
