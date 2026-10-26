import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile,mkdir} from 'node:fs/promises';
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
    const html=module.renderDocumentStrip(result.documents,'proposal:accepted');
    assert.match(html,/Roof proposal/);assert.match(html,/\$12,345\.00/);assert.match(html,/aria-pressed="true"/);assert.equal(html.match(/data-scope-document=/g).length,1);assert.doesNotMatch(html,/draft|presentation|JSON|Roof report/);
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
      resourceType:list=>list.resource_type,materialListColor:()=> '#123456',resourceTerms:()=>({singular:type,plural:type}),
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
    const result=await module.loadDocuments('org','project');assert.deepEqual(calls,['report','measurements','manual']);assert.equal(result.documents.length,1);assert.deepEqual(result.documents[0].value.measurements,{roofArea:{value:1200,unit:'ft2'}});assert.equal(result.error,'');
    window.PlatformAPI.publication.read=async()=>({status:'missing',code:'widget_report_unavailable'});const incomplete=await module.loadDocuments('org','project');assert.equal(incomplete.documents.length,0);
  }finally{delete globalThis.window;}
});

test('the project renderer mounts the compact published rail without requiring widget labels', () => {
  let mounted=false,divider=false;
  const target={querySelector(){},textContent:''};
  const ctx={performance,state:{active:true,lists:[],scopeDocuments:[],scopeDocumentsError:'',sidebarRoot:{classList:{add(){},remove(){}},querySelector:()=>null}},
    leftContentRoot:()=>target,orgId:()=> 'org',projectId:()=> 'project',schedulingOn:()=>true,timingMark(){},disposeScopeWidgets(){},scopeWidgetContext:()=>({fragments:{'scope.lists':()=>null}}),
    railLayout:()=>({defaultRatio:50,layout:'single'}),
    scopeWorkspace:{mountSidebar:(root,docs,error,key)=>{assert.equal(key,'org:project');mounted=true},installDivider:(root,layout)=>{divider=layout}}};
  vm.createContext(ctx);vm.runInContext(fn('renderLeft'),ctx);ctx.renderLeft();assert.ok(mounted);assert.equal(divider.defaultRatio,50);
  // One resource column gives an even split; several give the rail a third.
  const layoutCtx={resourceCategories:()=>[{id:'material'}]};vm.createContext(layoutCtx);vm.runInContext(fn('railLayout'),layoutCtx);
  assert.equal(layoutCtx.railLayout().defaultRatio,50);layoutCtx.resourceCategories=()=>[{id:'material'},{id:'labor'}];assert.ok(Math.abs(layoutCtx.railLayout().defaultRatio-100/3)<1e-9);
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

test('deleting a list uses the domain writer and preserves it on failure or project change',async()=>{
  for(const mode of ['success','failure','project-change','cancel']){
    const list={id:'labor',title:'Roof labor',revision:4},state={lists:[list],activeList:list,activeListId:list.id,visibleListIds:new Set([list.id])},calls=[];
    const button={dataset:{mtDeleteList:list.id},disabled:false};let current=true;
    const ctx={state,cleanText:String,materialListById:()=>list,captureProjectOperation:()=>({orgId:'org'}),projectOperationIsCurrent:()=>current,confirmAction:async()=>mode!=='cancel',showToast(){},render(){},renderLeft(){},materialsAPI:{lists:{archive:async(org,id,input)=>{calls.push({org,id,input});if(mode==='failure')throw Error('denied');if(mode==='project-change')current=false;}}}};
    vm.createContext(ctx);ctx.resourceCategories=()=>[];vm.runInContext(fn('bindResourceActions'),ctx);ctx.bindResourceActions({querySelectorAll:selector=>selector.includes('data-mt-restore-list')?[button]:[]});await button.onclick();
    assert.equal(state.lists.length,mode==='success'?0:1);assert.equal(button.disabled,false);
    assert.equal(calls.length,mode==='cancel'?0:1);if(calls.length)assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{org:'org',id:'labor',input:{expected_revision:4,reason:'Removed in Project'}});
  }
});

test('resource panes keep independent scroll, stable equal columns, and a draggable split', async () => {
  const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://fixture').pathname;if(path.startsWith('/libraries/image-viewer/')){res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../../libraries/image-viewer/'+path.split('/').pop(),import.meta.url)));return;}res.setHeader('Content-Type',req.url.includes('helper')?'text/javascript':'text/html');res.end(req.url.includes('helper')?helper:'<html><head></head><body></body></html>')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1500,height:900}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(({css,render,merged,helper})=>{
      window.state={lists:[],resourceTypes:['material','labor','equipment'].map((id,i)=>({id,name:['Materials','Labor','Equipment'][i],icon:'fa-box',color:'#123456'})),visibleListIds:new Set(),saving:false,loading:false};
      window.resourceCategories=()=>state.resourceTypes;
      window.items=[];
      window.filteredItems=()=>window.items;
      window.resourceType=list=>list?.resource_type||'material';
      window.materialListById=id=>state.lists.find(list=>list.id===id);
      window.resourceTerms=type=>({plural:{material:'Materials',labor:'Labor',equipment:'Equipment'}[type],singular:type});
      window.escapeHtml=value=>String(value);
      window.money=value=>'$'+value;window.laborListFinalized=()=>null;window.expenseTargetForList=()=>null;window.listTotals=()=>({projected:0});window.listProjected=()=>0;window.categoryProjected=()=>0;window.projectProjected=()=>0;window.renderAssignBlock=()=>'<div class="mt-empty">Empty List</div>';window.renderRequirementsTray=()=>'<aside class="mt-req-tray" data-mt-req-tray></aside>';window.projectId=()=>'';window.projectedDelivery=()=>({available:false,enabled:false,amount:0});window.number=Number;window.cleanText=value=>String(value||'');window.materialListOrdered=()=>false;window.renderListActionControls=()=>'';window.renderListHeaderActions=()=>'';window.renderLaborListControls=()=>'';window.requirementSet=()=>null;window.requirementsKey=()=>'org:project';window.minimizeIdleWorkOrder=()=>false;window.equipmentOn=()=>true;window.laborAssignmentOn=()=>true;window.equipmentListRetired=()=>false;
      window.materialSectionDefinitions=()=>['material','labor','equipment'].map(type=>({key:type,resource_type:type}));
      window.lineSectionKey=item=>item.section;
      window.renderMaterialSection=(section,rows)=>`<section class="mt-section">${rows.map(row=>`<div style="height:30px">${row.name}</div>`).join('')}</section>`;
      (0,eval)(css+'\n'+render+'\n'+merged);
      const style=document.createElement('style');style.textContent=window.css()+'.r-tab-content{display:flex;height:600px;width:1400px}.r-tab-main{flex:1;min-width:0}.mt-app{height:100%}';document.head.append(style);
      document.body.innerHTML='<div class="r-overlay materials-workspace"><div class="r-tab-content"><aside class="r-tab-sidebar mt-widget-sidebar"></aside><div class="r-tab-main"><div class="mt-app"><div class="mt-material-grid" data-mt-material-grid></div></div></div></div></div>';
      window.draw=()=>document.querySelector('[data-mt-material-grid]').innerHTML=renderMaterialSections();draw();
    },{css:fn('css'),render:fn('renderMaterialSections'),merged:fn('workOrderMerged'),helper});
    await page.evaluate(async()=>{window.helper=await import('/helper.js');helper.installDivider(document.querySelector('aside'));
      window.FMDocWidgets={};window.FMDocModel={paperDimensions:()=>({w_pt:612})};window.FMDocRenderer={render:(root,options)=>{root.innerHTML='<p>Rendered accepted roof contract</p>';window.renderedSnapshot=options.document;window.renderedContext=options.widgetContext;return {destroy(){}};}};
      window.scopeDocs=[{id:'contract',title:'Roof contract',source:'document',document_type:'contract',total:'$12,345.00',snapshot:{resolved_definition:{id:'captured-definition'},params:{contract_value:12345},outputs:{signed:true},widget_data:{}},sets:[{title:'Roof materials',lines:[{name:'Shingles',quantity:12,unit:'bundle',order_quantity:12,order_unit:'bundle'}]}]},{id:'report',title:'Roof report',source:'measurement',value:{measurements:{roofArea:{value:1400,unit:'ft2'}},artifacts:[{id:'report/pdf',kind:'firstmeasure.report'}]}}];
      window.widgetMounts=[];window.widgetDestroyed=0;
      window.FirstMateWidgets={mount(root,ref,context){window.roofContext=context;widgetMounts.push(ref.id);root.innerHTML='<div>Cached '+ref.id+'</div>';return {setVisible(){},destroy(){widgetDestroyed++;}};}};
      helper.mountSidebar(document.querySelector('aside'),scopeDocs,'','org:project');
    });
    assert.equal(await page.getByRole('tab',{name:'Measurements',exact:true}).getAttribute('aria-selected'),'true');assert.ok(await page.getByText('Cached reports.roof').isVisible());
    await page.getByRole('tab',{name:'Documents',exact:true}).click();
    const tile=page.locator('[data-scope-document="contract"]');assert.equal(await tile.getAttribute('aria-pressed'),'true');
    await page.getByText('Rendered accepted roof contract').waitFor();
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>renderedSnapshot.id),'captured-definition');assert.deepEqual(await page.evaluate(()=>renderedContext),{params:{contract_value:12345},outputs:{signed:true}});
    assert.ok(await page.locator('aside table').getByText('Shingles',{exact:true}).isVisible());assert.equal(await page.getByRole('button',{name:'Back',exact:false}).count(),0);
    assert.equal(await page.locator('[data-scope-document="report"]').count(),0);assert.equal(await page.locator('aside [data-scope-measure],aside details').count(),0);
    for(let i=0;i<3;i++){await page.getByRole('tab',{name:'Documents',exact:true}).click();await page.getByRole('tab',{name:'Photos',exact:true}).click();await page.getByRole('tab',{name:'Measurements',exact:true}).click();}
    await page.evaluate(()=>helper.mountSidebar(document.querySelector('aside'),scopeDocs,'','org:project',{measurementOverrides:{roofArea:1500},onMeasurementChange:(key,value)=>window.edited={key,value}}));
    assert.equal(await page.evaluate(()=>roofContext.getMeasurements().roofArea.value),1500);await page.evaluate(()=>roofContext.onMeasurementChange('roofArea',1750));assert.deepEqual(await page.evaluate(()=>edited),{key:'roofArea',value:1750});assert.equal(await page.evaluate(()=>roofContext.getMeasurements().roofArea.value),1750);
    await page.evaluate(()=>helper.mountSidebar(document.querySelector('aside'),scopeDocs.filter(doc=>doc.source!=='document'),'','org:empty'));await page.getByRole('tab',{name:'Documents',exact:true}).click();
    assert.ok(await page.getByText('No document selected',{exact:true}).isVisible());assert.ok(await page.getByText('No documents yet',{exact:true}).isVisible());const emptyViewer=await page.locator('.sw-doc-viewer').boundingBox(),emptyStrip=await page.locator('.sw-doc-strip').boundingBox();assert.ok(emptyViewer.height>emptyStrip.height*3&&emptyStrip.y>=emptyViewer.y+emptyViewer.height-1);
    await page.evaluate(()=>helper.mountSidebar(document.querySelector('aside'),scopeDocs,'','org:project',{measurementOverrides:{roofArea:1750}}));
    assert.deepEqual(await page.evaluate(()=>widgetMounts),['reports.roof','reports.roof','reports.roof']);
    assert.equal(await page.getByRole('tab').count(),4);assert.deepEqual(await page.getByRole('tab').allInnerTexts(),['Measurements','Documents','Photos','Schedule']);
    const widths=()=>page.locator('.mt-resource-column').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
    let w=await widths();assert.equal(w.length,2,'labor and equipment share one work order column');assert.ok(Math.max(...w)-Math.min(...w)<2);assert.equal(await page.getByText('Empty List',{exact:true}).count(),2);assert.deepEqual(await page.locator('.mt-resource-column').evaluateAll(nodes=>nodes.map(node=>node.dataset.resourceType)),['material','labor']);assert.equal(await page.locator('.mt-column-title').innerText(),'Work order');assert.equal(await page.locator('.mt-material-grid > .mt-req-tray').count(),1,'the requirements tray sits after the columns');
    await page.evaluate(()=>{state.lists=[{id:'m',title:'Materials',resource_type:'material'},{id:'l',title:'Labor',resource_type:'labor'}];state.visibleListIds=new Set(['m','l']);items=Array.from({length:70},(_,i)=>({name:'Item '+i,section:i%2?'labor':'material',__material_list_id:i%2?'l':'m'}));draw()});
    w=await widths();assert.ok(Math.abs(w[0]-w[1])<2);
    // An equipment list is drawn inside the work order column, after the labor.
    await page.evaluate(()=>{state.lists.push({id:'e',title:'Dumpster',resource_type:'equipment'});state.visibleListIds.add('e');items.push({name:'20 yard dumpster',section:'equipment',__material_list_id:'e'});draw()});
    assert.deepEqual(await page.locator('.mt-resource-column[data-resource-type=labor] [data-mt-pane-list]').evaluateAll(nodes=>nodes.map(node=>node.dataset.mtPaneList)),['l','e']);assert.equal((await widths()).length,2);
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


