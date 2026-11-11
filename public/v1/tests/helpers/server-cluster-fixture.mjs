// src/server.ts with its imports replaced by stubs: a real node:cluster primary and workers
// around a plain HTTP server (tests/server-cluster-drain.test.mjs, tests/server-rolling-replace.test.mjs).
import {readFile} from 'node:fs/promises';

export async function serverClusterFixture(settings={}) {
 const source=await readFile(new URL('../../src/server.ts',import.meta.url),'utf8');
 const ts=(await import('typescript')).default;
 const body=source.replace(/^import .*;\r?$/gm,'')
  .replace('await import("./app.js")','({buildApp:buildTestApp})')
  .replace('await import("./worker_warmup.js")','({warmWorker:warmTestWorker})');
 const compiled=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const env={isProduction:true,webWorkers:2,firstmeasureDatabaseMode:'postgres',deploymentTopology:'cluster',rollingDrainMs:900,host:'127.0.0.1',port:0,webWorkerHeartbeatIntervalMs:100,webWorkerStartupTimeoutMs:5000,webWorkerHeartbeatTimeoutMs:5000,webWorkerCrashWindowMs:10000,webWorkerCrashLimit:4,webWorkerRestartBaseDelayMs:100,webWorkerRestartMaxDelayMs:500,webWorkerWarmupConnections:4,...settings};
 return `import cluster from 'node:cluster';
import http from 'node:http';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {Server} from 'node:net';
import {availableParallelism} from 'node:os';
import path from 'node:path';
const env={...${JSON.stringify(env)},releaseId:process.env.RELEASE_ID||'development',webWorkerReleaseDir:process.env.V1_ROLLING_RELEASE_DIR||''};
let draining=false;
function validateRuntimeTopology(){}
function beginRuntimeDrain(){draining=true;}
function takeClusterWorkerSlot(slots,id){const slot=slots.get(id)||1;slots.delete(id);return slot;}
async function warmTestWorker(){console.log('TEST_WARMED '+process.pid);}
async function buildTestApp(){
 if(process.env.TEST_FAIL_START==='1')throw new Error('broken release');
 const server=http.createServer(async(req,res)=>{
  if(req.url==='/slow'){await new Promise(r=>setTimeout(r,1400));res.end('completed');return;}
  if(req.url==='/release'){await new Promise(r=>setTimeout(r,5));res.end(env.releaseId+' '+process.pid);return;}
  res.statusCode=draining?503:200;res.end('ready');
 });
 return {server,log:{info(){},warn(){},error:console.error},listen:({host,port})=>new Promise(resolve=>server.listen(port,host,()=>{console.log('TEST_READY '+JSON.stringify({pid:process.pid,port:server.address().port,release:env.releaseId}));resolve();})),close:()=>new Promise(resolve=>{server.close(()=>resolve());server.closeIdleConnections();})};
}
`+compiled;
}
