// My Contacts and Feed on a phone (390x844, mobile user agent) and unchanged on a desktop.
// MOBILE_SHOTS=<dir> also saves screenshots of each state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib=new URL('../../libraries/',import.meta.url);
const CHROME=process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PHONE={viewport:{width:390,height:844},userAgent:UA,isMobile:true,hasTouch:true,deviceScaleFactor:2};
const shot=async(page,name)=>{if(process.env.MOBILE_SHOTS)await page.screenshot({path:`${process.env.MOBILE_SHOTS}/test-${name}.png`});};
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);

async function contactsPage(browser,options){
 const context=await browser.newContext(options);
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://contacts.test/**',r=>r.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:sans-serif;background:#f0f2f5}main{position:relative;height:100vh}#ct{height:100vh;padding:12px;box-sizing:border-box}</style><main class="main"><div id="mainPanels"><section id="ct"></section></div></main>'}));
 await page.goto('https://contacts.test/');
 await page.evaluate(()=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.opened=[];window.routes=[];
  window.Portal={cfg:{orgId:'org'},util:{escapeHtml:esc,injectCSS:(id,css)=>{let s=document.getElementById('css_'+id);if(!s){s=document.createElement('style');s.id='css_'+id;document.head.append(s);}s.textContent=css;}},ui:{showToast(){}},
   apps:{registerPortalApp:app=>{window.ctApp=app;}},tabs:{renderTabs(){},activateTab(){}},appFlags:{current:()=>({}),has:()=>true,load:async()=>{}},
   navigation:{read:()=>({}),replace:r=>window.routes.push(r),push:r=>window.routes.push(r),registerSchema(){},registerHandler(){}},routeState:{get:()=>({})},
   modules:{contacts:{open:(contact,options)=>window.opened.push({contact,options}),close(){}}}};
  const project=(id,title,contactIds,days)=>({id,data:{id,title,address:`${id} Main Street`,updated_at:new Date(Date.now()-days*86400000).toISOString(),contacts:contactIds.map(id=>({id}))}});
  window.PlatformAPI={
   projects:{list:async()=>({documents:[project('p1','Oak Street roof',['c1'],1),project('p2','Maple siding',['c1','c2'],3),project('p3','Pine gutters',['c1'],5),project('p4','Elm windows',['c1'],9)]})},
   contacts:{listAll:async()=>[{id:'c1',name:'Avery Morgan',email:'avery@example.test',phone:'(555) 201-3344',tags:['vip']},{id:'c2',name:'Casey Brooks',phone:'555 777 1212'},{id:'c3',name:'Jordan Rivera',email:'jordan@example.test'}],settings:async()=>({settings:{tags:[{id:'vip',label:'VIP'}]}})},
   media:{fileUrl:()=>''}
  };
 });
 await page.addScriptTag({content:await readFile(new URL('apps/contacts/app.js',lib),'utf8')});
 await page.waitForFunction(()=>window.ctApp);
 await page.evaluate(()=>window.ctApp.mount(document.getElementById('ct')));
 await page.waitForSelector('.ct-table-row');
 return {context,page,errors};
}

