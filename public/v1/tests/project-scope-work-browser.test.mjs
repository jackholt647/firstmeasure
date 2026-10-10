import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium} from 'playwright-core';
const source = await readFile(new URL('../../libraries/apps/materials/project.js',import.meta.url),'utf8');
const helper = await readFile(new URL('../../libraries/apps/materials/scope-of-work.js',import.meta.url),'utf8');
const module = await import('data:text/javascript;base64,'+Buffer.from(helper).toString('base64'));
function fn(name) {
  const start=source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start>=0,name); return source.slice(start,source.indexOf('\n  }',start)+4);
}

test('only accepted artifact publishers and published measurement datasets appear', async () => {
  const calls=[];
  globalThis.window={PlatformAPI:{baseUrl:()=> 'https://fixture.test/v1/platform',request:async path=>{
    calls.push(path);
    if(path.includes('/calculus'))return {ledger:{sets:[
      {origin:{type:'document',document_id:'proposal',snapshot_id:'accepted'},title:'Roof materials',lines:[{name:'Shingles',quantity:12,unit:'bundle'}]},
      {origin:{type:'document',document_id:'draft',snapshot_id:'draft-snapshot'},lines:[]},
      {origin:{type:'scope'},lines:[]}
    ]}};
    if(path.includes('/snapshots'))return {snapshots:[{id:'accepted',title:'Roof proposal',resolved_definition:{computed_values:{contract_total_cents:1234500}}}]};
    return {documents:[{id:'proposal',title:'Roof proposal',status:'completed'},{id:'draft',status:'draft'},{id:'presentation',status:'completed'}]};
  },publication:{list:async()=>({items:[{id:'roof',name:'Roof report',type:'measurements',revision:'r1'},{id:'generic',type:'generic'}]}),read:async()=>({status:'ready',value:{measurements:{roofArea:{value:1400,unit:'ft2'}},artifacts:[]}})}}};
  try {
    const result=await module.loadDocuments('org','project');
    assert.deepEqual(result.documents.map(doc=>doc.id),['proposal:accepted','roof']);
    assert.equal(result.documents[0].total,'$12,345.00');
    assert.ok(calls.every(path=>!path.includes('document-modules')));
    const html=module.renderDocuments(result.documents);
    assert.match(html,/Roof proposal/);assert.match(html,/Roof report/);assert.match(html,/1,400/);assert.doesNotMatch(html,/draft|presentation|JSON/);
    assert.equal(result.error,'');
    window.PlatformAPI.request=async()=>{throw Error('denied')};window.PlatformAPI.publication.list=async()=>{throw Error('denied')};
    const denied=await module.loadDocuments('org','project');assert.equal(denied.documents.length,0);assert.match(denied.error,/could not load/);
  } finally {delete globalThis.window}
});

test('first Add creates only the requested resource list; later adds reuse it', async () => {
  for (const type of ['material','labor','equipment']) {
    const calls=[],state={lists:[],visibleListIds:new Set(),selectedSection:'all'};
    const ctx={state,performance,window:{},timingMark(){},cleanText:value=>String(value||''),
      destinationListForSection:()=>state.lists[0],resourceTypeForSection:section=>section==='accessories'?'material':section,
      resourceType:list=>list.resource_type,resourceTerms:()=>({singular:type,plural:type}),
      captureProjectOperation:()=>({orgId:'org',projectId:'project'}),projectOperationIsCurrent:()=>true,
      branchId:()=> 'branch',firstUnusedListColor:()=> '#123456',projectOrderSources:()=> [],
      updateMaterialListState:list=>{state.lists.push(list);return list},materialListById:id=>state.lists.find(x=>x.id===id),
      uid:()=> 'item'+calls.length,blankLine:()=> ({}),listItems:(list=state.activeList)=>list?.current_items||[],
      replaceListItems:(id,items)=>{state.lists.find(x=>x.id===id).current_items=items},
      setWorkspaceSaving(){},syncMaterialSection(){},syncMaterialsGrid(){},syncTopBar(){},syncFooterTotals(){},renderLeft(){},render(){},findByData(){},materialRoot(){},
      loadExpenseProjection:async()=>{},showToast(){},persistVersion:async patch=>calls.push(['add',patch.add_items[0].metadata.resource_type]),
      materialsAPI:{projects:{create:async(org,project,payload)=>{calls.push(['create',payload.resource_type]);return {material_list:{id:'list',...payload,current_items:[]}}}}}};
    vm.createContext(ctx);vm.runInContext(fn('addItem'),ctx);
    await ctx.addItem(null,type==='material'?'accessories':type);
    await ctx.addItem(null,type==='material'?'accessories':type);
    assert.deepEqual(calls,[['create',type],['add',type],['add',type]]);
    assert.equal(state.lists[0].current_items.length,2);
  }
});

