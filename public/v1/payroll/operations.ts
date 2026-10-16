/** Shared orchestration for HTTP and publication consumers. Domain services own effects. */
import type { PlatformAuthContext } from '../platform/auth.js';
import { hydratedWorkforceUser } from '../workforce/service.js';
import { listDocuments } from '../platform/storage.js';
import { getWorkforceDatabase, listAssignmentGroups } from '../workforce/storage.js';
import { listOrganizationConnections } from '../connections/storage.js';
import { asArray, asObject, cleanText, listPayrollBatches, listPayrollSchedules, readPayrollBatch, type JsonObject } from './storage.js';
import { forbidden } from '../platform/errors.js';
import { payeeScope, assertPayeeManageable } from './payee-scope.js';
import { readCrewTimeShift } from '../workforce/crew_storage.js';
import { upcomingPayroll, createPayrollBatch, patchPayrollBatchItem, applyPayrollBatchAction } from './service.js';
import { syncContractorPayrollPayables, syncPaidContractorPayrollDisbursements } from './contractor_disbursements.js';
import { syncPaidPayrollReimbursements } from '../payments/reimbursements.js';
import { refreshOrganizationEarnings } from './pay-refresh.js';

export async function payrollDashboard(orgId:string,options:JsonObject={}){
  return {...await upcomingPayroll(orgId,options),history:await listPayrollBatches(orgId,{...options,limit:Number(options.history_limit||100)})};
}
export async function payrollContractors(orgId:string){
  const users:JsonObject[]=(await listDocuments(orgId,'users')).map(row=>({id:row.id,...asObject(row.data)})),connections=await listOrganizationConnections(orgId);
  // Explicit payroll projection: no connection credentials or workforce private profile.
  return {users:users.filter(u=>!['disabled','deleted'].includes(cleanText(u.status))).map(u=>({id:cleanText(u.id),name:cleanText(u.name||u.email),worker_classification:cleanText(u.worker_classification||'employee'),payment_terms:asObject(u.payment_terms)})),connections:connections.map(c=>({id:cleanText(c.id),name:cleanText(c.name),status:cleanText(c.status),revision:c.revision,payment_terms:asObject(c.payment_terms)}))};
}
export async function payrollDirectory(orgId:string){
  const contractors=await payrollContractors(orgId);
  const roles=await getWorkforceDatabase().prepare("SELECT id,name,status,application_ids_json FROM workforce_access_roles WHERE organization_id=? AND status='active' ORDER BY name,id").all(orgId);
  return {...contractors,roles:roles.map(r=>({id:String(r.id),name:String(r.name),status:String(r.status),application_ids:JSON.parse(String(r.application_ids_json||'[]'))})),resource_groups:await listAssignmentGroups(orgId,true)};
}
export async function createPayrollRun(ctx:PlatformAuthContext,input:JsonObject){
  // A pay run pays what the rules say as of now, so work that out first. A rule that cannot be evaluated is reported, not a reason to block the run.
  const earnings_refresh=await refreshOrganizationEarnings(ctx.orgId).then(r=>({posted_count:r.posted_count,posted_cents:r.posted_cents,held_count:r.held_count,unresolved_count:r.unresolved_count,unresolved:r.payees.flatMap(p=>p.unresolved.map(u=>({payee:p.payee,...u}))).slice(0,50)})).catch(error=>({posted_count:0,posted_cents:0,held_count:0,unresolved_count:1,unresolved:[{rule_id:'',reason:String((error as Error)?.message||'Earnings could not be refreshed.')}]}));
  const batch=await createPayrollBatch(ctx.orgId,input,ctx.userId);
  const contractor_payables=await syncContractorPayrollPayables(ctx.orgId,batch,ctx);
  return {batch,contractor_payables,earnings_refresh};
}
async function syncPayments(ctx:PlatformAuthContext,batch:JsonObject){
  await syncPaidPayrollReimbursements(ctx.orgId,batch,ctx);
  return {batch,contractor_disbursements:await syncPaidContractorPayrollDisbursements(ctx.orgId,batch,ctx)};
}
export async function updatePayrollRunItem(ctx:PlatformAuthContext,batchId:string,itemId:string,input:JsonObject){
  return syncPayments(ctx,await patchPayrollBatchItem(ctx.orgId,batchId,itemId,input));
}
export async function actOnPayrollRun(ctx:PlatformAuthContext,batchId:string,input:JsonObject){
  const approvers=input.action==='submit_approval'?await Promise.all((Array.isArray(input.approvers)?input.approvers:[]).map(async value=>{const entry=asObject(value),user=await hydratedWorkforceUser(ctx.orgId,cleanText(entry.user_id));return {user_id:cleanText(entry.user_id),name:cleanText(user.name||user.email||entry.user_id)};})):input.approvers;
  return syncPayments(ctx,await applyPayrollBatchAction(ctx.orgId,batchId,{...input,approvers,actor:{user_id:ctx.userId,name:cleanText(asObject(ctx.user).name||asObject(ctx.user).email)}}));
}

/*
 * Branch scope on payroll writes (docs/architecture/branches.md). Someone who manages only some branches may change
 * what belongs to payees of those branches, and may act on a whole pay run only when every payee in it is theirs.
 */
