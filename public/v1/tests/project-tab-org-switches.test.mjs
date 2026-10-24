// The Project tab follows what the organization has turned on: no Equipment app means no equipment column, no
// "add an equipment list" and no equipment anywhere in the lists UI (a list kept from before is read-only), and no
// groups of users (and no outside company) means a work order is a plain list of labor line items added by hand.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source = await readFile(new URL('../../libraries/apps/materials/project.js',import.meta.url),'utf8');
function fn(name) {
  const start=source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start>=0,name); return source.slice(start,source.indexOf('\n  }',start)+4);
}
const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const cleanText=value=>String(value??'').trim();
const flags=values=>({current:()=>values,has:(group,name)=>values?.[group]?.[name]===true,value:(group,name,fallback)=>values?.[group]?.[name]??fallback});
const categories=(...ids)=>ids.map(id=>({id,name:{material:'Materials',labor:'Labor',equipment:'Equipment'}[id],icon:'fa-box',color:'#123456'}));

function context({types=['material','labor','equipment'],appFlags={apps:{crew:true}},lists=[],crews=[]}={}){
  const ctx={state:{lists,resourceTypes:categories(...types),crews,visibleListIds:new Set(lists.map(list=>list.id)),minimizedTypes:new Set(),collapsedListIds:new Set(),schedulingListId:'',laborMenu:null},
    rootWindow:{Portal:{appFlags:flags(appFlags)}},window:{},cleanText,escapeHtml,number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,money:value=>'$'+value,
    resourceCategories:()=>ctx.state.resourceTypes,resourceType:list=>list?.resource_type||'material',listItems:list=>list?.current_items||[],materialListById:id=>lists.find(list=>list.id===id),
    resourceTerms:type=>({plural:{material:'Materials',labor:'Labor',equipment:'Equipment'}[type],singular:{material:'Material',labor:'Labor item',equipment:'Equipment item'}[type]}),
    assignmentWorkResourceRef:list=>list?.assignment?.work_resource_ref||null,laborListFinalized:()=>null,laborSettings:list=>({id:list.id,resource:list?.assignment?.work_resource_ref||null}),
    materialListOrdered:()=>false,resourceScheduleEnabled:()=>true,workOrderActions:()=>[],projectId:()=>'p1',minimizeIdleWorkOrder:()=>false,workOrderMerged:()=>ctx.state.resourceTypes.some(row=>row.id==='labor'),
    filteredItems:()=>lists.flatMap(list=>(list.current_items||[]).map(item=>({...item,__material_list_id:list.id}))),lineSectionKey:item=>item.section,
    materialSectionDefinitions:()=>['material','labor','equipment'].map(type=>({key:type,resource_type:type})),
    renderMaterialSection:(section,rows)=>`<section class="mt-section">${rows.map(row=>`<div data-row>${row.name}</div>`).join('')}</section>`,
    renderAssignBlock:list=>`<div class="mt-assign-block" data-mt-assign-block="${list.id}"></div>`,listProjected:()=>0,categoryProjected:()=>0,projectedDelivery:()=>({available:false}),renderRequirementsTray:()=>''};
  vm.createContext(ctx);
  for(const name of ['equipmentOn','equipmentListRetired','groupsOn','laborAssignmentOn','workResourcesForScopeList','renderListHeaderActions','renderLaborListControls','renderMaterialSections','requirementKind'])vm.runInContext(fn(name),ctx);
  return ctx;
}

