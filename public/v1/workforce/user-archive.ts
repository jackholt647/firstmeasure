import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {PlatformAuthContext} from '../platform/auth.js';
import {badRequest,forbidden,notFound} from '../platform/errors.js';
import {readDocument,upsertDocument} from '../platform/storage.js';
import {registerAction} from '../platform/publication/actions.js';
import type {PublicationContext} from '../platform/publication/contracts.js';
import {backendImplementationDigest} from '../platform/publication/implementation.js';
import {guardUserCollection} from './branch-guards.js';

/**
 * Removing a person archives them (docs/architecture/branches.md, People): the user document is kept for the record,
 * with `deleted: true`, when and by whom, and status `disabled` so sign-in is refused. Their roles, groups,
 * departments and assignments stay as they were, so `workforce.users.restore` brings them back intact.
 */
type Obj=Record<string,unknown>;
const text=(value:unknown)=>String(value??'').trim();
const record=(value:unknown):Obj=>value&&typeof value==='object'&&!Array.isArray(value)?value as Obj:{};
const ARCHIVE_FIELDS=['deleted','deleted_at','deleted_by','archived_reason','status_before_archive'] as const;

export async function archiveOrganizationUser(ctx:PlatformAuthContext,userId:string,reason=''){
  const id=text(userId);
  if(id===ctx.userId)throw forbidden('self_user_delete_forbidden','You cannot delete your own organization user record.');
  await guardUserCollection(ctx,'write',id);
  const document=await readDocument(ctx.orgId,'users',id).catch(()=>null);
  if(!document)return false;
  const data=record(document.data);
  if(data.deleted===true)return true;
  const status=text(data.status)||'active';
  await upsertDocument(ctx.orgId,'users',{id,data:{...data,deleted:true,deleted_at:new Date().toISOString(),deleted_by:ctx.userId,status:'disabled',disabled:true,status_before_archive:status,...(text(reason)?{archived_reason:text(reason).slice(0,500)}:{})}},{mustExist:true});
  // A removed person is no longer an assignee: what was kept against them is cleaned up as for a group or company, and
  // payroll works out their pay through today before closing it (payroll/assignee-cleanup.ts). The archive is the
  // authority for this, so it runs as the platform; a step that fails is reported by the step and the archive stands.
  await (await import('../assignees/base.js')).cleanupAssignee(ctx.orgId,{type:'organization_user',id},{orgId:ctx.orgId,userId:ctx.userId,system:true}).catch(()=>null);
  return true;
}

export const userRestoreSchema=z.object({}).strict();
export async function restoreOrganizationUser(ctx:PlatformAuthContext,userId:string){
  const id=text(userId);
  if(!id)throw badRequest('user_required','Name the person to restore.');
  await guardUserCollection(ctx,'write',id);
  const document=await readDocument(ctx.orgId,'users',id).catch(()=>null);
  if(!document)throw notFound('user_not_found','This person no longer exists.');
  const data={...record(document.data)};
  if(data.deleted!==true)return {id,status:text(data.status)||'active',restored:false};
  // An invited person goes back to invited and a suspended one stays suspended; everyone else is active again.
  const before=text(data.status_before_archive);
  const status=before==='invited'?'invited':before==='disabled'?'disabled':'active';
  for(const key of ARCHIVE_FIELDS)delete data[key];
  data.status=status;
  data.disabled=status==='disabled';
  await upsertDocument(ctx.orgId,'users',{id,data,metadata:record(document.metadata)},{replace:true,mustExist:true});
  return {id,status,restored:true};
}

let registered=false;
export function registerUserArchivePublication(){
  if(registered)return;
  registered=true;
  registerAction({
    id:'workforce.users.restore',version:'1',domain:'workforce',effect:'write',executionKinds:['api','agent'],idempotency:'required',implementation:backendImplementationDigest(),
    description:'restore an archived person: they can sign in again with the roles, groups and departments they had. The target id is the user. Needs manage_company_users and the person in a branch the caller manages.',
    inputSchema:zodToJsonSchema(userRestoreSchema,{$refStrategy:'none'}) as Obj,
    outputSchema:{type:'object',required:['id','status','restored'],properties:{id:{type:'string'},status:{type:'string'},restored:{type:'boolean'}},additionalProperties:false},
    policy:{scopes:['organization'],permissions:['manage_company_users']},
    execute:async(ctx:PublicationContext,target)=>{
      if(!ctx.auth)throw forbidden('user_restore_denied','A signed-in person is required.');
      return restoreOrganizationUser(ctx.auth,text((target as Obj).id));
    }
  } as Parameters<typeof registerAction>[0]);
}
