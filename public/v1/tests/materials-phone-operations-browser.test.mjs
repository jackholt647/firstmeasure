// The Operations tab on a phone is its lists alone: no rail and no set of tabs (Measurements, Docs, Photos and Schedule
// are the project window's own tabs), the lists a carousel with a strip of their names. Desktop widths keep the rail
// and the lists side by side (no strip, no carousel).
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
<div class="r-overlay materials-workspace"><div class="r-tab-layout" style="display:flex"><aside class="r-tab-sidebar mt-widget-sidebar" style="display:flex">rail</aside><button type="button" class="mt-scope-divider" style="width:6px"></button><div class="r-tab-main" style="flex:1;min-width:0">
<div class="mt-app" data-materials-root style="height:600px;display:flex;flex-direction:column"><main class="mt-main" style="flex:1;min-height:0;display:flex;flex-direction:column">
<div class="mt-material-scroll" data-mt-material-scroll style="flex:1;min-height:0"><div class="mt-material-grid" data-mt-material-grid style="display:flex;height:100%">
<section class="mt-resource-column" data-resource-type="material"><h3 class="mt-resource-heading"><input value="Materials"></h3><div class="mt-resource-scroll" style="height:300px;overflow:auto"><div style="height:1200px">rows</div></div></section>
<button type="button" class="mt-column-divider"></button>
<section class="mt-resource-column" data-resource-type="labor"><h3 class="mt-resource-heading"><span class="mt-column-title">Work order</span></h3></section>
<aside class="mt-req-tray" data-mt-req-tray><button class="mt-req-bar"></button><div class="mt-req-panel"><div class="mt-req-panel-inner"><header class="mt-req-title"><strong>Requirements</strong><span class="mt-req-badge is-open">3</span></header><div class="mt-req-scroll"><div style="height:1200px">requirement rows</div></div></div></div></aside>
</div></div></main></div>
</div></div></div>
<script>
  const state = { active: false }, rootWindow = window, draftText = (key, fallback) => fallback;
  const cleanText = (v) => String(v ?? '').trim(), escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  let project = 'p1';
  const orgId = () => 'org', projectId = () => project, materialRoot = () => document.querySelector('[data-materials-root]');
  const resourceCategories = () => [{ id: 'material', name: 'Materials', icon: 'fa-boxes-stacked', color: '#d92d20' }, { id: 'labor', name: 'Labor', icon: 'fa-helmet-safety', color: '#175cd3' }];
  const leftContentRoot = () => null, syncMaterialsGrid = () => false, scopeWorkspace = null;
  ${block.replace(/<\/script/g, '<\\/script')}
  const style = document.createElement('style'); style.textContent = ${JSON.stringify(`${scrollerCss}\n${phoneCss}`)}; document.head.append(style);
  window.t = { state, syncPhoneLists, goPhoneList, setProject: (id) => { project = id; } };
