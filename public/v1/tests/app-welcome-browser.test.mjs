import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { APP_WELCOMES } from '../platform/app-experience/offers.ts';

const source=(await readFile(new URL('../../libraries/app-runtime/app-welcome.js',import.meta.url),'utf8')).replaceAll('export function','function');
const output=new URL('../../../output/app-welcome-tests/',import.meta.url);
await mkdir(output,{recursive:true});

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
      const body=url.pathname.endsWith('app-welcome.js')?module:url.pathname.endsWith('runtime.js')?runtime:'<html><body><main id="root"></main></body></html>';
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
      FirstMateEmbeddableApps.registerApp({id:'project.photos',surfaces:['project_modal'],enabled:()=>false,access:{capability:'platform.project_photos'},mount(){window.operationalMounts++;}});
      const listed=FirstMateEmbeddableApps.listApps({surface:'project_modal'});
      await FirstMateEmbeddableApps.mount(document.getElementById('root'),'project.photos',{surface:'project_modal',orgId:'test'});
      FirstMateTabGuides.opened({appId:'project.photos'});
      return {count:listed.length,mounts:window.operationalMounts,events:window.openEvents,pill:FirstMateTabGuides.pill('project.photos')?.kind};
    });
    assert.deepEqual(result,{count:1,mounts:0,events:0,pill:'new'});
    assert.equal(await page.getByRole('button',{name:'Get Started'}).count(),1);
  }finally{await browser.close();}
});
