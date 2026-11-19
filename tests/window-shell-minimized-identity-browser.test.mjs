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
