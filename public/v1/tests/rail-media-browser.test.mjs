// The Operations rail's Photos and Documents views: the project's media and documents, in the Photos and Docs tabs'
// order, in the shared media carousel, read only when shown, with the rail's own controls and the published materials
// an accepted document carries.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';

const root = new URL('../../libraries/', import.meta.url);
const page = (withMarkup) => `<!doctype html><style>body{margin:0;font-family:Arial}aside{position:relative;display:flex;flex-direction:column;width:900px;height:760px}.sw-viewport{position:relative;flex:1;min-height:0;overflow:hidden}.sw-panel{position:absolute;inset:0;overflow:hidden}.sw-panel[hidden]{display:none}.sw-tabs{display:flex;height:40px}</style><aside></aside>${withMarkup ? '<script src="/libraries/markup/firstmate-markup.js"></script>' : ''}`;
async function serve() {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/' || path === '/plain') { res.setHeader('Content-Type', 'text/html'); res.end(page(path === '/')); return; }
    if (/\.(svg)$/.test(path)) { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#8a9"/></svg>'); return; }
    if (/\.pdf$|\/pdf$/.test(path)) { res.statusCode = 404; res.end(); return; }
    try { res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(new URL(path.replace('/libraries/', ''), root))); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
// A project with report photos, its own media (one receipt, one in the trash, one of another project), uploaded
// documents, an invoice, a draft and an accepted (signed) document with a published material set.
const fixture = () => {
  window.calls = [];
  const day = (d) => `2026-10-${d}T12:00:00.000Z`;
  const owner = { type: 'project', id: 'project' };
  window.host = { tabs: [], getProject: () => ({ id: 'project', title: '2205 Mimosa Pl' }), getPhotos: () => [{ id: 'top_down_thumbnail', is_top_down_thumbnail: true, src: '/top.svg' }], setPhotos() {}, setActivePreviewTab: (tab) => host.tabs.push(tab) };
  window.PlatformAPI = {
    baseUrl: () => '/v1/platform',
    media: {
      list: async (org, options) => { calls.push(['media.list', org, options]); return { media: [
        { id: 'old', kind: 'image', owner, metadata: { name: 'Old photo', uploaded_at: day(20) } },
        { id: 'new', kind: 'image', owner, metadata: { name: 'New photo', uploaded_at: day(25) } },
        { id: 'clip', kind: 'video', owner, metadata: { name: 'Walkthrough', uploaded_at: day(22) } },
        { id: 'receipt', kind: 'image', owner: { ...owner, slot: 'receipts' }, metadata: { name: 'Receipt', uploaded_at: day(26) } },
        { id: 'trashed', kind: 'image', owner, metadata: { name: 'Trashed', uploaded_at: day(26), in_trash: true } },
        { id: 'elsewhere', kind: 'image', owner: { type: 'project', id: 'other' }, metadata: { name: 'Other project', uploaded_at: day(27) } }
      ] }; },
      fileUrl: (org, id) => `/${id}.svg`, thumbnailUrl: (org, id) => `/${id}.svg`
    },
    projectMedia: { normalizePhotos: (list) => list.map((p) => ({ ...p, media_id: p.media_id || p.id, src: p.src || `/${p.media_id || p.id}.svg`, thumb: p.thumb || `/${p.media_id || p.id}.svg`, label: p.metadata?.name || p.label, uploaded_at: p.metadata?.uploaded_at, media_type: p.kind || p.metadata?.kind, owner: p.owner, metadata: p.metadata || {} })) },
    projectDocuments: { list: async (org, pid) => { calls.push(['projectDocuments.list', org, pid]); return { documents: [{ id: 'up1', media_id: 'permit', title: 'Permit.pdf', content_type: 'application/pdf', uploaded_at: day(21) }] }; } }
  };
  window.PaymentsAPI = { invoices: { list: async () => ({ invoices: [{ id: 'inv1', invoice_number: 'INV-1', created_at: day(23) }] }), pdfUrl: (org, id) => `/v1/payments/${id}/pdf` } };
  window.DocumentsAPI = { documents: { listForProject: async () => ({ documents: [
    { id: 'contract', title: 'Roof contract', document_type: 'contract', status: 'signed', updated_at: day(24) },
    { id: 'draft', title: 'Draft proposal', document_type: 'proposal', status: 'draft', updated_at: day(26) },
    { id: 'voided', title: 'Void', document_type: 'proposal', status: 'void', updated_at: day(27) }
  ] }) } };
  window.scopeDocuments = [
    { source: 'document', id: 'contract:snap', documentId: 'contract', snapshotId: 'snap', acceptedAt: day(24), title: 'Roof contract', document_type: 'contract', status: 'signed', total: '$12,000.00', snapshot: { pdf: { media_id: 'contract-pdf' } }, sets: [{ title: 'Roofing', lines: [{ name: 'Shingles', quantity: 30, unit: 'sq', order_quantity: 90, order_unit: 'bundle', unit_cost: 40, currency: 'USD' }] }] },
    { source: 'report_asset', id: 'roof_report_pdf', title: 'Roof Measurement Report', url: '/report.pdf' }
  ];
  window.widgetContext = { target: { scope: 'project', organizationId: 'org', projectId: 'project' }, read: async (source, target) => { calls.push(['read', source, target]); return { status: 'ready', value: { media: [{ url: '/reference.svg', label: 'Reference photo' }, { url: '/aerial.svg', label: 'Aerial view' }, { url: 'https://invalid.example/x.png', label: 'External' }, { url: '/v.svg', video: true }] } }; } };
};

test('the rail shows the project photos and documents as the shared carousel, read only when shown', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const tab = await browser.newPage({ viewport: { width: 1000, height: 820 } });
    const errors = []; tab.on('pageerror', (error) => errors.push(String(error)));
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    await tab.evaluate(fixture);
    await tab.evaluate(async () => {
      window.FirstMateWidgets = { mount: () => ({ setVisible() {}, destroy() {} }) };
      window.helper = await import('/libraries/apps/materials/scope-of-work.js');
      helper.mountSidebar(document.querySelector('aside'), scopeDocuments, '', 'org:project', { widgetContext, scheduleContext: { projectWorkspace: host }, scheduling: false });
    });
    await tab.waitForTimeout(300);
    assert.deepEqual(await tab.evaluate(() => calls.map((c) => c[0])), [], 'nothing is read before a view is shown');

    await tab.getByRole('tab', { name: 'Photos', exact: true }).click();
    const photos = tab.locator('[data-scope-panel="aerial"] [data-media-thumb]');
    await photos.first().waitFor();
    // Report photos first (the aerial leading), then the project's media newest first, as the Photos tab lists them.
    assert.deepEqual(await photos.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))), ['Aerial view', 'Reference photo', 'New photo', 'Walkthrough', 'Old photo']);
    const reads = await tab.evaluate(() => calls);
    assert.deepEqual(reads.find((c) => c[0] === 'read').slice(1), [{ provider: 'project-widgets', export: 'report' }, { scope: 'project', organizationId: 'org', projectId: 'project' }]);
    assert.deepEqual(reads.find((c) => c[0] === 'media.list').slice(1), ['org', { projectId: 'project' }]);
    assert.ok(!reads.some((c) => c[0] === 'projectDocuments.list'), 'Documents are not read until shown');
    const tools = await tab.locator('[data-scope-panel="aerial"] [data-media-toolbar-btn]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    assert.deepEqual(tools, ['Upload', 'Open in Photos']);
    await tab.locator('[data-scope-panel="aerial"] [data-media-toolbar-btn][aria-label="Open in Photos"]').click();
    assert.deepEqual(await tab.evaluate(() => host.tabs), ['photos']);

    await tab.getByRole('tab', { name: 'Documents', exact: true }).click();
    const docs = tab.locator('[data-scope-panel="documents"] [data-media-thumb]');
    await docs.first().waitFor();
    // Newest first, as the Docs tab: the draft (shown as its card), the contract, the invoice, the upload; the report.
    const labels = await docs.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    assert.deepEqual(labels.filter((label) => label !== 'Roof Measurement Report'), ['Draft proposal', 'Roof contract', 'INV-1', 'Permit.pdf']);
    assert.ok(labels.includes('Roof Measurement Report'));
    const items = await tab.evaluate(async () => { const mod = await import('/libraries/apps/materials/rail-media.js?v=20261027-rail-media'); return mod ? 'ok' : ''; });
    assert.equal(items, 'ok');
    // A PDF is only asked for when one is stored: the signed contract's snapshot PDF; never the draft's.
    const requested = await tab.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => /\/pdf/.test(name)));
    assert.ok(!requested.some((name) => name.includes('/documents/draft/')), JSON.stringify(requested));

    await docs.nth(labels.indexOf('Roof contract')).click();
    await tab.locator('[data-scope-panel="documents"] [data-photo-indicator="published_materials"]').waitFor();
    assert.match(await tab.locator('[data-scope-panel="documents"] [data-photo-indicator="published_materials"]').textContent(), /Published 1 material/);
    await tab.locator('[data-scope-panel="documents"] [aria-label="Item actions"]:visible').last().click();
    await tab.locator('[data-scope-panel="documents"] button:visible', { hasText: 'Show 1 material' }).last().click();
    const sheet = tab.locator('[data-scope-panel="documents"] .fm-rail-sheet');
    await sheet.waitFor();
    assert.match(await sheet.textContent(), /Roof contract[\s\S]*Shingles[\s\S]*90 bundle/);
    await tab.keyboard.press('Escape');
    await tab.waitForFunction(() => document.querySelector('.fm-rail-sheet').hidden);
    const toolsDocs = await tab.locator('[data-scope-panel="documents"] [data-media-toolbar-btn]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
    assert.deepEqual(toolsDocs, ['Upload', 'Open in Docs']);
    await tab.locator('[data-scope-panel="documents"] [data-media-toolbar-btn][aria-label="Open in Docs"]').click();
    assert.deepEqual(await tab.evaluate(() => host.tabs), ['photos', 'docs']);

    await tab.evaluate(() => helper.disposeSidebar(document.querySelector('aside')));
    assert.equal(await tab.locator('.fm-rail-media').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});

