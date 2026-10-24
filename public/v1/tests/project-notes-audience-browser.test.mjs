// The note visibility picker: sections only when they mean something, no heading for a lone section,
// and the retired "Application access" audience neither offered nor carried over.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const publicRoot=fileURLToPath(new URL('../../',import.meta.url));

const people=[{id:'me',name:'Adam Holt'},{id:'bea',name:'Bea Lin'},{id:'cy',name:'Cy Ortiz'}];
// One department, groups switched off: what an organization that has added nothing yet looks like.
const simple={users:people,note_audience_users:people,departments:[{id:'default',label:'Company'}],selectable_department_ids:['default'],note_department_visibility:true,note_crew_visibility:false,note_advanced_visibility:true,note_audience_organization_wide:true,note_audience_sections:{departments:false,groups:false,users:true},note_audience_groups:[],note_audience_group_kinds:[],note_department_label:'Departments'};
const structured={...simple,departments:[{id:'sales',label:'Sales'},{id:'prod',label:'Production'}],selectable_department_ids:['sales','prod'],note_audience_sections:{departments:true,groups:true,users:true},note_audience_groups:[{id:'g1',kind_id:'k1',label:'North Team',department_ids:['prod']}],note_audience_group_kinds:[{id:'k1',name:'Installer'}]};

