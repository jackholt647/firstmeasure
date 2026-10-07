import { registerAction } from '../../platform/publication/actions.js';
import type { PublicationContext, TargetRef } from '../../platform/publication/contracts.js';
import { badRequest, forbidden } from '../../platform/errors.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { callDepartmentResource, requireCallAccess } from './service.js';
import { readCall } from './storage.js';
import { superviseCall, supervisionPermissions } from './supervision.js';

async function targetCall(ctx:PublicationContext,target:TargetRef,permission?:string){
  if(!ctx.auth)throw forbidden('supervision_user_required','Call supervision requires an authenticated user.');
  if(!target.id)throw badRequest('call_id_required','Choose a live call.');
  const call=requireCallAccess(ctx.auth,await readCall(ctx.organizationId,target.id));
  if(permission&&!hasResourcePermission(ctx.auth,permission,callDepartmentResource(call)))throw forbidden('supervision_forbidden','This supervision mode is not permitted for this call.');
  return call;
}
let registered=false;
/** Interactive API operations; source analysis is the agent-facing call workflow. */
export function registerSupervisionPublication(){
  if(registered)return;registered=true;
  for(const mode of ['monitor','whisper','barge','takeover','leave'] as const){
    const permission=mode==='leave'?'':supervisionPermissions[mode];
    registerAction({id:`customer-calls.supervision.${mode}`,version:'1',implementation:`customer-calls.supervision.${mode}.v1`,domain:'comms',
      description:mode==='leave'?'Leave your own supervisor session without ending the customer call.':`Request ${mode} participation on an authorized live customer call using your connected browser phone.`,
      effect:'external',idempotency:'required',executionKinds:['api'],
      policy:{scopes:['organization'],permissions:permission?[permission]:[],scopedPermissions:true,capabilities:['apps.comms'],systemKinds:[],authorize:async(ctx,target)=>{await targetCall(ctx,target,permission);}},
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      outputSchema:{type:'object',properties:{call_id:{type:'string'}},required:['call_id'],additionalProperties:false},
      execute:async(ctx,target,_input,execution)=>{const call=await targetCall(ctx,target,permission);await superviseCall(ctx.auth!,call.id,{operation_id:execution.receiptId,mode});return {call_id:call.id};}
    });
  }
}
