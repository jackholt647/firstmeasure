import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

// Mounts the Payroll tab against a stubbed publication API and walks the pay-rule surfaces:
// a refresh with an unresolved earning, the explanation for one payee, held corrections and pay-run summaries.
test('payroll tab refreshes rule earnings, explains a payee and reviews held corrections',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://payroll.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{font-family:Arial;margin:0}#tab{height:1000px}</style><div id="tab"></div>'});});
  await page.goto('https://payroll.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'manager'};window.apps={};window.calls=[];window.reads=[];window.confirm=()=>true;window.promptAnswer=null;window.prompt=(_message,fallback)=>window.promptAnswer??fallback;
   window.FirstMateEmbeddableApps={registerApp:def=>apps[def.id]=def};
   window.AppChrome={registerGroup:()=>{},resolve:(_a,v)=>v||'upcoming',header:o=>`<header><h2>${o.title}</h2>${o.tabs||''}</header>`,tabs:()=>'',settings:()=>''};
   const alice={type:'organization_user',id:'alice',name:'',worker_type:'employee'},bob={type:'organization_user',id:'bob',name:'',worker_type:'employee'};
   const schedule={id:'s1',name:'Weekly',currency:'USD',recurrence:{frequency:'weekly',weekday:5},delay:{},timing_basis:'worked',clawback_cap_percent:100};
   const preview=cents=>({gross_cents:cents,deduction_cents:0,net_cents:cents,subgroup_totals:{hourly:cents},entry_count:1});
   window.dashboard={schedules:[schedule],diagnostics:[],history:[],upcoming:[{schedule,pay_date:'2026-10-16',period_start:'2026-10-05',period_end:'2026-10-11',cutoff_at:'2026-10-11T23:59:59.999Z',batch:null,
    employees:[{payee:{...alice,name:'Alice Adams'},accrued:preview(45000),projected:preview(0),forecast_net_cents:45000}],subcontractors:[],accrued_total_cents:45000,projected_additional_cents:0,forecast_total_cents:45000}]};
   const version=(id,definition)=>({version:id,effective_from:'2026-01-01',definition});
   window.rules=[
    {id:'hourly_time_clock',name:'Hourly from the time clock',description:'',status:'active',versions:[version('h1',{grain:'period',period:'week',kind:'hourly',inputs:{shifts:{date:'clocked_out_at'}}})]},
    {id:'estimator_commission_sold',name:'Estimator commission when sold',description:'',status:'active',versions:[version('c1',{grain:'record',kind:'commission',inputs:{projects:{primary:true}}})]}];
   const ruleEntry=(id,payee,state,cents,metadata,extra={})=>({id,payee,schedule_id:'s1',kind:'commission',subgroup:'commission',state,amount_cents:cents,applied_cents:0,remaining_cents:cents,currency:'USD',eligible_at:'2026-10-09T12:00:00.000Z',created_at:'2026-10-12T09:00:00.000Z',description:'Correction: 3% of Jones roof',
    metadata:{source:'pay_rule',pay_rule:{rule_id:'estimator_commission_sold',definition_rule_id:'estimator_commission_sold',version:'c1',unit:'project_9',line:'main',earned_on:'2026-09-12',earned_at:'2026-09-12T12:00:00.000Z',params:{rate_percent:3}},...metadata},...extra});
   window.ledger=[
    ruleEntry('h1',bob,'projected',-5000,{correction:{posted_cents:20000,target_cents:15000,handling:'hold'},review_required:true,split:{of:'resource_group:g1',line_cents:45000,members:3}}),
    ruleEntry('h2',bob,'projected',-20000,{correction:{posted_cents:20000,target_cents:0,handling:'hold'},review_required:true},{description:'Correction: 3% of Lee siding'}),
    ruleEntry('o1',alice,'accrued',2500,{correction:{posted_cents:42500,target_cents:45000,handling:'off_cycle'},back_pay:true,off_cycle_requested:true,details:{contract_cents:1500000}},{description:'Correction: 3% of Smith roof'}),
    ruleEntry('e1',alice,'accrued',42500,{details:{contract_cents:1416667}},{description:'3% of Smith roof',applied_cents:42500,remaining_cents:0,created_at:'2026-10-01T09:00:00.000Z'}),
    {id:'manual',payee:alice,schedule_id:'s1',kind:'adjustment',state:'accrued',amount_cents:999,applied_cents:0,remaining_cents:999,currency:'USD',description:'Manual adjustment',metadata:{}}];
   window.units={'organization_user:alice':[
    {id:'hourly_time_clock:2026-10-05',rule_id:'hourly_time_clock',unit:'2026-10-05',status:'error',earned_at:'2026-10-11T12:00:00.000Z',rule_version:'h1',lines:[],error:"Set this payee's hourly rate.",evaluated_at:'2026-10-12T09:00:00.000Z'},
    {id:'estimator_commission_sold:project_7',rule_id:'estimator_commission_sold',unit:'project_7',status:'ok',earned_at:'2026-09-30T12:00:00.000Z',rule_version:'c1',lines:[{key:'main',amount_cents:45000,description:'3% of Smith roof',details:{contract_cents:1500000,rate_percent:3}}],error:'',evaluated_at:'2026-10-12T09:00:00.000Z'}]};
   window.units['resource_group:g1']=[{id:'estimator_commission_sold:project_9',rule_id:'estimator_commission_sold',unit:'project_9',status:'ok',earned_at:'2026-09-12T12:00:00.000Z',rule_version:'c1',lines:[{key:'main',amount_cents:45000,description:'3% of Jones roof'}],error:'',evaluated_at:'2026-10-12T09:00:00.000Z',split_among:[{id:'alice',weight:1},{id:'bob',weight:1},{id:'carol',weight:1}]}];
   const unresolved={rule_id:'hourly_time_clock',unit:'2026-10-05',reason:"Set this payee's hourly rate."};
   window.unresolvedRows=[
    {id:'organization_user:alice:hourly_time_clock:2026-10-05',payee:{type:'organization_user',id:'alice'},payee_name:'Alice Adams',...unresolved,whole_rule:false,earned_at:'2026-10-11T12:00:00.000Z',evaluated_at:'2026-10-12T09:00:00.000Z'},
    {id:'resource_group:g1:estimator_commission_sold:*',payee:{type:'resource_group',id:'g1'},payee_name:'North Install',rule_id:'estimator_commission_sold',unit:'',whole_rule:true,earned_at:'',reason:'projects: This reading is pending.',evaluated_at:'2026-10-12T09:00:00.000Z'}];
   window.plans=[{id:'sales',name:'Sales',status:'active',versions:[{effective_from:'2026-01-01',rules:[{rule_id:'estimator_commission_sold',params:{rate_percent:2}}]}]}];
   const slot=(rule_id,params)=>({rule_id,definition_rule_id:rule_id,params});
   window.setups={
    'organization_user:alice':{payee:{type:'organization_user',id:'alice'},entries:[],revision:2,distribution_today:null,effective:[slot('estimator_commission_sold',{rate_percent:3}),slot('hourly_time_clock',{rate_cents:2500})],
     schedule_today:[{earning_kind:'*',schedule_id:'weekly',schedule_name:'Weekly',timing_basis:'worked',clawback_cap_percent:50,effective_from:'2026-01-01',origin:{type:'organization',id:'org',name:'Everyone'}},{earning_kind:'commission',schedule_id:'monthly',schedule_name:'Monthly',timing_basis:'completed',clawback_cap_percent:null,effective_from:'2026-03-01',origin:{type:'role',id:'salesperson',name:'Salesperson'}}],
     layers:[{source:{type:'organization',id:'org'},entries:[{kind:'plan',plan_id:'sales',effective_from:'2026-01-01'}]},{source:null,entries:[{kind:'add',rule_id:'hourly_time_clock',params:{rate_cents:2500},effective_from:'2026-01-01'},{kind:'override',rule_id:'estimator_commission_sold',params:{rate_percent:3},effective_from:'2026-06-01'}]}]},
    'resource_group:g1':{payee:{type:'resource_group',id:'g1'},entries:[],revision:1,distribution_today:{mode:'split',method:'equal'},effective:[slot('estimator_commission_sold',{rate_percent:3})],layers:[{source:null,entries:[{kind:'add',rule_id:'estimator_commission_sold',params:{rate_percent:3},effective_from:'2026-01-01'}]}]}};
   const refreshed=payees=>{const all=[{payee:{type:'organization_user',id:'alice'},payee_name:'Alice Adams',evaluated:2,unchanged:1,differences:[],unresolved:[unresolved],posted:[]},{payee:{type:'organization_user',id:'bob'},payee_name:'Bob Brown',evaluated:1,unchanged:4,differences:[],unresolved:[],posted:[{id:'n1',payee:{...bob,name:'Bob Brown'},state:'accrued',amount_cents:12345,currency:'USD',metadata:{source:'pay_rule'}}]}];
    const list=payees?.length?all.filter(row=>payees.some(payee=>payee.id===row.payee.id)):all,posted=list.flatMap(row=>row.posted);return {payees:list,posted_count:posted.length,posted_cents:posted.reduce((sum,row)=>sum+row.amount_cents,0),held_count:0,held_cents:0,unresolved_count:list.reduce((sum,row)=>sum+row.unresolved.length,0)};};
   window.PlatformAPI={publication:{
    read:async(_org,source)=>{reads.push(source.export);const name=source.export,fromRules=row=>row.metadata?.source==='pay_rule';return {status:'ready',value:structuredClone(
     name==='pay_rules'?rules:name==='pay_plans'?plans:name==='pay_units'?units[source.target.id]||[]:name==='pay_setup'?setups[source.target.id]||{entries:[],layers:[],effective:[],distribution_today:null}:name==='pay_unresolved'?unresolvedRows
     :name==='pay_review'?{held:ledger.filter(row=>fromRules(row)&&row.state==='projected'&&row.metadata.review_required===true),off_cycle:ledger.filter(row=>fromRules(row)&&row.state==='accrued'&&row.remaining_cents!==0&&row.metadata.off_cycle_requested===true)}:[])};},
    invoke:async(org,action,target,input,options)=>{calls.push({org,action,target,input,options});let value;
     if(action==='payroll.dashboard.read')value=dashboard;
     else if(action==='payroll.ledger.list')value=ledger.filter(row=>(!input.state||row.state===input.state)&&(!input.payee_id||row.payee.id===input.payee_id)&&(!input.open_only||row.remaining_cents!==0));
     else if(action==='payroll.directory.read')value={users:[{id:'bob',name:'Bob Brown'},{id:'carol',name:'Carol Cole'}],connections:[],resource_groups:[]};
     else if(action==='payroll.earnings.refresh')value=refreshed(input.payees);
     else if(action==='payroll.projection.accrue'){value=ledger.find(row=>row.id===target.id);value.state='accrued';}
     else if(action==='payroll.correction.decline'){value=ledger.find(row=>row.id===target.id);value.state='void';value.metadata.pay_rule_declined=true;}
     else if(action==='payroll.batch.create'){const batch={id:input.run_type==='off_cycle'?'batch_off':'batch_regular',schedule_id:input.schedule_id,pay_date:input.pay_date,run_type:input.run_type||'regular',status:'draft',currency:'USD',total_cents:45000,items:[]};
      if(batch.run_type==='regular')dashboard.upcoming[0].batch=batch;else ledger.find(row=>row.id==='o1').remaining_cents=0;
      value={batch,contractor_payables:[],earnings_refresh:{posted_count:1,posted_cents:5000,held_count:1,unresolved_count:1,unresolved:[{payee:{type:'organization_user',id:'alice'},...unresolved}]}};}
     else value={};
     return {receipt:{status:'succeeded'},value:structuredClone(value)};}}};
  });
  for(const script of ['payroll-api/payroll-api.js','apps/payroll/app.js'])await page.addScriptTag({url:'https://payroll.test/libraries/'+script});
  await page.evaluate(()=>{window.tab=FirstMatePayroll.mountView({root:document.querySelector('#tab'),orgId:'org',params:{standalone:'upcoming'}});});
  const shots=process.env.PAYROLL_SHOTS;if(shots)await mkdir(shots,{recursive:true});
  const shot=async name=>{if(shots)await page.screenshot({path:join(shots,name+'.png'),fullPage:true});};
  const count=action=>page.evaluate(name=>calls.filter(call=>call.action===name).length,action);
  const last=action=>page.evaluate(name=>calls.filter(call=>call.action===name).at(-1),action);

  // Held corrections are listed by payee with what was posted, what the rule now says and the difference.
  const held=page.locator('[data-pay-held]');await held.locator('[data-held-entry="h1"]').waitFor();
  assert.equal(await held.locator('[data-held-payee]').count(),1);assert.equal(await held.locator('[data-held-entry]').count(),2);
  const heldText=await held.innerText();
  for(const expected of ['Bob Brown','Estimator commission when sold','Record project_9','$200.00','$150.00','−$50.00','originally earned','Rate percent: 3','no longer pays anything',"Their share of North Install's $450.00, split 3 ways"])assert.ok(heldText.includes(expected),`held corrections show ${expected}`);
  // Back pay that asked for an off-cycle run is surfaced with its schedule.
  const offCycle=page.locator('[data-pay-off-cycle]');assert.ok((await offCycle.innerText()).includes('Alice Adams'));assert.equal(await offCycle.locator('[data-off-cycle-entry]').count(),1);
  // What could not be worked out at the last refresh is shown on first load, before anyone refreshes, from the stored list.
  assert.equal(await page.locator('[data-pay-panel] [data-unresolved-row]').count(),2);assert.equal(await count('payroll.earnings.refresh'),0);assert.equal(await count('payroll.ledger.list'),0,'held and off-cycle corrections come from the review read');
  const groupRow=await page.locator('[data-unresolved-payee="resource_group:g1"]').innerText();
  for(const expected of ['North Install','Estimator commission when sold','the whole rule','The rule could not read its "projects" input: This reading is pending.'])assert.ok(groupRow.includes(expected),`whole-rule row shows ${expected}`);

  // Refresh for everyone: one earning could not be worked out, and it is never shown as an amount.
  await page.locator('.fmp-pay-head [data-action="refresh-earnings"]').click();
  await page.locator('[data-pay-last-refresh]').waitFor();const unresolvedRow=page.locator('[data-pay-panel] [data-unresolved-payee="organization_user:alice"]');await unresolvedRow.waitFor();
  assert.ok(await page.evaluate(()=>reads.filter(name=>name==='pay_unresolved').length>=2),'the stored list is read again after a refresh');
  const refresh=await last('payroll.earnings.refresh');assert.deepEqual(refresh.input,{});assert.ok(refresh.options.idempotencyKey);
  const rowText=await unresolvedRow.innerText();
  for(const expected of ['Alice Adams','Hourly from the time clock','Week starting',"Set this payee's hourly rate.",'NOT ZERO'])assert.ok(rowText.toUpperCase().includes(expected.toUpperCase()),`unresolved row shows ${expected}`);
  assert.ok(!rowText.includes('$0.00'));
  assert.match(await page.locator('[data-pay-last-refresh]').innerText(),/Last refresh .*\d{4}.*everyone with a pay setup \(2 payees\)/);
  const stats=await page.locator('[data-pay-panel] [data-pay-stats]').innerText();assert.ok(stats.includes('$123.45'));assert.ok(!/includes held/i.test(stats));assert.match(stats,/COULD NOT BE WORKED OUT\s*1/i);
  await shot('pay-rules-refresh');

  // The explanation for one payee: what each rule last worked out, and the ledger entries that came from rules.
  await unresolvedRow.locator('[data-action="explain-payee"]').click();
  const explain=page.locator('.fmp-explain');await explain.locator('[data-pay-unit]').first().waitFor();
  assert.ok((await explain.locator('.fmp-explain-top').innerText()).includes('Alice Adams'));
  const failed=await explain.locator('[data-unit-status="error"]').innerText();assert.ok(failed.includes("Set this payee's hourly rate."));assert.ok(failed.includes('This is not zero'));assert.ok(!failed.includes('$0.00'));
  const worked=await explain.locator('[data-unit-status="ok"]').innerText();
  for(const expected of ['Record project_7','3% of Smith roof','$450.00','Contract: $15,000.00','Rate percent: 3','Earned'])assert.ok(worked.includes(expected),`worked-out unit shows ${expected}`);
  const paidBy=explain.locator('[data-explain-paid-by]');
  const inherited=(await paidBy.locator('[data-paid-by-rule="estimator_commission_sold"]').innerText()).toUpperCase();for(const expected of ['Estimator commission when sold','From the organization default','Changed for this payee','Rate percent: 3'])assert.ok(inherited.includes(expected.toUpperCase()),`paid by shows ${expected}`);
  // When they are paid sits beside what they are paid, with the layer that chose each schedule.
  const paidOn=(await paidBy.locator('[data-paid-on]').innerText()).toUpperCase();for(const expected of ['Everything else: Weekly','From the organization default','clawbacks capped at 50% of a check','Commission: Monthly','From the default for the Salesperson role','recognized when the job is completed'])assert.ok(paidOn.includes(expected.toUpperCase()),`paid on shows ${expected}`);
  const own=(await paidBy.locator('[data-paid-by-rule="hourly_time_clock"]').innerText()).toUpperCase();for(const expected of ['Hourly from the time clock','Their own setup','Rate: $25.00'])assert.ok(own.includes(expected.toUpperCase()),`paid by shows ${expected}`);
  assert.equal(await explain.locator('[data-ledger-entry]').count(),2,'only entries that came from a pay rule are explained');
  const backPay=await explain.locator('[data-ledger-entry="o1"]').innerText();
  for(const expected of ['CORRECTION','BACK PAY','OFF-CYCLE REQUESTED','Estimator commission when sold','originally earned','Rate percent: 3','$425.00','$450.00','+$25.00'])assert.ok(backPay.toUpperCase().includes(expected.toUpperCase()),`back pay entry shows ${expected}`);
  assert.ok((await explain.locator('[data-ledger-entry="e1"]').innerText()).includes('In a pay run'));
  await shot('pay-rules-explained');
  await explain.locator('[data-action="refresh-earnings"]').first().click();
  await page.waitForFunction(()=>calls.filter(call=>call.action==='payroll.earnings.refresh').length===2);
  assert.deepEqual((await last('payroll.earnings.refresh')).input,{payees:[{type:'organization_user',id:'alice'}]});
  await explain.locator('[data-action="refresh-earnings"]:not([disabled])').first().waitFor();
  await explain.locator('[data-action="explain-close"]').click();assert.equal(await page.locator('.fmp-explain').count(),0);
  assert.equal(await page.locator('[data-pay-panel] [data-unresolved-row]').count(),2,'refreshing one payee keeps what is still unresolved');

  // A group whose pay is split: how it is split today, and who shared each record.
  await page.locator('[data-unresolved-payee="resource_group:g1"] [data-action="explain-payee"]').click();
  await explain.locator('[data-pay-split-among]').waitFor();
  assert.ok((await explain.locator('.fmp-explain-top').innerText()).includes('North Install'));
  assert.ok((await explain.locator('[data-pay-split-among]').innerText()).includes('Split equally among 3 members: Alice Adams, Bob Brown, Carol Cole'));
  assert.ok((await explain.locator('[data-explain-paid-by]').innerText()).includes('split among its members equally'));
  assert.ok((await explain.locator('[data-pay-unresolved]').innerText()).includes('the whole rule'));
  await shot('pay-rules-group-explained');
  await explain.locator('[data-action="explain-close"]').click();

  // Accept one held correction, decline the other with a note; the list is read again after each.
  await held.locator('[data-held-entry="h1"] [data-action="correction-accept"]').click();
  await held.locator('[data-held-entry="h1"]').waitFor({state:'detached'});
  const accepted=await last('payroll.projection.accrue');assert.equal(accepted.target.id,'h1');assert.ok(accepted.options.idempotencyKey);assert.equal(await held.locator('[data-held-entry]').count(),1);
  await page.evaluate(()=>{window.promptAnswer='Paid correctly at the time';});
  await held.locator('[data-held-entry="h2"] [data-action="correction-decline"]').click();
  await held.getByText('No corrections are waiting for review.').waitFor();
  const declined=await last('payroll.correction.decline');assert.equal(declined.target.id,'h2');assert.deepEqual(declined.input,{note:'Paid correctly at the time'});
  await page.evaluate(()=>{window.promptAnswer=null;});

  // Back pay goes into an off-cycle run through the existing off-cycle flow, and the run reports its refresh.
  await page.locator('[data-action="off-cycle-requested"]:not([disabled])').click();
  await page.locator('[data-pay-panel] [data-run-refresh]').waitFor();
  const offCycleRun=await last('payroll.batch.create');assert.equal(offCycleRun.input.run_type,'off_cycle');assert.deepEqual(offCycleRun.input.entry_ids,['o1']);assert.equal(offCycleRun.input.schedule_id,'s1');
  await page.locator('[data-pay-off-cycle]').waitFor({state:'detached'});

  // A regular pay run shows what its refresh posted, held and could not work out before the run's contents.
  await page.locator('[data-action="create-batch"]:not([disabled])').click();
  const runSummary=page.locator('.fmp-schedule-body [data-run-refresh]');await runSummary.waitFor();
  assert.equal(await count('payroll.batch.create'),2);
  const summaryText=await runSummary.innerText();
  for(const expected of ['Earnings were refreshed before this pay run was drafted','Alice Adams',"Set this payee's hourly rate.",'may be missing from this pay run'])assert.ok(summaryText.includes(expected),`run summary shows ${expected}`);
  assert.match(summaryText,/CORRECTIONS HELD FOR REVIEW\s*1/i);assert.ok(summaryText.includes('$50.00'));assert.ok(!/includes held/i.test(summaryText));
  assert.ok(await page.evaluate(()=>{const body=document.querySelector('.fmp-schedule-body'),summary=body.querySelector('[data-run-refresh]'),banner=body.querySelector('.fmp-batch-banner');return !!(summary.compareDocumentPosition(banner)&Node.DOCUMENT_POSITION_FOLLOWING);}),'the summary comes before the run');
  await shot('pay-rules-run-created');
  await page.evaluate(()=>tab.destroy());assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
