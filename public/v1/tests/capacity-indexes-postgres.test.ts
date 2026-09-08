import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const url=String(process.env.TEST_POSTGRES_URL??'');
test('capacity indexes preserve filter results and support both selective query paths',{skip:!url},async()=>{
 const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.pathname,'/firstmeasure_test');
 const client=new pg.Client({connectionString:url});await client.connect();
 try {
  await client.query('CREATE TABLE projects (id text,issuer_email text,owner_email text,assigned_to_email text,organization_id text,sort_ts bigint,updated_at_ms bigint)');
  await client.query('CREATE TABLE platform_documents (organization_id text,id text,collection text,document jsonb)');
  await client.query(`INSERT INTO projects SELECT n::text,'issuer-'||n,'owner-'||n,'staff-'||n,'org-'||n,n,n FROM generate_series(1,20000)n`);
  await client.query(`CREATE INDEX owner_idx ON projects(owner_email);CREATE INDEX assigned_idx ON projects(assigned_to_email);CREATE INDEX org_idx ON projects(organization_id)`);
  await client.query(`INSERT INTO platform_documents SELECT 'org',n::text,'projects','{"data":{"events":[]}}'::jsonb FROM generate_series(1,20000)n`);
  await client.query(`INSERT INTO platform_documents VALUES ('org','event','projects','{"data":{"events":[{}]}}'),('org','object','projects','{"data":{"events":{}}}'),('org','missing','projects','{}'),('org','wrong','customers','{"data":{"events":[{}]}}')`);
  const sql=await readFile(new URL('../../../deploy/digitalocean/dev-capacity-indexes-20260907.sql',import.meta.url),'utf8');
  for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(x=>x.trim()).filter(Boolean))await client.query(statement);
  await client.query('ANALYZE projects');await client.query('ANALYZE platform_documents');
  const query="SELECT id FROM projects WHERE organization_id='none' OR owner_email='none' OR issuer_email='issuer-100' OR assigned_to_email='none'";
  assert.deepEqual((await client.query(query)).rows,[{id:'100'}]);
  const plan=await client.query('EXPLAIN (FORMAT JSON) '+query);assert.match(JSON.stringify(plan.rows),/idx_projects_issuer_email_sort/);assert.doesNotMatch(JSON.stringify(plan.rows),/Seq Scan/);
  const {PROJECT_EVENT_BATCH_SQL}=await import('../platform/heartbeat_postgres.js');
  assert.deepEqual((await client.query(PROJECT_EVENT_BATCH_SQL,['',''])).rows.map(x=>x.id),['event']);
  const eventPlan=await client.query('EXPLAIN (FORMAT JSON) '+PROJECT_EVENT_BATCH_SQL,['','']);assert.match(JSON.stringify(eventPlan.rows),/platform_documents_project_events_idx/);
 }finally{await client.end();}
});
