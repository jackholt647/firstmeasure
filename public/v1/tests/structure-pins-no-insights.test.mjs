import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../firstmeasure/processing.ts',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function collectStructureInsights('),source.indexOf('function normalizeLatLngBox('));
function fixture(status){
 const pins=[{lat:36.927333,lng:-86.136654},{lat:36.927267,lng:-86.137108}];
 const c=vm.createContext({resolveRequestedStructurePins:()=>pins,buildStructureLabel:i=>String(i+1),
  fetchBuildingInsightsText:async()=>{throw Object.assign(new Error('Provider failure'),{code:status===404?'insights_no_coverage':'insights_fetch_failed'});},
  badRequest:(code,message)=>Object.assign(new Error(message),{code}),input:{manifest:{},fallbackLocation:{lat:0,lng:0},key:'fake',allowMissingInsights:true}});
 vm.runInContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 return {c,pins};
}
test('manual report can try imagery at exact pins without building footprints',async()=>{
 const {c,pins}=fixture(404);const r=await vm.runInContext('collectStructureInsights(input)',c);
 assert.equal(r.hasCoverageAtAnyPin,false);assert.equal(r.segmentCount,0);
 assert.deepEqual(JSON.parse(JSON.stringify(r.artifact.structures.map(s=>s.pin))),pins);
 assert.equal(r.primaryText,'{}');
});
test('provider credentials/rate failures are not misclassified as missing coverage',async()=>{
 for(const status of [403,429,500]){const {c}=fixture(status);await assert.rejects(vm.runInContext('collectStructureInsights(input)',c),{code:'insights_fetch_failed'});}
});
test('instant reports still require actual building insights',async()=>{
 const {c}=fixture(404);c.input.allowMissingInsights=false;
 await assert.rejects(vm.runInContext('collectStructureInsights(input)',c),{code:'insights_fetch_failed'});
});
