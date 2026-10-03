import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
test('named invitations are discoverable, required, recoverable and responsive',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://partners.test/**',r=>r.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:0;background:#f8fafc}*{box-sizing:border-box}</style><main id="app"></main>'}));await page.goto('https://partners.test/');
 await page.evaluate(()=>{
 window.calls=[];window.Portal={cfg:{orgId:'local'},apps:{registerPortalApp:a=>window.app=a}};
 window.PlatformTerminology={get:k=>k.endsWith('.partners')?'Subcontractors':'Subcontractor'};
 window.FirstMateEmbeddableApps={escapeHtml:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')};
 const invitation={id:'invite',owner_org_id:'local',label:'Acme Roofing',email:'roofing@example.test',status:'pending',partner_onboarding:true,revision:1,created_at:'2026-10-03T12:00:00Z',expires_at:'2099-10-10T12:00:00Z'};
 const url='/portal/#collaboration_invite='+'a'.repeat(43);
 window.PlatformAPI={request:async(urlValue,options={})=>{
 const path=new URL(urlValue).pathname.split('/local')[1];window.calls.push({path,...options});
 if(path==='/partners')return {items:[]};
 if(path==='/partner-invitations')return {invitation:{...invitation},url};
 if(path==='/invitations')return {items:[{...invitation}]};
 if(path==='/invitations/invite/link')return {invitation:{...invitation},url};
 if(path==='/invitations/invite/send'){invitation.delivery={status:'captured'};return {invitation:{...invitation},delivery:invitation.delivery};}
 throw Error(path);
 }};
 });
 for(const file of ['app-runtime/app-chrome.js','doc-widgets/firstmate-doc-widgets.js','apps/partners/app.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+file,import.meta.url),'utf8')});
 await page.evaluate(()=>window.app.mount(document.querySelector('#app')));
 await page.getByRole('button',{name:'Invitations',exact:true}).click();
 await page.getByRole('button',{name:'Add subcontractor',exact:true}).first().click();
 assert.equal(await page.locator('select[name=relationship]').count(),0);
 await page.getByRole('button',{name:'Create invitation'}).click();
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),0);
 await page.getByLabel('Subcontractor name').fill('Acme Roofing');await page.getByLabel('Subcontractor email').fill('roofing@example.test');
 await page.getByRole('button',{name:'Create invitation'}).click();await page.getByLabel('Invitation link',{exact:true}).waitFor();
 assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.path==='/partner-invitations').body),{name:'Acme Roofing',email:'roofing@example.test'});
 const qr=await page.getByLabel('Invitation QR code').boundingBox();assert.ok(qr.width>=240);
 const svg=await page.locator('.invitation-qr svg').boundingBox();assert.ok(svg.width>=220);
 const out=new URL('../../../output/partner-invitations-20261003/',import.meta.url);await mkdir(out,{recursive:true});
 await page.screenshot({path:fileURLToPath(new URL('invitation-desktop.png',out)),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:fileURLToPath(new URL('invitation-mobile.png',out)),fullPage:true});
 await page.getByRole('button',{name:'Send invitation email'}).click();await page.getByText('Email captured in the development message log',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Back to invitations'}).click();await page.getByRole('button',{name:'View invitation'}).click();
 assert.ok(await page.getByLabel('Invitation link',{exact:true}).isVisible());assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
