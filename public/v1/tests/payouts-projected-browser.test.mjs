import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The payee's own Earnings app (portal.crew_payouts and project.crew_payouts) shows a Projected section from
// payroll.projectedEarnings.me when, and only when, the access profile grants it (the projected_enabled parameter).
test('the payouts app lists projected earnings by job with expected dates, and hides them without the permission',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://payouts.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><div id="portal"></div><div id="project"><div data-crew-project-app="payouts"></div></div>'});});
  await page.goto('https://payouts.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'ana'};window.apps={};window.calls=[];window.deny=false;
   window.FirstMateEmbeddableApps={registerApp:def=>apps[def.id]=def,escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])};
   window.Portal={apps:{registerPortalApp:def=>apps[def.id]=def},util:{injectCSS:()=>{}},navigation:{registerHandler:()=>{}}};
   const earning=(id,project,title,cents,on,extra={})=>({id,projected:true,payee:'organization_user:ana',rule_id:'committed_labor',rule_name:'Committed labor lists',kind:'piece_rate',unit:id,line:'main',amount_cents:cents,description:'Committed labor',expected_on:on,expected_at:on?on+'T22:00:00.000Z':'',expected_from:on?'schedule_event':'',project_id:project,project_title:title,record_title:'Labor '+id,projected_from:'commitment',...extra});
   window.projection={payee:{type:'organization_user',id:'ana'},payee_name:'Ana',as_of:'2026-06-30T12:00:00.000Z',projected:true,total_cents:170000,
    earnings:[earning('c_open','p1','Maple St',90000,'2026-07-15'),earning('c_team','p1','Maple St',30000,'2026-07-20',{share_of:{payee:'resource_group:g1',payee_name:'Install team',line_cents:60000,method:'equal'}}),earning('list_new','p2','Oak Ave',50000,'')],
    unresolved:[{rule_id:'committed_labor',unit:'c_unpriced',reason:'This commitment has 1 line(s) with no rate.',expected_on:'2026-08-03',project_id:'p1',project_title:'Maple St'}],projects:[]};
   window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{calls.push(action);
    if(action==='payroll.earnings.me')return {receipt:{status:'succeeded'},value:{earnings:[{totals:{},projects:[],entries:[]}]}};
    if(action==='payroll.projectedEarnings.me'){if(deny)throw Object.assign(new Error('This operation is not permitted for this user.'),{status:403,code:'publication_permission_denied'});return {receipt:{status:'succeeded'},value:structuredClone(projection)};}
    return {receipt:{status:'succeeded'},value:{}};}}};
  });
  for(const script of ['payroll-api/payroll-api.js','apps/crew/app.js'])await page.addScriptTag({url:'https://payouts.test/libraries/'+script});
  const mountPortal=params=>page.evaluate(params=>{window.handle?.destroy?.();calls.length=0;window.handle=apps['portal.crew_payouts'].mount(document.querySelector('#portal'),{orgId:'org',params});},params);

  // Granted: the section, its total, each job with its next expected date, each earning and what could not be worked out.
  await mountPortal({mode:'crew',subject_scope:'mine',projected_enabled:true});
  const section=page.locator('#portal [data-projected-section]');await section.waitFor();
  assert.equal(await section.locator('h3').innerText(),'Projected');
  assert.match(await section.locator('h3').getAttribute('title'),/not done yet/,'the description is a tooltip, not visible copy');
  assert.equal(await section.locator('[data-projected-total]').innerText(),'$1,700.00');
  assert.equal(await section.locator('[data-projected-job]').count(),2);
  const text=await section.innerText();
  for(const expected of ['Maple St','Oak Ave','Labor c_open','Expected Jul 15, 2026','Not scheduled','$900.00','$300.00','$500.00','Not worked out'])assert.ok(text.includes(expected),`the section shows ${expected}`);
  assert.ok(!/crew/i.test(text),'no fixed copy says crew');
  assert.match(await section.locator('[data-projected-earning="c_team"]').getAttribute('title'),/Your share of Install team's \$600\.00/);
  assert.equal(await section.locator('[data-projected-unresolved]').getAttribute('title'),'This commitment has 1 line(s) with no rate.');
  assert.deepEqual((await page.evaluate(()=>calls)).sort(),['payroll.earnings.me','payroll.projectedEarnings.me']);

  // Not granted: nothing is asked for and nothing is shown.
  await mountPortal({mode:'crew',subject_scope:'mine',projected_enabled:false});
  await page.waitForFunction(()=>calls.includes('payroll.earnings.me'));
  assert.equal(await page.locator('#portal [data-projected-section]').count(),0);
  assert.equal(await page.locator('#portal [data-projected]').isVisible(),false);
  assert.ok(!(await page.evaluate(()=>calls)).includes('payroll.projectedEarnings.me'));

  // Granted in the profile but refused by the server: still hidden, with no error shown.
  await page.evaluate(()=>{window.deny=true;});
  await mountPortal({mode:'crew',subject_scope:'mine',projected_enabled:true});
  await page.waitForFunction(()=>calls.includes('payroll.projectedEarnings.me'));
  await page.waitForTimeout(50);
  assert.equal(await page.locator('#portal [data-projected-section]').count(),0);
  assert.equal(await page.locator('#portal [data-projected]').isVisible(),false);
  await page.evaluate(()=>{window.deny=false;});

  // In a project, only that job's projected earnings.
  await page.evaluate(()=>{calls.length=0;window.projectHandle=apps['project.crew_payouts'].mount({orgId:'org',projectId:'p2',root:document.querySelector('#project'),params:{mode:'crew',projected_enabled:true}});});
  const inProject=page.locator('#project [data-projected-section]');await inProject.waitFor();
  assert.equal(await inProject.locator('[data-projected-total]').innerText(),'$500.00');
  assert.equal(await inProject.locator('[data-projected-earning]').count(),1);
  assert.equal(await inProject.locator('[data-projected-unresolved]').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
