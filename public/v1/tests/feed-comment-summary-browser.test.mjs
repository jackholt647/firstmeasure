import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('feed posts show up to four recent comment photos without a timestamp',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://feed.test/**',r=>r.fulfill({contentType:r.request().url().endsWith('.svg')?'image/svg+xml':'text/html',body:r.request().url().endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#87a5b8"/><path d="M0 430L350 80L650 380L900 180V600H0" fill="#365d71"/></svg>':'<html><body></body></html>'}));
  await page.goto('http://feed.test/');
  await page.setContent('<main id="feed" style="height:830px;margin:25px"></main>');
  await page.evaluate(()=>{
   const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.__APP={userOrgId:'org',userId:'sam'};
   window.Portal={cfg:window.__APP,util:{escapeHtml:esc,injectCSS:(id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);}},ui:{showToast:()=>{}},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs:()=>{}},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>({}),replace:()=>{}},routeState:{get:()=>({})},modules:{request:{openProject:async(project,options)=>{window.lastOpenedProject={project,options};}}}};
   const uploadedAt=new Date().toISOString();
   const photos=Array.from({length:20},(_,i)=>({id:'photo'+i,media_id:'photo'+i,src:'/photo.svg',thumb:'/photo.svg',uploaded_at:uploadedAt,uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera',metadata:{upload_batch_id:'batch-today'}}));
   const projects=[{id:'project',data:{id:'project',title:'Oak Street renovation',address:'104 Oak Street',photos,documents:[{id:'contract',type:'contract',type_label:'Document',title:'Roof replacement agreement',total_cents:2450000,created_at:'2026-09-29T13:00:00Z',metadata:{uploaded_by_user_id:'sam'}}]}}];
   const events=[...Array.from({length:5},(_,i)=>({id:'event'+i,type:'project.created',project_id:'project',actor_user_id:'sam',created_at:'2026-09-29T12:00:00Z',payload:{title:'Site visit confirmed'}})),{id:'appointment',type:'project.event_scheduled',project_id:'project',actor_user_id:'sam',created_at:uploadedAt,payload:{event_type_default_id:'sales_appointment',event:{id:'real-appointment',title:'Roof inspection and estimate',event_type_default_id:'sales_appointment'}}},{id:'stage-change',type:'work.plan.stage_manually_set',project_id:'project',actor_user_id:'sam',created_at:uploadedAt,payload:{from_stage_title:'New Lead',to_stage_title:'Pending Deposit'}},{id:'proposal-sent',type:'document.sent',project_id:'project',actor_user_id:'sam',created_at:uploadedAt,payload:{document_type:'proposal'}},{id:'proposal-viewed',type:'document.viewed',project_id:'project',actor_user_id:'sam',created_at:uploadedAt,payload:{document_type:'proposal'}},{id:'fake-signature',type:'document.signed',project_id:'project',created_at:uploadedAt,payload:{title:'Invented signature',synthetic:true}},{id:'fake-note',type:'note.created',project_id:'project',actor_user_id:'sam',created_at:uploadedAt,payload:{title:'Invented title',actor_name:'Wrong person',synthetic:true}},{id:'workflow-start',type:'work.plan.started',project_id:'project',created_at:uploadedAt}];
   window.PlatformAPI={projects:{list:async()=>({documents:projects})},users:{list:async()=>({documents:[{id:'sam',data:{name:'Sam Rivera',profile_photo_url:'/avatar.svg'}}]})},media:{thumbnailUrl:()=>'/photo.svg',markupThumbnailUrl:()=>'/missing-markup.svg',fileUrl:()=>'/photo.svg'},projectDocuments:{list:async()=>({documents:projects[0].data.documents})}};
   window.FirstMateMarkup={openPhotoViewer:options=>{window.lastViewerOptions=options;window.viewerOpens=(window.viewerOpens||0)+1;return{close(){}};}};
   window.rootMessage={id:'root',reply_count:0,reactions:[],author:{id:'sam',name:'Sam Rivera'}};window.replies=[];
   window.ChannelsAPI={feed:{catalog:async()=>({projects,media:[{id:'contract',content_type:'text/plain',owner:{type:'project',id:'project',slot:'documents'},metadata:{field:'documents'}}],events,users:[{id:'sam',name:'Sam Rivera',avatar:'/wrong.svg'}],views:['list','small','large','mosaic','posts'],can_comment:true,can_react:true}),authorize:async(_org,refs)=>({sources:refs.map(ref=>({ref,key:ref.kind==='media'?'media-batch':ref.id,author:'sam',at:uploadedAt}))}),lookup:async()=>({root:window.rootMessage,replies:window.replies}),resolve:async()=>({root:window.rootMessage,replies:window.replies}),thread:async()=>({root:window.rootMessage,replies:window.replies}),comment:async(_o,_id,body)=>{window.replies.push({...body,id:'comment',author:{name:'Sam Rivera'},created_at:new Date().toISOString(),can_edit:true,can_delete:true});window.rootMessage.reply_count++;window.rootMessage.reply_participants=['Sam','Dana','Morgan','Taylor'].map((name,index)=>({id:String(index),name,avatar:index?'/avatar.svg':''}));return{};},react:async(_o,_id,emoji,on)=>{window.rootMessage.reactions=on?[{emoji,count:1,reacted:true}]:[];}},channels:{list:async()=>({channels:[{id:'project-channel',type:'project',project_id:'project'}]})},messages:{list:async()=>({messages:[{id:'note-1',text:'The flashing needs a closer look before installation. The crew should take photos of the north edge and confirm that the replacement material matches the existing trim. Keep the back entry clear while the work is underway, then return tomorrow for one final photo after the sealant has cured. This gives the homeowner a clear record of the repair and lets the office confirm that the area is ready for the final walkthrough.',created_at:uploadedAt,metadata:{project_note:true},author:{id:'sam',name:'Sam Rivera',avatar:'/avatar.svg'}},{id:'note-2',text:'Done.',created_at:new Date(Date.parse(uploadedAt)-60000).toISOString(),metadata:{project_note:true},author:{id:'sam',name:'Sam Rivera',avatar:'/avatar.svg'}},{id:'note-3',text:'Customer confirmed driveway access. Stage materials on the left side of the garage.',created_at:new Date(Date.parse(uploadedAt)-120000).toISOString(),metadata:{project_note:true},author:{id:'sam',name:'Sam Rivera',avatar:'/avatar.svg'}}]})}};
  });
  for(const file of ['channels-ui/channels-ui.js','apps/photos/feed.js'])await page.addScriptTag({content:await readFile(new URL(`../../libraries/${file}`,import.meta.url),'utf8')});
  await page.waitForFunction(()=>window.feedApp);
  await page.evaluate(()=>window.feedApp.mount(document.querySelector('#feed')));
  await page.waitForFunction(()=>document.querySelectorAll('.pf-feed-card').length>=10);
  await page.getByRole('button',{name:'Posts',exact:true}).click();
  const post=page.locator('.pf-post').first();
  await post.waitFor();
  assert.equal(await post.locator('.pf-comment-people').count(),0);
  await post.getByRole('button',{name:'Comments',exact:true}).click();
  await post.locator('[data-comment-editor]').fill('Looks great');
  await post.getByRole('button',{name:'Post comment',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pf-comment-people'));
  const summary=post.locator('.pf-post-stats [data-post-comments]');
  assert.equal(await summary.locator('.pf-post-avatar').count(),4);
  assert.equal(await summary.locator('img').count(),3);
  assert.match(await summary.innerText(),/1 comment/);
  assert.doesNotMatch(await summary.innerText(),/Last reply|Last comment| at /);
  await page.setViewportSize({width:390,height:844});
  assert.ok(await summary.evaluate(element=>element.getBoundingClientRect().right <= innerWidth),'summary fits on mobile');
 }finally{await browser.close();}
});
