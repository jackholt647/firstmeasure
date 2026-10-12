import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../firstmeasure/storage.ts', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('export async function getProjectDetail('), source.indexOf('export async function listProjectFiles(')).replace('export ', '').replace('projectId: string', 'projectId');
const keys = {appMetadata:'app_metadata.json', pdfState:'pdf_state.json', brandingDefaults:'branding_defaults.json'};
function fixture(files = [], fail = '') {
  const calls = [];
  const manifest = {id:'a', status:'completed', delivery:{release_hold:{status:'held'}}};
  const ctx = vm.createContext({FIRSTMEASURE_FILE_NAMES:keys,
    readManifest: async id => {calls.push('manifest');if(fail==='access')throw Error('denied');return manifest;},
    listProjectFiles: async id => {calls.push('list');if(fail==='list')throw Error('SlowDown');return files;},
    readAppMetadata: async () => {calls.push('app');return {edit:1};},
    readPdfState: async () => {calls.push('pdf');return {pages:[1]};},
    readBrandingDefaults: async () => {calls.push('brand');return {color:'red'};}
  });
  vm.runInContext(fn,ctx);return {ctx,calls,manifest};
}
test('missing optional files cause no speculative GETs and preserve the complete response shape', async () => {
 const {ctx,calls,manifest}=fixture([{name:'Report.pdf',size:123,updated_at:'today'}]);const d=await ctx.getProjectDetail('a');
 assert.deepEqual(calls,['manifest','list']);assert.equal(d.manifest,manifest);assert.equal(d.files[0].size,123);
 assert.deepEqual(JSON.parse(JSON.stringify(d)),{manifest,app_metadata:null,pdf_state:null,branding_defaults:null,files:[{name:'Report.pdf',size:123,updated_at:'today'}]});
});
test('all existing editable JSON bodies are retained',async()=>{
 const {ctx,calls}=fixture(Object.values(keys).map(name=>({name})));const d=await ctx.getProjectDetail('a');
 assert.deepEqual(calls,['manifest','list','app','pdf','brand']);assert.equal(d.app_metadata.edit,1);assert.equal(d.pdf_state.pages[0],1);assert.equal(d.branding_defaults.color,'red');
});
test('mixed inventory only fetches present optional files',async()=>{
 const {ctx,calls}=fixture([{name:keys.pdfState}]);const d=await ctx.getProjectDetail('a');assert.deepEqual(calls,['manifest','list','pdf']);assert.equal(d.app_metadata,null);assert.equal(d.branding_defaults,null);
});
test('a failed listing propagates rather than returning empty files or making more GETs',async()=>{
 const {ctx,calls}=fixture([], 'list');await assert.rejects(ctx.getProjectDetail('a'),/SlowDown/);assert.deepEqual(calls,['manifest','list']);
});
test('access failure happens before any storage request',async()=>{
 const {ctx,calls}=fixture([], 'access');await assert.rejects(ctx.getProjectDetail('a'),/denied/);assert.deepEqual(calls,['manifest']);
});
test('each request lists again and sees newly created files, with no stale cache',async()=>{
 const files=[];const {ctx,calls}=fixture(files);assert.equal((await ctx.getProjectDetail('a')).app_metadata,null);
 files.push({name:keys.appMetadata});assert.equal((await ctx.getProjectDetail('a')).app_metadata.edit,1);assert.equal(calls.filter(x=>x==='list').length,2);
});
