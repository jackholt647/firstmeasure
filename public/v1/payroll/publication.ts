import { z } from 'zod';
import { registerDataProvider, type DataExport } from '../platform/publication/providers.js';
import { registerAction } from '../platform/publication/actions.js';
import { contentHash } from '../platform/publication/validation.js';
import { backendImplementationDigest } from '../platform/publication/implementation.js';
import type { PublicationContext, SourceRef, TargetRef, AccessPolicy } from '../platform/publication/contracts.js';
import { badRequest, forbidden } from '../platform/errors.js';
import { hasPermission } from '../platform/auth.js';
import { readDocument } from '../platform/storage.js';
import * as store from './storage.js';
import * as service from './service.js';
import * as input from './schemas.js';
import * as contract from './publication-schemas.js';
import { payrollEarnings } from './earnings.js';
import { listPayrollTimesheets, correctPayrollTimesheet, approvePayrollTimesheet, rejectPayrollTimesheet } from './timesheets.js';
import { generatePayrollArtifact, PAYROLL_EXPORT_CATALOG } from './exports.js';
import { payRuleExports, registerPayRuleActions } from './pay-rule-publication.js';
import { readPayDefault } from './pay-rules.js';
import './assignee-cleanup.js';
import { payrollDashboard, payrollContractors, payrollDirectory, createPayrollRun, updatePayrollRunItem, actOnPayrollRun, assertRunManageable, assertRunCreatable, assertRunItemManageable, assertShiftManageable, myPayRunApprovals, decideOnPayRun } from './operations.js';
import { payeeScope, scopedBatch, scopedUpcoming, assertPayeeManageable } from './payee-scope.js';
import { finalizedWorkToPay } from './finalized-work.js';
import { listOffCyclePayments, offCyclePaymentInputSchema, readOffCyclePayment, recordOffCyclePayment, removeOffCyclePayment } from './off-cycle.js';