test('with the Equipment app off the work order column offers no equipment list and a kept equipment list is read-only', () => {
  const equipment={id:'eq',resource_type:'equipment',title:'Roofing Equipment',current_items:[{id:'t',name:'Truck',section:'equipment'}]};
  const on=context({lists:[equipment]});
  assert.equal(on.equipmentOn(),true);assert.equal(on.equipmentListRetired(equipment),false);
  let html=on.renderMaterialSections();
  assert.match(html,/data-mt-new-category-list="equipment"/,'with it on, an equipment list can be added');
  assert.doesNotMatch(html,/is-retired/);assert.match(html,/data-mt-add-section="equipment" data-mt-list-id="eq"/);
  // Off: the server sends no equipment column, so the tab has none of it.
  const off=context({types:['material','labor'],lists:[equipment]});
  assert.equal(off.equipmentOn(),false);assert.equal(off.equipmentListRetired(equipment),true);
  html=off.renderMaterialSections();
  assert.doesNotMatch(html,/data-mt-new-category-list="equipment"/,'no "add an equipment list"');
  assert.doesNotMatch(html,/data-resource-type="equipment"/,'no equipment column');
  assert.match(html,/class="mt-list-pane is-retired" data-mt-pane-list="eq"/,'the kept list still shows, in the work order column');
  assert.match(html,/data-mt-list-name="eq"[^>]*readonly/);assert.match(html,/data-mt-retired-note/);assert.match(html,/Truck/,'its lines are still readable');
  assert.doesNotMatch(html,/data-mt-add-section="equipment"/,'nothing can be added to it');
  const actions=off.renderListHeaderActions(equipment,'equipment','');
  assert.doesNotMatch(actions,/data-mt-list-schedule/);assert.match(actions,/data-mt-delete-list="eq"/,'it can still be removed');
  // A requirement that equipment would meet is shown as the work order's instead.
  assert.equal(off.requirementKind({kind:'function'}).type,'labor');assert.equal(on.requirementKind({kind:'function'}).type,'equipment');
  // Nothing else in the tab offers equipment: the Reserve Equipment action, the equipment line item source and the fix-all step.
  assert.match(source,/!schedulingOn\(\)\|\|!equipmentOn\(\)\?'':action\('equipment'/);
  assert.match(source,/LINE_ITEM_SOURCE_DEFS\.filter\(\(source\) => source\.id !== 'equipment' \|\| equipmentOn\(\)\)/);
  assert.match(source,/sources\.includes\('equipment'\) && equipmentOn\(\)/);
  assert.match(source,/openFunctions\.length && equipmentOn\(\)/);
});

test('with groups off and no outside company a work order is a plain list of line items with no assignment', () => {
  const labor={id:'wo',resource_type:'labor',title:'',metadata:{},current_items:[]};
  const groupsOff={apps:{crew:false}};
  const plain=context({appFlags:groupsOff,lists:[labor],crews:[{id:'g1',name:'Crew A',resource_kind:'resource_group'}]});
  assert.equal(plain.groupsOn(),false);assert.equal(plain.laborAssignmentOn(),false);
  assert.deepEqual(plain.workResourcesForScopeList(labor).map(row=>row.id),[],'a group left behind is not offered while groups are off');
  assert.equal(plain.renderLaborListControls(labor,{bare:true}),'','no assignee control');
  assert.equal(plain.renderLaborListControls(labor),'');
  let actions=plain.renderListHeaderActions({...labor,assignment:{work_resource_ref:{id:'g1',name:'Crew A'}}},'labor','');
  assert.doesNotMatch(actions,/data-mt-labor-generate|data-mt-labor-more/,'no pay sheet generation and no pay out');
  assert.match(actions,/data-mt-delete-list="wo"/);
  let html=plain.renderMaterialSections();
  assert.doesNotMatch(html,/data-mt-assign-block|data-mt-labor-menu/,'no assignment block, even on an empty work order');
  assert.match(html,/<div class="mt-empty">Empty List<\/div><button type="button" class="mt-resource-add mt-list-add-item" data-mt-add-section="labor" data-mt-list-id="wo">\+ Add labor item<\/button>/,'lines are added by hand, like materials');
  // A project with no work order yet asks nothing either: the column offers its Add.
  const empty=context({appFlags:groupsOff});
  html=empty.renderMaterialSections();
  assert.doesNotMatch(html,/data-mt-assign-block/);assert.match(html,/data-mt-add-section="labor">\+ Add labor item/);
  // An outside company is still an assignee with groups off, and only it is offered.
  const partner=context({appFlags:groupsOff,lists:[labor],crews:[{id:'g1',name:'Crew A',resource_kind:'resource_group'},{id:'sub',name:'Sub B',resource_kind:'organization_connection'}]});
  assert.equal(partner.laborAssignmentOn(),true);
  assert.deepEqual(partner.workResourcesForScopeList(labor).map(row=>row.id),['sub']);
  assert.match(partner.renderMaterialSections(),/data-mt-assign-block="wo"/);
  // Groups on: assignment as before, groups offered.
  const groups=context({lists:[labor],crews:[{id:'g1',name:'Crew A',resource_kind:'resource_group'}]});
  assert.equal(groups.laborAssignmentOn(),true);assert.deepEqual(groups.workResourcesForScopeList(labor).map(row=>row.id),['g1']);
  assert.match(groups.renderLaborListControls(labor,{bare:true}),/data-mt-labor-menu="wo"/);
  actions=groups.renderListHeaderActions({...labor,assignment:{work_resource_ref:{id:'g1',name:'Crew A'}}},'labor','');
  assert.match(actions,/data-mt-labor-generate="wo"/);assert.match(actions,/data-mt-labor-more="wo"/);
  // Flags not loaded yet change nothing.
  const unknown=context({appFlags:null});assert.equal(unknown.groupsOn(),true);
  // A work order paid out before groups were turned off still shows that, and can be reopened.
  plain.laborListFinalized=()=>({finalized_at:'2026-10-01T00:00:00Z'});
  assert.match(plain.renderLaborListControls(labor,{bare:true}),/To be paid/);
  assert.match(plain.renderListHeaderActions(labor,'labor',''),/data-mt-labor-more="wo"/);
  // Fix all assigns and builds from pay sheets only where a work order can be assigned.
  assert.match(source,/openWork\.length && laborAssignmentOn\(\)/);
  assert.match(source,/laborAssignmentOn\(\) && resourceType\(entry\) === 'labor' && assignmentWorkResourceRef\(entry\)\?\.id && !entry\.metadata\?\.labor_generation/);
});
