import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const read=p=>readFile(new URL('../../../'+p,import.meta.url),'utf8');
const portal=await read('public/portal/index.php');
const bootstrap=portal.split('<script id="fm-native-window-insets">')[1].split('</script>')[0];
const section=portal.slice(portal.indexOf('<div id="fmProjectRoutePrecover"'));
const precoverCSS=section.split('<style>')[1].split('</style>')[0];
const ua='Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36';
for(const native of [true,false])for(const workflow of ['existing','new'])test(`${native?'Android app':'Android browser'} ${workflow} header respects inset ownership`,async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:414,height:850},userAgent:ua+(native?' FirstMateMobile/1.0.0':'')});
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:47,bottom:34,left:0,right:0}});
  await page.route('https://insets.test/**',r=>r.fulfill({contentType:'text/html',body:'<style>body{margin:0}*{box-sizing:border-box}</style><main class="main"></main>'}));
  await page.goto('https://insets.test/');
  // No PhoneFeatures.ready or native bridge response: layout must be right immediately.
  await page.addScriptTag({content:bootstrap});
  await page.setContent('<style>body{margin:0}</style><main class="main"></main><div id="fmProjectRoutePrecover"><div class="fm-pr-shell"><div class="fm-pr-title">Project</div><span class="fm-pr-close">×</span></div></div>');
  await page.addScriptTag({content:bootstrap});
  await page.addStyleTag({content:precoverCSS});
  const inset=native?0:47;
  assert.equal(await page.locator('.fm-pr-title').evaluate(e=>parseFloat(getComputedStyle(e).paddingTop)),inset);
  assert.equal(await page.locator('.fm-pr-close').evaluate(e=>e.getBoundingClientRect().y),inset+8);
  await page.evaluate(()=>{window.Portal={modules:{request:{openingHeader:()=>({title:'Project',identityHtml:'Project',pillsHtml:''})}}};});
  for(const f of ['window-manager.js','window-shell.js','project-windows.js'])await page.addScriptTag({content:await read('public/libraries/window-manager/'+f)});
  await page.evaluate(workflow=>{window.record=FirstMateProjectWindows.open(workflow==='existing'?{id:'project_test'}:null,workflow==='new'?{workflow:'report'}:{});},workflow);
  assert.equal(await page.locator('.fm-project-loading-header').evaluate(e=>parseFloat(getComputedStyle(e).paddingTop)),inset);
  assert.equal(await page.locator('.fm-shell-identity').evaluate(e=>e.getBoundingClientRect().y),inset);
  assert.equal(await page.locator('[data-window-action=close]').evaluate(e=>e.getBoundingClientRect().y),inset+8);
  // The embedded document receives the same early bootstrap and shared shell styles.
  const frame=page.frames().find(f=>f!==page.mainFrame());
  await frame.waitForLoadState('domcontentloaded');
  await frame.addScriptTag({content:bootstrap});
  await frame.addScriptTag({content:await read('public/libraries/window-manager/window-shell.js')});
  await frame.evaluate(()=>{document.body.innerHTML='<section class="fm-entity-window"><header class="fm-shell-header" data-window-mobile="true" data-header-rows="2"><div class="fm-shell-identity">Project</div></header></section>';FirstMateWindowShell.ensureStyles();});
  assert.equal(await frame.locator('.fm-shell-identity').evaluate(e=>e.getBoundingClientRect().y),inset);
  await page.evaluate(()=>FirstMateProjectWindows.close());
 }finally{await browser.close();}
});
