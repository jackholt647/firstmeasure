import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const source=(await readFile(process.env.SETTINGS_SEARCH_SOURCE || new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const catalog=await readFile(new URL('../../libraries/apps/settings/search.js',import.meta.url),'utf8');
const css=source.slice(source.indexOf('      .cs-sidebar{'),source.indexOf('      .cfg-options{'));
const markup=source.slice(source.indexOf('            <div class="cs-settings-search">'),source.indexOf('            <nav class="cs-tabs"'));
const behavior=source.slice(source.indexOf("    const settingsSearchInput ="),source.indexOf('    const SETTINGS_SUBTAB_SELECTOR'));

test('settings search overlays the rail without reflow or clipping and supports selection and dismissal',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1000,height:780}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent(`<style>body{font:14px Arial;background:#eff2f6;margin:24px}main{display:grid;grid-template-columns:300px 1fr;gap:24px}aside{height:220px;transform:translateZ(0)}.content{background:#fff;position:relative;z-index:100;padding:24px;border-radius:16px}.cs-tab{padding:15px;text-align:left;background:transparent;border:0;flex:none}.cs-settings-search-clear i:before{content:'×'}${css}</style><h1>My Settings</h1><main><aside class="cs-sidebar"></aside><section class="content"><h2>Language & translation</h2><button id="outside">Other settings</button></section></main>`);
    await page.addScriptTag({content:catalog});
    await page.evaluate(({markup,behavior})=>{
      const panel=document.querySelector('main');
      const html=new Function('return `'+markup+'`;')();
      panel.querySelector('aside').innerHTML=html+'<div class="cs-tabs">'+['My Settings','Notifications','Company','Money','Calls','Contacts','Feedback'].map(label=>`<button class="cs-tab">${label}</button>`).join('')+'</div>';
      window.selected=[];window.Portal={navigation:{navigate:route=>window.selected.push(route)}};
      const initialize=new Function('panel','$','availableSettingsSections','escapeHtml',behavior);
      initialize(panel,(selector,host)=>host.querySelector(selector),window.FirstMateSettingsSearch.catalog.map(item=>({id:item.section})),value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    },{markup,behavior});
    const input=page.getByRole('combobox'),list=page.getByRole('listbox');
    const before=await page.locator('.cs-tabs').boundingBox();
    await input.fill('a');
    assert.equal(await list.isVisible(),true);
    assert.deepEqual(await page.locator('.cs-tabs').boundingBox(),before,'results must not shrink or move the navigation');
    assert.equal(await list.evaluate(el=>el.matches(':popover-open')),true);
    assert.equal(await list.evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
    const box=await list.boundingBox(),anchor=await input.boundingBox();
    assert.equal(box.x,anchor.x);assert.equal(box.width,anchor.width);assert.equal(box.y,anchor.y+anchor.height+6);
    assert.equal(await list.evaluate(el=>el.contains(document.elementFromPoint(el.getBoundingClientRect().left+20,el.getBoundingClientRect().bottom-15))),true,'top layer must stay clickable below the clipped sidebar');
    assert.ok(await list.evaluate(el=>el.scrollHeight>el.clientHeight));
    await page.getByRole('option').last().click();
    assert.equal(await list.isVisible(),false);assert.equal(await page.evaluate(()=>window.selected.length),1);
    await input.fill('dep');await input.press('ArrowDown');await input.press('Enter');
    assert.equal(await list.isVisible(),false);assert.equal(await page.evaluate(()=>window.selected.length),2);
    await input.fill('dep');await input.press('Escape');assert.equal(await list.isVisible(),false);assert.equal(await input.inputValue(),'dep');
    await input.click();assert.equal(await list.isVisible(),true);
    await page.locator('#outside').click();assert.equal(await list.isVisible(),false);
    await input.click();await page.getByRole('button',{name:'Clear settings search'}).click();assert.equal(await input.inputValue(),'');assert.equal(await list.isVisible(),false);
    assert.equal(await input.getAttribute('type'),'text','only the custom clear button is present');
    await input.fill('no-matching-setting-xyz');assert.match(await list.innerText(),/No matching settings/);
    await input.fill('dep');
    await mkdir('../../output/settings-search-dropdown',{recursive:true});
    await page.screenshot({path:'../../output/settings-search-dropdown/desktop.png'});
    await page.setViewportSize({width:390,height:740});
    await page.addStyleTag({content:'main{grid-template-columns:minmax(0,1fr)}aside{width:100%}body{margin:16px}'});
    await input.fill('settings');
    const mobile=await list.boundingBox();assert.ok(mobile.x>=8&&mobile.x+mobile.width<=382);assert.ok(mobile.y+mobile.height<=740);
    await page.screenshot({path:'../../output/settings-search-dropdown/mobile.png'});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
