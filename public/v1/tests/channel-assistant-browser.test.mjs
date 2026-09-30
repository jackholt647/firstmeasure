import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

test('channel recap uses the shared docked assistant with private follow-ups and preserved drafts', async () => {
  const browser = await chromium.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true });
  try {
    const page = await browser.newPage({ viewport:{ width:1440, height:1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<style>html,body{margin:0;height:100%;font-family:Arial}.main{position:relative;height:100vh;width:100%;overflow:hidden}</style><main class="main"><div id="mainPanels"><section id="tab_channels" class="fm-tabpanel active">Channel conversation</section></div></main>');
    await page.evaluate(() => {
      window.__APP = { userOrgId:'org-test' };
      window.Portal = { tabs:{ activateTab(){ throw new Error('Opening a recap must not navigate away from Channels'); } } };
      window.sent = [];
      window.sourceRevision = 'revision-1';
      window.failRecap = false;
      const main = { id:'main', title:'Main thread' };
      const threads = new Map([['main', main]]);
      const messages = new Map([['main', []]]);
      window.AssistantAPI = {
        context:async () => { await new Promise(resolve => setTimeout(resolve, 40)); return { main_thread:main, threads:[...threads.values()], agents:[], dashboard:[] }; },
        channelConversation:async (_org, channel) => {
          const id = `private-${channel}`;
          if (!threads.has(id)) { threads.set(id, { id, subject_id:`channel:${channel}`, title:channel }); messages.set(id, []); }
          return { thread:threads.get(id), source_revision:window.sourceRevision };
        },
        thread:async (_org, id) => ({ thread:threads.get(id), messages:messages.get(id) }),
        send:async (_org, id, body) => {
          window.sent.push({ id, text:body.message, intent:body.intent, composer:document.querySelector('[data-fma="input"]').value });
          const reply = { id:`reply-${window.sent.length}`, role:'assistant', content:`Private reply about ${id}`, data:{status:window.failRecap ? 'failed' : 'success'} };
          messages.get(id).push({ id:`user-${window.sent.length}`, role:'user', content:body.message, data:body.intent === 'channel_recap' ? {automatic_channel_recap:true,channel_source_revision:window.sourceRevision} : {} }, reply);
          return { thread:threads.get(id), assistant_message:reply };
        }
      };
    });
    for (const file of ['window-manager/window-manager.js', 'platform-assistant/platform-assistant.js']) {
      const source = process.env.ASSISTANT_ASSET_ORIGIN
        ? await (await fetch(`${process.env.ASSISTANT_ASSET_ORIGIN}/libraries/${file}?verify=${Date.now()}`)).text()
        : await readFile(new URL(`../../libraries/${file}`, import.meta.url), 'utf8');
      await page.addScriptTag({ content:source });
    }
    // Exercise a cold boot while opening the channel: both callers must await the same boot.
    await page.evaluate(() => window.PlatformAssistant.openChannelConversation({ channelId:'Gutters' }));
    assert.equal(await page.locator('.fma-drawer').getAttribute('data-window'), 'docked');
    assert.match(await page.locator('[data-fma="barSub"]').textContent(), /Private channel conversation/);
    assert.equal(await page.locator('.fma-msg.user').count(),0);
    assert.equal(await page.evaluate(()=>sent[0].intent),'channel_recap');
    assert.equal(await page.evaluate(()=>sent[0].composer),'');
    const input = page.locator('[data-fma="input"]');
    await input.fill('Who owns the order?');
    await input.press('Enter');
    await page.waitForFunction(() => window.sent.length === 2);
    await page.waitForFunction(() => !document.querySelector('[data-fma="send"]').disabled);
    await input.fill('Keep this unsent channel draft');
    await page.evaluate(() => window.PlatformAssistant.openChannelConversation({ channelId:'Roofing' }));
    await page.evaluate(() => window.PlatformAssistant.openChannelConversation({ channelId:'Gutters' }));
    assert.equal(await input.inputValue(), 'Keep this unsent channel draft');
    assert.equal(await page.locator('.fma-msg.user').count(),1);
    assert.equal(await page.locator('.fma-msg.user').innerText(),'Who owns the order?');
    assert.deepEqual(await page.evaluate(() => window.sent.map(item => item.id)), ['private-Gutters', 'private-Gutters', 'private-Roofing']);
    await page.evaluate(() => { sourceRevision='revision-2'; });
    await page.evaluate(() => PlatformAssistant.openChannelConversation({channelId:'Gutters'}));
    assert.equal(await page.evaluate(()=>sent.length),4);
    assert.equal(await page.evaluate(()=>sent.at(-1).intent),'channel_recap');
    assert.equal(await input.inputValue(),'Keep this unsent channel draft');
    assert.equal(await page.locator('.fma-msg.user').count(),1);
    await page.evaluate(() => PlatformAssistant.openChannelConversation({channelId:'Gutters'}));
    assert.equal(await page.evaluate(()=>sent.length),4,'Unchanged source does not regenerate');
    await page.evaluate(() => { sourceRevision='revision-3'; failRecap=true; });
    await page.evaluate(() => PlatformAssistant.openChannelConversation({channelId:'Gutters'}));
    await page.evaluate(() => { failRecap=false; });
    await page.evaluate(() => PlatformAssistant.openChannelConversation({channelId:'Gutters'}));
    assert.equal(await page.evaluate(()=>sent.length),6,'Failed recap is retried');
    assert.equal(await page.locator('.fma-drawer').count(), 1);
    assert.equal(await page.locator('#tab_channels').getAttribute('class'), 'fm-tabpanel active');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
