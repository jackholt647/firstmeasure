import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { fetchRequiredSolarLayers, fetchRequiredSolarDsm, imageryFailurePatch } from '../firstmeasure/solar_imagery.js';

test('Solar layers distinguish genuine no coverage from provider failures without leaking credentials',async()=>{
 const original=globalThis.fetch;
 try {
  for(const status of [404,400,403,429,500]){
   globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'secret-key-do-not-expose'}}),{status});
   await assert.rejects(fetchRequiredSolarLayers('https://solar.example/?key=secret-key-do-not-expose'),(e:any)=>{
    assert.equal(e.code,status===404?'solar_imagery_no_coverage':'solar_layers_fetch_failed');
    assert.equal(e.message.includes('secret-key'),false);
    assert.equal(imageryFailurePatch(e).status,status===404?'needs_coverage_review':'needs_structure_pins');return true;
   });
  }
  globalThis.fetch=async()=>new Response('not json');
  await assert.rejects(fetchRequiredSolarLayers('https://solar.example'),{code:'solar_layers_parse_failed'});
 }finally{globalThis.fetch=original;}
});

test('DSM downloads require actual TIFF data; a failed signed URL is not no coverage',async()=>{
 const original=globalThis.fetch;
 try{
  await assert.rejects(fetchRequiredSolarDsm(undefined,'secret'),{code:'solar_dsm_not_returned'});
  for(const status of [403,404,429,500]){
   globalThis.fetch=async()=>new Response('',{status});
   await assert.rejects(fetchRequiredSolarDsm('https://solar.example/raster?id=1','secret'),(e:any)=>{
    assert.equal(e.code,'solar_dsm_download_failed');assert.equal(imageryFailurePatch(e).status,'needs_structure_pins');return true;
   });
  }
  for(const body of ['', '<html>Not a raster</html>']){
   globalThis.fetch=async()=>new Response(body);
   await assert.rejects(fetchRequiredSolarDsm('https://solar.example/raster','secret'),{code:'solar_dsm_invalid'});
  }
  const tiff=new Uint8Array([73,73,42,0,8,0,0,0]);
  globalThis.fetch=async input=>{const url=new URL(String(input));assert.equal(url.searchParams.get('key'),'secret');assert.equal(url.searchParams.get('alt'),'media');return new Response(tiff);};
  assert.deepEqual(await fetchRequiredSolarDsm('https://solar.example/raster?id=1','secret'),tiff);
 }finally{globalThis.fetch=original;}
});

test('complete imagery orchestration stops on no coverage and still completes with a valid DSM',async()=>{
 const source=await readFile(new URL('../firstmeasure/processing.ts',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('export async function processProjectImagery('),source.indexOf('export async function processProjectMask(')).replace('export ','');
 const original=globalThis.fetch;
 try{
  for(const covered of [false,true]){
   const saved:string[]=[],patches:any[]=[];
   const manifest={instant_enabled:false,pins:[{lat:39.13393876112519,lng:-86.98916646874372}]};
   globalThis.fetch=async input=>String(input).includes('dataLayers')?new Response(JSON.stringify(covered?{dsmUrl:'https://solar.example/dsm'}:{error:{code:404}}),{status:covered?200:404}):new Response(new Uint8Array([73,73,42,0,8,0,0,0]));
   const context=vm.createContext({fetchRequiredSolarLayers,fetchRequiredSolarDsm,requireGoogleKey:()=> 'fake',readManifest:async()=>manifest,
    resolveProjectLocation:async()=>({lat:39.133809768878706,lng:-86.98902364111368,address:'fixture'}),
    collectStructureInsights:async()=>({primaryText:'{}',primaryInsights:{},artifact:{structures:[]},segmentCount:0,hasCoverageAtAnyPin:false}),
    resolveProjectImageryArea:(_m:any,_i:any,l:any)=>({...l,radius_meters:60}),resolveSolarPixelSizeMeters:()=>0.1,
    saveArtifact:async(_p:string,n:string)=>saved.push(n),INSTANT_STRUCTURE_INSIGHTS_FILE_NAME:'structures.json',computeComplexityRating:()=>1,
    generateStructureSupplementalImagery:async()=>{},fetchBinary:async()=>null,env:{},patchManifest:async(_p:string,p:any)=>{patches.push(p);return {...manifest,...p};},
    buildMultiStructurePointPatch:()=>({}),solarImageryQualityPatchFromSolarResponse:()=>({}),buildPartialInstantRefundPatch:()=>({}),
    readBrandingDefaults:async()=>null,ensureInstantPdfArtifact:async()=>null,readArtifactBytes:async()=>new Uint8Array(),badRequest:(code:string,message:string)=>Object.assign(new Error(message),{code})});
   vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
   if(covered){const result=await vm.runInContext("processProjectImagery('fixture',{})",context);assert.equal(result.project.status,'ready');assert.ok(saved.includes('dsm.tif'));}
   else{await assert.rejects(vm.runInContext("processProjectImagery('fixture',{})",context),{code:'solar_imagery_no_coverage'});assert.equal(patches.length,0);assert.ok(!saved.includes('dsm.tif'));}
  }
 }finally{globalThis.fetch=original;}
});

test('actual background processing sends confirmed no coverage to review, not retry or rejection',async()=>{
 const source=await readFile(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('async function runBackgroundImageryProcess('),source.indexOf('async function finalizePublicApiStructurePinBilling('));
 for(const errorCode of ['solar_imagery_no_coverage','solar_layers_fetch_failed','solar_dsm_download_failed']){
  const patches:any[]=[];
  const context=vm.createContext({finalizePublicApiStructurePinBilling:async()=>({skipped:true}),processProjectImagery:async()=>{throw Object.assign(new Error('fixture failure'),{code:errorCode});},imageryFailurePatch,patchManifest:async(_id:string,patch:any)=>patches.push(patch)});
  vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  await vm.runInContext("runBackgroundImageryProcess('fixture',{})",context);
  assert.equal(patches.length,1);
  assert.equal(patches[0].status,errorCode==='solar_imagery_no_coverage'?'needs_coverage_review':'needs_structure_pins');
  for(const field of ['pins','lat','lng','refund_pending','amount_charged','rejection_reason'])assert.equal(field in patches[0],false);
 }
 const index=await readFile(new URL('../firstmeasure/project_index.ts',import.meta.url),'utf8');
 assert.match(index,/\["no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"\]\.includes\(status\)\) return "waiting"/);
});
