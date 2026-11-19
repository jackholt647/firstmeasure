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
const paymentsSetupUrl = new URL('../../libraries/payments-setup/payments-setup.js', import.meta.url);

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

test('field and sales earnings are the shared My pay view, a project tab showing that job only', async () => {
  const crew = await readFile(crewUrl, 'utf8');
  const sales = await readFile(new URL('../../libraries/apps/sales/app.js', import.meta.url), 'utf8');
  const myPay = await readFile(new URL('../../libraries/apps/payroll/my-pay.js', import.meta.url), 'utf8');
  assert.match(crew, /window\.FirstMateMyPay\.mount\(root, \{ orgId:orgId\(context\), projected:context\.params\?\.projected_enabled === true/);
  assert.match(crew, /mountMyPay\(projectMountRoot\(context, 'payouts'\), context, \{ projectId:projectId\(context\) \}\)/);
  assert.match(sales, /window\.FirstMateMyPay\.mount\(root, \{ orgId:orgId\(context\), presentation:'commissions'/);
  // Commissions by earning kind, never by matching a word; one "Projected", the rule forecast.
  assert.doesNotMatch(sales, /includes\('commission'\)/);
  assert.match(myPay, /\['commission', 'clawback'\]\.includes\(clean\(entry\.kind\)\)/);
  assert.match(myPay, /t\('held_for_review', 'Held for review'\)/);
  assert.doesNotMatch(crew + sales, /totals\.projected_cents/);
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

test('Take a Payment leads to payment setup when the organization cannot take payments (FM-577)', async () => {
  const money = await readFile(moneyUrl, 'utf8');
  // Not ready: the form gets setup actions instead of a bare "not set up" notice.
  assert.match(money, /\.\.\.paymentNotReadyOptions\(config\)/);
  assert.match(money, /\['online_processing_off', 'no_merchant_account'\]\.includes\(reason\)/);
  assert.match(money, /notReadyActions: setUp \? \[\{ label: [^\]]*"Set up payments"[^\]]*onClick: startPaymentSetup \}, record\] : \[record\]/);
  // Setup is the Money app setup in the portal holding the project window, and only for whoever can run it.
  assert.match(money, /host\.Portal\.appSetup\.run\('platform\.money'\)/);
  assert.match(money, /hasPerm[^;]*\('manage_company_settings'\)/);
  // A not-ready answer is asked again on the next open, so finishing setup shows at once.
  assert.match(money, /modal\.type === 'take_payment' && state\.paymentIntakeConfig\?\.config\?\.ready !== true\) state\.paymentIntakeConfig = null/);
});

test('Generate invoice is a two-column composer, and money dialogs are bottom trays on a phone (GP-4)', async () => {
  const money = await readFile(moneyUrl, 'utf8');
  // Items and the note on the left; dates, switches and totals in a panel beside them.
  assert.match(money, /<form class="mn-invoice" data-money-invoice-form id="mnInvoiceForm">\s*<div class="mn-invoice-main">/);
  assert.match(money, /<div class="mn-invoice-side">\s*<div class="mn-invoice-settings">/);
  assert.match(money, /size:'mn-invoice-modal'/);
  // The total stays in view in the footer on a phone, kept current with the form.
  assert.match(money, /data-money-invoice-foot-total/);
  assert.match(money, /querySelectorAll\('\[data-money-invoice-foot-total\]'\)\.forEach/);
  // Classes that set display honour hidden.
  assert.match(money, /\.mn-invoice-total-row\[hidden\]\{display:none\}/);
  assert.match(money, /\.mn-invoice-setting\[hidden\]\{display:none\}/);
  // Phone: dialogs rise from the bottom edge to edge, and both the invoice and its email step drag or tap away.
  assert.match(money, /@container money \(max-width:640px\)\{[\s\S]*\.mn-modal-shade\{padding:0;align-items:flex-end;backdrop-filter:none\}[\s\S]*border-radius:18px 18px 0 0/);
  assert.match(money, /function bindTray\(shade, close, options = \{\}\)/);
  assert.match(money, /const tray = bindTray\(layer\.querySelector\('\[data-money-modal-shade\]'\), closeModal,/);
  assert.match(money, /const tray = bindTray\(shade, \(\) => shade\?\.remove\(\), \{ opening:true \}\)/);
  // Dialogs that must not close from outside (receipt review, a payment in progress) stay put.
  assert.match(money, /dismissible:\(\) => !state\.receiptBatch && !state\.receiptReview && !\(state\.modal\?\.type === 'take_payment' && moneyMutationBusy\(\)\)/);
});

test('on a phone the Finance actions and Reports are one + menu beside Settings; a desktop keeps its buttons (GP-2)', async () => {
  const money = await readFile(moneyUrl, 'utf8');
  // Desktop: the buttons stay, each marked desktop-only; the + sits between Reports and Settings and is hidden.
  for (const button of ['data-money-take-payment', 'data-money-upload-receipt', 'data-money-open-modal="invoice"', 'data-money-open-modal="reports"']) {
    assert.match(money, new RegExp(`class="mn-btn [^"]*mn-desk-only"[^>]*${button.replace(/[\[\]"]/g, '\\$&')}`), button);
  }
  assert.match(money, /data-money-open-modal="reports"[^\n]*\n\s*<button type="button" class="mn-btn primary icon mn-add-menu" data-money-open-modal="add_menu"[^\n]*\n\s*\$\{manage \? `<button type="button" class="mn-btn icon" data-money-open-modal="settings"/);
  assert.match(money, /\.mn-tools \.mn-add-menu\{display:none\}/);
  // Phone (the tab no wider than 640 px): the desktop-only buttons go and the + shows.
  assert.match(money, /@container money \(max-width:640px\)\{[\s\S]*\.mn-tools \.mn-desk-only\{display:none\}\s*\.mn-tools \.mn-add-menu\{display:inline-flex\}/);
  // The menu is a money tray open to everyone; Reports for all, the rest only for those who manage money.
  assert.match(money, /add_menu:addMenuModalHtml/);
  assert.doesNotMatch(money, /const manageOnly = \[[^\]]*'add_menu'/);
  assert.match(money, /\$\{manage \? item\('take_payment'[\s\S]*\$\{manage \? item\('upload_receipts'[\s\S]*\$\{manage \? item\('invoice'[\s\S]*\$\{item\('reports'/);
  // A choice closes the menu first, so its dialog rises as a fresh tray; receipts open the file picker in the same tap.
  assert.match(money, /function runAddAction\(action\)\{\s*closeModal\(\);\s*if \(action === 'upload_receipts'\) \{[^}]*querySelector\('\[data-money-receipt-input\]'\)\?\.click\(\)/);
  assert.match(money, /querySelectorAll\('\[data-money-add-action\]'\)\.forEach\(\(button\) => button\.addEventListener\('click', \(event\) => \{[^}]*\}\s*runAddAction\(cleanText\(button\.dataset\.moneyAddAction\)\)/);
});

test('Take a Payment wears the Operations Setup pill while online payments are not set up, and it opens setup (GP-17)', async () => {
  const money = await readFile(moneyUrl, 'utf8');
  const setup = await readFile(paymentsSetupUrl, 'utf8');
  // Only on a definite not-set-up answer for this project's organization; paused or unavailable is not setup.
  assert.match(money, /function paymentsSetupPending\(\)\{[^}]*entry\.key === `\$\{orgId\(\)\}:\$\{projectId\(\)\}`[^}]*!!config && config\.ready !== true && \['online_processing_off', 'no_merchant_account', 'not_approved'\]\.includes/);
  // Desktop button and the phone + menu item both carry it, with the Operations badge's copy and colours.
  assert.match(money, /data-money-take-payment[^\n]*\$\{setupPending \? paymentsSetupPillHtml\(\) : ''\}<\/button>/);
  assert.match(money, /item\('take_payment',[^\n]*setupPending \? paymentsSetupPillHtml\(\) : ''\)/);
  assert.match(money, /<span class="mn-setup-pill" data-money-payments-setup>\$\{\(globalThis\.PlatformLanguage\?\.htmlText\("money","m_b06faf127e1505","Setup"\)/);
  assert.match(money, /\.mn-setup-pill\{[^}]*border:1px solid #f2ca72;border-radius:20px;background:#fff0cb;color:#794c00/);
  // The pill opens payment setup for whoever can set payments up; the rest of the button still opens Take a payment.
  assert.match(money, /closest\?\.\('\[data-money-payments-setup\]'\) && canSetUpPayments\(\)\) \{ startPaymentSetup\(\); return; \}\s*openModal\(\{ type:'take_payment' \}\)/);
  assert.match(money, /closest\?\.\('\[data-money-payments-setup\]'\) && canSetUpPayments\(\) && !moneyMutationBusy\(\)\) \{ startPaymentSetup\(\); return; \}/);
  // When the setup closes, readiness is asked again so the pill goes once payments are ready.
  assert.match(money, /Promise\.resolve\(setup\)\.then\(recheckPaymentsSetup, \(\) => openPaymentSettings\(\)\)/);
  // Setup is started from inside the project window (z-index 2147483200): it has to open above it, below guides.
  const z = Number(setup.match(/\.fmp-modal\{position:fixed;inset:0;z-index:(\d+);/)?.[1]);
  assert.ok(z > 2147483200 && z < 2147483300, `payments setup z-index ${z}`);
});

test('the Finance tab placeholder is its one loading message: styled before mount and marked as a status (GP-9)', async () => {
  const money = await readFile(moneyUrl, 'utf8');
  // The project window paints panelHtml before mount; the runtime keeps a visible role="status" as the tab's only loader.
  assert.match(money, /function panelHtml\(\)\{[^}]*injectCSS\(\);\s*return `<div class="mn-app" data-money-root><div class="mn-shell" data-money-shell><div class="mn-state" role="status"/);
});
