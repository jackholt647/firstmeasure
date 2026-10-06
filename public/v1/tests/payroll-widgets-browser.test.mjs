import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('payroll tab and agent widgets share native views, independent filters, typed actions and denial cleanup',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://widgets.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.json')?'application/json':'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html',body:'<style>body{font-family:Arial;margin:20px}#a,#b,#tab{height:650px;margin:12px 0}#a,#b{max-width:600px}</style><div id="a"></div><div id="b"></div><div id="tab"></div>'});});
  await page.goto('https://widgets.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'alice'};window.apps={};window.calls=[];window.denied=false;window.confirm=()=>true;
   window.FirstMateEmbeddableApps={registerApp:def=>apps[def.id]=def};window.AppChrome={registerGroup:()=>{},resolve:(_a,v)=>v||'upcoming',header:o=>`<header><h2>${o.title}</h2>${o.tabs||''}</header>`,tabs:(_a,view,attr)=>['upcoming','timesheets','contractors','exports','history','settings'].map(v=>`<button ${attr}="${v}">${v}</button>`).join(''),settings:()=>''};
   window.FirstMatePayrollSettings={mount:root=>{root.innerHTML='<p>Shared payroll settings</p>';return {destroy(){root.replaceChildren();}};}};
   window.earning={id:'entry',payee:{type:'organization_user',id:'alice',name:'Alice'},project_id:'p',project_title:'Roof',kind:'commission',state:'accrued',amount_cents:12345,remaining_cents:12345,currency:'USD',eligible_at:'2026-10-01'};
   window.dashboard={schedules:[],upcoming:[],history:[],policies:[],diagnostics:[]};
   window.PlatformAPI={publication:{read:async(org,source)=>{if(denied)return {status:'denied',message:'Access revoked'};return {status:'ready',value:source.export==='records'?[structuredClone(earning)]:source.export==='my_earnings'||source.export==='earnings'?{earnings:[{subject:earning.payee,currency:'USD',totals:{projected_cents:100,owed_cents:12345,in_payroll_cents:0,paid_cents:500},projects:[{title:'Roof',currency:'USD',totals:{projected_cents:100,owed_cents:12345,paid_cents:500}}],payments:[]}],truncated:false}:source.export==='timesheets'?{timesheets:[]}:source.export==='batches'?[]:source.export==='contractors'?{users:[],connections:[]}:dashboard};},invoke:async(org,action,target,input,options)=>{calls.push({org,action,target,input,options});if(denied)throw Error('Access revoked');return {receipt:{status:'succeeded'},value:action==='payroll.timesheets.list'?{timesheets:[],summary:{}}:action==='payroll.contractors.list'?{users:[],connections:[]}:action==='payroll.exports.catalog'||action==='payroll.artifacts.list'?[]:action==='payroll.schedule.create'?{id:'s',...input}:dashboard};}}};
  });
  for(const script of ['platform-widgets/runtime.js','platform-widgets/payroll-widgets.js','payroll-api/payroll-api.js','apps/payroll/app.js'])await page.addScriptTag({url:'https://widgets.test/libraries/'+script});
  await page.evaluate(async()=>{await FirstMateWidgets.ready;window.a=FirstMateWidgets.mount(document.querySelector('#a'),{id:'payroll.upcoming',version:'1',target:{scope:'organization',organizationId:'org'},config:{from:'2026-10-01',through:'2026-10-10'}},{surface:'assistant'});window.b=FirstMateWidgets.mount(document.querySelector('#b'),{id:'payroll.upcoming',version:'1',target:{scope:'organization',organizationId:'org'},config:{from:'2026-11-01',through:'2026-11-10'}},{surface:'assistant'});await Promise.all([a.ready,b.ready]);window.tab=apps['portal.payroll'].mount({root:document.querySelector('#tab'),orgId:'org'});});
  await page.locator('#a #fmpRangeFrom').waitFor();
  assert.equal(await page.locator('#a #fmpRangeFrom').inputValue(),'2026-10-01');assert.equal(await page.locator('#b #fmpRangeFrom').inputValue(),'2026-11-01');
  await page.locator('#a #fmpRangeFrom').fill('2026-10-02');await page.locator('#a [data-action="apply-range"]').click();await page.waitForFunction(()=>calls.some(c=>c.input.from==='2026-10-02'));assert.equal(await page.locator('#b #fmpRangeFrom').inputValue(),'2026-11-01');
  await page.evaluate(()=>PayrollAPI.schedules.create('org',{name:'Weekly',recurrence:{frequency:'weekly',weekday:5}}));const mutation=await page.evaluate(()=>calls.find(c=>c.action==='payroll.schedule.create'));assert.ok(mutation.options.idempotencyKey);assert.equal(mutation.target.scope,'organization');
  for(const view of ['timesheets','contractors','exports','history','settings']){await page.locator(`#tab [data-payroll-view="${view}"]`).click();await page.locator(`#tab .fm-widget[data-sizing="fill"]`).waitFor();}
  await page.locator('#tab').getByText('Shared payroll settings').waitFor();
  await page.evaluate(async()=>{b.destroy();window.b=FirstMateWidgets.mount(document.querySelector('#b'),{id:'payroll.ledger',version:'1',target:{scope:'organization',organizationId:'org'},config:{}},{surface:'assistant'});await b.ready;});
  await page.locator('#b').getByText('Alice',{exact:true}).waitFor();await page.locator('#b').getByLabel('Search payroll').fill('not-found');await page.locator('#b').getByText('No matching payroll records.').waitFor();await page.locator('#b').getByLabel('Search payroll').fill('');
  await mkdir(new URL('../../../output/payroll-integration-20261006/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/payroll-integration-20261006/widgets-desktop.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
  await page.setViewportSize({width:390,height:900});await page.screenshot({path:new URL('../../../output/payroll-integration-20261006/widgets-mobile.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
  await page.evaluate(()=>{window.denied=true;window.dispatchEvent(new Event('fm:payroll:updated'));});await page.locator('#b').getByText('Access revoked').waitFor();assert.equal(await page.locator('#b').getByText('Alice',{exact:true}).count(),0);
  await page.evaluate(()=>{a.destroy();b.destroy();tab.destroy();});assert.equal(await page.locator('.fm-widget').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
