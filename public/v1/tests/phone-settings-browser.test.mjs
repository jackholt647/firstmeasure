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
 if(url.pathname.endsWith('/reputation'))response={ok:true,configured:true,carrier_writes:false,settings:{status:'approved',loa_status:'approved'},numbers:[{phone_number:'+12065550199',monitored:true,reputation_data:{spam_risk:'high',connection_score:42}}]};
 if(url.pathname.endsWith('/ports'))response={ok:true,ports:[],orders:[],carrier_writes:false};
 if(url.pathname.includes('/tracking'))response={ok:true,sources:[],calls:[],leads:[]};
 if(url.pathname.endsWith('/voicemail'))response={ok:true,messages:[]};
 if(url.pathname.endsWith('/billing'))response={ok:true,health:{usage_last_24_hours:[]},numbers:[]};
 if(url.pathname.endsWith('/voice/status'))response={ok:true,settings:{timezone:'America/Los_Angeles',business_hours:[],holidays:[]}};
 await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
 });
 await page.goto('https://settings.test');await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/phone.js',import.meta.url),'utf8')});
 await page.evaluate(async()=>{window.Portal={navigation:{push:r=>window.lastRoute=r}};await FirstMatePhoneSettings.mount(document.querySelector('#root'),{orgId:'fixture',registration:async el=>{el.textContent='Existing 10DLC registration';}});});
 await page.getByLabel('Automatically leave a prerecorded message',{exact:true}).check();await page.locator('[name=drop_media]').evaluate(e=>e.value='recording-fixture');await page.getByLabel('Balance power-dial calls across these numbers',{exact:true}).check();await page.locator('[name=pool_numbers]').check();await page.getByLabel('Balance calls by',{exact:true}).selectOption('least_used');
 await page.getByLabel('Your voicemail greeting',{exact:true}).fill('You reached Alice. Please leave a message.');await page.getByLabel('Text messages',{exact:true}).uncheck();await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();
 assert.equal(writes.find(r=>r.path.endsWith('/personal')).body.notifications.texts,false);assert.equal(writes[0].body.voicemail_drop.media_id,'recording-fixture');assert.equal(writes[0].body.power_dial.strategy,'least_used');assert.deepEqual(writes[0].body.power_dial.numbers,['+12065550199']);
 await page.evaluate(()=>window.scrollTo(0,0));await mkdir(new URL('../../../output/phone-settings/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/phone-settings/personal-desktop.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});
 await page.getByRole('button',{name:'Numbers & Users',exact:true}).click();await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByLabel('Line name',{exact:true}).fill('Google roofing campaign');await page.getByLabel('Alice',{exact:true}).check();await page.getByLabel('Customize this line’s routing',{exact:true}).check();await page.getByLabel('Ring strategy',{exact:true}).selectOption('simultaneous');await page.getByLabel('Use this as a tracking number',{exact:true}).check();await page.getByLabel('Source (for example, Google Ads)',{exact:true}).fill('Google Ads');await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();
 const line=writes.find(r=>r.path.includes('/lines/'));assert.equal(line.body.routing.strategy,'simultaneous');assert.equal(line.body.tracking.source,'Google Ads');assert.deepEqual(line.body.user_ids,['alice']);
 await page.getByRole('button',{name:'Number Porting',exact:true}).click();await page.getByLabel('Number to port (+country code)',{exact:true}).fill('+12065550199');await page.getByLabel('Line name',{exact:true}).fill('Existing main');await page.getByRole('button',{name:'Create port request',exact:true}).click();await page.getByText('Changes saved.',{exact:true}).waitFor();assert.ok(writes.some(r=>r.path.endsWith('/ports')&&r.body.phone_number==='+12065550199'));
 await page.getByRole('button',{name:'Number Reputation',exact:true}).click();await page.getByText('high',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Fresh check',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'Sync carrier results',exact:true}).click();
 await page.getByRole('button',{name:'10DLC Registration',exact:true}).click();await page.getByText('Existing 10DLC registration').waitFor();
 await page.getByRole('button',{name:'Billing & Usage',exact:true}).click();await page.getByRole('button',{name:'Open Billing',exact:true}).click();assert.equal(await page.evaluate(()=>window.lastRoute.sub),'billing');
 await page.getByRole('button',{name:'My Phone',exact:true}).click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:new URL('../../../output/phone-settings/personal-mobile.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});


test('reputation onboarding collects details, signs authorization, reports approvals and enrolls without billing',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1100,height:950}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const state={ok:true,can_manage:true,can_bill:false,carrier_writes:true,user_id:'owner',personal:{},people:[],departments:[],groups:[],lines:[{phone_number:'+12025550100',label:'Main',status:'active',can_manage:true}]};
 const rep={ok:true,configured:false,carrier_writes:true,account:null,settings:{},numbers:[],industries:['business'],remediation:[],operations:[],operator:false};
 await page.route('https://onboarding.test/**',async route=>{
 const req=route.request(),url=new URL(req.url());if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:16px}</style><div id="root"></div>'});
 assert.ok(!/stripe|platform-billing|subscription/.test(url.pathname),'No billing requests');const body=req.postDataJSON();if(body)writes.push({path:url.pathname,body});let result=state;
 if(url.pathname.endsWith('/phone/reputation'))result=rep;
 if(url.pathname.endsWith('/reputation/business')){rep.account={profile:body.profile,revision:1,status:'draft'};result={ok:true};}
 if(url.pathname.endsWith('/reputation/register')){rep.configured=true;rep.account.status='registered';result={ok:true};}
 if(url.pathname.endsWith('/authorization/render')){rep.account.loa_version='document-version';result={ok:true,file:Buffer.from('%PDF-1.7 fixture').toString('base64'),version:'document-version'};}
 if(url.pathname.endsWith('/reputation/authorization')){rep.account.signed_at='2026-10-12';rep.account.signer_name=body.signer_name;rep.settings={status:'pending',loa_status:'pending'};result={ok:true};}
 if(url.pathname.endsWith('/phone/reputation')&&body?.action==='monitor')rep.numbers=[{phone_number:'+12025550100',monitored:true,reputation_data:{spam_risk:'low'}}];
 if(url.pathname.endsWith('/voice/status'))result={ok:true,settings:{}};
 await route.fulfill({contentType:'application/json',body:JSON.stringify(result)});
 });
 await page.goto('https://onboarding.test');await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/phone.js',import.meta.url),'utf8')});await page.evaluate(()=>FirstMatePhoneSettings.mount(document.querySelector('#root'),{orgId:'fixture',initialTab:'reputation'}));
 await page.getByLabel('Registered legal business name',{exact:true}).fill('Example LLC');await page.getByLabel('Public business name (DBA)',{exact:true}).fill('Example');await page.getByLabel('State or province of incorporation',{exact:true}).fill('Washington');await page.getByLabel('Business website',{exact:true}).fill('https://example.test');
 for(const key of ['organization_contact','billing_contact'])for(const [k,v]of Object.entries({first_name:'Jane',last_name:'Example',email:'jane@example.test',phone_number:'+12025550100',...(key==='organization_contact'?{job_title:'Owner'}:{})}))await page.locator(`[name="${key}.${k}"]`).fill(v);
 for(const key of ['organization_physical_address','billing_address'])for(const [k,v]of Object.entries({street_address:'100 Test St',city:'Seattle',administrative_area:'WA',postal_code:'98101'}))await page.locator(`[name="${key}.${k}"]`).fill(v);
 await page.getByRole('button',{name:'Save business details',exact:true}).click();await page.getByLabel('Federal EIN (for example, 12-3456789)',{exact:true}).fill('12-3456789');await page.getByRole('button',{name:'Register business with Telnyx',exact:true}).click();
 await page.getByRole('button',{name:'Download authorization',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-form="rep-sign"] button:not([type])').disabled);
 await page.getByLabel('Authorized signer’s full name',{exact:true}).fill('Jane Example');const canvas=page.locator('[data-signature]');await canvas.scrollIntoViewIfNeeded();const box=await canvas.boundingBox();await page.mouse.move(box.x+20,box.y+40);await page.mouse.down();await page.mouse.move(box.x+100,box.y+65,{steps:8});await page.mouse.up();
 await page.getByText('I reviewed the authorization and am authorized to sign for this business.',{exact:true}).click();await page.getByText('I accept the Telnyx reputation-service terms and authorize carrier activation and its fees.',{exact:true}).click();await page.getByRole('button',{name:'Submit signed authorization',exact:true}).click();await page.getByText('Business approval: pending · Authorization: pending',{exact:true}).waitFor();
 const submit=writes.find(x=>x.path.endsWith('/reputation/authorization'));assert.equal(submit.body.signer_name,'Jane Example');assert.equal(submit.body.authorized,true);assert.ok(writes.some(x=>x.path.endsWith('/authorization/render')&&x.body.signature));
 rep.settings={status:'approved',loa_status:'approved',check_frequency:'never'};await page.getByRole('button',{name:'Sync carrier results',exact:true}).click();await page.getByRole('button',{name:'Enroll number',exact:true}).click();await page.getByText('low',{exact:true}).waitFor();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await mkdir(new URL('../../../output/reputation-onboarding/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/reputation-onboarding/mobile.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1'),fullPage:true});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
