import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function fixture() {
 const source=await readFile(new URL('../src/server.ts',import.meta.url),'utf8');
 const ts=(await import('typescript')).default;
 const compiled=ts.transpileModule(source.replace(/^import .*;\r?$/gm,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 return `import cluster from 'node:cluster';
import http from 'node:http';
import {availableParallelism} from 'node:os';
const env={isProduction:true,webWorkers:2,firstmeasureDatabaseMode:'postgres',deploymentTopology:'cluster',rollingDrainMs:900,host:'127.0.0.1',port:0,webWorkerHeartbeatIntervalMs:100,webWorkerStartupTimeoutMs:5000,webWorkerHeartbeatTimeoutMs:5000,webWorkerCrashWindowMs:10000,webWorkerCrashLimit:4,webWorkerRestartBaseDelayMs:100,webWorkerRestartMaxDelayMs:500};
let draining=false;
function validateRuntimeTopology(){}
function beginRuntimeDrain(){draining=true;}
function takeClusterWorkerSlot(slots,id){const slot=slots.get(id)||1;slots.delete(id);return slot;}
async function buildApp(){
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/slow'){await new Promise(r=>setTimeout(r,1400));res.end('completed');return;}
  res.statusCode=draining?503:200;res.end('ready');
 });
 return {log:{info(){},error:console.error},listen:({host,port})=>new Promise(resolve=>server.listen(port,host,()=>{console.log('TEST_READY '+JSON.stringify({pid:process.pid,port:server.address().port}));resolve();})),close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
`+compiled;
}
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
