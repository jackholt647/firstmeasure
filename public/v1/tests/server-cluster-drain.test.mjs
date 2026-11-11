import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {serverClusterFixture} from './helpers/server-cluster-fixture.mjs';

const fixture=()=>serverClusterFixture();
if(process.argv.includes('--build-fixture')) {
 await writeFile(process.argv[process.argv.indexOf('--build-fixture')+1],await fixture());
 process.exit(0);
}

test('real cluster survives duplicate termination signals, withdraws readiness, and drains in-flight requests', {skip:process.platform==='win32',timeout:20000}, async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'firstmeasure-drain-'));
 const script=path.join(dir,'server.mjs');
 await writeFile(script,process.env.SERVER_DRAIN_FIXTURE?await readFile(process.env.SERVER_DRAIN_FIXTURE):await fixture());
 const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe']});
 const ready=[];let output='';let errors='';
 child.stderr.on('data',value=>{errors+=value;});
 child.stdout.on('data',value=>{output+=value;for(const line of output.split('\n').slice(0,-1)){if(line.startsWith('TEST_READY ')){const row=JSON.parse(line.slice(11));if(!ready.some(x=>x.pid===row.pid))ready.push(row);}}});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  const deadline=Date.now()+8000;
  while(ready.length<2&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
  assert.equal(ready.length,2,errors+output);
  const base='http://127.0.0.1:'+ready[0].port;
  const request=fetch(base+'/slow').then(async r=>({status:r.status,text:await r.text()}));
  await new Promise(r=>setTimeout(r,100));
  const start=Date.now();
  child.kill('SIGTERM');
  await new Promise(r=>setTimeout(r,40));
  for(const row of ready)process.kill(row.pid,'SIGTERM');
  child.kill('SIGTERM');
  await new Promise(r=>setTimeout(r,80));
  assert.equal((await fetch(base+'/ready')).status,503,'readiness withdraws while server still drains');
  assert.deepEqual(await request,{status:200,text:'completed'});
  const result=await exited;
  assert.equal(result.code,0,errors);
  assert.ok(Date.now()-start>=900,'must wait for configured drain and active requests');
 }finally{
  if(child.exitCode===null)child.kill('SIGKILL');
  for(const row of ready){try{process.kill(row.pid,'SIGKILL');}catch{}}
  await rm(dir,{recursive:true,force:true});
 }
});