test('completed reports predating dataset publication remain readable without an import', async () => {
  const calls=[];
  globalThis.window={PlatformAPI:{baseUrl:()=> '/v1/platform',request:async path=>path.includes('calculus')?{ledger:{sets:[]}}:{documents:[]},publication:{list:async()=>({items:[]}),read:async(org,source)=>{
    calls.push(source.export);return source.export==='report'?{status:'ready',value:{reportId:'completed-report'}}:{status:'ready',value:{rows:[{key:'roofArea',value:1200,unit:'ft2'},{key:'missing',value:'Pending',unit:'ft'}]}};
  }}}};
  try {
    const result=await module.loadDocuments('org','project');assert.deepEqual(calls,['report','measurements']);assert.equal(result.documents.length,1);assert.deepEqual(result.documents[0].value.measurements,{roofArea:{value:1200,unit:'ft2'}});assert.equal(result.error,'');
    window.PlatformAPI.publication.read=async()=>({status:'missing',code:'widget_report_unavailable'});const incomplete=await module.loadDocuments('org','project');assert.equal(incomplete.documents.length,0);
  }finally{delete globalThis.window;}
});

test('the project renderer mounts the compact published rail without requiring widget labels', () => {
  let mounted=false,divider=false;
  const target={querySelector(){},textContent:''};
  const ctx={performance,state:{active:true,lists:[],scopeDocuments:[],scopeDocumentsError:'',sidebarRoot:{classList:{add(){},remove(){}},querySelector:()=>null}},
    leftContentRoot:()=>target,orgId:()=> 'org',projectId:()=> 'project',timingMark(){},disposeScopeWidgets(){},scopeWidgetContext:()=>({fragments:{'scope.lists':()=>null}}),
    scopeWorkspace:{mountSidebar:(root,docs,error,key)=>{assert.equal(key,'org:project');mounted=true},installDivider:()=>divider=true}};
  vm.createContext(ctx);vm.runInContext(fn('renderLeft'),ctx);ctx.renderLeft();assert.ok(mounted&&divider);
});

test('failed creation does not persist an item and releases the saving state', async () => {
  let adds=0,saving=false;
  const state={selectedSection:'all'};
  const ctx={state,performance,timingMark(){},cleanText:String,destinationListForSection:()=>null,
    captureProjectOperation:()=>({orgId:'org',projectId:'project'}),projectOperationIsCurrent:()=>true,
    resourceTypeForSection:()=> 'labor',resourceTerms:()=>({plural:'Labor'}),branchId:()=> 'b',
    firstUnusedListColor:()=> '#123456',projectOrderSources:()=> [],setWorkspaceSaving:value=>saving=value,showToast(){},
    persistVersion:()=>adds++,materialsAPI:{projects:{create:async()=>{throw Error('denied')}}}};
  vm.createContext(ctx);vm.runInContext(fn('addItem'),ctx);
  await ctx.addItem(null,'labor');assert.equal(adds,0);assert.equal(saving,false);assert.equal(state.creatingList,false);
});

