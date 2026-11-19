import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// GP-116: every Feed entry but a post opens when tapped; a receipt opens in the file viewer, never as a
// download in a new tab, and the list's Time/Project toggle is neutral rather than tinted with the primary colour.
test('Feed rows open receipts in the viewer, activities in their project, and the sort toggle is neutral',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:700}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://open.test/**',route=>route.fulfill({contentType:'text/html',body:'<main id="feed" style="height:640px"></main>'}));
  await page.goto('http://open.test/');
  await page.evaluate(()=>{
   const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   const now=Date.now();
   window.opened=[];window.viewers=[];window.projectsOpened=[];
   window.open=(...args)=>{window.opened.push(args);return null;};
   window.FirstMateMarkup={openMediaViewer:options=>{window.viewers.push(options);return {close(){}};}};
   window.Portal={cfg:{userOrgId:'org',userId:'sam'},util:{escapeHtml,injectCSS:(_id,css)=>{const style=document.createElement('style');style.textContent=css;document.head.append(style);}},ui:{showToast:()=>{}},apps:{registerPortalApp:app=>window.feedApp=app},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>({}),replace:()=>{}},routeState:{get:()=>({})},
    modules:{request:{openProject:async(project,options)=>{window.projectsOpened.push({id:project.id,tab:options.tab});}}}};
   const projects=[{id:'project',data:{id:'project',title:'Open test',photos:[],documents:[]}}];
   const events=[{id:'paid',type:'payment.received',project_id:'project',actor_user_id:'sam',created_at:new Date(now-3600000).toISOString(),payload:{amount_cents:12500}}];
   window.PlatformAPI={projects:{list:async()=>({documents:projects})},users:{list:async()=>({documents:[{id:'sam',data:{name:'Sam Rivera'}}]})},projectDocuments:{list:async()=>({documents:[]})}};
   window.PaymentsAPI={receipts:{list:async()=>({receipts:[{id:'r1',title:'Lumber yard',content_type:'image/jpeg',file:{file_name:'receipt.jpg',content_type:'image/jpeg'},uploaded_at:new Date(now-60000).toISOString()}]}),fileUrl:(_org,id)=>`http://open.test/receipts/${id}/file`},invoices:{list:async()=>({invoices:[]})}};
   window.ChannelsAPI={feed:{catalog:async()=>({projects,events,media:[],users:[{id:'sam',name:'Sam Rivera'}],views:['list','posts'],can_comment:false,can_react:false,can_post:false,manual_posts:[],departments:[],user_departments:{}}),authorize:async(_org,refs)=>({sources:refs.map(ref=>({ref,key:ref.id,author:'sam'}))})},channels:{list:async()=>({channels:[]})},messages:{list:async()=>({messages:[]})}};
  });
  for(const file of ['channels-ui/channels-ui.js','apps/photos/feed.js'])await page.addScriptTag({content:await readFile(file==='apps/photos/feed.js'&&process.env.FEED_BROWSER_SCRIPT?process.env.FEED_BROWSER_SCRIPT:new URL(`../../libraries/${file}`,import.meta.url),'utf8')});
  await page.evaluate(()=>window.feedApp.mount(document.querySelector('#feed')));
  const receiptRow=page.locator('.pf-feed-list-row').filter({hasText:'Lumber yard'});
  await receiptRow.waitFor();
  await receiptRow.locator('.pf-feed-list-title').click();
  assert.equal(await page.evaluate(()=>window.viewers.length),1,'tapping the receipt row opens the viewer');
  const viewer=await page.evaluate(()=>{const options=window.viewers[0],photo=options.photos[options.index];return {media_type:photo.media_type,src:photo.src,count:options.photos.length};});
  assert.deepEqual(viewer,{media_type:'image',src:'http://open.test/receipts/r1/file',count:1});
  await receiptRow.locator('[data-feed-document-id]').click();
  assert.equal(await page.evaluate(()=>window.viewers.length),2,'the receipt thumbnail opens the viewer too');
  assert.deepEqual(await page.evaluate(()=>window.opened),[],'nothing opens in a new tab');
  const paymentRow=page.locator('.pf-feed-list-row').filter({hasNotText:'Lumber yard'}).first();
  await paymentRow.locator('.pf-feed-list-title').click();
  await page.waitForFunction(()=>window.projectsOpened.length===1);
  assert.deepEqual(await page.evaluate(()=>window.projectsOpened),[{id:'project',tab:'money'}],'a payment opens its project on Money');
  const active=page.locator('.pf-list-segment button.active');
  assert.equal(await active.evaluate(button=>getComputedStyle(button).backgroundColor),'rgb(234, 236, 240)','the active sort is neutral gray');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
