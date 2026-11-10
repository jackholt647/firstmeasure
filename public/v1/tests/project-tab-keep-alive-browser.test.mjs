import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// Switching between the project window's tabs keeps each one as it was left (FM-370): coming back to Docs or Photos
// does not mount the tab again or read everything again, so the gallery keeps its scroll, its elements and what was
// loaded. A quiet read that finds a change redraws it, and Photos keeps its scroll through that.

const libraries = new URL('../../libraries/', import.meta.url);
const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

async function pageFor(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://tabs.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: await readFile(new URL(pathname.slice('/libraries/'.length), libraries)) });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:Arial,sans-serif}#tab{position:absolute;inset:0}#tab.off{display:none}</style><div id="tab"></div>' });
  });
  await page.goto('http://tabs.test/');
  return { page, errors };
}

test('coming back to Docs keeps the gallery as it was; only a changed document list redraws it', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser);
    await page.evaluate(() => {
      const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      window.__APP = { userOrgId: 'org', userId: 'sam' };
      const flags = { current: () => ({ raw: { platform: { documents: true } }, effective: { platform: { documents: true } } }), value: () => true };
      window.Portal = { cfg: window.__APP, appFlags: flags, modules: {}, util: { escapeHtml, injectCSS(id, text) { let el = document.getElementById('css_' + id); if (!el) { el = document.createElement('style'); el.id = 'css_' + id; document.head.append(el); } el.textContent = text; } }, ui: { showToast() {} } };
      window.reads = 0;
      window.PlatformAPI = { media: { fileUrl: () => '', thumbnailUrl: () => '' }, projectDocuments: { list: async () => { window.reads += 1; return { documents: [], uploaded_documents: [] }; } } };
      window.engineDocs = Array.from({ length: 30 }, (_, i) => ({ id: `doc${i}`, title: `Proposal ${i + 1}`, document_type: 'proposal', status: 'draft', updated_at: '2026-11-01T00:00:00Z' }));
      const engineApi = { openCreateModal() {}, openDocument() {}, openPreview() {}, getDocs: () => window.engineDocs, refresh() {} };
      window.FirstMateEmbeddableApps = { escapeHtml, registerApp() {}, unregisterApp() {}, mount: async (host, id, context) => { window.docsEmbed = context.params.embed; context.params.embed.onReady(engineApi); context.params.embed.onDocsChanged(window.engineDocs); return { destroy() {}, setActive() {} }; } };
    });
    await page.addScriptTag({ url: '/libraries/apps/photos/feed.js' });
    await page.addScriptTag({ url: '/libraries/apps/docs/project.js' });
    await page.evaluate(() => {
      window.tabContext = () => ({ panelRoot: document.querySelector('#tab'), host: { getProject: () => ({ id: 'p1', name: '2205 Mimosa Pl' }), projectOrgId: () => 'org' } });
      window.Portal.ProjectDocsTab.activate(window.tabContext());
    });
    await page.waitForFunction(() => /30 documents/.test(document.querySelector('.fm-docs-gallery .pf-title')?.textContent || '') && window.reads > 0);
    const scroller = () => page.evaluate(() => { const el = [...document.querySelectorAll('.fm-docs-gallery *')].find((node) => node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)); return el ? (el.scrollTop = el.scrollTop || 240, true) : false; });
    assert.ok(await scroller(), 'the gallery scrolls');
    const leave = () => page.evaluate(() => { document.querySelector('#tab').classList.add('off'); window.Portal.ProjectDocsTab.deactivate(window.tabContext()); });
    const back = async () => { await page.evaluate(() => { document.querySelector('#tab').classList.remove('off'); window.Portal.ProjectDocsTab.activate(window.tabContext()); }); await page.waitForTimeout(150); };
    const state = () => page.evaluate(() => { const gallery = document.querySelector('.fm-docs-gallery'), el = [...gallery.querySelectorAll('*')].find((node) => node.scrollHeight > node.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(node).overflowY)); return { same: gallery.__kept === true, reads: window.reads, top: Math.round(el?.scrollTop || 0), count: parseInt(gallery.querySelector('.pf-title').textContent, 10) }; });
    await page.evaluate(() => { document.querySelector('.fm-docs-gallery').__kept = true; });
    const before = await state();
    assert.ok(before.top > 0, 'scrolled down');

    await leave(); await back();
    assert.deepEqual(await state(), before, 'the same gallery, at the same place, with nothing read again');

    // The engine's quiet read on the way back found nothing new: still the same gallery.
    await page.evaluate(() => window.docsEmbed.onDocsChanged(window.engineDocs.map((doc) => ({ ...doc }))));
    assert.deepEqual(await state(), before, 'an unchanged read leaves the gallery alone');

    // A document added elsewhere draws the gallery again with it.
    await page.evaluate(() => window.docsEmbed.onDocsChanged([...window.engineDocs, { id: 'doc-new', title: 'Contract', document_type: 'contract', status: 'draft', updated_at: '2026-11-02T00:00:00Z' }]));
    const changed = await state();
    assert.equal(changed.same, false, 'a changed list is drawn again');
    assert.equal(changed.count, before.count + 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('coming back to Photos keeps the gallery mounted; new photos redraw it where it was scrolled', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await pageFor(browser);
    await page.evaluate(() => {
      document.querySelector('#tab').innerHTML = '<div id="rPhotoGallery" style="height:100%"></div>';
      window.project = { id: 'p1', photos: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, media_id: `m${i}`, content_type: 'image/jpeg', file_name: `${i}.jpg`, owner: { type: 'project', id: 'p1', slot: 'photos' } })) };
      window.mounts = 0; window.lists = 0;
      window.Portal = { cfg: { orgId: 'org' }, ui: { showToast() {} }, PhotoFeed: { mountProjectGallery: (el, options) => {
        window.mounts += 1;
        el.innerHTML = `<div class="pf-scroll" style="height:400px;overflow:auto">${options.photos.map((photo) => `<div style="height:120px">${photo.id}</div>`).join('')}</div>`;
      } } };
      window.projectOrgId = () => 'org';
      window.PlatformAPI = { media: { list: async () => { window.lists += 1; return { media: window.project.photos }; } }, publication: { read: async () => ({ status: 'ready', value: { fields: [] } }) } };
    });
    await page.addScriptTag({ url: '/libraries/apps/photos/project.js' });
    await page.evaluate(() => {
      window.tabContext = () => ({ panelRoot: document.querySelector('#rPhotoGallery'), host: { getProject: () => window.project, getPhotos: () => window.project.photos, setPhotos: (photos) => (window.project.photos = photos) } });
      window.Portal.ProjectPhotosTab.activate(window.tabContext());
    });
    await page.waitForFunction(() => window.lists > 0);
    await page.waitForTimeout(100);
    const state = () => page.evaluate(() => { const scroll = document.querySelector('.pf-scroll'); return { mounts: window.mounts, top: Math.round(scroll?.scrollTop || 0), kept: scroll?.__kept === true }; });
    await page.evaluate(() => { const scroll = document.querySelector('.pf-scroll'); scroll.scrollTop = 900; scroll.__kept = true; });
    const before = await state();
    assert.equal(before.top, 900);

    const visit = async () => {
      await page.evaluate(() => { document.querySelector('#tab').classList.add('off'); window.Portal.ProjectPhotosTab.deactivate(window.tabContext()); });
      const lists = await page.evaluate(() => window.lists);
      await page.evaluate(() => { document.querySelector('#tab').classList.remove('off'); window.Portal.ProjectPhotosTab.activate(window.tabContext()); });
      await page.waitForFunction((count) => window.lists > count, lists);
      await page.waitForTimeout(100);
    };
    await visit();
    assert.deepEqual(await state(), before, 'the same gallery at the same place: the quiet read found nothing new');

    // A photo added elsewhere while the tab was away: the gallery is drawn again, still where it was scrolled.
    await page.evaluate(() => { window.project.photos = [...window.project.photos]; window.serverExtra = true; const list = window.PlatformAPI.media.list; window.PlatformAPI.media.list = async () => { const result = await list(); return { media: [...result.media, { id: 'm-new', media_id: 'm-new', content_type: 'image/jpeg', file_name: 'new.jpg', owner: { type: 'project', id: 'p1', slot: 'photos' } }] }; }; });
    await visit();
    const after = await state();
    assert.equal(after.mounts, before.mounts + 1, 'drawn again with the new photo');
    assert.equal(after.top, 900, 'still where it was scrolled');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