export async function assertRunManageable(ctx:PlatformAuthContext,batchId:string){
  const scope=payeeScope(ctx);if(!scope.active)return;
  const batch=await readPayrollBatch(ctx.orgId,batchId);
  if(asArray(batch.items).map(asObject).some(item=>!scope.manageable(asObject(item.payee))))throw forbidden('branch_scope_denied','This pay run includes people of branches you do not manage. Someone who manages every branch in it has to do this.');
}
export async function assertRunCreatable(ctx:PlatformAuthContext,scheduleId:string,payDate:string){
  const scope=payeeScope(ctx);if(!scope.active)return;
  const occurrence=asArray((await upcomingPayroll(ctx.orgId,{from:payDate,through:payDate,include_projected:false})).upcoming).map(asObject).find(row=>cleanText(asObject(row.schedule).id)===scheduleId);
  const items=[...asArray(occurrence?.employees),...asArray(occurrence?.subcontractors)].map(asObject);
  if(items.some(item=>!scope.manageable(asObject(item.payee))))throw forbidden('branch_scope_denied','This pay run would include people of branches you do not manage. Someone who manages every branch in it has to draft it.');
}
export async function assertRunItemManageable(ctx:PlatformAuthContext,batchId:string,itemId:string){
  const scope=payeeScope(ctx);if(!scope.active)return;
  const item=asArray((await readPayrollBatch(ctx.orgId,batchId)).items).map(asObject).find(row=>cleanText(row.id)===itemId);
  if(item)assertPayeeManageable(scope,asObject(item.payee));
}
export async function assertShiftManageable(ctx:PlatformAuthContext,shiftId:string){
  const scope=payeeScope(ctx);if(!scope.active)return;
  const shift=await readCrewTimeShift(ctx.orgId,shiftId);
  assertPayeeManageable(scope,{type:'organization_user',id:cleanText(shift.user_id)});
}

/** A pay run as a named approver sees it: who is in it and what each is paid, without the ledger detail behind it. */
function approvalView(batch:JsonObject,userId:string,scheduleNames:Map<string,string>){
  const approval=asObject(batch.approval),decisions=asArray(approval.decisions).map(asObject);
  return {
    id:cleanText(batch.id),schedule_id:cleanText(batch.schedule_id),schedule_name:cleanText(scheduleNames.get(cleanText(batch.schedule_id))),
    pay_date:cleanText(batch.pay_date),period_start:cleanText(batch.period_start),period_end:cleanText(batch.period_end),run_type:cleanText(batch.run_type||'regular'),
    status:cleanText(batch.status),currency:cleanText(batch.currency||'USD'),total_cents:Number(batch.total_cents||0),
    employee_total_cents:Number(batch.employee_total_cents||0),subcontractor_total_cents:Number(batch.subcontractor_total_cents||0),
    approval:{status:cleanText(approval.status),requested_approvers:asArray(approval.requested_approvers).map(asObject).map(a=>({user_id:cleanText(a.user_id),name:cleanText(a.name)})),
      decisions:decisions.map(d=>({user_id:cleanText(d.user_id),name:cleanText(d.name),decision:cleanText(d.decision),note:cleanText(d.note),decided_at:cleanText(d.decided_at)})),
      submitted_by:asObject(approval.submitted_by),submitted_at:cleanText(approval.submitted_at)},
    my_decision:cleanText(decisions.find(d=>cleanText(d.user_id)===userId)?.decision),
    items:asArray(batch.items).map(asObject).map(item=>({payee:{type:cleanText(asObject(item.payee).type),id:cleanText(asObject(item.payee).id),name:cleanText(asObject(item.payee).name),worker_type:cleanText(asObject(item.payee).worker_type||'employee')},
      gross_cents:Number(item.gross_cents||0),deduction_cents:Number(item.deduction_cents||0),net_cents:Number(item.net_cents||0),subgroup_totals:asObject(item.subgroup_totals)}))
  };
}
/** Pay runs waiting for the signed-in user's decision as a named approver. Needs no payroll permission: being named is the authority. */
export async function myPayRunApprovals(ctx:PlatformAuthContext){
  const [runs,schedules]=await Promise.all([listPayrollBatches(ctx.orgId,{limit:200}),listPayrollSchedules(ctx.orgId,true)]);
  const names=new Map(schedules.map(s=>[cleanText(s.id),cleanText(s.name)]));
  const runsList=runs.filter(batch=>cleanText(asObject(batch.approval).status)==='pending'&&asArray(asObject(batch.approval).requested_approvers).map(asObject).some(a=>cleanText(a.user_id)===ctx.userId));
  return {approvals:runsList.map(batch=>approvalView(batch as JsonObject,ctx.userId,names)),count:runsList.length};
}
/** A named approver approves or rejects a pay run waiting for them. applyPayrollBatchAction refuses anyone not named. */
export async function decideOnPayRun(ctx:PlatformAuthContext,batchId:string,input:{decision:'approve'|'reject';note?:string}){
  const batch=await applyPayrollBatchAction(ctx.orgId,batchId,{action:input.decision,note:cleanText(input.note),actor:{user_id:ctx.userId,name:cleanText(asObject(ctx.user).name||asObject(ctx.user).email)}});
  const schedules=await listPayrollSchedules(ctx.orgId,true);
  return approvalView(batch as JsonObject,ctx.userId,new Map(schedules.map(s=>[cleanText(s.id),cleanText(s.name)])));
}