test('My Contacts on a phone: no doubled title, one control row, tappable rows, sheet menu; desktop unchanged',async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 try{
  const {page,errors}=await contactsPage(browser,PHONE);
  assert.equal(await page.locator('.ct-title').isVisible(),false,'the mobile header carries the title and icon');
  assert.equal(await page.locator('.ct-mobile-count').textContent(),'3 contacts');
  const row=await page.evaluate(()=>[...document.querySelectorAll('.ct-mobile-count,.ct-segment,[data-ct-open-import],[data-ct-manage]>summary')].map(e=>{const r=e.getBoundingClientRect();return{top:Math.round(r.top+r.height/2),right:r.right};}));
  assert.equal(new Set(row.map(r=>r.top)).size,1,'count and controls share one row');
  assert.ok(row.every(r=>r.right<=390),'the control row fits the phone');
  assert.deepEqual(await page.locator('#ctViewTiles,#ctViewList,[data-ct-open-import],[data-ct-manage]>summary').evaluateAll(e=>e.map(b=>b.getAttribute('aria-label'))),['Tiles','List','Import contacts','Manage view'],'icon-only controls keep their names');
  const avery=page.locator('.ct-table-row').filter({hasText:'Avery Morgan'});
  assert.equal(await avery.locator('.ct-quick[href^="tel:"]').getAttribute('href'),'tel:5552013344');
  assert.equal(await avery.locator('.ct-quick[href^="mailto:"]').count(),1);
  assert.match(await avery.locator('.ct-row-meta').textContent(),/4 projects/);
  assert.equal(await avery.locator('.ct-list-count').isVisible(),false);
  assert.equal(await page.locator('.ct-table-row').filter({hasText:'Jordan Rivera'}).locator('.ct-row-meta').textContent(),'No projects');
  assert.ok(await noOverflow(page),'no horizontal scroll');
  await shot(page,'contacts-list-390');
  await avery.locator('.ct-row-meta').click();
  assert.equal(await page.evaluate(()=>window.opened.at(-1)?.contact.id),'c1','tapping the row opens the contact');
  await avery.locator('.ct-chip').first().click();
  assert.equal(await page.evaluate(()=>window.opened.length),1,'a project chip keeps its own action');
  await page.locator('[data-ct-manage]>summary').click();
  await page.waitForTimeout(350);
  const sheet=await page.locator('.fm-sharing-popover').evaluate(e=>{const r=e.getBoundingClientRect();return{position:getComputedStyle(e).position,bottom:Math.round(r.bottom),width:Math.round(r.width),fontSize:getComputedStyle(e.querySelector('select')).fontSize};});
  assert.deepEqual(sheet,{position:'fixed',bottom:844,width:390,fontSize:'16px'},'Manage view is a bottom sheet with zoom-safe selects');
  await shot(page,'contacts-sheet-390');
  await page.mouse.click(200,150);
  assert.equal(await page.locator('[data-ct-manage]').evaluate(e=>e.open),false,'tapping outside closes the sheet');
  assert.equal(await page.evaluate(()=>window.opened.length),1,'and does not open the row underneath');
  await page.locator('#ctViewTiles').click();
  assert.equal(await page.locator('.ct-project-slot.empty:visible').count(),0,'no empty project slots on a phone');
  assert.equal(await page.locator('.ct-card').filter({hasText:'Jordan Rivera'}).locator('.ct-project-list').isVisible(),false);
  assert.ok(await noOverflow(page));
  await shot(page,'contacts-tiles-390');
  await page.setViewportSize({width:360,height:740});
  assert.ok(await noOverflow(page),'no horizontal scroll at 360');
  assert.deepEqual(errors,[]);

  const desktop=await contactsPage(browser,{viewport:{width:1600,height:1000}});
  const d=desktop.page;
  assert.equal(await d.locator('.ct-title').isVisible(),true);
  for(const selector of ['.ct-mobile-count','.ct-row-quick','.ct-row-meta'])assert.equal(await d.locator(selector).first().isVisible(),false,`${selector} is phone-only`);
  assert.equal(await d.locator('[data-ct-manage]>summary').textContent(),' Manage view');
  await d.locator('.ct-table-row').first().locator('.ct-list-count').click();
  assert.equal(await d.evaluate(()=>window.opened.length),0,'desktop rows keep their own targets');
  assert.deepEqual(desktop.errors,[]);
 }finally{await browser.close();}
});

