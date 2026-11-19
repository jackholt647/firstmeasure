// GP-69: the company document viewer (libraries/doc-viewer) shows a document in a modal with what can be done with it
// in a column on the right. The company Documents app lists every document and opens each one in it; the Invoices
// app opens each invoice in it with the invoice's actions. GP-112: the Documents app is the project Docs tab's gallery
// (apps/docs/project.js mountDocumentGallery over photos/feed.js: densities, Tags, the Shown menu), with the
// company's uploaded receipts as its Receipts category. The page itself is the project Documents engine's own
// viewer (project.documents' embed API), so it is stubbed here: the test checks what the viewer asks of it.
// Runs the real files in Chromium with Portal, the APIs and the app runtime stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (path) => readFileSync(new URL(`../public/libraries/${path}`, import.meta.url), 'utf8');
const viewerJs = read('doc-viewer/firstmate-doc-viewer.js');
const companyJs = read('apps/documents/company.js');
const feedJs = read('apps/photos/feed.js');
const docsTabJs = read('apps/docs/project.js');
const invoicesJs = read('apps/invoices/app.js');

const DOCS = [
  { id: 'doc_proposal_1', title: 'Roof proposal', document_type: 'proposal', status: 'sent', project_id: 'project_1', params: { amount_cents: 1250000 }, updated_at: '2026-11-18T10:00:00Z', created_at: '2026-11-17T10:00:00Z', project: { id: 'project_1', title: 'Bluewater roof', address: '12 Bluewater Lane' } },
  { id: 'doc_contract_1', title: 'Gutter contract', document_type: 'contract', status: 'signed', project_id: 'project_2', updated_at: '2026-11-16T10:00:00Z', project: { id: 'project_2', title: 'Harbor gutters' } },
  { id: 'doc_invoice_inv_1', title: 'INV-1001', document_type: 'invoice', status: 'issued', project_id: 'project_1', metadata: { payment_invoice: true, source_invoice_id: 'inv_1' }, params: { amount_cents: 500000 }, updated_at: '2026-11-15T10:00:00Z' },
  { id: 'doc_old', title: 'Voided draft', document_type: 'proposal', status: 'void', project_id: 'project_1' }
];
const RECEIPTS = [
  { id: 'rcpt_1', status: 'needs_review', project_id: 'project_3', total_cents: 4321, purchase_date: '2026-11-14', title: 'Lumber yard', uploaded_at: '2026-11-14T10:00:00Z', file: { media_id: 'media_r1', file_name: 'lumber.png', content_type: 'image/png', size_bytes: 2048 } },
  { id: 'rcpt_void', status: 'void', project_id: 'project_3', title: 'Voided receipt', uploaded_at: '2026-11-13T10:00:00Z', file: { file_name: 'void.png', content_type: 'image/png' } }
];
const INVOICE = {
  id: 'inv_1', invoice_number: 'INV-1001', status: 'draft', project_id: 'project_1', total_cents: 500000, balance_due_cents: 500000, amount_paid_cents: 0,
  issue_date: '2026-11-18', due_date: '2026-12-01', customer: { name: 'Pat Owner', email: 'pat@example.test' }, project_ref: { title: 'Bluewater roof' },
  line_items: [{ description: 'Custom item', amount_cents: 500000 }], email_deliveries: []
};