test('inline resource creation leaves empty placeholders, serializes names and inherits category identity',async()=>{
 const calls=[],state={resourceTypes:[],visibleListIds:new Set()},focused=[];
 const ctx={state,crypto:{randomUUID:()=> 'new-id'},window:{MaterialsAPI:{resourceTypes:{create:async(org,payload)=>{calls.push(['category',org,{...payload}]);return {resource_type:{...payload,revision:1}}},patch:async(org,id,payload)=>{calls.push(['rename',org,id,{...payload}]);return {resource_type:{...payload,revision:2}}}}}},companyPrimaryColor:()=> '#123456',captureProjectOperation:()=>({orgId:'org',projectId:'p'}),projectOperationIsCurrent:()=>true,workspaceIsEditing:()=>true,syncMaterialsGrid(){},materialRoot:()=>({querySelector:selector=>({focus:()=>focused.push(selector)})}),showToast(){},branchId:()=> 'branch',updateMaterialListState:list=>list,
 materialsAPI:{projects:{create:async(org,project,payload)=>{calls.push(['list',org,project,{...payload}]);return {material_list:{id:'new-list',...payload}}}}}};
 vm.createContext(ctx);vm.runInContext('const resourceWriteQueue=new Map();'+['resourceCategories','saveResourceCategory','addResourceCategory','createInlineList'].map(fn).join('\n'),ctx);
 ctx.addResourceCategory();const category=state.resourceTypes[0];assert.equal(category.name,'');assert.equal(category.icon,'fa-layer-group');assert.equal(category.color,'#123456');
 category.name='Disposal';await ctx.saveResourceCategory(category);assert.equal(category.revision,2);assert.equal(calls[0][0],'category');assert.equal(calls[1][3].expected_revision,1);
 await ctx.createInlineList(category.id);assert.equal(calls[2][3].title,'');assert.equal(calls[2][3].resource_type,category.id);assert.equal(calls[2][3].metadata.placeholder_title,true);assert.ok(focused.some(selector=>selector.includes('category-name')));assert.ok(focused.some(selector=>selector.includes('list-name')));assert.ok(state.visibleListIds.has('new-list'));
});


test('real resource rows are one line showing quantity and total, with unit price and remove behind the expander',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});try{const page=await browser.newPage({viewport:{width:780,height:650}});
 await page.evaluate(code=>{Object.assign(window,{state:{activeListId:'list',saving:false,unitsMode:'measured'},variantsForLine:()=>[],materialSecondaryText:()=>'',cleanText:value=>String(value||''),normalizeColor:value=>value,materialListColor:()=> '#123456',materialListById:()=>({resource_type:'material'}),resourceType:list=>list.resource_type,lineWarnings:(list,item)=>item==='labor'?[{message:'Tear off is also accounted for by Crew B.'}]:[],integerQuantity:value=>value,preciseQuantity:value=>value,materialPrimaryName:item=>item.name,escapeHtml:value=>String(value??''),renderVariantControl:()=>'',renderColorControl:()=>'<span class="mt-small">-</span>',money:value=>'$'+value});(0,eval)(code);const style=document.createElement('style');style.textContent=css()+'.mt-material-grid{height:500px;width:720px}';document.head.append(style);
 document.body.innerHTML='<div class="mt-material-grid">'+['material','labor','equipment'].map((type,i)=>'<section class="mt-resource-column"><h3 class="mt-resource-heading">'+type+'</h3><div class="mt-resource-scroll"><table class="mt-table"><tbody>'+renderLineRow({id:type,name:'Complete resource item name',__resource_type:type,quantity:12,unit:'ea',projected_unit_price:65})+'</tbody></table></div></section>').join('')+'</div>';},fn('css')+'\n'+fn('renderLineRow')+'\nfunction laborLinePaidAt(){return "";}');
 const columns=page.locator('.mt-resource-column');assert.equal(await columns.count(),3);
 assert.equal(await page.locator('.mt-c-warn').count(),1,'only the line with something to check carries the triangle');assert.equal(await page.locator('tr[data-mt-item-row=labor] .mt-c-warn').getAttribute('title'),'Tear off is also accounted for by Crew B.');for(let i=0;i<3;i++){assert.ok(await columns.nth(i).evaluate(el=>el.scrollWidth<=el.clientWidth));const row=await columns.nth(i).locator('tr.mt-list-row').boundingBox();assert.ok(row.height<=26);const name=await columns.nth(i).locator('[data-mt-item-name]').boundingBox();assert.ok(name.width>60);for(const part of ['[data-mt-item-qty]','[data-mt-item-unit]','.mt-c-total','[data-mt-expand-item]','.mt-drag']){const box=await columns.nth(i).locator(part).boundingBox();assert.ok(box.width>0&&box.y>=row.y&&box.y+box.height<=row.y+row.height&&box.x+box.width<=row.x+row.width+1,part);}assert.ok((await columns.nth(i).locator('[data-mt-item-qty]').boundingBox()).width<40);assert.equal(await columns.nth(i).locator('.mt-c-total').innerText(),'$780');for(const part of ['[data-mt-item-price]','[data-mt-remove]'])assert.equal(await columns.nth(i).locator(part).isVisible(),false);assert.match(await columns.nth(i).locator('tr.mt-list-row').getAttribute('title'),/^Complete resource item name\n12 ea × \$65 = \$780$/);}
 await page.locator('tr.mt-list-row').first().evaluate(row=>row.classList.add('is-expanded'));assert.equal(await page.locator('[data-mt-item-price=material]').inputValue(),'65');assert.ok(await page.locator('[data-mt-remove=material]').isVisible());assert.ok(await columns.nth(0).evaluate(el=>el.scrollWidth<=el.clientWidth));assert.equal(await page.locator('[data-mt-item-price=labor]').isVisible(),false);
 await page.locator('[data-mt-item-name=material]').fill('Long roofing material name');await page.locator('[data-mt-item-qty=material]').fill('28');assert.equal(await page.locator('[data-mt-item-qty=material]').inputValue(),'28');await page.addStyleTag({content:'.mt-material-grid{width:1560px!important}'});await page.setViewportSize({width:1600,height:650});
 for(let i=1;i<3;i++){assert.ok((await columns.nth(i).locator('tr.mt-list-row').boundingBox()).height<=26);assert.equal(await columns.nth(i).locator('.mt-c-total').innerText(),'$780');assert.ok(await columns.nth(i).evaluate(el=>el.scrollWidth<=el.clientWidth));}
 }finally{await browser.close();}
});