type Obj=Record<string,any>;
const org:AccessPolicy={scopes:['organization'],permissions:['manage_payroll|manage_company_settings'],capabilities:['apps.payroll'],authorize:ctx=>{
  // Bundles must preserve the existing Payroll HTTP permission alternative.
  if(!ctx.auth || !hasPermission(ctx.auth,'manage_payroll|manage_company_settings'))throw forbidden('payroll_access','Payroll management access is required.');
}};
const both:AccessPolicy={...org,scopes:['organization','project']};
// Discovery checks capabilities; concrete references and mutations check project ownership.
const projectMutation:AccessPolicy={...both,authorize:async(ctx,target)=>{await org.authorize!(ctx,target);if(target.scope==='project')await readDocument(ctx.organizationId,'projects',target.projectId!);}};
const self:AccessPolicy={scopes:['organization'],applications:false,permissions:[],capabilities:['payroll.self_service_earnings'],authorize:ctx=>{if(!ctx.auth)throw forbidden('payroll_subject_required','Personal earnings require a current signed-in user.');}};
/** The signed-in user's own timesheets: the time clock permission, the time clock feature, nothing about payroll. */
const SELF_CLOCK='crew.time_clock.use';
const selfClock:AccessPolicy={scopes:['organization'],applications:false,permissions:[SELF_CLOCK],capabilities:['crew.time_clock'],authorize:ctx=>{if(!ctx.auth)throw forbidden('payroll_subject_required','Your timesheets need a current signed-in user.');if(!hasPermission(ctx.auth,SELF_CLOCK))throw forbidden('time_clock_permission','Seeing your timesheets needs the time clock permission.');}};
/** A named pay run approver: being named on the run is the authority, checked by the run itself. */
const approver:AccessPolicy={scopes:['organization'],applications:false,permissions:[],capabilities:['apps.payroll'],authorize:ctx=>{if(!ctx.auth)throw forbidden('payroll_subject_required','Pay run approvals need a current signed-in user.');}};
function principal(ctx:PublicationContext){if(!ctx.auth)throw forbidden('payroll_principal','A current authorized user is required.');return ctx.auth;}
function recordId(target:TargetRef){if(!target.id)throw badRequest('payroll_target_required','Choose the target payroll record.');return target.id;}
function options(ref:SourceRef){const args=contract.querySchema.parse(ref.args||{});if(ref.target.scope==='project'&&args.project_id&&args.project_id!==ref.target.projectId)throw forbidden('payroll_project_denied','Payroll filters cannot override the target project.');return {...args,...(ref.target.scope==='project'?{project_id:ref.target.projectId}:{})};}
async function authorizeArgs(ctx:PublicationContext,ref:SourceRef){const args=options(ref);if(args.project_id)await readDocument(ctx.organizationId,'projects',args.project_id);if(ref.export==='entry'){const row=await store.readPayrollLedgerEntry(ctx.organizationId,recordId(ref.target));if(args.project_id&&row.project_id!==args.project_id)throw forbidden('payroll_project_denied','This earning belongs to another project.');}}
function ledgerOptions(o:Obj){return {...o,...(o.from?{eligible_from:o.from}:{}),...(o.through?{eligible_through:/^\d{4}-\d{2}-\d{2}$/.test(o.through)?o.through+'T23:59:59.999Z':o.through}:{}),...(o.include_projected===false&&!o.state?{state:'accrued'}:{})};}
function artifactLink(orgId:string,value:Obj){return {...value,download_url:`/v1/payroll/organizations/${encodeURIComponent(orgId)}/artifacts/${encodeURIComponent(value.id)}/download`};}
async function load(name:string,ctx:PublicationContext,ref:SourceRef):Promise<any>{
 const o=options(ref),orgId=ctx.organizationId;
 switch(name){
  case 'records':{const scope=payeeScope(ctx.auth,o);return (await store.listPayrollLedgerEntries(orgId,ledgerOptions(o))).filter(row=>scope.visible(row.payee));}
  case 'entry':{const row=await store.readPayrollLedgerEntry(orgId,recordId(ref.target));if(o.project_id&&row.project_id!==o.project_id)throw forbidden('payroll_project_denied','This earning belongs to another project.');if(!payeeScope(ctx.auth).visible(row.payee))throw forbidden('branch_scope_denied','This earning belongs to a branch you cannot see.');return row;}
  case 'schedules':return store.listPayrollSchedules(orgId,o.include_archived);
  case 'schedule':return store.readPayrollSchedule(orgId,recordId(ref.target));
  case 'configuration':return {schedules:await store.listPayrollSchedules(orgId,true),schedule_choices:(await readPayDefault(orgId,{type:'organization',id:orgId})).schedules||[]};
  case 'upcoming':return scopedUpcoming(await service.upcomingPayroll(orgId,o),payeeScope(ctx.auth,o));
  case 'dashboard':return scopedUpcoming(await payrollDashboard(orgId,o),payeeScope(ctx.auth,o));
  case 'batches':{const scope=payeeScope(ctx.auth,o);return (await store.listPayrollBatches(orgId,o)).map(batch=>scopedBatch(batch,scope));}
  case 'batch':return scopedBatch(await store.readPayrollBatch(orgId,recordId(ref.target)),payeeScope(ctx.auth,o));
  case 'earnings':{if(!o.payees?.length)throw badRequest('payroll_payees_required','Select one or more payroll payees.');const scope=payeeScope(ctx.auth);if(o.payees.some(payee=>!scope.visible(payee)))throw forbidden('branch_scope_denied','One of these payees belongs to a branch you cannot see.');return payrollEarnings(orgId,o.payees,o);}
  case 'my_earnings':return payrollEarnings(orgId,[{type:'organization_user',id:principal(ctx).userId}],o);
  case 'timesheets':{const scope=payeeScope(ctx.auth,o),result=await listPayrollTimesheets(orgId,o);if(!scope.active)return result;const timesheets=result.timesheets.filter(row=>scope.visible({type:'organization_user',id:row.user_id}));return {...result,timesheets,count:timesheets.length};}
  case 'my_timesheets':return listPayrollTimesheets(orgId,{...o,user_id:principal(ctx).userId});
  case 'my_approvals':return myPayRunApprovals(principal(ctx));
  case 'finalized_work':return finalizedWorkToPay(orgId,payeeScope(ctx.auth,o));
  case 'off_cycle_payments':{const scope=payeeScope(ctx.auth,o);return (await listOffCyclePayments(orgId,{payee_type:o.payee_type,payee_id:o.payee_id})).filter(row=>scope.visible(row.payee));}
  case 'contractors':return payrollContractors(orgId);
  case 'directory':return payrollDirectory(orgId);
  case 'export_catalog':return PAYROLL_EXPORT_CATALOG;
  case 'artifacts':return (await store.listPayrollArtifacts(orgId,o)).map(row=>artifactLink(orgId,row));
  case 'artifact':return artifactLink(orgId,await store.readPayrollArtifact(orgId,recordId(ref.target)));
 }
 throw badRequest('payroll_export_unknown','Unknown payroll export.');
}
export const payrollDataExports=['records','entry','schedules','schedule','configuration','upcoming','dashboard','batches','batch','earnings','my_earnings','timesheets','my_timesheets','my_approvals','off_cycle_payments','finalized_work','contractors','directory','export_catalog','artifacts','artifact'] as const;
const descriptions:Record<string,string>={records:'Payroll earnings ledger with payee identity, earning kind/state, currency, schedule, eligibility, remaining balance and source evidence. Projected earnings are forecasts; accrued earnings are earned. Does not reconcile or post earnings.',entry:'One payroll earning and its provenance.',schedules:'Payroll schedules, recurrence, timezone, recognition and clawback rules.',schedule:'One payroll schedule.',configuration:'Pay schedules, and under `schedule_choices` which of them the organization pays everyone on by default and per kind of earning. A role, a type of group or company, or one payee may choose differently; read pay_defaults and pay_setup for those.',upcoming:'Scheduled payroll occurrences with earned, projected and batch amounts, payees and diagnostics. Forecasts depend on recorded ledger entries.',dashboard:'Payroll overview with schedules, upcoming payments and batch history.',batches:'Payroll run history with per-payee items and allocated earnings.',batch:'One payroll run, approvals, payment references and earning allocations.',earnings:'Selected users or connected organizations: projected, earned, owed, reserved and paid earnings by project with payment history and truncation flags.',my_earnings:'Current user earnings only, including project breakdown and payment history.',timesheets:'Payroll timesheets, clock records, locations and approval evidence.',contractors:'Payroll contractor directory with payment terms; excludes credentials and private workforce fields.',export_catalog:'Available payroll reports and CSV/PDF formats.',artifacts:'Generated payroll reports with metadata and authorized download links; no file bytes.',artifact:'One generated payroll report and its authorized download link.',my_timesheets:'The signed-in user\'s own timesheets: clock records, breaks, projects and whether each was approved. Needs only the time clock permission.',my_approvals:'Pay runs waiting for the signed-in user\'s decision as a named approver, with who is paid what. Being named on the run is the authority.',finalized_work:'Work orders finalized to be paid at closeout, newest first, with the earnings their pay rules produced: pay_state not_earned (no earning yet: refresh earnings, or the assignee is not paid by a rule that reads committed labor), waiting (earned, not in a pay run) or in_pay_run.',off_cycle_payments:'Payments recorded as made outside a pay run, per payee and kind of earning: how much, when, the reference, how much the next pay runs have taken off (`subtracted_cents`) and how much is still to be taken off (`waiting_cents`).'};
const schemas:Record<string,z.ZodTypeAny>={records:z.array(contract.ledgerSchema),entry:contract.ledgerSchema,schedules:z.array(contract.scheduleSchema),schedule:contract.scheduleSchema,configuration:contract.configurationSchema,upcoming:contract.upcomingSchema,dashboard:contract.dashboardSchema,batches:z.array(contract.batchSchema),batch:contract.batchSchema,earnings:contract.earningsSchema,my_earnings:contract.earningsSchema,timesheets:contract.timesheetsSchema,contractors:contract.contractorSchema,my_timesheets:contract.timesheetsSchema,my_approvals:contract.approvalsSchema,off_cycle_payments:z.array(contract.offCyclePaymentSchema),finalized_work:z.array(z.object({}).passthrough()),export_catalog:contract.exportCatalogSchema,artifacts:z.array(contract.artifactSchema),artifact:contract.artifactSchema};
descriptions.directory='Read-only payroll assignment subjects: users, connected companies, access roles and resource groups with active members.';
schemas.directory=contract.contractorSchema.extend({roles:z.array(z.object({id:z.string(),name:z.string(),status:z.string(),application_ids:z.array(z.string())})),resource_groups:z.array(z.object({id:z.string(),name:z.string(),status:z.string(),members:z.array(z.object({user_id:z.string(),status:z.string()}))}).passthrough())});
const paged=new Set(['records','batches','artifacts']);
let registered=false;
export function registerPayrollPublication(){
 if(registered)return;registered=true;
 const exports:Record<string,DataExport>={};
 for(const name of payrollDataExports){
  const access=name==='my_earnings'?self:name==='my_timesheets'?selfClock:name==='my_approvals'?approver:['records','entry','earnings','timesheets'].includes(name)?both:org;
  const argsSchema=['my_earnings','my_timesheets','my_approvals'].includes(name)?contract.querySchema.omit({payees:true,payee_id:true,payee_type:true,user_id:true,branch_ids:true}):contract.querySchema;
  exports[name]={description:descriptions[name]!,schema:contract.jsonSchema(schemas[name]!),schemaVersion:'2',argsSchema:contract.jsonSchema(argsSchema),access,
   authorizeRef:async(ctx,ref)=>{argsSchema.parse(ref.args||{});await authorizeArgs(ctx,ref);},
   ...(['my_earnings','my_timesheets','my_approvals'].includes(name)?{authorizeSnapshot:(ctx:PublicationContext,_ref:SourceRef,result:any)=>{if(result.provenance.payeeUserId!==principal(ctx).userId)throw forbidden('payroll_snapshot_subject','These retained earnings belong to another user.');}}:{}),
   units:{amount_cents:'currency minor units',remaining_cents:'currency minor units',net_cents:'currency minor units',worked_seconds:'seconds'},
   read:async(ctx,ref)=>{const value=await load(name,ctx,ref);return {value,revision:contentHash(value),provenance:{domain:'payroll',...(['my_earnings','my_timesheets','my_approvals'].includes(name)?{payeeUserId:principal(ctx).userId}:{}),...(paged.has(name)?{bounded:true,limit:options(ref).limit|| (name==='records'?500:100),possiblyTruncated:value.length===(options(ref).limit||(name==='records'?500:100))}: {})}};},
   ...(paged.has(name)?{listItemSchema:contract.jsonSchema(name==='records'?contract.ledgerSchema:name==='batches'?contract.batchSchema:contract.artifactSchema),list:async(ctx:PublicationContext,ref:SourceRef,page:{limit:number;cursor?:string})=>{
    let offset=0;const signature=contentHash({ref,user:ctx.auth?.userId});if(page.cursor){try{const cursor=JSON.parse(Buffer.from(page.cursor,'base64url').toString());if(cursor.signature!==signature||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{throw badRequest('payroll_cursor_invalid','The payroll cursor does not match this query.');}}
    const o={...options(ref),limit:page.limit+1,offset};const rows=name==='records'?await store.listPayrollLedgerEntries(ctx.organizationId,ledgerOptions(o)):name==='batches'?await store.listPayrollBatches(ctx.organizationId,o):(await store.listPayrollArtifacts(ctx.organizationId,o)).map(row=>artifactLink(ctx.organizationId,row));
    const items=rows.slice(0,page.limit);return {items,revision:contentHash(items),provenance:{observation:'page',offset},...(rows.length>page.limit?{nextCursor:Buffer.from(JSON.stringify({signature,offset:offset+page.limit})).toString('base64url')}: {})};
   }}:{})};
 }
 registerDataProvider({id:'payroll',version:'1',apps:['payroll'],exports:{...exports,...payRuleExports()}});
 registerPayRuleActions();
 const readActions:Record<string,string>={'payroll.upcoming.read':'upcoming','payroll.dashboard.read':'dashboard','payroll.ledger.list':'records','payroll.ledger.read':'entry','payroll.schedules.list':'schedules','payroll.schedule.read':'schedule','payroll.configuration.read':'configuration','payroll.batches.list':'batches','payroll.batch.read':'batch','payroll.earnings.read':'earnings','payroll.earnings.me':'my_earnings','payroll.timesheets.list':'timesheets','payroll.timesheets.me':'my_timesheets','payroll.approvals.mine':'my_approvals','payroll.offCycle.list':'off_cycle_payments','payroll.finalizedWork.list':'finalized_work','payroll.contractors.list':'contractors','payroll.exports.catalog':'export_catalog','payroll.artifacts.list':'artifacts','payroll.artifact.read':'artifact'};
 const add=(id:string,schema:z.ZodTypeAny,output:z.ZodTypeAny,effect:'read'|'write',access:AccessPolicy,execute:(ctx:PublicationContext,target:TargetRef,value:any)=>Promise<any>)=>registerAction({id,version:'1',implementation:contentHash({artifact:backendImplementationDigest(),id,source:execute.toString()}),domain:'payroll',description:descriptions[readActions[id]||'']||id.replaceAll('.',' '),inputSchema:contract.jsonSchema(schema),validateInput:value=>schema.parse(value),outputSchema:contract.jsonSchema(output),effect,executionKinds:['api','agent','module','work'],idempotency:effect==='read'?'none':'required',policy:access,execute:async(ctx,target,value)=>JSON.parse(JSON.stringify(await execute(ctx,target,schema.parse(value))))});
 for(const [id,name]of Object.entries(readActions))add(id,['my_earnings','my_timesheets','my_approvals'].includes(name)?contract.querySchema.omit({payees:true,payee_id:true,payee_type:true,user_id:true,branch_ids:true}):contract.querySchema,schemas[name]!,'read',exports[name]!.access,async(ctx,target,args)=>{const ref={provider:'payroll',export:name,target,args};await exports[name]!.authorizeRef!(ctx,ref);return load(name,ctx,ref);});
 add('payroll.directory.read',z.object({}).strict(),schemas.directory!,'read',org,(ctx,t)=>load('directory',ctx,{provider:'payroll',export:'directory',target:t}));
 const empty=z.object({}).strict(),obj=z.object({}).passthrough();
 add('payroll.schedule.create',input.payrollScheduleInputSchema,contract.scheduleSchema,'write',org,(ctx,_t,v)=>store.createPayrollSchedule(ctx.organizationId,v));
 add('payroll.schedule.update',input.payrollSchedulePatchSchema,contract.scheduleSchema,'write',org,(ctx,t,v)=>store.patchPayrollSchedule(ctx.organizationId,recordId(t),v));
 add('payroll.schedule.archive',z.object({expected_revision:z.number().int().positive()}).strict(),contract.scheduleSchema,'write',org,(ctx,t,v)=>store.archivePayrollSchedule(ctx.organizationId,recordId(t),v.expected_revision));
 add('payroll.ledger.post',input.payrollLedgerBatchInputSchema,z.array(contract.ledgerSchema),'write',projectMutation,async(ctx,t,v)=>{for(const entry of v.entries){if(t.scope==='project'&&entry.project_id&&entry.project_id!==t.projectId)throw forbidden('payroll_project_denied','An earning cannot override the project target.');if(t.scope==='project')entry.project_id=t.projectId;if(entry.project_id)await readDocument(ctx.organizationId,'projects',entry.project_id);}return service.recordPayrollLedgerEntries(ctx.organizationId,v.entries);});
 const entryAccess:AccessPolicy={...both,authorize:async(ctx,t)=>{await both.authorize!(ctx,t);const row=await store.readPayrollLedgerEntry(ctx.organizationId,recordId(t));if(t.scope==='project'&&row.project_id!==t.projectId)throw forbidden('payroll_project_denied','This earning belongs to another project.');assertPayeeManageable(payeeScope(ctx.auth),row.payee);}};
 add('payroll.projection.accrue',empty,contract.ledgerSchema,'write',entryAccess,(ctx,t)=>service.accruePayrollProjection(ctx.organizationId,recordId(t)));
 add('payroll.ledger.reverse',input.payrollLedgerReverseSchema,contract.ledgerSchema,'write',entryAccess,(ctx,t,v)=>service.reversePayrollLedgerEntry(ctx.organizationId,recordId(t),v));
 add('payroll.batch.create',input.payrollBatchCreateSchema,z.object({batch:contract.batchSchema,contractor_payables:z.array(obj),earnings_refresh:obj.optional()}),'write',org,async(ctx,_t,v)=>{await assertRunCreatable(principal(ctx),v.schedule_id,v.pay_date);return createPayrollRun(principal(ctx),v);});
 add('payroll.batch.item.update',input.payrollBatchItemPatchSchema.extend({item_id:input.payrollIdSchema}),z.object({batch:contract.batchSchema,contractor_disbursements:z.array(obj)}),'write',org,async(ctx,t,v)=>{await assertRunItemManageable(principal(ctx),recordId(t),v.item_id);return updatePayrollRunItem(principal(ctx),recordId(t),v.item_id,v);});
 add('payroll.batch.action',input.payrollBatchActionSchema,z.object({batch:contract.batchSchema,contractor_disbursements:z.array(obj)}),'write',org,async(ctx,t,v)=>{if(!['approve','reject'].includes(v.action))await assertRunManageable(principal(ctx),recordId(t));return actOnPayrollRun(principal(ctx),recordId(t),v);});
 const correction=z.object({expected_revision:z.number().int().positive(),clocked_in_at:z.string().optional(),clocked_out_at:z.string().optional(),break_seconds:z.number().min(0).optional(),project_id:z.string().optional(),manager_note:z.string().max(1000).optional()}).strict();
 add('payroll.timesheet.correct',correction,contract.timesheetSchema,'write',org,async(ctx,t,v)=>{await assertShiftManageable(principal(ctx),recordId(t));if(v.project_id)await readDocument(ctx.organizationId,'projects',v.project_id);return correctPayrollTimesheet(ctx.organizationId,recordId(t),v,principal(ctx).userId);});
 add('payroll.timesheet.approve',correction,contract.timesheetSchema,'write',org,async(ctx,t,v)=>{await assertShiftManageable(principal(ctx),recordId(t));if(v.project_id)await readDocument(ctx.organizationId,'projects',v.project_id);return approvePayrollTimesheet(ctx.organizationId,recordId(t),v,principal(ctx).userId);});
 add('payroll.timesheet.reject',correction,contract.timesheetSchema,'write',org,async(ctx,t,v)=>{await assertShiftManageable(principal(ctx),recordId(t));return rejectPayrollTimesheet(ctx.organizationId,recordId(t),v,principal(ctx).userId);});
 add('payroll.artifact.generate',input.payrollExportCreateSchema,contract.artifactSchema,'write',org,async(ctx,_t,v)=>artifactLink(ctx.organizationId,await generatePayrollArtifact(ctx.organizationId,v,principal(ctx).userId,payeeScope(principal(ctx),v))));
 const named=(ctx:PublicationContext)=>({userId:principal(ctx).userId,name:String(principal(ctx).user?.name||principal(ctx).user?.email||'')});
 add('payroll.offCycle.record',offCyclePaymentInputSchema,contract.offCyclePaymentSchema,'write',org,async(ctx,_t,v)=>{assertPayeeManageable(payeeScope(ctx.auth),v.payee);return recordOffCyclePayment(ctx.organizationId,v,named(ctx));});
 add('payroll.offCycle.remove',z.object({}).strict(),contract.offCyclePaymentSchema,'write',org,async(ctx,t)=>{assertPayeeManageable(payeeScope(ctx.auth),(await readOffCyclePayment(ctx.organizationId,recordId(t))).payee);return removeOffCyclePayment(ctx.organizationId,recordId(t),named(ctx));});
 add('payroll.batch.decide',z.object({decision:z.enum(['approve','reject']),note:z.string().trim().max(1000).optional()}).strict(),contract.approvalSchema,'write',approver,(ctx,t,v)=>decideOnPayRun(principal(ctx),recordId(t),v));
 // How someone is paid (employee or independent contractor, and their payment terms) is pay data and people data: payroll, user or company settings managers may change it.
 const classification:AccessPolicy={...org,permissions:['manage_payroll|manage_company_users|manage_company_settings'],authorize:ctx=>{if(!ctx.auth||!hasPermission(ctx.auth,'manage_payroll|manage_company_users|manage_company_settings'))throw forbidden('payroll_classification_access','Changing how someone is paid needs payroll, user or company settings management.');}};
 const terms=z.object({basis:z.enum(['payroll_schedule','net_days']),net_days:z.number().int().min(0).max(365)}).strict();
 add('payroll.contractor.worker.update',z.object({worker_classification:z.enum(['employee','independent_contractor']),payment_terms:terms}).strict(),z.object({id:z.string(),worker_classification:z.string(),payment_terms:z.record(z.unknown())}).passthrough(),'write',classification,async(ctx,t,v)=>{const row=await (await import('../workforce/service.js')).patchWorkforceUserProfile(ctx.organizationId,recordId(t),v);return {id:row.id,name:row.name,worker_classification:row.worker_classification,payment_terms:row.payment_terms};});
 add('payroll.contractor.company.update',z.object({expected_revision:z.number().int().positive(),payment_terms:terms}).strict(),z.object({id:z.string(),revision:z.number(),payment_terms:z.record(z.unknown())}).passthrough(),'write',{...org,permissions:['manage_company_settings']},async(ctx,t,v)=>{const row=await (await import('../connections/storage.js')).patchOrganizationConnection(ctx.organizationId,recordId(t),v);return {id:row.id,name:row.name,revision:row.revision,payment_terms:row.payment_terms};});
}
