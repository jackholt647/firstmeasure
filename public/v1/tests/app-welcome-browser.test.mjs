import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { APP_WELCOMES } from '../platform/app-experience/offers.ts';

const source=(await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8')).replaceAll('export function','function');
const output=new URL('../../../output/app-welcome-tests/',import.meta.url);
await mkdir(output,{recursive:true});

test('activation refreshes guides before the host mounts and fades the advertisement away',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent('<main id="root" style="height:600px"></main>');
    await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
    await page.evaluate(welcome=>{
      window.__APP={userOrgId:'org_test'};window.steps=[];
      window.PlatformAPI={request:async()=>{steps.push('activate');return {};},capabilities:{load:async()=>{}},appFlags:{load:async()=>{}}};
      window.FirstMateGuides={refresh:async()=>{steps.push('guides');}};
      window.Portal={auth:{syncPlatformSession:async()=>{
        steps.push('mount');window.handle.destroy();
        document.getElementById('root').innerHTML='<section id="actual-app">Ready</section>';
        window.dispatchEvent(new CustomEvent('fm:embeddable-apps:app-mounted',{detail:{appId:'project.photos',context:{entitlement:{offered:false}}}}));
      }}};
      window.handle=window.mountWelcome({appId:'project.photos',orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{welcome},preload:async()=>{steps.push('preload');}});
    },APP_WELCOMES['project.photos']);
    await page.waitForFunction(()=>steps.includes('preload'));
    await page.getByRole('button',{name:'Get Started'}).click();
    await page.waitForSelector('#actual-app');
    await page.waitForFunction(()=>!document.querySelector('.fm-app-welcome'));
    assert.deepEqual(await page.evaluate(()=>steps),['preload','activate','guides','mount']);
  }finally{await browser.close();}
});

test('designed welcome screens fit phones and desktops and only activate on Get Started',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const width of [360,1100]) for(const [appId,welcome] of Object.entries(APP_WELCOMES)){
      const page=await browser.newPage({viewport:{width,height:850}});
      await page.setContent('<html><body style="margin:0"><main id="root" style="height:100vh"></main></body></html>');
      await page.evaluate(()=>{
        window.__APP={userOrgId:'org_test'};window.activations=0;window.startedEvents=0;window.failStart=true;
        window.PlatformAPI={request:async()=>{window.activations++;if(window.failStart)throw Error('Please try again.');return {ok:true};},capabilities:{load:async()=>({})},appFlags:{load:async()=>({})}};
        window.Portal={auth:{syncPlatformSession:async()=>({})}};
        window.addEventListener('fm:app-offer:started',()=>window.startedEvents++);
      });
      await page.addScriptTag({content:source+'\nwindow.mountWelcome=mountWelcome;'});
      await page.evaluate(({appId,welcome})=>window.handle=window.mountWelcome({appId,orgId:'org_test',roots:{main:document.getElementById('root')},entitlement:{offered:true,welcome}}),{appId,welcome});
      assert.equal(await page.locator('h1').textContent(),welcome.headline.text);
      assert.equal(await page.locator('.faw-benefits li').count(),3);
      assert.equal(await page.evaluate(()=>window.activations),0,'reading the advertisement never activates the app');
      assert.equal(await page.evaluate(()=>document.querySelector('.fm-app-welcome').scrollWidth<=innerWidth),true);
      await page.screenshot({path:new URL(`${welcome.theme}-${width}.png`,output).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>document.querySelector('.faw-error').textContent);
      assert.equal(await page.locator('.faw-start').isEnabled(),true);
      assert.equal(await page.evaluate(()=>window.startedEvents),0);
      await page.evaluate(()=>window.failStart=false);
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>window.startedEvents===1);
      assert.equal(await page.evaluate(()=>window.activations),2);
      await page.close();
    }
  }finally{await browser.close();}
});

