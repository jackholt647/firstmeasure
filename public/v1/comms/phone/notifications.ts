import { backgroundAuthContext } from '../../platform/auth.js';
import { hasResourcePermission } from '../../workforce/department-access.js';
import { readDocument, listDocuments } from '../../platform/storage.js';
import { lineMembers, canUseLine } from './service.js';
import * as s from '../calls/storage.js';
export async function notifyText(org:string,message:s.Json,settings:s.Json={}){
  const recipient=(Array.isArray(message.recipients)?message.recipients:[]).map(s.object)[0],number=s.text(recipient?.address),assigned=await lineMembers(org,number),members=assigned.length?assigned:(await listDocuments(org,'users')).map(u=>u.id);
  if(settings.enabled===false)return true;
  const context=s.object(message.context),projectId=s.text(context.project_id||message.project_id),project=projectId?await readDocument(org,'projects',projectId).catch(()=>null):null;
  for(const user of members){const ctx=await backgroundAuthContext(org,user).catch(()=>null);if(!ctx)continue;if(!assigned.length&&(s.strings(settings.target_user_ids).length||s.strings(settings.target_role_ids).length)&&!s.strings(settings.target_user_ids).includes(user)&&!s.strings(settings.target_role_ids).some(role=>s.strings(ctx.user.roles).includes(role)))continue;
    if(!await canUseLine(ctx,number)||!hasResourcePermission(ctx,'view_comms|send_comms|send_communications|manage_communications|manage_company_settings',project?.data||{}))continue;
    const prefs=s.object((await s.resource(org,'phone_personal',user))?.notifications);if(prefs.texts===false)continue;
    const {createPlatformNotification}=await import('../../platform/api.js');await createPlatformNotification(org,{id:s.id('phone_text',`${message.id}:${user}`),title:`New text from ${s.text(s.object(message.sender).name||s.object(message.sender).address)}`,body:s.text(message.text_body).slice(0,180),kind:'comms_message',source:'comms',channel:'passive',push:prefs.push!==false,target_user_ids:[user],branch_id:s.text(message.branch_id)||'default',context:{...context,message_id:message.id,conversation_id:message.conversation_id},frontend_action:projectId?{kind:'open_project_comms',project_id:projectId,comms_view:'sms',conversation_id:message.conversation_id}:{} });
  }
  return true;
}
