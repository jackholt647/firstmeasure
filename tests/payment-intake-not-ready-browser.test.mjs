// The shared payment form (public/libraries/payment-intake/payment-intake.js) in headless Chrome when the
// organization cannot take payments yet: a page that passes not-ready actions gets a way into payment setup
// and no amount to type; a page that passes none keeps the plain notice (FM-577).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const INTAKE = readFileSync(new URL('../public/libraries/payment-intake/payment-intake.js', import.meta.url));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><script src="/payment-intake.js"></script></head>
<body><div id="host"></div></body></html>`;

async function page(t) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/payment-intake.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(INTAKE); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: CHROME });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const tab = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await tab.goto(`http://localhost:${server.address().port}/`);
  return tab;
}

test('not ready with actions: the form leads to setup and offers nothing to charge', async (t) => {
  const tab = await page(t);
  await tab.evaluate(() => {
    window.__clicked = [];
    window.FirstMatePaymentIntake.mount(document.getElementById('host'), {
      title: 'Take a Payment',
      allowCustomAmount: true,
      details: [{ label: 'Project', value: '12 Main St' }],
      notReadyTitle: 'Set up online payments',
      notReadyMessage: 'To take card and bank payments here, set up your payment account first.',
      notReadyActions: [
        { label: 'Set up payments', primary: true, onClick: () => window.__clicked.push('setup') },
        { label: 'Record a cash or check payment', onClick: () => window.__clicked.push('record') },
        { label: 'Ignored without onClick' }
      ]
    });
  });
  const shown = await tab.evaluate(() => {
    const setup = document.querySelector('[data-fmpi-setup]');
    return {
      title: setup?.querySelector('h3')?.textContent,
      text: setup?.querySelector('p')?.textContent,
      buttons: [...(setup?.querySelectorAll('[data-fmpi-not-ready-action]') || [])].map((button) => [button.textContent, button.className]),
      amount: !!document.querySelector('[data-fmpi-custom-amount]'),
      methods: !!document.querySelector('[data-fmpi-method]'),
      details: !!document.querySelector('.fmpi-details')
    };
  });
  assert.equal(shown.title, 'Set up online payments');
  assert.match(shown.text, /set up your payment account first/);
  assert.deepEqual(shown.buttons, [['Set up payments', 'fmpi-primary'], ['Record a cash or check payment', 'fmpi-secondary']]);
  assert.equal(shown.amount, false, 'no amount to type when nothing can be charged');
  assert.equal(shown.methods, false);
  assert.equal(shown.details, false);
  await tab.click('text=Set up payments');
  await tab.click('text=Record a cash or check payment');
  assert.deepEqual(await tab.evaluate(() => window.__clicked), ['setup', 'record']);
});

test('not ready without actions: the plain notice beside the amount, as before', async (t) => {
  const tab = await page(t);
  const shown = await tab.evaluate(() => {
    window.FirstMatePaymentIntake.mount(document.getElementById('host'), {
      title: 'Pay',
      allowCustomAmount: true,
      notReadyMessage: 'Online payment is not available for this document yet.'
    });
    return {
      notice: document.querySelector('.fmpi-notice[data-fmpi-not-ready]')?.textContent,
      setup: !!document.querySelector('[data-fmpi-setup]'),
      amount: !!document.querySelector('[data-fmpi-custom-amount]')
    };
  });
  assert.equal(shown.notice, 'Online payment is not available for this document yet.');
  assert.equal(shown.setup, false);
  assert.equal(shown.amount, true);
});
