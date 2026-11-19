// GP-51: the document setup's price step takes as many estimates as the company has, on a page of its own: each is read
// as it is added (one per read, two at a time), listed with how that went, more can be added and any removed, and
// Continue puts them all into the lines, a line in several at the middle of their prices. The real player plays the real
// documents-setup.js step; the price sheet and documents.setup.read_estimate are stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = (file) => readFile(new URL('../../libraries/' + file, import.meta.url), 'utf8');
const LIBS = ['navigation/portal-navigation.js', 'guided-experiences/guided-experiences.js', 'guided-experiences/guided-setup.js'];
const t = (key, text) => ({ key, text });
const step = (id, part, required = true) => ({ id, widget: 'module', module: '/libraries/guided-experiences/documents-setup.js', options: { part }, title: t(`gx_tk_${id}`, id), required });
const setup = { id: 'documents.setup', version: 1, kind: 'modal', scope: 'organization', title: t('gx_tk_title', 'Estimates test'), tab: '', replayable: true,
  steps: [step('prices', 'prices', false), step('presentation', 'presentation')],
  completion: { action: null, screen: 'none', say: [], then: [] }, triggers: [], progress: null };
const sheet = {
  editable: true,
  items: [{ id: 'tearoff', name: 'Tear off', unit: 'sq', unit_price: 80, on: true, formula: 'Squares' }, { id: 'ridge', name: 'Ridge cap', unit: 'lf', unit_price: 5, on: true, formula: 'Ridges' }],
  catalog: [{ id: 'drip', name: 'Drip edge', unit: 'lf', unit_price: 3, formula: 'Eaves + Rakes' }],
  measurements: [{ key: 'roofSquares', label: 'Squares' }, { key: 'eavesLf', label: 'Eaves' }]
};
const guard = (price) => ({ name: 'Gutter guard', unit: 'lf', unit_price: price, item_id: null, formula: [{ type: 'measurement', value: 'eavesLf' }] });
const tearoff = (price) => ({ name: 'Tear off', unit: 'sq', unit_price: price, item_id: 'tearoff', formula: null });
// What each file reads as.
const estimates = {
  'a.pdf': { lines: [tearoff(90), guard(7)], notes: 'Read a.' },
  'b.pdf': { lines: [tearoff(100), guard(9)], notes: 'Read b.' },
  'c.pdf': { lines: [tearoff(120)], notes: 'Read c.' },
  'd.png': { lines: [{ name: 'Drip edge', unit: 'lf', unit_price: 3.5, item_id: 'drip', formula: null }], notes: 'Read d.' }
};
const page = () => `<!doctype html><html><head><style>body{margin:0;font:14px Arial}</style></head><body>
  <script>window.__APP={userOrgId:'o',platformApiBase:'https://fm.test/v1/platform'};
    window.__reads=[];window.__now=0;window.__most=0;
    const estimates=${JSON.stringify(estimates)};
    window.PlatformAPI={publication:{
      read:async(org,ref)=>({value:ref.provider==='document-setup'&&ref.export==='price_sheet'?${JSON.stringify(sheet)}:{}}),
      invoke:async(org,action,target,payload)=>{
        if(action!=='documents.setup.read_estimate') return {value:{}};
        window.__reads.push(payload.files.map((file)=>file.file_name));
        window.__now+=1;window.__most=Math.max(window.__most,window.__now);
        await new Promise((done)=>setTimeout(done,250));
        window.__now-=1;
        const read=estimates[payload.files[0].file_name];
        if(!read) throw new Error('That one could not be read.');
        return {value:read};
      }}};</script>
  ${LIBS.map((file) => `<script src="/libraries/${file}"></script>`).join('')}
  </body></html>`;
const file = (name) => ({ name, mimeType: name.endsWith('.png') ? 'image/png' : 'application/pdf', buffer: Buffer.from(`%PDF-1.4 ${name}`) });

async function open(browser){
  const tab = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [], events = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.route('https://fm.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/libraries/')) return route.fulfill({ contentType: 'text/javascript', body: await lib(url.pathname.slice(11)) });
    if (url.pathname === '/portal/') return route.fulfill({ contentType: 'text/html', body: page() });
    if (url.pathname.endsWith('/experiences')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, experiences: [setup], reveals: [], faqs: null }) });
    if (url.pathname.endsWith('/events')) events.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await tab.goto('https://fm.test/portal/');
  await tab.evaluate(() => { FirstMateGuides.play('documents.setup', { replay: true }); });
  await tab.waitForSelector('[data-gx-step="prices"] [data-start="estimate"]');
  return { tab, errors, events };
}
const choose = async (tab, selector, names) => {
  const [chooser] = await Promise.all([tab.waitForEvent('filechooser'), tab.click(selector)]);
  assert.equal(chooser.isMultiple(), true, 'several files at once');
  await chooser.setFiles(names.map(file));
};
const files = (tab) => tab.$$eval('[data-estimate]', (rows) => rows.map((row) => [row.querySelector('strong').textContent, row.dataset.state, row.querySelector('small').textContent]));
const settled = (tab) => tab.waitForFunction(() => !document.querySelector('[data-estimate][data-state=waiting],[data-estimate][data-state=reading]'));
const price = (tab, id) => tab.$eval(`[data-price="${id}"]`, (input) => input.value);
const on = (tab, name) => tab.$$eval('.gxd-line', (rows, wanted) => rows.find((row) => row.querySelector('strong').textContent === wanted)?.dataset.on, name);

