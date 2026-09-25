import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const bundle = await build({ entryPoints: [new URL('../platform/localization/browser.ts', import.meta.url).pathname.replace(/^\/(\w:)/,'$1')], bundle:true, write:false, format:'iife', plugins:[{
  name:'qa-fixture-packs', setup(build) { build.onLoad({filter:/languages\.json$/},async args=>{
    const registry=JSON.parse(await fs.readFile(args.path,'utf8'));
    registry.packs.push({code:'fr-FR',label:'Français',direction:'ltr'},{code:'ar',label:'العربية',direction:'rtl'});
    return {contents:JSON.stringify(registry),loader:'json'};
  }); }
}] });
const catalog={version:'fixture',namespaces:{settings:{
  'en-US':{color:'Color',welcome:{message:'Hello {name}',format:'icu'},fallback:'US fallback',entity:'Save &amp; close'},
  'en-GB':{color:'Colour',welcome:{message:'Welcome {name}',format:'icu'},entity:'Save &amp; close'},
  'fr-FR':{color:'Couleur',welcome:{message:'Bonjour {name}',format:'icu'}},
  ar:{color:'لون'}
}}};
const html=`<!doctype html><html><head><script src="/runtime.js"></script></head><body style="font:16px system-ui;padding:120px 20px 20px"><main></main><script>
window.PlatformAPI={localization:{get:async()=>({enabled:false,company:{locale:'en-US',measurement_system:'metric'},personal:{interface_locale:null}})}};
(async()=>{ await PlatformLanguage.refresh(); await PlatformLanguage.ensure(['settings']);
const t=(key, fallback, values)=>PlatformLanguage.text('settings',key,fallback,values);
document.querySelector('main').innerHTML='<h1 id="label">'+t('color','Color')+'</h1><p id="customer">Color</p><span id="greeting">'+t('welcome','Hello Sam',{name:'Sam'})+'</span><p id="fallback">'+t('fallback','US fallback')+'</p><p id="entity">'+t('entity','Save &amp; close')+'</p><input id="draft" placeholder="'+t('color','Color')+'"><div contenteditable="true" id="editor">Color</div><button id="action">'+t('color','Color')+'</button>';
window.clicks=0; document.querySelector('#action').onclick=()=>window.clicks++;
window.originalButton=document.querySelector('#action');window.ready=true;
})();</script></body></html>`;