async function open(browser,port,directory,rows=[],viewport={width:900,height:800}){
 const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}`);
 await page.evaluate(({directory,rows})=>{
  window.__APP={userOrgId:'org',userId:'me'};window.Portal={util:{injectCSS:(id,css)=>{if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}}};
  window.saved=[];window.visibilityUpdates=[];
  window.FirstMateChannels={createGifPickerButton:()=>Object.assign(document.createElement('button'),{type:'button',destroy(){}})};
  window.ChannelsAPI={directory:{list:async()=>directory},channels:{ensureProject:async()=>({channel:{id:'channel'}})},messages:{
   noteAuthors:async()=>({authors:[{id:'me',name:'Adam Holt',count:rows.length,archived_count:0}]}),
   list:async()=>({messages:rows.map(row=>({...row,reply_count:0})),channel:{separate_notes:false}}),thread:async()=>({replies:[]}),
   post:async(o,c,p)=>{window.saved.push(p);rows.push({...p,id:'n'+(rows.length+1),seq:rows.length+1,author:{id:'me',name:'Adam Holt'},created_at:new Date().toISOString(),metadata:{...p.metadata,project_note:true,department_ids:p.department_ids || [],note_audience_refs:p.audience_refs || []},can_edit:true,can_delete:true});return {message:rows.at(-1)};},
   updateVisibility:async(o,id,p)=>{window.visibilityUpdates.push(p);const row=rows.find(r=>r.id===id);row.metadata={...row.metadata,department_ids:p.department_ids || [],note_audience_crew:false,note_audience_refs:p.audience_refs || [],department_access:p.department_ids?.length || p.audience_refs?.length ? 'restricted' : 'shared'};return {message:row};}
  },uploads:{send:async()=>({})},mediaFileUrl:()=>''};
 },{directory,rows});
 await page.addScriptTag({url:'/libraries/project-notes/project-notes.js'});
 await page.evaluate(async()=>{window.notes=Portal.ProjectNotes.mount(document.querySelector('#notes'),{project:{id:'project'}});await notes.ready;});
 return {page,errors,menu:page.locator('.pn-audience-menu:not([hidden])')};
}

test('note visibility sections are gated by data and a lone section has no heading',async()=>{
 const server=createServer(async(req,res)=>{
  if(req.url.startsWith('/libraries/')){try{res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(await readFile(publicRoot+new URL(req.url,'http://fixture').pathname));}catch{res.writeHead(404);res.end();}return;}
  if(req.url.startsWith('/v1/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:Arial"><div id="notes" style="position:relative;max-width:360px;height:700px;margin:0 auto"></div></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
  // One department and no groups: Everybody, a search and the people, nothing else and no headings.
  {
   const {page,errors,menu}=await open(browser,port,simple,[],{width:375,height:740});
   await page.locator('.pn-composer .pn-visibility-button').click();
   assert.equal(await menu.locator('[data-audience-all]').isChecked(),true);
   assert.equal(await menu.locator('.pn-audience-group-label').count(),0,'A lone section has no heading');
   assert.equal(await menu.locator('input[type=checkbox]:not([data-audience-all]):not([data-audience-ref])').count(),0,'No department rows for one department');
   assert.equal(await menu.locator('[data-audience-ref=resource_group],[data-audience-ref=resource_group_kind],[data-audience-crew]').count(),0);
   assert.doesNotMatch(await menu.textContent(),/Application access|Advanced visibility|Individual users|Your Departments/i);
   assert.deepEqual(await menu.locator('[data-audience-ref=user]').evaluateAll(n=>n.map(i=>i.value)),['me','bea','cy']);
   const search=menu.getByRole('searchbox',{name:'Find people'});await search.click();await page.keyboard.type('bea');
   assert.deepEqual(await menu.locator('[data-audience-ref=user]').evaluateAll(n=>n.map(i=>i.value)),['bea']);
   assert.equal(await page.evaluate(()=>document.activeElement.matches('.pn-audience-search')),true,'Typing keeps focus in the search');
   await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.value),'bea','The match is next in tab order');
   await page.keyboard.press('Space');assert.equal(await menu.locator('[data-audience-all]').isChecked(),false);
   assert.equal(await page.evaluate(()=>document.activeElement.value),'bea','Focus stays on the box just checked');
   await search.fill('zzz');assert.match(await menu.textContent(),/No matches/);await search.fill('');
   const box=await menu.boundingBox();assert.ok(box.x>=0 && box.x+box.width<=375,'The menu fits a phone');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=375),true);
   await page.keyboard.press('Escape');
   await page.locator('.pn-composer textarea, .pn-composer [contenteditable]').first().fill('For Bea');await page.locator('.pn-composer [type=submit]').click();
   await page.waitForFunction(()=>saved.length===1);
   const sent=await page.evaluate(()=>saved[0]);assert.deepEqual(sent.audience_refs,[{kind:'user',id:'bea'}]);assert.deepEqual(sent.department_ids,[]);assert.equal('include_crew' in sent,false);
   assert.deepEqual(errors,[]);await page.close();
  }
  // Departments and groups exist: each section has a heading, groups use the organization's words.
  {
   const {page,errors,menu}=await open(browser,port,structured);
   await page.evaluate(()=>{window.PlatformTerminology={get:(key,fallback)=>key==='workforce.resource_group_plural' ? 'Teams' : fallback};window.dispatchEvent(new CustomEvent('fm:terminology:updated'));});
   await page.locator('.pn-composer .pn-visibility-button').click();
   assert.deepEqual(await menu.locator('.pn-audience-group-label').allTextContents(),['Your Departments','Teams','People']);
   assert.match(await menu.textContent(),/All Installer teams/);assert.match(await menu.textContent(),/North Team/);
   assert.equal(await menu.getByRole('searchbox',{name:'Find groups and people'}).count(),1);
   await menu.locator('input[value=sales]').check();await menu.locator('[data-audience-ref=resource_group_kind][value=k1]').check();
   assert.equal(await menu.locator('input[value=sales]').isChecked(),false,'A group replaces departments; the server refuses mixing');
   await page.keyboard.press('Escape');await page.close();assert.deepEqual(errors,[]);
  }
  // A note saved with the retired audience keeps its label until its author picks something else.
  {
   const legacy=[{id:'old',seq:1,text:'Old crew note',created_at:'2026-10-01T12:00:00Z',author:{id:'me',name:'Adam Holt'},audience:[],metadata:{project_note:true,department_access:'restricted',department_ids:[],note_audience_crew:true},can_edit:true,can_delete:true}];
   const {page,errors,menu}=await open(browser,port,simple,legacy);
   const card=page.locator('[data-project-note-id=old]');assert.match(await card.locator('footer').textContent(),/Crew Members/);
   await card.locator('.pn-visibility-button').click();
   assert.match(await menu.locator('.pn-audience-current').textContent(),/Current: Crew Members/);assert.equal(await menu.locator('[data-audience-all]').isChecked(),false);
   assert.equal(await menu.locator('[data-audience-crew]').count(),0);
   await menu.locator('[data-audience-ref=user][value=cy]').check();await menu.getByRole('button',{name:'Apply',exact:true}).click();
   await page.waitForFunction(()=>visibilityUpdates.length===1);const update=await page.evaluate(()=>visibilityUpdates[0]);
   assert.deepEqual(update.audience_refs,[{kind:'user',id:'cy'}]);assert.equal('include_crew' in update,false);
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser.close();server.close();}
});
