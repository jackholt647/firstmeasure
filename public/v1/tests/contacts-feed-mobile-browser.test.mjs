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
  assert.equal(await page.locator('.ct-sheet-head strong').textContent(),'Manage view','the sheet says what it is');
  assert.ok(await page.locator('[data-ct-manage-done]').evaluate(e=>e.getBoundingClientRect().height>=40));
  await page.locator('#ctSort').tap({force:true});
  await page.waitForSelector('[data-fm-select-menu]');
  assert.deepEqual(await page.locator('[data-fm-select-menu] [role=option]').allTextContents(),['Name','Recent','Project count'],'Order by opens the dropdown');
  await shot(page,'contacts-sheet-sort-390');
  await page.locator('[data-fm-select-menu] [role=option]',{hasText:'Recent'}).tap();
  assert.equal(await page.locator('#ctSort').inputValue(),'recent');
  assert.equal(await page.locator('[data-ct-manage]').evaluate(e=>e.open),true,'the sheet stays up for another change');
  await page.locator('#ctSort').tap({force:true});
  await page.locator('[data-fm-select-menu] [role=option]',{hasText:'Name'}).tap();
  await page.locator('[data-ct-manage-done]').tap();
  assert.equal(await page.locator('[data-ct-manage]').evaluate(e=>e.open),false,'Done puts it away');
  await page.locator('[data-ct-manage]>summary').click();
  await page.waitForTimeout(350);
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
  await d.locator('[data-ct-manage]>summary').click();
  assert.equal(await d.locator('.ct-sheet-head').isVisible(),false,'a desktop menu has no sheet title');
  assert.equal(await d.locator('#ctSort').evaluate(e=>getComputedStyle(e).pointerEvents),'auto','and keeps the browser select');
  await d.locator('[data-ct-manage]>summary').click();
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

async function contactWindowPage(browser,options){
 const context=await browser.newContext(options),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://contact.test/**',r=>r.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}main{position:relative;width:100vw;height:100vh}</style><main class="main"><div id="mainPanels"></div></main>'}));
 await page.goto('https://contact.test/');
 await page.evaluate(()=>{
  window.Portal={cfg:{orgId:'org'},modules:{},ui:{showToast(){}},PhotoFeed:{mountProjectGallery(node){node.innerHTML='<p class="media-mounted">Media</p>';}}};
  window.PlatformAPI={contacts:{settings:async()=>({settings:{tags:[{id:'vip',label:'VIP'},{id:'referral',label:'Referral partner'}]}}),projects:async()=>({projects:[]}),media:async()=>({media:[]}),get:async(_o,id)=>({contact:{id,name:'Avery Morgan'}}),update:async(_o,id,changes)=>{(window.saved=window.saved||[]).push(changes);return {contact:{id,...changes}};}},media:{fileUrl:()=>''}};
 });
 for(const file of ['window-manager/window-manager.js','window-manager/window-shell.js','apps/contacts/modal.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
 await page.evaluate(()=>Portal.modules.contacts.open({id:'c1',name:'Avery Morgan',phone:'5552013344',email:'avery@example.test'},{projects:[{id:'p1',title:'Oak Street roof',address:'1 Oak Street'}],projectsComplete:true}));
 await page.waitForSelector('#fmContactOverlay.active');
 await page.waitForTimeout(400);
 return {context,page,errors};
}
const tabBoxes=page=>page.locator('.fm-contact-tabs>button').evaluateAll(list=>list.filter(b=>b.getClientRects().length).map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent.trim(),height:Math.round(r.height),right:Math.round(r.right),fontSize:parseFloat(getComputedStyle(b).fontSize),selected:b.getAttribute('aria-selected')};}));