</script></body></html>`;

test('a phone shows the lists alone, as a carousel: one at a time, a strip of names, swipes and taps move between them', async () => {
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
      t.syncPhoneLists();
      const items = [...document.querySelectorAll('[data-mt-phone-item]')], shown = (selector) => getComputedStyle(document.querySelector(selector)).display !== 'none';
      return { pills: [...document.querySelectorAll('[data-mt-carousel-to]')].map((pill) => pill.textContent.trim()), inert: items.map((el) => el.inert), widths: items.map((el) => Math.round(el.getBoundingClientRect().width)), grid: Math.round(document.querySelector('[data-mt-material-grid]').getBoundingClientRect().width), rail: shown('.r-tab-sidebar'), divider: shown('.mt-scope-divider'), main: Math.round(document.querySelector('.r-tab-main').getBoundingClientRect().width) };
    });
    assert.deepEqual(view.pills, ['Materials', 'Work order', 'Requirements3'], 'every list and the requirements are in the strip');
    assert.deepEqual(view.inert, [false, true, true], 'only the list on screen can take focus');
    assert.ok(view.widths.every((width) => width === view.grid), `each list fills the width: ${view.widths} of ${view.grid}`);
    assert.deepEqual([view.rail, view.divider, view.main], [false, false, 390], 'no rail: the lists fill the tab');
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
    const desktop = await tab.evaluate(() => { t.syncPhoneLists(); return { strip: !!document.querySelector('[data-mt-phone-strip]'), phone: document.querySelector('[data-materials-root]').classList.contains('mt-phone-lists'), inert: [...document.querySelectorAll('.mt-resource-column,[data-mt-req-tray]')].some((el) => el.inert || el.hasAttribute('aria-hidden')), transform: getComputedStyle(document.querySelector('[data-mt-material-grid]')).transform, rail: getComputedStyle(document.querySelector('.r-tab-sidebar')).display }; });
    assert.deepEqual(desktop, { strip: false, phone: false, inert: false, transform: 'none', rail: 'flex' });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

test('the rail has no Lists view: Measurements, Documents, Photos and Schedule (when scheduling is on)', async () => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url.includes('helper') ? 'text/javascript' : 'text/html'); res.end(req.url.includes('helper') ? helper : '<html><head></head><body><aside></aside></body></html>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const tab = await browser.newPage(); const errors = []; tab.on('pageerror', (error) => errors.push(error.message));
    await tab.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await tab.evaluate(async () => {
      const helper = await import('/helper.js'), root = document.querySelector('aside');
      window.FirstMateWidgets = { mount: () => ({ setVisible() {}, destroy() {} }) };
      const tabs = () => [...root.querySelectorAll('[data-scope-view]')].map((button) => button.dataset.scopeView);
      helper.mountSidebar(root, [], '', 'org:a', { scheduling: true, listsView: { label: 'Lists', phone: () => true, setVisible() {} } });
      const order = tabs(), lists = helper.showSidebarView(root, 'lists');
      helper.mountSidebar(root, [], '', 'org:a', { scheduling: false });
      return { order, lists, without: tabs() };
    });
    assert.deepEqual(result.order, ['roof', 'documents', 'aerial', 'schedule']);
    assert.equal(result.lists, false, 'there is no Lists view to show');
    assert.deepEqual(result.without, ['roof', 'documents', 'aerial']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});

// The pieces of the Operations tab outside the phone block: on a phone the rail is never mounted, the lists' Schedule
// buttons go to the project window's Schedule tab, and coming back to the tab keeps the loaded lists.
test('on a phone the rail is not mounted, scheduling opens the Schedule tab, and a return does not reload the lists', () => {
  const renderLeft = source.slice(source.indexOf('  function renderLeft(){'), source.indexOf('  function renderRailState('));
  assert.ok(renderLeft.indexOf('if (phoneLayout())') > 0 && renderLeft.indexOf('if (phoneLayout())') < renderLeft.indexOf('mountSidebar('), 'renderLeft leaves the rail out on a phone before mounting it');
  const beside = source.slice(source.indexOf('  function showScheduleBesideLists(){'), source.indexOf('  function makeRoomForSchedule(){'));
  assert.match(beside, /if \(phoneLayout\(\)\) return;/);
  assert.doesNotMatch(source.replace(beside, ''), /showSidebarView\?\.\(leftContentRoot\(\), 'schedule'\)/, 'every Schedule button goes through showScheduleBesideLists');
  const setActive = source.slice(source.indexOf('  function setActive(active){'), source.indexOf('  function reset(){', source.indexOf('  function setActive(active){')));
  assert.match(setActive, /if \(listsLoadedHere\(\)\) void refreshWorkspace\(\);\s*else if \(!state\.loading\) loadData\(\);/);
  assert.doesNotMatch(source, /listsView/);
});

// FM-439: on a phone the workspace header fits one row: the projected total is just the figure, and Category, Schedule
// and Closeout are icons that keep their aria-label and tooltip. Desktop keeps every label. A scheduled job shows a
// calendar with a check, not a bare check.
test('on a phone the workspace header is the total and icons; desktop keeps the labels', async () => {
  const header = source.slice(source.indexOf('<header class="mt-workspace-header">'), source.indexOf('</header>`;', source.indexOf('<header class="mt-workspace-header">')));
  assert.match(header, /data-mt-new-category [^>]*aria-label="New category"><i class="fas fa-plus" aria-hidden="true"><\/i><span>Category<\/span><\/button>/, 'Category is an icon and a label the phone can hide');
  const schedule = source.slice(source.indexOf('  function scheduleJobButton(){'), source.indexOf('  function startPlacing('));
  assert.match(schedule, /aria-label="\$\{done \? 'Scheduled' : 'Schedule this job'\}"/, 'the Schedule button names itself without its text');
  assert.match(schedule, /done \? 'fa-calendar-check'/, 'a scheduled job shows a calendar with a check');
  assert.doesNotMatch(schedule, /'fa-check'/);
  const rule = (prefix) => { const at = source.indexOf(`      ${prefix}`); assert.ok(at > 0, `${prefix} is styled`); return source.slice(at, source.indexOf('\n', at)).trim(); };
  const css = [rule('.mt-workspace-header{'), rule('.mt-projected-total{'), rule('.mt-workspace-actions .mt-schedule-job{'), rule('.mt-workspace-actions .mt-closeout{'), phoneCss].join('\n');
  const markup = (phone) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0"><div class="mt-app${phone ? ' mt-phone-lists' : ''}">
    <header class="mt-workspace-header"><div class="mt-projected-total"><span>Projected total</span><strong>$12,345.67</strong></div><div class="mt-collapsed-pills"></div><div class="mt-workspace-actions">
    <button type="button" data-mt-new-category aria-label="New category"><i class="fas fa-plus" aria-hidden="true"></i><span>Category</span></button>
    <button type="button" class="mt-schedule-job is-done" data-mt-schedule-job aria-label="Scheduled"><i class="fas fa-calendar-check" aria-hidden="true"></i><span>Scheduled</span></button>
    <button type="button" class="mt-closeout" data-mt-closeout aria-label="Close out project"><i class="fas fa-flag-checkered" aria-hidden="true"></i><span>Closeout</span></button>
    </div></header></div></body></html>`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const read = async (width, phone) => {
      const tab = await browser.newPage({ viewport: { width, height: 400 } });
      await tab.setContent(markup(phone));
      return tab.evaluate(() => {
        const shown = (el) => getComputedStyle(el).display !== 'none';
        return { label: shown(document.querySelector('.mt-projected-total span')), total: shown(document.querySelector('.mt-projected-total strong')), texts: [...document.querySelectorAll('.mt-workspace-actions button>span')].map(shown), widths: [...document.querySelectorAll('.mt-workspace-actions button')].map((b) => Math.round(b.getBoundingClientRect().width)) };
      });
    };
    const phone = await read(433, true);
    assert.deepEqual([phone.label, phone.total, phone.texts], [false, true, [false, false, false]], 'a phone shows the figure and the icons alone');
    assert.ok(phone.widths.every((width) => width <= 40), `the icon buttons are square: ${phone.widths}`);
    const desktop = await read(1200, false);
    assert.deepEqual([desktop.label, desktop.total, desktop.texts], [true, true, [true, true, true]], 'desktop keeps every label');
  } finally { await browser.close(); }
});

// FM-436: on a phone the quick price book is a full-screen modal on a dimmed page, with a header of its title, list and
// two square buttons; typing a search refills it without reopening it, and Esc closes it, not the project window under it.
// Wider screens keep the panel floating over the lists.
test('on a phone the price book is a full-screen modal that Esc closes; desktop keeps the floating panel', async () => {
  const fn = (name) => { const at = source.indexOf(`  function ${name}(`); assert.ok(at > 0, `${name} is found`); return source.slice(at, source.indexOf('\n  }\n', at) + 4); };
  const modalAt = source.indexOf('  let pricebookModal = null;');
  assert.ok(modalAt > 0, 'the price book modal is found');
  const code = [fn('renderPricebookPanel'), fn('syncPricebookPanel'), source.slice(modalAt, source.indexOf('\n  }\n', modalAt) + 4)].join('\n');
  const rule = (prefix) => { const at = source.indexOf(`      ${prefix}`); assert.ok(at > 0, `${prefix} is styled`); return source.slice(at, source.indexOf('\n', at)).trim(); };
  const css = [rule('.mt-btn,.mt-icon-btn{'), rule('.mt-btn{padding'), rule('.mt-search{'), rule('.mt-pricebook-panel{'), rule('.mt-pricebook-head{'), rule('.mt-suggest-list{'), rule('.mt-suggest{'), rule('.mt-suggest strong{'), rule('@media (max-width:620px){.mt-top'), phoneCss].join('\n');
  const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0">
<div class="mt-app" data-materials-root style="container-type:inline-size;height:420px;margin-top:90px"><main class="mt-main" style="position:relative;height:100%"><button type="button" data-mt-open-pricebook data-mt-list-id="l1" aria-pressed="false">Price book</button></main></div>
<script>
  const rootWindow = window, state = { pricebookOpen: false, pricebookListId: 'l1', pricebookSearch: '', activeList: { id: 'l1', resource_type: 'material' } };
  const cleanText = (v) => String(v ?? '').trim(), escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const money = (v) => '$' + v, resourceType = (list) => list?.resource_type, materialListById = () => ({ title: 'Roof materials' }), materialRoot = () => document.querySelector('[data-materials-root]');
  const phoneLayout = () => matchMedia('(max-width:760px)').matches;
  const items = [{ id: 'i1', name: 'Architectural Shingles', category: 'Shingles', unitPrice: 365, unit: 'sq' }, { id: 'i2', name: 'Ridge Cap', category: 'Shingles', unitPrice: 80, unit: 'bundle' }];
  const suggestedItems = () => items.filter((item) => item.name.toLowerCase().includes(state.pricebookSearch.toLowerCase()));
  const bindMain = (root) => {
    root.querySelector('[data-mt-close-pricebook]')?.addEventListener('click', () => { state.pricebookOpen = false; syncPricebookPanel(); });
    root.querySelector('[data-mt-pricebook-search]')?.addEventListener('input', (event) => { state.pricebookSearch = event.target.value; syncPricebookPanel(); });
  };
  // The portal's modal stack, as core.js runs it: Esc closes the top entry, or else the project window.
  const stack = []; window.projectClosed = false;
  window.Portal = { modals: { register: (el, options) => { const entry = { el, options }; stack.push(entry); return { el, unregister: () => { const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1); } }; } } };
  document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; const entry = stack.pop(); if (entry) entry.options.onClose('escape'); else window.projectClosed = true; event.preventDefault(); }, true);
  ${code.replace(/<\/script/g, '<\\/script')}
  window.t = { state, open: () => { state.pricebookOpen = true; syncPricebookPanel(); }, stack };
</script></body></html>`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // Reduced motion: the sheet is measured where it lands, not while it slides in.
    const tab = await browser.newPage({ viewport: { width: 433, height: 582 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const errors = []; tab.on('pageerror', (error) => errors.push(error.message));
    await tab.setContent(page);
    const read = () => tab.evaluate(() => {
      const panel = document.querySelector('[data-mt-pricebook-panel]');
      if (!panel) return null;
      const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
      return { tag: panel.tagName, modal: panel.matches(':modal'), box: box(panel), backdrop: getComputedStyle(panel, '::backdrop').backgroundColor, title: panel.querySelector('.mt-pricebook-title').textContent.trim(), tools: [...panel.querySelectorAll('.mt-pricebook-tools .mt-icon-btn')].map(box), head: box(panel.querySelector('.mt-pricebook-head')), rows: panel.querySelectorAll('.mt-suggest').length, focus: document.activeElement?.matches('[data-mt-pricebook-search]'), pressed: document.querySelector('[data-mt-open-pricebook]').getAttribute('aria-pressed') };
    });
    await tab.evaluate(() => t.open());
    const phone = await read();
    assert.deepEqual([phone.tag, phone.modal, phone.box], ['DIALOG', true, [0, 0, 433, 582]], `a phone opens a full-screen modal: ${JSON.stringify(phone)}`);
    assert.equal(phone.backdrop, 'rgba(15, 23, 42, 0.48)', 'the page behind is dimmed');
    assert.equal(phone.title, 'Price BookRoof materials', 'the header names the price book and the list');
    assert.ok(phone.tools.every(([, top, width, height]) => width <= 44 && height <= 44 && top >= phone.head[1] && top + height <= phone.head[1] + phone.head[3]), `the header's buttons are square and in the header: ${JSON.stringify(phone.tools)}`);
    assert.equal(phone.pressed, 'true');
    const panel = await tab.$('[data-mt-pricebook-panel]');
    await tab.locator('[data-mt-pricebook-search]').tap();
    await tab.keyboard.type('ridge');
    const searched = await read();
    assert.ok(await panel.evaluate((el) => el.isConnected && el.open), 'a search refills the same modal');
    assert.deepEqual([searched.modal, searched.rows, searched.focus], [true, 1, true]);
    await tab.keyboard.press('Escape');
    assert.deepEqual(await tab.evaluate(() => ({ panel: !!document.querySelector('[data-mt-pricebook-panel]'), open: t.state.pricebookOpen, project: window.projectClosed, stack: t.stack.length, pressed: document.querySelector('[data-mt-open-pricebook]').getAttribute('aria-pressed') })), { panel: false, open: false, project: false, stack: 0, pressed: 'false' }, 'Esc closes the price book and leaves the project window open');
    await tab.evaluate(() => t.open());
    await tab.locator('[data-mt-close-pricebook]').tap();
    assert.deepEqual(await tab.evaluate(() => ({ panel: !!document.querySelector('[data-mt-pricebook-panel]'), stack: t.stack.length })), { panel: false, stack: 0 }, 'Close takes it off the modal stack');
    await tab.setViewportSize({ width: 1200, height: 700 });
    await tab.evaluate(() => t.open());
    const desktop = await read();
    assert.ok(desktop.tag === 'DIV' && !desktop.modal && desktop.box[2] <= 392, `desktop keeps the floating panel: ${JSON.stringify(desktop)}`);
    assert.equal(await tab.evaluate(() => t.stack.length), 0, 'the floating panel is not a modal');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
