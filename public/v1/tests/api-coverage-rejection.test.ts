import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {fetchRequiredSolarLayers,imageryFailurePatch} from '../firstmeasure/solar_imagery.js';
const source=await readFile(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');

test('expanded coverage tried at unchanged coordinates; failures never masquerade as missing coverage',async()=>{
 const original=globalThis.fetch;
 try{
  for(const status of [200,403,429,500,404]){
   let calls=0;
   globalThis.fetch=async input=>{
    const u=new URL(String(input));assert.equal(u.searchParams.get('location.latitude'),'39.1');
    if(++calls===1)return new Response('{}',{status:404});
    assert.equal(u.searchParams.get('requiredQuality'),'BASE');assert.equal(u.searchParams.get('experiments'),'EXPANDED_COVERAGE');
    return new Response(JSON.stringify({dsmUrl:'fixture',imageryQuality:'BASE'}),{status});
   };
   const request=fetchRequiredSolarLayers<any>('https://solar.googleapis.com/v1/dataLayers:get?location.latitude=39.1');
   if(status===200)assert.equal((await request).imageryQuality,'BASE');
   else await assert.rejects(request,{code:status===404?'solar_imagery_no_coverage':'solar_layers_fetch_failed'});
   assert.equal(calls,2);
  }
 }finally{globalThis.fetch=original;}
});

test('API no-coverage uses the shared frontend rejection, refunds once and cannot become ready',async()=>{
 const code=source.slice(source.indexOf('async function rejectCoverageProject('),source.indexOf('async function finalizePublicApiStructurePinBilling('));
 for(const codeName of ['solar_imagery_no_coverage','solar_layers_fetch_failed']){
  let manifest:any={id:'fixture',status:'needs_structure_pins',pins:[{lat:1,lng:2}],public_api:{key_id:'fixture-key'},organization_ref:{id:'org'},charge_token:'charge-one',amount_charged:30};
  let refunds=0,emails=0;const transitions:string[]=[];let lock=Promise.resolve();
  const ctx=vm.createContext({
   withPublicFirstMeasureLock:(_key:string,fn:any)=>{const p=lock.then(fn);lock=p.catch(()=>{});return p;},
   readManifest:async()=>({...manifest}),buildLegacyManifest:(x:any)=>x,asRecord:(x:any)=>x&&typeof x==='object'?x:{},
   resolveRejectionReasonId:async(x:any)=>x,normalizeOptionalPortalActor:()=>null,toSqlDateString:(d:Date)=>d.toISOString(),moneyAmount:Number,
   refundPublicFirstMeasureOrder:async(x:any)=>{refunds++;assert.equal(x.amount,30);assert.equal(x.meta.rejection_refund_key,'fixture:charge-one');},
   patchManifest:async(_id:string,p:any)=>{manifest={...manifest,...p};if(p.status)transitions.push(p.status);return manifest;},
   updateStatus:async(_id:string,status:string)=>{manifest.status=status;transitions.push(status);return manifest;},
   sendProjectRejectionEmail:async()=>{emails++;return {ok:true};},buildRejectionMessageParagraphs:()=>['No height map available.'],
   finalizePublicApiStructurePinBilling:async()=>({skipped:true}),imageryFailurePatch,
   processProjectImageryRaw:async()=>{throw Object.assign(new Error('fixture'),{code:codeName});}
  });
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);
  await vm.runInContext("Promise.all([runBackgroundImageryProcess('fixture',{}),runBackgroundImageryProcess('fixture',{})])",ctx);
  if(codeName==='solar_imagery_no_coverage'){
   assert.equal(manifest.status,'rejected_no_coverage');assert.equal(manifest.structure_pin_status,'rejected');assert.equal(manifest.refund_issued,true);
   assert.equal(refunds,1);assert.equal(emails,1);assert.equal(manifest.rejection_reason,'no_height_map');assert.equal(manifest.customer_rejection_message,'No height map available.');
  }else{assert.equal(manifest.status,'needs_structure_pins');assert.equal(refunds,0);assert.equal(emails,0);}
  assert.ok(!transitions.includes('ready'));assert.deepEqual(manifest.pins,[{lat:1,lng:2}]);
 }
});
