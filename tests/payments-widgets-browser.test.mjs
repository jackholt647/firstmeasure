// The shared payouts and disputes widgets (public/libraries/payments-widgets/payments-widgets.js) in headless Chrome
// against a stubbed PaymentsAPI: the disputes list pulls from the processor on open, a dispute opens with its facts,
// the response form keeps typed text across redraws, saves and submits what Forward needs, and staff file it (GP-76).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WIDGETS = readFileSync(new URL('../public/libraries/payments-widgets/payments-widgets.js', import.meta.url));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script src="/payments-widgets.js"></script></head>
<body><div id="host"></div></body></html>`;

// A stub PaymentsAPI that answers like /v1/payments and records every request.
const STUB = () => {
  const dispute = {
    id: 'payment_dispute_dp_1', provider_dispute_id: 'dp_1', status: 'new', open: true,
    amount_cents: 125000, currency: 'USD', reason: 'Merchandise/Services Not Received', reason_code: '13.1',
    respond_by: '2099-01-15', original_respond_by: '2099-01-10', dispute_date: '2026-11-01', received_date: '2026-11-02',
    card_last4: '4242', authorization_code: 'A1B2C3', transaction_date: '2026-10-20', transaction_amount_cents: 125000,
    transaction_id: 'payment_1', project_id: 'project_1', response: null
  };
  const closed = { ...dispute, id: 'payment_dispute_dp_2', provider_dispute_id: 'dp_2', status: 'won', open: false, amount_cents: 5000 };
  window.__requests = [];
  window.__state = { dispute, staff: false };
  const respond = (path, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    window.__requests.push({ method, path, body: options.body ?? null });
    const state = window.__state;
    if (path.endsWith('/disputes/sync')) return { ok: true, sync: { ok: true, synced: 2, synced_at: new Date().toISOString() }, disputes: [state.dispute, closed] };
    if (/\/disputes$/.test(path)) return { ok: true, disputes: [state.dispute, closed], can_respond: true, staff: state.staff };
    if (path.endsWith('/evidence') && method === 'POST') return { ok: true, file: { media_id: 'media_1', file_name: options.body.file_name, content_type: options.body.content_type, size_bytes: 10 } };
    if (path.endsWith('/response') && method === 'PUT') {
      const body = options.body;
      const current = state.dispute.response || {};
      const next = body.action === 'reopen' ? { ...current, status: 'draft' } : {
        ...current, status: body.action === 'submit' ? 'submitted' : 'draft', decision: body.decision, category: body.category,
        summary: body.summary, evidence: body.evidence, attachments: (body.attachments || []).map((file) => ({ ...file, file_name: 'contract.pdf', content_type: 'application/pdf' })),
        updated_at: new Date().toISOString(), history: body.action === 'submit' ? [{ at: new Date().toISOString(), action: 'submitted', by: 'Owner' }] : []
      };
      state.dispute = { ...state.dispute, response: next };
      return { ok: true, dispute: state.dispute };
    }
    if (path.startsWith('/staff/dispute-responses')) return { ok: true, disputes: [{ ...state.dispute, organization_id: 'org_1', organization_name: 'Acme Roofing' }] };
    if (path.startsWith('/staff/organizations/') && method === 'POST') {
      state.dispute = { ...state.dispute, response: { ...state.dispute.response, status: options.body.action === 'filed' ? 'filed' : 'returned', staff_note: options.body.note, filed_at: new Date().toISOString() } };
      return { ok: true, dispute: state.dispute };
    }
    if (/\/disputes\/[^/]+$/.test(path)) {
      return { ok: true, dispute: state.dispute, can_respond: true, organization_id: 'org_1', payment: { id: 'payment_1', amount_cents: 125000, received_at: '2026-10-20', payer_name: 'Pat Doe' }, project: { id: 'project_1', title: '12 Main St', customer_name: 'Pat Doe' } };
    }
    if (path.endsWith('/finance-summary')) return { ok: true, summary: { balance_pending_cents: 1000, in_transit_cents: 2000, disputes_open_count: 1 } };
    if (path.endsWith('/payouts')) return { ok: true, payouts: [{ id: 'payment_payout_po_1', provider_payout_id: 'po_1', status: 'completed', amount_cents: 99000, fee_cents: 300, created_at: '2026-11-01', transaction_ids: ['payment_1'] }] };
    if (path.includes('/payouts/')) return { ok: true, payout: { provider_payout_id: 'po_1', status: 'completed', amount_cents: 99000 }, transactions: [] };
    throw new Error(`unexpected ${method} ${path}`);
  };
  window.PaymentsAPI = {
    request: async (path, options) => respond(path, options),
    url: (path) => `/v1/payments${path}`,
    finance: { summary: (org) => respond(`/organizations/${org}/finance-summary`) },
    payouts: { list: (org) => respond(`/organizations/${org}/payouts`), get: (org, id) => respond(`/organizations/${org}/payouts/${id}`) }
  };
  window.confirm = () => true;
};

async function page(t) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/payments-widgets.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(WIDGETS); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const tab = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await tab.addInitScript(STUB);
  await tab.goto(`http://localhost:${server.address().port}/`);
  return tab;
}

