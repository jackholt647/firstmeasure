import { createHash } from "node:crypto";
import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, conflict } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import { listAssignmentGroups, readWorkforceConfiguration, saveWorkforceConfiguration } from "../workforce/storage.js";
import { currentActor, requirePermission, requireConnection, requireOpen, privacy, organizationProfile, actor } from "./service.js";
import { findRecord, getRecord, insertRecord, updateRecord, withOrganizationLocks, audit, type RecordValue } from "./storage.js";

const id=z.string().trim().min(1).max(180);
const ids=z.array(id).max(500).transform(v=>[...new Set(v)]);
const exposureSchema=z.object({organization:z.boolean().default(true),group_kind_ids:ids.default([]),group_ids:ids.default([]),include_future:z.boolean().default(false),fields:z.array(z.enum(["headcount","member_names"])).default([])}).strict();
const mappingSchema=z.object({local_kind_id:id,organization:z.boolean().default(true),group_kind_ids:ids.default([])}).strict();
const settingsSchema=z.object({expected_revision:z.number().int().nonnegative(),mappings:z.array(mappingSchema).max(100).optional(),exposure:exposureSchema.optional(),enable_kind_ids:ids.default([])}).strict();
const key=(org:string,other:string)=>`assignment_${createHash("sha256").update(JSON.stringify([org,other])).digest("hex")}`;
const defaults=()=>({mappings:[] as z.infer<typeof mappingSchema>[],exposure:exposureSchema.parse({})});
async function settings(org:string,other:string){return await findRecord(key(org,other),"assignment_settings")||{...defaults(),id:key(org,other),owner_org_id:org,recipient_org_id:other,revision:0};}
async function relationship(ctx:PlatformAuthContext,relationshipId:string){
 const r=await getRecord(relationshipId,"relationship");
 if(r.owner_org_id!==ctx.orgId)throw forbidden("relationship_private","Choose one of your connected organizations.");
 await requireConnection(ctx.orgId,r.recipient_org_id);
 return r;
}
async function exposureCatalog(owner:string,recipient:string){
 await requireConnection(owner,recipient);await requireOpen(owner,"send_shares");await requireOpen(recipient,"receive_shares");
 const s=await settings(owner,recipient),exposure=exposureSchema.parse(s.exposure),configuration=await readWorkforceConfiguration(owner);
 const kinds=(configuration.resource_group_kinds as any[]).filter(k=>k.status!=="archived"&&exposure.group_kind_ids.includes(k.id));
 const groups=(await listAssignmentGroups(owner,exposure.fields.length>0)).filter((g:any)=>g.status==="active"&&kinds.some(k=>k.id===g.kind_id)&&(exposure.include_future||exposure.group_ids.includes(String(g.id))));
 const policy=(await privacy(owner)).policy;
 const projected=[];
 for(const g of groups){
  const members=(Array.isArray(g.members)?g.members:[]) as any[];
  const active=members.filter(m=>m.status==="active");
  const item:any={id:g.id,kind_id:g.kind_id,name:g.name};
  if(exposure.fields.includes("headcount"))item.headcount=active.length;
  if(exposure.fields.includes("member_names")&&policy.disclose_name){
   item.member_names=[];
   for(const m of active){const user=await readDocument(owner,"users",m.user_id).catch(()=>null);if(user&&String(user.data.status||"active")==="active")item.member_names.push(String(user.data.name||"Team member"));}
  }
  projected.push(item);
 }
 return {organization:exposure.organization,kinds:kinds.map(k=>({id:k.id,name:k.name})),groups:projected};
}
export async function assignmentSettings(ctx:PlatformAuthContext,relationshipId:string){
 ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");requirePermission(ctx,"manage_company_settings");
 const r=await relationship(ctx,relationshipId);
 return withOrganizationLocks([ctx.orgId,r.recipient_org_id],async()=>{
  const local=await settings(ctx.orgId,r.recipient_org_id),config=await readWorkforceConfiguration(ctx.orgId);
  let available:any={organization:false,kinds:[],groups:[]};
  try{available=await exposureCatalog(r.recipient_org_id,ctx.orgId);}catch(e:any){if(e.statusCode!==403)throw e;}
  const groups=await listAssignmentGroups(ctx.orgId);
  return {settings:local,local_kinds:config.resource_group_kinds,local_groups:groups.filter(g=>g.status==="active").map(g=>({id:g.id,kind_id:g.kind_id,name:g.name})),available,partner:await organizationProfile(r.recipient_org_id)};
 });
}
export async function saveAssignmentSettings(ctx:PlatformAuthContext,relationshipId:string,raw:unknown){
 ctx=await currentActor(ctx);requirePermission(ctx,"manage_external_connections");requirePermission(ctx,"manage_company_settings");
 const input=settingsSchema.parse(raw),r=await relationship(ctx,relationshipId);
 return withOrganizationLocks([ctx.orgId,r.recipient_org_id],async()=>{
  await requireConnection(ctx.orgId,r.recipient_org_id);
  const current=await settings(ctx.orgId,r.recipient_org_id);
  if(current.revision!==input.expected_revision)throw conflict("assignment_revision_conflict","Assignment settings changed. Reopen them before saving.");
  const config=await readWorkforceConfiguration(ctx.orgId),kinds=config.resource_group_kinds as any[];
  for(const kind of input.enable_kind_ids)if(!kinds.some(k=>k.id===kind&&k.status!=="archived"))throw badRequest("assignment_kind_unknown","Choose an active group type.");
  if(input.mappings){
   if(new Set(input.mappings.map(m=>m.local_kind_id)).size!==input.mappings.length)throw badRequest("assignment_kind_duplicate","Choose each group type once.");
   const available=await exposureCatalog(r.recipient_org_id,ctx.orgId);
   for(const m of input.mappings){
    if(!kinds.some(k=>k.id===m.local_kind_id&&k.status!=="archived"&&(k.external_assignment===true||input.enable_kind_ids.includes(k.id))))throw badRequest("external_assignment_disabled","Enable partner assignments for this group type first.");
    if(m.organization&&!available.organization||m.group_kind_ids.some(k=>!available.kinds.some((v:any)=>v.id===k)))throw forbidden("assignment_not_exposed","The partner has not made these assignment options available.");
    if(!m.organization&&!m.group_kind_ids.length)throw badRequest("assignment_target_required","Choose the organization or an available team type.");
   }
  }
  if(input.exposure){
   await requireOpen(ctx.orgId,"send_shares");
   const groups=await listAssignmentGroups(ctx.orgId);
   if(input.exposure.group_kind_ids.some(v=>!kinds.some(k=>k.id===v&&k.status!=="archived"))||input.exposure.group_ids.some(v=>!groups.some(g=>g.id===v&&g.status==="active"&&input.exposure!.group_kind_ids.includes(String(g.kind_id)))))throw badRequest("assignment_group_unknown","Choose active teams from the selected types.");
  }
  // Validate the entire proposal before enabling a type; mappings only enable this partnership.
  if(input.enable_kind_ids.length)await saveWorkforceConfiguration(ctx.orgId,{expected_revision:config.revision,resource_group_kinds:kinds.filter(k=>input.enable_kind_ids.includes(k.id)).map(k=>({...k,external_assignment:true}))});
  const patch={mappings:input.mappings??current.mappings,exposure:input.exposure??current.exposure};
  const saved=current.revision?await updateRecord(current as RecordValue,patch,current.revision):await insertRecord("assignment_settings",{...current,...patch,status:"active",revision:1});
  await audit(saved,"collaboration.assignments.configured",actor(ctx));return saved;
 });
}