test('the price step reads as many estimates as they upload, on a page of its own (GP-51)', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const { tab, errors, events } = await open(browser);
    const tile = await tab.textContent('[data-start="estimate"]');
    assert.match(tile, /Upload existing estimates/);
    assert.match(tile, /We’ll read through these to set up your prices\./);
    assert.doesNotMatch(tile, /before anything is saved/, 'the long hint is gone');

    // Four at once (it used to keep three): the page lists each, reading two at a time; Continue waits for them.
    await choose(tab, '[data-start="estimate"]', ['a.pdf', 'b.pdf', 'bad.pdf', 'c.pdf']);
    await tab.waitForSelector('.gxd-uploads [data-estimate]');
    assert.equal(await tab.isHidden('.gxs-foot'), true, 'the page has its own Back and Continue');
    assert.match(await tab.textContent('.gxd-uploads'), /The more estimates you upload, the better we can work out your prices\./);
    assert.equal(await tab.isDisabled('[data-uploads-done]'), true, 'nothing read yet');
    await settled(tab);
    assert.deepEqual(await files(tab), [['a.pdf', 'done', '2 priced lines'], ['b.pdf', 'done', '2 priced lines'], ['bad.pdf', 'failed', 'That one could not be read.'], ['c.pdf', 'done', '1 priced line']]);
    assert.deepEqual(await tab.evaluate(() => window.__reads), [['a.pdf'], ['b.pdf'], ['bad.pdf'], ['c.pdf']], 'one estimate per read');
    assert.equal(await tab.evaluate(() => window.__most), 2, 'two at a time');

    // More can be added, and one removed.
    await choose(tab, '[data-add-estimates]', ['d.png']);
    await settled(tab);
    await tab.click('[data-remove-estimate="estimate_3"]');
    assert.deepEqual((await files(tab)).map(([name]) => name), ['a.pdf', 'b.pdf', 'c.pdf', 'd.png']);
    assert.equal(await tab.isDisabled('[data-uploads-done]'), false);

    // Continue: every estimate in the lines at once, a line in several at the middle of its prices.
    await tab.click('[data-uploads-done]');
    await tab.waitForSelector('.gxd-banner');
    assert.equal(await tab.isVisible('.gxs-foot'), true, 'the sheet’s footer is back');
    const banner = await tab.textContent('.gxd-banner');
    assert.match(banner, /From 4 estimates: 2 lines matched your price book and 1 are new\./);
    assert.match(banner, /middle price/);
    assert.equal(await price(tab, 'tearoff'), '100', 'the middle of 90, 100 and 120');
    assert.equal(await price(tab, 'drip'), '3.5');
    assert.equal(await on(tab, 'Gutter guard'), 'true');
    assert.equal(await tab.$$eval('.gxd-line', (rows) => rows.find((row) => row.querySelector('strong').textContent === 'Gutter guard').querySelector('[data-price]').value), '8', 'the middle of 7 and 9');
    assert.equal(await on(tab, 'Ridge cap'), 'false', 'a line none of them has is off');

    // Back on the estimates page from the list: what was uploaded is still there, and nothing new leaves the lines as edited.
    await tab.fill('[data-price="tearoff"]', '105');
    assert.equal((await tab.textContent('[data-upload]')).trim(), 'Add more estimates');
    let picked = false;
    tab.once('filechooser', () => { picked = true; });
    await tab.click('[data-upload]');
    await tab.waitForSelector('.gxd-uploads');
    assert.equal(picked, false, 'no picker when there are estimates to show');
    assert.equal((await files(tab)).length, 4);
    await tab.click('[data-uploads-done]');
    await tab.waitForSelector('.gxd-banner');
    assert.equal(await price(tab, 'tearoff'), '105', 'the change since is kept');
    assert.equal(await tab.$$eval('.gxd-line', (rows) => rows.filter((row) => row.querySelector('strong').textContent === 'Gutter guard').length), 1, 'no line twice');

    // The page's Back goes to where it was opened from.
    await tab.click('[data-upload]');
    await tab.click('[data-uploads-back]');
    await tab.waitForSelector('.gxd-banner');

    await tab.click('[data-gxs=next]');
    await tab.waitForFunction(() => document.querySelector('[data-gx-step="presentation"]'));
    await tab.waitForTimeout(300);
    const answer = events.filter((event) => event.type === 'step_done' && event.step_id === 'prices').at(-1)?.selections;
    assert.deepEqual(answer.prices, [{ item_id: 'tearoff', unit_price: 105 }, { item_id: 'drip', unit_price: 3.5 }]);
    assert.deepEqual(answer.lines.on.slice(0, 2), ['tearoff', answer.lines.new_items[0].key]);
    assert.deepEqual(answer.lines.new_items.map((item) => [item.name, item.unit, item.unit_price]), [['Gutter guard', 'lf', 8]]);
    assert.deepEqual(errors, []);
    await tab.close();
  } finally { await browser.close(); }
});
