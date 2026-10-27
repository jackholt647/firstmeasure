import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { PublicationContext } from '../platform/publication/contracts.js';
import { authorizePublication } from '../platform/publication/context.js';
import { registerAction } from '../platform/publication/actions.js';
import { backendImplementationDigest } from '../platform/publication/implementation.js';
import { badRequest, conflict, forbidden } from '../platform/errors.js';
import { readDocument, type JsonObject } from '../platform/storage.js';
import { createDocumentInstance, patchDocumentInstance, resolveDocumentInstance, createSnapshot, requireDocumentDepartmentAccess } from '../documents/service.js';
import { createDocumentTemplate, createDocumentWorkflow, readDocumentTemplate, readDocumentWorkflow, readDocumentInstance, readDocumentSnapshot, saveDocumentInstance, listProjectDocuments } from '../documents/storage.js';
import { ensureDefaultDocumentAssets } from '../documents/seeds.js';
import { withDocumentChange } from '../documents/versions/context.js';
import { publishInternalDocumentScope, hasPublishedDocumentScope } from '../materials/calculus.js';
import { readProjectForAccess } from '../projects/access.js';
import { workRequirements } from '../platform/publication/work-items.js';
import { listMeasurementDefinitions } from '../platform/publication/measurement-schemas.js';
import { getOrganizationPricebook, readOrganizationPricebook } from '../pricebook/storage.js';
import { generatePieceScope } from '../pricebook/scope-generation.js';
import { OPERATIONS_DOCUMENT_REVISION, OPERATIONS_PIECES, OPERATIONS_MEASUREMENTS, operationsDocumentDefinition, operationsWorkflowDefinition } from './document-definitions.js';
const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const array=(v:unknown):JsonObject[]=>Array.isArray(v)?v.map(obj):[];
const text=(v:unknown)=>String(v||'').trim();
const policy={scopes:['project'] as const,permissions:['manage_projects'],capabilities:['platform.materials']};
function scopeWork(params:JsonObject){
  const pieces=new Set(array(params.scope_pieces).map(p=>text(p.template_id||p.id))),m=obj(params.measurements),work:JsonObject[]=[];
  const quantities:JsonObject={};
  for(const definition of listMeasurementDefinitions())if(definition.key&&Number.isFinite(Number(m[definition.key]))&&m[definition.key]!==undefined)quantities[definition.key]={value:Number(m[definition.key]),unit:definition.unit};
  if(pieces.has('roof_replacement'))for(const row of workRequirements(['roofing'],{measurements:{measurements:quantities}}))work.push({item:row.item,...(row.quantity===null?{}:{quantity:row.quantity}),explanation:'Roof replacement scope selected in the document workflow.'});
  for(const [piece,key,items] of [['gutters','gutterLf',['gutters.remove','gutters.install']],['siding_replacement','wallNetArea',['siding.remove','siding.install']]] as const){
    if(!pieces.has(piece))continue;const amount=Number(m[key]);
    for(const item of items)work.push({item,...(m[key]!==undefined&&Number.isFinite(amount)&&amount>=0?{quantity:amount}:{}),explanation:'Replacement work selected in the document workflow.'});
  }
  return work;
}
async function access(ctx:PublicationContext,project:string){
  if(!ctx.auth)throw forbidden('operations_user_required','A signed-in person is required.');
  if(!project||project==='draft')throw badRequest('operations_project_required','Save this project before building its scope.');
  await authorizePublication(ctx,{scope:'project',organizationId:ctx.organizationId,projectId:project},policy,'operations.document');
  await readProjectForAccess(ctx.auth,project,'manage_projects');
  return ctx.auth;
}
async function owned(ctx:PublicationContext,id:string){
  const document=await readDocumentInstance(ctx.organizationId,id);
  await access(ctx,text(document.project_id));
  if(ctx.projectId&&ctx.projectId!==document.project_id)throw forbidden('operations_project_mismatch','This document belongs to another project.');
  requireDocumentDepartmentAccess(ctx.auth!,document);
  if(!['scope','proposal'].includes(text(obj(document.metadata).operations_path)))throw badRequest('operations_document_required','Choose a document created by this Operations workflow.');
  return document;
}
export async function prepareOperationsDocument(ctx:PublicationContext,input:{project_id:string;path:'scope'|'proposal';document_id?:string}){
  const auth=await access(ctx,input.project_id);
  await (await import('./onboarding.js')).initializeOperationsResources(ctx);
  await ensureDefaultDocumentAssets(ctx.organizationId,auth);
  await getOrganizationPricebook(ctx.organizationId);
  const suffix=`${input.path}_v${OPERATIONS_DOCUMENT_REVISION}`,templateId=`tpl_operations_${suffix}`,workflowId=`wfl_operations_${suffix}`;
  const templateDefinition=operationsDocumentDefinition(input.path),workflowDefinition=operationsWorkflowDefinition(input.path,templateDefinition);
  if(!await readDocumentWorkflow(ctx.organizationId,workflowId).catch(e=>{if(e.statusCode===404)return null;throw e;}))await createDocumentWorkflow(ctx.organizationId,{id:workflowId,name:text(workflowDefinition.name),status:'active',definition:workflowDefinition,metadata:{operations_revision:OPERATIONS_DOCUMENT_REVISION}},auth);
  if(!await readDocumentTemplate(ctx.organizationId,templateId).catch(e=>{if(e.statusCode===404)return null;throw e;}))await createDocumentTemplate(ctx.organizationId,{id:templateId,name:input.path==='scope'?'Scope of work':'Project proposal',document_type:input.path==='scope'?'scope_of_work':'proposal',status:'active',definition:templateDefinition,metadata:{operations_revision:OPERATIONS_DOCUMENT_REVISION,default_workflow_id:workflowId}},auth);
  let document=input.document_id?await owned(ctx,input.document_id):null;
  if(document&&(obj(document.metadata).operations_path!==input.path||document.project_id!==input.project_id))throw badRequest('operations_resume_mismatch','Resume this document in its original project and workflow.');
  if(!document)document=(await listProjectDocuments(ctx.organizationId,input.project_id)).find(d=>obj(d.metadata).operations_path===input.path&&d.status==='draft')||null;
  if(!document)document=(await createDocumentInstance(ctx.organizationId,input.project_id,{document_type:input.path==='scope'?'scope_of_work':'proposal',template_id:templateId,workflow_id:workflowId,title:input.path==='scope'?'Scope of work':'Project proposal',metadata:{operations_path:input.path,operations_revision:OPERATIONS_DOCUMENT_REVISION}},auth)).document;
  requireDocumentDepartmentAccess(auth,document);
  return {document,workflow:workflowDefinition,template:templateDefinition,preview:input.path==='proposal',piece_catalog:OPERATIONS_PIECES,measurement_fields_by_piece:OPERATIONS_MEASUREMENTS};
}
export async function saveOperationsDocument(ctx:PublicationContext,input:{document_id:string;expected_revision:number;params:JsonObject;current_step?:string;completed_steps?:string[]}){
  const document=await owned(ctx,input.document_id);
  if(document.status==='completed'&&obj(document.metadata).operations_path==='scope')throw conflict('operations_scope_published','This scope has been published. Start a new scope to change the project.');
  const workflow=operationsWorkflowDefinition(obj(document.metadata).operations_path as 'scope'|'proposal');
  const steps=new Set(array(workflow.steps).map(s=>text(s.id)));
  if(input.current_step&&!steps.has(input.current_step))throw badRequest('operations_step_invalid','Unknown workflow step.');
  const saved=await patchDocumentInstance(ctx.organizationId,input.document_id,{expected_revision:input.expected_revision,params:{...input.params,operations_work:scopeWork(input.params)}},ctx.auth!);
  // Native document workflow state is persisted with the document, not browser storage.
  const result=await saveDocumentInstance(ctx.organizationId,input.document_id,{...saved,workflow_state:{...obj(document.workflow_state),...(input.current_step?{current_step:input.current_step}:{}),...(input.completed_steps?{completed_steps:input.completed_steps.filter(id=>steps.has(id))}:{})}},{expectedRevision:Number(saved.revision)});
  return {document:result};
}
export async function operationsDocumentReady(ctx:PublicationContext,documentId:string){
  const document=await owned(ctx,documentId),state=obj(obj(document.metadata).operations_scope),snapshotId=text(state.snapshot_id);
  const snapshot=snapshotId?await readDocumentSnapshot(ctx.organizationId,snapshotId):null;
  return {ready:!!(snapshot&&snapshot.document_id===documentId&&snapshot.reason==='operations_scope'&&state.published_at&&await hasPublishedDocumentScope(ctx.organizationId,text(document.project_id),documentId,snapshotId)),document_id:documentId,path:obj(document.metadata).operations_path as 'scope'|'proposal',...(snapshotId?{snapshot_id:snapshotId}:{})};
}
export async function completeOperationsScope(ctx:PublicationContext,input:{document_id:string;expected_revision:number}){
  let document=await owned(ctx,input.document_id);
  const prior=await operationsDocumentReady(ctx,input.document_id);
  if(prior.snapshot_id&&text(obj(obj(document.metadata).operations_scope).params_hash)===JSON.stringify(document.params)){
    if(!prior.ready)await publishInternalDocumentScope(ctx,input.document_id,prior.snapshot_id);
    if(!(await operationsDocumentReady(ctx,input.document_id)).ready)throw conflict('operations_scope_retired','This scope was removed from the project. Start a new scope.');
    return {document,snapshot_id:prior.snapshot_id,published:true};
  }
  if(Number(document.revision)!==input.expected_revision)throw conflict('document_revision_conflict','The document changed. Refresh before publishing.');
  const params=obj(document.params),pieces=array(params.scope_pieces),rows=array(params.scope_items);
  if(!pieces.length||pieces.some(p=>!OPERATIONS_PIECES.some(known=>known.id===text(p.template_id||p.id))))throw badRequest('operations_scope_missing','Choose the work included in this project.');
  const leaves:JsonObject[]=[];const visit=(items:JsonObject[])=>items.forEach(r=>{if(r.selected===false||r.excluded===true||obj(r.selection).selected===false)return;const children=array(r.children);if(children.length)visit(children);else leaves.push(r);});visit(rows);
  if(!leaves.some(r=>r.operations_resource==='material'&&Number(r.quantity)>0))throw badRequest('operations_materials_missing','Choose materials and enter their quantities before publishing your scope.');
  if(leaves.some(r=>!Number.isFinite(Number(r.quantity))||Number(r.quantity)<0))throw badRequest('operations_quantities_invalid','Review each material quantity before publishing.');
  if(obj(document.metadata).operations_path==='proposal'&&leaves.some(r=>r.operations_price_unset===true&&!(Number(r.unit_price)>0)))throw badRequest('operations_prices_missing','Set your siding prices before publishing the proposal. The scope-only path does not require pricing.');
  return withDocumentChange({cut:'complete',documentId:input.document_id,userId:ctx.auth!.userId},async()=>{
    const snapshot=await createSnapshot(ctx.organizationId,input.document_id,{expected_revision:input.expected_revision,reason:'operations_scope'},ctx.auth!);
    document=await readDocumentInstance(ctx.organizationId,input.document_id);
    document=await saveDocumentInstance(ctx.organizationId,input.document_id,{...document,...(obj(document.metadata).operations_path==='scope'?{status:'completed'}:{}),publication:{...obj(document.publication),params:Object.keys(params)},metadata:{...obj(document.metadata),operations_scope:{snapshot_id:snapshot.id,published_at:new Date().toISOString(),params_hash:JSON.stringify(document.params),internal_plan:true}}},{expectedRevision:Number(document.revision)});
    await publishInternalDocumentScope(ctx,input.document_id,text(snapshot.id));
    return {document,snapshot_id:snapshot.id,published:true};
  });
}

