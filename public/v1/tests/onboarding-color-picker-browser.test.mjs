// FM-316: the shared color picker opened behind the onboarding wizard's full-screen overlay, so clicking a brand color
// looked like it did nothing. Chrome runs the real wizard with the real picker: the panel must be what a click at its
// own position lands on, and a color chosen there must reach the wizard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const wizard = await read('../../libraries/apps/onboarding/wizard.js');
const picker = await read('../../libraries/color-picker/firstmate-color-picker.js');
const launch = () => chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), headless: true });

const panelOnTop = page => page.locator('.fm-color-picker').evaluate(panel => {
  const box = panel.getBoundingClientRect();
  return panel.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
});

async function onboarding(browser, viewport) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://portal.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://portal.test/portal/');
  await page.evaluate(() => {
    window.__APP = { userEmail: 'owner@example.test', userOrgId: 'org_new', showOnboarding: true, orgName: 'Reyes Roofing LLC', userName: 'Dana Reyes' };
    window.Portal = {
      cfg: window.__APP,
      util: {
        $: (sel, root = document) => root.querySelector(sel),
        escapeHtml: v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        injectCSS: (key, css) => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); },
        postAction: async (action) => {
          if (action === 'org_get_my') return { data: { success: true, org: { name: window.__APP.orgName } } };
          if (action === 'pj_search') return { data: { success: true, results: [] } };
          return { data: { success: true } };
        }
      },
      ui: { showToast() {} }
    };
    window.PlatformAPI = { request: async () => ({ organization: { name: window.__APP.orgName } }) };
  });
  await page.addScriptTag({ content: picker });
  await page.addScriptTag({ content: wizard });
  await page.locator('#obOverlay').waitFor({ timeout: 5000 });
  // Skip the website and logo steps to reach the colors.
  for (let i = 0; i < 3 && !await page.locator('#obPrimary').isVisible(); i += 1) {
    await page.locator('#obSkip0').click();
    await page.waitForTimeout(150);
  }
  return { page, errors };
}

for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`FM-316: both brand colors open a picker that sits above the wizard (${name})`, async () => {
    const browser = await launch();
    try {
      const { page, errors } = await onboarding(browser, viewport);
      for (const [id, hex] of [['#obPrimary', '#123abc'], ['#obSecondary', '#abc123']]) {
        await page.locator(id).click();
        assert.equal(await panelOnTop(page), true, `${id}: the picker is covered`);
        await page.locator('.fm-color-picker [data-hex]').fill(hex);
        await page.locator('.fm-color-done').click();
        assert.equal(await page.locator('.fm-color-picker').count(), 0);
        assert.equal(await page.locator(id).inputValue(), hex);
      }
      assert.equal(await page.locator('.ob-preview-bar-p').first().evaluate(el => el.style.background), 'rgb(18, 58, 188)');
      assert.equal(await page.locator('.ob-preview-bar-s').first().evaluate(el => el.style.background), 'rgb(171, 193, 35)');
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

// Other full-screen layers use the same very high z-indexes; the picker has to win against the highest there is.
test('FM-316: the picker opens above a layer at the highest possible z-index', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<div style="position:fixed;inset:0;z-index:2147483647;background:#fff"><input id="color" type="color" value="#123456"></div>');
    await page.addScriptTag({ content: picker });
    await page.locator('#color').click();
    assert.equal(await panelOnTop(page), true);
  } finally { await browser.close(); }
});
