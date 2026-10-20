// Regression tests for production hotfix 15ed3851 (no missing-image storage fanout),
// checked against canonical's sendProjectThumbnail. Without catalog reads the
// thumbnail cache is checked first and storage is listed lazily, once; with catalog
// reads the versioned listing is read up front and unlisted sources are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const api=fs.readFileSync(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const start=api.indexOf('async function sendProjectThumbnail(');
const end=api.indexOf('async function readProjectArtifactFile(',start);
assert.ok(start>=0&&end>start,'sendProjectThumbnail not found');
const js=ts.transpileModule(api.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({files=[],cache={},fail='',artifact=null,catalog=false}={}){
 const calls=[];const reply={header(){return reply;}};
 const listed=()=>{calls.push('list');if(fail==='list')throw Error('SlowDown');};
 const ctx=vm.createContext({Array,Set,Map,String,createHash,clampThumbnailWidth:()=>320,
  readManifest:async()=>{calls.push('manifest');if(fail==='access')throw Error('denied');},
  catalogReadsEnabled:()=>catalog,
  // Strip the version suffix so cache fixtures are keyed by source name in both modes.
  thumbnailCachePath:(id,source)=>source.replace(/-[0-9a-f]{16}$/,''),
  readCachedThumbnail:async path=>cache[path]||null,
  listProjectFiles:async()=>{listed();return files.map(name=>({name}));},
  listProjectArtifacts:async(id,etags)=>{assert.equal(etags,true);listed();return files.map(name=>({name,etag:'"'+name+'"'}));},
  readProjectArtifactFile:async(id,source)=>{calls.push('get:'+source);return typeof artifact==='function'?artifact(source):artifact;},
  sendArtifactContent:(value)=>value,
  badRequest:(code)=>Error(code)
 },{importModuleDynamically:async()=>{throw Error('sharp unavailable in test');}});
 vm.runInContext(js,ctx);return {calls,files,run:q=>ctx.sendProjectThumbnail('project',q||{},reply)};
}
for(const catalog of [false,true]){
 const mode=catalog?' (catalog reads)':' (direct listing)';
 test('missing thumbnail makes one listing, no image GETs and returns thumbnail_source_not_found'+mode,async()=>{
  const f=fixture({catalog,files:['Report.pdf','app_metadata.json']});await assert.rejects(f.run(),/thumbnail_source_not_found/);assert.deepEqual(f.calls,['manifest','list']);
 });
 test('cached fallback skips missing candidates with one listing and no downloads'+mode,async()=>{
  const image={image:true};const f=fixture({catalog,files:['google.png'],cache:{'google.png':image}});assert.equal(await f.run(),image);assert.deepEqual(f.calls,['manifest','list']);
 });
 test('only existing source files are downloaded and the sharp-unavailable fallback is retained'+mode,async()=>{
  const image={name:'azure.png',content:Buffer.from('test')};const f=fixture({catalog,files:['azure.png'],artifact:image});assert.equal(await f.run(),image);assert.deepEqual(f.calls,['manifest','list','get:azure.png']);
 });
 test('access and listing failures stop further storage fanout'+mode,async()=>{
  for(const fail of ['access','list']){const f=fixture({catalog,fail,files:['google.png']});await assert.rejects(f.run(),fail==='access'?/denied/:/SlowDown/);assert.deepEqual(f.calls,fail==='access'?['manifest']:['manifest','list']);}
 });
 test('missing-image result is not cached; newly created images are discovered next request'+mode,async()=>{
  const image={name:'google.png',content:Buffer.from('test')};const f=fixture({catalog,artifact:image});await assert.rejects(f.run(),/thumbnail_source_not_found/);f.files.push('google.png');assert.equal(await f.run(),image);assert.equal(f.calls.filter(x=>x==='list').length,2);
 });
 test('a listed file disappearing during the read still falls through to another existing source'+mode,async()=>{
  const f=fixture({catalog,files:['google.png','azure.png']});await assert.rejects(f.run({source:'google.png'}),/thumbnail_source_not_found/);assert.deepEqual(f.calls,['manifest','list','get:google.png','get:azure.png']);
 });
}
test('without catalog reads a cached requested thumbnail needs no storage listing or download',async()=>{
 const image={image:true};const f=fixture({cache:{'google.png':image}});assert.equal(await f.run({source:'google.png'}),image);assert.deepEqual(f.calls,['manifest']);
});
