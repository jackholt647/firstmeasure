// The phone camera (public/libraries/camera-capture/camera-capture.js) in headless Chrome with a fake camera: Done
// closes it at once while photos are still encoding or uploading, and they finish behind it (FM-473).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CAMERA = readFileSync(new URL('../public/libraries/camera-capture/camera-capture.js', import.meta.url));

// A phone-sized page with the camera and a stub toast. window.__uploads holds each upload until the test settles it.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<script>
window.__toasts = [];
window.Portal = { ui: { showToast: (title, text, ok) => window.__toasts.push({ title, text, ok }) } };
window.__uploads = [];
window.__upload = (file, entry) => new Promise((resolve, reject) => window.__uploads.push({ id: entry.id, session: entry.session, size: file.size, resolve, reject }));
window.__settle = (fail) => { const list = window.__uploads.splice(0); list.forEach((u) => fail ? u.reject(new Error('refused')) : u.resolve({ id: 'media_' + u.id })); return list.length; };
</script>
<script src="/camera-capture.js"></script></head><body style="margin:0"><div id="host" style="position:relative;height:100vh"></div></body></html>`;

async function site() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/camera-capture.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(CAMERA); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function phone(t) {
  const s = await site();
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  t.after(async () => { await browser.close(); await s.close(); });
  const page = await browser.newPage({ viewport: { width: 433, height: 814 }, hasTouch: true, isMobile: true });
  await page.goto(s.url);
  return page;
}

// Takes `count` photos and taps Done in the same task, before any photo has finished encoding.
const SHOOT_AND_DONE = (count) => {
  const shell = document.querySelector('.fmc-shell');
  for (let i = 0; i < count; i++) shell.querySelector('[data-fmc-shutter]').click();
  shell.querySelector('[data-fmc-done]').click();
  return window.__entries ? window.__entries.map((entry) => ({ status: entry.status, file: !!entry.file, session: entry.session })) : null;
};
const liveCamera = (page) => page.waitForFunction(() => document.querySelector('.fmc-stage.live video')?.videoWidth > 0, null, { timeout: 15000 });

test('Done closes the full-screen camera at once and the photos encode and upload behind it', async (t) => {
  const page = await phone(t);
  await page.evaluate(() => {
    window.__session = FirstMateCamera.open({ title: 'Roof', upload: window.__upload, onDone: (entries) => { window.__entries = entries; } });
  });
  await liveCamera(page);
  const atDone = await page.evaluate(SHOOT_AND_DONE, 2);
  assert.ok(atDone, 'onDone ran in the same tap as Done');
  assert.equal(atDone.length, 2);
  assert.ok(atDone.every((entry) => entry.status === 'pending'), 'the photos were handed on still pending');
  assert.equal(await page.evaluate(() => document.querySelector('.fmc-shell')), null, 'the camera is gone');

  // Encoding finishes and the uploads start in order, in the background.
  await page.waitForFunction(() => window.__uploads.length === 1);
  assert.ok(await page.evaluate(() => window.__uploads[0].size > 0 && !!window.__entries[0].file));
  assert.equal(await page.evaluate(() => window.__entries[0].status), 'uploading');
  // Leaving the page now would lose the photos, so the page asks first.
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);

  await page.evaluate(() => window.__settle());
  await page.waitForFunction(() => window.__uploads.length === 1);
  await page.evaluate(() => window.__settle());
  const settled = await page.evaluate(async () => (await Promise.all(window.__entries.map((entry) => entry.settled))).map((entry) => entry.status));
  assert.deepEqual(settled, ['done', 'done']);
  assert.deepEqual(await page.evaluate(() => window.__toasts), []);
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  assert.equal((await page.evaluate(() => window.__session.done)).length, 2);
});

test('a photo that fails after the camera closed is told in a toast', async (t) => {
  const page = await phone(t);
  await page.evaluate(() => { FirstMateCamera.open({ upload: window.__upload, onDone: (entries) => { window.__entries = entries; } }); });
  await liveCamera(page);
  await page.evaluate(SHOOT_AND_DONE, 1);
  await page.waitForFunction(() => window.__uploads.length === 1);
  await page.evaluate(() => window.__settle(true));
  await page.waitForFunction(() => window.__toasts.length === 1);
  const [toast] = await page.evaluate(() => window.__toasts);
  assert.equal(toast.ok, false);
  assert.match(toast.text, /did not upload/);
  assert.equal(await page.evaluate(() => window.__entries[0].status), 'failed');
});

test('the "what next" step opens at once and each opening of a mounted camera is its own session', async (t) => {
  const page = await phone(t);
  await page.evaluate(() => {
    window.__steps = [];
    window.__cam = FirstMateCamera.mount(document.getElementById('host'), {
      upload: window.__upload,
      next: (entries, step) => { window.__steps.push(entries.map((entry) => entry.status)); step.setTitle('Next'); return new Promise((resolve) => { window.__next = resolve; }); },
      onDone: (entries, result) => { window.__entries = entries; window.__result = result; }
    });
    window.__cam.open();
  });
  await liveCamera(page);
  await page.evaluate(SHOOT_AND_DONE, 1);
  assert.deepEqual(await page.evaluate(() => window.__steps), [['pending']], 'the step got the photo before it was encoded');
  assert.equal(await page.locator('.fmc-step').count(), 1);
  // Done again (Escape) while the step shows opens no second step.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.fmc-step').count(), 1);
  await page.evaluate(() => window.__next({ picked: true }));
  await page.waitForFunction(() => window.__result?.picked === true && !window.__cam.isOpen());
  await page.waitForFunction(() => window.__uploads.length === 1);
  const first = await page.evaluate(() => window.__uploads[0].session);
  await page.evaluate(() => window.__settle());

  await page.evaluate(() => window.__cam.open());
  await liveCamera(page);
  await page.evaluate(SHOOT_AND_DONE, 1);
  await page.evaluate(() => window.__next(true));
  await page.waitForFunction(() => window.__uploads.length === 1);
  const second = await page.evaluate(() => window.__uploads[0].session);
  assert.ok(first && second && first !== second, `sessions ${first} and ${second}`);
});

// GP-62: Done is in the strip of photos, at its right end above the shutter row, where a thumb reaches it; the tray
// takes no room until a photo is taken, and a strip too long to fit scrolls beside Done rather than under it.
test('Done sits at the right end of the strip of photos, within thumb reach', async (t) => {
  const page = await phone(t);
  await page.evaluate(() => { FirstMateCamera.mount(document.getElementById('host'), { upload: window.__upload }).open(); });
  await liveCamera(page);
  assert.equal(await page.locator('.fmc-tray').isVisible(), false, 'no tray before a photo');
  await page.evaluate(() => { for (let i = 0; i < 8; i++) document.querySelector('[data-fmc-shutter]').click(); });
  await page.waitForFunction(() => document.querySelectorAll('.fmc-tile').length === 8);
  await page.evaluate(() => Promise.all(document.querySelector('[data-fmc-done]').getAnimations().map((animation) => animation.finished.catch(() => null))));
  const box = await page.evaluate(() => {
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
    return { done: rect('[data-fmc-done]'), strip: rect('.fmc-strip'), shutter: rect('[data-fmc-shutter]'), head: rect('.fmc-head'), text: document.querySelector('[data-fmc-done]').textContent, inHead: !!document.querySelector('.fmc-head [data-fmc-done]') };
  });
  assert.equal(box.inHead, false, 'Done is not in the top bar');
  assert.match(box.text, /Done · 8/);
  assert.ok(box.done.right >= 433 - 16 && box.done.right <= 433, `Done at the right edge (${box.done.right})`);
  assert.ok(box.done.top >= box.strip.top - 4 && box.done.bottom <= box.strip.bottom + 4, 'Done on the strip row');
  assert.ok(box.done.bottom <= box.shutter.top && box.done.top > 814 / 2, 'Done in the lower half, above the shutter');
  assert.ok(box.strip.right <= box.done.left, 'the strip ends before Done');
  assert.ok(box.done.height >= 44, 'a thumb-sized target');
});
