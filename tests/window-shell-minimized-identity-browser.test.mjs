// A minimized entity window shows its icon and name, with restore and close beside them (GP-125). The contact
// window's two-row shell header kept its open layout when minimized: the identity reserved 224px for the floating
// controls, so in the 224px bar the name had no width and the controls dropped below the bar.
// Runs public/libraries/window-manager/window-manager.js and window-shell.js in headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRIPTS = {
  '/window-manager.js': readFileSync(new URL('../public/libraries/window-manager/window-manager.js', import.meta.url)),
  '/window-shell.js': readFileSync(new URL('../public/libraries/window-manager/window-shell.js', import.meta.url)),
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script src="/window-manager.js"></script><script src="/window-shell.js"></script></head>
<body style="margin:0;font:13px Arial,sans-serif"><main class="main" style="position:fixed;inset:0"><div id="mainPanels"></div></main></body></html>`;

async function open(t) {
  const server = http.createServer((req, res) => {
    const script = SCRIPTS[req.url.split('?')[0]];
    if (script) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(script); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 }, reducedMotion: 'reduce' });
  await page.goto(`http://localhost:${server.address().port}/`);
  return page;
}

// The contact window's markup and options (contacts/modal.js): identity, controls host and tabs in one header.
const MINIMIZE = (headerRows) => {
  const host = document.querySelector('main');
  const element = document.createElement('section');
  element.innerHTML = `<div class="fm-contact-window-header"><div class="identity"><i class="fas fa-address-card"></i><span>Bill Testo</span></div>
    <div class="r-window-bar-actions"></div><div class="tabs"><button type="button" data-tab="projects">Projects</button><button type="button" data-tab="media">Photos</button></div></div>
    <div class="sidebar">Details</div><div class="body"></div>`;
  host.append(element);
  const header = element.querySelector('.fm-contact-window-header');
  const panes = FirstMateWindowShell.localPanes({ container: element.querySelector('.body'), definitions: [{ tab: 'projects', element: document.createElement('section') }, { tab: 'media', element: document.createElement('section') }] });
  const win = FirstMateWindows.attach({
    element, host, header, controlsHost: element.querySelector('.r-window-bar-actions'), title: element.querySelector('.identity'),
    contentTarget: document.getElementById('mainPanels'), customChrome: true, titleMenu: false, presentationModes: true, viewportCoordinates: true,
    name: 'contact', label: 'Contact', mode: 'floating', width: 1100, height: 760, minimizedHeight: 32,
  });
  FirstMateWindowShell.mount({ element, header, identity: element.querySelector('.identity'), tabs: element.querySelector('.tabs'), sidebar: element.querySelector('.sidebar'), panes, headerRows });
  win.setMode('minimized');
  const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
  const visible = [...element.querySelectorAll('.fm-window-controls button')].filter((button) => getComputedStyle(button).display !== 'none');
  return {
    bar: { left: parseFloat(element.style.left), top: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) },
    window: box(element), name: box(element.querySelector('.identity span')), icon: box(element.querySelector('.identity i')),
    controls: visible.map((button) => ({ action: button.dataset.windowAction, ...box(button) })),
    tabs: getComputedStyle(element.querySelector('.tabs')).display,
  };
};

for (const rows of [2, 1]) {
  test(`a minimized ${rows}-row shell window shows its name with restore and close on the same line`, async (t) => {
    const page = await open(t);
    const { window: bar, name, icon, controls, tabs } = await page.evaluate(MINIMIZE, rows);
    assert.ok(bar.width <= 240 && bar.bottom - bar.top <= 34, `minimized bar ${JSON.stringify(bar)}`);
    assert.ok(name.width >= 40, `the name has room: ${JSON.stringify(name)}`);
    assert.ok(icon.left - bar.left <= 12, `the icon starts the bar: ${JSON.stringify(icon)}`);
    assert.equal(tabs, 'none', 'tabs are hidden while minimized');
    assert.deepEqual(controls.map((button) => button.action).sort(), ['close', 'minimize']);
    for (const button of controls) {
      assert.ok(button.top >= bar.top && button.bottom <= bar.bottom + 1, `${button.action} sits inside the bar: ${JSON.stringify(button)}`);
      assert.ok(button.left >= name.right, `${button.action} is right of the name`);
      assert.ok(button.right <= bar.right, `${button.action} is inside the bar`);
    }
    assert.ok(bar.right - Math.max(...controls.map((button) => button.right)) <= 8, 'the controls end at the bar edge');
  });
}

