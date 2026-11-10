// The Operations tab on a phone: the rail's tabs gain Lists, and the lists are a carousel with a strip of their names.
// Desktop widths keep the rail and the lists side by side (no Lists tab, no strip, no carousel).
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
const helper = await readFile(new URL('../../libraries/apps/materials/scope-of-work.js', import.meta.url), 'utf8');
const start = source.indexOf('  // Phones (the project window');
const end = source.indexOf('  // Taking work off a work order', start);
assert.ok(start > 0 && end > start, 'the phone block is found');
const block = source.slice(start, end);
const cssStart = source.indexOf('/* Phones: the Operations tab'), cssEnd = source.indexOf('\n    `;', cssStart);
assert.ok(cssStart > 0 && cssEnd > cssStart, 'the phone styles are found');
const phoneCss = source.slice(cssStart, cssEnd);
// The lists' own scrollers, as every width styles them: what they allow decides whether a sideways drag reaches the carousel.
const scrollerCss = ['.mt-resource-scroll{', '.mt-resource-column .mt-resource-scroll{', '.mt-req-tray{', '.mt-req-panel{', '.mt-req-panel-inner{', '.mt-req-scroll{'].map((rule) => {
  const at = source.indexOf(`      ${rule}`);
  assert.ok(at > 0, `${rule} is styled`);
  return source.slice(at, source.indexOf('}', at) + 1).trim();
}).join('\n');

const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">
<div class="mt-app" data-materials-root style="height:600px;display:flex;flex-direction:column"><main class="mt-main" style="flex:1;min-height:0;display:flex;flex-direction:column">
<div class="mt-material-scroll" data-mt-material-scroll style="flex:1;min-height:0"><div class="mt-material-grid" data-mt-material-grid style="display:flex;height:100%">
<section class="mt-resource-column" data-resource-type="material"><h3 class="mt-resource-heading"><input value="Materials"></h3><div class="mt-resource-scroll" style="height:300px;overflow:auto"><div style="height:1200px">rows</div></div></section>
<button type="button" class="mt-column-divider"></button>
<section class="mt-resource-column" data-resource-type="labor"><h3 class="mt-resource-heading"><span class="mt-column-title">Work order</span></h3></section>
<aside class="mt-req-tray" data-mt-req-tray><button class="mt-req-bar"></button><div class="mt-req-panel"><div class="mt-req-panel-inner"><header class="mt-req-title"><strong>Requirements</strong><span class="mt-req-badge is-open">3</span></header><div class="mt-req-scroll"><div style="height:1200px">requirement rows</div></div></div></div></aside>
</div></div></main></div>
<script>
  const state = { active: false }, rootWindow = window, draftText = (key, fallback) => fallback;
  const cleanText = (v) => String(v ?? '').trim(), escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let project = 'p1';
  const orgId = () => 'org', projectId = () => project, materialRoot = () => document.querySelector('[data-materials-root]');
  const resourceCategories = () => [{ id: 'material', name: 'Materials', icon: 'fa-boxes-stacked', color: '#d92d20' }, { id: 'labor', name: 'Labor', icon: 'fa-helmet-safety', color: '#175cd3' }];
  const leftContentRoot = () => null, syncMaterialsGrid = () => false, scopeWorkspace = null;
  ${block.replace(/<\/script/g, '<\\/script')}
  const style = document.createElement('style'); style.textContent = ${JSON.stringify(`${scrollerCss}\n${phoneCss}`)}; document.head.append(style);
  window.t = { state, syncPhoneLists, goPhoneList, phoneListsView, setProject: (id) => { project = id; } };
