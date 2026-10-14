import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const source = await readFile(new URL('../../libraries/apps/materials/project.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.search(new RegExp(`  (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}
const code = ['css','laborAssignmentOptions','renderAssignBlock','renderLaborMenu','syncLaborMenu'].map(fn).join('\n');
const browser = await chromium.launch({...(process.platform === 'win32' ? {channel:'chrome'} : {}),headless:true});
test.after(() => browser.close());
async function fixture(width=1280,height=900,top=120) {
  const page = await browser.newPage({viewport:{width,height}});
  await page.setContent(`<main><button data-mt-labor-menu="list" style="position:fixed;top:${top}px;right:24px">Assign</button><div id="initial"></div></main>`);
  await page.addScriptTag({content:`
    const state={laborMenu:{listId:'list'},panelRoot:document.body};
    const cleanText=v=>String(v??'').trim(), number=(v,f)=>Number.isFinite(Number(v))&&v!=null?Number(v):f;
    const escapeHtml=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
    const list={id:'list'}, resources=[{id:'sales',name:'Sales'},{id:'partial',name:'Partial'},{id:'expensive',name:'Complete expensive'},{id:'best',name:'Complete best'},{id:'capable',name:'Capable without sheet'},{id:'unknown',name:'Unknown'}];
    let pay={loading:false}, requirements=[{kind:'work'}];
    let rows={sales:{overlap:0,sheet:true,complete:true,total_cents:1},partial:{overlap:1,sheet:true,total_cents:2},expensive:{overlap:2,sheet:true,complete:true,total_cents:400},best:{overlap:2,sheet:true,complete:true,total_cents:200},capable:{overlap:1}};
    const assigneePay=()=>pay, assigneePayFor=(_,id)=>rows[id], requirementSet=()=>({data:{requirements}}),workResourcesForScopeList=()=>resources;
    const assigneePayLabel=r=>r?.complete?'Complete estimate':'Estimate unresolved',assigneeKindPill=()=>'<span>Group</span>',assigneePills=()=>'<span>Work overlap</span>',workforceLabel=()=> 'Group';
    const laborSettings=()=>({id:'list',resourceId:'sales',resources,canRegenerate:true});
    const materialListById=()=>list,materialRoot=()=>document,closeLaborMenu=()=>{},colorPortalHost=()=>document.body;
    const loadAssigneePay=()=>Promise.resolve(),workspaceIsEditing=()=>false,syncMaterialsGrid=()=>{};
    window.writes=[];const assignWorkResource=(...args)=>window.writes.push(args),regenerateLaborListFromScope=()=>{};
    ${code}
    const style=document.createElement('style');style.textContent=css();document.head.append(style);
    window.draw=()=>{document.querySelector('#initial').innerHTML=renderAssignBlock(list);syncLaborMenu();};
    window.setData=(data)=>{if('pay'in data)pay=data.pay;if(data.requirements)requirements=data.requirements;if(data.rows)rows=data.rows;draw();};
    window.addMany=()=>{for(let i=0;i<40;i++){resources.push({id:'r'+i,name:'Available group '+i});rows['r'+i]={overlap:1,sheet:true,total_cents:500+i};}draw();};
    draw();
  `});
  return page;
}
test('initial and later assignment menus share eligibility and ranking, including selected incompatible assignees',async()=>{
 const page=await fixture();try{
 const expected=['best','expensive','partial','capable'];
 assert.deepEqual(await page.locator('[data-mt-assign-resource]').evaluateAll(nodes=>nodes.map(n=>n.dataset.mtAssignResource)),expected);
 assert.deepEqual(await page.locator('[data-mt-labor-assign]').evaluateAll(nodes=>nodes.map(n=>n.dataset.mtLaborAssign)),['',...expected]);
 assert.deepEqual(await page.evaluate(()=>writes),[]);
 await page.locator('[data-mt-labor-assign="best"]').click();
 assert.deepEqual(await page.evaluate(()=>writes),[['list','best']]);
 }finally{await page.close();}
});
test('without required work, both entry points offer pay sheets only; loading never exposes unverified choices',async()=>{
 const page=await fixture();try{
 await page.evaluate(()=>setData({requirements:[{kind:'material'}]}));
 assert.deepEqual(await page.locator('[data-mt-labor-assign]').evaluateAll(nodes=>nodes.map(n=>n.dataset.mtLaborAssign)),['','sales','best','expensive','partial']);
 await page.evaluate(()=>setData({pay:{loading:true},rows:{}}));
 assert.equal(await page.locator('[data-mt-labor-assign]').count(),1);
 assert.match(await page.locator('[role="status"]').textContent(),/Finding/);
 await page.evaluate(()=>setData({pay:{loading:false}}));
 assert.match(await page.locator('[role="status"]').textContent(),/No one has a pay sheet/);
 await page.evaluate(()=>setData({requirements:[{kind:'work'}]}));
 assert.match(await page.locator('[role="status"]').textContent(),/No assignees overlap/);
 }finally{await page.close();}
});
for(const [width,height,top] of [[1280,900,120],[1280,900,750],[390,844,380],[320,568,470]]){
 test(`assignment dropdown fits ${width}×${height} at y=${top}, with many scrollable options`,async()=>{
  const page=await fixture(width,height,top);try{
  await page.evaluate(()=>addMany());
  const box=await page.locator('.mt-assignment-portal').boundingBox();
  assert.ok(box.x>=7&&box.y>=7&&box.x+box.width<=width-7&&box.y+box.height<=height-7,JSON.stringify(box));
  assert.ok(box.width>=Math.min(550,width-16));
  const dimensions=await page.locator('.mt-assignment-portal .mt-labor-options').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
  assert.ok(dimensions.height>220);assert.ok(dimensions.scroll>dimensions.height);
  await page.locator('[data-mt-labor-assign="r39"]').click();assert.deepEqual(await page.evaluate(()=>writes),[['list','r39']]);
  if(width===1280&&top===120){await mkdir(new URL('../../../output/assignment-picker-20261014/',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../../../output/assignment-picker-20261014/desktop.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});}
  }finally{await page.close();}
 });
}
