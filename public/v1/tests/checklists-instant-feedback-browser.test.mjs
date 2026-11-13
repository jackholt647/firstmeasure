import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-449: on the project Checklists tab every tap answers at once. The phone's haptic fires before anything is sent,
// a check shows (animated) before its save answers, and a save that fails puts the row back and says why.
const source = await readFile(new URL('../../libraries/apps/checklists/app.js', import.meta.url), 'utf8');

async function mount(){
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
  const page = await browser.newPage({viewport:{width:430, height:900}});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="host" style="height:900px"></main>');
  await page.evaluate(() => {
    window.log = [];
    window.toasts = [];
    window.pending = [];
    // Every write waits until the test settles it, as a slow connection would.
    const later = (name, args) => { log.push(name); return new Promise((resolve, reject) => pending.push({name, args, resolve, reject})); };
    window.PhoneFeatures = {haptic:() => { log.push('haptic'); return Promise.resolve(); }};
    window.FirstMateEmbeddableApps = {registerApp:(app) => { window.checklistApp = app; }};
    window.Portal = {util:{injectCSS:(_id, css) => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); }}, ui:{showToast:(title, message, ok) => toasts.push({title, message, ok})}, currentUser:{id:'u1', name:'Pat'}};
    const items = [
      {id:'a', title:'Ridge vent installed', item_type:'todo', completed:false},
      {id:'b', title:'Gutters checked', item_type:'todo', completed:false},
      {id:'r', title:'Site clean', item_type:'rating', completed:false, rating:''}
    ];
    window.CrewAPI = {projects:{
      checklists:async () => ({checklists:[{id:'cl', title:'Work completion', items:items.map((item) => ({...item})), signature_required:false, crew_editable:false}]}),
      updateItemInChecklist:(...args) => later('save', args),
      updateChecklist:(...args) => later('update', args),
      addItemToChecklist:(...args) => later('add', args)
    }};
  });
  await page.addScriptTag({content:source});
  await page.evaluate(() => { window.handle = checklistApp.mount({root:document.querySelector('#host'), orgId:'org', projectId:'p', currentUser:{id:'u1'}}); });
  await page.locator('[data-fmcl-item="cl::a"]').waitFor();
  return {browser, page, errors};
}

test('a check shows at once, after the haptic and before its save answers', async () => {
  const {browser, page, errors} = await mount();
  try {
    await page.locator('[data-fmcl-item="cl::a"] [data-fmcl-toggle]').click();
    assert.deepEqual(await page.evaluate(() => log), ['haptic', 'save']);
    assert.equal(await page.locator('[data-fmcl-item="cl::a"]').evaluate((row) => row.classList.contains('done')), true, 'checked before the save answered');
    assert.equal(await page.locator('[data-fmcl-item="cl::a"] .fmcl-check').evaluate((check) => check.classList.contains('fmcl-pop')), true, 'the check animates');
    assert.match(await page.locator('[data-fmcl-item="cl::a"] .fmcl-item-copy').innerText(), /Done · Pat/);
    assert.equal(await page.locator('[data-fmcl-list="cl"] .fmcl-count').innerText(), '1/3');
    assert.deepEqual(await page.evaluate(() => pending[0].args[4]), {completed:true});
    await page.evaluate(() => pending[0].resolve({item:{id:'a', title:'Ridge vent installed', item_type:'todo', completed:true, completed_by_user_id:'u1', completed_at:new Date().toISOString()}}));
    await page.waitForTimeout(50);
    assert.equal(await page.locator('[data-fmcl-item="cl::a"]').evaluate((row) => row.classList.contains('done')), true);
    // Tapping again unchecks at once too, from the item as it is now.
    await page.locator('[data-fmcl-item="cl::a"] [data-fmcl-toggle]').click();
    assert.equal(await page.locator('[data-fmcl-item="cl::a"]').evaluate((row) => row.classList.contains('done')), false);
    assert.deepEqual(await page.evaluate(() => pending[1].args[4]), {completed:false});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a check whose save fails goes back and says why', async () => {
  const {browser, page, errors} = await mount();
  try {
    await page.locator('[data-fmcl-item="cl::b"] [data-fmcl-toggle]').click();
    assert.equal(await page.locator('[data-fmcl-item="cl::b"]').evaluate((row) => row.classList.contains('done')), true);
    await page.evaluate(() => pending[0].reject(Object.assign(new Error('Attach a photo first.'), {data:{message:'Attach a photo first.'}})));
    await page.waitForFunction(() => toasts.length > 0);
    assert.equal(await page.locator('[data-fmcl-item="cl::b"]').evaluate((row) => row.classList.contains('done')), false, 'rolled back');
    assert.equal(await page.locator('[data-fmcl-list="cl"] .fmcl-count').innerText(), '0/3');
    assert.deepEqual(await page.evaluate(() => toasts.map((toast) => [toast.message, toast.ok])), [['Attach a photo first.', false]]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('ratings, switches and new items show before the server answers', async () => {
  const {browser, page, errors} = await mount();
  try {
    await page.locator('[data-fmcl-item="cl::r"] [data-fmcl-rate="good"]').click();
    assert.equal(await page.locator('[data-fmcl-item="cl::r"] [data-fmcl-rate="good"]').evaluate((button) => button.classList.contains('on')), true);
    await page.locator('[data-fmcl-assign]').click();
    const signature = page.locator('[data-fmcl-signature-required]');
    await signature.click();
    assert.equal(await signature.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => pending.find((entry) => entry.name === 'update').args[3]), {signature_required:true});
    await page.keyboard.press('Escape');
    await page.locator('[data-fmcl-new-item]').fill('Dumpster removed');
    await page.locator('[data-fmcl-add-item]').click();
    assert.equal(await page.locator('.fmcl-item.pending').innerText(), 'Dumpster removed');
    assert.equal(await page.locator('[data-fmcl-new-item]').inputValue(), '', 'ready for the next item');
    const log = await page.evaluate(() => log);
    for (const write of ['save', 'update', 'add']) assert.equal(log[log.indexOf(write) - 1], 'haptic', `haptic before ${write}: ${log}`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
