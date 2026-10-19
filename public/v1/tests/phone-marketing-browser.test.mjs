import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const launch=()=>chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
test('website tracking preserves attribution through tagless navigation, swaps text/tel and restores on consent withdrawal',async()=>{
 const browser=await launch();try{const page=await browser.newPage(),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));let number='+12025550100';
 await page.route('https://roofing.test/**',r=>r.fulfill({contentType:'text/html',body:'<a href="tel:+12025550101">+12025550101</a><span data-phone-tracking>+12025550101</span>'}));
 await page.route('https://tracking.test/**',r=>{if(r.request().method()==='OPTIONS')return r.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'https://roofing.test','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'POST'}});calls.push({url:r.request().url(),body:r.request().postDataJSON()});return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://roofing.test'},body:JSON.stringify({number,status:number==='+12025550101'?'exhausted':'assigned',session_id:'visit-1'})});});
 const script=await readFile(new URL('../../libraries/phone-tracking/website.js',import.meta.url),'utf8');
 async function install(){await page.addScriptTag({content:script});await page.evaluate(()=>{window.allowTracking=false;window.tracker=FirstMateCallTracking.init({api:'https://tracking.test/v1/comms',organization:'org',pool:'pool',fallback:'+12025550101',consent:()=>window.allowTracking});});}
 await page.goto('https://roofing.test/?utm_source=google&utm_campaign=summer');await install();assert.equal(calls.length,0);
 await page.evaluate(()=>{window.allowTracking=true;document.dispatchEvent(new Event('firstmate:tracking-consent'));});await page.waitForFunction(()=>document.querySelector('a').getAttribute('href')==='tel:+12025550100');const key=calls[0].body.visitor_key;await page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<a id="late-phone" href="tel:+12025550101">Call us</a>'));await page.waitForFunction(()=>document.querySelector('#late-phone').getAttribute('href')==='tel:+12025550100');
 await page.goto('https://roofing.test/services');await install();await page.evaluate(()=>{window.allowTracking=true;document.dispatchEvent(new Event('firstmate:tracking-consent'));});await page.waitForFunction(()=>document.querySelector('span').textContent==='+12025550100');assert.equal(calls[1].body.visitor_key,key);
 number='+12025550102';await page.evaluate(()=>window.tracker.refresh());await page.waitForFunction(()=>document.querySelector('a').getAttribute('href')==='tel:+12025550102');
 await page.evaluate(()=>{window.allowTracking=false;document.dispatchEvent(new Event('firstmate:tracking-consent'));});assert.equal(await page.locator('a').getAttribute('href'),'tel:+12025550101');assert.equal(await page.locator('span').textContent(),'+12025550101');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('Phone Settings creates website sources/pools and broadcast drafts, audiences, previews and launches',async()=>{
 const browser=await launch();try{const page=await browser.newPage({viewport:{width:1100,height:900}}),writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const lines=[{phone_number:'+12025550100',label:'Website number',status:'active',can_manage:true},{phone_number:'+12025550101',label:'Main number',status:'active',can_manage:true}];
 const settings={ok:true,can_manage:true,can_bill:false,carrier_writes:false,personal:{},lines,people:[],departments:[],groups:[],user_id:'manager'};
 const marketing={ok:true,sources:[],pools:[],broadcasts:[],senders:[{id:'sender',label:'Main number',address:'+12025550101'}]};let audience=false;
 await page.route('https://settings.test/**',async r=>{const req=r.request(),url=new URL(req.url());if(url.pathname==='/')return r.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:16px}</style><div id="root"></div>'});const body=req.postDataJSON();if(body)writes.push({url:url.pathname,body});let result=settings;
 if(url.pathname.endsWith('/marketing'))result=marketing;
 if(url.pathname.includes('/sources/')){marketing.sources=[{id:'search',revision:1,...body}];result={ok:true};}
 if(url.pathname.includes('/website-pools/')&&req.method()==='PUT'){marketing.pools=[{...body,id:url.pathname.split('/').at(-1),revision:1}];result={ok:true};}
 if(url.pathname.endsWith('/visits'))result={ok:true,items:[]};
 if(/\/broadcasts\/[^/]+$/.test(url.pathname)&&req.method()==='PUT'){marketing.broadcasts=[{...body,id:url.pathname.split('/').at(-1),status:'draft',revision:1}];result={ok:true};}
 if(url.pathname.endsWith('/report'))result={ok:true,counts:{total:audience?1:0,pending:audience?1:0,sent:0,delivered:0,failed:0,skipped:0,replied:0,opted_out:0},last_error:''};
 if(url.pathname.endsWith('/marketing/contacts'))result={ok:true,items:[{project_id:'contacts',contact_id:'alice',name:'Alice Example'}]};
 if(url.pathname.endsWith('/audience')){audience=true;marketing.broadcasts[0].revision++;result={ok:true,added:1,duplicates:0,invalid:0};}
 if(url.pathname.endsWith('/recipients'))result={ok:true,items:audience?[{id:'recipient',name:'Alice Example',address:'+12025550200',state:'pending',reason:'',deliveries:[]}]:[]};
 if(url.pathname.endsWith('/preview'))result={ok:true,eligible:1,skipped:0,total:1,reasons:{},samples:[{name:'Alice',text:'Hello Alice',eligible:true}]};
 if(url.pathname.endsWith('/control')){marketing.broadcasts[0].status='running';result={ok:true};}
 assert.ok(!/platform-billing|subscription|stripe/.test(url.pathname));await r.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('https://settings.test');for(const f of ['phone-marketing.js','phone.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/'+f,import.meta.url),'utf8')});await page.evaluate(()=>FirstMatePhoneSettings.mount(document.querySelector('#root'),{orgId:'fixture',initialTab:'website'}));
 await page.getByLabel('Source reference',{exact:true}).fill('search');await page.getByLabel('Source name',{exact:true}).fill('Google Ads');await page.getByRole('button',{name:'Create lead source',exact:true}).click();
 await page.getByRole('button',{name:'Create website pool',exact:true}).click();await page.getByLabel('Pool name',{exact:true}).fill('Roofing website');await page.getByText('Enable website number assignment',{exact:true}).click();await page.locator('input[name="number:+12025550100"]').check();await page.getByLabel('Fallback business number',{exact:true}).selectOption('+12025550101');await page.getByLabel('Allowed website origins (one HTTPS address per line)',{exact:true}).fill('https://roofing.test');await page.getByLabel('Default lead source',{exact:true}).selectOption('search');await page.getByRole('button',{name:'Save website pool',exact:true}).click();await page.getByRole('button',{name:'Website setup',exact:true}).click();assert.match(await page.getByLabel('Website snippet',{exact:true}).inputValue(),/data-organization="fixture"/);
 await page.getByRole('button',{name:'SMS Broadcasts',exact:true}).click();await page.getByRole('button',{name:'Create campaign',exact:true}).click();await page.getByLabel('Campaign name',{exact:true}).fill('Summer offer');await page.getByLabel('Message',{exact:true}).fill('Hello {{first_name}}');await page.getByLabel('Sending hours use',{exact:true}).selectOption('schedule');await page.getByRole('button',{name:'Save campaign draft',exact:true}).click();
 await page.getByLabel('Search contacts',{exact:true}).fill('Alice');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByText('Alice Example',{exact:true}).first().click();await page.getByRole('button',{name:'Add selected contacts',exact:true}).click();await page.getByRole('button',{name:'Preview eligibility',exact:true}).click();await page.getByText('1 eligible · 0 skipped · 1 total',{exact:true}).waitFor();await page.getByRole('button',{name:'Start',exact:true}).click();await page.getByText('running',{exact:true}).waitFor();
 assert.equal(writes.find(w=>w.url.endsWith('/control')).body.confirmed,true);assert.equal(writes.find(w=>w.url.includes('/website-pools/')).body.fallback_number,'+12025550101');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await mkdir(new URL('../../../output/phone-marketing/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/phone-marketing/mobile.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
