/** Repair the additive call-department table in an existing development database. */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

const apply=process.argv.includes('--apply');
const root=process.env.FIRSTMEASURE_RUNTIME_ROOT||'/opt/firstmeasure/current/public/v1';
if(process.argv.includes('--service-env')){
  const pid=execFileSync('systemctl',['show','firstmeasure-development-web.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
  if(!/^\d+$/.test(pid)||pid==='0')throw new Error('Development web service is not running.');
  for(const item of readFileSync(`/proc/${pid}/environ`,'utf8').split('\0')){
    const equals=item.indexOf('=');if(equals>0)process.env[item.slice(0,equals)]=item.slice(equals+1);
  }
}
if(process.env.FIRSTMEASURE_DATA_ENVIRONMENT!=='development')throw new Error('Refusing to run outside development data.');
process.chdir(root);
const {database}=await import(pathToFileURL(path.join(root,'dist/comms/calls/storage.js')).href);
const db=database();
if(!db.isPostgres)throw new Error('This repair targets the development PostgreSQL store.');
const relation=await db.prepare("SELECT to_regclass('customer_call_departments') AS name").get();
console.log(JSON.stringify({environment:'development',database:db.isPostgres?'postgres':'sqlite',existing:!!relation?.name,apply}));
if(apply){
  await db.exec('CREATE TABLE IF NOT EXISTS customer_call_departments (organization_id TEXT NOT NULL,call_id TEXT NOT NULL REFERENCES customer_calls(id),department_id TEXT NOT NULL,PRIMARY KEY(organization_id,call_id,department_id));');
  await db.exec('CREATE INDEX IF NOT EXISTS customer_call_departments_scope ON customer_call_departments(organization_id,department_id,call_id);');
  const check=await db.prepare("SELECT to_regclass('customer_call_departments') AS name").get();
  if(!check?.name)throw new Error('Schema repair not visible.');
  console.log(JSON.stringify({repaired:true,table:check.name}));
}
process.exit(0);
