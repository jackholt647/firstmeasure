import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../../libraries/apps/projects/viewer.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  function projectBoardsEnabled(){'),source.indexOf('  function fmtMoney('));
test('board flag overrides stale stages and movement flags but preserves list and tiles',()=>{
 let boards=false;
 const context=vm.createContext({VIEW_MODES:new Set(['tiles','list','stages']),window:{Portal:{appFlags:{value:(group,key)=>key==='project_boards'?boards:true}}}});
 vm.runInContext(functions,context);
 assert.equal(vm.runInContext("normalizeViewMode('stages')",context),'tiles');
 assert.equal(vm.runInContext('manualStageMovementEnabled()',context),false);
 for(const mode of ['list','tiles'])assert.equal(vm.runInContext(`normalizeViewMode('${mode}')`,context),mode);
 boards=true;
 assert.equal(vm.runInContext("normalizeViewMode('stages')",context),'stages');
 assert.equal(vm.runInContext('manualStageMovementEnabled()',context),true);
});
test('disabled boards render every visible project directly without waiting for boards',()=>{
 const rows=[];const scroll={appendChild:row=>rows.push(row)};
 const context=vm.createContext({projectBoardsEnabled:()=>false,filteredProjects:[{id:'assigned'},{id:'unassigned'}],panelEl:{},$:(selector)=>selector==='#vListScroll'?scroll:null,createListRow:p=>p.id});
 vm.runInContext(source.slice(source.indexOf('  function renderGroupedList(){'),source.indexOf('  function renderResults(){')),context);
 vm.runInContext('renderGroupedList()',context);
 assert.deepEqual(rows,['assigned','unassigned']);
});
