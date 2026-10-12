import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const publicRoot=fileURLToPath(new URL('../../',import.meta.url));
test('project notes share channel formatting and controls, preserve drafts, and fit narrow trays',async()=>{
 const server=createServer(async(req,res)=>{
  if(req.url==='/avatar.svg'){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30"><circle cx="15" cy="15" r="15" fill="#175cd3"/></svg>');return;}
  if(req.url.startsWith('/v1/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({departments:[],channels:[]}));return;}
  if(req.url.startsWith('/libraries/')) {try {res.setHeader('Content-Type',req.url.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8');const data=process.env.DEV_ASSETS ? await (async()=>{const r=await fetch('https://dev.1m8.ai'+req.url+'?notes-tray='+Date.now());assert.ok(r.ok);return Buffer.from(await r.arrayBuffer());})() : await readFile(publicRoot+req.url);res.end(data);}catch {res.writeHead(404);res.end();}return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial;--primary:#175cd3"><div id="notes" style="position:relative;z-index:2147483100;width:360px;height:760px;margin:20px;border:1px solid #e4e7ec"></div></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:900,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'me'};
   window.saved=[];window.failSave=false;window.voiceCalls=[];window.visibilityUpdates=[];
   const rows=[{id:'n1',text:'**Site update**\n- Confirm the delivery\n- Check access\n\n> Keep the driveway clear.',seq:1,created_at:'2026-10-11T17:00:00Z',author:{id:'me',name:'Adam Holt',avatar:'/avatar.svg'},audience:[],metadata:{project_note:true},can_edit:true,can_delete:true}];
   window.ChannelsAPI={directory:{list:async()=>({users:[{id:'adam',name:'Adam Holt',email:'adam@example.com'}],departments:[{id:'sales-id',label:'Sales'},{id:'crew-id',label:'Crew'},{id:'office-id',label:'Office'}],selectable_department_ids:['sales-id','crew-id','office-id'],note_department_visibility:true,note_crew_visibility:true})},channels:{ensureProject:async()=>({channel:{id:'channel'}})},messages:{list:async()=>({messages:rows.filter(row=>!row.parent_id),channel:{separate_notes:true}}),thread:async(o,id)=>({replies:rows.filter(row=>row.parent_id===id)}),post:async(o,c,p)=>{if(window.failSave)throw Error('Save failed');window.saved.push(p);rows.push({...p,attachments:(p.attachment_ids || []).map(id=>({id,file_name:id==='file1'?'plan.pdf':'audio.webm',content_type:id==='file1'?'application/pdf':'audio/webm',media_id:'media-'+id})),id:'n'+(rows.length+1),seq:rows.length+1,author:{id:'me',name:'Adam Holt'},created_at:new Date().toISOString(),metadata:{...p.metadata,project_note:true,department_ids:p.department_ids || [],note_audience_crew:!!p.include_crew,department_access:p.department_ids?.length || p.include_crew ? 'restricted':'shared'},can_edit:true,can_delete:true});return {message:rows.at(-1)};},updateVisibility:async(o,id,p)=>{if(window.failVisibility)throw Error('Visibility failed');window.visibilityUpdates.push(p);const row=rows.find(r=>r.id===id);row.audience=p.audience || [];row.metadata={...row.metadata,department_ids:p.department_ids || [],note_audience_crew:!!p.include_crew,department_access:p.department_ids?.length || p.include_crew ? 'restricted':'shared'};return {message:row};},edit:async(o,id,p)=>{window.saved.push(p);const row=rows.find(r=>r.id===id);Object.assign(row,p);row.edited_at=new Date().toISOString();if(p.department_ids)row.metadata={...row.metadata,department_ids:p.department_ids,note_audience_crew:!!p.include_crew,department_access:p.department_ids.length || p.include_crew ? 'restricted':'shared'};},pin:async(o,id)=>{rows.find(r=>r.id===id).pinned_at=new Date().toISOString();},unpin:async(o,id)=>{rows.find(r=>r.id===id).pinned_at=null;},remove:async(o,id)=>{Object.assign(rows.find(r=>r.id===id),{deleted_at:new Date().toISOString(),can_restore:true});},restore:async(o,id)=>{rows.find(r=>r.id===id).deleted_at=null;},revisions:async(o,id)=>({current:rows.find(r=>r.id===id),revisions:[{text:'Earlier wording',edited_at:'2026-10-11T18:00:00Z',edited_by_user:{name:'Adam Holt'}}]})},uploads:{send:async(o,file)=>({attachment:{id:'file1',file_name:file.name,content_type:'application/pdf',media_id:'m1'}})},mediaFileUrl:()=>'/file.pdf'};
   window.FirstMateAudioNotes={hydrate(){},prepareInline:async(o,c,options)=>{window.voiceCalls.push(options.mode);options.onRecordingState?.({stop(){}});options.onRecordingState?.(null);return {text:'Dictated update',attachment:{id:'audio1'},metadata:{duration_seconds:4}};}};
  });
  await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
  await page.addScriptTag({url:'/libraries/platform-tags/platform-tags.js'});
  await page.evaluate(()=>{
   const renderers=new Map();window.summaryCalls=[];
   window.FirstMateWidgets={attachRenderer:(id,v,r)=>renderers.set(id,r),mount:(host,reference,context)=>renderers.get('user.summary')(host,{data:{id:'me',name:'Adam Holt',profile_photo:'/avatar.svg',department:'Sales'},reference,context})};
   window.PlatformAPI={publication:{resolveWidget:async(org,request)=>{window.summaryCalls.push(request);return {status:'ready',widget:{id:'summary.user'}};}}};
  });
  await page.addScriptTag({url:'/libraries/platform-widgets/grouped-widgets.js'});
  await page.addScriptTag({url:'/libraries/project-notes/project-notes.js'});
  await page.evaluate(async()=>{window.notes=Portal.ProjectNotes.mount(document.querySelector('#notes'),{project:{id:'project'}});await notes.ready;});
  assert.deepEqual(await page.locator('.pn-compose-actions > button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Insert emoji','Attach a file','Dictate message','Record an audio note']);
  assert.deepEqual(await page.locator('.pn-composer .fm-ch-formatbar > button').evaluateAll(nodes=>nodes.map(n=>n.title)),['Bold','Italic','Strikethrough','Bulleted list','Numbered list','Quote']);
  await page.locator('.pn-avatar').first().hover();await page.locator('.fm-user-summary').waitFor();
  assert.equal(await page.locator('.fm-user-summary-name').textContent(),'Adam Holt');
  assert.equal(await page.evaluate(()=>summaryCalls[0].type),'summary.user');
  assert.equal(await page.evaluate(()=>summaryCalls[0].target.id),'me');
  assert.equal(await page.locator('.fm-user-summary').evaluate(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+15,r.top+15));}),true,'summary renders above the actual project-modal layer');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.pn-card-content strong').first().textContent(),'Site update');
  assert.equal(await page.locator('.pn-card-content li').count(),2);
  assert.equal(await page.locator('[type=submit]').isDisabled(),true);
  await page.evaluate(()=>document.fonts.ready);
  const editor=page.locator('.pn-composer [contenteditable]');
  for (const [name,markup] of [['Italic','_Formatted_'],['Strikethrough','~~Formatted~~'],['Bulleted list','- Formatted'],['Numbered list','1. Formatted'],['Quote','> Formatted']]) {
   await editor.fill('Formatted');
   await editor.evaluate(node=>{const r=document.createRange();r.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(r);});
   await page.getByRole('button',{name,exact:true}).click();
   assert.equal(await editor.evaluate(n=>n.value),markup);
   await editor.evaluate(n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  }
  for(const name of ['Bold','Italic','Strikethrough']){
   await editor.evaluate(n=>{n.value='';n.focus();const r=document.createRange();r.selectNodeContents(n);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);});
   const toggle=page.locator('.pn-composer .fm-ch-formatbar').getByRole('button',{name,exact:true});await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');assert.equal(await toggle.evaluate(n=>getComputedStyle(n).color),'rgb(217, 48, 37)');await editor.press('a');assert.equal(await toggle.getAttribute('aria-pressed'),'true');await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');
  }
  await editor.evaluate(n=>{n.value='**Bold** plain';n.focus();const r=document.createRange();r.setStart(n.querySelector('strong').firstChild,1);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});await page.waitForFunction(()=>document.querySelector('.pn-composer [data-format-toggle=bold]').getAttribute('aria-pressed')==='true');
  await editor.evaluate(n=>{const r=document.createRange();r.setStart(n.lastChild,2);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});await page.waitForFunction(()=>document.querySelector('.pn-composer [data-format-toggle=bold]').getAttribute('aria-pressed')==='false');
  await editor.evaluate(n=>n.value='');await editor.fill('Important update');
  await editor.evaluate(node=>{const r=document.createRange();r.selectNodeContents(node);const s=getSelection();s.removeAllRanges();s.addRange(r);});
  await page.getByRole('button',{name:'Bold',exact:true}).click();
  assert.equal(await editor.evaluate(n=>n.value),'**Important update**');
  await page.locator('.pn-composer .pn-visibility-button').click();
  await page.locator('.pn-audience-menu:not([hidden]) input[value="sales-id"]').check();
  await page.locator('.pn-audience-menu:not([hidden]) input[value="crew-id"]').check();
  await page.locator('[type=submit]').click();
  await page.waitForFunction(()=>saved.length===1 && !document.querySelector('.pn-error').textContent);
  assert.equal(await page.evaluate(()=>saved[0].text),'**Important update**');
  assert.deepEqual(await page.evaluate(()=>saved[0].department_ids),['sales-id','crew-id']);
  assert.match(await page.locator('.pn-card footer').first().textContent(),/Sales and Crew/);
  await page.getByRole('button',{name:'Dictate message',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pn-composer [contenteditable]').value==='Dictated update');
  assert.equal(await page.locator('.pn-uploads').textContent(),'');
  await page.getByRole('button',{name:'Record an audio note',exact:true}).click();
  await page.waitForFunction(()=>voiceCalls.length===2 && document.querySelector('[type=submit]').disabled===false);
  assert.equal(await page.locator('[data-audio]').isDisabled(),true);
  await page.locator('[type=submit]').click();
  await page.waitForFunction(()=>saved.length===2 && !document.querySelector('.pn-error').textContent);
  assert.deepEqual(await page.evaluate(()=>saved[1].attachment_ids),['audio1']);
  assert.equal(await page.evaluate(()=>saved[1].metadata.audio_note.duration_seconds),4);
  await page.locator('.pn-card .pn-menu summary').first().click();
  await page.locator('.pn-card [data-act=edit]').first().click();
  await editor.fill('New-note draft remains here');
  const inline=page.locator('.pn-inline-edit [contenteditable]');await inline.fill('Edited update');
  await mkdir(new URL('../../../output/notes-tray/',import.meta.url),{recursive:true});
  await page.locator('#notes').screenshot({path:fileURLToPath(new URL('../../../output/notes-tray/inline-edit.png',import.meta.url))});
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.waitForFunction(()=>saved.length===3 && !document.querySelector('.pn-error').textContent);
  assert.equal(await page.evaluate(()=>saved[2].text),'Edited update');
  await page.locator('.pn-card .pn-menu summary').first().click();await page.locator('.pn-card [data-act=edit]').first().click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await editor.evaluate(n=>n.value),'New-note draft remains here');
  await editor.fill('Keep this draft @Adam Holt');await page.evaluate(()=>window.failSave=true);
  await page.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.pn-error').textContent==='Save failed');
  assert.equal(await editor.evaluate(n=>n.value),'Keep this draft @Adam Holt');
  await page.evaluate(()=>window.failSave=false);
  await page.locator('[type=file]').setInputFiles({name:'plan.pdf',mimeType:'application/pdf',buffer:Buffer.from('demo')});
  await page.waitForFunction(()=>document.querySelector('.pn-error').textContent==='');
  await page.locator('[type=submit]').click();await page.waitForFunction(()=>saved.length===4 && !document.querySelector('.pn-error').textContent);
  assert.deepEqual(await page.evaluate(()=>saved[3].attachment_ids),['file1']);
  assert.equal(await page.evaluate(()=>saved[3].mention_users[0]?.id),'adam');
  // Exercise the picker callback with a deterministic selection; production uses the shared picker.
  await page.evaluate(()=>FirstMateChannels.mountEmojiPicker=(host,onPick)=>{host.innerHTML='<button type="button">Choose emoji</button>';host.firstChild.onclick=()=>onPick('👍');return {destroy(){host.replaceChildren();},focus(){}};});
  await page.getByRole('button',{name:'Insert emoji',exact:true}).click();await page.getByRole('button',{name:'Choose emoji'}).click();
  assert.equal(await editor.evaluate(n=>n.value),'👍');
  assert.equal(await page.locator('.pn-tools [type=search]').isVisible(),true);assert.equal(await page.locator('.pn-heading').count(),0);
  await page.locator('.pn-tools [type=search]').fill('does not exist');assert.match(await page.locator('.pn-history').textContent(),/No notes match/);await page.locator('.pn-tools [type=search]').press('Escape');assert.equal(await page.locator('.pn-tools [type=search]').inputValue(),'');
  assert.equal(await page.locator('.pn-tools').evaluate(n=>getComputedStyle(n).display),'grid');
  const firstMenu=page.locator('.pn-card .pn-menu summary').first();await firstMenu.click();
  assert.equal(await page.locator('.pn-menu[open]').count(),1);await page.mouse.click(800,40);assert.equal(await page.locator('.pn-menu[open]').count(),0);
  const original=page.locator('[data-project-note-id=n1]');await original.locator('summary').click();await original.getByRole('button',{name:'Pin Note',exact:true}).click();
  await page.locator('.pn-pin-toggle').waitFor();await page.locator('.pn-pin-toggle').click();await page.waitForFunction(()=>!document.querySelector('.pn-pin-toggle'));
  await original.locator('summary').click();assert.equal(await original.getByRole('button',{name:'View Edit History',exact:true}).count(),0);await original.locator('summary').click();const edited=page.locator('.pn-card').filter({hasText:'Edited update'});await edited.locator('summary').click();await edited.getByRole('button',{name:'View Edit History',exact:true}).click();await page.locator('.pn-history-pop').waitFor();
  assert.match(await page.locator('.pn-history-pop').textContent(),/Earlier wording/);await page.getByRole('button',{name:'Close edit history'}).click();assert.equal(await page.locator('.pn-history-pop').count(),0);
  await original.locator('summary').click();await original.getByRole('button',{name:'Archive Note',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-project-note-id=n1]'));
  await page.getByRole('button',{name:'Show Archived',exact:true}).click();await original.waitFor();assert.match(await original.textContent(),/Archived/);assert.match(await original.locator('.pn-card-content').textContent(),/Site update/);
  await page.getByRole('button',{name:'Hide Archived',exact:true}).click();await page.getByRole('button',{name:'Show Archived',exact:true}).click();await original.locator('summary').click();await original.getByRole('button',{name:'Unarchive Note',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-project-note-id=n1]').classList.contains('pn-archived'));await page.getByRole('button',{name:'Hide Archived',exact:true}).click();
  // Audience updates use their own writer and leave both note text and Add Note draft alone.
  const originalText=await original.locator('.pn-card-content').textContent();const draft=await editor.evaluate(n=>n.value);
  await original.locator('.pn-visibility-button').click();await page.locator('.pn-audience-menu:not([hidden]) input[value="sales-id"]').check();await page.locator('.pn-audience-menu:not([hidden]) [data-audience-crew]').check();await page.locator('.pn-audience-menu:not([hidden])').getByRole('button',{name:'Apply',exact:true}).click();
  await page.waitForFunction(()=>visibilityUpdates.length===1);assert.deepEqual(await page.evaluate(()=>visibilityUpdates[0].department_ids),['sales-id']);assert.equal(await page.evaluate(()=>visibilityUpdates[0].include_crew),true);
  assert.equal(await original.locator('.pn-card-content').textContent(),originalText);assert.equal(await editor.evaluate(n=>n.value),draft);assert.match(await original.locator('footer').textContent(),/Sales and Field crew/);
  assert.equal(await original.locator('footer .fa-eye').count(),1);assert.equal(await original.locator('[data-act=history]').count(),0);
  assert.equal(await original.locator('footer').evaluate(n=>getComputedStyle(n).borderTopWidth),'0px');
  await page.evaluate(()=>window.failVisibility=true);await original.locator('.pn-visibility-button').click();await page.locator('.pn-audience-menu:not([hidden]) input[value="office-id"]').check();await page.locator('.pn-audience-menu:not([hidden])').getByRole('button',{name:'Apply',exact:true}).click();await page.getByText('Visibility failed',{exact:true}).waitFor();await page.locator('.pn-audience-menu:not([hidden])').getByRole('button',{name:'Cancel',exact:true}).click();await page.evaluate(()=>window.failVisibility=false);
  assert.match(await original.locator('footer').textContent(),/Sales and Field crew/);
  for(const width of [360,280,240]) {
   await page.locator('#notes').evaluate((n,w)=>n.style.width=w+'px',width);
   assert.equal(await page.locator('.pn-workspace').evaluate(n=>n.scrollWidth<=n.clientWidth),true,`no overflow at ${width}px`);
   assert.equal(await page.locator('.pn-composer-box').evaluate(n=>[...n.querySelectorAll('.pn-compose-actions button')].every(b=>b.getBoundingClientRect().right<=n.getBoundingClientRect().right)),true);
  }
  await page.locator('#notes').evaluate(n=>n.style.width='360px');
  await page.evaluate(()=>document.activeElement.blur());
  await mkdir(new URL('../../../output/notes-tray/',import.meta.url),{recursive:true});
  await page.locator('.pn-composer-box').screenshot({path:fileURLToPath(new URL('../../../output/notes-tray/composer.png',import.meta.url))});
  await page.screenshot({path:fileURLToPath(new URL('../../../output/notes-tray/preview.png',import.meta.url))});
  // Replies share the rich composer and keep their own draft through root refreshes.
  assert.ok(await original.locator(':scope > header .pn-author').evaluate(n=>{const name=n.querySelector('span').getBoundingClientRect(),time=n.querySelector('time').getBoundingClientRect();return time.top-name.bottom<=1.5;}));
  await editor.fill('Separate Add Note draft');await original.locator(':scope > footer [data-act=replies]').click();
  const replyForm=original.locator('.pn-reply-compose'),replyEditor=replyForm.locator('[contenteditable]');assert.equal(await replyForm.isVisible(),false);await original.getByRole('button',{name:'Add Reply',exact:true}).click();await replyEditor.waitFor();
  assert.deepEqual(await replyForm.locator('.fm-ch-formatbar > button').evaluateAll(nodes=>nodes.map(n=>n.title)),['Bold','Italic','Strikethrough','Bulleted list','Numbered list','Quote']);
  assert.deepEqual(await replyForm.locator('.pn-compose-actions > button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Insert emoji','Attach a file','Dictate message','Record an audio note']);
  await replyEditor.fill('Reply draft survives');await page.evaluate(()=>notes.refresh());assert.equal(await replyEditor.evaluate(n=>n===document.activeElement),true);assert.equal(await replyEditor.evaluate(n=>n.value),'Reply draft survives');assert.equal(await editor.evaluate(n=>n.value),'Separate Add Note draft');
  await replyEditor.fill('Rich reply');await replyEditor.evaluate(n=>{const range=document.createRange();range.selectNodeContents(n);getSelection().removeAllRanges();getSelection().addRange(range);});await replyForm.getByRole('button',{name:'Bold',exact:true}).click();
  await replyForm.locator('[type=file]').setInputFiles({name:'reply-plan.pdf',mimeType:'application/pdf',buffer:Buffer.from('reply')});await replyForm.getByRole('button',{name:'Send reply',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.pn-reply-compose [type=submit]').disabled);
  const countBeforeReply=await page.evaluate(()=>saved.length);await replyEditor.press('Enter');await page.waitForFunction(n=>saved.length===n+1,countBeforeReply);await page.waitForFunction(()=>document.querySelector('.pn-reply-compose [contenteditable]').value==='');
  const postedReply=await page.evaluate(()=>saved.at(-1));assert.equal(postedReply.parent_id,'n1');assert.equal(postedReply.text,'**Rich reply**');assert.deepEqual(postedReply.attachment_ids,['file1']);
  const richReply=original.locator('.pn-reply-card').filter({hasText:'Rich reply'});assert.equal(await richReply.locator('header .pn-author>span').textContent(),'Adam Holt');assert.equal(await richReply.locator('.pn-card-content strong').textContent(),'Rich reply');assert.equal(await richReply.locator('.pn-file-item').count(),1);
  assert.ok(await richReply.evaluate(n=>n.querySelector('header').getBoundingClientRect().bottom<=n.querySelector('.pn-card-content').getBoundingClientRect().top));
  await richReply.locator('summary').click();await richReply.getByRole('button',{name:'Edit Reply',exact:true}).click();await richReply.locator('.pn-inline-edit [contenteditable]').fill('Edited reply');await richReply.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Edited reply',{exact:true}).waitFor();
  const editedReply=original.locator('.pn-reply-card').filter({hasText:'Edited reply'});await page.context().grantPermissions(['clipboard-read','clipboard-write']);await editedReply.locator('summary').click();await editedReply.getByRole('button',{name:'Copy text',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'**Edited reply**');
  await editedReply.locator('summary').click();await editedReply.getByRole('button',{name:'Archive Reply',exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll('.pn-reply-card')].some(n=>n.textContent.includes('Edited reply')));
  await page.getByRole('button',{name:'Show Archived',exact:true}).click();await editedReply.waitFor();assert.match(await editedReply.textContent(),/Archived/);assert.match(await editedReply.locator('.pn-card-content').textContent(),/Edited reply/);
  await editedReply.locator('summary').click();await editedReply.getByRole('button',{name:'Unarchive Reply',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.pn-reply-card.pn-archived'));await page.getByRole('button',{name:'Hide Archived',exact:true}).click();
  assert.equal(await replyForm.isVisible(),false);await original.getByRole('button',{name:'Add Reply',exact:true}).click();await replyEditor.fill('First line');await replyEditor.press('Shift+Enter');await replyEditor.press('a');assert.equal(await page.evaluate(()=>saved.length),countBeforeReply+2);assert.match(await replyEditor.evaluate(n=>n.value),/First line\na/);
  await page.evaluate(()=>window.failSave=true);await replyEditor.press('Enter');await replyForm.getByText('Save failed',{exact:true}).waitFor();assert.match(await replyEditor.evaluate(n=>n.value),/First line\na/);await page.evaluate(()=>window.failSave=false);
  await replyForm.getByRole('button',{name:'Dictate message',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.pn-reply-compose [contenteditable]').value.includes('Dictated update'));
  await replyForm.getByRole('button',{name:'Record an audio note',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.pn-reply-compose [type=submit]').disabled);await replyForm.getByRole('button',{name:'Insert emoji',exact:true}).click();await replyForm.getByRole('button',{name:'Choose emoji'}).click();
  await replyForm.getByRole('button',{name:'Send reply',exact:true}).click();await page.waitForFunction(n=>saved.length===n+3,countBeforeReply);assert.deepEqual(await page.evaluate(()=>saved.at(-1).attachment_ids),['audio1']);assert.equal(await page.evaluate(()=>saved.at(-1).metadata.audio_note.duration_seconds),4);
  assert.equal(await editor.evaluate(n=>n.value),'Separate Add Note draft');
  await original.getByRole('button',{name:'Add Reply',exact:true}).click();await replyEditor.fill('Collapsed draft');await replyForm.getByRole('button',{name:'Close reply composer'}).click();assert.equal(await replyForm.isVisible(),false);await original.getByRole('button',{name:'Add Reply',exact:true}).click();assert.equal(await replyEditor.evaluate(n=>n.value),'Collapsed draft');
  await original.locator(':scope > footer [data-act=replies]').click();await original.locator(':scope > footer [data-act=replies]').click();assert.equal(await replyForm.isVisible(),false);await original.getByRole('button',{name:'Add Reply',exact:true}).click();assert.equal(await replyEditor.evaluate(n=>n.value),'Collapsed draft');
  for(const width of [360,280,240]){await page.locator('#notes').evaluate((n,w)=>n.style.width=w+'px',width);assert.equal(await original.evaluate(n=>n.scrollWidth<=n.clientWidth),true,`reply fits ${width}px`);}
  await page.locator('#notes').evaluate(n=>n.style.width='360px');await original.scrollIntoViewIfNeeded();await original.screenshot({path:fileURLToPath(new URL('../../../output/notes-tray/replies.png',import.meta.url))});
  await page.evaluate(async()=>{await ChannelsAPI.messages.post('org','channel',{text:Array.from({length:18},(_,i)=>'Line '+i).join('\n\n'),department_ids:[]});await notes.refresh();});
  const longNote=page.locator('.pn-card').filter({hasText:'Line 17'}),more=longNote.getByRole('button',{name:'Show more',exact:true});await more.waitFor();
  assert.deepEqual(await more.evaluate(n=>{const s=getComputedStyle(n);return [s.backgroundColor,s.borderTopWidth,s.paddingLeft];}),['rgba(0, 0, 0, 0)','0px','0px']);
  await more.click();assert.equal(await longNote.locator('.pn-card-content').evaluate(n=>n.classList.contains('expanded')),true);await longNote.getByRole('button',{name:'Show less',exact:true}).click();assert.equal(await longNote.locator('.pn-card-content').evaluate(n=>n.classList.contains('expanded')),false);
  assert.equal(await page.locator('.pn-status').count(),0);
  assert.equal(await page.locator('[data-act=save]').count(),0);
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>notes.destroy());
 } finally {await browser.close();await new Promise(r=>server.close(r));}
});

