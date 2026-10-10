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

test('scope sources include proposals, contracts and modules, and exclude unrelated documents', async () => {
  globalThis.window={PlatformAPI:{baseUrl:()=> 'https://fixture.test/v1/platform',request:async path=>path.includes('document-modules')?{instances:[{id:'workflow',moduleId:'roof-workflow',kind:'workflow'}]}:{documents:[
    {id:'proposal',title:'Roof proposal',document_type:'roofing_proposal'},
    {id:'change',title:'Gutters',document_type:'change_order'},
    {id:'invoice',document_type:'invoice'},{id:'old',document_type:'contract',status:'archived'}
  ]}}};
  try {
    const result=await module.loadDocuments('org','project');
    assert.deepEqual(result.documents.map(doc=>doc.id),['proposal','change','workflow']);
    const html=module.renderDocuments(result.documents);
    assert.match(html,/Roof proposal/);assert.match(html,/Gutters/);assert.match(html,/data-scope-source="module"/);
    assert.equal(result.error,'');
    window.PlatformAPI.request=async()=>{throw Error('denied')};
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
      window.Portal={navigation:{push:route=>window.openedScopeDocument=route}};
      const docs=document.createElement('div');docs.innerHTML=helper.renderDocuments([{id:'contract',title:'Roof contract',source:'document',thumbnail:'/missing.png'}]);document.body.append(docs);helper.bindDocuments(docs,'org','project');
    });
    await page.locator('.mt-scope-document-sheet i').waitFor();
    assert.equal(await page.locator('.mt-scope-document-sheet img').count(),0);
    await page.locator('[data-scope-document="contract"]').click();
    assert.deepEqual(await page.evaluate(()=>openedScopeDocument),{project:'project',projectTab:'docs',document:'contract'});
    const widths=()=>page.locator('.mt-resource-column').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().width));
    let w=await widths();assert.ok(Math.max(...w)-Math.min(...w)<2);assert.equal(await page.getByText('Empty List',{exact:true}).count(),3);
    await page.evaluate(()=>{state.lists=[{id:'m',resource_type:'material'},{id:'l',resource_type:'labor'}];items=Array.from({length:70},(_,i)=>({name:'Item '+i,section:i%2?'labor':'material',__material_list_id:i%2?'l':'m'}));draw()});
    w=await widths();assert.ok(w[0]>w[2]*2);assert.ok(w[1]>w[2]*2);
    await page.locator('.mt-resource-scroll').nth(0).evaluate(el=>el.scrollTop=200);
    assert.equal(await page.locator('.mt-resource-scroll').nth(1).evaluate(el=>el.scrollTop),0);
    assert.ok(await page.locator('.mt-resource-scroll').nth(0).evaluate(el=>el.scrollTop)>0);
    const divider=page.getByRole('separator');const box=await divider.boundingBox();
    await page.mouse.move(box.x+4,box.y+100);await page.mouse.down();await page.mouse.move(box.x+140,box.y+100);await page.mouse.up();
    assert.ok(Number(await divider.getAttribute('aria-valuenow'))>40);
    await divider.focus();await page.keyboard.press('Home');assert.equal(await divider.getAttribute('aria-valuenow'),'20');
    await page.setViewportSize({width:390,height:844});assert.equal(await divider.isVisible(),false);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
