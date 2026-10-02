import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('partner assignment setup enables only selected types and keeps exposure explicit',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://assign.test/**',r=>r.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:0;background:#f8fafc}*{box-sizing:border-box}</style><main id="app"></main>'}));await page.goto('https://assign.test/');
 await page.evaluate(()=>{
 window.calls=[];window.Portal={cfg:{orgId:'local'},apps:{registerPortalApp:a=>window.app=a}};
 window.PlatformAPI={request:async(url,options={})=>{
 const path=new URL(url).pathname.split('/local')[1];window.calls.push({path,...options});
 if(path==='/partners')return {items:[{id:'rel',recipient_org_id:'other',organization:{name:'Acme Roofing'},connection:{status:'active'},classification:'partner'}]};
 if(path==='/engagements')return {items:[{id:'job',title:'Roof job',owner_org_id:'local',recipient_org_id:'other',status:'accepted',revision:2}]};
 if(path==='/engagements/job/assignment-options')return {relationship_id:'rel',items:[{id:'external_team',name:'Acme / Roofing Team One'}]};
 if(path==='/engagements/job/schedule')return {event_id:'scheduled'};
 if(path==='/partners/rel/assignments'&&options.method==='PUT')return {ok:true};
 if(path==='/partners/rel/assignments')return {partner:{name:'Acme Roofing'},settings:{revision:0,mappings:[],exposure:{organization:true,group_kind_ids:[],group_ids:[],fields:[],include_future:false}},local_kinds:[{id:'crew',name:'Crews'},{id:'inspection',name:'Inspection Teams'}],local_groups:[{id:'north',kind_id:'crew',name:'North Crew'}],available:{organization:true,kinds:[{id:'roofers',name:'Roofing Teams'}],groups:[{id:'roof1',kind_id:'roofers',name:'Roofing Team One'}]}};
 throw Error(path);
 }};
 });
 await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/partners/app.js',import.meta.url),'utf8')});await page.evaluate(()=>window.app.mount(document.querySelector('#app')));
 await page.getByRole('button',{name:'Assignments',exact:true}).click();
 await page.getByText('No group types currently allow partner assignments.',{exact:false}).waitFor();
 await page.locator('summary').filter({hasText:/^Crews$/}).click();
 assert.equal(await page.locator('[data-map-options=crew]').isVisible(),false);
 await page.locator('[name=map][value=crew]').check();
 assert.equal(await page.locator('[name=org_crew]').isChecked(),true);
 await page.locator('[name=types_crew][value=roofers]').check();
 assert.equal(await page.locator('[data-team-kind=crew]').isVisible(),false);
 await page.locator('[name=expose_kind][value=crew]').check();
 await page.locator('[name=expose_group][value=north]').check();
 await mkdir(new URL('../../../output/partner-assignments-20261002/',import.meta.url),{recursive:true});
 await page.screenshot({path:new URL('../../../output/partner-assignments-20261002/assignments-desktop.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:new URL('../../../output/partner-assignments-20261002/assignments-mobile.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await page.getByRole('button',{name:'Save assignments'}).click();await page.waitForFunction(()=>window.calls.some(c=>c.method==='PUT'));
 const payload=await page.evaluate(()=>window.calls.find(c=>c.method==='PUT').body);
 assert.deepEqual(payload.enable_kind_ids,['crew']);assert.deepEqual(payload.mappings,[{local_kind_id:'crew',organization:true,group_kind_ids:['roofers']}]);assert.deepEqual(payload.exposure.group_ids,['north']);assert.deepEqual(payload.exposure.fields,[]);assert.equal(payload.exposure.include_future,false);assert.deepEqual(errors,[]);
 await page.getByRole('button',{name:'Work',exact:true}).click();await page.getByRole('button',{name:'Schedule',exact:true}).click();
 assert.equal(await page.locator('select[name=assignment]').inputValue(),'external_team');
 await page.locator('[name=start]').fill('2026-10-15T10:00');await page.locator('[name=end]').fill('2026-10-15T11:00');
 await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.waitForFunction(()=>window.calls.some(c=>c.path.endsWith('/schedule')));
 assert.equal(await page.evaluate(()=>window.calls.find(c=>c.path.endsWith('/schedule')).body.assignment_id),'external_team');

 }finally{await browser.close();}
});
