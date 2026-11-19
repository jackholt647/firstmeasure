import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('report window controls load without enabling the assistant', async () => {
  const portal=await readFile(new URL('../../portal/index.php',import.meta.url),'utf8');
  const assistantBlocks=portal.match(/<\?php if \(\$platformAssistantAssets\): \?>[\s\S]*?<\?php endif; \?>/g) || [];
  assert(assistantBlocks.length,'Assistant asset gate exists');
  for(const block of assistantBlocks)assert(!/window-manager\/(window-manager|window-shell)\.js/.test(block),'Shared report window controls must not require the assistant');
  for(const name of ['window-manager','window-shell'])assert(portal.includes(`libraries/window-manager/${name}.js`));
});

test('personal settings respect module flags and saving retains hidden preferences', async () => {
  const source=await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const start=source.indexOf('    async function renderMySettings(){');
  const render=source.slice(start,source.indexOf('    function renderCallsSettings(){',start));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const [channels,left,language] of [[false,false,true],[true,false,false],[false,true,false],[false,false,true],[true,true,true]]) {
      const page=await browser.newPage();await page.setContent('<main id="settings"></main>');
      await page.evaluate(async ({render,channels,left,language})=>{
        const preferences={interface_locale:'en-US',language:'fr',auto_translate_messages:true,sidebar_width:310,left_column_behavior:'locked',left_column_channels:true,left_column_agents:true};
        window.Portal={currentUser:{identity:{preferences}},sidebarWidth:{normalize:v=>v,min:220,max:420}};
        window.PlatformLanguage={enabled:()=>true,text:(_ns,_key,fallback)=>fallback,htmlText:(_ns,_key,fallback)=>fallback,context:()=>({locale:'en-US'}),refresh:async()=>{}};
        window.PlatformAPI={preferences:{get:async()=>({preferences}),patch:async value=>{window.savedPatch=value;return {preferences:{...preferences,...value}};}}};
        const escapeHtml=v=>String(v).replaceAll('<','&lt;');
        const languageOptions=value=>`<option value="${value || ''}" selected>Selected language</option>`;
        // GP-121: the assistant's personal settings belong to AI Agents; My Settings must not show them even with the assistant on.
        const draw=new Function('paneMySettings','canMessageTranslation','canLeftColumnSettings','canInterfaceLanguage','canAssistant','escapeHtml','languageOptions','showToast',render+';return renderMySettings;');
        await draw(document.querySelector('#settings'),channels,left,language,true,escapeHtml,languageOptions,()=>{})();
      },{render,channels,left,language});
      assert.equal(await page.locator('[data-my-language]').count(),Number(channels));
      assert.equal(await page.locator('[data-my-auto-translate]').count(),Number(channels));
      assert.equal(await page.locator('[data-my-sidebar-width]').count(),Number(left));
      assert.equal(await page.locator('[data-my-left-column-behavior]').count(),Number(left));
      assert.equal(await page.locator('[data-interface-locale]').count(),Number(language));
      assert.equal(await page.locator('[data-my-assistant-settings]').count(),0);
      assert.equal(await page.getByText('Open assistant settings').count(),0);
      await page.locator('[data-my-settings-save]').click();await page.waitForFunction(()=>window.savedPatch);
      const saved=await page.evaluate(()=>({patch:window.savedPatch,preferences:window.Portal.currentUser.identity.preferences}));
      assert.equal(Object.hasOwn(saved.patch,'language'),channels);
      assert.equal(Object.hasOwn(saved.patch,'sidebar_width'),left);
      if(!channels){assert.equal(saved.preferences.language,'fr');assert.equal(saved.preferences.auto_translate_messages,true);}
      if(!left){assert.equal(saved.preferences.sidebar_width,310);assert.equal(saved.preferences.left_column_behavior,'locked');}
      assert.equal(await page.locator('[data-my-settings-status]').innerText(),'Saved');
      await page.close();
    }
  } finally {await browser.close();}
});

test('My Settings is offered only for personal preferences, never for the assistant alone (GP-121)', async () => {
  const source=await readFile(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const gate=source.match(/const canMySettings = ([^;]+);/)?.[1];
  assert(gate,'My Settings gate exists');
  assert.doesNotMatch(gate,/canAssistant/,'The assistant alone must not open an empty My Settings');
  assert.doesNotMatch(source,/data-my-assistant-settings/,'Assistant settings live in AI Agents, not My Settings');
});
