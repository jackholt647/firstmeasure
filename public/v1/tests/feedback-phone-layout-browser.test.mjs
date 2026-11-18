import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// FM-548: the Feedback tab on a phone. The portal's phone header names the app, so the app's own heading goes;
// explanations are (i) tips, not paragraphs; nothing scrolls sideways. Settings keeps its heading.
const SETTINGS = {
  survey:{ scale:5, question:'How did we do?', comment_prompt:'Anything else?', low_comment_prompt:'What went wrong?', thank_you:'Thanks!' },
  review:{ mode:'threshold', threshold:4, prompt:'Share it?', low_note:'Thanks for telling us.', destinations:[{ id:'google', label:'Google', url:'', icon:'fab fa-google' }] },
  channels:{ sms:true, email:true, portal:false },
  messages:{ sms_text:'Hi {{customer_first_name}} {{link}}', email_subject:'How did we do?', email_body:'Hi {{link}}' },
  delivery:{ trigger:'project_completed' }
};

async function mounted(page, surface, view){
  return page.evaluate(async ({ settings, surface, view }) => {
    const host = document.createElement('div');
    document.querySelector('main').replaceChildren(host);
    window.FirstMateFeedbackSettings.mount(host, { orgId:'org-one', surface, initialView:view });
    for (let i = 0; i < 100 && !host.querySelector('.fb-subtabs'); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return !!host.querySelector('.fb-subtabs') && !!settings;
  }, { settings:SETTINGS, surface, view });
}

test('the Feedback tab has a phone layout: no second heading, tips instead of paragraphs, no sideways scroll', async () => {
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:433, height:870 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<style>body{margin:0;font:14px Arial}main{padding:12px}</style><main></main>');
    await page.evaluate((settings) => {
      window.PlatformAPI = { request:async (path) => path.endsWith('/requests')
        ? { totals:{ sent:3, rated:2, average_rating:4.5, review_clicks:1 }, requests:[{ id:'r1', rating:5, contact:{ name:'Sarah Mitchell' }, project_title:'Roof replacement', comment:'Great crew', rated_at:'2026-11-01' }] }
        : { settings, revision:1 } };
    }, SETTINGS);
    await page.addScriptTag({ content:await readFile(new URL('../../libraries/apps/settings/feedback.js', import.meta.url), 'utf8') });

    const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const view of ['delivery', 'workflow', 'responses']) {
      assert.ok(await mounted(page, undefined, view), view);
      assert.equal(await page.locator('.fb-head').isVisible(), false, `${view}: the portal's phone header already names the app`);
      assert.equal(await page.locator('.fb-page-intro').isVisible(), false, `${view}: the sub-tab already names the view`);
      assert.equal(await sideways(), 0, `${view} scrolls sideways`);
    }

    await mounted(page, undefined, 'delivery');
    assert.equal(await page.locator('.fb-root p').count(), 0, 'explanations are tips, not paragraphs');
    assert.ok(await page.locator('.fb-card-head [data-fb-tip]').count() >= 2);
    assert.equal(await page.locator('.fb-trigger > span > span').first().isVisible(), false, 'trigger notes give way to labels');
    const tip = page.locator('.fb-card-head [data-fb-tip]').first();
    assert.equal(await tip.locator('.fb-hint-tip').isVisible(), false);
    await tip.click();
    assert.equal(await tip.locator('.fb-hint-tip').isVisible(), true, 'a tap opens a tip');
    assert.match(await tip.locator('.fb-hint-tip').textContent(), /Each project receives one request/);
    await page.locator('.fb-scope-todo strong').click();
    assert.equal(await tip.locator('.fb-hint-tip').isVisible(), false, 'a tap elsewhere closes it');
    assert.equal(await page.locator('.fb-savebar').isVisible(), false, 'the hidden save bar takes no room');

    // Inside Settings the app keeps its own heading (Settings decides what to show around it).
    await mounted(page, 'settings', 'delivery');
    assert.equal(await page.locator('.fb-head').isVisible(), true);

    // A desktop still shows the heading and the view intro.
    await page.setViewportSize({ width:1440, height:900 });
    await mounted(page, undefined, 'delivery');
    assert.equal(await page.locator('.fb-head').isVisible(), true);
    assert.equal(await page.locator('.fb-page-intro').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