/** Runtime catalog only. Foreign groups never become local workforce membership records. */
export async function externalAssignmentSubjects(org:string,connections:any[],branch:string){
 const configuration=await readWorkforceConfiguration(org);
 const enabled=new Set((configuration.resource_group_kinds as any[]).filter(k=>k.external_assignment===true&&k.status!=="archived").map(k=>k.id));
 const subjects:any[]=[];
 for(const connection of connections){
  const other=String(connection.linked_organization_id||"");if(!other)continue;
  try{
   const local=await settings(org,other),mappings=(local.mappings||[]).filter((m:any)=>enabled.has(m.local_kind_id));
   if(!mappings.length)continue;
   const exposed=await exposureCatalog(other,org);
   const add=(id:string,name:string,target:any,mapped:string[])=>{if(mapped.length)subjects.push({id,resource_id:id,resource_kind:"organization_connection",subject_type:"organization_connection",name,status:"active",branch_id:branch,mapped_group_kind_ids:mapped,external_assignment:true,external_target:{owner_org_id:other,...target},connection_id:connection.id,linked_organization_id:other,work_resource_ref:{kind:"organization_connection",id,name},capability_scope_ids:connection.capability_scope_ids||[],assignment_tag_ids:[],kind_ids:mapped});};
   if(exposed.organization)add(connection.id,connection.name,{kind:"organization"},mappings.filter((m:any)=>m.organization).map((m:any)=>m.local_kind_id));
   for(const group of exposed.groups){
    const mapped=mappings.filter((m:any)=>m.group_kind_ids.includes(group.kind_id)).map((m:any)=>m.local_kind_id);
    const resourceId=`external_${createHash("sha256").update(JSON.stringify([org,other,group.id])).digest("hex")}`;
    add(resourceId,`${connection.name} / ${group.name}`,{kind:"resource_group",id:group.id,kind_id:group.kind_id},mapped);
   }
  }catch(e:any){if(e.statusCode!==403)throw e;}
 }
 return subjects;
}