export async function generateOperationsScope(ctx:PublicationContext,selection:JsonObject[],measurements:JsonObject){
  await access(ctx,ctx.projectId||'');
  const catalog=(await readOrganizationPricebook(ctx.organizationId)).catalog as unknown as JsonObject;
  // An unpriced material is an honest placeholder, not a quote. Its quantity still uses the shared formula engine.
  const catalogItems=array(catalog.items);
  for(const [id,name,unit,key] of [['siding_panel','Siding material','sqft','wallNetArea'],['siding_trim','Siding trim','lf','wallTerminationsLf']]){
    if(!catalogItems.some(item=>item.id===id))catalogItems.push({id,name,unit,category:'siding',unitPrice:0,operations_price_unset:true,formulaConfig:{tokens:[{type:'measurement',value:key}],includeWaste:false}});
  }
  catalog.items=catalogItems;
  const items:JsonObject[]=[];
  for(const piece of selection){
    const templateId=text(piece.template_id||piece.id);
    if(!OPERATIONS_PIECES.some(p=>p.id===templateId))throw badRequest('operations_piece_invalid','Choose roofing, gutters or siding.');
    const generated=generatePieceScope(catalog,templateId,measurements);
    const annotate=(row:JsonObject)=>{const children=array(row.children);if(children.length)children.forEach(annotate);else{const product=array(catalog.items).find(p=>p.id===obj(row.pricebook_ref).item_id||p.id===obj(row.pricebook_ref).catalog_item_id||p.id===row.item_ref);const category=text(product?.category).toLowerCase();row.operations_resource=category&&!['disposal','labor','warranties','services','fees'].includes(category)?'material':'work';if(product?.operations_price_unset)row.operations_price_unset=true;row.operations_trade=piece.name||OPERATIONS_PIECES.find(p=>p.id===templateId)!.name;}};
    annotate(generated);items.push({...generated,scope_template_id:templateId,name:piece.name||generated.name});
  }
  return {items};
}
let registered=false;
export function registerOperationsDocumentPublication(){
  if(registered)return;registered=true;
  const id=z.string().trim().min(1).max(150),record=z.record(z.unknown());
  const add=(name:string,schema:z.ZodTypeAny,effect:'read'|'write',execute:(ctx:PublicationContext,input:any)=>Promise<unknown>)=>registerAction({id:name,version:'1',domain:'operations',implementation:backendImplementationDigest(),description:name,inputSchema:zodToJsonSchema(schema,{$refStrategy:'none'}) as JsonObject,outputSchema:{type:'object'},policy,effect,executionKinds:['api','agent','module'],idempotency:effect==='write'?'required':'none',validateInput:value=>{schema.parse(value);},execute:async(ctx,target,value)=>execute({...ctx,projectId:target.projectId},schema.parse(value))});
  add('operations.document.prepare',z.object({project_id:id,path:z.enum(['scope','proposal']),document_id:id.optional()}).strict(),'write',prepareOperationsDocument);
  add('operations.document.save',z.object({document_id:id,expected_revision:z.number().int().positive(),params:record,current_step:id.optional(),completed_steps:z.array(id).optional()}).strict(),'write',saveOperationsDocument);
  add('operations.document.resolve',z.object({document_id:id}).strict(),'read',async(ctx,input)=>resolveDocumentInstance(ctx.organizationId,await owned(ctx,input.document_id)));
  add('operations.scope.complete',z.object({document_id:id,expected_revision:z.number().int().positive()}).strict(),'write',completeOperationsScope);
  add('operations.scope.generate',z.object({selection:z.array(record).min(1).max(3),measurements:record}).strict(),'read',async(ctx,input)=>generateOperationsScope(ctx,input.selection,input.measurements));
}
