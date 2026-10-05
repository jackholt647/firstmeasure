import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Full House ordering validates flags, references, prices and paid queue artifacts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fm-exteriors-'));
 const keys=path.join(root,'keys.json');await writeFile(keys,JSON.stringify({application:{internal_api_secret:'isolated-exterior-test'}}));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',NODE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',DATABASE_URL:'',PROVIDER_KEYS_PATH:keys,GOOGLE_MAPS_API_KEY:'exterior-country-fixture',FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',EMAIL_OUTBOUND_DISABLED:'1',STATS_SCHEDULER_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 for(const name of ['FIRSTMEASURE','PLATFORM','INTERNAL','CRM','PRICEBOOK','MESSAGING','CHANNELS','CALLS','CANVASSING','WEATHER','CODE_REPORT'])process.env[name+'_STORAGE_ROOT']=path.join(root,name.toLowerCase());
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(async(input:any)=>new Response(JSON.stringify(String(input).includes('/geocode/')?{status:'OK',results:[{address_components:[{types:['country'],short_name:'US'}]}]}:{}),{status:String(input).includes('/geocode/')?200:503})) as typeof fetch;
 const {buildApp}=await import('../src/app.js');
 const {saveCapabilityValues}=await import('../platform/capabilities.js');
 const {saveGlobal,readGlobal}=await import('../platform/storage.js');
 const {readManifest,readArtifact,saveAppMetadata,readAppMetadata}=await import('../firstmeasure/storage.js');
 const {exteriorQuote,EXTERIOR_VIEWS,validateExteriorOrder}=await import('../firstmeasure/exteriors.js');
 const {pricingContext,DEFAULT_EXPEDITE_PRICING}=await import('../firstmeasure/pricing_config.js');
 const app=await buildApp();await app.ready();
 try{
 const register=await app.inject({method:'POST',url:'/v1/platform/auth/register',payload:{email:'exterior@test.example',name:'Exterior Test',password:'Local-only-test-123!',phone:'+15550103782'}});assert.equal(register.statusCode,201,register.body);
 const cookie=String(register.headers['set-cookie']).match(/fm_platform_session=[^;,]+/)![0];
 const session=(await app.inject({method:'GET',url:'/v1/platform/auth/session',headers:{cookie}})).json();
 const orgId=session.membership.organization_id;const headers={cookie,'x-platform-csrf':session.csrf_token};
 const action=(action:string,fields:any={},h:any=headers)=>app.inject({method:'POST',url:'/v1/platform/portal-action',headers:h,payload:{action,...fields}});
 assert.equal((await action('exteriors_quote',{project_type:'residential'})).statusCode,403,'default off');
 await saveCapabilityValues(orgId,{'firstmeasure.exteriors':true});
 assert.equal((await action('exteriors_quote',{}, {cookie})).statusCode,403,'CSRF required');
 for(const project_type of ['commercial','multifamily'])assert.equal((await action('exteriors_quote',{project_type})).statusCode,403,'nonresidential default off');
 const quote=await action('exteriors_quote',{project_type:'residential',structure_count:2});assert.equal(quote.statusCode,200,quote.body);assert.deepEqual(quote.json().options.map((o:any)=>o.amount),[50,60,70]);
 assert.equal(quote.json().allow_incomplete_photo_review,false,'preview flag defaults off');
 await saveCapabilityValues(orgId,{'firstmeasure.exteriors_photo_review_test':true});
 assert.equal((await action('exteriors_quote')).json().allow_incomplete_photo_review,true,'explicit test org can preview');
 const {env}=await import('../src/config/env.js');
 const productionTestEnv=env as {isProduction:boolean};const previousProduction=productionTestEnv.isProduction;productionTestEnv.isProduction=true;
 try{assert.equal((await action('exteriors_quote')).json().allow_incomplete_photo_review,false,'production hard-disables photo preview even with org flag');}finally{productionTestEnv.isProduction=previousProduction;}
 pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING,exteriors_base_price:40,exteriors_same_day_fee:7,exteriors_priority_fee:12},revision:4,now:new Date('2026-09-19T18:00:00Z')},()=>{const q=exteriorQuote(2);assert.deepEqual(q.options.map(o=>o.amount),[80,94,104]);assert.equal(q.pricing_revision,4);});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QmcAAAAASUVORK5CYII=','base64');
 assert.equal((await action('exteriors_upload',{__file:{bytes_base64:Buffer.from('not image').toString('base64')}})).statusCode,400);
 const refs:Array<{structure:number;view:string;media_id:string}>=[];for(const view of EXTERIOR_VIEWS){const upload=await action('exteriors_upload',{project_type:'residential',__file:{filename:view+'.png',bytes_base64:png.toString('base64')}});assert.equal(upload.statusCode,200,upload.body);refs.push({structure:0,view,media_id:upload.json().media_id});}
 await saveGlobal(orgId,{data:{credits_balance:100}});
 const body={address:'123 Fictional Test Lane',project_type:'residential',measurement_scope:'full_house',pins:JSON.stringify([{lat:47.6,lng:-122.3}]),report_expedite_option:'exteriors_priority',report_pricing_revision:quote.json().pricing_revision,exterior_references:JSON.stringify(refs),tech_notes:'Reference test notes'};
 const extra=await action('exteriors_upload',{project_type:'residential',__file:{filename:'front-retake.png',bytes_base64:png.toString('base64')}});
 const withRetake=[...refs,{structure:0,view:'additional',angle:'front',media_id:extra.json().media_id}];
 assert.equal((await validateExteriorOrder(orgId,{...body,report_expedite_option:'exteriors_standard',exterior_references:withRetake},1)).references.at(-1)?.angle,'front');
 await assert.rejects(()=>validateExteriorOrder(orgId,{...body,exterior_references:[...refs,{...withRetake.at(-1),angle:'invalid'}]},1));
 await pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING,exteriors_priority_fee:0},revision:quote.json().pricing_revision,now:new Date('2026-09-20T04:00:00Z')},async()=>{
  assert.equal(exteriorQuote().ordering_closed,false);
  assert.equal((await validateExteriorOrder(orgId,body,1)).option.key,'exteriors_priority','rush remains available after 8pm');
  assert.equal((await validateExteriorOrder(orgId,{...body,report_expedite_option:'exteriors_standard'},1)).option.key,'exteriors_standard');
 });
 for(const invalid of [{exterior_references:'[]'},{exterior_references:JSON.stringify(refs.slice(1))},{exterior_references:JSON.stringify(refs.map(r=>({...r,media_id:refs[0]!.media_id})))},{report_pricing_revision:999},{project_type:'commercial'},{exterior_references:'{broken'},{exterior_references:JSON.stringify(refs.map((r,i)=>i===0?{...r,media_id:'media_not_owned_by_this_org'}:r))}]){const res=await action('queue',{...body,...invalid});assert.ok(res.statusCode>=400,res.body);assert.equal((await readGlobal(orgId)).data.credits_balance,100,'invalid order not charged');}
 const queued=await action('queue',body);assert.equal(queued.statusCode,200,queued.body);assert.equal(queued.json().success,true,queued.body);
 const id=queued.json().folder;assert.match(id,/^exteriors_/);const manifest=await readManifest(id);assert.equal(manifest.measurement_scope,'full_house');assert.equal(manifest.include_gutter_measurements,true);assert.equal(manifest.amount_charged,35);assert.equal(manifest.exteriors_base_amount,25);await saveAppMetadata(id,{exteriorsWalls:{version:2,faces:[{id:'wall-test',height:9}]}});assert.equal((await readAppMetadata(id) as any).exteriorsWalls.faces[0].height,9);assert.equal(manifest.report_expedite_option,'exteriors_priority');assert.equal((manifest.elevation_photos as any[]).length,8);assert.ok(await readArtifact(id,'customer-reference-0.png'));assert.equal((await readGlobal(orgId)).data.credits_balance,65);
 for(const [tier,amount,minutes] of [['exteriors_standard',25,1440],['exteriors_same_day',30,360]] as const){const res=await action('queue',{...body,report_expedite_option:tier,include_gutter_measurements:false,amount_charged:0});assert.equal(res.json().success,true,res.body);const m=await readManifest(res.json().folder);assert.equal(m.amount_charged,amount);assert.equal(m.include_gutter_measurements,true);assert.ok(Math.abs(Date.parse(String(m.report_due_window_end))-Date.now()-minutes*60000)<10000);}
 // An orbital video replaces the eight views; videos are stored apart from the image-only elevation photos.
 const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(64)]);
 const clip=await action('exteriors_upload',{project_type:'residential',__file:{filename:'walk.mp4',bytes_base64:mp4.toString('base64')}});assert.equal(clip.statusCode,200,clip.body);assert.equal(clip.json().kind,'video');
 const webm=await action('exteriors_upload',{project_type:'residential',__file:{filename:'detail.webm',bytes_base64:Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.alloc(32)]).toString('base64')}});assert.equal(webm.statusCode,200,webm.body);
 const orbit={structure:0,view:'orbital_video',media_id:clip.json().media_id};
 const videoBody={...body,report_expedite_option:'exteriors_standard',exterior_references:JSON.stringify([orbit,{structure:0,view:'additional',media_id:extra.json().media_id},{structure:0,view:'additional',kind:'image',media_id:webm.json().media_id}])};
 assert.deepEqual((await validateExteriorOrder(orgId,videoBody,1)).references.map(r=>r.kind),['video','image','video'],'the stored upload decides the kind, not the client');
 await assert.rejects(()=>validateExteriorOrder(orgId,{...videoBody,exterior_references:[{...orbit,media_id:extra.json().media_id}]},1),(error:any)=>error.code==='invalid_reference','a photo cannot stand in for the orbital video');
 await assert.rejects(()=>validateExteriorOrder(orgId,{...videoBody,exterior_references:refs.map((r,i)=>i===0?{...r,media_id:clip.json().media_id}:r)},1),(error:any)=>error.code==='invalid_reference','a video cannot fill a required view');
 await assert.rejects(()=>validateExteriorOrder(orgId,{...videoBody,pins:JSON.stringify([{lat:47.6,lng:-122.3},{lat:47.61,lng:-122.3}])},2),(error:any)=>error.code==='missing_reference','every structure needs its own video or eight views');
 await saveGlobal(orgId,{data:{credits_balance:100}});
 const videoOrder=await action('queue',videoBody);assert.equal(videoOrder.statusCode,200,videoOrder.body);assert.equal(videoOrder.json().success,true,videoOrder.body);
 const videoManifest=await readManifest(videoOrder.json().folder) as any;
 assert.deepEqual(videoManifest.exterior_reference_videos.map((v:any)=>[v.file_name,v.view,v.content_type]),[['customer-reference-0.mp4','orbital_video','video/mp4'],['customer-reference-2.webm','additional','video/webm']]);
 assert.deepEqual(videoManifest.elevation_photos.map((p:any)=>p.file_name),['customer-reference-1.png']);
 assert.ok(await readArtifact(videoOrder.json().folder,'customer-reference-0.mp4'));assert.equal((await readGlobal(orgId)).data.credits_balance,75);
 const direct=await app.inject({method:'POST',url:'/v1/firstmeasure/projects/queue',payload:{...body,pins:JSON.parse(body.pins),report_pricing_revision:0,exterior_references:refs}});assert.ok([401,403].includes(direct.statusCode),'direct public queue cannot bypass charging');
 const roof=await action('queue',{address:'456 Fictional Roof Lane',project_type:'residential',pins:body.pins,report_pricing_revision:String(quote.json().pricing_revision)});assert.equal(roof.json().success,true,roof.body);assert.equal((await readManifest(roof.json().folder)).amount_charged,7);
 }finally{globalThis.fetch=originalFetch;await app.close();await(await import('./helpers/platform-fixture.js')).closePlatformFixtureStores();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