test('contact window on a phone: Details is its own tab, each tab shows only its content, no keyboard on open, the dropdown for selects; desktop unchanged',async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 try{
  const {page,errors,context}=await contactWindowPage(browser,PHONE);
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'BODY','nothing is focused, so the keyboard stays down');
  let tabs=await tabBoxes(page);
  assert.deepEqual(tabs.map(t=>t.text),['Details','Projects','Photos & Media','Docs']);
  assert.ok(tabs.every(t=>t.height>=44&&t.fontSize>=14&&t.right<=390),`thumb-sized tabs that fit: ${JSON.stringify(tabs)}`);
  assert.deepEqual(tabs.map(t=>t.selected),['true','false','false','false'],'a contact opens on Details');
  assert.equal(await page.locator('#fmContactFirstName').isVisible(),true);
  assert.equal(await page.locator('.fm-contact-right').isVisible(),false,'no view under the form');
  await shot(page,'contact-tab-details-390');
  // The phone label opens the dropdown, not the browser's picker; picking writes the select.
  await page.locator('#fmContactPrimaryPhoneLabel').tap({force:true});
  await page.waitForSelector('[data-fm-select-menu]');
  assert.deepEqual(await page.locator('[data-fm-select-menu] [role=option]').allTextContents(),['Home','Cell','Work','Other'],'the empty "Label…" is not a choice');
  assert.ok(await page.locator('[data-fm-select-menu] [role=option]').evaluateAll(list=>list.every(o=>o.getBoundingClientRect().height>=44)));
  await shot(page,'contact-label-menu-390');
  await page.locator('[data-fm-select-menu] [role=option]',{hasText:'Cell'}).tap();
  assert.equal(await page.locator('#fmContactPrimaryPhoneLabel').inputValue(),'cell');
  assert.equal(await page.locator('[data-fm-select-menu]').count(),0);
  await page.waitForFunction(()=>window.saved?.length,null,{timeout:3000});
  assert.equal(await page.evaluate(()=>window.saved.at(-1).custom_field_values.primary_phone_label),'cell','the choice saves like any change');
  await page.locator('#fmContactTagInput').tap({force:true});
  await page.waitForSelector('[data-fm-select-menu]');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-fm-select-menu]').count(),0,'Escape closes the dropdown');
  assert.equal(await page.locator('#fmContactOverlay.active').count(),1,'and not the contact');
  for(const [tab,shown] of [['Projects','#fmContactProjects'],['Photos & Media','.media-mounted'],['Docs','#fmContactDocs']]){
   await page.locator('.fm-contact-tabs>button',{hasText:tab}).tap();
   await page.waitForTimeout(150);
   assert.equal(await page.locator(shown).isVisible(),true,`${tab} shows its own content`);
   assert.equal(await page.locator('#fmContactFirstName').isVisible(),false,`the form is not above ${tab}`);
   const top=await page.locator(shown).evaluate(e=>Math.round(e.getBoundingClientRect().top));
   assert.ok(top<200,`${tab} starts at the top, not below the fold: ${top}`);
   assert.equal(await page.locator('.fm-contact-actions').isVisible(),true,'Call, Text and Email stay along the bottom');
   tabs=await tabBoxes(page);
   assert.deepEqual(tabs.filter(t=>t.selected==='true').map(t=>t.text),[tab]);
  }
  await shot(page,'contact-tab-docs-390');
  await page.locator('[data-fm-contact-more]').tap();
  await page.waitForSelector('.fm-contact-sheet.open');
  await page.getByRole('menuitem',{name:'Add employer'}).tap();
  await page.waitForSelector('#fmContactRelationshipPanel:not([hidden])');
  assert.equal(await page.locator('#fmContactRelationshipPanel').isVisible(),true,'Add employer goes back to Details, where its form is');
  await page.setViewportSize({width:360,height:740});
  await page.waitForFunction(()=>document.querySelector('.fm-contact-win').getBoundingClientRect().width<=360);
  await page.waitForTimeout(200);
  tabs=await tabBoxes(page);
  assert.ok(tabs.every(t=>t.right<=360),`the tabs fit at 360: ${JSON.stringify(tabs)}`);
  assert.ok(await noOverflow(page));
  assert.deepEqual(errors,[]);
  await context.close();

  const desktop=await contactWindowPage(browser,{viewport:{width:1600,height:1000}});
  const d=desktop.page;
  assert.equal(await d.evaluate(()=>document.activeElement?.id),'fmContactFirstName','a desktop still starts in First name');
  tabs=await tabBoxes(d);
  assert.deepEqual(tabs.map(t=>[t.text,t.height,t.fontSize]),[['Projects',32,11],['Photos & Media',32,11],['Docs',32,11]],'no Details tab and the same tabs');
  assert.equal(await d.locator('#fmContactFirstName').isVisible(),true);
  assert.equal(await d.locator('#fmContactProjects').isVisible(),true,'the form and the view side by side');
  assert.equal(await d.locator('#fmContactPrimaryPhoneLabel').evaluate(e=>getComputedStyle(e).pointerEvents),'auto','the browser select on a desktop');
  await d.locator('#fmContactPrimaryPhoneLabel').click();
  assert.equal(await d.locator('[data-fm-select-menu]').count(),0);
  assert.deepEqual(desktop.errors,[]);
 }finally{await browser.close();}
});

