import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const ts=createRequire(import.meta.url)('typescript');
const api=fs.readFileSync(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const source=api.slice(api.indexOf('async function sendProjectThumbnail('),api.indexOf('async function readProjectArtifactFile('));
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({files=[],cache={},fail='',artifact=null}={}){
 const calls=[];const reply={header(){return reply;}};
 const ctx=vm.createContext({clampThumbnailWidth:()=>320,
  readManifest:async()=>{calls.push('manifest');if(fail==='access')throw Error('denied');},
  thumbnailCachePath:(id,source)=>source,
  readCachedThumbnail:async path=>cache[path]||null,
  listProjectFiles:async()=>{calls.push('list');if(fail==='list')throw Error('SlowDown');return files.map(name=>({name}));},
  readProjectArtifactFile:async(id,source)=>{calls.push('get:'+source);return artifact;},
  sendArtifactContent:(value)=>value,
  badRequest:(code)=>Error(code)
 },{importModuleDynamically:async()=>{throw Error('sharp unavailable in test');}});
 vm.runInContext(js,ctx);return {calls,files,run:q=>ctx.sendProjectThumbnail('project',q||{},reply)};
}
test('missing thumbnail makes one listing and no speculative image GETs',async()=>{
 const f=fixture();await assert.rejects(f.run(),/thumbnail_source_not_found/);assert.deepEqual(f.calls,['manifest','list']);
});
test('cached requested thumbnail needs no storage listing or download',async()=>{
 const image={image:true};const f=fixture({cache:{'google.png':image}});assert.equal(await f.run({source:'google.png'}),image);assert.deepEqual(f.calls,['manifest']);
});
test('cached fallback skips missing candidates with one listing and no downloads',async()=>{
 const image={image:true};const f=fixture({files:['google.png'],cache:{'google.png':image}});assert.equal(await f.run(),image);assert.deepEqual(f.calls,['manifest','list']);
});
test('only existing source files are downloaded and existing sharp fallback is retained',async()=>{
 const image={name:'azure.png',content:Buffer.from('test')};const f=fixture({files:['azure.png'],artifact:image});assert.equal(await f.run(),image);assert.deepEqual(f.calls,['manifest','list','get:azure.png']);
});
test('access and listing failures stop further storage fanout',async()=>{
 for(const fail of ['access','list']){const f=fixture({fail});await assert.rejects(f.run(),fail==='access'?/denied/:/SlowDown/);assert.deepEqual(f.calls,fail==='access'?['manifest']:['manifest','list']);}
});
test('missing-image result is not cached; newly created images are discovered next request',async()=>{
 const image={name:'google.png',content:Buffer.from('test')};const f=fixture({artifact:image});await assert.rejects(f.run(),/thumbnail_source_not_found/);f.files.push('google.png');assert.equal(await f.run(),image);assert.equal(f.calls.filter(x=>x==='list').length,2);
});
test('a listed file disappearing during the read still falls through to another existing source',async()=>{
 const f=fixture({files:['google.png','azure.png']});await assert.rejects(f.run({source:'google.png'}),/thumbnail_source_not_found/);assert.deepEqual(f.calls,['manifest','list','get:google.png','get:azure.png']);
});
