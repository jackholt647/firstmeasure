import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { customerExportBatch } from '../internal/customer_export.js';

test('export uses bounded ID cursors, includes test customers and excludes internal organization', () => {
  const orgs = Array.from({length:1003}, (_,i)=>({id:`org_${String(i).padStart(5,'0')}`,name:'Same name',is_test:i%2===0}));
  let cursor = '';const collected:string[]=[];
  do {
    const result=customerExportBatch([...orgs,{id:'internal',name:'Internal',is_test:false}],cursor,'internal');
    assert.ok(result.batch.length<=25);
    collected.push(...result.batch.map(row=>row.id));
    if(result.next_cursor===null)break;
    cursor=result.next_cursor;
    orgs.reverse(); // Storage ordering/renames must not change pagination.
  }while(true);
  assert.equal(collected.length,1003);assert.equal(new Set(collected).size,1003);
});

async function frontend(fetchPage:(body:any)=>Promise<any>) {
 const source=await readFile(new URL('../../measure/internal/portal_scripts/customers.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  async function fetchOrganizationsForExport('),source.indexOf('  async function exportUsersTsv('));
 const context=vm.createContext({window:{Portal:{apiPost:(_:any,body:any)=>fetchPage(body)}},apiServer:()=>'/v1/internal/legacy-action'});
 return vm.runInContext(`${code};fetchOrganizationsForExport`,context);
}
test('frontend exports every batch, reports progress, and does not request 1000-row dashboard summaries', async()=>{
 const orgs=Array.from({length:77},(_,i)=>({id:String(i).padStart(4,'0')}));let calls=0;
 const fetch=await frontend(async body=>{
   assert.equal(body.action,'customer_users_export_page');assert.equal(body.per_page,undefined);calls++;
   const {batch,next_cursor}=customerExportBatch(orgs,body.after,'internal');
   return {success:true,organizations:batch,next_cursor};
 });
 const progress:number[]=[];const result=await fetch((n:number)=>progress.push(n));
 assert.equal(result.length,77);assert.equal(calls,4);assert.deepEqual(progress,[25,50,75,77]);
});
test('frontend rejects failed, malformed and nonadvancing pages rather than downloading a partial TSV',async()=>{
 for(const response of [{success:false,error:'timeout'},{success:true,organizations:[]},{success:true,organizations:[],next_cursor:'next'}]){
  const fetch=await frontend(async()=>response);await assert.rejects(fetch());
 }
 let calls=0;const fetch=await frontend(async()=>++calls===1?{success:true,organizations:[{id:'a'}],next_cursor:'a'}:{success:false,error:'timeout'});
 await assert.rejects(fetch(),/timeout/);
});

test('real export action preserves customer fields and never uses dashboard minimum page size',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'customer-export-'));
 const pgUrl=process.env.TEST_POSTGRES_URL;
 Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:pgUrl?'postgres':'sqlite',FIRSTMEASURE_JOB_WORKERS:'0',PLATFORM_HEARTBEAT_DISABLED:'1',FIRSTMEASURE_STORAGE_ROOT:path.join(root,'fm'),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,'index.sqlite'),INTERNAL_STORAGE_ROOT:path.join(root,'internal'),PLATFORM_STORAGE_ROOT:path.join(root,'platform')});
 if(pgUrl)Object.assign(process.env,{DATABASE_URL:pgUrl,DATABASE_ADMIN_URL:pgUrl,POSTGRES_AUTO_MIGRATE:'true',POSTGRES_POOL_MAX:'1'});
 const storage=await import('../platform/storage.js');const {buildApp}=await import('../src/app.js');
 const app=await buildApp();await app.ready();
 let lock:any;
 try{
  for(let i=0;i<27;i++){
   const org=await storage.createOrganization({name:`Export ${i}`});
   await storage.upsertDocument(org.id,'users',{id:'user',data:{name:'Customer',email:`customer${i}@example.test`,org_permission_level:'super_admin'}});
   await storage.saveGlobal(org.id,{data:{credits_balance:42,contact:{email:'billing@example.test'},credits_ledger:Array.from({length:i===0?1001:1},()=>({delta:42,reason:'fixture',ts:'2026-09-01'}))}});
  }
  if(pgUrl){
   const {default:pg}=await import('pg');lock=new pg.Client({connectionString:pgUrl});await lock.connect();
   await lock.query('BEGIN');await lock.query("SELECT document FROM platform_documents WHERE collection='global' FOR UPDATE");
  }
  const page=async(after='')=>(await app.inject({method:'POST',url:'/v1/internal/legacy-action',headers:{'x-internal-user-email':'admin@example.test'},payload:{action:'customer_users_export_page',after}})).json();
  const first=await page();assert.equal(first.success,true);assert.equal(first.organizations.length,25);assert.ok(first.next_cursor);
  const next=await page(first.next_cursor);assert.equal(next.organizations.length,2);assert.equal(next.next_cursor,null);
  for(const row of [...first.organizations,...next.organizations]){
   assert.equal(row.users.length,1);assert.match(row.users[0].email,/^customer\d+@example.test$/);assert.equal(row.credits_balance,42);assert.equal(row.contact.email,'billing@example.test');assert.equal(row.latest_credit_entry.reason,'fixture');
  }
  let cursor:any=null;const exported:string[]=[];
  do{
   const result=(await app.inject({method:'POST',url:'/v1/internal/legacy-action',headers:{'x-internal-user-email':'admin@example.test'},payload:{action:'customer_credit_export_page',cursor}})).json();
   assert.equal(result.success,true);assert.ok(result.rows.length<=500);
   exported.push(...result.rows.map((row:any)=>`${row.organization_id}:${row.ledger_ordinal}`));cursor=result.next_cursor;
  }while(cursor);
  assert.equal(exported.length,1027);assert.equal(new Set(exported).size,1027);
 }finally{if(lock){await lock.query('ROLLBACK');await lock.end();}await app.close();await(await import('../firstmeasure/project_index.js')).closeFirstMeasureProjectIndex();if(pgUrl)await(await import('../src/database/postgres.js')).closePostgresPools();await rm(root,{recursive:true,force:true,maxRetries:3});}
});