test('disputes: pulled on open, answered with evidence, submitted to FirstMate', async (t) => {
  const tab = await page(t);
  await tab.evaluate(() => { window.__widget = window.FirstMatePaymentsWidgets.mountDisputes(document.getElementById('host'), { orgId: 'org_1', onOpenProject: (id) => { window.__opened = id; } }); });
  await tab.waitForSelector('tr[data-pmw-row="payment_dispute_dp_1"]');
  await tab.waitForFunction(() => window.__requests.some((entry) => entry.path === '/organizations/org_1/disputes/sync' && entry.method === 'POST'));
  // "Needs response" shows only the open one; the won dispute is under Closed.
  assert.equal(await tab.locator('tr[data-pmw-row]').count(), 1);
  assert.match(await tab.locator('.pmw-chip.active').textContent(), /Needs response/);

  await tab.click('tr[data-pmw-row="payment_dispute_dp_1"]');
  await tab.waitForSelector('[data-pmw-response]');
  const facts = await tab.locator('.pmw-facts').textContent();
  for (const fact of ['Merchandise/Services Not Received', 'Code 13.1', '•••• 4242', 'A1B2C3', '12 Main St', 'Pat Doe']) assert.ok(facts.includes(fact), `facts show ${fact}`);

  // Nothing to fill until a decision; fighting it picks the evidence for the reason ("not received").
  assert.equal(await tab.locator('[data-pmw-summary]').count(), 0);
  await tab.click('[data-pmw-decision="contest"]');
  assert.equal(await tab.locator('[data-pmw-category]').inputValue(), 'not_received');
  assert.equal(await tab.locator('[data-pmw-evidence="delivery_proof"]').count(), 1);
  await tab.fill('[data-pmw-evidence="delivery_proof"]', 'Roof finished and signed off on Oct 20.');
  // A redraw (another category) keeps what was typed.
  await tab.selectOption('[data-pmw-category]', 'fraud');
  await tab.selectOption('[data-pmw-category]', 'not_received');
  assert.equal(await tab.locator('[data-pmw-evidence="delivery_proof"]').inputValue(), 'Roof finished and signed off on Oct 20.');

  // A file: uploaded to the dispute, then the draft saves it with a label.
  await tab.setInputFiles('[data-pmw-file-input]', { name: 'contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await tab.waitForFunction(() => window.__requests.some((entry) => entry.method === 'PUT' && entry.body.attachments?.length === 1));
  const upload = await tab.evaluate(() => window.__requests.find((entry) => entry.path.endsWith('/evidence')));
  assert.equal(upload.path, '/organizations/org_1/disputes/payment_dispute_dp_1/evidence');
  assert.equal(upload.body.content_type, 'application/pdf');
  assert.match(upload.body.data_base64, /^data:application\/pdf;base64,/);

  // Submitting without a letter is stopped in the page.
  await tab.click('[data-pmw-submit]');
  assert.match(await tab.locator('.pmw-actions .pmw-status').textContent(), /Write a few sentences/);
  await tab.fill('[data-pmw-summary]', 'The customer signed our proposal on Oct 1 and we finished the roof on Oct 20.');
  // The portal's confirm answers with a promise: Cancel there must stop the submission.
  await tab.evaluate(() => { window.confirm = () => Promise.resolve(false); });
  await tab.click('[data-pmw-submit]');
  await tab.waitForTimeout(200);
  assert.equal(await tab.evaluate(() => window.__requests.some((entry) => entry.method === 'PUT' && entry.body.action === 'submit')), false);
  await tab.evaluate(() => { window.confirm = () => Promise.resolve(true); });
  await tab.click('[data-pmw-submit]');
  await tab.waitForSelector('.pmw-note.info');
  const submit = await tab.evaluate(() => window.__requests.filter((entry) => entry.method === 'PUT').pop().body);
  assert.equal(submit.action, 'submit');
  assert.equal(submit.decision, 'contest');
  assert.equal(submit.category, 'not_received');
  assert.equal(submit.evidence.delivery_proof, 'Roof finished and signed off on Oct 20.');
  assert.deepEqual(submit.attachments.map((file) => file.media_id), ['media_1']);
  assert.ok(submit.attachments[0].label, 'an attached file gets a suggested name');
  // Submitted: read-only, with a way to change it.
  assert.equal(await tab.locator('[data-pmw-summary]').isDisabled(), true);
  assert.equal(await tab.locator('[data-pmw-reopen]').count(), 1);
  await tab.click('[data-pmw-project]');
  assert.equal(await tab.evaluate(() => window.__opened), 'project_1');
});

test('disputes: FirstMate staff see every company\'s submissions and mark them filed', async (t) => {
  const tab = await page(t);
  await tab.evaluate(() => {
    window.__state.staff = true;
    window.__state.dispute = { ...window.__state.dispute, response: { status: 'submitted', decision: 'accept', summary: 'Refund it.', submitted_at: '2026-11-03', submitted_by: 'Owner' } };
    window.prompt = () => Promise.resolve('Filed in Forward');
    window.FirstMatePaymentsWidgets.mountDisputes(document.getElementById('host'), { orgId: 'org_1' });
  });
  await tab.waitForSelector('[data-pmw-filter="queue"]');
  await tab.click('[data-pmw-filter="queue"]');
  await tab.waitForSelector('tr[data-pmw-org="org_1"]');
  assert.match(await tab.locator('tr[data-pmw-org="org_1"]').textContent(), /Acme Roofing/);
  await tab.click('tr[data-pmw-org="org_1"]');
  await tab.waitForSelector('[data-pmw-staff="filed"]');
  assert.equal(await tab.evaluate(() => window.__requests.some((entry) => entry.path === '/staff/organizations/org_1/disputes/payment_dispute_dp_1')), true);
  await tab.click('[data-pmw-staff="filed"]');
  await tab.waitForSelector('.pmw-note.good');
  const action = await tab.evaluate(() => window.__requests.filter((entry) => entry.method === 'POST' && entry.path.startsWith('/staff/')).pop());
  assert.deepEqual(action.body, { action: 'filed', note: 'Filed in Forward' });
});

test('payouts: metrics, list and detail; the open disputes tile leads to disputes', async (t) => {
  const tab = await page(t);
  await tab.evaluate(() => { window.FirstMatePaymentsWidgets.mountPayouts(document.getElementById('host'), { orgId: 'org_1', onOpenDisputes: () => { window.__toDisputes = true; } }); });
  await tab.waitForSelector('tr[data-pmw-row="payment_payout_po_1"]');
  assert.match(await tab.locator('[data-pmw-tile="open_disputes"]').textContent(), /1/);
  await tab.click('tr[data-pmw-row="payment_payout_po_1"]');
  await tab.waitForSelector('.pmw-modal .pmw-stats');
  await tab.keyboard.press('Escape');
  assert.equal(await tab.locator('.pmw-modal').count(), 0);
  await tab.click('[data-pmw-tile="open_disputes"]');
  assert.equal(await tab.evaluate(() => window.__toDisputes), true);
});
