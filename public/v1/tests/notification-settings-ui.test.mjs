import { chromium } from 'playwright-core';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import http from 'node:http';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const executable=process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('notification settings registration, retry, grouping, delete and responsive controls', {skip:!existsSync(executable)}, async()=>{
const source=await fs.readFile(path.join(root,'public/libraries/apps/settings/company.js'),'utf8');
const start=source.indexOf('    async function renderNotificationSettings(){');
const render=source.slice(start,source.indexOf("    window.Portal?.navigation?.registerHandler?.('company-settings'",start));
const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/html');try{res.end(req.url.endsWith('.js')?await fs.readFile(path.join(root,'public',req.url)):'<style>body{font-family:Arial;margin:16px}.cs-btn{padding:7px 12px;border:1px solid #ddd;border-radius:8px;background:white;cursor:pointer}</style><div id="csPaneNotifications" style="height:800px"></div>');}catch{res.statusCode=404;res.end();}}).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const browser=await chromium.launch({executablePath:executable,headless:true});
try{
 const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(()=>{
 window.paneNotifications=document.querySelector('#csPaneNotifications');window.currentOrgId=()=> 'org';window.currentBranchId=()=> 'default';window.escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');window.FirstMateAgentChat={injectBaseCss(){}};
 window.records=[];window.patches=[];const metadata={source:'documents',group:'signatures',tab:'documents'};
 window.PlatformAPI={notifications:{
 rules:async()=>({events:[{event:'document.signed',label:'Document signed',description:'A document was signed.',notification:metadata,source_label:'Documents',tag_path:'payload.document_tags',group_paths:['project_id','payload.document_id']}],tags:[{id:'proposal',label:'Proposal',archived:false},{id:'old',label:'Old',archived:true}],scopes:[{id:'roof',label:'Roofing'}],document_workflows:[{id:'roof-doc',label:'Roofing proposal workflow'}],rules:records,history:[]}),
 preferences:async()=>({catalog:[{id:'legacy.messages',kind:'app',label:'Messages',definitions:[{key:'messages',label:'Messages',description:'Incoming messages'}]},{id:'scope.roof',kind:'workflow',label:'Roofing',definitions:[{key:'workflow.roof',label:'Scope progress',description:'Scope progress'}]},{id:'automation',kind:'workflow',label:'Automation',definitions:[{key:'workflow.auto',label:'Flow update',description:'Flow update'}]},{id:'events.document',kind:'app',label:'Documents',definitions:[{key:'event.document.signed',event:'document.signed',label:'Document signed',description:'Signed',...metadata}]},{id:'personal',kind:'custom',definitions:records.map(r=>({key:'workflow.'+r.id,rule_id:r.id,label:r.title,description:r.intent,event:r.event,group_id:'signatures',group_label:'Signatures'}))}],preferences:{in_app:Object.fromEntries(['messages','workflow.roof','workflow.auto',...records.map(r=>'workflow.'+r.id)].map(k=>[k,true])),push:{},email:{},sms:{},toast:{},audio:{},celebration:{},in_app_sound:{'event.document.signed':true,messages:true},in_app_bell:{messages:false},in_app_badge:{messages:true}}}),
 savePreferences:async(org,patch)=>patches.push(patch),
 addRegistration:async(org,input)=>{window.created=input;if(!window.attempts){window.attempts=1;throw Error('Temporary save failure');}records.push({...input,id:'custom_1',intent:'Signed proposals',enabled:true,filters:[],source:'return {outputs:{}};',revision:1});return {ok:true};},
 saveRule:async(org,rule)=>{window.savedRule=rule;records[0]={...rule,revision:rule.revision+1};return {rule:records[0]};},
 deleteRule:async(org,id,revision)=>{window.deleted={id,revision};records=[];return {ok:true};},saveQuietHours:async(org,value)=>{window.quietSaved=value;return {ok:true};}
 },notificationAssistant:{context:async()=>({settings:{enabled:false}})}};
 });
 await page.evaluate('(async()=>{'+render+'\nawait renderNotificationSettings();})()');
 assert.equal(await page.locator('[data-nc-tab]').count(),6);
 assert.equal(await page.locator('[data-nc-tab=settings]').count(),0,'Settings is separate from categories');
 assert.equal(await page.locator('[data-nc-chat]').count(),0);
 assert.equal((await page.locator('[data-nc-settings]').innerText()).trim(),'');
 await page.locator('[data-nc-tab=workflows]').click();assert.equal(await page.locator('.nc-card').count(),2,'Flows and scopes share Workflows');await page.locator('[data-nc-tab=all]').click();
 const toolbar=await page.locator('.nc-toolbar').evaluate(el=>[...el.children].map(child=>child.getBoundingClientRect().top));assert.ok(Math.max(...toolbar)-Math.min(...toolbar)<8,'desktop toolbar stays on one row');
 await page.locator('[data-nc-add]').click();await page.locator('dialog').waitFor();
 const modal=await page.locator('dialog').boundingBox();assert.ok(modal.width>=780);assert.ok(modal.y>=0&&modal.y+modal.height<=850);
 assert.equal(await page.locator('[data-event-description]').getAttribute('title'),'A document was signed.');
 assert.equal(await page.locator('dialog [data-scope-selector]').isVisible(),false);
 await page.screenshot({path:path.join(root,'output/notification-registration-20260929/add-refined.png')});
 await page.locator('[data-close]').click();await page.waitForFunction(()=>!document.querySelector('dialog'));
 await page.locator('[data-nc-add]').click();await page.locator('dialog').waitFor();await page.mouse.click(5,5);await page.waitForFunction(()=>!document.querySelector('dialog'));
 await page.locator('[data-nc-add]').click();await page.locator('dialog').waitFor();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog'));

 await page.locator('[data-nc-settings]').click();assert.equal(await page.locator('.nc-body').isVisible(),false);assert.equal(await page.locator('[data-nc-add]').isVisible(),false);assert.equal(await page.locator('[data-delivery-rules]').count(),0);
 assert.equal(await page.locator('[data-notification-org-settings]').count(),1);
 await page.locator('[data-quiet-form] input[name=enabled]').check();await page.waitForFunction(()=>quietSaved?.enabled);await page.locator('[data-quiet-form] select[name=timezone]').selectOption('America/New_York');await page.waitForFunction(()=>quietSaved.timezone==='America/New_York');assert.equal(await page.locator('[data-quiet-form] button[type=submit]').count(),0);
 assert.equal(await page.locator('[data-quiet-form] input[name=enabled]').evaluate(el=>getComputedStyle(el).opacity),'0','native checkbox is visually hidden behind switch');
 await fs.mkdir(path.join(root,'output/notification-registration-20260929'),{recursive:true});
 await page.screenshot({path:path.join(root,'output/notification-registration-20260929/settings-panel.png')});
 await page.locator('[data-nc-tab=all]').click();assert.equal(await page.locator('.nc-body').isVisible(),true);

 assert.equal(await page.locator('[data-notification-key="event.document.signed"]').count(),0,'unselected events hidden');
 await page.locator('[data-nc-add]').click();await page.locator('dialog').waitFor();
 assert.equal(await page.locator('dialog input[name=tag]').count(),1);
 await page.locator('dialog input[name=tag]').check();await page.locator('dialog input[value=sms]').check();
 await page.locator('dialog select[name=document_workflow]').selectOption('roof-doc');await page.locator('dialog select[name=group_path]').selectOption('payload.document_id');await page.locator('dialog select[name=group_alert]').selectOption('first');
 await page.locator('dialog button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('dialog [role=status]').textContent==='Temporary save failure');assert.equal(await page.locator('dialog input[name=tag]').isChecked(),true);await page.locator('dialog button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('dialog'));
 assert.deepEqual(await page.evaluate(()=>created.tags),['proposal']);assert.equal(await page.evaluate(()=>created.document_workflow_id),'roof-doc');
 assert.equal(await page.locator('[data-nc-tab=custom]').getAttribute('aria-pressed'),'true');assert.ok(await page.locator('.nc-heading').textContent().then(t=>t.includes('Signatures')));
 await page.locator('[data-nc-advanced="workflow.custom_1"]').click();
 await page.locator('input[data-notification-surface=email]').check();await page.waitForFunction(()=>patches.length>0);
 assert.equal(await page.evaluate(()=>patches.at(-1).email['workflow.custom_1']),true);
 assert.equal(await page.locator('[data-nr-rule],[data-nr-definition]').count(),0);
 assert.equal(await page.locator('.nc-rule-summary').innerText(),'Signed proposals');
 await page.locator('[data-nc-advanced="workflow.custom_1"]').click();assert.equal(await page.locator('.nc-rule-summary').isVisible(),true);await page.locator('[data-nc-advanced="workflow.custom_1"]').hover();
 await page.waitForTimeout(60);
 const tip=await page.locator('[id="nc-advanced-tip-workflow.custom_1"]').boundingBox(),trigger=await page.locator('[data-nc-advanced="workflow.custom_1"] svg').boundingBox();assert.ok(Math.abs(trigger.y-(tip.y+tip.height)-7)<1,'tooltip is close to its trigger '+JSON.stringify({tip,trigger}));
 await page.locator('[data-nc-advanced="workflow.custom_1"]').click();
 const centered=await page.locator('.nc-mode svg').first().evaluate(svg=>{const a=svg.getBoundingClientRect(),b=svg.parentElement.getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2);});assert.ok(centered<.5,'mode icon vertically centered');
 const size=await page.locator('.nc-mode').evaluate(el=>el.getBoundingClientRect().height);assert.equal(size,18);

 await page.screenshot({path:path.join(root,'output/notification-registration-20260929/toolbar-refined.png')});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow');
 assert.equal(await page.locator('.nc-assistant').isVisible(),true);await page.locator('[data-nr-delete]').click();await page.waitForFunction(()=>window.deleted);await page.waitForFunction(()=>!document.querySelector('[data-nr-delete]'));
 assert.equal(await page.evaluate(()=>deleted.revision),1);assert.deepEqual(errors,[]);
 await page.evaluate(()=>{ const prior=PlatformAPI.notifications.preferences; PlatformAPI.notifications.preferences=async()=>({...await prior(),permissions:{personal:false,organization:false}}); const rules=PlatformAPI.notifications.rules; PlatformAPI.notifications.rules=async()=>({...await rules(),permissions:{personal:false},rule_locks:{locked:'full'},rules:[{id:'locked',intent:'Organization delivery rule',enabled:true}]}); });
 await page.evaluate('(async()=>{'+render+'\nawait renderNotificationSettings();})()');
 await page.locator('[data-nc-settings]').click();
 assert.equal(await page.locator('[data-quiet-form] input[name=enabled]').isDisabled(),true);
 assert.equal(await page.locator('[data-rule-id=locked]').count(),0);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile settings overflow');
 await page.screenshot({path:path.join(root,'output/notification-registration-20260929/settings-mobile-locked.png')});

 await page.setViewportSize({width:1200,height:850});
 await page.evaluate(()=>{
  window.notificationAdmin=true;window.lockMode='unlocked';
  const prior=PlatformAPI.notifications.preferences;
  PlatformAPI.notifications.preferences=async()=>({...await prior(),permissions:{personal:true,organization:notificationAdmin},configuration_revision:1,catalog:[{id:'legacy.messages',kind:'app',label:'Messages',definitions:[{key:'messages',label:'Messages',description:'Incoming messages',personal:true,lock_mode:lockMode,editable:notificationAdmin||lockMode!=='full',removable:notificationAdmin||lockMode==='unlocked'}]}]});
  PlatformAPI.notifications.rules=async()=>({permissions:{personal:true,organization:notificationAdmin},locks_revision:0,rules:[],events:[],history:[]});
  PlatformAPI.notifications.defaults=async()=>({revision:0});
  PlatformAPI.notifications.resetDefaults=async(org,revision)=>{window.defaultReset=revision;return {revision:2};};
  PlatformAPI.notifications.saveDefaults=async(org,revision)=>{window.defaultSaved=revision;return {revision:1};};
  PlatformAPI.notifications.saveLock=async(org,patch)=>{window.savedLock=patch;window.lockMode=patch.mode;return {revision:1};};
 });
 await page.evaluate('(async()=>{'+render+'\nawait renderNotificationSettings();})()');
 await page.locator('[data-nc-settings]').click();await page.locator('[data-nr-publish]').click();
 assert.equal(await page.evaluate(()=>defaultSaved),0);await page.locator('[data-nr-reset]').click();await page.waitForFunction(()=>window.defaultReset===1);
 await page.locator('[data-nc-tab=all]').click();await page.locator('[data-nc-advanced=messages]').click();
 await page.locator('[data-nr-mode=full]').click();
 await page.waitForFunction(()=>window.savedLock);assert.equal(await page.evaluate(()=>savedLock.key),'messages');
 await page.waitForFunction(()=>document.querySelector('[data-nr-mode=full]')?.getAttribute('aria-pressed')==='true');
 await page.screenshot({path:path.join(root,'output/notification-registration-20260929/admin-locks.png')});
 await page.evaluate(()=>notificationAdmin=false);
 await page.evaluate('(async()=>{'+render+'\nawait renderNotificationSettings();})()');
 await page.locator('[data-nc-advanced=messages]').click();
 assert.equal(await page.locator('[data-notification-surface=push]').isDisabled(),true);
 assert.equal(await page.locator('[data-nr-definition]').count(),0);
 assert.equal(await page.locator('[data-nr-delete]').count(),0);
 assert.equal(await page.locator('[data-nr-lock]').count(),0);
 assert.deepEqual(errors,[]);
 console.log('PASS tabs, source/tag/scope selection, grouping, custom creation, independent methods, source-preserving edit, deletion, compact size, mobile layout');
}finally{await browser.close();server.close();}

});
