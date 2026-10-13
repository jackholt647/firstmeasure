import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source=await readFile(new URL('../../portal/scripts/core.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  const firstMeasureRefreshPages ='),source.indexOf('  async function listFirstMeasureProjectCandidates('));
test('browser applies only changed rows, removes deleted rows, isolates accounts and coalesces simultaneous refreshes',async()=>{
  let calls=0;
  const context=vm.createContext({Map,JSON,Error,fmPost:async(_route,payload)=>{
    calls++;
    if(!payload.cursor)return {refresh:{reset:true,cursor:'one',projects:[{id:'a',value:1},{id:'b',value:1}],order:['a','b'],removed:[]}};
    return {refresh:{reset:false,cursor:'two',projects:[{id:'b',value:2}],order:['b'],removed:['a']}};
  }});
  vm.runInContext(code,context);
  const result=await vm.runInContext("Promise.all([refreshFirstMeasurePage({actor:'a'}),refreshFirstMeasurePage({actor:'a'})])",context);
  assert.equal(calls,1);assert.equal(result[0].projects.length,2);
  const next=await vm.runInContext("refreshFirstMeasurePage({actor:'a'})",context);
  assert.equal(next.projects.length,1);assert.equal(next.projects[0].value,2);
  const other=await vm.runInContext("refreshFirstMeasurePage({actor:'b'})",context);
  assert.equal(other.projects.length,2);
});
