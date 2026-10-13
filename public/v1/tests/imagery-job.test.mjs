import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const source=await readFile(new URL('../firstmeasure/api.ts',import.meta.url),'utf8');
const compile=code=>ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
test('durable imagery job retries transient failures, preserves terminal projects and records permanent failures',async()=>{
  const start=source.indexOf('  registerFirstMeasureJobHandler("imagery.process",');
  const code=compile(source.slice(start,source.indexOf('  registerFirstMeasureJobHandler("pdf.sync",',start)));
  let handler,status='queued',failure=null,processed=0;const patches=[];
  const context=vm.createContext({registerFirstMeasureJobHandler:(_type,fn)=>handler=fn,asRecord:x=>x||{},
    readManifest:async()=>({status}),patchManifest:async(_id,patch)=>patches.push(patch),
    imageryFailurePatch:e=>({retryable:e.transient}),isTransientProviderFailure:e=>e.transient,
    processProjectImagery:async()=>{processed++;if(failure)throw failure;},runBackgroundImageryProcess:async()=>{if(failure)throw failure;}
  });
  vm.runInContext(code,context);
  assert.equal((await handler({payload:{project_id:'a',input:{}}})).processed,true);
  failure=Object.assign(new Error('SlowDown'),{transient:true});
  await assert.rejects(handler({payload:{project_id:'a'}}),/SlowDown/);assert.equal(patches.at(-1).retryable,true);
  failure=new Error('permanent');assert.equal((await handler({payload:{project_id:'a'}})).needs_attention,true);
  status='cancelled';const before=processed;assert.equal((await handler({payload:{project_id:'a'}})).skipped,true);assert.equal(processed,before);
});
test('enqueue stores only processing inputs and acceptance never loads storage detail',async()=>{
  const start=source.indexOf('async function acceptedImageryProject(');
  const code=compile(source.slice(start,source.indexOf('async function runBackgroundImageryProcess(',start)));
  let queued;
  const context=vm.createContext({asRecord:x=>x||{},readManifest:async()=>({id:'a'}),enqueueFirstMeasureJob:async(type,payload,options)=>{queued={type,payload,options};return 'job';}});
  vm.runInContext(code,context);
  await context.enqueueImageryProcess('a',{address:'test',google_api_key:'never-store',authorization:'never-store'});
  assert.equal(queued.type,'imagery.process');assert.equal(queued.options.maxAttempts,5);
  assert.equal('google_api_key' in queued.payload.input,false);assert.equal('authorization' in queued.payload.input,false);
  assert.equal((await context.acceptedImageryProject('a')).summary_only,true);
});
