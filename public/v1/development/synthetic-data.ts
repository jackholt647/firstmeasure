/** Development-only fixture orchestration. Never imported by production boot. */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { env } from '../src/config/env.js';
import { hasPermission, type PlatformAuthContext } from '../platform/auth.js';
import { readOrganization, readDocument, listDocuments, upsertDocument, type JsonObject } from '../platform/storage.js';
import { sandboxStore, sandboxError } from '../signup-sandbox/storage.js';
import { isCapabilityEnabled } from '../platform/capabilities.js';
import { withSyntheticBatch, sampleId } from './fixtures.js';

import { batchProjects, companyContacts, companyProjects, companyEquipment, companyUsers, companyChannels } from './roofing-company.js';

export const COMPANIES = [{ id: 'roofing', label: 'Roofing & exteriors' }];
export const CATEGORIES = [
 { id: 'events', label: 'Events', description: 'Site visits, installations and walkthroughs', icon: 'fa-calendar-days' },
 { id: 'equipment', label: 'Equipment', description: 'Vehicles, trailers, tools and a yard', icon: 'fa-truck-pickup' },
 { id: 'projects', label: 'Projects', description: 'Sixteen roofing jobs across pipeline stages', icon: 'fa-house' },
 { id: 'contacts', label: 'Contacts', description: 'Twenty-four fictional homeowners', icon: 'fa-address-book' },
 { id: 'material_lists', label: 'Material lists', description: 'Editable, price-book-linked project lists', icon: 'fa-layer-group' },
 { id: 'document_types', label: 'Document types', description: 'Four estimate styles and draft proposals', icon: 'fa-file-signature' },
 { id: 'users', label: 'Users', description: 'Six reusable fictional team members', icon: 'fa-users' },
 { id: 'channels', label: 'Channels', description: 'Two shared team spaces reused between batches', icon: 'fa-hashtag' },
 { id: 'communication', label: 'Communication', description: 'Sample inbox messages and channel replies', icon: 'fa-comments' }
];
const selection = z.object(Object.fromEntries(CATEGORIES.map(c => [c.id, z.boolean().default(true)]))).strict();
const inputSchema = z.object({ company: z.literal('roofing').default('roofing'), categories: selection, amount: z.number().int().min(1).max(10).default(1), request_id: z.string().uuid().optional() }).strict();
const metadata = { synthetic: true, source: 'development_tools', version: 1 };
export async function requireDevelopmentOrganization(ctx: PlatformAuthContext) {
 if (env.isProduction || env.dataEnvironment !== 'development') throw sandboxError(404, 'not_found', 'Not found.');
 if (!hasPermission(ctx, 'manage_company_settings')) throw sandboxError(403, 'permission_denied', 'Company settings access is required.');
 const org = await readOrganization(ctx.orgId);
 const meta = org.metadata as JsonObject | undefined;
 const record = meta?.sandbox_test_org === true && meta.sandbox_instance_id ? await sandboxStore.readTestOrg(String(meta.sandbox_instance_id)) : null;
 if (!record || record.org_id !== ctx.orgId) throw sandboxError(403, 'development_org_required', 'Development tools require a sandbox organization.');
 return org;
}
async function maybe(org: string, collection: string, id: string) {
 try { return await readDocument(org, collection, id); } catch (e:any) { if(e.statusCode === 404) return null; throw e; }
}
async function insert(org: string, collection: string, id: string, data: JsonObject) {
 if(await maybe(org, collection, id)) return false;
 await upsertDocument(org, collection, { id, data, metadata }, { createOnly: true }); return true;
}
async function projects(org: string) {
 const found=await batchProjects(org);
 if(found.length)return found;
 return (await listDocuments(org,'projects')).filter(p=>['signup_sandbox_samples','development_roofing_company'].includes(String((p.metadata as JsonObject)?.source)) && (p.data as JsonObject)?.workflow_state==='project').slice(0,16);
}
async function measurements(ctx: PlatformAuthContext) {
 const { userPublicationContext } = await import('../platform/publication/context.js');
 const { saveProjectDataset, selectProjectDataset } = await import('../platform/publication/datasets.js');
 for(const [i,p] of (await projects(ctx.orgId)).entries()) {
  const id=sampleId(ctx.orgId,`measurements:${p.id}`);
  if(await maybe(ctx.orgId,'project_datasets',id)) continue;
  const target={scope:'project' as const,organizationId:ctx.orgId,projectId:String(p.id)};
  const c=userPublicationContext(ctx,{projectId:String(p.id),mode:'command'});
  await saveProjectDataset(c,target,{id,name:'Synthetic roof measurements',type:'measurements',schemaVersion:'1',role:'measurements',value:{measurements:Object.fromEntries(Object.entries({roofSquares:20+i*1.5,eavesLf:120+i*10,rakesLf:80+i*8,hipsLf:40,ridgesLf:60}).map(([k,value])=>[k,{value,unit:k==='roofSquares'?'roofing_square':'ft',status:'ready',source:'Synthetic development fixture'}]))},provenance:metadata});
  await selectProjectDataset(c,target,'measurements',id,Number(p.revision));
 }
}
async function events(ctx: PlatformAuthContext) {
 let created=0;const ps=await projects(ctx.orgId);
 for(let i=0;i<6;i++) {
  const start=new Date(); start.setUTCDate(start.getUTCDate()+i-1); start.setUTCHours(14+(i%3),0,0,0);
  const p=ps[i%Math.max(1,ps.length)];
  if(await insert(ctx.orgId,'calendar_events',sampleId(ctx.orgId,`dev-event:${i}`),{title:['Roof inspection','Material delivery review','Crew planning','Roof installation','Gutter site visit','Final walkthrough'][i]+' (Sample)',branch_id:ctx.branchId||'default',project_id:p?.id||'',kind:'project_work',event_type_default_id:'project_work',start_at:start.toISOString(),end_at:new Date(+start+7200000).toISOString(),duration_minutes:120,status:'scheduled',resource_refs:[],customer_visible:false,metadata}))created++;
 }
 return {created};
}
async function materialLists(ctx: PlatformAuthContext) {
 const {createMaterialList}=await import('../materials/storage.js'); let created=0;
 const ps=await projects(ctx.orgId);
 for(const [i,p] of ps.entries()) {
  const id=sampleId(ctx.orgId,`dev-materials:${p.id}`);
  if(await maybe(ctx.orgId,'material_lists',id))continue;
  await createMaterialList(ctx.orgId,String(p.id),{id,title:'Roof system (Sample)',color:['#d93025','#2563eb','#7c3aed','#059669'][i%4],metadata,items:[{id:'shingles',name:'GAF Timberline HDZ',quantity:(20+i*1.5)*1.1,unit:'sq',pricebook_ref:{item_id:'gaf_hd'},selected_options:{color:'charcoal'}},{id:'underlayment',name:'Synthetic Underlayment',quantity:(20+i*1.5)*1.1,unit:'sq',pricebook_ref:{item_id:'underlayment'}}]},ctx);created++;
 }
 return {created,...(!ps.length?{note:'Enable Projects first, then run Material lists again.'}:{})};
}
async function documents(ctx: PlatformAuthContext) {
 const {seedInstantRoofingDocuments,ROOFING_ESTIMATES}=await import('../signup-sandbox/roofing-documents.js');
 const {createDocumentInstance}=await import('../documents/service.js');
 const before=await listDocuments(ctx.orgId,'document_templates');
 await seedInstantRoofingDocuments(ctx.orgId,ctx);
 let drafts=0;const ps=await projects(ctx.orgId);
 for(const [i,spec] of ROOFING_ESTIMATES.entries()) {
  const p=ps[i%Math.max(1,ps.length)];if(!p)continue;
  const id=sampleId(ctx.orgId,`dev-document:${spec.key}`);if(await maybe(ctx.orgId,'documents',id))continue;
  await createDocumentInstance(ctx.orgId,String(p.id),{id,document_type:'proposal',template_id:`tpl_instant_roofing_${spec.key}`,metadata,params:spec.key==='detailed'?{scope_items:[{id:'main_roof',pricebook_ref:{item_id:'gaf_hd'},name:'HDZ main roof',quantity:20,unit:'sq',unit_price:398},{id:'garage',pricebook_ref:{item_id:'gaf_hd'},name:'HDZ garage',quantity:5,unit:'sq',unit_price:398}]}:{}},ctx,{createOnly:true});drafts++;
 }
 return {created:(await listDocuments(ctx.orgId,'document_templates')).length-before.length,drafts,note:ps.length?'Draft estimates are ready for your review and signature. Signing publishes material artifacts.':'Templates are ready. Enable Projects to add draft estimates.'};
}
async function communication(ctx: PlatformAuthContext) {
 const store=await import('../messaging/communications_storage.js');
 let created=0;const ps=await projects(ctx.orgId);
 // Retained incoming records only. No transport, delivery queue, signatures or notifications.
 for(const [i,text] of ['Can you include the garage roof in the estimate?','The driveway will be clear for your site visit.','Please show me the charcoal and weathered wood options.'].entries()) {
  const seed=sampleId(ctx.orgId,`dev-conversation:${i}`);
  // The communications store namespaces caller-supplied IDs by organization.
  const conversationId=`conversation_${createHash('sha256').update(ctx.orgId).digest('hex').slice(0,12)}_${seed}`;
  const contact=(ps[i]?.data?.contacts as JsonObject[]|undefined)?.[0];
  const email=String(contact?.email||`sample${i}@example.test`);
  const sender={name:String(contact?.name||['Avery Morgan','Jordan Rivera','Taylor Chen'][i]),email,address:email,type:'external'};
  const context={project_id:ps[i]?.id||''};
  let conversation;
  try {conversation=await store.readConversationRecord(ctx.orgId,conversationId);}catch(e:any){if(e.statusCode!==404)throw e;}
  if(!conversation)conversation=await store.createConversationRecord({id:seed,organization_id:ctx.orgId,branch_id:ctx.branchId||'default',channel_strategy:'email',subject:'Roofing enquiry (Sample)',participants:[sender],context,metadata,created_by_user_id:ctx.userId});
  const result=await store.createMessageRecord({id:sampleId(ctx.orgId,`dev-message:${i}`),organization_id:ctx.orgId,branch_id:ctx.branchId||'default',conversation_id:conversation.id,context,direction:'inbound',channel:'email',status:'received',subject:'Roofing enquiry (Sample)',text_body:text,sender,recipients:[],metadata,tags:['synthetic'],idempotency_key:sampleId(ctx.orgId,`dev-message:${i}`),created_by_user_id:ctx.userId});
  if(result.created)await store.touchConversationForMessage(ctx.orgId,String(conversation.id),String(result.message.created_at));
  if(result.created)created++;
 }
 return {created};
}
export async function generateSyntheticData(ctx: PlatformAuthContext, raw: unknown) {
 await requireDevelopmentOrganization(ctx);
 const parsed=inputSchema.safeParse(raw);if(!parsed.success)throw sandboxError(400,'invalid_selection','Choose a supported company and boolean category toggles.');
 const selected=parsed.data.categories as Record<string,boolean>;
 if(!Object.values(selected).some(Boolean))throw sandboxError(400,'empty_selection','Select at least one category.');
 const requirements:Record<string,[string,string]>={events:['platform.scheduling','manage_projects'],equipment:['apps.equipment','equipment.manage'],projects:['apps.projects','manage_projects'],contacts:['platform.contacts','manage_projects'],material_lists:['platform.materials','manage_projects'],document_types:['platform.documents','manage_documents'],users:['','manage_company_users'],channels:['apps.channels','manage_channels'],communication:['apps.messaging','send_communications']};
 for(const [key,[capability,permission]]of Object.entries(requirements))if(selected[key]) {
  if(!hasPermission(ctx,permission))throw sandboxError(403,'permission_denied',`You need ${permission} access to generate ${key.replaceAll('_',' ')}.`);
  if(capability && !await isCapabilityEnabled(ctx.orgId,capability))throw sandboxError(400,'feature_disabled',`Enable ${key.replaceAll('_',' ')} for this organization, or turn its toggle off.`);
 }
 // Durable lease serializes concurrent clicks across development web nodes.
 const leaseId='development_synthetic_data_lease';const prior=await maybe(ctx.orgId,'onboarding_events',leaseId);
 if(Number((prior?.data as JsonObject)?.expires)>Date.now())throw sandboxError(409,'generation_running','Synthetic data is already being added. Try again shortly.');
 const lease=await upsertDocument(ctx.orgId,'onboarding_events',{id:leaseId,expected_revision:prior?.revision,data:{token:randomUUID(),expires:Date.now()+600000},metadata},{replace:true,createOnly:!prior});
 const results:Record<string,any>={};
 const addCounts=(a:any,b:any):any=>typeof b==='number'?(Number(a)||0)+b:b&&typeof b==='object'?Object.fromEntries(Object.entries(b).map(([k,v])=>[k,addCounts(a?.[k],v)])):b;
 try {
  for(let batch=0;batch<parsed.data.amount;batch++)await withSyntheticBatch(parsed.data.request_id ? `${parsed.data.request_id}:${batch}` : batch?`amount:${batch}`:'',async()=>{
  const run=async(key:string,fn:()=>Promise<unknown>)=>{if(!selected[key])return;try{const value=await fn() as JsonObject;const previous=results[key];results[key]={...addCounts(previous,value),status:previous?.status==='failed'?'failed':'complete',...(previous?.error?{error:previous.error}:{})};}catch(e:any){results[key]={...results[key],status:'failed',error:String(e.message||'Generation failed')};}};
  await run('users',()=>companyUsers(ctx.orgId));
  await run('contacts',()=>companyContacts(ctx.orgId));
  await run('projects',async()=>{const r=await companyProjects(ctx);await measurements(ctx);return r;});
  await run('equipment',()=>companyEquipment(ctx.orgId));
  await run('events',()=>events(ctx));
  await run('material_lists',()=>materialLists(ctx));
  await run('document_types',()=>documents(ctx));
  await run('channels',()=>companyChannels(ctx,false,true));
  await run('communication',async()=>{const r=await communication(ctx); return {...r,channels:await companyChannels(ctx,true,selected.channels===true)};});
  });
  return {organization_id:ctx.orgId,amount:parsed.data.amount,results};
 }finally {await upsertDocument(ctx.orgId,'onboarding_events',{id:leaseId,expected_revision:lease.revision,data:{expires:0},metadata},{replace:true});}
}
