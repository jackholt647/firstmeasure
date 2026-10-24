import type {PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {relevantDepartmentContext} from './department-access.js';

export type NoteAudienceRef = {kind:'resource_group'|'resource_group_kind'|'user';id:string;department_ids?:string[]};

/**
 * Groups of users exist for an organization when People shows them: the platform People app
 * (`platform.people_access`) with the groups app (`apps.crew`) on, the same switches
 * people-data.js checks. With them off the picker offers no group or group-type audience.
 */
export const NOTE_GROUP_AUDIENCE_CAPABILITIES=['platform.people_access','apps.crew'] as const;
export function noteGroupAudiencesEnabled(effectiveByKey:Record<string,unknown>|undefined):boolean {
  return NOTE_GROUP_AUDIENCE_CAPABILITIES.every(key=>effectiveByKey?.[key]===true);
}

/**
 * What the note visibility picker offers, built from data: departments only when the person can choose more
 * than one, groups only when groups exist and are switched on, people always. Selections stay validated by
 * validateNoteAudienceRefs and projectNoteDepartmentVisibility; this only decides what is offered.
 */
export function noteAudienceOptions<U extends {id?:unknown},K extends {id?:unknown}>(input:{
  viewerId:string;
  groupsEnabled:boolean;
  selection:{organization_wide:boolean;department_ids:string[]};
  departments:Array<{id:string;label:string;status?:string}>;
  groups:Array<{id:string;kind_id:string;department_ids:string[]}>;
  groupKinds:K[];
  members:Array<{id:string;department_ids:string[];resource_group_ids?:string[]}>;
  users:U[];
}){
  const {selection}=input,member=input.members.find(u=>u.id===input.viewerId);
  const eligible=(ids:string[])=>selection.organization_wide || ids.some(id=>selection.department_ids.includes(id));
  const departments=input.departments.filter(d=>(d.status ?? 'active')==='active').map(d=>({id:d.id,label:d.label}));
  const selectable=departments.filter(d=>selection.department_ids.includes(d.id));
  const groups=input.groupsEnabled ? input.groups.filter(g=>eligible(g.department_ids) || !!member?.resource_group_ids?.includes(g.id)) : [];
  const groupKinds=input.groupsEnabled ? input.groupKinds.filter(k=>groups.some(g=>g.kind_id===String(k.id ?? '') && eligible(g.department_ids))) : [];
  const users=input.users.filter(u=>{const id=String(u.id ?? ''),row=input.members.find(m=>m.id===id);return !!row && (id===input.viewerId || eligible(row.department_ids));});
  return {
    departments,
    selectable_department_ids:selectable.map(d=>d.id),
    groups,
    group_kinds:groupKinds,
    users,
    sections:{departments:selectable.length>1,groups:input.groupsEnabled && (groups.length>0 || groupKinds.length>0),users:true}
  };
}

/** Stable organization IDs, with kind selections bounded to the sender's department context. */
export function validateNoteAudienceRefs(ctx:PlatformAuthContext, refs:NoteAudienceRef[]):NoteAudienceRef[] {
  const structure=ctx.organizationStructure, selection=relevantDepartmentContext(ctx);
  const allowed=(ids:string[])=>selection.organization_wide || ids.some(id=>selection.department_ids.includes(id));
  const groups=structure?.groups || [], users=structure?.users || [];
  const result:NoteAudienceRef[]=[];
  for(const ref of refs){
    let valid=false, normalized:NoteAudienceRef={kind:ref.kind,id:ref.id};
    if(ref.kind==='resource_group'){
      const group=groups.find(g=>g.id===ref.id);
      valid=!!group && (allowed(group.department_ids) || !!users.find(u=>u.id===ctx.userId)?.resource_group_ids?.includes(group.id));
    }else if(ref.kind==='user'){
      const user=users.find(u=>u.id===ref.id);valid=!!user && (user.id===ctx.userId || allowed(user.department_ids));
    }else if(ref.kind==='resource_group_kind'){
      const departments=[...new Set(ref.department_ids || [])].sort();
      valid=groups.some(g=>g.kind_id===ref.id) && departments.every(id=>selection.department_ids.includes(id)) && (departments.length>0 || selection.organization_wide);
      normalized={...normalized,department_ids:departments};
    }
    if(!valid)throw forbidden('note_audience_denied','Choose active groups and users available in your departments.');
    if(!result.some(row=>row.kind===normalized.kind && row.id===normalized.id))result.push(normalized);
  }
  return result;
}

/** Evaluated from current active memberships; labels and role names confer no access. */
export function matchesNoteAudienceRefs(ctx:PlatformAuthContext,refs:unknown,ownerId:unknown):boolean {
  if(ctx.userId===ownerId || relevantDepartmentContext(ctx).organization_wide)return true;
  if(!Array.isArray(refs))return false;
  const structure=ctx.organizationStructure,member=structure?.users.find(u=>u.id===ctx.userId);
  if(!member)return false;
  return refs.some((ref:NoteAudienceRef)=>{
    if(ref.kind==='user')return ref.id===ctx.userId;
    const groups=(structure?.groups || []).filter(g=>member.resource_group_ids?.includes(g.id));
    if(ref.kind==='resource_group')return groups.some(g=>g.id===ref.id);
    if(ref.kind==='resource_group_kind')return groups.some(g=>g.kind_id===ref.id && (!(ref.department_ids || []).length || g.department_ids.some(id=>ref.department_ids!.includes(id))));
    return false;
  });
}
