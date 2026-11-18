// The quick project camera (FM-559): a project card's camera opens the project window on its Photos tab with the
// camera already open over it, at once, while the window's document boots behind it. Done shows the window and its
// Photos tab reads the new photos again; closing the window ends the camera.
// Runs public/libraries/window-manager/project-windows.js and the shared camera in headless Chrome with a fake camera.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const read = (path) => readFileSync(new URL('../' + path, import.meta.url));
const FILES = {
  '/camera-capture.js': read('public/libraries/camera-capture/camera-capture.js'),
  '/project-windows.js': read('public/libraries/window-manager/project-windows.js')
};

// The portal: a workspace, a stub window controller and a camera whose uploads the test settles.
const PORTAL = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script>
window.__uploads = [];
window.Portal = { cfg: { orgId: 'org_test' }, ui: { showToast() {} }, routeState: { get: () => ({}), set() {} }, modules: { request: { openProject() {} } } };
window.PlatformAPI = { media: { upload: (orgId, file, options) => new Promise((resolve) => window.__uploads.push({ orgId, ownerId: options.ownerId, resolve })) } };
window.FirstMateWindows = { attach: () => ({ state: { mode: 'modal', visible: true }, destroy() {}, rebindChrome() {}, setVisible() {}, setMode() {}, focus() {}, restore() {}, refresh() {} }) };
</script>
<script src="/camera-capture.js"></script><script src="/project-windows.js"></script></head>
<body style="margin:0"><main class="main" id="mainPanels"></main></body></html>`;
// A project window's document: records what reaches its Photos tab.
const CHILD = `<!doctype html><html><body><script>window.__photosUploaded = [];
addEventListener('fm:project-photos-uploaded', (event) => window.__photosUploaded.push(event.detail.projectId));</script></body></html>`;

async function phone(t) {
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (FILES[path]) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(FILES[path]); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url.includes('projectWindow=') ? CHILD : PORTAL);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 433, height: 814 }, hasTouch: true, isMobile: true });
  await page.goto(`http://localhost:${server.address().port}/`);
  return page;
}

// Opens the window with the camera; reports what the same task saw.
const OPEN = () => {
  window.__done = null;
  const record = FirstMateProjectWindows.open({ id: 'project_one', title: 'Bill Testo' }, { camera: { projectId: 'project_one', title: 'Bill Testo', onDone: (entries) => { window.__done = entries; } } });
  window.__record = record;
  const shell = document.querySelector('.fmc-shell.fullscreen');
  return { token: record.token, tab: record.options.tab, camera: 'camera' in record.options, shell: !!shell, title: shell?.querySelector('.fmc-head-title')?.textContent || '', layer: !!document.querySelector('.fm-project-window-layer[data-project-window]') };
};
// The window's document has booted and its project opened.
const CHILD_READY = async () => {
  const record = window.__record;
  await new Promise((resolve) => { if (record.frame.contentDocument?.readyState === 'complete' && record.frame.contentWindow.__photosUploaded) resolve(); else record.frame.addEventListener('load', resolve, { once: true }); });
  window.__opened = [];
  FirstMateProjectWindows.ready(record.token, record.frame.contentWindow, { openProject: (project, options) => { window.__opened.push(options.tab); return Promise.resolve(project); }, close: () => true });
  await record.ready;
  return window.__opened;
};
const liveCamera = (page) => page.waitForFunction(() => document.querySelector('.fmc-shell.fullscreen .fmc-stage.live video')?.videoWidth > 0, null, { timeout: 15000 });

test('the camera opens at once over the project window, which opens on Photos and loads behind it', async (t) => {
  const page = await phone(t);
  const opened = await page.evaluate(OPEN);
  assert.deepEqual(opened, { token: opened.token, tab: 'photos', camera: false, shell: true, title: 'Bill Testo', layer: true });
  await liveCamera(page);
  assert.deepEqual(await page.evaluate(CHILD_READY), ['photos'], 'the window opened its project on the Photos tab');

  // A photo, then Done: the camera closes, the window is what remains, and its Photos tab reads the photos again.
  await page.evaluate(() => { const shell = document.querySelector('.fmc-shell'); shell.querySelector('[data-fmc-shutter]').click(); shell.querySelector('[data-fmc-done]').click(); });
  assert.equal(await page.evaluate(() => window.__done?.length), 1);
  assert.equal(await page.evaluate(() => !!document.querySelector('.fmc-shell')), false, 'the camera is gone');
  assert.equal(await page.evaluate(() => FirstMateProjectWindows.size), 1, 'the project window stays open');
  await page.waitForFunction(() => window.__uploads.length === 1);
  assert.deepEqual(await page.evaluate(() => ({ org: window.__uploads[0].orgId, owner: window.__uploads[0].ownerId })), { org: 'org_test', owner: 'project_one' });
  await page.evaluate(() => window.__uploads[0].resolve({ media: { id: 'media_1' } }));
  await page.waitForFunction(() => window.__record.frame.contentWindow.__photosUploaded.length >= 2);
  assert.ok(await page.evaluate(() => window.__record.frame.contentWindow.__photosUploaded.every((id) => id === 'project_one')));
});

test('closing the project window ends its camera; opening it again from the board reopens the camera', async (t) => {
  const page = await phone(t);
  const first = await page.evaluate(OPEN);
  await liveCamera(page);
  await page.evaluate((token) => FirstMateProjectWindows.closed(token), first.token);
  assert.equal(await page.evaluate(() => !!document.querySelector('.fmc-shell')), false, 'the camera closed with its window');
  assert.deepEqual(await page.evaluate(() => window.__done), [], 'onDone ran with no photos');
  const again = await page.evaluate(OPEN);
  assert.equal(again.shell, true);
  assert.equal(await page.evaluate(() => FirstMateProjectWindows.size), 1);
});
