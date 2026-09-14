import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source=await readFile(new URL('../../measure/internal/portal_scripts/payroll.js',import.meta.url),'utf8');
function fn(name){const a=source.indexOf(`  function ${name}(`);assert.ok(a>=0);const b=source.slice(a+1).search(/\n  (?:async )?function /);return source.slice(a,b<0?undefined:a+1+b);}
test('daily export separates first/last tech and earliest QA start, preserving existing columns',()=>{
 const c=vm.createContext({employeeRankMap:()=>new Map(),projectPayTechnician:()=>({email:'payee@test'}),resolveProjectPoints:()=>3,collectionElapsedMs:()=>0,speedBandForElapsed:()=>({label:'standard'}),buildSpeedTimeline:()=>[],projectTimestamp:()=>null,projectQaReviewer:()=> 'qa@test',projectComplexityLevel:()=>3,projectQaKickbacks:()=>1,projectQaScore:()=>0,heightQualityPoints:()=>0,projectExpeditedLevel:()=>3});
 vm.runInContext(['parseProjectTimestamp','normalizeHistory','rawWorkHistory','exportTechnicianHistory','exportQaStartedAt','isoTimestamp','tsvCell','buildPayrollExportTsv'].map(fn).join('\n'),c);
 c.findClaimStartedAt=()=>null;
 c.projects=[{id:'fixture',work_history:[
  {event:'correction_submitted',ts:'2026-09-14T12:00:00Z',worker_email:'last@test'},
  {event:'qa_claimed',ts:'2026-09-14T13:00:00Z',qa_email:'qa@test'}],workflow:{history:[
  {event:'claimed_new',ts:'2026-09-14T08:00:00Z',actor:{email:'first@test'}},
  {event:'qa_claimed',ts:'2026-09-14T10:00:00Z',qa_email:'qa@test'}]}}];
 const [header,row]=vm.runInContext('buildPayrollExportTsv(projects,[])',c).split('\r\n').map(s=>s.split('\t'));
 const data=Object.fromEntries(header.map((key,i)=>[key,row[i]]));
 assert.equal(data.original_technician_user,'first@test');assert.equal(data.latest_technician_user,'last@test');
 assert.equal(data.qa_started_timestamp,'2026-09-14T10:00:00.000Z');assert.equal(data.technician_user,'payee@test');
 c.projects=[{id:'no-history'}];const empty=vm.runInContext('buildPayrollExportTsv(projects,[])',c).split('\r\n')[1].split('\t');
 assert.equal(empty[header.indexOf('original_technician_user')],'');assert.equal(empty[header.indexOf('qa_started_timestamp')],'');
});
