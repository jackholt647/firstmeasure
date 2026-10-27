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
