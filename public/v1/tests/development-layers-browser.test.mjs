import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
// The dev console's Setup, Software layers, Synthetic data and Leads sections (libraries/dev-console) on desktop and a phone.
test('dev console: scope-filtered nested contracts and synthetic data fit desktop and mobile',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const leadPosts=[],testCalls=[],saved=[],resets=[];const layers={items:[{id:'projects.profile',layer:'data',origin:'Projects',declarationScope:'global',scopes:['project'],details:{schema:{type:'object',properties:{address:{type:'object',properties:{city:{type:'string'}}}}}}},{id:'custom-fields-project.roof',layer:'data',origin:'Custom fields',declarationScope:'organization',scopes:['project'],details:{schema:{type:'number'}}},{id:'doc.audio',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.video',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}},{id:'doc.media.gallery',layer:'widgets',origin:'Documents',declarationScope:'global',scopes:['project'],details:{schema:{type:'object'}}}],projects:[{id:'project',label:'Roof project'}],notes:['Declarations only.']};
  const at='2026-11-17T15:04:00Z',setupState={steps:[
   {id:'company.type',scope:'organization',title:'What kind of company are you?',requires:[],status:'done',answered_in:{experience_id:'documents.setup',experience_title:'Set up Documents',on_its_own:false,by:'Jack Holt',at},last:null,last_type:'step_done',asked_by:['Set up Documents']},
   {id:'company.services',scope:'organization',title:'What kind of work do you do?',requires:['company.type'],status:'done',answered_in:null,last:null,last_type:null,asked_by:[]},
   {id:'company.sales_team',scope:'organization',title:'Who does the sales in your company?',requires:['company.type'],status:'skipped',answered_in:null,last:{experience_id:'appointments.setup',experience_title:'Set up your appointments',on_its_own:false,by:'Jack Holt',at},last_type:'step_skip',asked_by:['Set up your appointments']}],
   guides:[{id:'appointments.setup',title:'Set up your appointments',kind:'modal',scope:'organization',group:'setup',status:'started',step:{id:'company.sales_team',title:'Who does the sales in your company?'},started_at:at,updated_at:at,finished_at:null,finished_by:'',asks:[]},
   {id:'comms.setup',title:'Set up texts, calls and email',kind:'modal',scope:'organization',group:'setup',status:'done',step:null,started_at:at,updated_at:at,finished_at:at,finished_by:'Jack Holt',asks:[]},
   {id:'operations.setup',title:'Set up Operations',kind:'modal',scope:'organization',group:'setup',status:'skipped',step:null,started_at:at,updated_at:at,finished_at:at,finished_by:'Jack Holt',asks:[]},
   {id:'docs.tab_tutorial',title:'Docs tour',kind:'overlay',scope:'person',group:'tour',status:'not_started',step:null,started_at:null,updated_at:null,finished_at:null,finished_by:'',asks:[]}]};
  await page.route('http://development.test/**',async route=>{const url=new URL(route.request().url()),p=url.pathname,json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,...data})});
   if(p==='/libraries/setup-steps/fm571-stub.js')return route.fulfill({contentType:'application/javascript',body:"export function mount(el,ctx){el.innerHTML='<button type=\"button\" data-stub-pick>Roofing</button>';let picked=false;el.querySelector('[data-stub-pick]').onclick=()=>{picked=true;ctx.change({company_type:'roofing_contractor'},'Roofing');};return{valid:()=>picked,answer:()=>({company_type:'roofing_contractor'}),summary:()=>'Roofing',destroy(){}};}"});
   if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.css')?'text/css':p.endsWith('.html')?'text/html':'application/javascript',body:await readFile(new URL('../../libraries/'+p.slice(11),import.meta.url),'utf8')});
   const testCall=p.match(/^\/v1\/signup-sandbox\/development\/console\/setup\/steps\/([^/]+)\/(test|test\/end|rollback)$/);
   if(testCall){testCalls.push(`${testCall[1]} ${testCall[2]}`);
    if(testCall[2]==='test')return json({experience:{id:'setup_step.company.type',version:1,kind:'modal',scope:'organization',title:{key:'gx_t',text:'What kind of company are you?'},replayable:true,variant:{id:'default',bucket:0,unit:'u'},triggers:[],progress:null,completion:{action:null,screen:'none',say:[],then:[]},steps:[{id:'company.type',title:{key:'gx_step_company_type_title',text:'What kind of company are you?'},widget:'module',module:'/libraries/setup-steps/fm571-stub.js',options:{},say:[],selects:[],required:true,next:null,setup_step:{id:'company.type',version:1,writes:{action:'company-profile.save',target:'organization'},injected_for:''}}]},test:{status:'open'}});
    if(testCall[2]==='test/end'){setupState.steps[0].test={step_id:'company.type',status:'ended',first_started_at:at,tests:1,ended_at:at,changes:[{branch_id:'default',module:'company_profile',key:'company_type'}]};return json({test:setupState.steps[0].test});}
    setupState.steps[0].test=null;return json({restored:['company_profile.company_type'],events:2});
   }
   if(p.startsWith('/v1/publication/')){if(p.endsWith('/actions/invoke'))saved.push(route.request().postDataJSON());return json({result:{status:'ready',value:{}}});}
   if(p.startsWith('/v1/platform/'))return json({});
   if(/^\/v1\/guided-experiences\/organizations\/[^/]+\/dev\/reset$/.test(p)){resets.push(`${p.split('/')[4]} ${JSON.stringify(route.request().postDataJSON())}`);return json({progress:1});}
   if(p.startsWith('/v1/guided-experiences/'))return json({experiences:[]});
   if(p==='/v1/signup-sandbox/development/console/setup')return json(setupState);
   if(p==='/v1/signup-sandbox/development/console')return json({sections:{setup:true,test_run:false,synthetic_data:true,synthetic_leads:true,software_layers:true,guided:false,live:false}});
   if(p==='/v1/signup-sandbox/development/software-layers')return json(url.searchParams.get('projectId')?{...layers,items:layers.items.filter(item=>item.declarationScope==='organization')}:layers);
   if(p==='/v1/signup-sandbox/development/synthetic-leads'){
    if(route.request().method()==='GET')return json({max:25,fields:[{id:'name',label:'Name',icon:'fa-user',default:true},{id:'phone',label:'Phone',icon:'fa-phone',default:true},{id:'source',label:'Source',icon:'fa-bullhorn',default:true},{id:'note',label:'Note',icon:'fa-comment',default:false}],sources:[{id:'google',label:'Paid › Google Ads',channel:'paid'}]});
    leadPosts.push(route.request().postDataJSON());
    return json({created:2,skipped:0,leads:[{project_id:'p1',name:'Avery Chen',phone:'(312) 555-0142',email:'',address:'',source:'',matched:false},{project_id:'p2',name:'Quinn Ward',phone:'(415) 555-0107',email:'',address:'',source:'',matched:true,routed:'Sales › New Lead'}]});
   }
   if(p==='/v1/signup-sandbox/development')return json({companies:[{id:'roofing',label:'Roofing'}],categories:[{id:'projects',label:'Projects',icon:'fa-house'}]});
   return route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><style>body{margin:0;font:14px Verdana,sans-serif}</style><main>App</main>'});
  });
  await page.goto('http://development.test');
  await page.evaluate(async()=>{await(await import('/libraries/dev-console/dev-console.js')).mount();});
  await page.locator('.fm-dc-strip').click();
  // Setup (FM-571): first in the rail and opened first; each question says where it was answered, on hover and on a tap.
  assert.deepEqual(await page.locator('[data-dc-section]').evaluateAll(els=>els.slice(0,2).map(el=>el.dataset.dcSection)),['setup','leads']);
  await page.locator('[data-dc-setup-row="step:company.type"]').waitFor();
  assert.match(await page.locator('[data-dc-setup-row="step:company.type"]').innerText(),/Answered in Set up Documents[\s\S]*Done/);
  assert.match(await page.locator('[data-dc-setup-row="step:company.type"]').getAttribute('title'),/^Answered in Set up Documents by Jack Holt, /);
  assert.match(await page.locator('[data-dc-setup-row="step:company.services"]').innerText(),/Answered outside a guided setup/);
  assert.match(await page.locator('[data-dc-setup-row="step:company.sales_team"]').innerText(),/Skipped in Set up your appointments[\s\S]*Skipped/);
  assert.match(await page.locator('[data-dc-setup-row="guide:appointments.setup"]').innerText(),/Last at Who does the sales in your company\?[\s\S]*Started/);
  assert.equal(await page.locator('.fm-dc-setup-tours').evaluate(el=>el.open),false,'tours are folded');
  await page.locator('[data-dc-setup-row="step:company.sales_team"]').click();
  assert.match(await page.locator('[data-dc-setup-row="step:company.sales_team"] .fm-dc-setup-more').innerText(),/Asked after: What kind of company are you\?/);
  // Test (FM-571): the question in an overlay, played by the real setup player in a frame, saved, then rolled back.
  await page.evaluate(()=>{window.__APP={userOrgId:'org_t',userId:'u1'};});
  await page.locator('[data-dc-setup-test="company.type"]').click();
  const overlay=page.locator('.fm-dc-test');await overlay.waitFor();
  const frame=page.frameLocator('.fm-dc-test iframe');
  await frame.locator('[data-stub-pick]').click();
  await overlay.locator('[data-test-state]').filter({hasText:'Testing'}).waitFor();
  // Desktop switches the frame between widths without restarting the step.
  await overlay.locator('[data-test-device="phone"]').click();
  await page.waitForFunction(()=>Math.round(document.querySelector('.fm-dc-test iframe').getBoundingClientRect().width)<=390);
  assert.equal(await frame.locator('[data-stub-pick]').count(),1,'still on the step');
  assert.ok(await frame.locator('body').evaluate(()=>innerWidth<=390),'the step lays out as on a phone');
  await frame.getByRole('button',{name:/continue|finish|done/i}).last().click();
  await overlay.locator('[data-test-state]').filter({hasText:'Answered.'}).waitFor();
  assert.deepEqual(testCalls,['company.type test','company.type test/end']);
  assert.ok(saved.some(body=>JSON.stringify(body).includes('roofing_contractor')),'the answer was saved through its action');
  await overlay.locator('[data-test-rollback]:not([hidden])').waitFor();
  // The first press says what it restores (in place: the portal's confirm dialog could be under the overlay).
  await overlay.locator('[data-test-rollback]').click();
  assert.match(await overlay.locator('[data-test-state]').innerText(),/Roll back restores company_profile \(company_type\)/);
  assert.deepEqual(testCalls,['company.type test','company.type test/end'],'nothing rolled back yet');
  await overlay.locator('[data-test-rollback]').click();
  await overlay.locator('[data-test-state]').filter({hasText:'Rolled back'}).waitFor();
  assert.equal(testCalls.at(-1),'company.type rollback');
  await overlay.locator('[data-test-close]').click();
  assert.equal(await page.locator('.fm-dc-test').count(),0);
  setupState.steps[0].test={step_id:'company.type',status:'ended',first_started_at:at,tests:2,ended_at:at,changes:[{branch_id:'default',module:'company_profile',key:'company_type'}]};
  await page.locator('[data-dc-setup-reload]').click();
  await page.locator('[data-dc-setup-rollback="company.type"]').click();
  assert.match(await page.locator('.fm-dc-setup-confirm').innerText(),/Roll back restores company_profile \(company_type\)/);
  await page.locator('[data-dc-setup-rollback-now="company.type"]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-dc-setup-rollback="company.type"]'));
  assert.equal(testCalls.at(-1),'company.type rollback');
  // Guided setups (FM-589): a finished setup plays again from its row, as a replay when it allows one; one that allows
  // none (not offered once finished) is reset first and plays as new. Reset alone clears its progress.
  await page.evaluate(()=>{window.__plays=[];window.__listed=new Set(['comms.setup','appointments.setup']);window.FirstMateGuides={refresh:async()=>null,experience:(id)=>window.__listed.has(id)?{id}:null,isPlaying:()=>false,play:async(id,options)=>{window.__plays.push([id,options]);return{status:'completed'};}};
   // The portal's spare project window: laid out but hidden, so nothing plays in it.
   const spare=document.createElement('iframe');spare.style.visibility='hidden';document.body.append(spare);spare.contentWindow.FirstMateGuides={...window.FirstMateGuides,play:async()=>{window.__plays.push(['spare frame']);return{status:'completed'};}};});
  assert.match(await page.locator('[data-dc-setup-row="guide:comms.setup"]').innerText(),/Finished by Jack Holt[\s\S]*Run again[\s\S]*Reset[\s\S]*Done/);
  assert.match(await page.locator('[data-dc-setup-play="appointments.setup"]').innerText(),/Continue/);
  await page.locator('[data-dc-setup-play="comms.setup"]').click();
  await page.waitForFunction(()=>window.__plays.length===1);
  assert.deepEqual(await page.evaluate(()=>window.__plays),[['comms.setup',{replay:true,force:true}]]);
  assert.deepEqual(resets,[],'a replay resets nothing');
  await page.locator('[data-dc-setup-play="operations.setup"]').click();
  await page.waitForFunction(()=>window.__plays.length===2);
  assert.deepEqual(resets,['org_t {"experience_id":"operations.setup","scope":"me"}']);
  assert.deepEqual(await page.evaluate(()=>window.__plays[1]),['operations.setup',{replay:false,force:true}]);
  await page.locator('[data-dc-setup-reset="comms.setup"]').click();
  await page.getByText(/^Reset: it plays as new/).waitFor();
  assert.equal(resets.at(-1),'org_t {"experience_id":"comms.setup","scope":"me"}');
  assert.equal(await page.locator('[data-dc-setup-reset="docs.tab_tutorial"]').count(),0,'tours keep their tools in Guided experiences');
  await page.evaluate(()=>{delete window.FirstMateGuides;});
  await page.locator('[data-dc-section="layers"]').click();await page.getByText('5 of 5 declarations',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-namespace="doc"]').count(),1);
  assert.equal(await page.getByText('doc.audio',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc"]>summary').click();await page.getByText('doc.audio',{exact:true}).waitFor();
  assert.equal(await page.getByText('doc.media.gallery',{exact:true}).count(),0);
  await page.locator('[data-namespace="doc.media"]>summary').click();await page.getByText('doc.media.gallery',{exact:true}).waitFor();
  await page.locator('[data-namespace="projects"]>summary').click();
  await page.locator('[data-namespace="projects"] .fm-dev-layer-row>summary').click();await page.getByText('schema {2}',{exact:true}).click();await page.getByText('properties {1}',{exact:true}).click();await page.getByText('address {2}',{exact:true}).waitFor();
  // The console takes the page's font.
  const family=await page.evaluate(()=>getComputedStyle(document.body).fontFamily);
  for(const selector of ['.fm-dc-head h2','[data-layer]','[data-search]','.fm-dev-layer-contract','.fm-dev-json summary'])assert.equal(await page.locator(selector).first().evaluate(el=>getComputedStyle(el).fontFamily),family,selector);
  await page.locator('[data-search]').fill('city');assert.equal(await page.locator('.fm-dev-namespace').count(),1);await page.locator('[data-search]').fill('');await page.locator('[data-scope]').selectOption('organization');assert.equal(await page.locator('.fm-dev-namespace').count(),1);
  await page.locator('[data-project]').selectOption('project');await page.getByText('1 of 1 declarations',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  // The tray settles across the phone a frame after the resize.
  await page.waitForFunction(()=>{const r=document.querySelector('.fm-dc').getBoundingClientRect();return r.left===0&&r.right===innerWidth;},null,{timeout:3000}).catch(()=>assert.fail('across the phone'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll');
  await page.locator('[data-dc-section="setup"]').click();
  // Opening the section reads the setup state again and redraws it, so the row is read once it is drawn.
  await page.waitForFunction(()=>{const el=document.querySelector('[data-dc-setup-row="step:company.sales_team"]');return el&&el.getClientRects().length&&el.getBoundingClientRect().right<=innerWidth&&el.querySelector('.fm-dc-badge').getBoundingClientRect().top<el.querySelector('small').getBoundingClientRect().bottom;},null,{timeout:3000}).catch(()=>assert.fail('a setup row keeps its badge beside it on a phone'));
  await page.locator('[data-dc-section="synthetic"]').click();await page.locator('[data-dev-generate]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-dev-category="projects"]').isChecked(),true);
  // Leads (FM-552): near the top, count defaults to 1, the chosen fields and source are sent, the leads are listed.
  assert.deepEqual(await page.locator('[data-dc-section]').evaluateAll(els=>els.slice(0,3).map(el=>el.dataset.dcSection)),['setup','leads','org-state']);
  await page.locator('[data-dc-section="leads"]').click();await page.locator('[data-dev-lead-add]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-dev-lead-count]').inputValue(),'1');
  assert.equal(await page.locator('[data-dev-lead-add]').innerText(),'Add a lead');
  assert.equal(await page.locator('[data-dev-lead-field="note"]').isChecked(),false);
  await page.locator('[data-dev-lead-source]').selectOption('google');
  await page.locator('[data-dev-lead-count]').fill('2');assert.equal(await page.locator('[data-dev-lead-add]').innerText(),'Add 2 leads');
  await page.locator('[data-dev-lead-count]').fill('0');assert.equal(await page.locator('[data-dev-lead-add]').isDisabled(),true);
  await page.locator('[data-dev-lead-count]').fill('2');
  for(const id of ['name','phone'])await page.locator(`[data-dev-lead-field="${id}"]`).uncheck({force:true});
  assert.equal(await page.locator('[data-dev-lead-add]').isDisabled(),true,'a lead needs something besides a source');
  await page.locator('[data-dev-lead-field="phone"]').check({force:true});
  await page.locator('[data-dev-lead-add]').click();await page.getByText('2 leads added',{exact:true}).waitFor();
  assert.equal(leadPosts.length,1);
  assert.deepEqual({...leadPosts[0],request_id:typeof leadPosts[0].request_id},{count:2,fields:{name:false,phone:true,source:true,note:false},source_id:'google',request_id:'string'});
  await page.getByText('Quinn Ward').waitFor();await page.getByText(/Routed to Sales › New Lead · matched an existing contact/).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways scroll in Leads');
  await page.screenshot({path:process.env.LEADS_SCREENSHOT||'/dev/null'}).catch(()=>{});
  await page.locator('.fm-dc-fold').click();assert.equal(await page.locator('.fm-dc').isVisible(),false);assert.equal(await page.locator('.fm-dc-strip').isVisible(),false,'a phone has no strip: a shake opens the dev tray');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