async function feedPage(browser,options,{views=['list','small','large','mosaic','posts'],route={},events:customEvents=null,flags=null,delay=0,camera=false,photoCount=6}={}){
 const context=await browser.newContext(options);
 const page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://feed.test/**',r=>r.fulfill({contentType:r.request().url().endsWith('.svg')?'image/svg+xml':'text/html',body:r.request().url().endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#87a5b8"/></svg>':'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main id="feed" style="height:100vh;padding:0 12px;box-sizing:border-box"></main></body></html>'}));
 await page.goto('http://feed.test/');
 await page.evaluate(({views,route,customEvents,flags,delay,photoCount})=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.__APP={userOrgId:'org',userId:'sam'};window.routes=[];window.openedProjects=[];window.docLists=0;
  window.Portal={cfg:window.__APP,util:{escapeHtml:esc,injectCSS:(id,css)=>{let s=document.getElementById('css_'+id);if(!s){s=document.createElement('style');s.id='css_'+id;document.head.append(s);}s.textContent=css;}},ui:{showToast:()=>{}},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs:()=>{}},appFlags:{has:()=>true,load:async()=>{},...(flags?{current:()=>flags,value:(group,flag)=>flags.raw?.[group]?.[flag]}:{})},navigation:{read:()=>route,replace:r=>window.routes.push(r)},routeState:{get:()=>({})},modules:{request:{openProject:async(project,options)=>{window.openedProjects.push({id:project.id,tab:options.tab,photo:options.photo||''});}}}};
  const at=new Date().toISOString();
  const photos=Array.from({length:photoCount},(_,i)=>({id:'photo'+i,media_id:'photo'+i,src:'/photo.svg',thumb:'/photo.svg',uploaded_at:at,uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera',metadata:{upload_batch_id:'batch'}}));
  const projects=[{id:'project',data:{id:'project',title:'Oak Street renovation',address:'104 Oak Street',photos}}];
  const events=customEvents || Array.from({length:6},(_,i)=>({id:'event'+i,type:'project.created',project_id:'project',actor_user_id:'sam',created_at:new Date(Date.now()-i*60000).toISOString(),payload:{title:'Site visit confirmed'}}));
  window.PlatformAPI={projects:{list:async()=>({documents:projects})},users:{list:async()=>({documents:[{id:'sam',data:{name:'Sam Rivera'}}]})},media:{thumbnailUrl:()=>'/photo.svg',markupThumbnailUrl:()=>'/photo.svg',fileUrl:()=>'/photo.svg'},projectDocuments:{list:async()=>{window.docLists++;return{documents:[]};}},publication:{resolveWidget:async()=>({status:'unavailable'}),read:async()=>({status:'ready',value:{}})}};
  window.ChannelsAPI={mediaFileUrl:()=>'/photo.svg',feed:{catalog:async()=>(delay&&await new Promise(r=>setTimeout(r,delay)),{projects,media:[],events,users:[{id:'sam',name:'Sam Rivera'}],views,can_comment:true,can_react:true,can_post:true,can_view_all_departments:true,manual_posts:[],departments:[{id:'sales',label:'Sales'}],user_departments:{sam:['sales']}}),authorize:async(_o,refs)=>({sources:refs.map(ref=>({ref,key:ref.id,author:'sam',at}))}),lookup:async()=>({root:{id:'root',reactions:[],reply_count:0},replies:[]}),resolve:async()=>({root:{id:'root',reactions:[],reply_count:0},replies:[]})},gifs:{config:async()=>({enabled:false})},channels:{list:async()=>({channels:[]})},messages:{list:async()=>({messages:[]})}};
 },{views,route,customEvents,flags,delay,photoCount});
 for(const file of [...(camera?['camera-capture/camera-capture.js']:[]),'platform-tags/platform-tags.js','channels-ui/channels-ui.js','audio-notes/audio-notes.js','apps/photos/feed.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
 await page.waitForFunction(()=>window.feedApp);
 await page.evaluate(()=>{
  // Whether the camera bar was already there when the first entries appeared (it must not arrive late over them).
  const observer=new MutationObserver(()=>{if(document.querySelector('.pf-feed-grid')&&window.barBeforeGrid===undefined){window.barBeforeGrid=!!document.querySelector('.fmc-bar');observer.disconnect();}});
  observer.observe(document.body,{childList:true,subtree:true});
  window.feedApp.mount(document.querySelector('#feed'));
 });
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

test('Feed entries on a phone: compact full-width text cards, plain copy, photo taps open the photo, calm filters with Reset and Done, a Write a post row; desktop keeps its grid',async()=>{
 const browser=await chromium.launch({executablePath:CHROME,headless:true});
 try{
  const at=i=>new Date(Date.now()-i*60000).toISOString();
  const events=[
   {id:'e1',type:'project.created',project_id:'project',actor_user_id:'sam',created_at:at(1),payload:{title:'104 Oak Street',address:'104 Oak Street'}},
   {id:'e2',type:'document.created',project_id:'project',created_at:at(2),payload:{document_type:'proposal'},feed_presentation:{description:'A document was created on a project.',group:'documents'}},
   {id:'e3',type:'material.lines.created',project_id:'project',created_at:at(3),payload:{title:'Materials from measurements',line_count:12},feed_presentation:{description:'A material set on the project got its first lines (entered by hand, or generated from a document, the scope or measurement defaults).',group:'materials'}},
   {id:'e4',type:'crew.change_order.drafted',project_id:'project',actor_user_id:'sam',created_at:at(4),payload:{},feed_presentation:{description:'Some internal description.',group:'field_work'}}
  ];
  const flags={raw:{platform:{}},effective:{platform:{}}};
  const {page,errors}=await feedPage(browser,PHONE,{events,flags,delay:300,camera:true,photoCount:3});
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>window.barBeforeGrid),true,'the camera bar is there before the entries');
  assert.equal(await page.evaluate(()=>window.docLists),0,'no project file lists are asked for when Project Docs is off');
  assert.equal(await shown(page),'large');
  const copy=await page.locator('.pf-feed-activity-copy>strong').allTextContents();
  assert.ok(copy.includes('Sam Rivera created a project'),'the project address is not repeated after the action: '+copy.join(' | '));
  assert.ok(copy.includes('Sam Rivera started a proposal'),'a document entry says what was started: '+copy.join(' | '));
  assert.ok(copy.includes('Sam Rivera listed 12 materials: Materials from measurements'),copy.join(' | '));
  assert.ok(copy.includes('Field work update'),'an event with no wording names its area, not its internal description');
  assert.ok(copy.every(text=>!/was created on a project|got its first lines|internal description|System/.test(text)),copy.join(' | '));
  const grid=await page.locator('.pf-feed-grid').first().boundingBox();
  const card=await page.locator('.pf-feed-activity').first().boundingBox();
  assert.ok(Math.abs(card.width-grid.width)<2,'text entries take the full width');
  assert.ok(card.height<=110,`text cards are compact (${card.height}px)`);
  const media=await page.locator('.pf-feed-media-card').evaluateAll(cards=>cards.map(c=>({w:Math.round(c.getBoundingClientRect().width),wide:c.classList.contains('pf-tile-wide')})));
  assert.ok(media.length>=1);
  assert.ok(media.filter(m=>!m.wide).every(m=>m.w<grid.width/2+2),'photos pair up in two columns');
  assert.equal(media.filter(m=>m.wide).length,media.length%2,'the last of an odd run of photos is full width');
  assert.ok(await noOverflow(page));
  await shot(page,'feed-compact-tiles-390');
  // A photo entry opens the photo (the project's Photos tab on that photo), not the project's Overview.
  await page.locator('.pf-feed-media-card .pf-tile-actor time').first().click();
  await page.waitForFunction(()=>window.openedProjects.length===1);
  assert.deepEqual(await page.evaluate(()=>window.openedProjects[0]),{id:'project',tab:'photos',photo:'photo0'});
  await page.getByRole('button',{name:'List',exact:true}).click();
  assert.equal(await page.locator('.pf-feed-list-row[data-feed-open-photo] img').first().getAttribute('loading'),'eager','list thumbnails paint as soon as the row shows');
  const row=page.locator('.pf-feed-list-row[data-feed-open-photo]').first();
  const box=await row.boundingBox();
  await page.mouse.click(box.x+box.width-12,box.y+box.height-8);
  await page.waitForFunction(()=>window.openedProjects.length===2);
  assert.equal(await page.evaluate(()=>window.openedProjects[1].photo),'photo0','tapping the row opens its photo');
  // Filters: a plain list with Reset and Done.
  await page.getByRole('button',{name:'Filter',exact:true}).click();
  await page.waitForTimeout(300);
  const option=await page.locator('.pf-activity-options>button').first().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderTopWidth,height:Math.round(e.getBoundingClientRect().height)}));
  assert.deepEqual(option,{bg:'rgba(0, 0, 0, 0)',border:'0px',height:52},'rows are untinted and unbordered');
  assert.equal(await page.locator('[data-feed-shown-reset]').isDisabled(),true,'nothing to reset yet');
  await page.locator('[data-feed-filter-id="calls"]').click();
  assert.equal(await page.locator('[data-feed-shown-reset]').isDisabled(),false);
  await shot(page,'feed-filters-390');
  await page.locator('[data-feed-shown-reset]').click();
  assert.equal(await page.locator('[data-feed-filter-id="calls"]').getAttribute('aria-pressed'),'true','Reset shows everything again');
  for(const selector of ['[data-feed-shown-reset]','[data-feed-shown-done]'])assert.ok((await page.locator(selector).boundingBox()).height>=44);
  await page.locator('[data-feed-shown-done]').click();
  assert.equal(await page.locator('[data-feed-shown-menu]').count(),0,'Done closes the sheet');
  // Posting from a phone: a Write a post row opens the composer full screen.
  const post=page.locator('.pf-mobile-post');
  assert.equal(await post.isVisible(),true);
  assert.deepEqual(await offered(page),['List','Tiles'],'the views stay List and Tiles');
  await post.click();
  await page.waitForTimeout(400);
  const dialog=await page.locator('[data-feed-compose]').boundingBox();
  assert.deepEqual([dialog.x,dialog.y,dialog.width,dialog.height].map(Math.round),[0,0,390,844],'the composer is a full-screen sheet');
  assert.ok((await page.locator('[data-feed-compose-close]').boundingBox()).width>=40);
  await shot(page,'feed-composer-390');
  await page.locator('[data-feed-compose-close]').click();
  await page.setViewportSize({width:360,height:740});
  assert.ok(await noOverflow(page),'no horizontal scroll at 360');
  assert.deepEqual(errors,[]);

  const desktop=await feedPage(browser,{viewport:{width:1600,height:1000}},{events,route:{feedDensity:'large'},photoCount:3});
  const d=desktop.page;
  assert.equal(await d.locator('.pf-mobile-post').count(),0,'Write a post is phone-only');
  assert.equal(await d.locator('.pf-feed-card.pf-tile-wide').count(),0,'desktop tiles keep their grid');
  assert.equal(await d.locator('.pf-feed-activity').first().evaluate(e=>getComputedStyle(e).display),'flex','desktop text tiles are unchanged');
  await d.getByRole('button',{name:'Filter',exact:true}).click();
  assert.equal(await d.locator('[data-feed-shown-done]').count(),0,'the desktop filter menu is unchanged');
  assert.ok(await d.evaluate(()=>window.docLists)>0,'with no flags to say otherwise the project file lists are read as before');
  assert.deepEqual(desktop.errors,[]);
 }finally{await browser.close();}
});
