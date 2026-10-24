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

// A single board (or none) and a single department offer nothing to choose: no picker.
function fakeElement(tag='div'){
 const classes=new Set();const children=[];
 return {tag,children,innerHTML:'',style:{setProperty(){},},attrs:{},
  classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
  setAttribute(k,v){this.attrs[k]=v;},appendChild(child){children.push(child);},prepend(child){children.unshift(child);},addEventListener(){},contains:()=>false,querySelectorAll:()=>[]};
}
function summaryContext({ boards, departments=[], projects=[] }){
 const summary=fakeElement();
 const context=vm.createContext({
  workBoards:boards,allProjects:projects,activeWorkBoardId:'',viewMode:'stages',workDepartmentId:'',
  workDepartmentContext:{show_selector:departments.length>1,departments,department_label:'Department',departments_label:'Departments'},
  panelEl:{},$:(selector)=>selector==='#vWorkBoardSummary'?summary:null,escapeHtml:String,
  document:{createElement:fakeElement,addEventListener(){}},loadWorkBoards(){},selectWorkBoard(){},globalThis:{}
 });
 const from=(name)=>source.indexOf(`  function ${name}(`);
 vm.runInContext(source.slice(source.indexOf('  function workBoardProjectCount('),source.indexOf('  // Starts the active board\'s scope')),context);
 vm.runInContext(source.slice(from('workBoardOptionHtml'),from('workBoardStorageKey')),context);
 vm.runInContext(source.slice(from('renderWorkBoardSummary'),from('selectedBoardColumns')),context);
 return {context,summary};
}
const json=(code,context)=>JSON.parse(vm.runInContext(`JSON.stringify(${code})`,context));
const board=(id,projectIds=[])=>({id,title:id,color:'#2563eb',columns:[{id:`${id}-lead`,title:'Lead',cards:projectIds.map(project_id=>({project_id}))}]});
test('one configured board shows no board picker and keeps projects on no board beside its stages',()=>{
 const {context,summary}=summaryContext({boards:[board('sales',['p1'])],projects:[{id:'p1'},{id:'p2'}]});
 const boards=json('projectBoards()',context);
 assert.deepEqual(boards.map(item=>item.id),['sales']);
 assert.deepEqual(boards[0].columns.map(column=>[column.id,column.cards.map(card=>card.project_id)]),[['sales-lead',['p1']],['__no_board__',['p2']]]);
 assert.equal(vm.runInContext('workBoardPickerOffered()',context),false);
 vm.runInContext('renderWorkBoardSummary(projectBoards()[0], orderedWorkBoards())',context);
 assert.equal(summary.classList.contains('visible'),false);
 assert.doesNotMatch(summary.innerHTML,/v-board-trigger/);
 assert.equal(summary.children.length,0);
});
test('no configured board and an organization with every project on a board show no picker either',()=>{
 const none=summaryContext({boards:[],projects:[{id:'p1'}]});
 assert.deepEqual(json('projectBoards().map(item=>item.id)',none.context),['__no_board__']);
 vm.runInContext('renderWorkBoardSummary(projectBoards()[0], orderedWorkBoards())',none.context);
 assert.equal(none.summary.classList.contains('visible'),false);
 const all=summaryContext({boards:[board('sales',['p1'])],projects:[{id:'p1'}]});
 assert.deepEqual(json('projectBoards()[0].columns.map(column=>column.id)',all.context),['sales-lead']);
});
test('two configured boards show the picker and keep the No board catch-all as its own choice',()=>{
 const {context,summary}=summaryContext({boards:[board('sales',['p1']),board('production')],projects:[{id:'p1'},{id:'p2'}]});
 assert.deepEqual(json('projectBoards().map(item=>item.id)',context),['sales','production','__no_board__']);
 assert.equal(vm.runInContext('workBoardPickerOffered()',context),true);
 vm.runInContext('renderWorkBoardSummary(projectBoards()[0], orderedWorkBoards())',context);
 assert.equal(summary.classList.contains('visible'),true);
 assert.match(summary.innerHTML,/id="vWorkBoardTrigger"/);
});
test('one department shows no department picker; two show it, even beside a single board',()=>{
 const single=summaryContext({boards:[board('sales'),board('production')],departments:[{id:'d1',label:'Global'}]});
 single.context.workDepartmentContext.show_selector=true; // even if the server said so, one choice is no choice
 assert.equal(vm.runInContext('workDepartmentPickerOffered()',single.context),false);
 vm.runInContext('renderWorkBoardSummary(projectBoards()[0], orderedWorkBoards())',single.context);
 assert.equal(single.summary.children.some(child=>child.tag==='select'),false);
 const two=summaryContext({boards:[board('sales')],departments:[{id:'d1',label:'Sales'},{id:'d2',label:'Production'}]});
 vm.runInContext('renderWorkBoardSummary(projectBoards()[0], orderedWorkBoards())',two.context);
 assert.equal(two.summary.classList.contains('visible'),true);
 assert.doesNotMatch(two.summary.innerHTML,/v-board-trigger/);
 assert.equal(two.summary.children.filter(child=>child.tag==='select').length,1);
});
test('list and map never stay on All boards when there is only one board',()=>{
 assert.match(source,/value === 'all' && workBoardPickerOffered\(\) && \(viewMode === 'list' \|\| viewMode === 'map'\)/);
 assert.match(source,/preferredBoardId === 'all' && workBoardPickerOffered\(\)/);
 assert.equal(source.match(/const allBoards = activeWorkBoardId === 'all' && workBoardPickerOffered\(\);/g)?.length,2);
 assert.match(source,/workBoardsLoaded && workBoardSummaryOffered\(\)\)/);
});