// Every minimized bar is the same bar (GP-153): the contact window (a two-row shell header with the GP-152 title toggle),
// a tray window (phone, to do, assistant) and a plain window put their icon, name and controls in the same places, in
// the same type. The contact's header kept the open header's 36px min-height, so its name sat below the bar's middle.
const BARS = () => {
  const host = document.querySelector('main');
  const make = (html) => { const element = document.createElement('section'); element.innerHTML = html; host.append(element); return element; };
  const base = { host, contentTarget: document.getElementById('mainPanels'), viewportCoordinates: true, mode: 'floating', width: 900, height: 600, minimizedHeight: 32 };
  const contact = make(`<div class="fm-contact-window-header"><div class="identity"><i class="fas fa-address-card"></i><span>Bill Testo</span></div>
    <div class="r-window-bar-actions"></div><div class="tabs"><button type="button" data-tab="projects">Projects</button><button type="button" data-tab="media">Photos</button></div></div>
    <div class="sidebar">Details</div><div class="body"></div>`);
  const contactHeader = contact.querySelector('.fm-contact-window-header');
  const panes = FirstMateWindowShell.localPanes({ container: contact.querySelector('.body'), definitions: [{ tab: 'projects', element: document.createElement('section') }, { tab: 'media', element: document.createElement('section') }] });
  const contactWin = FirstMateWindows.attach({ ...base, element: contact, header: contactHeader, controlsHost: contact.querySelector('.r-window-bar-actions'), title: contact.querySelector('.identity'),
    customChrome: true, titleMenu: false, presentationModes: true, name: 'contact', label: 'Contact', minimizedTooltip: () => ({ name: 'Bill Testo', detail: '1 Main St' }) });
  FirstMateWindowShell.mount({ element: contact, header: contactHeader, identity: contact.querySelector('.identity'), tabs: contact.querySelector('.tabs'), sidebar: contact.querySelector('.sidebar'), panes, headerRows: 2, sidebarToggle: { open: true } });
  const tray = make(`<header><div class="identity"><i class="fas fa-phone"></i><span>Phone</span></div></header><div class="body"></div>`);
  const trayBody = FirstMateWindowShell.trayWindow({ element: tray, header: tray.querySelector('header'), title: tray.querySelector('.identity'), body: tray.querySelector('.body'), tabs: [{ id: 'calls', label: 'Calls', element: tray.querySelector('.body') }] }).body;
  const trayWin = FirstMateWindows.attach({ ...base, element: tray, header: tray.querySelector('header'), title: tray.querySelector('.identity'), body: trayBody, name: 'phone', label: 'Phone' });
  const plain = make(`<header><div class="identity fm-window-minimized-identity"><i class="fas fa-list-check"></i><span>To Do</span></div></header><div class="body"></div>`);
  const plainWin = FirstMateWindows.attach({ ...base, element: plain, header: plain.querySelector('header'), title: plain.querySelector('.identity'), body: plain.querySelector('.body'), name: 'todo', label: 'To Do' });
  for (const win of [contactWin, trayWin, plainWin]) win.setMode('minimized');
  const tip = contact.querySelector('.identity').getAttribute('data-fm-tooltip-html');
  const bars = [contact, tray, plain].map((element) => {
    const bar = element.getBoundingClientRect(), name = element.querySelector('.identity span'), box = name.getBoundingClientRect(), icon = element.querySelector('.identity i').getBoundingClientRect();
    const close = element.querySelector('[data-window-action=close]').getBoundingClientRect(), style = getComputedStyle(name);
    return { name: name.textContent, height: bar.height, icon: icon.left - bar.left, text: box.left - bar.left, middle: box.top + box.height / 2 - bar.top, close: bar.right - close.right, closeWidth: close.width,
      font: `${style.fontSize} ${style.fontWeight}`, border: getComputedStyle(element).borderTopColor, shadow: getComputedStyle(element).boxShadow };
  });
  contactWin.setMode('floating');
  return { bars, tip, restoredTip: contact.querySelector('.identity').getAttribute('data-fm-tooltip-html') };
};

test('the contact, tray and plain windows minimize to the same bar, the name in its middle', async (t) => {
  const page = await open(t);
  const { bars } = await page.evaluate(BARS);
  const [first] = bars;
  for (const bar of bars) {
    assert.ok(Math.abs(bar.middle - bar.height / 2) <= 1, `${bar.name}: the name is in the bar's middle: ${JSON.stringify(bar)}`);
    for (const key of ['height', 'icon', 'text', 'close', 'closeWidth', 'font', 'border', 'shadow']) {
      assert.equal(bar[key], first[key], `${bar.name} ${key} matches ${first.name}: ${JSON.stringify(bars)}`);
    }
  }
});

test('a minimized bar names its window in a tooltip, the address under a divider, and drops it when restored', async (t) => {
  const page = await open(t);
  const { tip, restoredTip } = await page.evaluate(BARS);
  assert.equal(tip, '<div class="fm-window-tip-name">Bill Testo</div><div class="fm-window-tip-detail">1 Main St</div>');
  assert.equal(restoredTip, null);
});
