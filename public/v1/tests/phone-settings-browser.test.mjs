import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('phone settings saves personal, routing, attribution and port drafts with usable mobile layout',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1360,height:950}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 const state={ok:true,can_manage:true,can_bill:true,carrier_writes:false,user_id:'alice',personal:{revision:0},messaging:{revision:0},people:[{id:'alice',name:'Alice'},{id:'bob',name:'Bob'}],departments:[{id:'sales',name:'Sales'}],groups:[],sms_profiles:[],lines:[{phone_number:'+12065550199',label:'Main',status:'active',can_manage:true}]};
 await page.route('https://settings.test/**',async route=>{
 const r=route.request(),url=new URL(r.url());if(url.pathname==='/'){return route.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:24px;background:#f8fafc}</style><div id="root"></div>'});}
 const payload=r.postDataJSON();if(payload)writes.push({path:url.pathname,body:payload});
 let response=state;if(url.pathname.endsWith('/personal')&&payload){state.personal={...payload,revision:1};response={ok:true};}
 if(url.pathname.endsWith('/ports'))response={ok:true,ports:[],orders:[],carrier_writes:false};
 if(url.pathname.includes('/tracking'))response={ok:true,sources:[],calls:[],leads:[]};
 if(url.pathname.endsWith('/voicemail'))response={ok:true,messages:[]};
 if(url.pathname.endsWith('/billing'))response={ok:true,health:{usage_last_24_hours:[]},numbers:[]};
 if(url.pathname.endsWith('/voice/status'))response={ok:true,settings:{timezone:'America/Los_Angeles',business_hours:[],holidays:[]}};
 await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
 });
 await page.goto('https://settings.test');await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/phone.js',import.meta.url),'utf8')});
 await page.evaluate(async()=>{window.Portal={navigation:{push:r=>window.lastRoute=r}};await FirstMatePhoneSettings.mount(document.querySelector('#root'),{orgId:'fixture',registration:async el=>{el.textContent='Existing 10DLC registration';}});});
 await page.getByLabel('Your voicemail greeting',{exact:true}).fill('You reached Alice. Please leave a message.');await page.getByLabel('Text messages',{exact:true}).uncheck();await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();
 assert.equal(writes.find(r=>r.path.endsWith('/personal')).body.notifications.texts,false);
 await page.evaluate(()=>window.scrollTo(0,0));await mkdir(new URL('../../../output/phone-settings/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/phone-settings/personal-desktop.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});
 await page.getByRole('button',{name:'Numbers & Users',exact:true}).click();await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByLabel('Line name',{exact:true}).fill('Google roofing campaign');await page.getByLabel('Alice',{exact:true}).check();await page.getByLabel('Customize this line’s routing',{exact:true}).check();await page.getByLabel('Ring strategy',{exact:true}).selectOption('simultaneous');await page.getByLabel('Use this as a tracking number',{exact:true}).check();await page.getByLabel('Source (for example, Google Ads)',{exact:true}).fill('Google Ads');await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();
 const line=writes.find(r=>r.path.includes('/lines/'));assert.equal(line.body.routing.strategy,'simultaneous');assert.equal(line.body.tracking.source,'Google Ads');assert.deepEqual(line.body.user_ids,['alice']);
 await page.getByRole('button',{name:'Number Porting',exact:true}).click();await page.getByLabel('Number to port (+country code)',{exact:true}).fill('+12065550199');await page.getByLabel('Line name',{exact:true}).fill('Existing main');await page.getByRole('button',{name:'Create port request',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();assert.ok(writes.some(r=>r.path.endsWith('/ports')&&r.body.phone_number==='+12065550199'));
 await page.getByRole('button',{name:'10DLC Registration',exact:true}).click();await page.getByText('Existing 10DLC registration').waitFor();
 await page.getByRole('button',{name:'Billing & Usage',exact:true}).click();await page.getByRole('button',{name:'Open Billing',exact:true}).click();assert.equal(await page.evaluate(()=>window.lastRoute.sub),'billing');
 await page.getByRole('button',{name:'My Phone',exact:true}).click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:new URL('../../../output/phone-settings/personal-mobile.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
