// The Feed's phone camera and its Unassigned group (photos/feed.js with camera-capture.js).
// Phone: 390x844 with a mobile user agent and Chrome's fake camera. Desktop: 1600x1000, no camera bar.
// FEED_SHOTS=<dir> also saves a screenshot of each state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib=new URL('../../libraries/',import.meta.url);
const CHROME=process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const PHONE={viewport:{width:390,height:844},userAgent:UA,isMobile:true,hasTouch:true,deviceScaleFactor:2};
const DESKTOP={viewport:{width:1600,height:1000}};
const ORIGIN='http://localhost:4818';
const shot=async(page,name)=>{if(process.env.FEED_SHOTS)await page.screenshot({path:`${process.env.FEED_SHOTS}/test-${name}.png`});};
const launch=()=>chromium.launch({executablePath:CHROME,headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});

// A Feed page with an in-memory server: uploads, the catalog, assign, the unassigned list and project search.
async function feedPage(browser,options,{unassigned=[]}={}){
  const context=await browser.newContext(options);
  await context.grantPermissions(['camera'],{origin:ORIGIN}).catch(()=>{});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(ORIGIN+'/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/media/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" fill="#87a5b8"/><path d="M0 330L160 190L300 300L420 220L600 340V450H0Z" fill="#4b6577"/></svg>'});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;font-family:Arial,sans-serif;--primary:#16a34a"><div id="mainPanels" style="height:100vh;padding:0 12px;box-sizing:border-box"><main id="feed" style="height:100%"></main></div></body></html>'});
  });
  await page.goto(ORIGIN+'/');
  await page.evaluate(({unassigned})=>{
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.__APP={userOrgId:'org',userId:'sam'};window.marker='same page';
    window.toasts=[];
    window.Portal={cfg:window.__APP,util:{escapeHtml:esc,injectCSS:(id,css)=>{let s=document.getElementById('css_'+id);if(!s){s=document.createElement('style');s.id='css_'+id;document.head.append(s);}s.textContent=css;}},ui:{showToast:(a,b)=>window.toasts.push([a,b])},apps:{registerPortalApp:app=>window.feedApp=app},tabs:{renderTabs:()=>{}},appFlags:{has:()=>true,load:async()=>{}},navigation:{read:()=>({}),replace:()=>{}},routeState:{get:()=>({})},modules:{request:{openProject:async()=>{}}}};
    const at=new Date(Date.now()-3600000).toISOString();
    const photos=Array.from({length:3},(_,i)=>({id:'photo'+i,media_id:'photo'+i,src:'/media/p.svg',thumb:'/media/p.svg',uploaded_at:at,uploaded_by_user_id:'sam',uploaded_by_name:'Sam Rivera',metadata:{upload_batch_id:'old'}}));
    const projects=[{id:'project',data:{id:'project',title:'Oak Street renovation',address:'104 Oak Street',photos,updated_at:at}},{id:'maple',data:{id:'maple',title:'Maple siding',address:'12 Maple Ave',photos:[],updated_at:at}}];
    const record=(id,batch,when,by='sam')=>({id,file_name:id+'.jpg',content_type:'image/jpeg',owner:{type:'organization',id:'org',slot:'photos'},metadata:{uploaded_by_user_id:by,uploaded_by_name:by==='sam'?'Sam Rivera':'Riley Chen',upload_batch_id:batch,uploaded_at:when},created_at:when,project_id:'',branch_id:'default',department_ids:[]});
    window.server={unassigned:unassigned.map(u=>record(u.id,u.batch,u.at||at,u.by)),projectMedia:[],uploads:[],assigns:[],catalogs:0,searches:[],failAssign:''};
    let seq=0;
    window.PlatformAPI={
      projects:{list:async()=>({documents:projects})},users:{list:async()=>({documents:[{id:'sam',data:{name:'Sam Rivera'}},{id:'riley',data:{name:'Riley Chen'}}]})},
      media:{thumbnailUrl:(o,id)=>'/media/'+id+'.svg',markupThumbnailUrl:(o,id)=>'/media/'+id+'.svg',fileUrl:(o,id)=>'/media/'+id+'.svg',
        upload:async(org,file,options)=>{server.uploads.push({org,name:file.name,options});const media=record('cam'+(++seq),options.metadata.upload_batch_id,options.metadata.uploaded_at);server.unassigned.push(media);return {ok:true,media};}},
      search:{projectsAndContacts:async(org,options)=>{const q=String(options.query||'').toLowerCase();server.searches.push(q);return {results:[{type:'project',id:'project',project_id:'project',title:'Oak Street renovation',subtitle:'104 Oak Street'},{type:'project',id:'maple',project_id:'maple',title:'Maple siding',subtitle:'12 Maple Ave'}].filter(r=>!q||(r.title+' '+r.subtitle).toLowerCase().includes(q))};}},
      request:async(path,options={})=>{
        if(path==='/organizations/org/media/assign'){
          const body=options.body;server.assigns.push(JSON.parse(JSON.stringify(body)));
          if(server.failAssign){const error=new Error('This photo already belongs to a project.');error.status=409;error.data={ok:false,error:server.failAssign};server.failAssign='';server.unassigned=server.unassigned.filter(m=>m.id!==server.goneId);throw error;}
          const moved=server.unassigned.filter(m=>body.media_ids.includes(m.id));
          server.unassigned=server.unassigned.filter(m=>!body.media_ids.includes(m.id));
          moved.forEach(m=>server.projectMedia.push({...m,owner:{type:'project',id:body.project_id,slot:'photos'},metadata:{...m.metadata,project_id:body.project_id,paired_from:'organization'}}));
          return {ok:true,project_id:body.project_id,media:moved,assigned:moved.map(m=>m.id),already_assigned:[],photos:[],thumbnail_photo_id:'',project_revision:2};
        }
        if(path==='/organizations/org/media?unassigned=true')return {ok:true,media:server.unassigned};
        throw new Error('unexpected request '+path);
      },
      projectDocuments:{list:async()=>({documents:[]})},publication:{resolveWidget:async()=>({status:'unavailable'}),read:async()=>({status:'ready',value:{}})}
    };
    window.ChannelsAPI={mediaFileUrl:()=>'/media/x.svg',feed:{
      catalog:async()=>{server.catalogs++;return {projects,media:server.projectMedia,unassigned_media:server.unassigned.slice(),can_assign_media:true,events:[],users:[{id:'sam',name:'Sam Rivera'},{id:'riley',name:'Riley Chen'}],views:['list','small','large','mosaic','posts'],can_comment:true,can_react:true,can_post:true,can_view_all_departments:true,manual_posts:[],departments:[],user_departments:{}};},
      authorize:async(_o,refs)=>({sources:refs.map(ref=>({ref,key:ref.id,author:'sam',at}))}),lookup:async()=>({root:null,replies:[]}),resolve:async()=>({root:null,replies:[]})},
      gifs:{config:async()=>({enabled:false})},channels:{list:async()=>({channels:[]})},messages:{list:async()=>({messages:[]})}};
  },{unassigned});
  for(const file of ['camera-capture/camera-capture.js','platform-tags/platform-tags.js','channels-ui/channels-ui.js','audio-notes/audio-notes.js','apps/photos/feed.js'])await page.addScriptTag({content:await readFile(new URL(file,lib),'utf8')});
  await page.waitForFunction(()=>window.feedApp);
  await page.evaluate(()=>window.feedApp.mount(document.querySelector('#feed')));
  await page.waitForFunction(()=>window.server.catalogs>0&&document.querySelector('.pf-feed-grid'));
  return {context,page,errors};
}
const rect=(page,selector)=>page.locator(selector).first().evaluate(el=>{const b=el.getBoundingClientRect();return {x:Math.round(b.x),y:Math.round(b.y),width:Math.round(b.width),height:Math.round(b.height)};});
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);

