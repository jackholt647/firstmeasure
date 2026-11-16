// FM-489: in the project window header the name keeps its full width and only the address beside it clips; the
// name clips only when it alone is wider than the header. Renders the header with project-request/app.js's own
// identity CSS in Chromium at the reporter's phone width (433 px) and on a desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { chromium } = createRequire(new URL('../public/v1/package.json', import.meta.url))('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const app = readFileSync(new URL('../public/libraries/apps/project-request/app.js', import.meta.url), 'utf8');

// The header identity rules, as app.js injects them (a template literal, so its backslashes are doubled).
function identityCss(){
  const start = app.indexOf('    .r-window-identity{');
  const end = app.indexOf('    .r-window-identity .r-project-tag i{', start);
  assert.ok(start > 0 && end > start, 'header identity CSS found in project-request/app.js');
  return app.slice(start, end).replace(/\\\\/g, '\\');
}

const ADDRESS = '1231 116th Ave NE, Bellevue, WA 98004, USA';

async function header(page, { mobile, name }){
  await page.setContent(`<!doctype html><html><head><style>body{margin:0;font-family:sans-serif}
    .fm-shell-header{display:flex;align-items:center;width:100%;height:56px}
    .fm-shell-header>.r-window-identity{flex:1 1 auto}
    .r-window-bar-actions{flex:none;width:150px}
    ${identityCss()}</style></head><body>
    <header class="fm-shell-header" data-window-mobile="${mobile}">
      <div class="r-window-identity fm-shell-identity"><i></i><button type="button" id="rProjectIdentityTrigger">
        <span id="rWindowProjectTitle"><strong></strong><span class="r-project-identity-secondary"></span></span></button></div>
      <div class="r-window-bar-actions"></div>
    </header></body></html>`);
  return page.evaluate(([name, address]) => {
    const strong = document.querySelector('#rWindowProjectTitle strong');
    const secondary = document.querySelector('.r-project-identity-secondary');
    strong.textContent = name; secondary.textContent = address;
    const title = document.getElementById('rWindowProjectTitle');
    return { nameClipped: strong.scrollWidth > strong.clientWidth, addressClipped: secondary.scrollWidth > secondary.clientWidth,
      nameWidth: strong.getBoundingClientRect().width, titleWidth: title.getBoundingClientRect().width };
  }, [name, ADDRESS]);
}

test('phone header: the name is shown whole and the address clips', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 433, height: 870 } });
    const short = await header(page, { mobile: true, name: 'Bill Henderson' });
    assert.equal(short.nameClipped, false, 'a name that fits is never clipped to show the address');
    assert.equal(short.addressClipped, true, 'the address is what clips');
    const long = await header(page, { mobile: true, name: 'Bartholomew Montgomery-Fitzgerald and Associates LLC' });
    assert.equal(long.nameClipped, true, 'a name wider than the header clips');
    assert.ok(Math.abs(long.nameWidth - long.titleWidth) < 1, 'a name wider than the header takes the whole title row');
  } finally { await browser.close(); }
});

test('desktop header: a name that fits is never clipped', async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const result = await header(page, { mobile: false, name: 'Bartholomew Montgomery-Fitzgerald' });
    assert.equal(result.nameClipped, false);
    assert.equal(result.addressClipped, true);
  } finally { await browser.close(); }
});
