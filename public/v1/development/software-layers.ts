import { z } from 'zod';
import type { PlatformAuthContext } from '../platform/auth.js';
import { hasPermission } from '../platform/auth.js';
import { initializePublication } from '../platform/publication/bootstrap.js';
import { listDataProviders, authorizeSource } from '../platform/publication/providers.js';
import { listActions, authorizeAction } from '../platform/publication/actions.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { listDatasetTypes } from '../platform/publication/datasets.js';
import { authorizePublication, userPublicationContext } from '../platform/publication/context.js';
import type { AccessPolicy } from '../platform/publication/contracts.js';
import { PlatformError } from '../platform/errors.js';
import { listDocuments, readDocument } from '../platform/storage.js';
import { definitions, canReadField } from '../custom_fields/records.js';
import { fieldSchema } from '../custom_fields/contracts.js';
import { listModules, moduleDefinition } from '../documents/modules/service.js';
import { listWidgets } from '../platform/widgets/catalog.js';
import { DOCUMENT_WIDGET_CATALOG } from '../documents/api.js';
import { listDocumentWidgetResolvers } from '../documents/widgets/registry.js';
import { listDocumentTypes } from '../documents/types/registry.js';
import { listDocumentSources } from '../documents/sources/registry.js';
import { SCOPE_ARTIFACT_TYPES } from '../scopes/artifacts.js';
import { requireDevelopmentOrganization } from './synthetic-data.js';

export async function softwareLayers(auth: PlatformAuthContext, query: unknown) {
 await requireDevelopmentOrganization(auth);
 const { projectId } = z.object({ projectId:z.string().min(1).max(200).optional() }).strict().parse(query);
 const ctx=userPublicationContext(auth);
 initializePublication();
 await (await import('../integrations/publication.js')).loadConnectionPublications(auth.orgId);
 const items:Record<string,unknown>[]=[];
 const add=(layer:string,id:string,origin:string,declarationScope:string,scopes:readonly string[],details:unknown,version?:string)=>items.push({layer,id,origin,declarationScope,scopes,details,version});
 const visible=async(policy:AccessPolicy,operation:string)=>{
  const scopes:string[]=[];
  for(const scope of policy.scopes)try{
   await authorizePublication(ctx,{scope,organizationId:auth.orgId,...(scope==='project'?{projectId:projectId||'$project'}:{})},policy,operation);scopes.push(scope);
  }catch(e){if(!(e instanceof PlatformError&&[400,403,404].includes(e.statusCode)))throw e;}
  return scopes;
 };
 for(const provider of listDataProviders())for(const [name,entry]of Object.entries(provider.exports)){
  if(provider.id.startsWith('external.'))try{await authorizeSource(ctx,{provider:provider.id,version:provider.version,export:name,target:{scope:'organization',organizationId:auth.orgId}});}catch(e){if(e instanceof PlatformError&&[400,403,404].includes(e.statusCode))continue;throw e;}
  const scopes=await visible(entry.access,`${provider.id}.${name}`);
  if(scopes.length)add('data',`${provider.id}.${name}`,provider.apps.join(', '),provider.id.startsWith('external.')?'organization':'global',scopes,entry,provider.version);
 }
 for(const action of listActions()){
  if(action.id.startsWith('external.'))try{await authorizeAction({...ctx,mode:'command'},{action:action.id,version:action.version,target:{scope:'organization',organizationId:auth.orgId}});}catch(e){if(e instanceof PlatformError&&[400,403,404].includes(e.statusCode))continue;throw e;}
  const scopes=await visible(action.policy,action.id);
  if(scopes.length)add('actions',action.id,action.domain,action.id.startsWith('external.')?'organization':'global',scopes,action,action.version);
 }
 for(const type of listDatasetTypes())add('dataset types',type.id,'Datasets','global',['project'],type,type.version);
 for(const widget of await listWidgets(ctx))add('widgets',widget.id,widget.app,'global',['project'],widget,widget.version);
 const documentScopes=await visible({scopes:['organization','project'],permissions:['view_projects'],capabilities:['platform.documents']},'document-modules.read');
 if(documentScopes.length){
  for(const type of listDocumentTypes())add('artifacts',type.id,'Document types','global',documentScopes,type);
  for(const type of SCOPE_ARTIFACT_TYPES)add('artifacts',type,'Scope artifact categories','global',['project'],{category:type});
  const widgets=new Map(DOCUMENT_WIDGET_CATALOG.map(w=>[String(w.id),w]));
  const clientWidgets=createRequire(import.meta.url)(path.resolve(process.cwd(),'../libraries/doc-widgets/firstmate-doc-widgets.js'));
  for(const widget of clientWidgets.list())widgets.set(widget.id,JSON.parse(JSON.stringify(widget)));
  for(const resolver of listDocumentWidgetResolvers())widgets.set(resolver.id,{...widgets.get(resolver.id),...resolver});
  for(const [id,widget]of widgets)add('widgets',id,'Document / website / portal widgets','global',documentScopes,widget,String(widget.version||'1'));
  for(const source of listDocumentSources())add('data',`source:${source.id}`,'Legacy document row sources','global',documentScopes,source);
  for(const module of await listModules(ctx)){
   const record=await moduleDefinition(ctx,String(module.id));
   const def=record.definition as Record<string,any>;
   const exports=Object.fromEntries(Object.entries(def.exports||{}).filter(([,value])=>(value as any).access!=='private'));
   add('modules',String(module.id),'Documents / workflows','organization',['project'],{name:def.name,kind:def.kind,exports},String(record.version));
   for(const [name,entry]of Object.entries(exports))add('data',`${module.id}.${name}`,'Document module exports','organization',['project'],entry,String(record.version));
  }
 }
 const projects=hasPermission(auth,'view_projects')?(await listDocuments(auth.orgId,'projects')).filter(p=>p.data.workflow_state!=='contact_only').map(p=>({id:p.id,label:String(p.data.title||p.data.project_title||p.id)})):[];
 let project:Record<string,unknown>={};
 if(projectId){if(!projects.some(p=>p.id===projectId))throw new PlatformError('project_denied',403,'Select an accessible project.');project=(await readDocument(auth.orgId,'projects',projectId)).data;}
 for(const entity of ['project','contact','organization'] as const){
  if(!hasPermission(auth,entity==='contact'?'view_contacts':'view_projects'))continue;
  for(const field of await definitions(auth.orgId,String(project.branch_id||auth.branchId||'default'),entity,entity==='project'?project:{})){
   if(!canReadField(ctx,field))continue;
   const instance=entity==='project'&&projectId&&Array.isArray((project.custom_field_schema as any)?.fields)&&(project.custom_field_schema as any).fields.some((f:any)=>(f.path||f.key)===field.path);
   add('data',`custom-fields-${entity}.${field.path}`,'Custom fields',instance?'project':'organization',entity==='organization'?['organization']:entity==='contact'?['organization','project']:['project'],{...field,schema:fieldSchema(field),...(instance?{projectId}:{})});
  }
 }
 return {ok:true,organizationId:auth.orgId,projectId:projectId||null,projects,items,notes:['Declarations and schemas only; no actions are executed and no live values are displayed.','Global means registered platform-wide; supported scopes describe where an item can be used.','Organization declarations include installed external connection contracts and current published module versions. Select a project to include its custom field declarations.','Flexible JSON exports may declare additional fields only at runtime. Private module exports and fields without read permission are excluded.']};
}