test('dropping an item reorders its list or moves it beside the anchor in another list of the same type',async()=>{
 const make=()=>{const lists=[{id:'a',resource_type:'material',revision:1,current_items:[{id:'1'},{id:'2'},{id:'3'}]},{id:'b',resource_type:'material',revision:1,current_items:[{id:'4'}]},{id:'c',resource_type:'labor',revision:1,current_items:[]}],calls=[];
  const ctx={state:{saving:false},calls,lists,cleanText:value=>String(value??''),materialListById:id=>lists.find(list=>list.id===id),resourceType:list=>list.resource_type,listItems:list=>list.current_items,replaceListItems:(id,items)=>{lists.find(list=>list.id===id).current_items=items;},syncMaterialsGrid(){},setWorkspaceSaving(){},showToast(){},resourceTerms:()=>({list:'List'}),loadExpenseProjection:async()=>{},persistVersion:async(payload,options)=>{calls.push({list:options.list.id,reason:payload.reason,items:payload.items?.map(item=>item.id),removed:payload.remove_item_ids});if(ctx.fail)throw Error('denied');}};
  vm.createContext(ctx);vm.runInContext(fn('dropItem'),ctx);return ctx;};
 const ids=(ctx,id)=>ctx.lists.find(list=>list.id===id).current_items.map(item=>item.id);
 let ctx=make();await ctx.dropItem('3','a','a','1',false);assert.deepEqual(ids(ctx,'a'),['3','1','2']);assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls)),[{list:'a',reason:'revision',items:['3','1','2']}]);assert.equal(ctx.state.saving,false);
 ctx=make();await ctx.dropItem('1','a','a','2',false);assert.equal(ctx.calls.length,0);await ctx.dropItem('1','a','a','3',true);assert.deepEqual(ids(ctx,'a'),['2','3','1']);
 ctx=make();await ctx.dropItem('2','a','b','4',false);assert.deepEqual(ids(ctx,'a'),['1','3']);assert.deepEqual(ids(ctx,'b'),['2','4']);assert.deepEqual(JSON.parse(JSON.stringify(ctx.calls)),[{list:'b',reason:'supplement',items:['2','4']},{list:'a',reason:'removal',removed:['2']}]);
 ctx=make();await ctx.dropItem('2','a','b');assert.deepEqual(ids(ctx,'b'),['4','2']);
 ctx=make();await ctx.dropItem('2','a','c');assert.equal(ctx.calls.length,0);assert.deepEqual(ids(ctx,'a'),['1','2','3']);
 ctx=make();ctx.fail=true;await ctx.dropItem('3','a','a','1',false);assert.deepEqual(ids(ctx,'a'),['1','2','3']);assert.equal(ctx.state.saving,false);
});

test('assigning a labor list re-renders only after saving is released, so controls are not left disabled',async()=>{
 for(const name of ['assignWorkResource'])for(const fail of [false,true]){
  const list={id:'labor',title:'Roof labor',compensation:{}},renders=[];
  const ctx={state:{saving:false},cleanText:value=>String(value??''),materialListById:()=>list,captureProjectOperation:()=>({}),projectOperationIsCurrent:()=>true,renderLeft(){},workResourceById:()=>null,assignmentWorkResourceRef:()=>null,workResourceLabel:()=>'Team',patchScopeResourceList:async(_id,patch)=>{assert.equal(Object.hasOwn(patch,'compensation'),false,'assigning says nothing about pay');if(fail)throw Error('denied');return list;},loadExpenseProjection:async()=>{},render:()=>renders.push(ctx.state.saving),syncLaborMenu(){},showToast(){},syncScopeListCard(){}};
  vm.createContext(ctx);vm.runInContext(fn(name),ctx);await ctx[name]('labor','hourly');
  assert.equal(ctx.state.saving,false,name);assert.equal(renders.at(-1),false,name+' final render');
 }
});

test('the assign block stays clickable through a background save, assigns once and keeps its pills short',async()=>{
 const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
 const calls=[],list={id:'labor'};let pending=0;
 const ctx={state:{saving:true,crewsLoaded:true,assigneePay:{labor:{loading:false,at:Date.now(),rows:[{assignee:{id:'crew'},sheet:{id:'s2'},complete:false,total_cents:0,overlap:1},{assignee:{id:'sub'},sheet:{id:'s'},complete:true,total_cents:433080,hourly_rate_cents:12800,duration_days:2,equipment:[{name:'Dump truck',included:true}]}]}}},setTimeout,
  cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,escapeHtml,money:value=>'$'+Number(value).toLocaleString('en-US'),
  workResourcesForScopeList:()=>[{id:'sub',name:'Summit Roofing',resource_kind:'organization_connection'},{id:'crew',name:'Crew A',resource_kind:'resource_group'}],workforceLabel:kind=>kind==='organization_connection'?'Subcontractor':'Crew',
  workspaceIsEditing:()=>false,syncMaterialsGrid(){},materialRoot:()=>null,captureProjectOperation:()=>({}),projectOperationIsCurrent:()=>true,listWritesPending:()=>pending>0,requirementSet:()=>null,showToast(){},materialListById:()=>list,
  assignmentWorkResourceRef:value=>value.assigned?{id:value.assigned}:null,assignWorkResource:async(id,resource)=>{calls.push(['assign',resource,ctx.state.saving,pending]);await new Promise(resolve=>setTimeout(resolve,5));list.assigned=resource;},generateLaborList:async id=>{calls.push(['generate',id]);}};
 vm.createContext(ctx);for(const name of ['assigneePay','assigneePayFor','assigneePayLabel','assigneePills','assigneeKindPill','laborAssignmentOptions','laborAssignmentView','renderAssignmentNote','renderAssignmentMore','renderAssignBlock','syncAssignBusy','assignAndGenerate'])vm.runInContext(fn(name),ctx);
 const html=ctx.renderAssignBlock(list);
 assert.doesNotMatch(html,/<button[^>]*disabled/,'a save in progress does not disable the options');
 assert.match(html,/title="Subcontractor\. An outside company\.">Sub</);assert.match(html,/People inside your organization\.">Crew</);
 assert.match(html,/title="2 days\. [^"]*"><i[^>]*><\/i><span>2d</);assert.match(html,/<span>\$128\/hr</);assert.match(html,/class="mt-pill fit" title="Brings their own dump truck[^"]*"><i[^>]*><\/i><span>Dump truck</);
 // Clicked twice while a line save is still running: it waits for the save, then assigns and generates once.
 pending=1;setTimeout(()=>{ctx.state.saving=false;pending=0;},120);
 await Promise.all([ctx.assignAndGenerate('labor','sub'),ctx.assignAndGenerate('labor','sub'),ctx.assignAndGenerate('labor','crew')]);
 assert.deepEqual(calls,[['assign','sub',false,0],['generate','labor']]);assert.equal(ctx.state.assigningListId,'');
 assert.doesNotMatch(source,/state\.saving\) assignAndGenerate/,'the click is not gated on the page-wide saving flag');
});

