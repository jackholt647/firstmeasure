import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const databaseUrl=process.env.TEST_POSTGRES_URL;

test('organization department adoption and updates reject concurrent PostgreSQL writes', {skip:!databaseUrl},async t=>{
  Object.assign(process.env,{FIRSTMATE_ENV:'test',FIRSTMEASURE_DATABASE_MODE:'postgres',DATABASE_URL:databaseUrl,POSTGRES_POOL_MAX:'4',POSTGRES_AUTO_MIGRATE:'false',FIRSTMEASURE_ARTIFACT_STORAGE:'local'});
  t.after(async()=>{
    await (await import('../platform/sql_store.js')).closeSqlStoresForTests();
    await (await import('../src/database/postgres.js')).closePostgresPools();
  });
  const storage=await import('../platform/storage.js');
  const departments=await import('../workforce/departments.js');
  const orgId=`departments_${randomUUID().replaceAll('-','')}`;
  await storage.createOrganization({id:orgId,name:'Department concurrency test'});
  const ctx={orgId,userId:'owner',branchId:'default',role:'member',permissions:{manage_company_settings:true}} as any;
  const initial=await departments.readOrganizationDepartments(orgId);
  const creates=await Promise.allSettled([departments.saveDepartmentSettings(ctx,initial),departments.saveDepartmentSettings(ctx,initial)]);
  assert.equal(creates.filter(r=>r.status==='fulfilled').length,1);
  const saved=await departments.readOrganizationDepartments(orgId);
  assert.equal(saved.revision,1);
  const updates=await Promise.allSettled(['First edit','Second edit'].map(label=>departments.saveDepartmentSettings(ctx,{...saved,departments:saved.departments.map((row,index)=>index?row:{...row,label})})));
  assert.equal(updates.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await departments.readOrganizationDepartments(orgId)).revision,2);
});
