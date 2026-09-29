import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('project viewer label sits in the notes composer, excludes self, and safely renders names', async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="rOverlay" class="active"><div class="r-bottom-notes"><div class="r-note-composer-shell"><textarea aria-label="Notes"></textarea></div></div></div>');
    const source = await readFile(new URL('../../libraries/apps/project-request/app.js', import.meta.url), 'utf8');
    const code = source.slice(source.indexOf('  let projectPresenceStop = null;'), source.indexOf('  function syncProjectNotesPlacement(){'));
    await page.addScriptTag({ content: `const cfg = { userId:'self' }; function projectOrgId(){ return 'org'; } function activeProjectRouteId(){ return 'project'; }
      window.PlatformRealtime = { watchPresence(org, scope, callback){ window.roster = callback; return () => callback([]); } };
      ${code}
      syncProjectPresence();` });
    await page.evaluate(() => window.roster([{ user_id: 'self', name: 'Me' }, { user_id: 'bill', name: 'Bill' }]));
    const label = page.locator('.r-note-composer-shell > .r-project-presence');
    assert.equal(await label.innerText(), 'Bill is viewing');
    assert.equal(await label.getAttribute('role'), 'status');
    assert.equal(await label.locator('span').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(22, 163, 74)');
    await page.evaluate(() => window.roster([{ user_id: 'bill', name: 'Bill' }, { user_id: 'sam', name: 'Sam' }]));
    assert.equal(await label.innerText(), 'Bill and Sam are viewing');
    await page.evaluate(() => window.roster([{ user_id: 'x', name: '<img src=x onerror=alert(1)>' }]));
    assert.equal(await label.locator('img').count(), 0);
    assert.match(await label.innerText(), /<img/);
    await page.evaluate(() => { document.getElementById('rOverlay').classList.remove('active'); syncProjectPresence(); });
    assert.equal(await label.isVisible(), false);
  } finally { await browser.close(); }
});