test('the labor popover is about who does the work and shows what each would be paid',()=>{
 const crews=[{id:'hourly',name:'Crew A',resource_kind:'resource_group',members:[{},{}],compensation_plan:{type:'hourly'}},{id:'piece',name:'Sub B',resource_kind:'organization_connection',compensation_plan:{type:'piece_rate'}},{id:'salary',name:'Staff C',resource_kind:'resource_group',compensation_plan:{type:'salary'}}];
 const ctx={state:{laborMenu:null,crewsLoaded:true},cleanText:value=>String(value??''),escapeHtml:value=>String(value??''),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,assignmentWorkResourceRef:list=>list.assigned?{id:list.assigned}:null,workResourcesForScopeList:()=>crews,workResourceById:id=>crews.find(crew=>crew.id===id)||null,workforceLabel:kind=>kind==='organization_connection'?'Partner':'Team',laborAssignmentOn:()=>true};
 ctx.money=value=>'$'+Number(value).toLocaleString('en-US');ctx.laborListFinalized=()=>null;ctx.requirementSet=()=>null;vm.createContext(ctx);for(const name of ['laborPayLabel','assigneePay','assigneePayFor','assigneePayLabel','assigneeKindPill','assigneePills','laborSettings','laborAssignmentOptions','laborAssignmentView','renderAssignmentNote','renderAssignmentMore','renderLaborListControls','renderLaborMenu'])vm.runInContext(fn(name),ctx);
 const menu=list=>ctx.renderLaborMenu({id:'labor',...list});
 // Before pay is worked out everyone who can be assigned is listed, without a price yet.
 let html=menu({});assert.match(html,/Crew A[\s\S]*Staff C[\s\S]*Sub B/);assert.doesNotMatch(html,/\$0|Finding who/);assert.match(ctx.renderLaborListControls({id:'labor'}),/Unassigned/);
 // Each assignee shows what this job would pay them, or the one thing standing in the way. Unknown is never shown as zero.
 // With no work required yet, only those with a pay sheet are offered: complete first, then the rest.
 ctx.state.assigneePay={labor:{rows:[{assignee:{id:'piece'},sheet:{id:'s1'},complete:true,total_cents:214000,duration_days:1.5,equipment:[{name:'Dump truck',included:true}]},{assignee:{id:'hourly'},sheet:{id:'s2'},complete:false,total_cents:0,awaiting_hours:true,hourly_rate_cents:12800,missing_inputs:[{required:true,label:'Hours'}]},{assignee:{id:'salary'},sheet:null,complete:false}]}};
 html=menu({});assert.match(html,/title="Team\. People inside your organization\.">Team</);assert.match(html,/title="Partner\. An outside company\.">Par</);assert.doesNotMatch(html,/data-mt-labor-pay-mode|data-mt-labor-hours-input|data-mt-labor-salary-mode/);
 assert.match(html,/Sub B[\s\S]*?<b class="mt-pay">\$2,140<\/b>[\s\S]*?Crew A[\s\S]*?<b class="mt-pay unknown">Hourly<\/b>/);assert.doesNotMatch(html,/Staff C/,'no pay sheet and no work in common: not offered');assert.doesNotMatch(html,/\$0/);assert.match(html,/Sub B[\s\S]*?Dump truck[\s\S]*?1\.5d/,'reassigning shows the same facts as assigning: what they bring and how long');
 assert.doesNotMatch(ctx.renderLaborListControls({id:'labor'}),/data-mt-labor-generate/,'nothing to generate from until someone is assigned');assert.match(ctx.renderLaborListControls({id:'labor',assigned:'hourly'}),/data-mt-labor-generate="labor"/);
 // Pay modes, hours and salary handling are not chosen here: a list's pay is its lines.
 for(const assigned of ['hourly','piece','salary']){html=menu({assigned});assert.doesNotMatch(html,/data-mt-labor-pay-mode|data-mt-labor-hours-input|data-mt-labor-salary-mode|Project pay/);}
 assert.match(ctx.renderLaborListControls({id:'labor',assigned:'hourly'}),/<span>Crew A<\/span>/);
});

test('dragging a column divider trades width between its two neighbours, starting from unset weights',()=>{
 const column=(type,width)=>({dataset:{resourceType:type},props:{},getBoundingClientRect:()=>({width}),style:{setProperty(name,value){this.owner.props[name]=value;}}});
 const left=column('material',300),right=column('labor',300);left.style.owner=left;right.style.owner=right;
 const ctx={state:{columnWeights:null},rootWindow:{localStorage:{getItem:()=>null,setItem(key,value){ctx.saved=JSON.parse(value);}}}};
 vm.createContext(ctx);for(const name of ['number','columnWeights','resizeColumns'])vm.runInContext(fn(name),ctx);
 const divider={previousElementSibling:left,nextElementSibling:right};
 ctx.resizeColumns(divider,0);assert.equal(left.props['--column-weight'],1);assert.equal(right.props['--column-weight'],1);
 ctx.resizeColumns(divider,150,true);assert.equal(left.props['--column-weight'],1.5);assert.equal(right.props['--column-weight'],0.5);assert.deepEqual(ctx.saved,{material:1.5,labor:0.5});
 ctx.resizeColumns(divider,-10000,true);assert.ok(left.props['--column-weight']>0&&right.props['--column-weight']>left.props['--column-weight']);assert.equal(Math.round((left.props['--column-weight']+right.props['--column-weight'])*1000),2000);
 ctx.state.columnWeights={material:0,labor:0};ctx.resizeColumns(divider,0,true);assert.equal(left.props['--column-weight'],1);
});

test('committing a name renames or swaps in a price book item, and Enter on the last row starts the next one',async()=>{
 const make=()=>{const list={id:'list',resource_type:'material',current_items:[{id:'first',name:'Drip edge',quantity:4},{id:'last',name:'New material',quantity:0}]},calls=[];
  const ctx={state:{saving:false,autofill:null},calls,list,cleanText:value=>String(value??'').trim(),materialListById:()=>list,listItems:value=>value.current_items,materialPrimaryName:item=>item.name,integerQuantity:value=>Math.round(Number(value)||0),resourceType:value=>value.resource_type,document:{querySelectorAll:()=>[]},materialRoot:()=>null,findByData:()=>null,syncMaterialsGrid(){calls.push(['grid']);},
   lineFromPricebookItem:(item,overrides)=>({name:item.name,pricebook_ref:{item_id:item.id},quantity:overrides.quantity??12,section:'shingles'}),updateItem:async(id,patch,listId)=>{calls.push(['update',id,patch.name,patch.pricebook_ref?.item_id||null,patch.quantity??null,listId]);},addItem:async(item,section,listId)=>{calls.push(['add',item,section,listId]);}};
  vm.createContext(ctx);for(const name of ['closeAutofill','commitItemName'])vm.runInContext(fn(name),ctx);return ctx;};
 const input=(id,value)=>({value,dataset:{mtItemName:id,mtListId:'list'}});const plain=ctx=>JSON.parse(JSON.stringify(ctx.calls));
 let ctx=make(),field=input('last','Ridge vent');await ctx.commitItemName(field,null,true);assert.deepEqual(plain(ctx),[['update','last','Ridge vent',null,null,'list'],['add',null,'accessories','list']]);assert.equal(field.dataset.mtCommitted,'1');
 ctx=make();await ctx.commitItemName(input('last','timber'),{catalogItem:{id:'p1',name:'Timberline HDZ'}},true);assert.deepEqual(plain(ctx),[['update','last','Timberline HDZ','p1',12,'list'],['grid'],['add',null,'accessories','list']]);
 ctx=make();await ctx.commitItemName(input('first','Drip edge white'),{catalogItem:{id:'p1',name:'Timberline HDZ'}},true);assert.deepEqual(plain(ctx),[['update','first','Timberline HDZ','p1',4,'list'],['grid']],'a middle row keeps its quantity and does not start a new row');
 ctx=make();await ctx.commitItemName(input('last','New material'),null,true);assert.deepEqual(plain(ctx),[],'an untouched row does nothing');
 ctx=make();await ctx.commitItemName(input('last','Ridge vent'),null,false);assert.deepEqual(plain(ctx),[['update','last','Ridge vent',null,null,'list']]);
 ctx=make();await ctx.commitItemName(input('last','tear'),{patch:{name:'Tear off',unit:'sq',projected_unit_price:65}},true);assert.deepEqual(plain(ctx),[['update','last','Tear off',null,null,'list'],['add',null,'accessories','list']],'a suggestion from another source fills the row and starts the next');
 const counted=()=>{const next=make();next.findByData=(root,selector,key,id)=>selector==='[data-mt-item-qty]'&&key==='mtItemQty'?{focus(){next.calls.push(['focus',id]);},select(){next.calls.push(['select',id]);}}:null;return next;};
 ctx=counted();await ctx.commitItemName(input('first','Custom flashing'),null,false);assert.deepEqual(plain(ctx),[['update','first','Custom flashing',null,null,'list'],['focus','first'],['select','first']],'Tab from typed text keeps it and moves to that row\'s count');
 ctx=counted();await ctx.commitItemName(input('first','Drip edge'),null,false);assert.deepEqual(plain(ctx),[['focus','first'],['select','first']],'Tab from an unchanged name still moves to the count');
 ctx=counted();await ctx.commitItemName(input('first','timber'),{catalogItem:{id:'p1',name:'Timberline HDZ'}},false);assert.deepEqual(plain(ctx),[['update','first','Timberline HDZ','p1',4,'list'],['grid'],['focus','first'],['select','first']],'Tab with a suggestion chosen takes it and moves to the count');
 ctx=counted();await ctx.commitItemName(input('first','Custom flashing'),null,true);assert.deepEqual(plain(ctx),[['update','first','Custom flashing',null,null,'list']],'Enter on typed text in a middle row leaves the focus alone');

});

