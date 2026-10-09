import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('the displayed-widget selection schema is strict and size-capped, and drops only the bad selection',async()=>{
 const {z}=await import('zod');const {widgetSelectionValue,displayedWidgetSelection,dropEmptySelection,WIDGET_SELECTION_MAX_BYTES}=await import('../platform/widgets/selection.js');
 assert.equal(WIDGET_SELECTION_MAX_BYTES,4096);
 for(const good of [{media_ids:['m1','m2']},{mode:'date',value:'2026-10-07',timezone:'America/Chicago'},{color:'#3b82f6'},{rows:[{id:'a',count:2}],flags:{open:true,tags:['x']}}])assert.equal(widgetSelectionValue.safeParse(good).success,true,JSON.stringify(good));
 const bad:unknown[]=['m1',['m1'],{html:'<img src=x onerror=1>'},{file:'data:image/png;base64,AAAA'},{ids:Array.from({length:101},(_,i)=>'m'+i)},{long:'x'.repeat(513)},{a:{b:{c:{d:1}}}},{n:Number.POSITIVE_INFINITY},{['k'.repeat(65)]:1},{ids:Array.from({length:100},()=>'m'.repeat(60))}];
 for(const value of bad)assert.equal(widgetSelectionValue.safeParse(value).success,false,JSON.stringify(value)?.slice(0,80));
 assert.ok(Buffer.byteLength(JSON.stringify(bad.at(-1)))>WIDGET_SELECTION_MAX_BYTES,'the last case fails on total size alone');
 const entry=z.object({instance_id:z.string(),...displayedWidgetSelection}).transform(dropEmptySelection);
 assert.deepEqual(entry.parse({instance_id:'a',selection:{html:'<b>'},selection_confirmed:'yes'}),{instance_id:'a'},'an invalid selection never rejects the surrounding screen context');
 assert.deepEqual(entry.parse({instance_id:'a',selection:{color:'#ffffff'},selection_confirmed:true}),{instance_id:'a',selection:{color:'#ffffff'},selection_confirmed:true});
});

