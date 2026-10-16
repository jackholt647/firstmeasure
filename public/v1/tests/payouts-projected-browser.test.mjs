import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// The field Earnings tab (portal.crew_payouts), a project's Earnings tab (project.crew_payouts) and the sales Earnings
// tab (portal.sales_earnings) all show the shared My pay view (libraries/apps/payroll/my-pay.js): earned, next pay
// date, paid, the rule forecast ("Projected") only when the person may see it, "Held for review" for corrections
// waiting on a manager, what could not be worked out, pay runs, payments made outside a run and, with the time clock
// permission, their own timesheets. Screenshots go to output/payroll-ui/.
const shots=new URL('../../../output/payroll-ui/',import.meta.url);
const shot=name=>new URL(name+'.png',shots).pathname.replace(/^\/(\w:)/,'$1');
test('every self-service Earnings tab shows My pay, projected only when permitted, one job in a project, commissions by kind for sales',async()=>{
 await mkdir(shots,{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  for(const [width,height,suffix] of [[1280,900,'desktop'],[390,844,'phone']]){
  const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://payouts.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{margin:0;font:14px Inter,Arial,sans-serif;background:#f2f4f7}</style><div id="portal"></div><div id="project"><div data-crew-project-app="payouts"></div></div>'});});
  await page.goto('https://payouts.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'ana'};window.apps={};window.calls=[];window.deny=false;window.perms={};
   window.FirstMateEmbeddableApps={registerApp:def=>apps[def.id]=def,escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])};
   // The time clock is Today's App experience option (docs/architecture/app-experience.md).
   window.Portal={apps:{registerPortalApp:def=>apps[def.id]=def},currentUser:{appEntitlements:[{ id:'portal.crew_overview', allowed:true, option_values:{ time_clock:true } }]},util:{injectCSS:()=>{},hasPerm:key=>perms[key]===true},navigation:{registerHandler:()=>{}}};
   const day=offset=>{const d=new Date(Date.now()+offset*864e5);return d.toISOString().slice(0,10);};
   const earning=(id,project,title,cents,on,extra={})=>({id,projected:true,rule_id:'committed_labor',kind:'piece_rate',amount_cents:cents,description:'Committed labor',expected_on:on,project_id:project,project_title:title,record_title:'Labor '+id,...extra});
   window.projection={total_cents:170000,earnings:[earning('c_open','p1','Maple St',90000,day(9)),earning('c_team','p1','Maple St',30000,day(14),{share_of:{payee_name:'Install team'}}),earning('list_new','p2','Oak Ave',50000,'')],
    unresolved:[{rule_id:'committed_labor',reason:'This commitment has 1 line(s) with no rate.',expected_on:day(20),project_id:'p1',project_title:'Maple St'}]};
   const entry=(id,kind,cents,extra={})=>({id,kind,subgroup:kind,state:'accrued',amount_cents:cents,applied_cents:0,remaining_cents:cents,currency:'USD',eligible_at:day(-3)+'T12:00:00.000Z',project_id:'p1',project_title:'Maple St',description:'',...extra});
   window.report=project=>({subject:{type:'organization_user',id:'ana'},currency:'USD',
    totals:{owed_cents:project?42000:96500,in_payroll_cents:0,paid_cents:project?60000:418000,projected_cents:-8000},
    projects:[{project_id:'p1',title:'Maple St',currency:'USD',totals:{owed_cents:42000}},{project_id:'p3',title:'Birch Ln',currency:'USD',totals:{owed_cents:54500}}].filter(row=>!project||row.project_id===project),
    entries:[entry('e1','commission',42000,{description:'Estimator commission: Maple St'}),entry('e2','clawback',-6000,{description:'Canceled: Elm Ave',project_title:'Elm Ave',project_id:'p9'}),entry('e3','piece_rate',54500,{description:'Committed labor',project_id:'p3',project_title:'Birch Ln'}),entry('e4','commission',-8000,{state:'projected',description:'Correction: Maple St'}),entry('e5','reimbursement',4500,{description:'Expense reimbursement: dump fee',applied_cents:4500,remaining_cents:0})].filter(row=>!project||row.project_id===project),
    payments:[{id:'pay1',batch_id:'r1',status:'paid',pay_date:day(-5),net_cents:124200,amount_cents:60000,currency:'USD',schedule:{name:'Weekly'}},{id:'pay2',batch_id:'r2',status:'run',pay_date:day(2),net_cents:98000,amount_cents:0,currency:'USD',schedule:{name:'Weekly'}}],
    off_cycle_payments:[{id:'oc1',kind:'hourly',amount_cents:20000,currency:'USD',paid_on:day(-8),reference:'Check 1042'}]});
   window.PlatformAPI={publication:{invoke:async(org,action,target,input)=>{calls.push({action,input});
    if(action==='payroll.earnings.me')return {receipt:{status:'succeeded'},value:{earnings:[report(input.project_id)],next_payment:{pay_date:day(2),schedule_name:'Weekly'},unresolved:input.project_id?[]:[{rule_name:'Hourly from the time clock',reason:'Your hourly rate is not set yet.',earned_at:day(-6)+'T23:00:00.000Z'}]}};
    if(action==='payroll.projectedEarnings.me'){if(deny)throw Object.assign(new Error('This operation is not permitted for this user.'),{status:403,code:'publication_permission_denied'});return {receipt:{status:'succeeded'},value:structuredClone(projection)};}
    if(action==='payroll.timesheets.me')return {receipt:{status:'succeeded'},value:{timesheets:[{id:'s1',user_id:'ana',project_id:'p1',project:{title:'Maple St'},status:'closed',approval_status:'approved',clocked_in_at:day(-1)+'T13:00:00.000Z',clocked_out_at:day(-1)+'T21:30:00.000Z',worked_seconds:28800},{id:'s2',user_id:'ana',project_id:'p3',project:{title:'Birch Ln'},status:'closed',approval_status:'pending',clocked_in_at:day(-2)+'T13:00:00.000Z',clocked_out_at:day(-2)+'T20:00:00.000Z',worked_seconds:23400}]}};
    return {receipt:{status:'succeeded'},value:{}};}}};
  });
  for(const script of ['payroll-api/payroll-api.js','apps/payroll/my-pay.js','apps/crew/app.js','apps/sales/app.js'])await page.addScriptTag({url:'https://payouts.test/libraries/'+script});
  const actions=()=>page.evaluate(()=>calls.map(c=>c.action).sort());
  const mountPortal=(id,params)=>page.evaluate(({id,params})=>{window.handle?.destroy?.();calls.length=0;window.handle=apps[id].mount(document.querySelector('#portal'),{orgId:'org',params});},{id,params});
  const portal=page.locator('#portal [data-my-pay]');

  // Field Earnings, with projections allowed: earned, next pay date, paid, projected, held for review, what could not
  // be worked out, pay runs, payments outside a run and the person's own timesheets.
  await mountPortal('portal.crew_payouts',{mode:'crew',subject_scope:'mine',projected_enabled:true});
  await portal.locator('[data-section="timesheets"]').waitFor();
  const stats=await portal.locator('.mp-stats').innerText();
  for(const expected of ['Earned, not paid yet','$965.00','Next pay date','Weekly','Paid','$4,180.00','Projected','$1,700.00','Held for review','−$80.00'])assert.ok(stats.includes(expected),`stats show ${expected}`);
  assert.equal((stats.match(/Projected/g)||[]).length,1,'one Projected, the rule forecast');
  assert.match(await portal.locator('[data-section="attention"]').innerText(),/Hourly from the time clock[\s\S]*Your hourly rate is not set yet/);
  const projected=await portal.locator('[data-section="projected"]').innerText();
  for(const expected of ['Maple St','Oak Ave','Not scheduled','$900.00','Not worked out','Your share of what Install team earns'])assert.ok(projected.includes(expected),`projected shows ${expected}`);
  assert.match(await portal.locator('[data-section="held"]').innerText(),/Correction: Maple St/);
  assert.match(await portal.locator('[data-section="outside"]').innerText(),/Check 1042|\$200\.00/);
  assert.match(await portal.locator('[data-section="timesheets"]').innerText(),/Maple St[\s\S]*Approved/);
  assert.ok(!/crew/i.test(await portal.innerText()),'no fixed copy says crew');
  assert.deepEqual(await actions(),['payroll.earnings.me','payroll.projectedEarnings.me','payroll.timesheets.me']);
  if(suffix==='phone')assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no sideways scroll');
  await page.screenshot({path:shot(`field-earnings-${suffix}`),fullPage:true});

  // Not allowed projections: the forecast is never asked for; no time clock option: no timesheets.
  await page.evaluate(()=>{perms={};Portal.currentUser.appEntitlements=[];});
  await mountPortal('portal.crew_payouts',{mode:'crew',subject_scope:'mine',projected_enabled:false});
  await portal.locator('[data-section="payments"]').waitFor();
  assert.equal(await portal.locator('[data-section="projected"], [data-section="timesheets"]').count(),0);
  assert.deepEqual(await actions(),['payroll.earnings.me']);
  // Allowed in the profile but refused by the server: hidden, with no error shown.
  await page.evaluate(()=>{window.deny=true;perms={};Portal.currentUser.appEntitlements=[{ id:'portal.crew_overview', allowed:true, option_values:{ time_clock:true } }];});
  await mountPortal('portal.crew_payouts',{mode:'crew',subject_scope:'mine',projected_enabled:true});
  await portal.locator('[data-section="timesheets"]').waitFor();
  assert.equal(await portal.locator('[data-section="projected"]').count(),0);
  assert.ok(!/not permitted/i.test(await portal.innerText()));
  await page.evaluate(()=>{window.deny=false;});

  // In a project: that job only, its own earnings, its projections and its shifts.
  await page.evaluate(()=>{handle?.destroy?.();calls.length=0;window.projectHandle=apps['project.crew_payouts'].mount({orgId:'org',projectId:'p1',root:document.querySelector('#project'),params:{mode:'crew',projected_enabled:true}});});
  const project=page.locator('#project [data-my-pay]');await project.locator('[data-section="timesheets"]').waitFor();
  assert.equal(await project.getAttribute('data-project'),'p1');
  assert.equal((await page.evaluate(()=>calls.find(c=>c.action==='payroll.earnings.me').input)).project_id,'p1');
  const projectText=await project.innerText();
  assert.ok(projectText.includes('Earned on this job'));assert.ok(projectText.includes('$1,200.00'),'only this job is projected');assert.ok(!projectText.includes('Oak Ave'));assert.ok(!projectText.includes('Birch Ln'),'only this job’s shifts');
  assert.equal(await project.locator('[data-section="outside"], [data-section="attention"]').count(),0);
  await page.screenshot({path:shot(`project-earnings-${suffix}`),fullPage:true});
  await page.evaluate(()=>projectHandle.destroy());

  // Sales: commissions first, picked by earning kind (commission and its clawbacks), never by matching words.
  await mountPortal('portal.sales_earnings',{mode:'sales',subject_scope:'mine',presentation:'commissions'});
  const commissions=portal.locator('[data-section="commissions"]');await commissions.waitFor();
  const commissionText=await commissions.innerText();
  assert.ok(commissionText.includes('Maple St'));assert.ok(commissionText.includes('Elm Ave'));assert.ok(commissionText.includes('−$60.00'));
  assert.ok(!commissionText.includes('Birch Ln'),'piece rate is not a commission');assert.ok(!commissionText.includes('Correction: Maple St'),'held corrections are under Held for review');
  assert.equal(await commissions.locator('tbody tr').count(),2);
  // The sales tab's projected_enabled comes from payroll.view_own_projected_earnings: off, the forecast is never asked for.
  assert.ok(!(await actions()).includes('payroll.projectedEarnings.me'));
  await mountPortal('portal.sales_earnings',{mode:'sales',subject_scope:'mine',presentation:'commissions',projected_enabled:true});
  await portal.locator('[data-section="projected"]').waitFor();
  assert.ok((await actions()).includes('payroll.projectedEarnings.me'));
  if(suffix==='phone')assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await page.screenshot({path:shot(`sales-earnings-${suffix}`),fullPage:true});
  assert.deepEqual(errors,[]);
  await page.close();
  }
 }finally{await browser.close();}
});