test('the runtime mounts only the welcome and keeps New without starting a tutorial',async()=>{
  const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
  const guides=await readFile(new URL('../../libraries/tab-guides/tab-guides.js',import.meta.url),'utf8');
  const module=await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();
    await page.route('https://welcome.test/**',route=>{
      const url=new URL(route.request().url());
      const body=url.pathname.endsWith('photos.js')?`window.bundleLoads=(window.bundleLoads||0)+1;FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal'],enabled:()=>false,access:{capability:'platform.project_photos'},mount(){window.operationalMounts++;}});`:url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:'<html><body><main id="root"></main></body></html>';
      return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html',body});
    });
    await page.goto('https://welcome.test/');
    await page.evaluate(welcome=>{
      window.operationalMounts=0;window.openEvents=0;
      window.Portal={currentUser:{identity:{preferences:{seen_tabs:['project.photos']}},appEntitlements:[{id:'project.photos',allowed:true,offered:true,welcome,visible:{desktop:true,mobile:true}}]}};
      window.addEventListener('fm:project-tab:opened',()=>window.openEvents++);
    },APP_WELCOMES['project.photos']);
    await page.addScriptTag({url:'https://welcome.test/runtime.js'});
    await page.addScriptTag({content:guides});
    const result=await page.evaluate(async()=>{
      FirstMateEmbeddableApps.registerManifest({id:'project.photos',surfaces:['project_modal'],bundles:['https://welcome.test/photos.js']});
      FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal']});
      const listed=FirstMateEmbeddableApps.listApps({surface:'project_modal'});
      await FirstMateEmbeddableApps.mount(document.getElementById('root'),'project.photos',{surface:'project_modal',orgId:'test'});
      FirstMateTabGuides.opened({appId:'project.photos'});
      return {count:listed.length,mounts:window.operationalMounts,events:window.openEvents,pill:FirstMateTabGuides.pill('project.photos')?.kind};
    });
    assert.deepEqual(result,{count:1,mounts:0,events:0,pill:'new'});
    assert.equal(await page.getByRole('button',{name:'Get Started'}).count(),1);
    await page.waitForFunction(()=>window.bundleLoads===1);
    assert.equal(await page.evaluate(()=>window.operationalMounts),0,'preloading registers code without mounting the offered app');
  }finally{await browser.close();}
});

// The project window keeps one handle per tab: Get Started must leave nothing of the advertisement behind, whether
// the host remounts the root (the runtime replaces the welcome), mounts the real app over it without destroying the
// welcome, or drops the panel. A tour waits for the cover (FirstMateAppWelcome.settled).
test('the advertisement is gone once the real app mounts, and the cover ends if its panel leaves the page',async()=>{
  const runtime=await readFile(new URL('../../libraries/app-runtime/firstmate-embeddable-apps.js',import.meta.url),'utf8');
  const module=await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    for(const mode of ['remount','overwrite','detached']){
      const page=await browser.newPage();
      await page.route('https://welcome.test/**',route=>{
        const url=new URL(route.request().url());
        const body=url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:'<html><body><div id="panel"><main id="root" style="height:500px"></main></div></body></html>';
        return route.fulfill({contentType:url.pathname.endsWith('.js')?'text/javascript':'text/html',body});
      });
      await page.goto('https://welcome.test/');
      await page.evaluate(({welcome,mode})=>{
        window.__APP={userOrgId:'org_test'};
        const entitlement=offered=>({id:'project.photos',allowed:true,offered,...(offered?{welcome}:{}),visible:{desktop:true,mobile:true}});
        window.PlatformAPI={request:async()=>({}),capabilities:{load:async()=>{}},appFlags:{load:async()=>{}}};
        window.Portal={currentUser:{appEntitlements:[entitlement(true)]},auth:{syncPlatformSession:async()=>{
          window.Portal.currentUser.appEntitlements=[entitlement(false)];
          const root=document.getElementById('root');
          if(mode==='remount')await FirstMateEmbeddableApps.mount(root,'project.photos',{surface:'project_modal',orgId:'org_test'});
          if(mode==='overwrite'){root.insertAdjacentHTML('beforeend','<section id="actual-app">Ready</section>');window.dispatchEvent(new CustomEvent('fm:embeddable-apps:app-mounted',{detail:{appId:'project.photos',context:{roots:{main:root},entitlement:{offered:false}}}}));}
          if(mode==='detached')document.getElementById('panel').remove();
        }}};
      },{welcome:APP_WELCOMES['project.photos'],mode});
      await page.addScriptTag({url:'https://welcome.test/runtime.js'});
      await page.evaluate(async()=>{
        FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal'],mount(context){context.roots.main.insertAdjacentHTML('beforeend','<section id="actual-app">Ready</section>');return {destroy(){}};}});
        await FirstMateEmbeddableApps.mount(document.getElementById('root'),'project.photos',{surface:'project_modal',orgId:'org_test'});
      });
      await page.getByRole('button',{name:'Get Started'}).click();
      await page.waitForFunction(()=>window.FirstMateAppWelcome&&!window.FirstMateAppWelcome.pending()&&!document.querySelector('.fm-app-welcome-cover'),null,{timeout:3000});
      assert.equal(await page.locator('.fm-app-welcome').count(),0,`${mode}: no advertisement is left`);
      if(mode!=='detached')assert.equal(await page.locator('#actual-app').count(),1,`${mode}: the real app shows`);
      assert.equal(await page.evaluate(()=>document.querySelector('.fm-app-welcome-host')),null);
      await page.close();
    }
  }finally{await browser.close();}
});
