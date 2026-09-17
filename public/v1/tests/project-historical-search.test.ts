import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('address searches include old reports but retain explicit dates and actor visibility',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'historical-search-'));
 const pgUrl=process.env.TEST_POSTGRES_URL;
 Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:pgUrl?'postgres':'sqlite',FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'fm'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PLATFORM_STORAGE_ROOT:path.join(root,'platform')});
 if(pgUrl)Object.assign(process.env,{DATABASE_URL:pgUrl,DATABASE_ADMIN_URL:pgUrl,POSTGRES_AUTO_MIGRATE:'true'});
 const {buildApp}=await import('../src/app.js');const index=await import('../firstmeasure/project_index.js');
 const app=await buildApp();await app.ready();
 try{
  const old=new Date(Date.now()-200*86400000).toISOString();
  for(const [id,email] of [['old-visible','tech@example.test'],['old-other','other@example.test']]){
   await index.upsertProjectIndex({id,schema_version:2,status:'completed',address:'2900 S Jefferson Ave, Springfield, MO 65807, USA',workflow:{assigned_to:{email}},timestamps:{created_at:old,updated_at:old,completed_at:old}} as any,{fileNames:['report.pdf']});
  }
  const query=async(extra:Record<string,unknown>={})=>{
   const response=await app.inject({method:'POST',url:'/v1/firstmeasure/projects/list',payload:{filter:'all',actor:{email:'admin@example.test',roles:['admin']},view:'card',...extra}});
   assert.equal(response.statusCode,200,response.body);return response.json();
  };
  assert.equal((await query()).pagination.total_count,0);
  const search='2900 S Jefferson Ave, Springfield, MO 65807, USA';
  const found=await query({search});assert.equal(found.pagination.total_count,2);assert.equal(found.activity_start,null);
  assert.equal((await query({search,activity_start:new Date(Date.now()-86400000).toISOString()})).pagination.total_count,0);
  const scoped=await query({search,filter:'mine',actor:{email:'tech@example.test',roles:['technician']}});
  assert.equal(scoped.pagination.total_count,1);assert.equal(scoped.projects[0].id,'old-visible');
 }finally{await app.close();await index.closeFirstMeasureProjectIndex();if(pgUrl)await(await import('../src/database/postgres.js')).closePostgresPools();await rm(root,{recursive:true,force:true,maxRetries:3});}
});