test('resource panes keep independent scroll, narrow empty columns, and a draggable split', async () => {
  const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url.includes('helper')?'text/javascript':'text/html');res.end(req.url.includes('helper')?helper:'<html><head></head><body></body></html>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1500,height:900}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(({css,render,helper})=>{
      window.state={lists:[],saving:false,loading:false};
      window.items=[];
      window.filteredItems=()=>window.items;
      window.resourceType=list=>list?.resource_type||'material';
      window.materialListById=id=>state.lists.find(list=>list.id===id);
      window.resourceTerms=type=>({plural:{material:'Materials',labor:'Labor',equipment:'Equipment'}[type],singular:type});
      window.escapeHtml=value=>String(value);
      window.materialSectionDefinitions=()=>['material','labor','equipment'].map(type=>({key:type,resource_type:type}));
      window.lineSectionKey=item=>item.section;
      window.renderMaterialSection=(section,rows)=>`<section class="mt-section">${rows.map(row=>`<div style="height:30px">${row.name}</div>`).join('')}</section>`;
      (0,eval)(css+'\n'+render);
      const style=document.createElement('style');style.textContent=window.css()+'.r-tab-content{display:flex;height:600px;width:1400px}.r-tab-main{flex:1;min-width:0}.mt-app{height:100%}';document.head.append(style);
      document.body.innerHTML='<div class="r-overlay materials-workspace"><div class="r-tab-content"><aside class="r-tab-sidebar mt-widget-sidebar"></aside><div class="r-tab-main"><div class="mt-app"><div class="mt-material-grid" data-mt-material-grid></div></div></div></div></div>';
      window.draw=()=>document.querySelector('[data-mt-material-grid]').innerHTML=renderMaterialSections();draw();
    },{css:fn('css'),render:fn('renderMaterialSections'),helper});
    await page.evaluate(async()=>{window.helper=await import('/helper.js');helper.installDivider(document.querySelector('aside'));
      window.FMDocModel={paperDimensions:()=>({w_pt:612})};window.FMDocRenderer={render:(root,options)=>{root.innerHTML='<p>Rendered accepted roof contract</p>';window.renderedSnapshot=options.document;return {destroy(){}};}};
      window.scopeDocs=[{id:'contract',title:'Roof contract',source:'document',document_type:'contract',total:'$12,345.00',snapshot:{resolved_definition:{id:'captured-definition'},widget_data:{}},sets:[{title:'Roof materials',lines:[{name:'Shingles',quantity:12,unit:'bundle',order_quantity:12,order_unit:'bundle'}]}]},{id:'report',title:'Roof report',source:'measurement',value:{measurements:{roofArea:{value:1400,unit:'ft2'}},artifacts:[{id:'report/pdf',kind:'firstmeasure.report'}]}}];
      helper.mountSidebar(document.querySelector('aside'),scopeDocs,'','org:project');
    });
    const tile=page.locator('[data-scope-document="contract"]');
    await tile.hover();assert.ok(await tile.getByRole('tooltip').isVisible());
    await page.locator('[data-scope-document="contract"]').click();
    await page.getByText('Rendered accepted roof contract').waitFor();
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>renderedSnapshot.id),'captured-definition');
    assert.ok(await page.locator('aside table').getByText('Shingles',{exact:true}).isVisible());
    await page.getByRole('button',{name:'Back',exact:false}).click();assert.ok(await tile.isVisible());
    await page.locator('[data-scope-document="report"]').click();assert.match(await page.locator('aside').innerText(),/1,400 ft2/);
    await page.getByRole('button',{name:'Back',exact:false}).click();
    assert.equal(await page.getByRole('tab').count(),3);assert.ok(await page.getByRole('tab',{name:'Scope of Work'}).isVisible());
    const widths=()=>page.locator('.mt-resource-column').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
    let w=await widths();assert.ok(Math.max(...w)-Math.min(...w)<2);assert.equal(await page.getByText('Empty List',{exact:true}).count(),3);
    await page.evaluate(()=>{state.lists=[{id:'m',resource_type:'material'},{id:'l',resource_type:'labor'}];items=Array.from({length:70},(_,i)=>({name:'Item '+i,section:i%2?'labor':'material',__material_list_id:i%2?'l':'m'}));draw()});
    w=await widths();assert.ok(w[0]>w[2]*2);assert.ok(w[1]>w[2]*2);
    await page.locator('.mt-resource-scroll').nth(0).evaluate(el=>el.scrollTop=200);
    assert.equal(await page.locator('.mt-resource-scroll').nth(1).evaluate(el=>el.scrollTop),0);
    assert.ok(await page.locator('.mt-resource-scroll').nth(0).evaluate(el=>el.scrollTop)>0);
    const divider=page.getByRole('separator',{name:'Resize project widgets and scope of work'});const box=await divider.boundingBox();
    await page.mouse.move(box.x+4,box.y+100);await page.mouse.down();await page.mouse.move(box.x+140,box.y+100);await page.mouse.up();
    assert.ok(Number(await divider.getAttribute('aria-valuenow'))>40);
    await divider.focus();await page.keyboard.press('Home');assert.equal(await divider.getAttribute('aria-valuenow'),'20');
    await page.setViewportSize({width:390,height:844});assert.equal(await divider.isVisible(),false);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