</script></body></html>`;

test('a phone shows the lists as a carousel: one at a time, a strip of names, swipes and taps move between them', async () => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true });
    const tab = await context.newPage();
    const errors = []; tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    const current = () => tab.evaluate(() => document.querySelector('[data-mt-carousel-to][aria-current="true"]')?.textContent.trim());
    const view = await tab.evaluate(() => {
      t.phoneListsView.setVisible(true); t.syncPhoneLists();
      const items = [...document.querySelectorAll('[data-mt-phone-item]')];
      return { pills: [...document.querySelectorAll('[data-mt-carousel-to]')].map((pill) => pill.textContent.trim()), inert: items.map((el) => el.inert), widths: items.map((el) => Math.round(el.getBoundingClientRect().width)), grid: Math.round(document.querySelector('[data-mt-material-grid]').getBoundingClientRect().width), label: t.phoneListsView.label };
    });
    assert.deepEqual(view.pills, ['Materials', 'Work order', 'Requirements3'], 'every list and the requirements are in the strip');
    assert.deepEqual(view.inert, [false, true, true], 'only the list on screen can take focus');
    assert.ok(view.widths.every((width) => width === view.grid), `each list fills the width: ${view.widths} of ${view.grid}`);
    assert.equal(view.label, 'Lists');
    // The strip starts at its first pill, with no half-screen inset. Pills that fit sit centred with no fade; pills that
    // don't start at the left edge and fade only on the side with more to scroll to.
    const stripAt = async (width) => {
      await tab.setViewportSize({ width, height: 700 });
      return tab.evaluate(() => {
        t.goPhoneList(document.querySelector('[data-materials-root]'), 0);
        const strip = document.querySelector('[data-mt-phone-strip]'), box = strip.getBoundingClientRect(), style = getComputedStyle(strip);
        const first = strip.firstElementChild.getBoundingClientRect(), last = strip.lastElementChild.getBoundingClientRect();
        return { scrolls: strip.scrollWidth > strip.clientWidth, before: Math.round(first.left - box.left), after: Math.round(box.right - last.right), faded: (style.maskImage || style.webkitMaskImage) !== 'none', fadeBefore: strip.classList.contains('is-more-before'), fadeAfter: strip.classList.contains('is-more-after') };
      });
    };
    const narrow = await stripAt(260);
    assert.ok(narrow.scrolls && narrow.before <= 12, `a crowded strip starts at its first pill: ${JSON.stringify(narrow)}`);
    assert.deepEqual([narrow.faded, narrow.fadeBefore, narrow.fadeAfter], [true, false, true], 'only the side with more fades');
    await tab.evaluate(() => t.goPhoneList(document.querySelector('[data-materials-root]'), 2)); await tab.waitForTimeout(450);
    const end = await tab.evaluate(() => { const strip = document.querySelector('[data-mt-phone-strip]'), box = strip.getBoundingClientRect(), last = strip.lastElementChild.getBoundingClientRect(); return { inView: last.right <= box.right + 1 && last.left >= box.left, fadeBefore: strip.classList.contains('is-more-before'), fadeAfter: strip.classList.contains('is-more-after') }; });
    assert.deepEqual(end, { inView: true, fadeBefore: true, fadeAfter: false }, 'the last pill scrolls fully into view');
    const roomy = await stripAt(700);
    assert.ok(!roomy.scrolls && !roomy.faded && Math.abs(roomy.before - roomy.after) <= 2, `pills that fit are centred, with no scroll or fade: ${JSON.stringify(roomy)}`);
    await tab.setViewportSize({ width: 390, height: 700 });
    await tab.evaluate(() => t.goPhoneList(document.querySelector('[data-materials-root]'), 0));
    // Tapping a name jumps to it.
    await tab.locator('[data-mt-carousel-to="2"]').click(); await tab.waitForTimeout(450);
    assert.equal(await current(), 'Requirements3');
    const offset = await tab.evaluate(() => Math.round(document.querySelector('[data-mt-req-tray]').getBoundingClientRect().left - document.querySelector('[data-mt-material-scroll]').getBoundingClientRect().left));
    assert.ok(Math.abs(offset) <= 12, `the requirements slide into view (${offset})`);
    // A sideways swipe rolls to the neighbour; an upward drag does not change list.
    const cdp = await context.newCDPSession(tab);
    const swipe = async (x0, y0, dx, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let step = 1; step <= 10; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * step / 10, y: y0 + dy * step / 10 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await tab.waitForTimeout(500);
    };
    // Swiping back from the requirements starts over their own scrolling list (FM-372: it used to start, then snap back).
    await swipe(120, 300, 200, 4);
    assert.equal(await current(), 'Work order', 'swiping right goes back one list');
    await swipe(300, 200, -200, 4);
    assert.equal(await current(), 'Requirements3', 'swiping left goes forward one list');
    await swipe(300, 200, -200, 4);
    assert.equal(await current(), 'Requirements3', 'the last list stays put');
    await tab.locator('[data-mt-carousel-to="0"]').click(); await tab.waitForTimeout(450);
    await swipe(200, 400, 3, -200);
    assert.equal(await current(), 'Materials', 'a vertical drag scrolls the list, it does not change list');
    // The list is remembered per project for the session.
    await tab.locator('[data-mt-carousel-to="1"]').click();
    const remembered = await tab.evaluate(() => { t.setProject('p2'); t.syncPhoneLists(); const other = document.querySelector('[data-mt-carousel-to][aria-current="true"]').textContent.trim(); t.setProject('p1'); t.syncPhoneLists(); return { other, back: document.querySelector('[data-mt-carousel-to][aria-current="true"]').textContent.trim() }; });
    assert.deepEqual(remembered, { other: 'Materials', back: 'Work order' });
    // At a desktop width nothing of this remains.
    await tab.setViewportSize({ width: 1200, height: 700 });
    const desktop = await tab.evaluate(() => { t.syncPhoneLists(); return { strip: !!document.querySelector('[data-mt-phone-strip]'), phone: document.querySelector('[data-materials-root]').classList.contains('mt-phone-lists'), inert: [...document.querySelectorAll('.mt-resource-column,[data-mt-req-tray]')].some((el) => el.inert || el.hasAttribute('aria-hidden')), transform: getComputedStyle(document.querySelector('[data-mt-material-grid]')).transform }; });
    assert.deepEqual(desktop, { strip: false, phone: false, inert: false, transform: 'none' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('the rail offers Lists only when the host passes it, before Schedule, and restores a phone view per project', async () => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url.includes('helper') ? 'text/javascript' : 'text/html'); res.end(req.url.includes('helper') ? helper : '<html><head></head><body><aside></aside></body></html>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const tab = await browser.newPage(); const errors = []; tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await tab.evaluate(async () => {
      const helper = await import('/helper.js'), root = document.querySelector('aside');
      window.FirstMateWidgets = { mount: () => ({ setVisible() {}, destroy() {} }) };
      const shown = [];
      const listsView = { label: 'Lists', icon: 'fa-layer-group', phone: () => true, setVisible: (value) => shown.push(value) };
      const tabs = () => [...root.querySelectorAll('[data-scope-view]')].map((button) => button.dataset.scopeView);
      helper.mountSidebar(root, [], '', 'org:a', { scheduling: true, listsView });
      const order = tabs();
      helper.showSidebarView(root, 'lists');
      const lists = { attribute: root.dataset.scopeShown, shown: shown.at(-1), panels: [...root.querySelectorAll('[data-scope-panel]')].filter((panel) => !panel.hidden).length };
      helper.mountSidebar(root, [], '', 'org:b', { scheduling: true, listsView });
      const other = root.dataset.scopeShown;
      helper.mountSidebar(root, [], '', 'org:a', { scheduling: true, listsView });
      const back = root.dataset.scopeShown;
      helper.mountSidebar(root, [], '', 'org:a', { scheduling: false });
      return { order, lists, other, back, without: tabs() };
    });
    assert.deepEqual(result.order, ['roof', 'documents', 'aerial', 'lists', 'schedule']);
    assert.deepEqual(result.lists, { attribute: 'lists', shown: true, panels: 0 }, 'the rail keeps only its tabs while the host shows the lists');
    assert.equal(result.other, 'roof', 'another project starts on Measurements');
    assert.equal(result.back, 'lists', 'coming back to a project on a phone shows the view it was on');
    assert.deepEqual(result.without, ['roof', 'documents', 'aerial'], 'no Lists tab without the host');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
