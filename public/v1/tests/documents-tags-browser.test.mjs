import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

for (const inline of [false, true]) test(`Doc Studio Tags opens with ${inline ? 'inline' : 'external'} bundles and supports rename, archive and retry`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    const modules = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://studio.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if(path.endsWith('/tag-manager.js')) modules.push(route.request().url());
      if (path.startsWith('/libraries/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'application/javascript', body: await readFile(new URL(`../..${path}`, import.meta.url), 'utf8') });
      return route.fulfill({ contentType: 'text/html', body: '<main id="studio"></main>' });
    });
    await page.goto('http://studio.test/');
    await page.evaluate(() => {
      window.toasts = []; window.requests = []; window.failTags = false;
      window.FirstMateEmbeddableApps = { registerApp: app => window.studioApp = app };
      window.Portal = { ui: { showToast: (...args) => window.toasts.push(args) } };
      window.DocumentsAPI = {
        catalog: { get: async () => ({}) }, templates: { list: async () => ({ templates: [] }) },
        themes: { list: async () => ({ themes: [] }) }, workflows: { list: async () => ({ workflows: [] }) },
        folders: { list: async () => ({ folders: [{id:'docfld_marketing',key:'marketing',label:'Marketing',system:true}] }) }
      };
      let tags = [{ id: 'tag_a', label: 'Quote', revision: 1, archived: false }];
      window.PlatformAPI = {
        orgs:{portalState:async()=>({})},branches:{get:async()=>({data:{}})},branchModules:{get:async()=>({data:{}})},
        brandingMedia:{list:async()=>({media:[]})},
        baseUrl: () => '/v1/platform',
        request: async (url, opts) => {
          assertAbsoluteUrl(url);
          window.requests.push({ url, ...opts });
          if(window.failTags) throw new Error('Tags could not load. Try again.');
          if (opts.method === 'PATCH') tags = tags.map(t => ({ ...t, ...opts.body, revision: t.revision + 1 }));
          return { tags: structuredClone(tags) };
        }
      };
      function assertAbsoluteUrl(url){ if(!url.startsWith('http://studio.test/v1/documents/')) throw new Error('Tag request used an incorrect API URL.'); }
    });
    if(!inline) await page.evaluate(() => { window.DocumentsAPI.request=(path,options)=>window.PlatformAPI.request(`http://studio.test/v1/documents${path}`, options); });
    await page.addScriptTag({url:'http://studio.test/libraries/brand-kit/brand-kit.js'});
    if(inline) await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/documents/studio.js',import.meta.url),'utf8')});
    else await page.addScriptTag({url:'http://studio.test/libraries/apps/documents/studio.js?v=test'});
    await page.evaluate(() => { window.handle = window.studioApp.mount({ root:document.querySelector('#studio'), orgId:'org' }); });
    await page.getByRole('button', { name:'Tags', exact:true }).click();
    await page.getByRole('heading', { name:'Tag manager' }).waitFor();
    assert.equal(await page.locator('dialog').isVisible(), true);
    await page.getByRole('button', {name:'Rename',exact:true}).click();
    await page.getByLabel('Tag label').fill('Estimate');
    await page.getByRole('button', {name:'Save',exact:true}).click();
    await page.locator('[data-rename]').waitFor();
    assert.match(await page.locator('[data-list]').innerText(), /Estimate/);
    await page.getByRole('button', {name:'Archive',exact:true}).click();
    await page.getByRole('button', {name:'Restore',exact:true}).waitFor();
    await page.getByRole('button', {name:'Close tag manager'}).click();
    await page.locator('dialog').waitFor({state:'detached'});
    await page.locator('[data-tab="brand-kit"]').click();
    await page.locator('#dsLogoStage').waitFor();
    await page.evaluate(() => { window.failTags = true; });
    await page.getByRole('button', {name:'Tags',exact:true}).click();
    await page.getByText('Tags could not load. Try again.', {exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:'Tag manager'}).isVisible(),true);
    await page.evaluate(() => { window.failTags = false; });
    await page.getByRole('button', {name:'Retry',exact:true}).click();
    await page.getByRole('button', {name:'Restore',exact:true}).waitFor();
    await page.getByRole('button',{name:'Close tag manager'}).click();
    await page.locator('dialog').waitFor({state:'detached'});
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.toasts), []);
    assert.equal(modules[0], `http://studio.test/libraries/apps/documents/tag-manager.js${inline ? '' : '?v=test'}`);
  } finally { await browser.close(); }
});
