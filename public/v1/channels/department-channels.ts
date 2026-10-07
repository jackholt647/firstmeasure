import type {PlatformAuthContext} from '../platform/auth.js';
import {badRequest} from '../platform/errors.js';
import {resolveOrganizationStructure} from '../workforce/organization-structure.js';
import {createChannelRecord,findChannelByDmKey,updateChannelRecord,upsertChannelMember,listChannelMembers,removeChannelMember,type ChannelRow,type ChannelMemberRow} from './storage.js';

/** Department membership is resolved by ID, never by a display label. */
export async function departmentMemberIds(orgId:string,departmentIds:string[]) {
  if(!departmentIds.length)return [];
  const structure=await resolveOrganizationStructure(orgId);
  const valid=new Set(structure.catalog.departments.filter(d=>d.status!=='archived').map(d=>d.id));
  if(departmentIds.some(id=>!valid.has(id)))throw badRequest('unknown_department','Choose an active department in this organization.');
  return [...new Set(structure.users.filter(user=>user.department_ids.some(id=>departmentIds.includes(id))).map(user=>user.id))];
}
export async function departmentChannelMembers(channel:ChannelRow):Promise<string[]|null>{
  const id=String(channel.settings.department_id||'');
  if(!id)return null;
  const structure=await resolveOrganizationStructure(channel.organization_id);
  if(!structure.catalog.departments.some(d=>d.id===id&&d.status!=='archived'))return [];
  return structure.users.filter(u=>u.department_ids.includes(id)).map(u=>u.id);
}
export async function effectiveChannelMembers(channel:ChannelRow):Promise<ChannelMemberRow[]>{
  const members=await listChannelMembers(channel.id),ids=await departmentChannelMembers(channel);
  if(!ids)return members;
  return ids.map(id=>members.find(m=>m.user_id===id)||{organization_id:channel.organization_id,channel_id:channel.id,user_id:id,role:'member',notify_level:'mentions',joined_at:channel.created_at});
}
/** Called on explicit department saves only. Reading channels never creates departments. */
export async function syncDepartmentChannels(ctx:PlatformAuthContext){
  const structure=await resolveOrganizationStructure(ctx.orgId);
  const active=structure.catalog.departments.filter(d=>d.status!=='archived');
  for(const department of structure.catalog.departments){
    const key=`department:${department.id}`;
    let channel=await findChannelByDmKey(ctx.orgId,key);
    if(active.length<2||department.status==='archived'||department.default_channel===false){
      if(channel)await updateChannelRecord(ctx.orgId,channel.id,{archived_at:new Date().toISOString()});
      continue;
    }
    const name=department.label.toLowerCase().replace(/\s+/g,'-').slice(0,80);
    if(!channel)channel=await createChannelRecord({organization_id:ctx.orgId,type:'private',name,dm_key:key,created_by:ctx.userId,settings:{department_id:department.id}});
    else if(channel.archived_at||channel.name!==name)await updateChannelRecord(ctx.orgId,channel.id,{name,archived_at:null});
    const ids=structure.users.filter(u=>u.department_ids.includes(department.id)).map(u=>u.id);
    const existing=await listChannelMembers(channel.id);
    for(const id of ids)if(!existing.some(m=>m.user_id===id))await upsertChannelMember({organization_id:ctx.orgId,channel_id:channel.id,user_id:id,role:'member'});
    for(const member of existing)if(!ids.includes(member.user_id))await removeChannelMember(channel.id,member.user_id);
  }
}
