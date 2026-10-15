import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

// Mounts Payroll's Review view and the "Why" view against a stubbed publication API and walks the pay-rule surfaces:
// what could not be worked out, a refresh, why one payee and one group are paid what they are, held corrections
// accepted and declined, and drafting a pay run, which refreshes first. Nothing is asked with window.prompt.
test('payroll review refreshes rule earnings, explains a payee and reviews held corrections',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{errors.push('dialog: '+d.message());d.dismiss();});
  await page.route('https://payroll.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{font-family:Arial;margin:0}#tab{min-height:900px}</style><div id="tab"></div>'});});
  await page.goto('https://payroll.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'manager'};window.apps={};window.calls=[];window.reads=[];window.prompt=()=>{throw Error('window.prompt is not used');};
   window.Portal={currentUser:{id:'manager',permissions:{manage_payroll:true}},ui:{showToast:(...values)=>(window.toasts=window.toasts||[]).push(values)}};
   window.FirstMateEmbeddableApps={registerApp:def=>apps[def.id]=def};
   window.AppChrome={registerGroup:()=>{},resolve:(_a,v)=>v||'upcoming',header:o=>`<header><h2>${o.title}</h2>${o.tabs||''}</header>`,tabs:()=>'',settings:()=>''};
   const alice={type:'organization_user',id:'alice',name:'Alice Adams',worker_type:'employee'},bob={type:'organization_user',id:'bob',name:'Bob Brown',worker_type:'employee'};
   const schedule={id:'s1',name:'Weekly',currency:'USD',recurrence:{frequency:'weekly',weekday:5},delay:{},timing_basis:'worked',clawback_cap_percent:100};
   const preview=cents=>({gross_cents:cents,deduction_cents:0,net_cents:cents,subgroup_totals:{hourly:cents},entry_count:1});
   window.dashboard={schedules:[schedule],diagnostics:[],history:[],upcoming:[{schedule,pay_date:'2026-10-16',period_start:'2026-10-05',period_end:'2026-10-11',cutoff_at:'2026-10-11T23:59:59.999Z',batch:null,
    employees:[{payee:alice,accrued:preview(45000),projected:preview(0),forecast_net_cents:45000}],subcontractors:[],accrued_total_cents:45000,projected_additional_cents:0,forecast_total_cents:45000}]};
   window.rules=[{id:'hourly_time_clock',name:'Hourly from the time clock',versions:[]},{id:'estimator_commission_sold',name:'Estimator commission when sold',versions:[]}];
   const ruleEntry=(id,payee,state,cents,metadata,extra={})=>({id,payee,schedule_id:'s1',kind:'commission',subgroup:'commission',state,amount_cents:cents,applied_cents:0,remaining_cents:cents,currency:'USD',eligible_at:'2026-10-09T12:00:00.000Z',created_at:'2026-10-12T09:00:00.000Z',description:'Correction: 3% of Jones roof',
    metadata:{source:'pay_rule',pay_rule:{rule_id:'estimator_commission_sold',unit:'project_9',line:'main',earned_on:'2026-09-12',params:{rate_percent:3}},...metadata},...extra});
   window.ledger=[
    ruleEntry('h1',bob,'projected',-5000,{correction:{posted_cents:20000,target_cents:15000,handling:'hold'},review_required:true,split:{of:'resource_group:g1',line_cents:45000,members:3}}),
    ruleEntry('h2',bob,'projected',-20000,{correction:{posted_cents:20000,target_cents:0,handling:'hold'},review_required:true},{description:'Correction: 3% of Lee siding'}),
    ruleEntry('o1',alice,'accrued',2500,{correction:{posted_cents:42500,target_cents:45000,handling:'off_cycle'},back_pay:true,off_cycle_requested:true},{description:'Correction: 3% of Smith roof'}),
    ruleEntry('e1',alice,'accrued',42500,{},{description:'3% of Smith roof',applied_cents:42500,remaining_cents:0,created_at:'2026-10-01T09:00:00.000Z'})];
   window.units={'organization_user:alice':[
    {id:'u1',rule_id:'hourly_time_clock',unit:'2026-10-05',status:'error',earned_at:'2026-10-11T12:00:00.000Z',lines:[],error:"Set this payee's hourly rate."},
    {id:'u2',rule_id:'estimator_commission_sold',unit:'project_7',status:'ok',earned_at:'2026-09-30T12:00:00.000Z',lines:[{key:'main',amount_cents:45000,description:'3% of Smith roof'}]}]};
   window.unresolvedRows=[
    {id:'a',payee:{type:'organization_user',id:'alice'},payee_name:'Alice Adams',rule_id:'hourly_time_clock',unit:'2026-10-05',whole_rule:false,earned_at:'2026-10-11T12:00:00.000Z',reason:"Set this payee's hourly rate."},
    {id:'g',payee:{type:'resource_group',id:'g1'},payee_name:'North Install',rule_id:'estimator_commission_sold',unit:'',whole_rule:true,earned_at:'',reason:'projects: This reading is pending.'}];
   const slot=(rule_id,params,origin=null,changed_above=false)=>({rule_id,definition_rule_id:rule_id,params,origin,changed_above});
   window.setups={
    'organization_user:alice':{effective:[slot('estimator_commission_sold',{rate_bps:300},{type:'organization',id:'org',name:'Everyone'},true),slot('hourly_time_clock',{rate_cents:2500})],distribution_today:null,
     schedule_today:[{earning_kind:'*',schedule_name:'Weekly',timing_basis:'worked',clawback_cap_percent:50,origin:{type:'organization',id:'org',name:'Everyone'}},{earning_kind:'commission',schedule_name:'Monthly',timing_basis:'completed',clawback_cap_percent:null,origin:{type:'role',id:'salesperson',name:'Salesperson'}}]},
    'resource_group:g1':{effective:[slot('estimator_commission_sold',{rate_bps:300})],distribution_today:{mode:'split',method:'rule'},schedule_today:[]}};
   const refreshed={payees:[],posted_count:1,posted_cents:12345,held_count:0,held_cents:0,unresolved_count:1};
   window.PlatformAPI={publication:{
    read:async(_org,source)=>{reads.push(source.export);const name=source.export,fromRules=row=>row.metadata?.source==='pay_rule';return {status:'ready',value:structuredClone(
     name==='pay_rules'?rules:name==='pay_units'?units[source.target.id]||[]:name==='pay_setup'?setups[source.target.id]||{effective:[],schedule_today:[]}:name==='pay_unresolved'?unresolvedRows
     :name==='pay_review'?{held:ledger.filter(row=>fromRules(row)&&row.state==='projected'&&row.metadata.review_required===true),off_cycle:ledger.filter(row=>fromRules(row)&&row.state==='accrued'&&row.remaining_cents!==0&&row.metadata.off_cycle_requested===true)}
     :name==='off_cycle_payments'||name==='finalized_work'?[]:name==='pay_rule_vocabulary'?{earning_kinds:['hourly','commission'],labels:{earning_kinds:{hourly:'Hourly',commission:'Commission'}}}:[])};},
    invoke:async(org,action,target,input,options)=>{calls.push({org,action,target,input,options});let value;
     if(action==='payroll.dashboard.read')value=dashboard;
     else if(action==='payroll.ledger.list')value=ledger.filter(row=>(!input.kind||row.kind===input.kind)&&(!input.payee_id||row.payee.id===input.payee_id)&&(!input.open_only||row.remaining_cents!==0));
     else if(action==='payroll.earnings.read')value={earnings:[{subject:alice,currency:'USD',totals:{owed_cents:45000,in_payroll_cents:0,paid_cents:42500},projects:[],payments:[],off_cycle_payments:[]}]};
     else if(action==='payroll.earnings.refresh')value=refreshed;
     else if(action==='payroll.projection.accrue'){value=ledger.find(row=>row.id===target.id);value.state='accrued';}
     else if(action==='payroll.correction.decline'){value=ledger.find(row=>row.id===target.id);value.state='void';}
     else if(action==='payroll.batch.create'){dashboard.upcoming[0].batch={id:'batch_regular',schedule_id:'s1',pay_date:input.pay_date,status:'draft',currency:'USD',total_cents:45000,approval:{status:'draft'},items:[]};value={batch:dashboard.upcoming[0].batch,contractor_payables:[],earnings_refresh:{posted_count:1,held_count:1,unresolved_count:1}};}
     else value={};
     return {receipt:{status:'succeeded'},value:structuredClone(value)};}}};
  });
  for(const script of ['apps/people/people-kit.js','apps/people/entity-modal.js','payroll-api/payroll-api.js','apps/payroll/app.js'])await page.addScriptTag({url:'https://payroll.test/libraries/'+script});
  await page.evaluate(()=>{window.tab=FirstMatePayroll.mountView({root:document.querySelector('#tab'),orgId:'org',params:{standalone:'review'}});});
  const shots=process.env.PAYROLL_SHOTS;if(shots)await mkdir(shots,{recursive:true});
  const shot=async name=>{if(shots)await page.screenshot({path:join(shots,name+'.png'),fullPage:true});};
  const count=action=>page.evaluate(name=>calls.filter(call=>call.action===name).length,action);
  const last=action=>page.evaluate(name=>calls.filter(call=>call.action===name).at(-1),action);

  // Held corrections: who, what, what was posted and what the rule says now, and the difference.
  const held=page.locator('[data-section="held"]');await held.locator('[data-accept="h1"]').waitFor();
  assert.equal(await held.locator('tbody tr').count(),2);
  const heldText=await held.innerText();
  for(const expected of ['Bob Brown','Estimator commission when sold','$200.00 → $150.00','−$50.00','$200.00 → $0.00','−$200.00'])assert.ok(heldText.includes(expected),`held corrections show ${expected}`);
  // Back pay that asked to be paid off-cycle is listed with a way to record it as paid outside a run.
  const backPay=page.locator('[data-section="back-pay"]');assert.match(await backPay.innerText(),/Alice Adams[\s\S]*\$25\.00/);assert.equal(await backPay.locator('[data-record-for="organization_user:alice"]').count(),1);
  // What could not be worked out at the last refresh is read from the stored list, before anyone refreshes.
  const unresolved=page.locator('[data-section="unresolved"]');
  assert.equal(await unresolved.locator('tbody tr').count(),2);assert.equal(await count('payroll.earnings.refresh'),0);
  const unresolvedText=await unresolved.innerText();
  for(const expected of ['North Install','The whole rule','projects: This reading is pending.',"Set this payee's hourly rate."])assert.ok(unresolvedText.includes(expected),`unresolved shows ${expected}`);
  assert.ok(!unresolvedText.includes('$0.00'),'an unresolved earning is never shown as an amount');
  await shot('pay-rules-review');

  // Refresh for everyone; the stored list is read again.
  await unresolved.locator('[data-act="refresh-earnings"]').click();
  await page.waitForFunction(()=>calls.some(call=>call.action==='payroll.earnings.refresh'));
  const refresh=await last('payroll.earnings.refresh');assert.deepEqual(refresh.input,{});assert.ok(refresh.options.idempotencyKey);
  await page.waitForFunction(()=>reads.filter(name=>name==='pay_unresolved').length>=2);
  assert.match(JSON.stringify(await page.evaluate(()=>window.toasts)),/1 changes posted, 0 held for review, 1 could not be worked out/);

  // Why Alice is paid what she is: the rules and where each came from, when she is paid, what each rule worked out.
  await unresolved.locator('[data-why="organization_user:alice"]').click();
  const why=page.locator('.pp-modal');await why.locator('[data-modal-panel="paid_by"]').getByText('Hourly from the time clock').waitFor();
  const paidBy=await why.locator('[data-modal-panel="paid_by"]').innerText();
  for(const expected of ['Estimator commission when sold','Everyone','Changed for them','rate 3%','Their own setup','rate $25.00','Weekly','recognized when the work is done','clawbacks capped at 50% of a check','Monthly','Salesperson role','recognized when the job is completed'])assert.ok(paidBy.includes(expected),`paid by shows ${expected}`);
  await why.locator('[data-modal-tab="results"]').click();
  const results=await why.locator('[data-modal-panel="results"]').innerText();
  assert.ok(results.includes("Set this payee's hourly rate."));assert.ok(results.includes('3% of Smith roof'));assert.ok(results.includes('$450.00'));
  await why.locator('[data-modal-tab="ledger"]').click();
  const ledgerText=await why.locator('[data-modal-panel="ledger"]').innerText();
  assert.ok(ledgerText.includes('correction: $425.00 before, $450.00 now'));assert.ok(ledgerText.includes('In a pay run'));
  assert.match(await why.locator('.pp-sum').innerText(),/Owed\s+\$450\.00/);
  await shot('pay-rules-explained');
  await page.keyboard.press('Escape');await why.waitFor({state:'detached'});

  // A group whose pay is divided by a split rule says so, not "equally".
  await unresolved.locator('[data-why="resource_group:g1"]').click();
  await page.locator('.pp-modal [data-modal-panel="paid_by"]').getByText('divided among its members by a split rule').waitFor();
  await page.keyboard.press('Escape');

  // Accept one held correction; decline the other with a note in a small form, never a prompt.
  await held.locator('[data-accept="h1"]').click();
  await held.locator('[data-accept="h1"]').waitFor({state:'detached'});
  const accepted=await last('payroll.projection.accrue');assert.equal(accepted.target.id,'h1');assert.ok(accepted.options.idempotencyKey);
  await held.locator('[data-decline="h2"]').click();
  await page.locator('.pp-form [name="note"]').fill('Paid correctly at the time');
  await page.locator('.pp-form button[type="submit"]').click();
  await held.getByText('No corrections are waiting for review.').waitFor();
  const declined=await last('payroll.correction.decline');assert.equal(declined.target.id,'h2');assert.deepEqual(declined.input,{note:'Paid correctly at the time'});

  // Drafting a pay run refreshes earnings first and says when something could not be worked out.
  await page.evaluate(()=>{tab.destroy();window.tab=FirstMatePayroll.mountView({root:document.querySelector('#tab'),orgId:'org',params:{standalone:'upcoming'}});});
  await page.locator('[data-section="runs"] tbody tr').first().click();
  await page.locator('.pp-modal [data-run-act="draft"]').click();
  await page.waitForFunction(()=>calls.some(call=>call.action==='payroll.batch.create'));
  assert.equal((await last('payroll.batch.create')).input.schedule_id,'s1');
  await page.locator('.pp-modal [data-run-steps="draft"]').waitFor();
  assert.match(JSON.stringify(await page.evaluate(()=>window.toasts)),/Some earnings could not be worked out/);
  await shot('pay-rules-run-created');
  await page.evaluate(()=>{document.querySelector('.pp-modal-back')?.remove();tab.destroy();});assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
