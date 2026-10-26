// The portal shell on phones: the top bar shows the open app's icon and title,
// the More (⋯) sheet groups every top bar action with large tap targets, and
// phone and desktop offer the same actions (docs/architecture/app-experience.md,
// "The mobile top bar").
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const read = (relative) => readFile(path.join(publicRoot, relative), 'utf8');
const [core, index] = await Promise.all([read('portal/scripts/core.js'), read('portal/index.php')]);
const between = (text, start, end) => {
  const i = text.indexOf(start), j = text.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `missing ${start}`);
  return text.slice(i, j);
};
const mobileHeader = between(core.replace(/\r\n/g, '\n'), '  // --- Mobile header ---', '  function defaultPortalTab(');
const indexStyles = [...index.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
const mobileTopbar = between(index, '<div class="mobile-topbar">', '<!-- ====== SIDEBAR BACKDROP');
const desktopTopbar = between(index, '<div class="platform-topbar" id="platformTopbar">', '<div class="main-panels" id="mainPanels">');
const shots = process.env.MOBILE_SHELL_SCREENSHOTS || '';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${indexStyles}</style></head><body>
${mobileTopbar}
<main class="main">${desktopTopbar}<div class="main-panels" id="mainPanels"><div class="fm-tabpanel active" style="height:900px">Content</div></div></main>
<script>
  window.flags = { 'topbar.todos': false };
  window.assistantToggles = 0;
  window.__APP = { orgId:'org', userOrgId:'org', userId:'user' };
  window.Portal = {
    cfg: window.__APP,
    util: { escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])) },
    can: (key) => window.flags[key] ?? true,
    capabilities: { can: () => true },
    branchModules: { currentBranchId: () => 'default' }
  };
  window.PlatformAPI = {
    appFlags: { current: () => ({}), has: (group, flag) => group === 'platform' && flag === 'top_bar', load: async () => ({}) },
    actionItems: { list: async () => ({ items: [{ id:'t1', title:'Call Jane', kind:'manual', status:'open', assigned_user_ids:['user'] }] }) },
    work: { configuration: async () => ({}) }
  };
  window.ChannelsAPI = { readState: { inbox: async () => ({ entries: [{ entry_id:'e1', unread:true, count:3, title:'Jane', text:'Hi' }] }) } };
  window.PlatformAssistant = { toggle(){ window.assistantToggles += 1; } };
</script>
<script>
  const cleanText = (...values) => { for (const value of values) { if (value && typeof value === 'object') continue; const text = String(value ?? '').trim(); if (text) return text; } return ''; };
  const terminologyLabel = (key, fallback) => (key === 'projects.portal_tab' ? 'Jobs' : String(fallback || '').trim());
  const TabRegistry = { tabs: new Map([
    ['viewer', { id:'viewer', appId:'portal.viewer', title:'My Projects', terminologyKey:'', icon:'fa-folder-open' }],
    ['crm', { id:'crm', appId:'portal.crm', title:'CRM', terminologyKey:'', icon:'fa-filter' }],
    ['bare', { id:'bare', appId:'portal.bare', title:'Bare', terminologyKey:'', icon:'fa-circle' }]
  ]) };
${mobileHeader}
  window.showTab = (id) => updateMobileTabTitle(TabRegistry.tabs.get(id));
