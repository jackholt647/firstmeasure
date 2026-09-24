import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';

test('unified subscription controls show tiers, allowances, automatic payments and credit-inclusive statements',{skip:process.env.SKIP_BILLING_BROWSER==='1'},async()=>{
 let executablePath;for(const candidate of ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium'])try{await access(candidate);executablePath=candidate;break;}catch{}
 assert.ok(executablePath);const browser=await chromium.launch({executablePath,headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1366,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<body style="font-family:Arial;margin:32px"><main id="billing"></main></body>');
 await page.evaluate(()=>{
 const basic={id:'sms_v1',product_id:'sms',plan_key:'basic',name:'SMS Basic',description:'Customer conversations and project updates.',highlights:['1,000 outgoing messages each month','Sending pauses at the allowance. No overage charges.'],monthly_cents:3000,rates:[],published:true,version:1};
 const advanced={...basic,id:'sms_v2',plan_key:'advanced',name:'SMS Advanced',monthly_cents:10000,version:2,highlights:['5,000 outgoing messages each month']};
 const now=new Date().toISOString(),end=new Date(Date.now()+30*86400000).toISOString();
 window.fixture={can_manage:true,has_customer:true,payment_details:{has_payment_method:true,status:'active'},account:{enforce:true},prices:[basic,advanced],subscriptions:[{id:'subscription',product_id:'sms',price:basic,starts_at:now,ends_at:null,paid_through:end}],sms_allowance:{used:1000,limit:1000,paused:true,renews_at:end},invoices:[{id:'usage',period:now.slice(0,7),status:'open',total_cents:800,created_at:now,lines:[{label:'Usage',amount_cents:800}]}],recurring_invoices:[],purchases:[],estimate:{lines:[],total_cents:0},storage:null,late_usage:[],meters:[]};
 window.PlatformAPI={baseUrl:()=>'/v1/platform',appFlags:{load:async()=>{}},request:async(url,options)=>{
 if(url.includes('/subscription-quotes'))return {quote:{id:'quote',price:advanced,replaces_id:'subscription',subscription_id:'sub',items:[{name:'SMS Advanced',monthly_cents:10000,added:true}],current_monthly_cents:3000,new_monthly_cents:10000,due_now_cents:3500,renewal_at:end}};
 if(url.endsWith('/cancel'))window.fixture.subscriptions[0].ends_at=end;
 if(url.endsWith('/resume'))window.fixture.subscriptions[0].ends_at=null;
 return structuredClone(window.fixture);
 }};
 });
 await page.addScriptTag({path:path.resolve('../libraries/apps/settings/platform-billing.js')});
 await page.evaluate(()=>window.FirstMatePlatformBilling.mountWorkspace(document.querySelector('#billing'),{orgId:'fixture',credits:{settings:()=>({enabled:true,amount:100,threshold:50,card:'Visa •••• 4242'}),refreshBalance:()=>{document.querySelector('.credits-val-target').textContent='$75.00';},statement:async()=>({ok:true,transactions:[]}),open:()=>{}}}));
 await page.getByText('Sending paused.',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'Pay invoice',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'Manage payment details'}).count(),1);assert.equal(await page.getByRole('heading',{name:'Monthly statement'}).count(),1);
 await mkdir('../../output/subscription-service/ui',{recursive:true});await page.screenshot({path:'../../output/subscription-service/ui/desktop.png',fullPage:true});
 await page.getByRole('button',{name:'Change plan',exact:true}).click();await page.getByText('SMS Enterprise',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Current plan'}).isDisabled(),true);
 await page.screenshot({path:'../../output/subscription-service/ui/plans.png',fullPage:true});await page.getByRole('button',{name:'Review change',exact:true}).click();
 await page.getByRole('heading',{name:'Due today'}).waitFor();const text=await page.locator('.pb dialog').innerText();for(const value of ['$30.00','$100.00','$35.00','Prorated difference'])assert.ok(text.includes(value));
 await page.screenshot({path:'../../output/subscription-service/ui/review.png',fullPage:true});await page.getByRole('button',{name:'Back',exact:true}).click();
 page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Cancel renewal'}).click();await page.getByRole('button',{name:'Resume renewal'}).click();await page.getByRole('button',{name:'Cancel renewal'}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'../../output/subscription-service/ui/mobile.png',fullPage:true});await page.evaluate(()=>{window.fixture.prices.push({...window.fixture.prices[0],id:'storage_v1',product_id:'storage',name:'Storage 10 GB'});void window.FirstMatePlatformBilling.choose({orgId:'fixture',productId:'storage'});});
 await page.getByRole('heading',{name:'Choose a plan'}).waitFor();await page.getByRole('heading',{name:'Storage 10 GB'}).waitFor();assert.equal(await page.getByRole('button',{name:'Review plan',exact:true}).count(),1);await page.getByRole('button',{name:'Back',exact:true}).click();assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
