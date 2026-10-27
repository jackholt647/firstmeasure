import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

/* European visitors' login billboard: eu.1m8.ai never published /billboards/login, so every region uses the main
   host's page, and a missing page shows the branded fallback instead of the website's "Not Found". */
const publicRoot = fileURLToPath(new URL('../../', import.meta.url));
const BILLBOARD = 'https://1m8.ai/billboards/login/';
const EUROPE = {timezoneId: 'Europe/Paris', locale: 'fr-FR', extraHTTPHeaders: {'CF-IPCountry': 'FR', 'X-FirstMate-Region': 'EU'}};

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function withPortal(run) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'login-billboard-'));
  const port = await freePort();
  const binary = spawnSync('php', ['-r', 'echo PHP_BINARY;'], {encoding: 'utf8'}).stdout.trim();
  const child = spawn(binary, ['-S', `127.0.0.1:${port}`, '-t', publicRoot], {
    env: {...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary}, stdio: 'ignore'
  });
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${origin}/portal/marketing/billboard_source.php`)).ok) break; } catch { /* wait for the test PHP server */ }
      if (attempt >= 50) throw Error('Test PHP server failed to start');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await run({origin, browser, temporary});
  } finally {
    await browser.close();
    child.kill();
    await rm(temporary, {recursive: true, force: true});
  }
}

// Serves the portal from PHP; the website's billboard and the status check are scripted, everything else external is cut.
async function openLogin(browser, origin, {billboard, status}) {
  const context = await browser.newContext({...EUROPE, viewport: {width: 1280, height: 860}});
  const page = await context.newPage();
  const requested = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    requested.push(url);
    if (url.startsWith(`${origin}/portal/marketing/billboard_status.php`)) return status ? route.fulfill(status) : route.continue();
    if (url.startsWith(origin)) return route.continue();
    if (url === BILLBOARD) return route.fulfill(billboard);
    return route.abort();
  });
  await page.goto(`${origin}/portal/login.php`);
  return {page, requested, context};
}

const panelState = (page) => page.evaluate(() => {
  const panel = document.getElementById('loginBillboard');
  const frame = panel.querySelector('iframe');
  return {
    ready: panel.classList.contains('is-ready'),
    fallback: panel.classList.contains('is-fallback'),
    frameSrc: frame ? frame.src : null,
    frameOpacity: frame ? getComputedStyle(frame).opacity : null,
    fallbackOpacity: getComputedStyle(panel.querySelector('.login-billboard-fallback')).opacity,
    fallbackText: panel.querySelector('.login-billboard-fallback').textContent.trim()
  };
});

test('European visitors get the main host billboard, never eu.1m8.ai', {skip: !spawnSync('php', ['-v']).stdout?.length && 'php not installed'}, async () => {
  await withPortal(async ({origin, browser}) => {
    const html = await (await fetch(`${origin}/portal/login.php`, {headers: EUROPE.extraHTTPHeaders})).text();
    assert.doesNotMatch(html, /eu\.1m8\.ai/);
    assert.match(html, /src="https:\/\/1m8\.ai\/billboards\/login\/"/);

    const {page, requested, context} = await openLogin(browser, origin, {
      billboard: {status: 200, contentType: 'text/html', body: '<!doctype html><h1>Coming Soon: Full Exterior Measurements</h1>'},
      status: {status: 200, contentType: 'application/json', body: '{"ok":true}'}
    });
    await page.waitForFunction(() => document.getElementById('loginBillboard').classList.contains('is-ready'));
    await page.waitForTimeout(300);
    const state = await panelState(page);
    assert.equal(state.frameSrc, BILLBOARD);
    assert.equal(state.fallback, false);
    assert.equal(state.frameOpacity, '1');
    assert.equal(await page.frameLocator('#loginBillboard iframe').locator('h1').textContent(), 'Coming Soon: Full Exterior Measurements');
    assert.equal(requested.some((url) => url.includes('eu.1m8.ai')), false, 'no request to the EU host');
    await context.close();
  });
});

test('a missing website billboard shows the fallback, not "Not Found"', {skip: !spawnSync('php', ['-v']).stdout?.length && 'php not installed'}, async () => {
  await withPortal(async ({origin, browser}) => {
    const {page, context} = await openLogin(browser, origin, {
      billboard: {status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>'},
      status: {status: 200, contentType: 'application/json', body: '{"ok":false}'}
    });
    await page.waitForFunction(() => document.getElementById('loginBillboard').classList.contains('is-fallback'));
    await page.waitForTimeout(300);
    const state = await panelState(page);
    assert.equal(state.frameSrc, null, 'the 404 frame is removed');
    assert.equal(state.ready, false);
    assert.equal(state.fallbackOpacity, '1');
    assert.equal(state.fallbackText, 'Roof and exterior measurement reports');
    await page.setViewportSize({width: 390, height: 800});
    const box = await page.locator('#loginBillboard').boundingBox();
    assert.ok(Math.abs(box.width / box.height - 4) < 0.1, 'mobile keeps the 4:1 panel');
    await context.close();
  });
});

test('an unreachable status check still shows a billboard that loads', {skip: !spawnSync('php', ['-v']).stdout?.length && 'php not installed'}, async () => {
  await withPortal(async ({origin, browser}) => {
    const {page, context} = await openLogin(browser, origin, {
      billboard: {status: 200, contentType: 'text/html', body: '<h1>Billboard</h1>'},
      status: {status: 502, body: 'Bad Gateway'}
    });
    await page.waitForFunction(() => document.getElementById('loginBillboard').classList.contains('is-ready'));
    assert.equal((await panelState(page)).fallback, false);
    await context.close();
  });
});

test('the status endpoint reports a cached missing billboard', {skip: !spawnSync('php', ['-v']).stdout?.length && 'php not installed'}, async () => {
  await withPortal(async ({origin, temporary}) => {
    await writeFile(path.join(temporary, 'firstmate-login-billboard-status.json'), JSON.stringify({ok: false, status: 404, checked_at: Math.floor(Date.now() / 1000)}));
    const response = await fetch(`${origin}/portal/marketing/billboard_status.php`);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(await response.json(), {ok: false});
  });
});
