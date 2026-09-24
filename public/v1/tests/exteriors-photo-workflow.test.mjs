import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import {randomUUID} from 'node:crypto';

const source=await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8');
const views=['front','front-right','right','back-right','back','back-left','left','front-left'];
async function harness(fetchImpl, photoReviewTest=false){
 const portal={cfg:{serverEndpoint:'/local-test'},capabilities:{value:key=>key==='firstmeasure.exteriors'},util:{escapeHtml:s=>s,injectCSS(){},postAction:async()=>({data:{success:true,allow_incomplete_photo_review:photoReviewTest,pricing_revision:2,options:[{key:'exteriors_standard',amount:25}]}})}};
 // Exercise the module's actual state transitions without adding a production test API.
 const instrumented=source.replace('  P.ExteriorOrder={',`  P.test={files,assign,upload,send,go,canVisit,pinsConfirmed,confirm:()=>{confirmedPins=pinSignature;},getPage:()=>page};\n  P.ExteriorOrder={`);
 vm.runInNewContext(instrumented,{window:{Portal:portal},document:{getElementById:()=>null,cookie:''},URL,FormData,crypto:{randomUUID},fetch:fetchImpl});
 const context={type:'residential',count:1,pins:[{lat:39,lng:-105}],ordered:false,orderWorkflow:true,refresh:()=>portal.ExteriorOrder.sync(context)};
 const order=portal.ExteriorOrder;order.sync(context);await new Promise(setImmediate);
 order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_standard',tech_notes:'Keep the porch.',exterior_references:JSON.stringify(views.map((view,i)=>({structure:0,view,media_id:'media_'+i})))});
 return {order,context,t:portal.test};
}

test('pin confirmation gates forward navigation, invalidates after same-count movement, and preserves photos/notes',async()=>{
 const {order,context,t}=await harness();
 assert.equal(t.canVisit(1),false);t.go(2);assert.equal(t.getPage(),0);
 t.confirm();t.go(1);t.go(2);assert.equal(order.ready(),true);
 t.go(0);assert.equal(t.canVisit(2),true);t.go(2);
 context.pins=[{lat:39.001,lng:-105}];order.sync(context);
 assert.equal(t.pinsConfirmed(),false);assert.equal(t.getPage(),0);assert.equal(order.ready(),false);
 assert.equal(JSON.parse(order.payload().exterior_references).length,8);assert.equal(order.payload().tech_notes,'Keep the porch.');
 t.confirm();t.go(2);assert.equal(order.ready(),true);
});

test('bulk assignments preserve displaced photos, exclude unassigned photos from payload, and require a decision before review',async()=>{
 const {order,t}=await harness();t.confirm();
 t.files.set('tray:extra',{name:'extra.jpg',media_id:'extra'});
 assert.equal(t.canVisit(2),false);assert.equal(JSON.parse(order.payload().exterior_references).length,8);
 t.assign('tray:extra','0:front');
 const displaced=[...t.files].find(([key])=>key.startsWith('tray:'));
 assert.equal(displaced[1].media_id,'media_0');assert.equal(t.files.size,9);
 t.assign(displaced[0],'0:additional-example');t.go(2);
 assert.equal(order.ready(),true);const refs=JSON.parse(order.payload().exterior_references);
 assert.equal(refs.find(r=>r.view==='front').media_id,'extra');assert.equal(refs.find(r=>r.view==='additional').media_id,'media_0');
 t.files.get('0:additional-example').error='Network failed';assert.equal(order.ready(),false);assert.equal(t.canVisit(2),false);
});

test('removed structure photos are kept for reassignment rather than destroyed',async()=>{
 const {order,context,t}=await harness();context.count=2;order.sync(context);await new Promise(setImmediate);
 t.files.set('1:front',{name:'other-house.jpg',media_id:'other'});
 context.count=1;order.sync(context);
 assert.equal(t.files.has('1:front'),false);assert.ok([...t.files].some(([k,f])=>k.startsWith('tray:')&&f.media_id==='other'));
});

test('uploads have bounded concurrency and removed or reset photos cannot reappear on completion',async()=>{
 const requests=[];let current=0,max=0;
 const {order,t}=await harness(()=>new Promise(resolve=>{current++;max=Math.max(max,current);requests.push(()=>{current--;resolve({ok:true,json:async()=>({success:true,media_id:randomUUID()})});});}));
 const file=new File(['test bytes'],'fixture.jpg',{type:'image/jpeg'});
 const uploads=Array.from({length:8},(_,i)=>t.upload(file,'tray:'+i));
 assert.equal(requests.length,3);assert.equal(max,3);
 t.files.delete('tray:0');requests.shift()();await new Promise(setImmediate);
 assert.equal(t.files.has('tray:0'),false);
 order.reset();while(requests.length){requests.shift()();await new Promise(setImmediate);}
 await Promise.all(uploads);assert.equal(t.files.size,0);assert.equal(max,3);
});

test('failed uploads can be retried without losing assignment, and retry success unblocks review',async()=>{
 let fail=true;
 const {order,t}=await harness(async()=>({ok:!fail,json:async()=>fail?{success:false,message:'Temporary failure'}:{success:true,media_id:'recovered'}}));
 const file=new File(['test bytes'],'retry.jpg',{type:'image/jpeg'});
 await t.upload(file,'tray:retry');t.assign('tray:retry','0:additional-retry');t.confirm();
 assert.equal(t.files.get('0:additional-retry').error,'Temporary failure');assert.equal(t.canVisit(2),false);
 fail=false;await t.send(t.files.get('0:additional-retry'));t.go(2);
 assert.equal(order.ready(),true);assert.equal(JSON.parse(order.payload().exterior_references).find(r=>r.view==='additional').media_id,'recovered');
});


test('org-specific photo review preview allows page three but never makes an incomplete order submittable',async()=>{
 for(const enabled of [false,true]){
  const {order,t}=await harness(undefined,enabled);t.files.clear();t.confirm();t.go(2);
  assert.equal(t.getPage(),enabled?2:0);
  assert.equal(order.ready(),false,'test preview never bypasses actual order requirements');
 }
});

test('shared host pin confirmation and technician notes are authoritative',async()=>{
 const {order,context,t}=await harness();
 context.locationConfirmed=true;context.getNotes=()=> 'Shared roof notes';context.setPinConfirmed=value=>{context.locationConfirmed=value;};
 order.sync(context);t.go(2);assert.equal(order.ready(),true);assert.equal(order.payload().tech_notes,'Shared roof notes');
 context.pins=[{lat:40,lng:-105}];order.sync(context);assert.equal(context.locationConfirmed,false);assert.equal(order.ready(),false);
});

test('shared mobile pager can show Details, Photos, and Review without using the exterior navigation',async()=>{
 const {order,context,t}=await harness();
 context.locationConfirmed=true;order.sync(context);
 assert.equal(order.mobileDetailsReady(),true);
 order.setMobilePage('photos');assert.equal(t.getPage(),1);
 assert.equal(order.mobilePhotosReady(),true);
 order.setMobilePage('final');assert.equal(t.getPage(),2);
 assert.equal(order.ready(),true);
 order.setMobilePage('details');assert.equal(t.getPage(),0);
 t.files.delete('0:front');
 assert.equal(order.mobilePhotosReady(),false);
 order.setMobilePage('photos');assert.equal(t.getPage(),1);
 assert.equal(order.ready(),false);
});