test('order deliveries group only when asked, and the supplier email describes each delivery once',()=>{
 const lists=[{id:'a',title:'Dry-in'},{id:'b',title:'Shingles'},{id:'c',title:'Trim'}];
 const ctx={state:{orderSelectedListIds:new Set(['a','b','c']),orderScheduleDrafts:{a:{date:'2026-10-20',time:'Morning (8am - 12pm)'},b:{date:'2026-10-20',time:'Morning (8am - 12pm)'},c:{date:'',time:''}},project:{address:'12 Oak St'}},cleanText:value=>String(value??'').trim(),materialListById:id=>lists.find(list=>list.id===id),selectedOrderLists:()=>lists,projectId:()=>'project',orderRequestRows:list=>[{name:list.title+' item',detail:'',details:[],quantity:2,unit:'ea'}],orderDateLabel:()=>'Thu, Oct 22, 2026'};
 vm.createContext(ctx);const source=fn('orderTimeClock')+fn('orderGroupTarget')+fn('orderSchedule')+fn('orderDeliveryGroups')+fn('orderGroupTitle')+fn('scheduleDraftForList')+fn('dateFromOrderSchedule')+fn('orderRequestSubject')+fn('orderDeliveryInstruction')+fn('orderEmailFacts')+fn('orderRequestText');vm.runInContext(source,ctx);
 assert.deepEqual(['9','9am','9:30 pm','14:00','12am','Morning','25:00'].map(value=>ctx.orderTimeClock(value)),['09:00','09:00','21:30','14:00','00:00','','']);
 const titles=()=>JSON.parse(JSON.stringify(ctx.orderDeliveryGroups().map(group=>group.lists.map(list=>list.title))));
 assert.deepEqual(titles(),[['Dry-in'],['Shingles'],['Trim']],'the same date and time does not group lists by itself');
 ctx.state.orderScheduleDrafts.c={date:'',time:'',group_with:'a'};assert.deepEqual(titles(),[['Dry-in','Trim'],['Shingles']]);assert.equal(ctx.orderSchedule(lists[2]).date,'2026-10-20');
 const text=ctx.orderRequestText();assert.match(text,/I need the Dry-in and Trim delivery on .*2026, Morning \(8am - 12pm\)\./);assert.equal(text.match(/Material\tDetails\tQuantity\tUnit/g).length,2);assert.match(text,/Dry-in item\t—\t2\tea\nTrim item/);assert.match(text,/^Material delivery request - 12 Oak St - 2026-10-20/);
 ctx.state.orderScheduleDrafts.a={date:'2026-10-20',time:'9:30 am'};assert.match(ctx.orderDeliveryInstruction(ctx.orderDeliveryGroups()[0]),/ at 9:30 am\.$/);
 ctx.state.orderScheduleDrafts.a={date:'',time:''};assert.deepEqual(titles(),[['Dry-in'],['Shingles'],['Trim']],'a group dissolves when its lead loses its date');assert.match(ctx.orderDeliveryInstruction(ctx.orderDeliveryGroups()[2]),/please contact me to arrange them/);
 ctx.state.orderSelectedListIds=new Set(['b','c']);ctx.state.orderScheduleDrafts.c={group_with:'b'};ctx.state.orderScheduleDrafts.b={date:'2026-10-21',time:'',group_with:'c'};assert.equal(ctx.orderGroupTarget(lists[2]),null,'a list that is itself grouped cannot lead a group');
});

test('saves for one list run in order on the latest revision while what is on screen is kept',async()=>{
 const list={id:'list',revision:1,current_items:[{id:'a'}]},sent=[],release=[];
 const ctx={state:{activeList:list,lists:[list]},cleanText:value=>String(value??'').trim(),materialListById:()=>ctx.state.lists[0],listItems:value=>value?.current_items||[],
  updateMaterialListState:next=>{ctx.state.lists=[{...ctx.state.lists[0],...next}];return ctx.state.lists[0];},
  persistVersionNow:(payload,options)=>new Promise(resolve=>{sent.push([payload.tag,options.list.revision]);release.push(()=>{ctx.updateMaterialListState({id:'list',revision:options.list.revision+1,current_items:payload.server});resolve('ok');});})};
 vm.createContext(ctx);vm.runInContext('const listWrites=new Map();'+fn('listWritesPending')+fn('persistVersion')+fn('replaceListItems'),ctx);
 ctx.replaceListItems('list',[{id:'a'},{id:'b'}]);const first=ctx.persistVersion({tag:'add b',server:[{id:'a'},{id:'b'}]},{list});
 ctx.replaceListItems('list',[{id:'a'},{id:'b'},{id:'c'}]);const second=ctx.persistVersion({tag:'add c',server:[{id:'a'},{id:'b'},{id:'c'}]},{list});
 await Promise.resolve();await Promise.resolve();assert.deepEqual(sent,[['add b',1]],'the second save waits for the first');assert.equal(ctx.listWritesPending(),true);
 release[0]();await first;assert.deepEqual(ctx.state.lists[0].current_items.map(item=>item.id),['a','b','c'],'the row added while saving is still there');assert.equal(ctx.state.lists[0].revision,2);
 await Promise.resolve();await Promise.resolve();assert.deepEqual(sent,[['add b',1],['add c',2]]);release[1]();await second;assert.equal(ctx.state.lists[0].revision,3);assert.equal(ctx.listWritesPending(),false);
});

test('suggestions come only from the sources a category has switched on, using real price book and equipment data, and never for labor',()=>{
 const crew={id:'crew',name:'Crew A',compensation_plan:{hourly_rate_cents:4200,piece_rates:[{id:'tear',label:'Tear off',unit:'sq',rate_cents:6500}]},members:[{compensation_plan:{piece_rates:[{id:'tear',label:'Tear off',unit:'sq',rate_cents:6500},{id:'ridge',label:'Ridge install',unit:'ft',rate_cents:300}]}}]};
 const ctx={state:{pricebookItems:[{id:'p1',name:'Tear resistant underlayment',category:'Underlayment',code:'UL-1',unitPrice:95,unit:'roll'},{id:'p2',name:'Tear off estimate allowance',category:'Estimating',unitPrice:10,unit:'sq'}],equipmentUnits:[{id:'u1',name:'Tear-off trailer',status:'available',rates:{daily_cents:35000}},{id:'u2',name:'Lift',rates:{}}],resourceTypes:[{id:'material',line_item_sources:['pricebook']},{id:'labor',line_item_sources:['piece_rate','hourly_labor']},{id:'equipment',line_item_sources:['equipment']},{id:'custom',line_item_sources:['pricebook','equipment']},{id:'off',line_item_sources:[]}]},
  cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,money:value=>'$'+Number(value).toFixed(2),resourceCategories:()=>ctx.state.resourceTypes,LINE_ITEM_SOURCE_DEFS:[{id:'pricebook'},{id:'equipment'}],resourceType:list=>list.resource_type,laborSettings:list=>({resource:list.assigned?crew:null}),loadEquipmentUnits(){}};
 vm.createContext(ctx);vm.runInContext(fn('equipmentOn')+fn('categorySources')+fn('categorySkuOnly')+fn('autofillGroup')+fn('equipmentProvides')+fn('autofillMatches'),ctx);
 const labels=(query,list)=>JSON.parse(JSON.stringify(ctx.autofillMatches(query,list).map(entry=>entry.label)));
 assert.deepEqual(labels('tear',{resource_type:'material'}),['Tear resistant underlayment']);
 // Labor lines come from the assignee's pay sheet when the work order is generated, never from suggestions; a category that still names the old pay plan sources suggests nothing from them.
 assert.deepEqual(labels('tear',{resource_type:'labor',assigned:true}),[],'no labor suggestions, even with an assignee whose old pay plan lists piece rates');
 assert.deepEqual(labels('hour',{resource_type:'labor',assigned:true}),[]);
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.categorySources('labor'))),[],'stored pay plan sources are not offered');
 const trailer=ctx.autofillMatches('trailer',{resource_type:'equipment'})[0];assert.equal(trailer.patch.projected_unit_price,350);assert.equal(trailer.patch.unit,'day');assert.equal(ctx.autofillMatches('lift',{resource_type:'equipment'})[0].patch.projected_unit_price,undefined);
 assert.deepEqual(labels('tear',{resource_type:'custom'}),['Tear resistant underlayment','Tear off estimate allowance','Tear-off trailer'],'only Materials limits the price book to items with a SKU by default');
 ctx.state.resourceTypes.find(row=>row.id==='material').pricebook_sku_only=false;assert.deepEqual(labels('tear',{resource_type:'material'}),['Tear resistant underlayment','Tear off estimate allowance']);ctx.state.resourceTypes.find(row=>row.id==='custom').pricebook_sku_only=true;assert.deepEqual(labels('tear',{resource_type:'custom'}),['Tear resistant underlayment','Tear-off trailer']);assert.deepEqual(labels('tear',{resource_type:'off'}),[]);
 ctx.state.resourceTypes=[{id:'material'}];assert.deepEqual(labels('tear',{resource_type:'material'}),['Tear resistant underlayment'],'a category without a saved choice uses its default sources');
});