test('console tester swaps source-owned labels live, preserves data/state, persists per tab and restores preferences',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  try {
    const context=await browser.newContext({viewport:{width:800,height:650}}), page=await context.newPage();
    const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
    await context.route('https://preview.test/**',async route=>{
      if(route.request().method()!=='GET')writes.push(route.request().method());
      const path=new URL(route.request().url()).pathname;
      const body=path==='/runtime.js'?bundle.outputFiles[0].text:path.endsWith('manifest.json')?JSON.stringify({namespaces:{settings:'fixture.json'},eagerNamespaces:['settings']}):path.endsWith('fixture.json')?JSON.stringify(catalog):html;
      await route.fulfill({body,contentType:path==='/runtime.js'?'text/javascript':path.endsWith('.json')?'application/json':'text/html'});
    });
    await page.goto('https://preview.test/');await page.waitForFunction(()=>window.ready);
    assert.equal(await page.locator('#fm-language-tester').count(),0);
    assert.equal(await page.locator('#label').textContent(),'Color');
    assert.equal(await page.evaluate(()=>PlatformLanguage.text('settings','color','Color')),'Color');
    await page.evaluate(()=>PlatformLanguage.tester.open());
    assert.equal(await page.getByRole('combobox',{name:'Preview language'}).isDisabled(),true);
    await page.getByRole('button',{name:'Reload & start'}).click();
    await page.waitForFunction(()=>window.ready&&PlatformLanguage.tester.status().live);
    await page.waitForFunction(()=>document.querySelector('#label').textContent==='Color');
    await page.locator('#draft').fill('Unsaved Color'); await page.locator('#draft').focus();
    await page.evaluate(()=>PlatformLanguage.tester.setLocale('en-GB'));
    assert.equal(await page.locator('#label').textContent(),'Colour');
    assert.equal(await page.locator('#greeting').textContent(),'Welcome Sam');
    assert.equal(await page.locator('#draft').getAttribute('placeholder'),'Colour');
    assert.equal(await page.locator('#entity').textContent(),'Save & close');
    assert.equal(await page.locator('#customer').textContent(),'Color');
    assert.equal(await page.locator('#editor').textContent(),'Color');
    assert.equal(await page.locator('#draft').inputValue(),'Unsaved Color');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'draft');
    assert.equal(await page.evaluate(()=>originalButton===document.querySelector('#action')),true);
    assert.deepEqual(await page.evaluate(()=>({context:PlatformLanguage.context().locale,snapshot:PlatformLanguage.snapshot().locale,units:PlatformLanguage.context().measurement_system,lang:document.documentElement.lang})),{context:'en-US',snapshot:'en-US',units:'metric',lang:'en-GB'});
    await page.locator('#action').click();assert.equal(await page.evaluate(()=>clicks),1);
    await page.evaluate(()=>{const p=document.createElement('p');p.id='late';p.textContent=FMText('settings','color','Color');document.body.append(p);});
    await page.waitForFunction(()=>document.querySelector('#late').textContent==='Colour');
    await page.evaluate(()=>{const frame=document.createElement('iframe');frame.id='embedded';frame.src='/embedded';frame.style.display='none';document.body.append(frame);});
    await page.waitForFunction(()=>document.querySelector('#embedded').contentWindow.ready);
    const embedded=page.frames().find(frame=>frame.url().endsWith('/embedded'));
    assert.equal(await embedded.locator('#fm-language-tester').count(),0);
    await page.getByRole('combobox',{name:'Preview language'}).selectOption('fr-FR');
    await page.waitForFunction(()=>document.querySelector('#label').textContent==='Couleur');
    assert.equal(await page.locator('#late').textContent(),'Couleur');
    await embedded.waitForFunction(()=>document.querySelector('#label').textContent==='Couleur');
    assert.equal(await page.locator('#fallback').textContent(),'US fallback');
    await page.evaluate(()=>{document.querySelector('#greeting').textContent='Manually replaced content';});
    await page.evaluate(()=>PlatformLanguage.tester.setLocale('ar'));
    assert.equal(await page.locator('#label').textContent(),'لون');
    assert.equal(await page.locator('#greeting').textContent(),'Manually replaced content');
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
    await assert.rejects(page.evaluate(()=>PlatformLanguage.tester.setLocale('zz-ZZ')),/not installed/);
    const output=new URL('../../../output/language-tester/',import.meta.url);await fs.mkdir(output,{recursive:true});
    await page.screenshot({path:new URL('desktop.png',output).pathname.replace(/^\/(\w:)/,'$1')});
    await page.setViewportSize({width:390,height:700});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:new URL('mobile.png',output).pathname.replace(/^\/(\w:)/,'$1')});
    await page.goto('https://preview.test/other');await page.waitForFunction(()=>window.ready);
    await page.waitForFunction(()=>document.querySelector('#label').textContent==='لون');
    await page.getByRole('button',{name:'Close language tester and restore account language'}).click();
    assert.equal(await page.locator('#label').textContent(),'Color');
    assert.equal(await page.locator('html').getAttribute('dir'),'ltr');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('fm:language-tester:v1')),null);
    assert.equal(await page.locator('#fm-language-tester').count(),0);
    const other=await context.newPage();await other.goto('https://preview.test/');await other.waitForFunction(()=>window.ready);
    assert.equal(await other.locator('#fm-language-tester').count(),0);
    assert.equal(await other.locator('#label').textContent(),'Color');
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  } finally { await browser.close(); }
});