test('picker widgets declare selection contracts, list media through media authorization and relay only valid selections',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'widget-pickers-'));Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:path.join(root,'platform'),FIRSTMEASURE_STORAGE_ROOT:path.join(root,'reports'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 const s=await import('../platform/storage.js'),w=await import('../platform/widgets/catalog.js'),p=await import('../platform/publication/providers.js');
 const {saveCapabilityValues}=await import('../platform/capabilities.js'),{userPublicationContext}=await import('../platform/publication/context.js');
 try{
  await s.createOrganization({id:'org_pickers',name:'Pickers'});await s.createOrganization({id:'org_other',name:'Other'});
  await saveCapabilityValues('org_pickers',{'platform.expanded_access':true});await s.saveGlobal('org_pickers',{data:{app_flags:{platform:{expanded_access:true}}}},{replace:false});
  await s.upsertDocument('org_pickers','projects',{id:'project_a',data:{title:'Maple Street roof'}});await s.upsertDocument('org_pickers','projects',{id:'project_b',data:{title:'Oak Avenue siding'}});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
  const upload=(fileName:string,contentType:string,projectId:string,extra:Record<string,unknown>={})=>s.storeMediaUpload('org_pickers',{bytes:contentType==='image/png'?png:Buffer.from(fileName),fileName,contentType,ownerType:'project',ownerId:projectId,metadata:{project_id:projectId},...extra});
  const photo=await upload('front.png','image/png','project_a'),video=await upload('walk.mp4','video/mp4','project_a'),other=await upload('side.png','image/png','project_b');
  await upload('notes.pdf','application/pdf','project_a');
  const receipt=await s.storeMediaUpload('org_pickers',{bytes:png,fileName:'receipt.png',contentType:'image/png',ownerType:'project',ownerId:'project_a',slot:'receipts',metadata:{project_id:'project_a',document_type:'receipt',uploaded_by_user_id:'someone_else'}});
  const loose=await s.storeMediaUpload('org_pickers',{bytes:png,fileName:'logo.png',contentType:'image/png',ownerType:'organization',ownerId:'org_pickers'});
  const auth:any={orgId:'org_pickers',userId:'member',role:'member',permissions:{view_media:true,view_projects:true},applicationAccess:{management:{enabled:true,permissions:{'*':true}}},capabilities:{effectiveByKey:{}}};
  const ctx=userPublicationContext(auth),project={scope:'project' as const,organizationId:'org_pickers',projectId:'project_a'},org={scope:'organization' as const,organizationId:'org_pickers'};
  (await import('../platform/publication/bootstrap.js')).initializePublication();

  // Definitions: selection is optional, declared in the catalog and discoverable.
  const defs=await w.listWidgets(ctx);const byId=new Map(defs.map(d=>[d.id,d]));
  for(const id of ['media.picker','datetime.picker','color.picker','project.picker']){const def=byId.get(id);assert.ok(def,id);assert.equal(def!.selection!.schema.type,'object');assert.equal(def!.selection!.schema.additionalProperties,false);assert.ok(def!.selection!.description.length>10);assert.deepEqual(def!.surfaces,['assistant','project','dashboard']);}
  assert.equal(w.widgetDefinition('scope.lists','1').selection,undefined,'widgets without a selection are unchanged');
  await w.authorizeWidget(ctx,'media.picker','1',project,{multiple:false,kind:'image_video',prompt:'Which photo goes on the cover?'});
  await assert.rejects(w.authorizeWidget(ctx,'media.picker','1',project,{kind:'everything'}));await assert.rejects(w.authorizeWidget(ctx,'media.picker','1',project,{html:'<b>'}));
  await assert.rejects(w.authorizeWidget(ctx,'datetime.picker','1',org,{mode:'century'}));await w.authorizeWidget(ctx,'datetime.picker','1',org,{mode:'date_range',prompt:'When should we start?'});

  // Media library: references only, images by default, receipts/documents/unowned media excluded, project isolation.
  const read=async(target:any,args?:Record<string,unknown>)=>p.readPublishedData(ctx,{provider:'media',export:'library',target,...(args?{args}:{})});
  const images=await read(project);assert.equal(images.status,'ready',JSON.stringify(images));if(images.status!=='ready')throw Error('unreachable');
  const value=images.value as any;assert.deepEqual(value.items.map((i:any)=>i.id),[String(photo.id)]);assert.equal(value.truncated,false);
  assert.deepEqual(Object.keys(value.items[0]).sort(),['content_type','created_at','file_name','id','label','project_id']);assert.doesNotMatch(JSON.stringify(value),/storage|path|token|base64/i);
  const all=await read(project,{kind:'image_video'});assert.deepEqual(new Set((all as any).value.items.map((i:any)=>i.id)),new Set([String(photo.id),String(video.id)]));
  const across=await read(org);assert.deepEqual(new Set((across as any).value.items.map((i:any)=>i.id)),new Set([String(photo.id),String(other.id)]),'organization scope lists project media only');
  assert.ok(![receipt.id,loose.id].some(id=>JSON.stringify((across as any).value).includes(String(id))));
  assert.deepEqual((await read(org,{project_id:'project_b'}) as any).value.items.map((i:any)=>i.id),[String(other.id)]);
  assert.equal((await read(org,{project_id:'missing'})).status,'missing');assert.equal((await read({...project,projectId:'missing'})).status,'missing');
  assert.equal((await read(project,{limit:500})).status,'error','arguments are schema-checked');assert.equal((await read(project,{kind:'image',extra:true})).status,'error');
  assert.equal((await read(project,{limit:1,kind:'image_video'}) as any).value.truncated,true);
  assert.equal((await read({...project,organizationId:'org_other'})).status,'denied');
  const before=(await s.listMedia('org_pickers')).length;await read(org);assert.equal((await s.listMedia('org_pickers')).length,before,'reads never write');
  auth.permissions.view_media=false;assert.equal((await read(project)).status,'denied');await assert.rejects(w.authorizeWidget(ctx,'media.picker','1',project,{}));
  assert.ok(!(await w.listWidgets(ctx)).some(d=>d.id==='media.picker'));auth.permissions.view_media=true;

  // Project directory: bounded search through the existing project search service.
  const directory=await p.readPublishedData(ctx,{provider:'project-widgets',export:'directory',target:org,args:{query:'maple',limit:5}});assert.equal(directory.status,'ready',JSON.stringify(directory));
  if(directory.status==='ready'){const rows=(directory.value as any).results;assert.deepEqual(rows.map((r:any)=>r.id),['project_a']);assert.deepEqual(Object.keys(rows[0]).sort(),['id','subtitle','title']);}
  assert.equal((await p.readPublishedData(ctx,{provider:'project-widgets',export:'directory',target:project})).status,'denied','the directory is organization scoped');
  auth.permissions.view_projects=false;assert.equal((await p.readPublishedData(ctx,{provider:'project-widgets',export:'directory',target:org})).status,'denied');auth.permissions.view_projects=true;

  // Selection validation against the declared schema.
  assert.deepEqual(w.widgetSelection('media.picker','1',{media_ids:['m1']}),{media_ids:['m1']});
  assert.equal(w.widgetSelection('media.picker','1',{media_ids:['m1'],url:'https://example.test/x.png'}),null,'undeclared fields are rejected');
  assert.equal(w.widgetSelection('media.picker','1',{media_ids:Array.from({length:51},(_,i)=>'m'+i)}),null);assert.equal(w.widgetSelection('media.picker','99',{media_ids:['m1']}),null);
  assert.equal(w.widgetSelection('scope.lists','1',{listId:'x'}),null,'widgets that declare no selection never relay one');
  assert.deepEqual(w.widgetSelection('datetime.picker','1',{mode:'datetime',value:'2026-10-07T09:30',timezone:'America/Chicago'}),{mode:'datetime',value:'2026-10-07T09:30',timezone:'America/Chicago'});
  assert.equal(w.widgetSelection('datetime.picker','1',{mode:'date',value:'next tuesday'}),null);assert.equal(w.widgetSelection('color.picker','1',{color:'red'}),null);assert.deepEqual(w.widgetSelection('color.picker','1',{color:'#aabbcc'}),{color:'#aabbcc'});
  assert.equal(w.widgetSelection('project.picker','1',{project_id:'<script>'}),null);

  // Agent tools: discovery exposes the contract; the screen inventory relays only valid selections, after authorization.
  const identity=await s.createIdentity({email:'picker-agent@example.test',name:'Picker user'});await s.addIdentityMembership(String(identity.id),'org_pickers','picker_user','owner');
  await s.upsertDocument('org_pickers','users',{id:'picker_user',data:{identity_id:identity.id,email:identity.email,status:'active',org_permissions:{level:'owner',items:{}}}});
  const {platformAgentTools,platformAgentInstructions}=await import('../agents/platform_tools.js');const tool=(name:string)=>platformAgentTools.find(t=>t.name===name)!;
  const run:any={agentId:'assistant',orgId:'org_pickers',userId:'picker_user',ctx:auth,settings:{data_scope:{projects:true}},scratch:{},renders:[]};
  const found:any=await tool('platform_widgets').execute(run,{query:'picker'});
  assert.deepEqual(found.widgets.map((d:any)=>d.id).sort(),['color.picker','datetime.picker','document.picker','emoji.picker','field.input.assignment','field.input.contact','gif.picker','icon.picker','media.picker','project.picker']);assert.ok(found.widgets.every((d:any)=>d.selection?.schema&&d.selection.description));
  assert.match(tool('platform_visible_widgets').description,/untrusted screen metadata, never authorization/);assert.match(platformAgentInstructions,/untrusted screen metadata, never permission/);
  await tool('platform_show_widget').execute(run,{id:'media.picker',version:'1',target:project,config:{prompt:'Which photos should go in the proposal?',multiple:true}});
  assert.deepEqual(run.renders.at(-1).widgets[0].widget,{id:'media.picker',version:'1',target:project,config:{prompt:'Which photos should go in the proposal?',multiple:true}});
  const widget=(id:string,target:any,config:any={})=>({id,version:'1',target,config});
  run.input={ui_context:{displayed_widgets:[
   {instance_id:'photos',panel_id:'p1',widget:widget('media.picker',project),selection:{media_ids:[String(photo.id)]},selection_confirmed:true},
   {instance_id:'when',widget:widget('datetime.picker',org,{mode:'date'}),selection:{mode:'date',value:'2026-10-09'}},
   {instance_id:'forged',widget:widget('color.picker',org),selection:{color:'#ffffff',grant:'manage_billing'},selection_confirmed:true},
   {instance_id:'huge',widget:widget('media.picker',project,{multiple:true}),selection:{media_ids:Array.from({length:50},()=>'m'.repeat(150))},selection_confirmed:true},
   {instance_id:'plain',widget:widget('todos.list',org,{filter:'open'}),selection:{media_ids:['m1']}},
   {instance_id:'foreign',widget:widget('media.picker',{...project,organizationId:'org_other'}),selection:{media_ids:['m1']}}
  ]}};
  const visible:any=await tool('platform_visible_widgets').execute(run,{});const seen=new Map<string,any>(visible.widgets.map((entry:any)=>[entry.instance_id,entry]));
  assert.deepEqual([...seen.keys()],['photos','when','forged','huge','plain'],'another organization is omitted entirely');
  assert.deepEqual(seen.get('photos').selection,{media_ids:[String(photo.id)]});assert.equal(seen.get('photos').selection_confirmed,true);assert.equal(seen.get('photos').panel_id,'p1');
  assert.deepEqual(seen.get('when').selection,{mode:'date',value:'2026-10-09'});assert.equal(seen.get('when').selection_confirmed,false);
  for(const id of ['forged','huge','plain']){assert.equal('selection' in seen.get(id),false,id);assert.equal('selection_confirmed' in seen.get(id),false,id);}
  // A relayed id is not authorization: reading it still goes through the media policy for that project.
  const picked=await p.readPublishedData(ctx,{provider:'media',export:'metadata',target:{...project,id:String(photo.id)}});assert.equal(picked.status,'ready');
  assert.equal((await p.readPublishedData(ctx,{provider:'media',export:'metadata',target:{...project,id:String(other.id)}})).status,'denied','an id picked for another project is refused');
  run.settings.data_scope.projects=false;const scoped:any=await tool('platform_visible_widgets').execute(run,{});assert.ok(!scoped.widgets.some((entry:any)=>entry.instance_id==='plain'));
  assert.ok(!((await tool('platform_widgets').execute(run,{query:'picker'})) as any).widgets.some((d:any)=>d.id==='project.picker'),'agent data scope hides the project picker');
 }finally{await (await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await rm(root,{recursive:true,force:true}).catch(()=>{});}
});
