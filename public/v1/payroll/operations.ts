/** Shared orchestration for HTTP and publication consumers. Domain services own effects. */
import type { PlatformAuthContext } from '../platform/auth.js';
import { hydratedWorkforceUser } from '../workforce/service.js';
import { listDocuments } from '../platform/storage.js';
import { getWorkforceDatabase, listAssignmentGroups } from '../workforce/storage.js';
import { listOrganizationConnections } from '../connections/storage.js';
import { asObject, cleanText, listPayrollPolicies, listPayrollBatches, type JsonObject } from './storage.js';
import { upcomingPayroll, createPayrollBatch, patchPayrollBatchItem, applyPayrollBatchAction } from './service.js';
import { syncContractorPayrollPayables, syncPaidContractorPayrollDisbursements } from './contractor_disbursements.js';
import { syncPaidPayrollReimbursements } from '../payments/reimbursements.js';

export async function payrollDashboard(orgId:string,options:JsonObject={}){
  return {...await upcomingPayroll(orgId,options),policies:await listPayrollPolicies(orgId),history:await listPayrollBatches(orgId,{...options,limit:Number(options.history_limit||100)})};
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
  const batch=await createPayrollBatch(ctx.orgId,input,ctx.userId);
  const contractor_payables=await syncContractorPayrollPayables(ctx.orgId,batch,ctx);
  return {batch,contractor_payables};
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