test('contact window on a phone: one scrolling column, fixed Call/Text/Email bar, More sheet; desktop unchanged',async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 try{
  for(const options of [PHONE,{viewport:{width:1600,height:1000}}]){
   const phone=options===PHONE;
   const context=await browser.newContext(options),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://contact.test/**',r=>r.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}main{position:relative;width:100vw;height:100vh}</style><main class="main"><div id="mainPanels"></div></main>'}));
   await page.goto('https://contact.test/');
   await page.evaluate(()=>{
    window.Portal={cfg:{orgId:'org'},modules:{},ui:{showToast(){}},PhotoFeed:{mountProjectGallery(node){node.innerHTML='<p>Media</p>';}}};
    window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[]}}),projects:async()=>({projects:[]}),get:async(_o,id)=>({contact:{id,name:'Avery Morgan'}})}};
   });
   for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/contacts/modal.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
   await page.evaluate(()=>Portal.modules.contacts.open({id:'c1',name:'Avery Morgan',phone:'5552013344',email:'avery@example.test'},{projects:[{id:'p1',title:'Oak Street roof',address:'1 Oak Street'}],projectsComplete:true}));
   await page.waitForSelector('#fmContactOverlay.active');
   await page.waitForTimeout(400);
   const more=page.locator('[data-fm-contact-more]');
   if(!phone){
    assert.equal(await more.isVisible(),false,'More is phone-only');
    assert.equal(await page.locator('#fmContactNewProject').isVisible(),true);
    assert.equal(await page.locator('.fm-contact-actions').evaluate(e=>getComputedStyle(e).position),'static');
    assert.equal(await page.locator('[data-add-relationship="employer"]').isVisible(),true);
    await context.close();continue;
   }
   const bar=await page.locator('.fm-contact-actions').evaluate(e=>{const r=e.getBoundingClientRect();return{position:getComputedStyle(e).position,bottom:Math.round(r.bottom),width:Math.round(r.width)};});
   assert.deepEqual(bar,{position:'fixed',bottom:844,width:390},'actions are a bar along the bottom');
   for(const name of ['Call','Text','Email'])assert.equal(await page.locator('.fm-contact-actions').getByRole('button',{name}).isEnabled(),true);
   assert.ok(await page.locator('.fm-contact-actions button').evaluateAll(b=>b.every(e=>e.getBoundingClientRect().height>=48)),'thumb-sized actions');
   assert.equal(await page.locator('#fmContactEmail').evaluate(e=>getComputedStyle(e).fontSize),'16px','inputs do not zoom the page on focus');
   assert.equal(await page.locator('#fmContactNewProject').isVisible(),false,'New Project moves into More');
   assert.equal(await page.locator('#fmContactRelationships').isVisible(),false,'empty relationships wait in More');
   const scroller=await page.locator('.fm-contact-content').evaluate(e=>({overflow:getComputedStyle(e).overflowY,fieldsOverflow:getComputedStyle(e.querySelector('.fm-contact-fields')).overflowY}));
   assert.deepEqual(scroller,{overflow:'auto',fieldsOverflow:'visible'},'one scrolling column');
   assert.ok(await noOverflow(page));
   await shot(page,'contact-detail-390');
   await more.click();
   await page.waitForSelector('.fm-contact-sheet.open');
   await page.waitForTimeout(300);
   assert.deepEqual(await page.locator('.fm-contact-sheet [role=menuitem]').allTextContents(),['New Project','Add employer','Add spouse']);
   await shot(page,'contact-more-390');
   await page.getByRole('menuitem',{name:'Add employer'}).click();
   await page.waitForSelector('#fmContactRelationshipPanel:not([hidden])');
   assert.equal(await page.locator('#fmContactRelationships').isVisible(),true,'the employer form opens in place');
   await page.waitForFunction(()=>!document.querySelector('.fm-contact-sheet'));
   await more.click();
   await page.waitForSelector('.fm-contact-sheet.open');
   await page.keyboard.press('Escape');
   await page.waitForFunction(()=>!document.querySelector('.fm-contact-sheet'));
   assert.equal(await page.locator('#fmContactOverlay.active').count(),1,'Escape closes only the sheet');
   assert.deepEqual(errors,[]);
   await context.close();
  }
 }finally{await browser.close();}
});