test('a supplier quote covers carried items, flags unknown prices, applies delivery once and defaults to the cheapest full match',()=>{
 const line=(id,item,quantity)=>({id,quantity,pricebook_ref:{item_id:item}});
 const lists=[{id:'a',title:'Dry-in',current_items:[line('a1','shingle',10),line('a2','nails',2)]},{id:'b',title:'Shingles',current_items:[line('b1','shingle',5),{id:'fee',quantity:1,metadata:{delivery_fee:true}}]},{id:'c',title:'Trim',current_items:[line('c1','gutter',3),{id:'custom',quantity:1}]}];
 const abc={id:'abc',name:'ABC',order_email:'orders@abc.test',delivery_fee:{amount_cents:7500,free_above_cents:60000},offerings:[{item_id:'shingle',sku:'A',price_cents:4000},{item_id:'nails',sku:'',price_cents:4200},{item_id:'gutter',sku:'',price_cents:null}],locations:[{id:'south',name:'South',order_email:'south@abc.test',delivery_fee:null,overrides:[{item_id:'shingle',price_cents:3500},{item_id:'nails',carried:false}]}]};
 const beacon={id:'beacon',name:'Beacon',order_email:'',delivery_fee:null,offerings:[{item_id:'shingle',sku:'',price_cents:4100},{item_id:'nails',sku:'',price_cents:4000}],locations:[]};
 const ctx={state:{suppliers:[abc,beacon],orderSelectedListIds:new Set(['a','b','c']),orderScheduleDrafts:{}},cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,listItems:list=>list.current_items,linePricebookItemId:item=>item.pricebook_ref?.item_id||'',materialListById:id=>lists.find(list=>list.id===id),selectedOrderLists:()=>lists.filter(list=>ctx.state.orderSelectedListIds.has(list.id))};
 vm.createContext(ctx);vm.runInContext(['supplierTargets','supplierOffer','orderableItems','packagedOrderQuantity','supplierQuantity','supplierQuote','orderDeliveryLists','bestSupplierTarget','orderSupplierChoice','orderSupplierGroups','orderGroupTarget','scheduleDraftForList'].map(fn).join(''),ctx);
 const targets=ctx.supplierTargets();assert.deepEqual(JSON.parse(JSON.stringify(targets.map(target=>[target.key,target.email]))),[['abc','orders@abc.test'],['abc/south','south@abc.test'],['beacon','']]);
 const plain=quote=>({coversAll:quote.coversAll,missing:[...quote.missing],unpriced:[...quote.unpriced],subtotal:quote.subtotal,delivery:quote.delivery,total:quote.total,waived:quote.waived});
 assert.deepEqual(plain(ctx.supplierQuote(targets[0],[lists[0]])),{coversAll:true,missing:[],unpriced:[],subtotal:48400,delivery:7500,total:55900,waived:false});
 assert.equal(ctx.supplierQuote(targets[0],[lists[0]],false).total,48400);
 assert.deepEqual(plain(ctx.supplierQuote(targets[0],[lists[0],lists[1]])),{coversAll:true,missing:[],unpriced:[],subtotal:68400,delivery:0,total:68400,waived:true},'two lists in one delivery pay one fee, waived above the threshold; the fee line itself is not an order item');
 assert.deepEqual(plain(ctx.supplierQuote(targets[1],[lists[0]])),{coversAll:false,missing:['a2'],unpriced:[],subtotal:35000,delivery:7500,total:42500,waived:false},'a location uses its own price and stock, and its supplier\'s fee');
 const trim=ctx.supplierQuote(targets[0],[lists[2]]);assert.deepEqual([...trim.missing],['custom'],'a line that is not a price book item cannot be matched');assert.deepEqual([...trim.unpriced],['c1']);assert.equal(trim.total,null);
 assert.equal(ctx.orderSupplierChoice(lists[0]).target.key,'beacon','Beacon carries everything for less once delivery is counted');
 assert.equal(ctx.orderSupplierChoice(lists[1]).target.key,'beacon','the South yard price is lower but its delivery fee makes Beacon cheaper overall');assert.equal(ctx.orderSupplierChoice(lists[2]).target,null,'no supplier fully covers a list with unknown or unmatched lines');
 ctx.state.orderScheduleDrafts.a={supplier_key:'abc',date:'2026-10-20'};ctx.state.orderScheduleDrafts.b={group_with:'a'};
 assert.equal(ctx.orderSupplierChoice(lists[1]).target.key,'abc','a grouped list is ordered from the list it is grouped with');
 ctx.state.orderScheduleDrafts.c={supplier_email:'yard@elsewhere.test',supplier_key:''};
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.orderSupplierGroups().map(group=>[group.key,group.choice.email,group.lists.map(list=>list.id)]))),[['abc','orders@abc.test',['a','b']],['email:yard@elsewhere.test','yard@elsewhere.test',['c']]]);
 ctx.state.orderScheduleDrafts.a={supplier_key:''};assert.equal(ctx.orderSupplierChoice(lists[0]).target,null,'an explicit empty choice stays empty');
});

test('projected delivery is one estimate per category, switched off for the whole category and dropped for ordered lists',()=>{
 const line=(id,item)=>({id,quantity:10,projected_total:100,pricebook_ref:{item_id:item}});
 const abc={id:'abc',name:'ABC',delivery_fee:{amount_cents:7500,free_above_cents:null},offerings:[{item_id:'shingle',sku:'',price_cents:4000},{item_id:'nails',sku:'',price_cents:null}],locations:[]};
 const beacon={id:'beacon',name:'Beacon',delivery_fee:{amount_cents:5000,free_above_cents:null},offerings:[{item_id:'shingle',sku:'',price_cents:4500}],locations:[]};
 const ctx={state:{suppliers:[abc,beacon],lists:[]},ordered:new Set(),cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,listItems:list=>list.current_items,linePricebookItemId:item=>item.pricebook_ref?.item_id||'',resourceType:list=>list.resource_type,materialListOrdered:list=>ctx.ordered.has(list.id),expenseTargetForList:list=>list.target||null,listTotals:list=>({projected:list.current_items.reduce((sum,item)=>sum+(item.projected_total||0),0)})};
 vm.createContext(ctx);vm.runInContext(['supplierTargets','supplierOffer','orderableItems','packagedOrderQuantity','supplierQuantity','supplierQuote','bestSupplierTarget','projectedDelivery','listProjected','categoryProjected','projectProjected'].map(fn).join(''),ctx);
 const plain=value=>JSON.parse(JSON.stringify(value));
 const a={id:'a',resource_type:'material',current_items:[line('a1','shingle')]},b={id:'b',resource_type:'material',current_items:[line('b1','shingle')]},labor={id:'l',resource_type:'labor',target:{projected_cents:123400},current_items:[line('l1','shingle')]};
 ctx.state.lists=[a,b,labor];
 assert.deepEqual(plain(ctx.projectedDelivery('material')),{available:true,enabled:true,amount:75,estimate:75},'two lists are one delivery from the cheaper supplier overall');
 assert.equal(ctx.listProjected(a),100,'a list no longer carries delivery itself');assert.equal(ctx.categoryProjected('material'),275);assert.equal(ctx.projectedDelivery('labor').available,false);assert.equal(ctx.projectProjected(),275+1234);
 b.metadata={projected_delivery_disabled:true};assert.deepEqual(plain(ctx.projectedDelivery('material')),{available:true,enabled:false,amount:0,estimate:75},'off on any list of the category is off for the category');assert.equal(ctx.categoryProjected('material'),200);b.metadata={};
 ctx.ordered.add('a');assert.equal(ctx.projectedDelivery('material').amount,75,'the unordered list still needs a delivery');ctx.ordered.add('b');assert.equal(ctx.projectedDelivery('material').available,false);ctx.ordered.clear();
 b.current_items=[line('b1','shingle'),line('b2','nails')];assert.equal(ctx.projectedDelivery('material').amount,50,'with no full match, the lowest fee among suppliers carrying something');
 b.current_items=[line('b1','shingle'),{id:'fee',metadata:{delivery_fee:true}}];assert.equal(ctx.projectedDelivery('material').amount,75,'a list with a real delivery line is left out');
 ctx.state.lists=[labor];assert.equal(ctx.projectedDelivery('material').available,false);ctx.state.lists=[a];ctx.state.suppliers=[];assert.equal(ctx.projectedDelivery('material').available,false);
});