test('phone Feed camera: a shot uploads unpaired, Done asks for a project, picking one assigns the batch and the Feed moves it',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await feedPage(browser,PHONE);
    await page.waitForSelector('#feed>.fmc-bar');
    const bar=await rect(page,'#feed>.fmc-bar');
    assert.ok(bar.x>=12&&bar.x+bar.width<=378&&bar.height<=48&&bar.y+bar.height>=830,'a slim bar along the bottom of the Feed: '+JSON.stringify(bar));
    assert.equal(await page.locator('[data-feed-unassigned]').count(),0,'no Unassigned group while there is nothing unpaired');
    await shot(page,'phone-feed');
    await page.locator('#feed>.fmc-bar').click();
    await page.waitForSelector('#feed .fmc-stage.live');
    await page.waitForTimeout(450);
    const shell=await rect(page,'#feed>.fmc-shell');
    assert.deepEqual(shell,{x:0,y:0,width:390,height:844},'the camera fills the screen edge to edge');
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>window.server.uploads.length===1);
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.fmc-tile').length===2);
    await shot(page,'phone-camera');
    await page.locator('[data-fmc-done]').click();
    await page.waitForSelector('.fmc-step [data-feed-assign]');
    assert.equal(await page.locator('.fmc-step-head strong').textContent(),'Add to a project?');
    await page.waitForSelector('.fmc-step [data-assign-project="maple"]');
    assert.match(await page.locator('[data-assign-count]').textContent(),/^2 photos/);
    assert.equal(await page.locator('[data-assign-leave]').textContent(),'Leave unassigned');
    const leave=await rect(page,'[data-assign-leave]'),row=await rect(page,'[data-assign-project="maple"]');
    assert.ok(leave.y+leave.height<=844&&leave.y>=700,'Leave unassigned sits at the bottom, in thumb reach: '+JSON.stringify(leave));
    assert.ok(row.height>=56,'project rows are tall tap targets');
    assert.ok(await noOverflow(page));
    await shot(page,'phone-pick-project');
    const uploads=await page.evaluate(()=>window.server.uploads.map(u=>u.options));
    assert.equal(uploads.length,2);
    for(const options of uploads){
      assert.equal(options.ownerType,'organization');
      assert.equal(options.slot,'photos');
      assert.equal(options.ownerId,undefined,'no project is named');
      assert.equal(options.metadata.project_id,undefined);
    }
    assert.ok(uploads[0].metadata.upload_batch_id&&uploads[0].metadata.upload_batch_id===uploads[1].metadata.upload_batch_id,'one batch id for the camera session');
    const catalogs=await page.evaluate(()=>window.server.catalogs);
    await page.locator('[data-assign-project="maple"]').click();
    await page.waitForFunction(()=>window.server.assigns.length===1);
    assert.deepEqual(await page.evaluate(()=>window.server.assigns[0]),{project_id:'maple',media_ids:['cam1','cam2']});
    await page.waitForFunction(()=>!document.querySelector('#feed>.fmc-shell').classList.contains('open'));
    await page.waitForFunction(n=>window.server.catalogs>n,catalogs);
    await page.waitForSelector('[data-photo-feed-id="maple::cam1"]');
    assert.equal(await page.locator('[data-feed-unassigned]').count(),0,'nothing is left unassigned');
    assert.deepEqual(await page.evaluate(()=>window.toasts.at(-1)),['Added to project','2 photos added to 12 Maple Ave.']);
    assert.equal(await page.evaluate(()=>window.marker),'same page','no reload');
    // A second camera session gets its own batch.
    await page.locator('#feed>.fmc-bar').click();
    await page.waitForSelector('#feed .fmc-stage.live');
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>window.server.uploads.length===3);
    assert.notEqual(await page.evaluate(()=>window.server.uploads[2].options.metadata.upload_batch_id),uploads[0].metadata.upload_batch_id);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('phone Feed camera: Leave unassigned keeps the photos, and they show in the Unassigned group',async()=>{
  const browser=await launch();
  try{
    const {page,errors}=await feedPage(browser,PHONE);
    await page.waitForSelector('#feed>.fmc-bar');
    await page.locator('#feed>.fmc-bar').click();
    await page.waitForSelector('#feed .fmc-stage.live');
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>window.server.uploads.length===1);
    await page.locator('[data-fmc-shutter]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.fmc-tile').length===2);
    await page.locator('[data-fmc-done]').click();
    await page.waitForSelector('[data-assign-leave]');
    await page.locator('[data-assign-leave]').click();
    await page.waitForFunction(()=>!document.querySelector('#feed>.fmc-shell').classList.contains('open'));
    await page.waitForSelector('[data-feed-unassigned] [data-photo-feed-id="unassigned::cam2"]');
    assert.equal(await page.evaluate(()=>window.server.assigns.length),0,'nothing was assigned');
    assert.equal(await page.locator('[data-feed-unassigned-batch]').count(),1,'the burst is one batch');
    assert.equal(await page.locator('[data-feed-unassigned] .pf-thumb').count(),2);
    assert.match(await page.locator('[data-feed-unassigned] .pf-unassigned-head').textContent(),/Unassigned\s*2 photos not in a project yet/);
    assert.match(await page.locator('.pf-unassigned-batch-copy strong').textContent(),/Sam Rivera took 2 photos/);
    assert.equal(await page.evaluate(()=>window.toasts.at(-1)?.[0]),'Saved to Unassigned');
    const group=await rect(page,'[data-feed-unassigned]'),firstDay=await rect(page,'.pf-day');
    assert.ok(group.y<firstDay.y,'the group leads the Feed');
    assert.ok(group.x>=12&&group.x+group.width<=378,'it fits the phone');
    assert.ok(await noOverflow(page));
    await page.waitForTimeout(400);
    await shot(page,'phone-unassigned');
    // A sideways swipe over the photos scrolls; it does not start a selection.
    const tile=await rect(page,'[data-feed-unassigned] .pf-thumb');
    const cdp=await page.context().newCDPSession(page);
    const y=tile.y+tile.height/2;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tile.x+70,y}]});
    for(const x of [60,48,34,20,8])await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tile.x+x,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.pf-selectionbar').count(),0,'no selection from a swipe');
    // The batch's own Add to project opens the same picker as a bottom sheet.
    await page.locator('[data-feed-unassigned-assign]').click();
    await page.waitForSelector('[data-feed-assign-sheet] [data-assign-project="project"]');
    await page.waitForTimeout(350);
    const sheet=await rect(page,'.pf-assign-sheet');
    assert.ok(sheet.width===390&&Math.abs(sheet.y+sheet.height-844)<=1,'a bottom sheet: '+JSON.stringify(sheet));
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-assign-search]')),false,'the keyboard stays down');
    await shot(page,'phone-sheet');
    await page.locator('[data-assign-leave]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-feed-assign-sheet]'));
    assert.equal(await page.locator('[data-feed-unassigned] .pf-thumb').count(),2,'Keep unassigned changes nothing');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('desktop Feed: no camera bar; the Unassigned group assigns a batch, a selection, and explains a photo paired elsewhere',async()=>{
  const browser=await launch();
  try{
    const now=Date.now(),at=m=>new Date(now-m*60000).toISOString();
    const {page,errors}=await feedPage(browser,DESKTOP,{unassigned:[{id:'u1',batch:'b1',at:at(5)},{id:'u2',batch:'b1',at:at(6)},{id:'u3',batch:'b2',at:at(90),by:'riley'},{id:'u4',batch:'b2',at:at(91),by:'riley'},{id:'u5',batch:'b2',at:at(92),by:'riley'}]});
    await page.waitForSelector('[data-feed-unassigned]');
    assert.equal(await page.locator('#feed>.fmc-bar').isVisible(),false,'no camera bar on a desktop');
    assert.equal(await page.locator('#feed>.fmc-shell').isVisible(),false);
    assert.equal(await page.locator('[data-feed-unassigned-batch]').count(),2);
    assert.match(await page.locator('[data-feed-unassigned-batch]').nth(1).textContent(),/Riley Chen took 3 photos/);
    await shot(page,'desktop-unassigned');
    // A batch: Add to project, search, pick.
    await page.locator('[data-feed-unassigned-batch="sam:b1"] [data-feed-unassigned-assign]').click();
    await page.waitForSelector('[data-feed-assign-sheet]');
    const dialog=await rect(page,'.pf-assign-sheet');
    assert.ok(dialog.width===480&&dialog.x>500,'a centered dialog on a desktop: '+JSON.stringify(dialog));
    assert.equal(await page.evaluate(()=>document.activeElement?.matches('[data-assign-search]')),true,'the search has focus');
    await page.keyboard.type('maple');
    await page.waitForFunction(()=>window.server.searches.includes('maple')&&document.querySelectorAll('[data-assign-project]').length===1);
    await shot(page,'desktop-search');
    await page.locator('[data-assign-project="maple"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-feed-assign-sheet]'));
    assert.deepEqual(await page.evaluate(()=>window.server.assigns[0]),{project_id:'maple',media_ids:['u1','u2']});
    assert.equal(await page.locator('[data-feed-unassigned-batch="sam:b1"]').count(),0,'the batch leaves the group at once');
    await page.waitForSelector('[data-photo-feed-id="maple::u1"]');
    assert.equal(await page.evaluate(()=>window.marker),'same page','no reload');
    // Select two photos, and the selection bar's Add to project. The server says one is already in a project.
    await page.locator('[data-photo-select="unassigned::u3"]').click();
    await page.locator('[data-photo-select="unassigned::u4"]').click();
    await page.waitForSelector('[data-selection-assign]');
    assert.equal(await page.locator('[data-selection-delete]').count(),0,'Delete is for project photos');
    assert.match(await page.locator('.pf-selectionbar strong').textContent(),/2 selected/);
    await shot(page,'desktop-selection');
    await page.evaluate(()=>{window.server.failAssign='media_assigned_elsewhere';window.server.goneId='u3';});
    await page.locator('[data-selection-assign]').click();
    await page.waitForSelector('[data-feed-assign-sheet] [data-assign-project="project"]');
    await page.locator('[data-assign-project="project"]').click();
    await page.waitForSelector('.pf-assign-status.warn');
    assert.match(await page.locator('.pf-assign-status').textContent(),/1 of these photos is already in another project\. Pick a project for the remaining 1 photo\./);
    assert.match(await page.locator('[data-assign-count]').textContent(),/^1 photo$/);
    assert.equal(await page.locator('[data-assign-project="project"]').isDisabled(),false,'the list works again');
    await shot(page,'desktop-elsewhere');
    await page.locator('[data-assign-project="project"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-feed-assign-sheet]'));
    assert.deepEqual(await page.evaluate(()=>window.server.assigns.slice(1)),[{project_id:'project',media_ids:['u3','u4']},{project_id:'project',media_ids:['u4']}]);
    await page.waitForSelector('[data-photo-feed-id="project::u4"]');
    assert.equal(await page.locator('.pf-selectionbar').count(),0,'the selection ends with the assigned photos');
    assert.deepEqual(await page.locator('[data-feed-unassigned] .pf-thumb').evaluateAll(n=>n.map(t=>t.dataset.photoFeedId)),['unassigned::u5']);
    // Errors the person can act on are said plainly.
    await page.evaluate(()=>{window.server.failAssign='project_manage_denied';});
    await page.locator('[data-feed-unassigned-assign]').click();
    await page.waitForSelector('[data-feed-assign-sheet] [data-assign-project="maple"]');
    await page.locator('[data-assign-project="maple"]').click();
    await page.waitForSelector('.pf-assign-status.error');
    assert.match(await page.locator('.pf-assign-status').textContent(),/can’t add photos to 12 Maple Ave\. Pick another project/);
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!document.querySelector('[data-feed-assign-sheet]'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
