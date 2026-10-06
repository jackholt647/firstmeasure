import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('payroll publications expose complete records, safe reads, pagination, subject privacy, typed actions and widgets',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'payroll-publication-'));
 Object.assign(process.env,{NODE_ENV:'test',FIRSTMATE_ENV:'test',PLATFORM_STORAGE_ROOT:root,FIRSTMEASURE_DATABASE_MODE:'local',FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 const core=await import('../platform/storage.js'),store=await import('../payroll/storage.js'),service=await import('../payroll/service.js');
 const {saveCapabilityValues}=await import('../platform/capabilities.js'),{userPublicationContext}=await import('../platform/publication/context.js');
 const {readPublishedData,listPublishedData,describeDataProvider,authorizeSourceSnapshot}=await import('../platform/publication/providers.js');
 const {invokeAction,listActions}=await import('../platform/publication/actions.js');
 const {listWidgets,authorizeWidget}=await import('../platform/widgets/catalog.js');
 try{
  await core.createOrganization({id:'org_paypub',name:'Payroll publications'});
  await saveCapabilityValues('org_paypub',{'platform.expanded_access':true,'apps.payroll':true,'payroll.self_service_earnings':true,'platform.money':true});
  await core.upsertDocument('org_paypub','projects',{id:'project_paypub',data:{title:'Roof'}});
  await core.upsertDocument('org_paypub','projects',{id:'other_project',data:{title:'Other'}});
  await core.upsertDocument('org_paypub','users',{id:'alice',data:{name:'Alice',status:'active',worker_classification:'employee',private_note:'DO NOT PUBLISH'}});
  const auth:any={orgId:'org_paypub',userId:'alice',role:'member',permissions:{manage_payroll:true,manage_company_settings:true,manage_company_users:true},applicationAccess:{management:{enabled:true,permissions:{'*':true}}},capabilities:{effectiveByKey:{'apps.payroll':true,'payroll.self_service_earnings':true}}};
  const ctx=userPublicationContext(auth),command=userPublicationContext(auth,{mode:'command'}),target={scope:'organization' as const,organizationId:'org_paypub'},project={...target,scope:'project' as const,projectId:'project_paypub'};
  (await import('../platform/publication/bootstrap.js')).initializePublication();
  const run=async(action:string,input:any={},id?:string,key=action)=>invokeAction(command,{action,target:{...target,...(id?{id}:{})}},input,{idempotencyKey:key});
  const schedule:any=(await run('payroll.schedule.create',{name:'Weekly',recurrence:{frequency:'weekly',weekday:5}})).value;
  await run('payroll.policy.save',{subject_type:'organization',subject_id:'org_paypub',values:{schedule_id:schedule.id}});
  const entry={payee:{type:'organization_user',id:'alice',name:'Alice'},schedule_id:schedule.id,kind:'commission',state:'accrued',amount_cents:12345,currency:'USD',project_id:'project_paypub',worked_at:'2026-10-01T12:00:00.000Z',source_event_id:'pub-earning'};
  const posted:any=(await run('payroll.ledger.post',{entries:[entry]})).value;
  await run('payroll.ledger.post',{entries:[entry]});assert.equal((await store.listPayrollLedgerEntries('org_paypub')).length,1);
  const record:any=await readPublishedData(ctx,{provider:'payroll',export:'records',target:project});assert.equal(record.status,'ready',JSON.stringify(record));
  assert.equal(record.value[0].payee.id,'alice');assert.equal(record.value[0].kind,'commission');assert.equal(record.value[0].state,'accrued');assert.equal(record.value[0].remaining_cents,12345);assert.ok(record.value[0].eligible_at);assert.equal(record.value[0].source_event_id,'pub-earning');
  assert.ok(describeDataProvider('payroll')!.exports.records!.schema.items);
  for(let i=0;i<205;i++)await service.recordPayrollLedgerEntries('org_paypub',[{...entry,payee:{type:'organization_user',id:'bob',name:'Bob'},source_event_id:'paged-'+i} as any]);
  const first:any=await listPublishedData(ctx,{provider:'payroll',export:'records',target:project},{limit:200});assert.equal(first.status,'ready');assert.equal(first.items.length,200);assert.ok(first.nextCursor);
  const second:any=await listPublishedData(ctx,{provider:'payroll',export:'records',target:project},{limit:200,cursor:first.nextCursor});assert.equal(second.items.length,6);assert.equal(new Set([...first.items,...second.items].map(r=>r.id)).size,206);
  assert.equal((await listPublishedData(ctx,{provider:'payroll',export:'records',target:{...project,projectId:'other_project'}},{cursor:first.nextCursor})).status,'error');
  const before=await store.getPayrollDatabase().prepare('SELECT COUNT(*) AS n FROM payroll_ledger_entries').get();
  const roleCount=await (await import('../workforce/storage.js')).getWorkforceDatabase().prepare('SELECT COUNT(*) AS n FROM workforce_access_roles').get();
  const refs:Record<string,any>={entry:{...project,id:posted[0].id},schedule:{...target,id:schedule.id},project_payees:project};
  for(const name of ['records','entry','schedules','schedule','policies','configuration','project_payees','upcoming','dashboard','batches','earnings','my_earnings','timesheets','contractors','directory','export_catalog','artifacts']){
   const result:any=await readPublishedData(ctx,{provider:'payroll',export:name,target:refs[name]||target,...(name==='earnings'?{args:{payees:[{type:'organization_user',id:'alice'}]}}:{})});
   assert.equal(result.status,'ready',name+': '+JSON.stringify(result));
   if(name==='contractors'||name==='directory')assert.equal(JSON.stringify(result.value).includes('DO NOT PUBLISH'),false);
  }
  assert.deepEqual(await store.getPayrollDatabase().prepare('SELECT COUNT(*) AS n FROM payroll_ledger_entries').get(),before);
  assert.deepEqual(await (await import('../workforce/storage.js')).getWorkforceDatabase().prepare('SELECT COUNT(*) AS n FROM workforce_access_roles').get(),roleCount,'Reads must not seed workforce defaults');
  const own:any=await readPublishedData(ctx,{provider:'payroll',export:'my_earnings',target});assert.equal(own.value.earnings.length,1);assert.equal(own.value.earnings[0].subject.id,'alice');
  assert.equal((await readPublishedData(ctx,{provider:'payroll',export:'my_earnings',target,args:{payees:[{type:'organization_user',id:'bob'}]}})).status,'error');
  await assert.rejects(authorizeSourceSnapshot(userPublicationContext({...auth,userId:'bob'}),{provider:'payroll',export:'my_earnings',target},own));
  assert.equal((await readPublishedData(ctx,{provider:'payroll',export:'records',target:{...target,organizationId:'another_org'}})).status,'denied');
  assert.equal((await readPublishedData(ctx,{provider:'payroll',export:'records',target:project,args:{project_id:'other_project'}})).status,'denied');
  await assert.rejects(invokeAction(command,{action:'payroll.ledger.reverse',target:{...project,projectId:'other_project',id:posted[0].id}},{source_event_id:'bad-reverse'},{idempotencyKey:'bad-reverse'}));
  await assert.rejects(run('payroll.ledger.post',{entries:[{...entry,amount_cents:1.5}]},undefined,'malformed'));
  await assert.rejects(invokeAction(ctx,{action:'payroll.schedule.create',target},{name:'Not allowed',recurrence:{frequency:'weekly',weekday:1}},{idempotencyKey:'evaluation'}));
  const batch:any=(await run('payroll.batch.create',{schedule_id:schedule.id,run_type:'off_cycle',pay_date:'2026-10-02',period_start:'2026-10-01',period_end:'2026-10-02'})).value;
  assert.equal((await readPublishedData(ctx,{provider:'payroll',export:'batch',target:{...target,id:batch.batch.id}})).status,'ready');
  await run('payroll.batch.action',{action:'submit_approval',approvers:[{user_id:'alice'}]},batch.batch.id,'submit-run');
  await run('payroll.batch.action',{action:'approve'},batch.batch.id,'approve-run');
  await run('payroll.batch.action',{action:'finalize'},batch.batch.id,'finalize-run');
  await run('payroll.batch.action',{action:'paid'},batch.batch.id,'paid-run');
  const artifact:any=(await run('payroll.artifact.generate',{type:'payroll_register',format:'csv',batch_id:batch.batch.id})).value;assert.ok(artifact.download_url);assert.equal(artifact.content,undefined);
  assert.equal((await readPublishedData(ctx,{provider:'payroll',export:'artifact',target:{...target,id:artifact.id}})).status,'ready');
  const widgets=(await listWidgets(ctx,target)).filter(w=>w.app==='payroll');assert.equal(widgets.length,11);assert.equal((await listWidgets(ctx)).filter(w=>w.app==='payroll').length,12);
  await authorizeWidget(ctx,'payroll.upcoming','1',target,{include_projected:false});await authorizeWidget(ctx,'payroll.project_payees','1',project,{});await assert.rejects(authorizeWidget(ctx,'payroll.upcoming','99',target,{}));
  const denied=userPublicationContext({...auth,role:'member',permissions:{manage_payroll:false,manage_company_settings:false}});assert.equal((await readPublishedData(denied,{provider:'payroll',export:'records',target})).status,'denied');assert.deepEqual((await listWidgets(denied,target)).filter(w=>w.app==='payroll').map(w=>w.id),['payroll.my_earnings']);
  assert.ok(listActions().filter(a=>a.domain==='payroll'&&a.executionKinds.includes('agent')).length>=40);
 }finally{await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await rm(root,{recursive:true,force:true}).catch(()=>{});}
});
