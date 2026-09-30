import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('app groups preserve access, defaults, standalone mounting, saved layouts and responsive headers',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<style>body{margin:0;font:14px Arial}main{height:600px}</style><main></main>');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'org-one'};
      window.Portal={currentUser:{permissions:{manage_company_settings:true},applicationAccess:{management:{enabled:true}}}};
      window.saved={};
      window.PlatformAPI={request:async(path,options)=>{if(options?.method==='PUT'){window.saved[path.split('/').at(-1)]=options.body;return {ok:true};}return {groups:window.saved};}};
    });
    for(const file of ['app-runtime/firstmate-embeddable-apps.js','app-runtime/app-chrome.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await page.evaluate(async()=>{
      const runtime=window.FirstMateEmbeddableApps;
      runtime.registerApp({id:'portal.test',title:'Communications',surfaces:['portal_tab'],access:{permissionsAny:['manage_company_settings']},visible:true});
      window.AppChrome.registerGroup({id:'communications',parent:'portal.test',title:'Communications',default:'inbox',members:[{id:'inbox',title:'Inbox'},{id:'center',title:'Call center'}],mount:(id,context)=>{context.root.innerHTML=window.AppChrome.header({title:id==='center'?'Call center':'Inbox',icon:'fa-headset'});return {destroy(){context.root.innerHTML='';}};}});
      await window.AppChrome.load();
    });
    assert.deepEqual(await page.evaluate(()=>window.AppChrome.members('communications').map(m=>m.id)),['inbox','center']);
    assert.equal(await page.evaluate(()=>window.AppChrome.resolve('communications','invalid')),'inbox');
    assert.deepEqual(await page.evaluate(()=>window.AppChrome.members('communications',{permissions:{manage_company_settings:false}})),[]);
    assert.equal(await page.evaluate(()=>window.AppChrome.resolve('communications','inbox',{entitlements:{'portal.test.inbox':false}})),'center');
    await page.evaluate(()=>{document.querySelector('main').innerHTML=window.AppChrome.settings('communications');});
    await page.locator('[name=center]').selectOption('both');
    await page.locator('[name=default]').selectOption('center');
    await page.locator('[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('[data-layout-status]').textContent.includes('saved'));
    assert.equal(await page.evaluate(()=>window.AppChrome.resolve('communications')),'center');
    assert.deepEqual(await page.evaluate(()=>window.FirstMateEmbeddableApps.listApps({surface:'portal_tab'}).map(m=>m.id)),['portal.test','portal.test.center']);
    // Saving a standalone-only organization removes the group without disabling the app.
    await page.locator('[name=center]').selectOption('standalone');
    await page.locator('[name=inbox]').selectOption('hidden');
    await page.locator('[name=default]').selectOption('');
    await page.locator('[type=submit]').click();
    await page.waitForFunction(()=>window.saved.communications.default==='');
    assert.deepEqual(await page.evaluate(()=>window.FirstMateEmbeddableApps.listApps({surface:'portal_tab'}).map(m=>m.id)),['portal.test.center']);
    await page.evaluate(async()=>{window.handle=await window.FirstMateEmbeddableApps.mount(document.querySelector('main'),'portal.test.center',{surface:'portal_tab'});});
    assert.equal(await page.locator('h1').textContent(),'Call center');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    // Explicit parent denial cannot be bypassed by changing placement.
    assert.equal(await page.evaluate(()=>window.FirstMateEmbeddableApps.evaluateAccess('portal.test.center',{surface:'portal_tab',entitlements:{'portal.test':false}}).allowed),false);
    await page.evaluate(()=>{window.handle.destroy();window.__APP.userOrgId='org-two';window.saved={};return window.AppChrome.load();});
    assert.equal(await page.evaluate(()=>window.AppChrome.resolve('communications')),'inbox');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Communications, Financials and Payroll render declared tabs and scope their actions',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://app-groups.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font:14px Arial}main{height:850px}</style><div id="mainPanels"></div><main></main>'}));
    await page.goto('http://app-groups.test/');
    await page.evaluate(()=>{
      window.__APP={userOrgId:'test',userId:'owner'};
      window.route={tab:'chat',communicationsView:'center'};
      const handlers=[];
      window.Portal={currentUser:{permissions:{'*':true}},tabs:{},appFlags:{has:()=>true},capabilities:{current:()=>({effective_by_key:{'money.merchant_processing':true}})},navigation:{read:()=>window.route,registerSchema(){},registerHandler:(_id,handler)=>{handlers.push(handler);return ()=>{};},push:patch=>{window.route={...window.route,...patch};},navigate:patch=>{window.route={...window.route,...patch};handlers.forEach(h=>h.apply(window.route));}}};
      window.PlatformAPI={request:async()=>({groups:{}})};
      window.CommsAPI={customer:async()=>({columns:[],calls:[],agents:[],tasks:[],scripts:[]})};
      window.Portal.CustomerPhone={refreshStatus:async()=>({permissions:{manage:false},numbers:[]}),open:async()=>{},status:{permissions:{manage:false}}};
      window.FinancialsAPI={projects:async()=>({projects:[],totals:{}}),cashFlow:async()=>({totals:{},series:[],transactions:{items:[]}})};
      window.FirstMatePayrollSettings={mount:root=>{root.innerHTML='<p>Payroll settings content</p>';return {destroy(){}};}};
    });
    const script=async file=>page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
    await script('app-runtime/firstmate-embeddable-apps.js');await script('app-runtime/app-chrome.js');
    await page.evaluate(()=>{window.Portal.apps={registerPortalApp:def=>window.FirstMateEmbeddableApps.registerApp({...def,surfaces:['portal_tab'],mount:context=>def.mount(context.root,context)})};});
    for(const file of ['apps/comms/communications-ui.js','apps/comms/workspace.js','apps/chat/app.js','apps/financials/app.js','apps/payroll/app.js'])await script(file);
    await page.waitForFunction(()=>window.FirstMateEmbeddableApps.getApp('portal.chat.center'));
    await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
    const mount=async(id,params={})=>page.evaluate(async({id,params})=>{window.handle?.destroy();window.handle=await window.FirstMateEmbeddableApps.mount(document.querySelector('main'),id,{surface:'portal_tab',orgId:'test',permissions:{'*':true},params});}, {id,params});
    await mount('portal.chat');
    await page.waitForSelector('[data-action=new-call]');
    assert.equal(await page.locator('[data-app-header] h1').textContent(),'Communications');
    assert.equal(await page.locator('[data-app-header] .app-tabs button').count(),6);
    assert.equal(await page.locator('[data-app-header] [data-action=new-call]').count(),0);
    if(process.env.APP_GROUP_SCREENSHOT_DIR)await page.screenshot({path:process.env.APP_GROUP_SCREENSHOT_DIR+'/communications-desktop.png'});
    await page.locator('[data-view=setup]').click();
    await page.waitForSelector('[data-view=layout]');
    await page.locator('[data-view=layout]').click();
    assert.equal(await page.locator('[data-app-layout=communications]').count(),1);
    await mount('portal.chat.center');
    assert.equal(await page.locator('[data-app-header] h1').textContent(),'Call center');
    assert.equal(await page.locator('[data-app-header] .app-tabs button').count(),0);
    await mount('portal.financials');
    await page.waitForSelector('[data-fn-view=payouts]');
    assert.equal(await page.locator('[data-app-header] .app-tabs button').count(),4);
    assert.equal(await page.locator('[data-app-header] [data-fn-action=refresh]').count(),0);
    await mount('portal.payroll',{smoke:true});
    assert.equal(await page.locator('[data-app-header] .app-tabs button').count(),6);
    assert.equal(await page.locator('[data-app-header] [data-action=create-off-cycle]').count(),0);
    assert.equal(await page.locator('[data-action=create-off-cycle]').count(),1);
    await page.locator('[data-view=settings]').click();
    assert.equal(await page.locator('[data-payroll-settings-host]').textContent(),'Payroll settings content');
    assert.equal(await page.locator('[data-app-header] .app-tabs button').count(),6);
    await page.evaluate(async()=>{window.handle.destroy();window.handle=await window.FirstMateEmbeddableApps.mount(document.querySelector('main'),'portal.financials',{surface:'portal_tab',orgId:'test',permissions:{'*':true},entitlements:Object.fromEntries(['projects','cashflow','reconcile','payouts'].map(id=>['portal.financials.'+id,false]))});});
    assert.match(await page.locator('main').textContent(),/No accessible apps/);
    await mount('portal.chat');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.APP_GROUP_SCREENSHOT_DIR)await page.screenshot({path:process.env.APP_GROUP_SCREENSHOT_DIR+'/communications-mobile.png'});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
