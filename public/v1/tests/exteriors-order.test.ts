import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('Full House ordering validates flags, references, prices and paid queue artifacts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'fm-exteriors-'));
 const keys=path.join(root,'keys.json');await writeFile(keys,JSON.stringify({application:{internal_api_secret:'isolated-exterior-test'}}));
 Object.assign(process.env,{FIRSTMATE_ENV:'test',NODE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'sqlite',DATABASE_URL:'',PROVIDER_KEYS_PATH:keys,FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',EMAIL_OUTBOUND_DISABLED:'1',STATS_SCHEDULER_DISABLED:'1',WORK_SCHEDULER_DISABLED:'1',FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite')});
 for(const name of ['FIRSTMEASURE','PLATFORM','INTERNAL','CRM','PRICEBOOK','MESSAGING','CHANNELS','CALLS','CANVASSING','WEATHER','CODE_REPORT'])process.env[name+'_STORAGE_ROOT']=path.join(root,name.toLowerCase());
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
  assert.equal(exteriorQuote().ordering_closed,true);
  await assert.rejects(()=>validateExteriorOrder(orgId,body,1),(error:any)=>error.code==='exteriors_closed','closed hours reject expedited orders even when their fee is zero');
  assert.equal((await validateExteriorOrder(orgId,{...body,report_expedite_option:'exteriors_standard'},1)).option.key,'exteriors_standard');
 });
 for(const invalid of [{exterior_references:'[]'},{exterior_references:JSON.stringify(refs.slice(1))},{exterior_references:JSON.stringify(refs.map(r=>({...r,media_id:refs[0]!.media_id})))},{report_pricing_revision:999},{project_type:'commercial'},{exterior_references:'{broken'},{exterior_references:JSON.stringify(refs.map((r,i)=>i===0?{...r,media_id:'media_not_owned_by_this_org'}:r))}]){const res=await action('queue',{...body,...invalid});assert.ok(res.statusCode>=400,res.body);assert.equal((await readGlobal(orgId)).data.credits_balance,100,'invalid order not charged');}
 const queued=await action('queue',body);assert.equal(queued.statusCode,200,queued.body);assert.equal(queued.json().success,true,queued.body);
 const id=queued.json().folder;assert.match(id,/^exteriors_/);const manifest=await readManifest(id);assert.equal(manifest.measurement_scope,'full_house');assert.equal(manifest.include_gutter_measurements,true);assert.equal(manifest.amount_charged,35);assert.equal(manifest.exteriors_base_amount,25);await saveAppMetadata(id,{exteriorsWalls:{version:2,faces:[{id:'wall-test',height:9}]}});assert.equal((await readAppMetadata(id) as any).exteriorsWalls.faces[0].height,9);assert.equal(manifest.report_expedite_option,'exteriors_priority');assert.equal((manifest.elevation_photos as any[]).length,8);assert.ok(await readArtifact(id,'customer-reference-0.png'));assert.equal((await readGlobal(orgId)).data.credits_balance,65);
 for(const [tier,amount,minutes] of [['exteriors_standard',25,1440],['exteriors_same_day',30,360]] as const){const res=await action('queue',{...body,report_expedite_option:tier,include_gutter_measurements:false,amount_charged:0});assert.equal(res.json().success,true,res.body);const m=await readManifest(res.json().folder);assert.equal(m.amount_charged,amount);assert.equal(m.include_gutter_measurements,true);assert.ok(Math.abs(Date.parse(String(m.report_due_window_end))-Date.now()-minutes*60000)<10000);}
 const direct=await app.inject({method:'POST',url:'/v1/firstmeasure/projects/queue',payload:{...body,pins:JSON.parse(body.pins),report_pricing_revision:0,exterior_references:refs}});assert.ok([401,403].includes(direct.statusCode),'direct public queue cannot bypass charging');
 const roof=await action('queue',{address:'456 Fictional Roof Lane',project_type:'residential',pins:body.pins,report_pricing_revision:String(quote.json().pricing_revision)});assert.equal(roof.json().success,true,roof.body);assert.equal((await readManifest(roof.json().folder)).amount_charged,7);
 }finally{await app.close();await(await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();await rm(root,{recursive:true,force:true,maxRetries:5});}
});