async function setup(page, { invoices = false, receipts = RECEIPTS } = {}) {
  // A real origin, for the gallery's saved density and Shown choice (localStorage).
  await page.route('http://docs.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0"><div id="root" style="height:100vh"></div></body></html>' }));
  await page.goto('http://docs.test/');
  await page.evaluate(({ docs, invoice, receipts }) => {
    window.__calls = [];
    window.__routes = [];
    window.__closed = [];
    const call = (name, args) => window.__calls.push({ name, args });
    let route = { tab: '' };
    const handlers = [];
    window.Portal = {
      cfg: { userOrgId: 'org_1' },
      currentUser: { id: 'user_1', hasApp: () => true },
      ui: { showToast: (...args) => call('toast', args), confirm: async () => true },
      util: {
        hasPerm: () => true,
        escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
        injectCSS: (id, css) => { const style = document.createElement('style'); style.id = `css_${id}`; style.textContent = css; document.head.append(style); }
      },
      navigation: {
        read: () => route,
        registerHandler: (id, handler) => { handlers.push(handler); return () => {}; },
        push: (patch) => { route = { ...route, ...patch }; window.__routes.push({ kind: 'push', patch }); },
        replace: (patch) => { route = { ...route, ...patch }; window.__routes.push({ kind: 'replace', patch }); },
        navigate: (patch, options) => { window.__routes.push({ kind: 'navigate', patch, options }); },
        backOrClose: (keys, fallback) => { route = { ...route, ...fallback }; window.__routes.push({ kind: 'back', keys }); }
      }
    };
    // The project Documents engine, as the viewer mounts it: its embed API is what the viewer uses.
    window.FirstMateEmbeddableApps = {
      registerApp: (definition) => { (window.__apps ||= {})[definition.id] = definition; },
      mount: async (host, id, context) => {
        call('mount', [id, context.projectId, context.params.embed.focus]);
        const embed = context.params.embed;
        window.__embed = embed;
        embed.onReady({
          mountViewer: (target, doc) => { call('mountViewer', [doc.id]); target.innerHTML = `<div data-test-page>${doc.id}</div>`; return { destroy: () => call('destroyViewer', [doc.id]) }; },
          openDocument: async (doc) => { call('openDocument', [doc.id]); embed.onDocScreen(); host.innerHTML = '<div data-test-editor>editor</div>'; },
          openSendModal: (doc) => call('openSendModal', [doc.id]),
          downloadPdf: (doc) => call('downloadPdf', [doc.id]),
          archiveDoc: async (doc) => call('archiveDoc', [doc.id])
        });
        return { destroy: () => call('destroyEngine', [id]) };
      }
    };
    window.PlatformAPI = { projects: {
      get: async (org, id) => ({ document: { id, data: { title: 'Bluewater roof' } } }),
      list: async () => { call('projectsList', []); return { documents: [{ id: 'project_3', data: { title: 'Cedar deck', address: '9 Cedar Court' } }] }; }
    } };
    window.FirstMateMarkup = { openMediaViewer: (options) => { call('openMediaViewer', [options.photos.map((photo) => photo.id), options.index]); return { close() {} }; } };
    window.DocumentsAPI = { documents: {
      listOrganization: async () => ({ documents: structuredClone(docs) }),
      get: async (org, id) => ({ document: structuredClone(docs.find((doc) => doc.id === id) || { id }) })
    } };
    window.PaymentsAPI = { invoices: {
      listAll: async () => ({ invoices: [structuredClone(invoice)], summary: {}, settings: {} }),
      uninvoiced: async () => ({ projects: [] }),
      pdfUrl: (org, id) => `/v1/payments/organizations/${org}/invoices/${id}/pdf`,
      document: async (org, id) => { call('invoiceDocument', [id]); return { invoice: structuredClone(invoice), document: structuredClone(docs.find((doc) => doc.id === `doc_invoice_${id}`)) }; }
    }, receipts: {
      listFor: async (org, association) => { call('receiptsListFor', [association]); return { receipts: structuredClone(receipts) }; },
      fileUrl: (org, id, options) => `/v1/payments/organizations/${org}/receipts/${id}/file${options?.inline ? '?inline=1' : ''}`
    } };
  }, { docs: DOCS, invoice: INVOICE, receipts });
  await page.addScriptTag({ content: viewerJs });
  if (!invoices) for (const content of [feedJs, docsTabJs]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: invoices ? invoicesJs : companyJs });
}

const calls = (page, name) => page.evaluate((wanted) => window.__calls.filter((entry) => entry.name === wanted).map((entry) => entry.args), name);