test('without the shared carousel the rail falls back to its own stage and filmstrip, and an empty project offers Upload', async () => {
  const server = await serve();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const tab = await browser.newPage({ viewport: { width: 1000, height: 820 } });
    const errors = []; tab.on('pageerror', (error) => errors.push(String(error)));
    await tab.goto(`http://127.0.0.1:${server.address().port}/plain`);
    await tab.evaluate(fixture);
    await tab.evaluate(async () => {
      const mod = await import('/libraries/apps/materials/rail-media.js?v=20261027-rail-media');
      const stage = document.createElement('div'); stage.style.cssText = 'position:relative;height:700px'; document.querySelector('aside').append(stage);
      window.view = mod.mountRailPhotos(stage, { context: widgetContext, host });
      view.setVisible(true);
    });
    await tab.locator('.fm-rail-fb-tile').first().waitFor();
    assert.equal(await tab.locator('.fm-rail-fb-tile').count(), 5);
    assert.equal(await tab.locator('.fm-rail-fb-tile').first().getAttribute('aria-label'), 'Aerial view');
    await tab.locator('.fm-rail-fb-tile').nth(2).click();
    assert.match(await tab.locator('.fm-rail-fb-title').textContent(), /New photo/);
    await tab.evaluate(() => view.destroy());

    await tab.evaluate(async () => {
      PlatformAPI.media.list = async () => ({ media: [] });
      widgetContext.read = async () => ({ status: 'ready', value: { media: [] } });
      const mod = await import('/libraries/apps/materials/rail-media.js?v=20261027-rail-media');
      const stage = document.createElement('div'); stage.style.cssText = 'position:relative;height:700px'; document.querySelector('aside').append(stage);
      window.view = mod.mountRailPhotos(stage, { context: widgetContext, host });
      view.setVisible(true);
    });
    await tab.getByText('No photos yet', { exact: true }).waitFor();
    assert.ok(await tab.locator('.fm-rail-fb-stage button', { hasText: 'Upload' }).isVisible());
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
});
