// FM-389: SIGHUP to the cluster primary replaces its workers one at a time from the release
// `current` points at, warming each before it listens, so a compatibility release never has
// zero warm workers. Runs the real src/server.ts primary (tests/helpers/server-cluster-fixture.mjs).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, rm, symlink, rename, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {serverClusterFixture} from './helpers/server-cluster-fixture.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function release(root,name,extra=''){
 const dir=path.join(root,'releases',name,'public','v1');
 await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,'server.mjs'),await serverClusterFixture());
 await writeFile(path.join(root,'releases',name,'release.env'),`RELEASE_ID=release-${name}\n${extra}`);
}

async function point(root,name){
 const next=path.join(root,'current.next');
 await symlink(path.join(root,'releases',name),next);
 await rename(next,path.join(root,'current'));
}

function startPrimary(root){
 const child=spawn(process.execPath,['server.mjs'],{
  cwd:path.join(root,'current','public','v1'),
  env:{...process.env,RELEASE_ID:'release-a',V1_ROLLING_RELEASE_DIR:path.join(root,'current','public','v1')},
  stdio:['ignore','pipe','pipe']
 });
 const state={child,output:'',errors:'',ready:[]};
 child.stdout.on('data',value=>{
  state.output+=value;
  for(const line of String(value).split('\n'))if(line.startsWith('TEST_READY '))state.ready.push(JSON.parse(line.slice(11)));
 });
 child.stderr.on('data',value=>{state.errors+=value;});
 return state;
}

async function until(check,ms,what){
 const deadline=Date.now()+ms;
 while(Date.now()<deadline){if(check())return;await sleep(25);}
 throw new Error('timed out waiting for '+what);
}

// Keep-alive load (fetch reuses connections) like the web nodes' proxy to compatibility.
function load(base,concurrency){
 const results={ok:0,bad:[],releases:new Set()};
 let running=true;
 const loops=Array.from({length:concurrency},async(_,index)=>{
  while(running){
   try{
    const response=await fetch(base+(index===0?'/slow':'/release'));
    const text=await response.text();
    if(response.status===200){results.ok++;if(index)results.releases.add(text.split(' ')[0]);}
    else results.bad.push(response.status+' '+text);
   }catch(error){results.bad.push(String(error.cause?.code||error.message));}
  }
 });
 return {results,stop:async()=>{running=false;await Promise.all(loops);return results;}};
}

const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('SIGHUP replaces workers one at a time from the new release with no failed request, and a broken release changes nothing',{skip:process.platform==='win32',timeout:60000},async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'firstmeasure-rolling-'));
 await release(root,'a');await release(root,'b');await release(root,'c','TEST_FAIL_START=1\n');
 await point(root,'a');
 const primary=startPrimary(root);
 const exited=new Promise(resolve=>primary.child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  await until(()=>primary.ready.length>=2,8000,'two workers');
  const first=primary.ready.slice(0,2);
  assert.deepEqual(first.map(row=>row.release),['release-a','release-a']);
  const base='http://127.0.0.1:'+first[0].port;

  const traffic=load(base,6);
  await sleep(300);
  await point(root,'b');
  primary.child.kill('SIGHUP');
  await until(()=>primary.output.includes('rolling replace complete'),30000,'the rolling replace\n'+primary.output+primary.errors);
  await sleep(200);
  const during=await traffic.stop();
  assert.deepEqual(during.bad,[],'no request fails or is refused while workers are replaced');
  assert.ok(during.ok>50,'traffic flowed throughout: '+during.ok);
  assert.deepEqual([...during.releases].sort(),['release-a','release-b']);

  const replacements=primary.ready.slice(2);
  assert.deepEqual(replacements.map(row=>row.release),['release-b','release-b']);
  assert.equal(replacements[0].port,first[0].port,'the listening port is kept');
  for(const row of replacements)assert.ok(primary.output.includes('TEST_WARMED '+row.pid),'replacement warmed before it listened');
  // One at a time: the second replacement starts only after the first old worker retired.
  const log=primary.output;
  assert.ok(log.indexOf('slot 1 replaced')<log.indexOf('TEST_WARMED '+replacements[1].pid));
  await until(()=>first.every(row=>!alive(row.pid)),5000,'old workers to exit');
  assert.equal(primary.child.exitCode,null,'the primary keeps running');
  for(let i=0;i<20;i++){
   const text=await (await fetch(base+'/release')).text();
   assert.match(text,/^release-b /);
  }
  assert.doesNotMatch(primary.errors,/exited|missed/,'no worker crashed or was killed by the watchdog');

  // A release whose workers cannot start: the replace stops and every slot keeps release b.
  const traffic2=load(base,4);
  await point(root,'c');
  primary.child.kill('SIGHUP');
  await until(()=>primary.errors.includes('rolling replace failed'),20000,'the failed replace\n'+primary.output+primary.errors);
  await sleep(300);
  const broken=await traffic2.stop();
  assert.deepEqual(broken.bad,[]);
  assert.deepEqual([...broken.releases],['release-b']);
  assert.ok(replacements.every(row=>alive(row.pid)),'the working workers were never retired');

  // Back to a good release: a later SIGHUP replaces them again.
  await point(root,'a');
  primary.child.kill('SIGHUP');
  const before=primary.output.split('rolling replace complete').length;
  await until(()=>primary.output.split('rolling replace complete').length>before,30000,'the replace back to a');
  for(let i=0;i<10;i++)assert.match(await (await fetch(base+'/release')).text(),/^release-a /);

  primary.child.kill('SIGTERM');
  assert.equal((await exited).code,0,primary.errors);
 }finally{
  if(primary.child.exitCode===null)primary.child.kill('SIGKILL');
  for(const row of primary.ready){try{process.kill(row.pid,'SIGKILL');}catch{}}
  await rm(root,{recursive:true,force:true});
 }
});