async function feedPage(browser,options,{views=['list','small','large','mosaic','posts'],route={}}={}){
 const context=await browser.newContext(options);
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://feed.test/**',r=>r.fulfill({contentType:r.request().url().endsWith('.svg')?'image/svg+xml':'text/html',body:r.request().url().endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#87a5b8"/></svg>':'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main id="feed" style="height:100vh;padding:0 12px;box-sizing:border-box"></main></body></html>'}));
 await page.goto('http://feed.test/');
 await page.evaluate(({views,route})=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.__APP={userOrgId:'org',userId:'sam'};window.routes=[];
  window.Portal={cfg:window.__APP,util:{escapeHtml:esc,injectCSS:(id,css)=>{let s=document.getElementById('css_'+id);if(!s){s=document.createElement('style');s.id='css_'+id;document.head.append(s);}s.textContent=css;}},ui:{showToast:()=>{}},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs:()=>{}},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>route,replace:r=>window.routes.push(r)},routeState:{get:()=>({})},modules:{request:{openProject:async()=>{}}}};
  const at=new Date().toISOString();
  const photos=Array.from({length:6},(_,i)=>({id:'photo'+i,media_id:'photo'+i,src:'/photo.svg',thumb:'/photo.svg',uploaded_at:at,uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera',metadata:{upload_batch_id:'batch'}}));
  const projects=[{id:'project',data:{id:'project',title:'Oak Street renovation',address:'104 Oak Street',photos}}];
  const events=Array.from({length:6},(_,i)=>({id:'event'+i,type:'project.created',project_id:'project',actor_user_id:'sam',created_at:new Date(Date.now()-i*60000).toISOString(),payload:{title:'Site visit confirmed'}}));
  window.PlatformAPI={projects:{list:async()=>({documents:projects})},users:{list:async()=>({documents:[{id:'sam',data:{name:'Sam Rivera'}}]})},media:{thumbnailUrl:()=>'/photo.svg',markupThumbnailUrl:()=>'/photo.svg',fileUrl:()=>'/photo.svg'},projectDocuments:{list:async()=>({documents:[]})},publication:{resolveWidget:async()=>({status:'unavailable'}),read:async()=>({status:'ready',value:{}})}};
  window.ChannelsAPI={mediaFileUrl:()=>'/photo.svg',feed:{catalog:async()=>({projects,media:[],events,users:[{id:'sam',name:'Sam Rivera'}],views,can_comment:true,can_react:true,can_post:true,can_view_all_departments:true,manual_posts:[],departments:[{id:'sales',label:'Sales'}],user_departments:{sam:['sales']}}),authorize:async(_o,refs)=>({sources:refs.map(ref=>({ref,key:ref.id,author:'sam',at}))}),lookup:async()=>({root:{id:'root',reactions:[],reply_count:0},replies:[]}),resolve:async()=>({root:{id:'root',reactions:[],reply_count:0},replies:[]})},gifs:{config:async()=>({enabled:false})},channels:{list:async()=>({channels:[]})},messages:{list:async()=>({messages:[]})}};
 },{views,route});
 for(const file of ['platform-tags/platform-tags.js','channels-ui/channels-ui.js','audio-notes/audio-notes.js','apps/photos/feed.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
 await page.waitForFunction(()=>window.feedApp);
 await page.evaluate(()=>window.feedApp.mount(document.querySelector('#feed')));
 await page.waitForSelector('.pf-feed-grid');
 return {context,page,errors};
}
const offered=page=>page.locator('.pf-density [data-density]').evaluateAll(b=>b.map(e=>e.getAttribute('aria-label')));
const shown=page=>page.locator('.pf-wrap').evaluate(e=>e.dataset.density);

test('Feed on a phone: title only in the mobile header, one control row, List and Tiles only, saved views fall back to Tiles',async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 try{
  const {page,errors}=await feedPage(browser,PHONE,{route:{feedDensity:'mosaic'}});
  assert.equal(await page.locator('.pf-title').isVisible(),false,'no in-content title or icon');
  assert.deepEqual(await offered(page),['List','Tiles']);
  assert.equal(await shown(page),'large','a saved mosaic view shows as Tiles');
  const row=await page.evaluate(()=>[...document.querySelectorAll('[data-feed-scope],.pf-density,[data-feed-shown]')].map(e=>{const r=e.getBoundingClientRect();return{mid:Math.round(r.top+r.height/2),right:r.right};}));
  assert.equal(new Set(row.map(r=>r.mid)).size,1,'scope, views and filter share one row');
  assert.ok(row.every(r=>r.right<=390));
  assert.ok(await noOverflow(page));
  await shot(page,'feed-tiles-390');
  await page.getByRole('button',{name:'Filter',exact:true}).click();
  await page.waitForTimeout(350);
  const sheet=await page.locator('[data-feed-shown-menu]').evaluate(e=>{const r=e.getBoundingClientRect();return{position:getComputedStyle(e).position,bottom:Math.round(r.bottom),width:Math.round(r.width)};});
  assert.deepEqual(sheet,{position:'fixed',bottom:844,width:390},'Filters is a bottom sheet');
  await page.locator('[data-feed-filter-group="activity"]').first().click();
  assert.equal(await page.evaluate(()=>window.routes.at(-1).feedDensity),'mosaic','changing a filter on a phone keeps the saved view for wider screens');
  await page.locator('[data-feed-shown-close]').click();
  await page.getByRole('button',{name:'List',exact:true}).click();
  assert.equal(await shown(page),'list');
  assert.equal(await page.evaluate(()=>window.routes.at(-1).feedDensity),'list','choosing a view on a phone saves it');
  assert.equal(await page.locator('.pf-toolbar .pf-list-controls').count(),0,'sort moves out of the control row');
  await page.getByRole('button',{name:'Filter',exact:true}).click();
  await page.locator('.pf-shown-sort [data-feed-list-organize="project"]').click();
  assert.equal(await page.evaluate(()=>window.routes.at(-1).feedListOrganize),'project','sort by project from the Filters sheet');
  await shot(page,'feed-list-filters-390');
  await page.locator('[data-feed-shown-close]').click();
  await page.locator('[data-feed-scope]').click();
  assert.equal(await page.locator('.pf-feed-scope-menu').evaluate(e=>getComputedStyle(e).position),'fixed','the audience menu is a bottom sheet');
  assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-feed-scope-search]')),false,'the keyboard stays down');
  await page.locator('[data-feed-scope]').click();
  await page.setViewportSize({width:360,height:740});
  assert.ok(await noOverflow(page),'no horizontal scroll at 360');
  await page.setViewportSize({width:1600,height:1000});
  await page.waitForFunction(()=>document.querySelectorAll('.pf-density [data-density]').length===5);
  assert.equal(await page.locator('.pf-title').isVisible(),true,'a wide screen keeps its title');
  assert.equal(await shown(page),'list');
  assert.deepEqual(errors,[]);

  const small=await feedPage(browser,PHONE);
  assert.equal(await shown(small.page),'large','the dense default shows as Tiles');
  const postsOnly=await feedPage(browser,PHONE,{views:['posts']});
  assert.deepEqual(await offered(postsOnly.page),['Posts'],'a posts-only feed keeps Posts');

  const desktop=await feedPage(browser,{viewport:{width:1600,height:1000}},{route:{feedDensity:'mosaic'}});
  assert.deepEqual(await offered(desktop.page),['List','Small tiles','Large tiles','Mosaic','Posts']);
  assert.equal(await shown(desktop.page),'mosaic');
  assert.equal(await desktop.page.locator('.pf-title').isVisible(),true);
  assert.deepEqual([...small.errors,...postsOnly.errors,...desktop.errors],[]);
 }finally{await browser.close();}
});