</script>
<script src="/portal/scripts/topbar.js"></script>
<script src="/libraries/window-manager/window-manager.js"></script>
<script src="/libraries/window-manager/window-shell.js"></script>
<script src="/libraries/platform-action-items/platform-action-items.js"></script>
<script src="/libraries/platform-action-items/todo-tray.js"></script>
</body></html>`;

async function openShell(browser, viewport, mobile = true){
  const context = await browser.newContext({ viewport, ...(mobile ? { userAgent: MOBILE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://shell.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: harness });
    return route.fulfill({ contentType: 'application/javascript', body: await read(url.pathname.slice(1)) });
  });
  await page.goto('https://shell.test/');
  await page.waitForFunction(() => document.querySelector('.mobile-topbar')?.classList.contains('topbar-enabled'));
  await page.evaluate(() => window.showTab('viewer'));
  return { context, page, errors };
}

// The actions the desktop top bar offers right now, by name.
const desktopActions = (page) => page.evaluate(() => [...document.querySelectorAll('#platformTopbar .ptb-bell')]
  .filter((button) => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden')
  .map((button) => button.getAttribute('aria-label') || button.dataset.fmTooltip).sort());
const sheetActions = (page) => page.evaluate(() => [...document.querySelectorAll('#mobilePlatformMoreMenu .ptb-more-item')]
  .filter((item) => getComputedStyle(item).display !== 'none')
  .map((item) => item.querySelector('span').textContent.trim()).sort());

const launch = () => chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

test('the phone top bar shows the open app icon and title, and apps can change them', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openShell(browser, { width: 390, height: 844 });
    const heading = () => page.evaluate(() => ({
      ...window.Portal.mobileHeader.current(),
      iconVisible: getComputedStyle(document.getElementById('mobTabIcon')).display !== 'none',
      actions: document.getElementById('mobTabActions').hidden ? 0 : document.getElementById('mobTabActions').childElementCount
    }));
    assert.deepEqual(await heading(), { tabId: 'viewer', title: 'My Projects', icon: 'fa-folder-open', iconVisible: true, actions: 0 });
    const iconBox = await page.locator('#mobTabIcon').boundingBox();
    const titleBox = await page.locator('#mobTabTitle').boundingBox();
    assert.ok(iconBox.width >= 24 && iconBox.x + iconBox.width <= titleBox.x, 'icon sits before the title');
    assert.ok(Math.abs((iconBox.y + iconBox.height / 2) - (titleBox.y + titleBox.height / 2)) < 3, 'icon and title share a line');
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'header-390.png'), clip: { x: 0, y: 0, width: 390, height: 120 } }); }

    // The registry's placeholder icon is not shown.
    await page.evaluate(() => window.showTab('bare'));
    assert.deepEqual(await heading(), { tabId: 'bare', title: 'Bare', icon: '', iconVisible: false, actions: 0 });

    // An app overrides its own header by app or tab id; others are untouched.
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('aria-label', 'Filter'); button.innerHTML = '<i class="fas fa-sliders"></i>';
      window.Portal.mobileHeader.set('portal.crm', { title: 'Pipeline', icon: 'fa-chart-line', actions: button });
      window.showTab('crm');
    });
    assert.deepEqual(await heading(), { tabId: 'crm', title: 'Pipeline', icon: 'fa-chart-line', iconVisible: true, actions: 1 });
    assert.equal(await page.getByRole('button', { name: 'Filter' }).isVisible(), true);
    await page.evaluate(() => window.showTab('viewer'));
    assert.deepEqual(await heading(), { tabId: 'viewer', title: 'My Projects', icon: 'fa-folder-open', iconVisible: true, actions: 0 });
    await page.evaluate(() => { window.showTab('crm'); window.Portal.mobileHeader.clear('crm'); });
    assert.deepEqual(await heading(), { tabId: 'crm', title: 'CRM', icon: 'fa-filter', iconVisible: true, actions: 0 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('the More sheet is a grouped bottom sheet with large targets that opens and closes with motion', async () => {
  const browser = await launch();
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
      const { context, page, errors } = await openShell(browser, viewport);
      // A script that adds its own item lands in the tools group.
      await page.evaluate(() => {
        const item = document.createElement('button');
        item.type = 'button'; item.className = 'ptb-more-item'; item.dataset.devMobile = '';
        item.innerHTML = '<i class="fas fa-code"></i><span>Development tools</span>';
        document.getElementById('mobilePlatformMoreMenu').prepend(item);
      });
      await page.getByRole('button', { name: 'More' }).click();
      const sheet = page.locator('#mobilePlatformMoreMenu .ptb-sheet');
      await page.waitForFunction(() => { const r = document.querySelector('.ptb-sheet').getBoundingClientRect(); return Math.abs(r.bottom - innerHeight) < 1; });
      assert.equal(await page.getByRole('button', { name: 'More' }).getAttribute('aria-expanded'), 'true');
      assert.equal(await page.evaluate(() => document.getElementById('mobilePlatformMoreMenu').matches(':popover-open')), true, 'the sheet is in the top layer');
      const box = await sheet.boundingBox();
      assert.ok(box.x === 0 && Math.round(box.width) === viewport.width, JSON.stringify(box));
      const groups = await page.evaluate(() => [...document.querySelectorAll('#mobilePlatformMoreMenu [data-more-group]')]
        .filter((group) => getComputedStyle(group).display !== 'none')
        .map((group) => [...group.querySelectorAll('.ptb-more-item')].filter((item) => getComputedStyle(item).display !== 'none').map((item) => item.querySelector('span').textContent.trim())));
      assert.deepEqual(groups, [['AI Assistant'], ['Messages', 'Notifications'], ['Development tools']]);
      for (const item of await page.locator('#mobilePlatformMoreMenu .ptb-more-item:visible').all()) {
        const rect = await item.boundingBox();
        assert.ok(rect.height >= 48 && rect.width >= viewport.width - 40, `tap target ${JSON.stringify(rect)}`);
        assert.ok(await item.locator('i').evaluate((icon) => icon.getBoundingClientRect().width >= 32), 'each entry has an icon tile');
      }
      await page.waitForFunction(() => document.getElementById('mobilePlatformMoreMessagesCount').textContent === '3');
      assert.equal(await page.locator('#mobilePlatformMoreMessagesCount').isVisible(), true);
      if (shots) await page.screenshot({ path: path.join(shots, `sheet-${viewport.width}.png`) });

      // Tapping the scrim slides the sheet away, then leaves the top layer.
      await page.mouse.click(viewport.width / 2, 40);
      const midway = await sheet.boundingBox();
      assert.ok(midway && midway.y < viewport.height, 'closing animates rather than vanishing');
      await page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
      assert.equal(await page.getByRole('button', { name: 'More' }).getAttribute('aria-expanded'), 'false');

      // Escape closes it, and an entry opens its control.
      await page.getByRole('button', { name: 'More' }).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
      await page.getByRole('button', { name: 'More' }).click();
      await page.locator('#mobilePlatformMoreAssistant').click();
      assert.equal(await page.evaluate(() => window.assistantToggles), 1);
      await page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));

      // Messages opens beneath the More button, not over the bar.
      await page.getByRole('button', { name: 'More' }).click();
      await page.locator('#mobilePlatformMoreMessages').click();
      const messages = await page.locator('#mobilePlatformMessagesMenu').boundingBox();
      const more = await page.getByRole('button', { name: 'More' }).boundingBox();
      assert.ok(messages.y >= more.y + more.height, JSON.stringify({ messages, more }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('phone and desktop offer the same top bar actions, following the switches', async () => {
  const browser = await launch();
  try {
    const { page, errors } = await openShell(browser, { width: 1280, height: 900 }, false);
    const compare = async (label) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      const desktop = await desktopActions(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'More' }).click();
      await page.waitForFunction(() => document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
      const phone = await sheetActions(page);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
      assert.deepEqual(phone, desktop, label);
      return phone;
    };
    // topbar.todos off (the MVP configuration): neither offers To Do.
    assert.deepEqual(await compare('to-dos off'), ['AI Assistant', 'Messages', 'Notifications']);
    // The organization switch on: both offer it.
    await page.evaluate(() => { window.flags['topbar.todos'] = true; window.dispatchEvent(new Event('fm:capabilities:updated')); });
    assert.deepEqual(await compare('to-dos on'), ['AI Assistant', 'Messages', 'Notifications', 'To Do']);
    // The phone app (shown on desktop once calling is set up) and the assistant switch.
    await page.evaluate(() => { document.getElementById('platformPhoneSlot').hidden = false; window.flags['apps.assistant'] = false; window.dispatchEvent(new Event('fm:app-flags:updated')); });
    await page.waitForFunction(() => document.getElementById('platformAssistantSlot').hidden);
    assert.deepEqual(await compare('phone on, assistant off'), ['Messages', 'Notifications', 'Phone', 'To Do']);
    // The To Do entry opens the same tray on a phone.
    await page.getByRole('button', { name: 'More' }).click();
    await page.locator('#mobilePlatformMoreTodos').click();
    await page.getByText('Call Jane', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.getElementById('mobilePlatformMoreMenu').matches(':popover-open'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