test('the requirements tray says how the project stands when closed and what accounts for each thing when open',async()=>{
 const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
 const lists=[{id:'labor',resource_type:'labor',title:'Roof labor',assigned:'sub',metadata:{work_scope:{excluded_items:['roofing.cleanup']}}},{id:'equipment',resource_type:'equipment',title:'Equipment'}];
 const items={labor:[{id:'g1',name:'Tear off and install',metadata:{generated_from_pay_sheet:true,covers:['roofing.install']}}],equipment:[{id:'dumpster',name:'20 yard dumpster',metadata:{}}]};
 const cover=(name,mode,lines=[])=>({list_id:'labor',list_title:'Roof labor',assignee_name:name,mode,lines});
 const data={status:'open',counts:{open:1,warning:1,covered:2},reason:'',manual_work:[{item:'roofing.cleanup'}],available:[{item:'roofing.valleys',label:'Valleys',description:'Line and finish the valleys.'}],line_warnings:[{list_id:'labor',item_id:'g1',code:'duplicate',message:'Install roofing is also accounted for by Crew B.'}],requirements:[
  {id:'material:shingles',kind:'material',label:'Shingles',unit:'bundle',quantity:96,status:'covered',covered_by:[{list_id:'m',list_title:'Roof materials',assignee_name:'',mode:'paid',lines:[]}],warnings:[],can_cover:[]},
  {id:'roofing.install',kind:'work',label:'Install roofing',description:'Lay the new field roofing.',unit:'roofing_square',quantity:32,status:'warning',covered_by:[cover('Summit','paid',[{id:'g1',name:'Tear off and install',quantity:32,unit:'sq',total_cents:304000,generated:true}])],warnings:[{code:'duplicate',message:'Accounted for twice: Crew B and Summit.'}],can_cover:[]},
  {id:'roofing.cleanup',kind:'work',label:'Clean up',unit:'job',quantity:1,sources:[{set_id:'m1',title:'Added by hand',origin:'manual'},{set_id:'d1',title:'Roof proposal',origin:'document'}],status:'covered',covered_by:[cover('Summit','included')],warnings:[],can_cover:[]},
  {id:'disposal.debris',kind:'function',label:'Debris disposal',unit:'yd3',quantity:12.8,under:'roofing.tear_off',status:'open',covered_by:[],warnings:[],can_cover:[{list_id:'labor',list_title:'Roof labor',assignee_name:'Summit'}]}]};
 const calls=[],stored={};
 const ctx={state:{lists,requirements:{key:'org:project',loading:false,error:'',data},expandedRequirementIds:new Set(),assigningListId:''},setTimeout,clearTimeout,JSON,
  rootWindow:{localStorage:{getItem:key=>stored[key]??null,setItem:(key,value)=>{stored[key]=value;}}},cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,escapeHtml,money:value=>'$'+Number(value).toLocaleString('en-US'),
  orgId:()=>'org',projectId:()=>'project',apiReady:()=>false,window:{},workspaceIsEditing:()=>false,syncMaterialsGrid(){},materialRoot:()=>null,resourceType:list=>list.resource_type,listItems:list=>items[list?.id]||[],materialListById:id=>lists.find(list=>list.id===id),
  assignmentWorkResourceRef:list=>list?.assigned?{id:list.assigned,name:'Summit'}:null,resourceCategories:()=>[{id:'material',icon:'fa-cubes',color:'#d93025'},{id:'labor',icon:'fa-helmet',color:'#2563eb'},{id:'equipment',icon:'fa-truck',color:'#067647'}],resourceTerms:()=>({plural:'Equipment'}),captureProjectOperation:()=>({orgId:'org',projectId:'project'}),projectOperationIsCurrent:()=>true,showToast(){},equipmentOn:()=>true,laborAssignmentOn:()=>true,
  materialsAPI:{labor:{saveManualScope:async(org,project,work)=>{calls.push(['scope',org,project,work.map(entry=>entry.item)]);}}},
  patchScopeResourceList:async(id,patch)=>{calls.push(['patch',id,patch.metadata.work_scope.excluded_items]);},generateLaborList:async id=>{calls.push(['generate',id]);},updateItem:async(id,patch,listId)=>{calls.push(['update',listId,id,patch.metadata.covers]);}};
 vm.createContext(ctx);vm.runInContext("const REQUIREMENT_STATUS = { open: ['fa-circle-exclamation', 'Not accounted for'], warning: ['fa-triangle-exclamation', 'Accounted for, with something to check'], covered: ['fa-circle-check', 'Accounted for'] };"+['requirementsOpen','requirementsKey','requirementSet','loadRequirements','refreshRequirements','lineWarnings','requirementAmount','requirementKind','requirementWhy','requirementTooltip','renderRequirementRow','renderRequirementsTray','syncRequirementsTray','setWorkExcluded','setManualRequirement','markLineCover'].map(fn).join('\n'),ctx);
 // Closed by default: the bar alone carries the status, red for what is missing and yellow for what to check.
 let html=ctx.renderRequirementsTray();
 assert.match(html,/<aside class="mt-req-tray" data-mt-req-tray data-status="open"/);assert.match(html,/aria-expanded="false"/);
 assert.match(html,/mt-req-badge is-open" title="1 not accounted for">1<\/span>/,'the count sits inside the red circle');assert.match(html,/mt-req-badge is-warning" title="1 to check">1<\/span>/);assert.doesNotMatch(html,/mt-req-badge is-covered/);
 assert.doesNotMatch(html,/mt-column-total|>Total</,'requirements carry no money, so there is no total');
 // What is missing comes first, then what is to check, each under its own name; the rest is grouped below them.
 assert.deepEqual([...html.matchAll(/data-mt-req-group="([^"]+)"/g)].map(match=>match[1]),['missing','check','material','work']);
 assert.match(html,/<span>Missing<\/span><em>1<\/em>/);assert.match(html,/<span>To check<\/span><em>1<\/em>/);assert.doesNotMatch(html,/Needs attention/);
 // Under each one not settled, one short sentence says why.
 assert.match(html,/<small class="mt-req-why">Nothing on the work order takes care of this yet\.<\/small>/);assert.match(html,/<small class="mt-req-why">Accounted for twice: Crew B and Summit\.<\/small>/);
 assert.deepEqual([...html.matchAll(/data-mt-req-row="([^"]+)"/g)].map(match=>match[1]),['disposal.debris','roofing.install','material:shingles','roofing.cleanup']);
 assert.match(html,/Debris disposal<\/span><em>12\.8 yd³<\/em>/);
 // Each requirement carries the icon of the list that meets it, and says on hover what kind of thing it is.
 assert.match(html,/fa-helmet mt-req-kind" style="color:#2563eb"[^>]*><\/i><span>Install roofing/);assert.match(html,/fa-truck mt-req-kind[^>]*><\/i><span>Debris disposal/);assert.match(html,/fa-cubes mt-req-kind[^>]*><\/i><span>Shingles/);
 // The tooltip is short: what and how much, where it stands and why, what covers it. The long description is not in it.
 assert.match(html,/data-fm-tooltip-html="[^"]*fm-tooltip-title[^"]*Install roofing · 32 sq[^"]*To check[^"]*Accounted for twice: Crew B and Summit\.[^"]*By Tear off and install/);assert.doesNotMatch(html,/data-fm-tooltip-html="[^"]*Lay the new field roofing/);assert.match(html,/Install roofing<\/span><em>32 sq<\/em>/);assert.match(html,/Clean up<\/span><em><\/em>/);
 // Green only when nothing is missing and nothing is odd.
 ctx.state.requirements.data={...data,status:'covered',counts:{open:0,warning:0,covered:4}};assert.match(ctx.renderRequirementsTray(),/mt-req-badge is-covered" title="Everything is accounted for"/);
 ctx.state.requirements.data={...data,status:'empty',counts:{open:0,warning:0,covered:0},requirements:[],reason:'Nothing on this project names a kind of work yet.'};assert.match(ctx.renderRequirementsTray(),/Nothing on this project names a kind of work yet\./);
 ctx.state.requirements.data=data;
 // Open, a requirement shows the lines that account for it and what can be done about it.
 ctx.state.requirementsOpen=true;ctx.state.expandedRequirementIds=new Set(['roofing.install','disposal.debris','roofing.cleanup']);html=ctx.renderRequirementsTray();
 assert.match(html,/class="mt-req-tray is-open"/);
 // What no artifact has listed can be added by hand; what was added by hand says so and can be taken back.
 assert.match(html,/<select data-mt-req-add[^>]*><option value="">\+ Add<\/option><option value="roofing\.valleys" title="Line and finish the valleys\.">Valleys<\/option><\/select>/);
 assert.match(html,/data-fm-tooltip-html="[^"]*Clean up[^"]*Accounted for[^"]*By Summit[^"]*For Added by hand, Roof proposal/);assert.match(html,/<span>Added by hand<\/span><button type="button" class="mt-req-remove" data-mt-req-unrequire="roofing\.cleanup">Remove<\/button>/);
 await ctx.setManualRequirement('roofing.valleys',true);assert.equal(JSON.stringify(calls),JSON.stringify([['scope','org','project',['roofing.cleanup','roofing.valleys']]]));calls.length=0;
 await ctx.setManualRequirement('roofing.cleanup',false);assert.equal(JSON.stringify(calls),JSON.stringify([['scope','org','project',[]]]));calls.length=0;
 assert.match(html,/<div class="mt-req-cover-head" title="Summit: does this work, on these line items\.\nTear off and install, 32 sq · \$3,040"><strong>Summit<\/strong><em>Tear off and install<\/em><button type="button" class="mt-req-remove" data-mt-req-exclude="roofing\.install" data-mt-list-id="labor"[^>]*>Remove<\/button><\/div><\/div>/);assert.doesNotMatch(html,/<ul><li><span title="Tear off and install">Tear off and install<\/span><em>32 sq · \$3,040<\/em><\/li><\/ul>/);
 assert.match(html,/Accounted for twice: Crew B and Summit\./);assert.doesNotMatch(html,/Take off|<small>/,'the name is said once and how it is covered is on hover');
 assert.match(html,/title="Summit: does this work at no separate charge\."/);assert.doesNotMatch(html,/Paid for it|A line that takes care/);
 assert.match(html,/data-mt-req-include="disposal\.debris" data-mt-list-id="labor"[^>]*><i class="fas fa-plus" aria-hidden="true"><\/i><span>Summit</);
 assert.match(html,/<select data-mt-req-mark="disposal\.debris"[^>]*><option value="">Choose a line item<\/option><option value="equipment\|dumpster">20 yard dumpster · Equipment<\/option><\/select>/,'only a line item a person added can be chosen, never one the pay sheet wrote');
 // Work is done by labor: an equipment line item is never offered for it.
 ctx.state.requirements.data={...data,requirements:[{id:'roofing.ridge_cap',kind:'work',label:'Hip and ridge cap',unit:'ft',quantity:314,status:'open',covered_by:[],warnings:[],can_cover:[]}]};ctx.state.expandedRequirementIds=new Set(['roofing.ridge_cap']);items.labor.push({id:'hand',name:'Ridge cap install',metadata:{}});
 const work=ctx.renderRequirementsTray();assert.match(work,/<option value="labor\|hand">Ridge cap install · Summit<\/option>/);assert.doesNotMatch(work,/equipment\|dumpster/);ctx.state.requirements.data=data;
 // Taking work off a work order records it on the list and builds the list again; marking a line records it on the line.
 await ctx.setWorkExcluded('labor','roofing.install',true);assert.equal(JSON.stringify(calls),JSON.stringify([['patch','labor',['roofing.cleanup','roofing.install']],['generate','labor']]));
 calls.length=0;await ctx.setWorkExcluded('labor','roofing.cleanup',false);assert.equal(JSON.stringify(calls[0]),JSON.stringify(['patch','labor',[]]));
 calls.length=0;await ctx.markLineCover('equipment','dumpster','disposal.debris',true);assert.equal(JSON.stringify(calls),JSON.stringify([['update','equipment','dumpster',['disposal.debris']]]));
 assert.equal(ctx.lineWarnings('labor','g1')[0].code,'duplicate');assert.equal(ctx.lineWarnings('labor','other').length,0);
});

test('the Schedule button always does something: it places a planned job whole, or asks before scheduling each list by hand',async()=>{
 const escapeHtml=value=>String(value??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
 const lists=[{id:'m',resource_type:'material',status:'ordered'},{id:'l',resource_type:'labor',assigned:'sub'},{id:'e',resource_type:'equipment'}];
 const shown=[],focused=[],timers=[],toasts=[],asked=[],ensured=[],dispatched=[];let answer=true,found=true,placing='',grouped=false;
 const ctx={state:{lists,scopeDocuments:[],panelRoot:{},project:{id:'p',events:[{id:'span',kind:'schedule_group',status:'unscheduled'},{id:'old',kind:'schedule_group',status:'cancelled'}]}},setTimeout:fn=>{timers.push(fn);},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init?.detail;}},
  cleanText:value=>String(value??'').trim(),number:(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback,resourceType:list=>list.resource_type,listItems:()=>[{}],materialListOrdered:list=>list.status==='ordered',assignmentWorkResourceRef:list=>list.assigned?{id:list.assigned}:null,
  resourceSchedulePending:list=>!list.event,eventDateParts:event=>({date:event?.date||''}),linkedScheduleEvent:list=>list.event||null,orgId:()=>'org',projectId:()=>'p',apiReady:()=>true,materialsAPI:null,window:{},syncResourceHeader(){},
  schedulingOn:()=>true,rootWindow:{dispatchEvent:event=>dispatched.push(event.type),addEventListener(){},Portal:{modules:{projectSchedule:{context:()=>({mode:placing}),focusMaterialDelivery:payload=>{focused.push(payload.event_id);placing=found?'materials':'';return found;}}}}},scopeWorkspace:{showSidebarView:(root,view)=>shown.push(view),widenSidebar:(root,percent)=>shown.push('widen:'+percent)},requirementsOpen:()=>false,materialRoot:()=>null,leftContentRoot:()=>'rail',
  captureProjectOperation:()=>({}),projectOperationIsCurrent:()=>true,showToast:(title)=>toasts.push(title),confirmAction:async message=>{asked.push(message);return answer;},
  ensureScheduleEventForList:async list=>{ensured.push(list.id);return {list,event:{id:'event-'+list.id,...(grouped?{parent_event_id:'job'}:{})}};},schedulingFocusPayload:(list,event)=>({event_id:event.id,scope_resource_list_id:list.id})};
 vm.createContext(ctx);for(const name of ['laborCommitments','laborListDelivered','headerDone','jobSchedule','scheduleJobButton','startPlacing','makeRoomForSchedule','scheduleJob','syncScheduleState'])vm.runInContext(fn(name),ctx);
 const run=()=>{while(timers.length)timers.shift()();};
 // Ordered material is done; equipment with no date is not. Labor that is only assigned and built has not been sent to anyone.
 assert.equal(JSON.stringify(ctx.headerDone()),JSON.stringify({material:true,labor:false,equipment:false}));
 lists[1].revision=4;ctx.state.laborCommitments={key:'org:p',rows:[{list_id:'l',revision:2,status:'committed',delivery:{status:'pending'},list_revision:4}]};assert.equal(ctx.headerDone().labor,false,'committed but not delivered');
 ctx.state.laborCommitments.rows[0].delivery.status='delivered';assert.equal(ctx.headerDone().labor,true);lists[1].revision=5;assert.equal(ctx.headerDone().labor,false,'the list changed after it was sent');
 let html=ctx.scheduleJobButton();assert.match(html,/class="mt-schedule-job" data-mt-schedule-job[^>]*><i class="fas fa-calendar-days"[^>]*><\/i><span>Schedule<\/span>/);
 // A piece of work a scope planned is placed whole, with no question asked. Every list still gets its schedule item.
 await ctx.scheduleJob();assert.equal(JSON.stringify(shown),'["schedule","widen:60"]','the calendar gets room: the left side slides to 60%');assert.equal(asked.length,0);assert.equal(JSON.stringify(ensured),'["l","e","m"]','the work first, then equipment, then material');
 assert.equal(JSON.stringify(dispatched),'["fm:project-schedule:external"]','the schedule is told to read the project again');run();assert.equal(JSON.stringify(focused),'["span"]');
 // Lists the scope did not make get their events first; the server puts them under the job their scope defines, and
 // that job is placed whole, with no question asked.
 ctx.state.project.events=[];focused.length=0;ensured.length=0;dispatched.length=0;grouped=true;await ctx.scheduleJob();assert.equal(asked.length,0);assert.equal(JSON.stringify(ensured),'["l","e","m"]');run();assert.equal(JSON.stringify(focused),'["job"]');
 // Nothing groups them and no signed document: it says so and asks. Declining places nothing.
 grouped=false;focused.length=0;ensured.length=0;answer=false;await ctx.scheduleJob();assert.match(asked[0],/No document has been signed for this project/);assert.equal(timers.length,0);assert.equal(focused.length,0);
 // Agreeing starts placing the work by hand.
 answer=true;ensured.length=0;await ctx.scheduleJob();assert.equal(JSON.stringify(ensured),'["l","e","m"]');run();assert.equal(JSON.stringify(focused),'["event-l"]');
 // With a signed document whose scope groups nothing, the question says that instead.
 ctx.state.scopeDocuments=[{source:'document'}];asked.length=0;await ctx.scheduleJob();assert.match(asked[0],/^This project's scope does not say how its work/);run();
 // Asking again for what is already being placed does not switch placing off.
 focused.length=0;ctx.startPlacing({event_id:'event-l'});assert.equal(focused.length,0);run();
 // If the schedule is not placing anything shortly after, it says where to pick the job up rather than doing nothing.
 found=false;placing='';focused.length=0;toasts.length=0;ctx.startPlacing({event_id:'late'});assert.equal(focused.length,1,'asked once');run();assert.equal(JSON.stringify(toasts),'["Choose it on the schedule"]');found=true;
 // Everything dated: the button is green, says so, and clicking it only opens the schedule and says why.
 lists.forEach(list=>{list.event={date:'2026-10-20'};});ctx.state.project.events=[{id:'span',kind:'schedule_group',status:'scheduled',start_at:'2026-10-20T08:00:00Z'}];
 html=ctx.scheduleJobButton();assert.match(html,/class="mt-schedule-job is-done"[^>]*><i class="fas fa-check"[^>]*><\/i><span>Scheduled<\/span>/);assert.equal(ctx.headerDone().equipment,true);
 toasts.length=0;ensured.length=0;await ctx.scheduleJob();assert.equal(JSON.stringify(toasts),'["Already scheduled"]');assert.equal(ensured.length,0);
 // When the schedule saves, the header reads the project's dates again.
 ctx.state.project={id:'p',events:[]};ctx.rootWindow.activeBaseProject={id:'p',events:[{id:'x'}]};ctx.syncScheduleState();assert.equal(ctx.state.project.events.length,1);
});

test('list header actions move into the ⋮ menu by priority as the header narrows, and ⋮ shows only when it holds something',async()=>{
 const code='var LIST_NAME_ROOM=96;var listFitObserver=null;\n'+['css','renderListHeaderActions','renderLaborListControls','fitListActions','openListMore','closeListMore','listMoreDismiss','colorPortalHost'].map(fn).join('\n');
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:400}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setContent('<html><body><div id="root" data-materials-root></div></body></html>');
  const result=await page.evaluate(code=>{
   const list={id:'wo',resource_type:'labor',title:'',metadata:{},assignment:{work_resource_ref:{id:'crew2',name:'Crew 2 – Alvarez'}}};
   Object.assign(window,{state:{panelRoot:document.getElementById('root'),schedulingListId:'',laborMenu:null},cleanText:v=>String(v??'').trim(),escapeHtml:v=>String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),
    materialListOrdered:()=>false,resourceScheduleEnabled:()=>true,assignmentWorkResourceRef:entry=>entry.assignment?.work_resource_ref||null,laborListFinalized:()=>null,laborSettings:entry=>({id:entry.id,resource:entry.assignment.work_resource_ref}),materialRoot:()=>document.getElementById('root'),workOrderActions:()=>[],laborAssignmentOn:()=>true,equipmentOn:()=>true});
   (0,eval)(code);const style=document.createElement('style');style.textContent=css();document.head.append(style);
   const draw=width=>{document.getElementById('root').innerHTML=`<div style="width:${width}px"><header class="mt-list-head" data-mt-actions-head><button type="button" data-mt-collapse-list="wo"><i></i></button><input data-mt-list-name="wo" value="" placeholder="Default"><span class="mt-list-total">$685.05</span>${renderLaborListControls(list,{bare:true})}${renderListHeaderActions(list,'labor','')}</header></div>`;fitListActions(document.getElementById('root'));
    return {shown:[...document.querySelectorAll('[data-mt-action]')].filter(b=>!b.hidden).map(b=>b.dataset.mtAction),more:!document.querySelector('[data-mt-list-more]').hidden};};
   const narrow=draw(300),wide=draw(520);draw(300);
   openListMore(document.querySelector('[data-mt-list-more]'));
   return {narrow,wide,menu:[...document.querySelectorAll('[data-mt-list-more-menu] button span')].map(span=>span.textContent),bareHasNoActions:!/data-mt-labor-generate|data-mt-labor-more/.test(renderLaborListControls(list,{bare:true}))};
  },code);
  // Wide: every action in the header and no ⋮. Narrow: the most used stays, the rest move into ⋮ in priority order.
  assert.deepEqual(result.wide,{shown:['schedule','generate','payout','delete'],more:false});
  assert.equal(result.narrow.more,true);assert.ok(result.narrow.shown.length<4);
  assert.deepEqual(result.narrow.shown,['schedule','generate','payout','delete'].slice(0,result.narrow.shown.length),'actions leave from the least used end');
  assert.deepEqual(result.menu,['Generate from pay sheet','Pay out','Delete list'].slice(result.narrow.shown.length-1));
  assert.equal(result.bareHasNoActions,true,'the assignee control alone carries no actions; the header does');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
