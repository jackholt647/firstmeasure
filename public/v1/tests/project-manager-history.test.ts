import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../measure/internal/portal_scripts/projects.js',import.meta.url),'utf8');
const start=source.indexOf('        // ── Work History Timeline');
const end=source.indexOf('        // ── Submission Sources',start);
assert.ok(start>0 && end>start);
const esc=(s:unknown)=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function render(events:unknown[]){
 const context=vm.createContext({workHistory:events,m:{},html:'',canSeeRefundDetails:true,esc,safeParseTs:Date.parse,fmtLocalShort:(x:string)=>x,buildStageBarHtml:()=>''});
 return vm.runInContext(source.slice(start,end)+';html;',context) as string;
}
test('project history shows manager name or email, with HTML escaped',()=>{
 const named=render([{event:'manager_approved',manager_name:'Manager <One>',manager_email:'manager@example.test',ts:'2026-09-17'}]);
 assert.match(named,/Manager approved/);assert.match(named,/Manager &lt;One&gt;/);assert.doesNotMatch(named,/<One>/);
 assert.match(render([{event:'manager_approved',manager_email:'manager@example.test'}]),/manager@example.test/);
});
test('QA attribution remains separate and missing manager identity is not invented',()=>{
 const result=render([{event:'qa_approved',qa_name:'QA Person'},{event:'manager_approved'}]);
 assert.equal((result.match(/QA Person/g)||[]).length,1);assert.match(result,/Manager approved/);
});
