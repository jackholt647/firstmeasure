import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
const transpile = s => ts.transpileModule(s.replaceAll('export ', ''), {compilerOptions:{target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None}}).outputText.replaceAll('export ', '');
const source = fs.readFileSync(new URL('../firstmeasure/storage.ts', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('export async function getProjectDetail('), source.indexOf('export async function listProjectFiles('));
const keys = {appMetadata:'app_metadata.json', pdfState:'pdf_state.json', brandingDefaults:'branding_defaults.json'};
function fixture(files = [], fail = '') {
  const calls = [];
  const manifest = {id:'a', status:'completed', delivery:{release_hold:{status:'held'}}};
  const ctx = vm.createContext({FIRSTMEASURE_FILE_NAMES:keys, isSpacesArtifactStorageEnabled:()=>false,
    readManifest: async id => {calls.push('manifest');if(fail==='access')throw Error('denied');return manifest;},
    listProjectFiles: async id => {calls.push('list');if(fail==='list')throw Error('SlowDown');return files;},
    readAppMetadata: async () => {calls.push('app');return {edit:1};},
    readPdfState: async () => {calls.push('pdf');return {pages:[1]};},
    readBrandingDefaults: async () => {calls.push('brand');return {color:'red'};}
  });
  vm.runInContext(transpile(fn),ctx);return {ctx,calls,manifest};
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

const artifacts = fs.readFileSync(new URL('../src/storage/project_artifacts.ts', import.meta.url), 'utf8');
const cacheSource = artifacts.slice(artifacts.indexOf('const detailJsonCache ='), artifacts.indexOf('export async function headProjectArtifact'));
function cacheFixture({bytes=128*1024*1024,entries=12000}={}) {
 let gets=0;let value={etag:'"v1"',content:Buffer.from('{"value":1}')};
 const ctx=vm.createContext({Buffer,projectArtifactKey:(p,f)=>p+'/'+f,getProjectArtifactVersion:async()=>{gets++;if(value instanceof Error)throw value;return value;}});
 vm.runInContext(transpile(cacheSource.replace('128 * 1024 * 1024',String(bytes)).replace('= 12000','= '+entries)),ctx);
 return {read:(etag='"v1"',p='a')=>ctx.readListedProjectJson(p,'x.json',etag),gets:()=>gets,set:v=>{value=v;}};
}
test('matching fresh ETags reuse JSON and each caller gets an independent editable object',async()=>{
 const c=cacheFixture();const a=await c.read();a.value=99;assert.equal((await c.read()).value,1);assert.equal(c.gets(),1);
});
test('changed ETag or missing ETag forces a fresh GET',async()=>{
 const c=cacheFixture();await c.read();c.set({etag:'"v2"',content:Buffer.from('{"value":2}')});assert.equal((await c.read('"v2"')).value,2);await c.read('');assert.equal(c.gets(),3);
});
test('a LIST/GET write race caches the actual GET version, never under the earlier listing version',async()=>{
 const c=cacheFixture();c.set({etag:'"v2"',content:Buffer.from('{"value":2}')});await c.read('"v1"');await c.read('"v2"');assert.equal(c.gets(),1);await c.read('"v1"');assert.equal(c.gets(),2);
});
test('concurrent identical reads share one GET; project identities remain isolated',async()=>{
 const c=cacheFixture();await Promise.all([c.read(),c.read(),c.read()]);assert.equal(c.gets(),1);await c.read('"v1"','b');assert.equal(c.gets(),2);
});
test('errors, missing objects and malformed JSON never poison subsequent reads',async()=>{
 const c=cacheFixture();c.set(Error('SlowDown'));await assert.rejects(c.read(),/SlowDown/);c.set(null);assert.equal(await c.read(),null);c.set({etag:'"v1"',content:Buffer.from('broken')});await assert.rejects(c.read());c.set({etag:'"v1"',content:Buffer.from('{"value":3}')});assert.equal((await c.read()).value,3);assert.equal(c.gets(),4);
});
test('LRU entry and byte budgets evict cached bodies',async()=>{
 const c=cacheFixture({entries:1});await c.read();await c.read('"v1"','b');await c.read();assert.equal(c.gets(),3);
 const d=cacheFixture({bytes:48});for(const p of ['a','b','c','d','e'])await d.read('"v1"',p);await d.read();assert.equal(d.gets(),6);
});
test('oversized JSON is returned correctly but not retained',async()=>{
 const c=cacheFixture({bytes:16});await c.read();await c.read();assert.equal(c.gets(),2);
});
test('ETags are opt-in, and paginated listings preserve full inventory',async()=>{
 const start=artifacts.indexOf('export async function listProjectArtifacts(');const end=artifacts.indexOf('export async function listProjectArtifactInventory',start);
 const run=async include=>{let n=0;const ctx=vm.createContext({env:{spacesBucket:'test'},projectPrefix:()=> 'p/',overlayEnabled:()=>false,ListObjectsV2Command:class{constructor(input){this.input=input;}},client:()=>({send:async()=>({Contents:[{Key:'p/'+(++n)+'.json',ETag:'"'+n+'"',Size:10}],IsTruncated:n===1,NextContinuationToken:n===1?'next':undefined})})});vm.runInContext(transpile(artifacts.slice(start,end)),ctx);return ctx.listProjectArtifacts('a',include);};
 const ordinary=await run(false);assert.equal(ordinary.length,2);assert.equal('etag' in ordinary[0],false);const versioned=await run(true);assert.equal(versioned[1].etag,'"2"');
});

test('Spaces details validate current inventory, fetch versioned bodies, and keep ETags out of the public shape',async()=>{
 let tag='"one"';let exists=true;let lists=0;const versions=[];
 const ctx=vm.createContext({FIRSTMEASURE_FILE_NAMES:keys,isSpacesArtifactStorageEnabled:()=>true,readManifest:async()=>({id:'a'}),
 listProjectArtifacts:async(id,include)=>{assert.equal(include,true);lists++;return exists?[{name:keys.appMetadata,size:12,updated_at:'now',etag:tag}]:[];},
 readListedProjectJson:async(id,name,etag)=>{versions.push(etag);return {version:etag};}});
 vm.runInContext(transpile(fn),ctx);let d=await ctx.getProjectDetail('a');assert.equal(d.app_metadata.version,'"one"');assert.equal('etag' in d.files[0],false);
 tag='"two"';d=await ctx.getProjectDetail('a');assert.equal(d.app_metadata.version,'"two"');exists=false;d=await ctx.getProjectDetail('a');assert.equal(d.app_metadata,null);assert.equal(d.files.length,0);assert.equal(lists,3);assert.deepEqual(versions,['"one"','"two"']);
});
