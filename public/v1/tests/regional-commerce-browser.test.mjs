import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const commercePath=fileURLToPath(new URL('../../libraries/platform-commerce/platform-commerce.js',import.meta.url));
test('currency formatting, reference estimates and stale prices are independent of language',async()=>{
  const root={Intl};vm.runInNewContext(await readFile(commercePath,'utf8'),root);
  const api=root.PlatformCommerce;
  assert.throws(()=>api.credit(14),/still loading/);
  api.set({currency:'USD',credit_display:'credits',report_prices:{residential:14},exchange:{rate:150,currency:'JPY'}});
  assert.equal(api.credit(14),'14 credits');assert.match(api.cash(30),/30\.00 USD/);assert.match(api.estimate(30),/4,500/);
  assert.equal(api.credit(14,{currency:'EUR',credit_display:'currency'}),'€14.00');
  assert.equal(api.credit(-7,{currency:'USD',credit_display:'currency'}),'-$7');
  assert.throws(()=>api.set({currency:'USD',credit_display:'credits',report_prices:{residential:21}}),/Prices changed/);
});

test('regional billing and report add-ons render the correct units on desktop and mobile',async()=>{
  const {chromium}=await import('playwright-core');
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  const output=path.resolve('../../output/regional-billing-ui');await mkdir(output,{recursive:true});
  try{
    for(const [country,currency,display,multiplier] of [['US','USD','currency',1],['FR','EUR','currency',2],['JP','USD','credits',2]]){
      const page=await browser.newPage({viewport:{width:1280,height:950}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.setContent('<html><body style="font-family:Arial;margin:20px"><main id="billing"></main><section id="report" hidden></section></body></html>');
      await page.addScriptTag({path:commercePath});
      await page.evaluate(({currency,display,multiplier})=>{
        const prices={residential:7*multiplier,gutters:2*multiplier,weather:5*multiplier};
        window.PlatformCommerce.set({currency,credit_display:display,minor_digits:2,report_prices:prices,exchange:display==='credits'?{currency:'JPY',rate:150}:null});
        window.Portal={modules:{},util:{},commerce:window.PlatformCommerce};
        const price={id:'agents_v1',product_id:'agents',name:'AI tools',description:'Tools for your team',monthly_cents:3000*multiplier,currency,minor_digits:2,rates:[]};
        const data={currency,minor_digits:2,exchange:display==='credits'?{currency:'JPY',rate:150}:null,can_manage:true,operator:false,account:{},prices:[price],subscriptions:[{id:'sub',product_id:'agents',price}],purchases:[],invoices:[],recurring_invoices:[],estimate:{total_cents:0,lines:[]},meters:[],late_usage:[]};
        window.PlatformAPI={baseUrl:()=>'/v1/platform',request:async()=>structuredClone(data)};
        window.creditOptions={statement:async()=>({ok:true,transactions:[]}),settings:()=>({enabled:true,amount:50,threshold:25,card:'Visa ending in 4242'}),open:()=>{},refreshBalance:()=>{document.querySelectorAll('.credits-val-target').forEach(el=>el.textContent=PlatformCommerce.credit(100));}};
      },{currency,display,multiplier});
      await page.addScriptTag({path:fileURLToPath(new URL('../../libraries/apps/settings/platform-billing.js',import.meta.url))});
      await page.addScriptTag({path:fileURLToPath(new URL('../../libraries/apps/firstmeasure/order/app.js',import.meta.url))});
      await page.evaluate(async()=>{
        await FirstMatePlatformBilling.mountWorkspace(document.getElementById('billing'),{orgId:'fixture',credits:creditOptions});
        document.getElementById('report').innerHTML=Portal.modules.firstMeasureOrder.panelHtml({services:{firstMeasureOrder:{gutterReportAddon:()=>PlatformCommerce.price('gutters'),weatherReportAddon:()=>PlatformCommerce.price('weather')}}});
      });
      const text=await page.locator('#billing').innerText();assert.ok(!/international|multiplier|domestic/i.test(text));
      assert.ok(text.includes(country==='FR'?'€60.00':country==='US'?'$30.00 USD':'$60.00 USD'));
      assert.ok(text.includes(country==='FR'?'€100.00':country==='US'?'$100':'100 credits'));
      if(country==='JP')assert.match(text,/Approximately.*9,000/);
      const addon=await page.locator('[data-addon-price="gutters"]').textContent();assert.equal(addon,country==='FR'?'+€4.00':country==='US'?'+$2':'+4 credits');
      for(const width of [1280,390]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,`${country}-${width}.png`),fullPage:true});}
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();}
});
