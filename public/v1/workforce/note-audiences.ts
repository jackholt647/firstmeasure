import type {PlatformAuthContext} from '../platform/auth.js';
import {forbidden} from '../platform/errors.js';
import {relevantDepartmentContext} from './department-access.js';

export type NoteAudienceRef = {kind:'resource_group'|'resource_group_kind'|'user';id:string;department_ids?:string[]};

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
