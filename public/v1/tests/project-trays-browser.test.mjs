import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('project trays reuse Notes, Channels and the global agent and preserve drafts across tray switches', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1200,height:800}}), errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.setContent('<style>body{margin:0;font:14px Arial}.r-win{height:700px;display:flex;flex-direction:column}#shell{display:flex;flex:1;min-height:0;flex-direction:column}.r-preview{background:#eef2f6;flex:1}.r-modal-header{height:48px}#channel{height:650px}</style><div id="rOverlay" class="r-overlay"><section class="r-win"><div id="shell" class="r-right"><header class="r-modal-header r-window-bar"><div class="r-window-identity">Project controls</div><div class="r-tabbar"><button data-tab="map">Overview</button></div><div class="modal-shell-actions"></div><div class="r-window-bar-actions"></div></header><div class="r-preview">Overview content</div></div></section></div><div id="channel"></div>');
    await page.evaluate(() => {
      window.__APP={userOrgId:'org',userId:'user',userName:'Alex'};
      window.split=false; window.project={id:'project',title:'Roofing'};window.sent=[];window.notePosts=[];
      window.Portal={can:key => key === 'channels.separate_project_notes' ? window.split : true};
      window.rows=[{id:'old',text:'Pinned '+ 'long content '.repeat(90),pinned_at:'2026-09-29',seq:1,author:{id:'user',name:'Alex'},created_at:'2026-09-29T10:00:00Z',can_edit:true,can_delete:true,metadata:{project_note:true},audience:[],attachments:[]}];
      const channel=() => ({id:'channel',type:'project',project_id:'project',name:'Roofing',display_name:'Roofing',separate_notes:window.split,can_post:true,members:[],settings:{}});
      window.ChannelsAPI={
        channels:{ensureProject:async () => ({channel:channel()}),list:async () => ({channels:[channel()]}),get:async () => ({channel:channel()})},
        messages:{list:async (_org,_channel,params={}) => ({channel:channel(),messages:window.rows.filter(row=>params.view==='all'||params.view==='notes'||!window.split||!row.metadata.project_note)}),post:async (_org,_channel,body)=>{window.notePosts.push(body);const row={id:'new'+window.rows.length,seq:window.rows.length+1,author:{id:'user',name:'Alex'},created_at:new Date().toISOString(),can_edit:true,can_delete:true,attachments:[],...body,metadata:{...body.metadata,project_note:body.project_note===true},pinned_at:body.pin?new Date().toISOString():null};window.rows.push(row);return {message:row};},pin:async (_org,id)=>{window.rows.find(row=>row.id===id).pinned_at=new Date().toISOString();},unpin:async (_org,id)=>{window.rows.find(row=>row.id===id).pinned_at=null;},shareNote:async (_org,id)=>{window.rows.find(row=>row.id===id).metadata.note_shared={message_id:'shared'};},revisions:async()=>({revisions:[]})},
        pins:{list:async()=>({messages:window.rows.filter(row=>row.pinned_at)})},readState:{markRead:async()=>({})},saved:{add:async()=>({})},preferences:{get:async()=>({}),collaboration:async()=>({})},typing:{set:async()=>({})}
      };
      window.PlatformAPI={work:{activity:async()=>({events:[{id:'event',type:'project.scope.created',payload:{summary:'Scope created'},created_at:'2026-09-29T10:00:00Z'}]})},userActivity:{listForProject:async()=>({events:[]})}};
      window.histories=new Map();
      window.AssistantAPI={projectConversation:async (_org,pid)=>{const id='thread-'+pid;if(!window.histories.has(id))window.histories.set(id,[]);return {thread:{id}};},thread:async (_org,id)=>({thread:{id},messages:window.histories.get(id)}),send:async (_org,id,body)=>{window.sent.push({id,...body});window.histories.get(id).push({id:'u',role:'user',content:body.message},{id:'a',role:'assistant',content:'**Project scope** reviewed.'});return {thread:{id},assistant_message:{role:'assistant',content:'**Project scope** reviewed.'}};}};
    });
    for (const file of ['window-manager/project-layout.js','agent-chat/agent-chat.js','platform-assistant/platform-assistant.js','channels-ui/channels-ui.js','project-notes/project-notes.js','project-trays/project-trays.js'])
      await page.addScriptTag({content:await readFile(new URL(`../../libraries/${file}`,import.meta.url),'utf8')});
    const portal = await readFile(new URL('../../portal/index.php',import.meta.url),'utf8');
    assert.ok(portal.indexOf('project-trays/project-trays.js') > 0 && portal.indexOf('project-trays/project-trays.js') < portal.indexOf('apps/project-request/app.js'),'the static portal loader includes trays before the project app');
    await page.evaluate(() => {window.layout=window.FirstMateProjectLayout.mount({overlay:document.querySelector('#rOverlay'),getProject:()=>window.project,getTab:()=> 'map'});window.trays=window.FirstMateProjectTrays.mount(document.querySelector('#shell'),{orgId:'org',getProject:()=>window.project});});
    assert.equal(await page.locator('.fm-project-tray-tabs button').count(),4);
    assert.equal(await page.locator('#shell .r-modal-header').count(),0,'layout moved the header out of the content rail');
    assert.equal(await page.locator('.r-window-bar .fm-project-tray-tabs').count(),1);
    assert.equal(await page.getByRole('tab',{name:'Notes',exact:true}).isVisible(),true);
    await page.getByRole('tab',{name:'Notes',exact:true}).click();
    await page.waitForSelector('.pn-pinned .pn-card');
    assert.equal(await page.locator('.pn-pinned .pn-card').count(),1);
    await page.getByRole('button',{name:'Show More',exact:true}).click();
    assert.equal(await page.locator('.pn-card-content.expanded').count(),1);
    await page.getByRole('textbox',{name:'New project note'}).fill('Keep this draft');
    await page.getByRole('tab',{name:'Agent',exact:true}).click();
    await page.waitForSelector('.fma-welcome');
    assert.equal(await page.locator('.fm-project-tray>header').isVisible(),false);
    assert.equal(await page.locator('.fma-head [data-fma=closeSurface]').isVisible(),true);
    await page.getByRole('textbox',{name:'Message'}).fill('Review scope');
    await page.getByRole('button',{name:'Close assistant',exact:true}).click();
    assert.equal(await page.locator('.fm-project-content').getAttribute('data-tray-open'),'false');
    await page.getByRole('tab',{name:'Agent',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Message'}).inputValue(),'Review scope');
    await page.getByRole('tab',{name:'Notes',exact:true}).click();
    assert.equal(await page.locator('.fm-project-tray>header').isVisible(),true);
    assert.equal(await page.getByRole('textbox',{name:'New project note'}).inputValue(),'Keep this draft');
    await page.getByRole('button',{name:'Add pinned note',exact:true}).click();
    await page.waitForFunction(()=>window.notePosts.length===1);
    assert.equal(await page.evaluate(()=>window.notePosts[0].pin),true);
    assert.equal(await page.evaluate(()=>window.notePosts[0].project_note),true);
    await page.getByRole('tab',{name:'Agent',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'Message'}).inputValue(),'Review scope');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForSelector('.fma-msg.assistant strong');
    assert.equal(await page.evaluate(()=>window.sent[0].id),'thread-project');
    await page.evaluate(()=>{window.split=true;window.dispatchEvent(new CustomEvent('fm:capabilities:updated'));});
    assert.equal(await page.locator('.fm-project-tray-tabs button').count(),5);
    await page.getByRole('tab',{name:'Messages',exact:true}).click();
    await page.waitForSelector('.fm-project-tray .fm-ch');
    await page.getByRole('tab',{name:'Activity',exact:true}).click();
    await page.waitForSelector('.fm-project-activity article');
    assert.match(await page.locator('.fm-project-activity').textContent(),/Scope created/);
    await page.evaluate(()=>{window.project={id:'other',title:'Other project'};window.trays.update();});
    await page.getByRole('tab',{name:'Agent',exact:true}).click();
    await page.waitForSelector('.fma-welcome');
    assert.equal(await page.getByRole('textbox',{name:'Message'}).inputValue(),'');
    // The real Channels Notes subtab mounts the same note component.
    await page.evaluate(()=>window.channelView=window.FirstMateChannels.create(document.querySelector('#channel'),{orgId:'org',channelId:'channel',mode:'conversation',realtime:false,features:{resources:false,richMessages:false,typing:false,reads:false}}));
    await page.evaluate(()=>window.channelView.setChannel('channel'));
    await page.locator('#channel .fm-ch-tab').filter({hasText:'Notes'}).click();
    await page.waitForSelector('#channel .pn-workspace');
    assert.equal(await page.locator('#channel .pn-pinned .pn-card').count(),2);
    await page.evaluate(()=>{window.channelView.destroy();window.trays.destroy();window.layout.destroy();});
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