test('the company document viewer and the apps that open documents in it', async (t) => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  t.after(() => browser.close());

  await t.test('the viewer shows the page through the project Documents engine, with the actions on the right', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await setup(page);
    await page.evaluate((doc) => {
      window.__viewer = window.FMDocViewer.open({
        orgId: 'org_1', document: doc, subtitle: 'Bluewater roof',
        facts: [{ label: 'Project', value: 'Bluewater roof' }, { label: 'Empty', value: '' }],
        actions: [{ id: 'host', label: 'Do the host thing', icon: 'fa-star', run: () => window.__calls.push({ name: 'host', args: [] }) }],
        onChange: () => window.__calls.push({ name: 'changed', args: [] }),
        onClose: (reason) => window.__closed.push(reason)
      });
    }, DOCS[0]);
    await page.waitForSelector('[data-test-page]');
    // The engine is mounted for the document's project and leaves the page's windows alone (focus:false).
    assert.deepEqual(await calls(page, 'mount'), [['project.documents', 'project_1', false]]);
    assert.deepEqual(await calls(page, 'mountViewer'), [['doc_proposal_1']]);
    const rail = await page.$eval('[data-fmdv-rail]', (node) => ({
      facts: [...node.querySelectorAll('dt')].map((dt) => dt.textContent),
      buttons: [...node.querySelectorAll('[data-fmdv-action]')].map((button) => button.dataset.fmdvAction)
    }));
    assert.deepEqual(rail.facts, ['Project'], 'a fact with no value is left out');
    assert.deepEqual(rail.buttons, ['host', 'doc-edit', 'doc-send', 'doc-pdf', 'doc-project', 'doc-void']);
    const box = await page.$eval('[data-fmdv-rail]', (node) => node.getBoundingClientRect().toJSON());
    const stage = await page.$eval('.fmdv-stage', (node) => node.getBoundingClientRect().toJSON());
    assert.ok(box.left >= stage.right - 1, 'the actions are in a column to the right of the document');
    assert.equal(await page.$eval('[data-fmdv-title]', (node) => node.textContent), 'Roof proposal');
    assert.equal(await page.$eval('[data-fmdv-status]', (node) => node.textContent), 'Sent');

    await page.click('[data-fmdv-action="host"]');
    await page.click('[data-fmdv-action="doc-send"]');
    await page.click('[data-fmdv-action="doc-pdf"]');
    assert.equal((await calls(page, 'host')).length, 1);
    assert.deepEqual(await calls(page, 'openSendModal'), [['doc_proposal_1']]);
    assert.deepEqual(await calls(page, 'downloadPdf'), [['doc_proposal_1']]);

    // Edit opens the engine's own document screen over the modal; its Back brings the viewer back, re-read.
    await page.click('[data-fmdv-action="doc-edit"]');
    await page.waitForSelector('[data-fmdv-engine]:not([hidden]) [data-test-editor]');
    assert.deepEqual(await calls(page, 'openDocument'), [['doc_proposal_1']]);
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.__closed), [], 'Escape belongs to the editor while it is open');
    await page.evaluate(() => window.__embed.onListView());
    await page.waitForFunction(() => document.querySelector('[data-fmdv-engine]').hidden);
    await page.waitForFunction(() => window.__calls.filter((entry) => entry.name === 'mountViewer').length === 2);
    assert.equal((await calls(page, 'changed')).length, 1);

    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.__closed), ['person']);
    assert.equal(await page.$('[data-fm-doc-viewer]'), null);
    assert.deepEqual(await calls(page, 'destroyEngine'), [['project.documents']]);
    await page.close();
  });

  await t.test('the Documents app shows every company document and receipt in the Docs gallery and opens each', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setup(page);
    await page.evaluate(() => window.__mounted = window.__apps['portal.documents'].mount({ root: document.getElementById('root'), orgId: 'org_1' }));
    await page.waitForSelector('.fm-document-tile');
    const tiles = () => page.$$eval('.fm-document-tile', (nodes) => nodes.map((node) => node.dataset.photoFeedId.replace(/^documents::/, '')));
    const tile = (id) => `.fm-document-tile[data-photo-feed-id="documents::${id}"]`;
    assert.deepEqual(await tiles(), ['engine:doc_proposal_1', 'engine:doc_contract_1', 'engine:doc_invoice_inv_1', 'receipt:rcpt_1'], 'newest first; voided documents and receipts are left out');
    // Every receipt of the company is read, and its project named from the project list.
    assert.deepEqual(await calls(page, 'receiptsListFor'), [[{ kind: 'organization', id: 'org_1' }]]);
    assert.match(await page.$eval(tile('receipt:rcpt_1'), (node) => node.textContent), /Lumber yard[\s\S]*Receipt[\s\S]*\$43\.21[\s\S]*Cedar deck/);
    assert.match(await page.$eval(tile('engine:doc_proposal_1'), (node) => node.textContent), /Roof proposal[\s\S]*Proposal[\s\S]*Bluewater roof/, 'a tile names its project');

    // The project Docs tab's densities, with List.
    assert.deepEqual(await page.$$eval('.pf-density [data-density]', (nodes) => nodes.map((node) => node.dataset.density)).then((modes) => ['loose', 'comfortable', 'list'].every((mode) => modes.includes(mode))), true);
    await page.click('.pf-density [data-density="list"]');
    await page.waitForSelector('.pf-wrap[data-density="list"] .fm-document-tile');
    assert.equal(await page.evaluate(() => localStorage.getItem('firstmate.documents.density.org_1.')), 'list', 'the density is the one the Docs tab keeps');
    await page.click('.pf-density [data-density="loose"]');

    // Tags: one per kind of document.
    await page.click('[data-local-tags]');
    await page.waitForSelector('[data-local-tag-menu]');
    assert.match(await page.$eval('[data-local-tag-menu]', (node) => node.textContent), /#receipt[\s\S]*/i);
    await page.click('[data-local-tags-close]');

    // Shown: receipts are a category that can be turned off and on, and the choice is kept.
    await page.click('[data-gallery-toolbar-action="shown"]');
    await page.waitForSelector('[data-doc-filter-menu]');
    assert.match(await page.$eval('[data-doc-filter-menu]', (node) => node.textContent), /Receipts1/);
    await page.click('[data-doc-category-toggle="receipt"]');
    assert.deepEqual(await tiles(), ['engine:doc_proposal_1', 'engine:doc_contract_1', 'engine:doc_invoice_inv_1']);
    assert.ok(!JSON.parse(await page.evaluate(() => localStorage.getItem('firstmate.documents.company.shown.org_1.'))).includes('receipt'));
    await page.click('[data-doc-category-toggle="receipt"]');
    await page.click('[data-doc-category-close]');
    assert.equal((await tiles()).length, 4);

    // Search reaches the project.
    await page.fill('.pf-search input', 'harbor');
    await page.waitForFunction(() => document.querySelectorAll('.fm-document-tile').length === 1);
    assert.deepEqual(await tiles(), ['engine:doc_contract_1']);
    await page.fill('.pf-search input', '');
    await page.waitForFunction(() => document.querySelectorAll('.fm-document-tile').length === 4);

    await page.click(tile('engine:doc_proposal_1'));
    await page.waitForSelector('[data-fm-doc-viewer] [data-test-page]');
    assert.ok((await page.evaluate(() => window.__routes)).some((entry) => entry.kind === 'push' && entry.patch.doc === 'doc_proposal_1'), 'the open document is in the route');
    await page.click('[data-fmdv-close]');
    assert.ok((await page.evaluate(() => window.__routes)).some((entry) => entry.kind === 'back' && entry.keys.includes('doc')));

    // A signed document opens but offers no Send or Void.
    await page.click(tile('engine:doc_contract_1'));
    await page.waitForSelector('[data-fm-doc-viewer] [data-test-page]');
    assert.deepEqual(await page.$$eval('[data-fmdv-action]', (nodes) => nodes.map((node) => node.dataset.fmdvAction)), ['doc-edit', 'doc-pdf', 'doc-project']);
    await page.click('[data-fmdv-close]');

    // A receipt opens in the shared file viewer.
    await page.click(tile('receipt:rcpt_1'));
    assert.deepEqual(await calls(page, 'openMediaViewer'), [[['receipt:rcpt_1'], 0]]);

    // An invoice opens in the Invoices app.
    await page.click(tile('engine:doc_invoice_inv_1'));
    const last = (await page.evaluate(() => window.__routes)).at(-1);
    assert.deepEqual(last.patch, { tab: 'invoices', invoice: 'inv_1' });
    assert.equal(await page.$('[data-fm-doc-viewer]'), null);

    // A refresh that changed nothing leaves the gallery as it was.
    await page.evaluate(() => { document.querySelector('.fm-docs-gallery').dataset.kept = '1'; window.dispatchEvent(new Event('fm:documents:changed')); });
    await page.waitForFunction(() => window.__calls.filter((entry) => entry.name === 'receiptsListFor').length === 2);
    await page.waitForTimeout(100);
    assert.equal(await page.$eval('.fm-docs-gallery', (node) => node.dataset.kept), '1');
    assert.deepEqual(errors, []);
    await page.close();
  });

  await t.test('the Invoices app opens an invoice as a document, with the invoice actions in the column', async () => {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await setup(page, { invoices: true });
    await page.evaluate(() => window.__mounted = window.__apps['portal.invoices'].mount({ root: document.getElementById('root'), orgId: 'org_1' }));
    await page.waitForSelector('tr[data-invoice]');
    await page.click('tr[data-invoice="inv_1"]');
    await page.waitForSelector('[data-fm-doc-viewer] [data-test-page]');
    assert.deepEqual(await calls(page, 'invoiceDocument'), [['inv_1']]);
    assert.deepEqual(await calls(page, 'mountViewer'), [['doc_invoice_inv_1']]);
    const buttons = await page.$$eval('[data-fmdv-action]', (nodes) => nodes.map((node) => node.dataset.fmdvAction));
    assert.deepEqual(buttons, ['send', 'payment', 'pdf', 'hold', 'void', 'project'], 'the invoice is sent, paid and voided as an invoice, not as a document');
    assert.equal(await page.$eval('[data-fmdv-title]', (node) => node.textContent), 'INV-1001 · $5,000');
    assert.match(await page.$eval('.fmdv-facts', (node) => node.textContent), /Balance due\$5,000[\s\S]*CustomerPat Owner/);

    // An invoice action's dialog opens above the viewer, which stays open beneath it.
    await page.click('[data-fmdv-action="payment"]');
    await page.waitForSelector('.inv-shade');
    const z = await page.evaluate(() => [getComputedStyle(document.querySelector('.inv-shade')).zIndex, getComputedStyle(document.querySelector('.fmdv-shade')).zIndex].map(Number));
    assert.ok(z[0] > z[1], 'the invoice dialog is above the viewer');
    await page.click('.inv-shade [data-inv-close]');
    assert.ok(await page.$('[data-fm-doc-viewer]'));
    await page.close();
  });
});
