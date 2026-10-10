import { readDocument } from '../storage.js';
import { hasResourcePermission, matchesDepartmentFilter } from '../auth.js';
import { registerDataProvider } from '../publication/providers.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { AccessPolicy, PublicationContext, TargetRef } from '../publication/contracts.js';
import { contentHash } from '../publication/validation.js';
const fields=['id','name','title','first_name','last_name','email','phone','address','city','state','status','stage','document_type','type','created_at','updated_at','total_cents','cover_media_id','stage_label','job_type','project_type','primary_contact_name','primary_contact_phone','primary_contact_email','primary_contact_visible','deal_value_cents'];
const schema={type:'object',properties:Object.fromEntries(fields.map(k=>[k,{type:['string','number','boolean','null']}])),additionalProperties:false};
const pick=(data:any,id:string)=>({...Object.fromEntries(fields.filter(k=>data[k]===null||['string','number','boolean'].includes(typeof data[k])).map(k=>[k,data[k]])),id});
const userFields=['id','name','email','phone','profile_photo','title','department','location','time_zone','pronouns','bio'];
const userSchema={type:'object',properties:{...Object.fromEntries(userFields.map(k=>[k,{type:'string'}])),phone_fields:{type:'array',items:{type:'object',properties:{label:{type:'string'},number:{type:'string'},type:{type:'string',enum:['phone','platform_phone']}},required:['label','number','type'],additionalProperties:false}}},required:userFields,additionalProperties:false};
function userSummary(data:any,id:string,departments:string[]){
 const profile=data.profile&&typeof data.profile==='object'&&!Array.isArray(data.profile)?data.profile:{};
 const value=(...options:unknown[])=>options.find(option=>typeof option==='string'&&option.trim()) as string|undefined || '';
 return {id,name:value(data.name,data.display_name,data.full_name,[data.first_name,data.last_name].filter(Boolean).join(' '),data.email),email:value(data.email),phone:value(data.work_phone,data.phone),profile_photo:value(profile.profile_photo,data.profile_photo,data.profile_photo_url,data.avatar_url,data.avatar),title:value(data.job_title,data.title),department:departments.join(', ')||value(data.department),location:value(data.location),time_zone:value(data.time_zone,data.timezone),pronouns:value(data.pronouns),bio:value(data.bio)};
}
async function userPhoneFields(ctx:PublicationContext,target:TargetRef){
 const {readFields}=await import('../../custom_fields/records.js');
 const state=await readFields(ctx,target,'user',undefined,false,true);
 const fieldLabel=new Map(state.visible.map(field=>[String(field.path),String(field.label||field.path)]));
 const phones=state.phones.filter(phone=>phone.available===true&&typeof phone.phone_number==='string'&&phone.phone_number.trim());
 const platform=phones.filter(phone=>phone.type==='platform_phone').slice(0,1).map(phone=>({label:'Direct line',number:String(phone.phone_number),type:'platform_phone'}));
 const custom=phones.filter(phone=>phone.type==='phone').slice(0,2).map(phone=>({label:fieldLabel.get(String(phone.field))||'Phone',number:String(phone.phone_number),type:'phone'}));
 return {fields:[...platform,...custom],revision:state.revision};
}
const obj=(value:any):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const label=(value:any)=>typeof value==='string'?value.trim():'';
function projectSummary(data:any,id:string,contactsVisible:boolean,financialsVisible:boolean){
 const projection=obj(data.work_projection),instances=Array.isArray(projection.active_instances)?projection.active_instances:[];
 const active=instances.find((item:any)=>obj(item).kind==='pipeline')||instances[0];
 const cover=obj(obj(data.custom_field_values).cover_photo||obj(data.custom_fields).cover_photo);
 const photos=Array.isArray(data.photos)?data.photos:[];
 const photo=photos.map(obj).find((item:any)=>label(item.media_id||item.mediaId))||{};
 const contact=(Array.isArray(data.contacts)?data.contacts:[]).map(obj).find((item:any)=>item.primary===true||label(item.id)===label(data.primary_contact_id))||{};
 const value=[data.deal_value_cents,data.estimated_value_cents,data.proposal_total_cents,data.project_total_cents].find((item:any)=>Number.isFinite(item)&&item>=0);
 return {...pick(data,id),
  cover_media_id:label(cover.media_id||photo.media_id||photo.mediaId),
  stage_label:label(obj(active).stage_title||data.stage_label),
  job_type:label(data.job_type||data.service_type),
  project_type:label(data.project_type),
  primary_contact_visible:contactsVisible,
  ...(contactsVisible?{
   primary_contact_name:label(data.primary_contact_name||data.customer_name||contact.name),
   primary_contact_phone:label(data.primary_contact_phone||data.customer_phone||contact.phone),
   primary_contact_email:label(data.primary_contact_email||data.customer_email||contact.email)
  }:{primary_contact_name:'',primary_contact_phone:'',primary_contact_email:''}),
  ...(financialsVisible&&value!==undefined?{deal_value_cents:value}:{deal_value_cents:null})
 };
}
async function project(ctx:PublicationContext,t:TargetRef){const row=await readDocument(ctx.organizationId,'projects',t.projectId!);if(ctx.auth&&(!hasResourcePermission(ctx.auth,'view_projects',row.data)||!matchesDepartmentFilter(ctx.auth,row.data)))throw forbidden('widget_project_denied','Project is unavailable.');return row;}
let registered=false;
export function registerObjectWidgets(){
 if(registered)return;registered=true;
 const access:AccessPolicy={scopes:['project'],permissions:['view_projects'],scopedPermissions:true,authorize:async(ctx,t)=>{await project(ctx,t);}};
 registerDataProvider({id:'widget-objects',version:'1',apps:['projects','contacts','documents'],exports:{
  'secure-entry':{description:'Secure credential form availability. Values are never published.',schema:{type:'object',properties:{available:{const:true}},required:['available'],additionalProperties:false},schemaVersion:'1',access:{scopes:['organization'],permissions:['manage_company_settings'],applications:false,capabilities:['platform.connections']},read:async()=>({value:{available:true}})},
  assignments:{description:'Eligible assignment references from the workforce domain, without private member settings.',schema:{type:'object',additionalProperties:true},schemaVersion:'1',access:{scopes:['organization','project'],permissions:['view_projects']},read:async(ctx,ref)=>{const result=await (await import('../../workforce/service.js')).resolveAssignableSubjects(ctx.organizationId,ref.target.branchId||ctx.branchId||'default',{});return {value:{subjects:(result.subjects as any[]).map(row=>({id:row.id,name:row.name,subject_type:row.subject_type,resource_id:row.resource_id,resource_kind:row.resource_kind}))}};}},
  project:{description:'Authorized project summary fields.',schema,schemaVersion:'1',access,read:async(ctx,ref)=>{if(ref.target.id&&ref.target.id!==ref.target.projectId)throw forbidden('widget_project_mismatch','Project identity mismatch.');const row=await project(ctx,ref.target);const contactsVisible=!ctx.auth||hasResourcePermission(ctx.auth,'view_contacts',row.data);const financialsVisible=!ctx.auth||hasResourcePermission(ctx.auth,'view_financials',row.data);return {value:projectSummary(row.data,row.id,contactsVisible,financialsVisible),revision:String(row.revision)};}},
  contact:{description:'Summary of a saved contact in its owning project.',schema,schemaVersion:'1',access:{...access,permissions:['view_contacts'],authorize:async(ctx,t)=>{await readDocument(ctx.organizationId,'projects',t.projectId!);}},read:async(ctx,ref)=>{const {resolveContact}=await import('../../contacts/service.js');const r=await resolveContact(ctx.organizationId,{project_id:ref.target.projectId,contact_id:ref.target.id});return {value:pick(r.contact,String(ref.target.id)),revision:String(r.parent.revision)};}},
  user:{description:'Organization member public profile without role grants, credentials or private settings.',schema:userSchema,schemaVersion:'1',access:{scopes:['organization'],permissions:[]},read:async(ctx,ref)=>{if(!ref.target.id)throw badRequest('widget_id_required','Choose a user.');const r=await readDocument(ctx.organizationId,'users',ref.target.id);if(r.data.disabled===true||String(r.data.status||'').toLowerCase()==='disabled')throw notFound('widget_user_missing','This user is unavailable.');const structure=await (await import('../../workforce/organization-structure.js')).resolveOrganizationStructure(ctx.organizationId);const ids=structure.users.find(user=>user.id===r.id)?.department_ids||[];const departments=structure.catalog.departments.filter(department=>ids.includes(department.id)&&department.status!=='archived').map(department=>department.label);const phones=await userPhoneFields(ctx,ref.target);return {value:{...userSummary(r.data,r.id,departments),phone_fields:phones.fields},revision:contentHash({user:r.revision,phones:phones.revision})};}},
  document:{description:'Authorized document identity and summary fields; no private parameters or signing artifacts.',schema,schemaVersion:'1',access,read:async(ctx,ref)=>{const s=await import('../../documents/service.js');const r=await s.readDocumentInstance(ctx.organizationId,String(ref.target.id||''));if(r.project_id!==ref.target.projectId)throw forbidden('widget_document_mismatch','Document belongs to another project.');if(ctx.auth){s.requireDocumentDepartmentAccess(ctx.auth,r,'view_projects');if(!matchesDepartmentFilter(ctx.auth,r))throw forbidden('widget_document_department','Document is outside your department filter.');}return {value:pick(r,String(r.id)),revision:String(r.revision||r.updated_at||'1')};}},
  'document-directory':{description:'Project documents eligible for selection, with department authorization on each result.',schema:{type:'object',properties:{items:{type:'array',items:schema}},required:['items'],additionalProperties:false},schemaVersion:'1',access,read:async(ctx,ref)=>{const s=await import('../../documents/service.js');const rows=await s.listProjectDocuments(ctx.organizationId,ref.target.projectId!);return {value:{items:rows.filter(row=>{try{if(ctx.auth){s.requireDocumentDepartmentAccess(ctx.auth,row,'view_projects');if(!matchesDepartmentFilter(ctx.auth,row))return false;}return true;}catch{return false;}}).map(row=>pick(row,String(row.id)))}};}}
 }});
}
