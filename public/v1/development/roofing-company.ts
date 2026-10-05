/** A connected roofing company: batches add customers/jobs; shared resources stay bounded. */
import { createHash } from 'node:crypto';
import { readDocument, listDocuments, upsertDocument, type JsonObject } from '../platform/storage.js';
import type { PlatformAuthContext } from '../platform/auth.js';
import { sampleId } from './fixtures.js';
import * as channels from '../channels/storage.js';
import { ensureProjectChannelRecord } from '../channels/service.js';
import { listScopeTemplates } from '../scopes/storage.js';
import { createWorkPlan, setManualPlanStage, syncProjectWorkProjection } from '../work/service.js';
import { ensureEquipmentSeed } from '../equipment/service.js';
import { listCategories, listUnits, listTypes, listYards, saveType, saveUnit, saveYard } from '../equipment/storage.js';

const metadata={synthetic:true,source:'development_roofing_company',version:2};
const stable=(org:string,key:string)=>'sample_'+createHash('sha256').update(`${org}:roofing-company:${key}`).digest('hex').slice(0,24);
async function find(org:string,collection:string,id:string){try{return await readDocument(org,collection,id);}catch(e:any){if(e.statusCode===404||e.code==='not_found')return null;throw e;}}
async function insert(org:string,collection:string,id:string,data:JsonObject){if(await find(org,collection,id))return false;await upsertDocument(org,collection,{id,data:{id,...data},metadata},{createOnly:true});return true;}
export const PROJECT_KEYS=Array.from({length:16},(_,i)=>`roofing-job:${i}`);
const names=['Avery Morgan','Jordan Rivera','Taylor Chen','Casey Brooks','Riley Patel','Jamie Wilson','Cameron Reed','Drew Bennett','Morgan Ellis','Parker Hayes','Alexis Turner','Quinn Foster','Robin Campbell','Sam Mitchell','Blair Roberts','Reese Cooper','Lee Anderson','Dana Price','Jesse Sullivan','Skyler Davis','Kendall Hughes','Emery Scott','Rowan Kelly','Finley Ward'];
const roads=['Maple Street','Cedar Lane','Harbor Way','Willow Court','Pine Avenue','Oak Drive','Birch Lane','Meadow Road'];
const scopes=['Full roof replacement','Roof and garage replacement','Storm damage roof replacement','Roof and gutter replacement'];
export const TEAM=[['alex','Alex Martinez','Production manager'],['sam','Sam Rivera','Estimator'],['morgan','Morgan Lee','Office coordinator'],['chris','Chris Bennett','Crew lead'],['jamie','Jamie Brooks','Roofing technician'],['dana','Dana Chen','Roofing technician']] as const;
export async function companyUsers(org:string){let created=0;for(const [key,name,title]of TEAM)if(await insert(org,'users',stable(org,`person:${key}`),{name,display_name:name,email:`${key}.${stable(org,key).slice(-8)}@example.test`,job_title:title,role:'viewer',roles:[],access_role_ids:[],permissions:{},status:'active',branch_id:'default',account_type:'employee',metadata}))created++;return {created};}
export async function companyPeople(org:string){const users=await listDocuments(org,'users');return TEAM.map(([key])=>users.find(u=>u.id===stable(org,`person:${key}`))).filter((u):u is NonNullable<typeof u>=>!!u);}
export function customer(org:string,i:number){const id=sampleId(org,`roofing-customer:${i}`);return {id,contact_id:id,name:names[i%names.length]!,email:`homeowner.${id.slice(-16)}@example.test`,phone:`202-555-${String(100+i).padStart(4,'0')}`,address:`${104+i*17} ${roads[i%roads.length]}, Northampton, MA 01060`,primary:true};}
export async function companyContacts(org:string){let created=0;for(let i=0;i<names.length;i++){const c=customer(org,i);if(await insert(org,'projects',sampleId(org,`roofing-contact:${i}`),{title:c.name,project_title:c.name,workflow_state:'contact_only',branch_id:'default',contacts:[c],contact_id:c.id,primary_contact_id:c.id,contact_ids:[c.id],address:c.address,tags:['Synthetic'],events:[],measurement:{}}))created++;}return {created};}
export async function batchProjects(org:string){const rows=await Promise.all(PROJECT_KEYS.map(key=>find(org,'projects',sampleId(org,key))));return rows.filter((p):p is NonNullable<typeof p>=>!!p);}
export async function companyProjects(ctx:PlatformAuthContext){
 let created=0;const org=ctx.orgId,branch=ctx.branchId||'default';const templates=await listScopeTemplates(org,branch);
 const template=templates.find(t=>t.id==='sales_pipeline')||templates.find(t=>(t.definition as any)?.kind==='pipeline');
 if(!template)throw new Error('Enable a sales pipeline before generating projects.');
 const root=(template.definition as any)?.work_plan?.root_nodes?.[0];
 const stages=(root?.children||[]).filter((s:any)=>String(s.terminology_key).endsWith('stage'));
 if(!stages.length)throw new Error('The sales pipeline needs stages before generating projects.');
 const people=await companyPeople(org);
 for(let i=0;i<PROJECT_KEYS.length;i++){
  const id=sampleId(org,PROJECT_KEYS[i]!);const c=customer(org,i);const title=`${c.name.split(' ').at(-1)} — ${scopes[i%scopes.length]}`;
  if(await insert(org,'projects',id,{title,project_title:title,address:c.address,branch_id:branch,project_type:'residential',property_type:'residential',workflow_state:'project',status:'active',contacts:[c],contact_id:c.id,primary_contact_id:c.id,contact_ids:[c.id],assigned_user_ids:people.length?[String(people[i%people.length]!.id)]:[ctx.userId],tags:['Synthetic',i%4===2?'Repair':'Replacement'],estimated_value:8500+i*950,notes:`${scopes[i%scopes.length]}. Architectural asphalt shingles; ${20+i*1.5} squares. Protect landscaping and confirm driveway access with ${c.name.split(' ')[0]}.`,events:[],proposals:[],photos:[],measurement:{},metadata}))created++;
  // Create-only plan semantics make retries repair a missing board without resetting a user's stage.
  const plan=await createWorkPlan({id:sampleId(org,`roofing-plan:${id}`),organization_id:org,project_id:id,branch_id:branch,template_id:String(template.id),source_type:'pipeline',source_key:`synthetic:${id}`,title:String(template.name),metadata:{...metadata,scope_template_kind:'pipeline'},root_nodes:[{id:root.id,title:root.title,terminology_key:root.terminology_key,completion_mode:'manual',children:stages.map((s:any,index:number)=>({id:s.id,title:s.title,terminology_key:s.terminology_key,completion_mode:'manual',metadata:{color:s.metadata?.color||s.color},depends_on:index?[stages[index-1].id]:[]}))}]});
  if(plan.created)await setManualPlanStage(org,String(plan.plan!.id),String(stages[i%stages.length].id),{actor_user_id:ctx.userId,reason:'Synthetic pipeline scenario'});
  await syncProjectWorkProjection(org,id);
 }
 return {created};
}
export async function companyEquipment(org:string){
 await ensureEquipmentSeed(org);let created=0;
 const categories=new Map((await listCategories(org)).map(c=>[String(c.seed_key),c.id]));
 const types=new Set((await listTypes(org,{includeArchived:true})).map(t=>t.id)),units=new Set((await listUnits(org,{includeArchived:true})).map(u=>u.id));
 const yard=stable(org,'yard');if(!(await listYards(org,{includeArchived:true})).some(y=>y.id===yard))await saveYard(org,{id:yard,name:'Operations yard',address:{formatted:'100 Industrial Drive, Northampton, MA (synthetic)'}});
 for(const [key,name,kind,category]of [['truck','Crew pickup','vehicle','vehicles'],['trailer','Dump trailer','trailer','trailers'],['compressor','Roofing compressor','tool','tools'],['hoist','Shingle hoist','tool','tools']]){
  const type=stable(org,`equipment-type:${key}`),id=stable(org,`equipment:${key}`);
  if(!types.has(type))await saveType(org,{id:type,name,kind:kind as any,category_id:categories.get(category!),tracking:'unit',description:'Synthetic roofing company equipment'});
  if(!units.has(id)){await saveUnit(org,{id,type_id:type,name,identifier:`DEMO-${key!.toUpperCase()}`,ownership:'owned',status:'available',location:{yard_id:yard,name:'Operations yard'},home_location:{yard_id:yard},tags:['synthetic']});created++;}
 }
 return {created};
}
export async function companyChannels(ctx:PlatformAuthContext,withMessages:boolean,allowCreate:boolean){
 const org=ctx.orgId,people=await companyPeople(org);const authors=people.length?people.map(p=>String(p.id)):[ctx.userId];let created=0,messages=0,project_channels=0;
 const existing=await channels.listChannelRecords(org,{includeArchived:true});const targets:Awaited<ReturnType<typeof channels.listChannelRecords>>=[];
 for(const [key,name,topic]of [['team','team','Company updates and team coordination'],['field','field-operations','Crew schedules, materials and site handoffs']]){
  let channel=existing.find(c=>c.settings.synthetic_company_key===key)||existing.find(c=>c.type==='public'&&c.name===name&&!c.archived_at);
  if(!channel&&allowCreate){channel=await channels.createChannelRecord({organization_id:org,type:'public',name:name!,topic:topic!,created_by:ctx.userId,settings:{synthetic_company_key:key}});created++;}
  if(channel&&!channel.archived_at)targets.push(channel);
 }
 const ps=await batchProjects(org);
 // Only jobs with a conversation need a project channel. The same project always reuses its channel.
 if(withMessages)for(const p of ps.slice(0,2)){
  let channel=await channels.findChannelByProject(org,String(p.id));
  if(!channel&&allowCreate){channel=await ensureProjectChannelRecord(org,String(p.id),String(p.data?.title),ctx.userId);project_channels++;}
  if(channel)targets.push(channel);
 }
 for(const channel of targets){
  for(const id of [ctx.userId,...authors])await channels.upsertChannelMember({organization_id:org,channel_id:channel.id,user_id:id,role:id===ctx.userId?'owner':'member'});
  if(!withMessages)continue;
  const job=channel.project_id?ps.find(p=>p.id===channel.project_id):ps[0];const title=String(job?.data?.title||'the next roof replacement');
  const lines=channel.type==='project'?[`Site visit complete for ${title}. Decking looks sound; allow two sheets for the rear eave.`,`I have added that allowance to the estimate. Charcoal is the homeowner’s preferred color.`,`Confirmed driveway access after 8 a.m. Please keep the left bay clear.`,`Crew can start Thursday if the material delivery arrives Wednesday.`,`I will confirm delivery and update the customer this afternoon.`,`Thanks. I will bring the gutter protection and take completion photos.`]:channel.name==='team'?['Morning team. We have two roof installations and three inspections on the schedule this week.','I can cover the afternoon inspections while the crew finishes the current roof.',`The proposal for ${title} is ready for review.`,`Please confirm customer selections before we release the material order.`,`I have followed up and recorded the preferred shingle color.`,`Thanks everyone. We will review tomorrow’s schedule at 4 p.m.`]:[`Planning the handoff for ${title}. Is the driveway clear for the trailer?`,`Yes, the customer will move both vehicles before 8 a.m.`,`Check the underlayment and starter quantities before confirming the delivery.`,`I have reviewed the list against the roof measurements.`,`The pickup and dump trailer are available. I will check the compressor this afternoon.`,`All set. Crew briefing is at the yard at 7:15.`];
  let parent:string|null=null;
  for(let i=0;i<lines.length;i++){
   const client=sampleId(org,`company-chat:${channel.id}:${i}`);let message=await channels.findMessageByClientId(channel.id,authors[i%authors.length]!,client);
   if(!message){message=await channels.createMessageRecord({organization_id:org,channel_id:channel.id,author_id:authors[i%authors.length]!,client_msg_id:client,parent_id:i===2?null:parent,text:lines[i]!,language_code:'en',language_confidence:1,tags:['synthetic'],metadata,created_at:new Date(Date.now()-(lines.length-i)*900000).toISOString()});messages++;}
   if(i===0||i===2)parent=message.id;
  }
 }
 return {created,messages,project_channels};
}
