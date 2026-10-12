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
  if(req.url.startsWith('/v1/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({departments:[],channels:[]}));return;}
  if(req.url.startsWith('/libraries/')) {try {res.setHeader('Content-Type',req.url.endsWith('.svg')?'image/svg+xml':'text/javascript; charset=utf-8');res.end(await readFile(publicRoot+req.url));}catch {res.writeHead(404);res.end();}return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial;--primary:#175cd3"><div id="notes" style="width:360px;height:760px;margin:20px;border:1px solid #e4e7ec"></div></body></html>');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:900,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'me'};
   window.saved=[];window.failSave=false;window.voiceCalls=[];
   const rows=[{id:'n1',text:'**Site update**\n- Confirm the delivery\n- Check access\n\n> Keep the driveway clear.',seq:1,created_at:'2026-10-11T17:00:00Z',author:{id:'me',name:'Adam Holt'},audience:[],metadata:{project_note:true},can_edit:true,can_delete:true}];
   window.ChannelsAPI={directory:{list:async()=>({users:[{id:'adam',name:'Adam Holt',email:'adam@example.com'}]})},channels:{ensureProject:async()=>({channel:{id:'channel'}})},messages:{list:async()=>({messages:rows,channel:{separate_notes:true}}),post:async(o,c,p)=>{if(window.failSave)throw Error('Save failed');window.saved.push(p);rows.push({...p,id:'n'+(rows.length+1),seq:rows.length+1,author:{id:'me',name:'Adam Holt'},created_at:new Date().toISOString(),metadata:{project_note:true},can_edit:true});},edit:async(o,id,p)=>{window.saved.push(p);Object.assign(rows.find(r=>r.id===id),p);}},uploads:{send:async(o,file)=>({attachment:{id:'file1',file_name:file.name,content_type:'application/pdf',media_id:'m1'}})},mediaFileUrl:()=>'/file.pdf'};
   window.FirstMateAudioNotes={hydrate(){},prepareInline:async(o,c,options)=>{window.voiceCalls.push(options.mode);options.onRecordingState?.({stop(){}});options.onRecordingState?.(null);return {text:'Dictated update',attachment:{id:'audio1'},metadata:{duration_seconds:4}};}};
  });
  await page.addScriptTag({url:'/libraries/channels-ui/channels-ui.js'});
  await page.addScriptTag({url:'/libraries/platform-tags/platform-tags.js'});
  await page.addScriptTag({url:'/libraries/project-notes/project-notes.js'});
  await page.evaluate(async()=>{window.notes=Portal.ProjectNotes.mount(document.querySelector('#notes'),{project:{id:'project'}});await notes.ready;});
  assert.deepEqual(await page.locator('.pn-compose-actions > button').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['Insert emoji','Attach a file','Dictate message','Record an audio note']);
  assert.deepEqual(await page.locator('.pn-composer .fm-ch-formatbar > button').evaluateAll(nodes=>nodes.map(n=>n.title)),['Bold','Italic','Strikethrough','Bulleted list','Numbered list','Quote']);
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
  await editor.fill('Important update');
  await editor.evaluate(node=>{const r=document.createRange();r.selectNodeContents(node);const s=getSelection();s.removeAllRanges();s.addRange(r);});
  await page.getByRole('button',{name:'Bold',exact:true}).click();
  assert.equal(await editor.evaluate(n=>n.value),'**Important update**');
  await page.locator('[type=submit]').click();
  await page.waitForFunction(()=>saved.length===1 && !document.querySelector('.pn-status').textContent);
  assert.equal(await page.evaluate(()=>saved[0].text),'**Important update**');
  await page.getByRole('button',{name:'Dictate message',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pn-composer [contenteditable]').value==='Dictated update');
  assert.equal(await page.locator('.pn-uploads').textContent(),'');
  await page.getByRole('button',{name:'Record an audio note',exact:true}).click();
  await page.waitForFunction(()=>voiceCalls.length===2 && document.querySelector('[type=submit]').disabled===false);
  assert.equal(await page.locator('[data-audio]').isDisabled(),true);
  await page.locator('[type=submit]').click();
  await page.waitForFunction(()=>saved.length===2 && !document.querySelector('.pn-status').textContent);
  assert.deepEqual(await page.evaluate(()=>saved[1].attachment_ids),['audio1']);
  assert.equal(await page.evaluate(()=>saved[1].metadata.audio_note.duration_seconds),4);
  await page.locator('.pn-card .pn-menu summary').first().click();
  await page.locator('.pn-card [data-act=edit]').first().click();
  await editor.fill('Edited update');await page.getByRole('button',{name:'Save note',exact:true}).click();
  await page.waitForFunction(()=>saved.length===3 && !document.querySelector('.pn-status').textContent);
  assert.equal(await page.evaluate(()=>saved[2].text),'Edited update');
  await page.locator('.pn-card .pn-menu summary').first().click();await page.locator('.pn-card [data-act=edit]').first().click();
  await page.getByRole('button',{name:'Cancel editing'}).click();
  assert.equal(await editor.evaluate(n=>n.value),'');
  await editor.fill('Keep this draft @Adam Holt');await page.evaluate(()=>window.failSave=true);
  await page.locator('[type=submit]').click();await page.waitForFunction(()=>document.querySelector('.pn-status').textContent==='Save failed');
  assert.equal(await editor.evaluate(n=>n.value),'Keep this draft @Adam Holt');
  await page.evaluate(()=>window.failSave=false);
  await page.locator('[type=file]').setInputFiles({name:'plan.pdf',mimeType:'application/pdf',buffer:Buffer.from('demo')});
  await page.waitForFunction(()=>document.querySelector('.pn-status').textContent==='');
  await page.locator('[type=submit]').click();await page.waitForFunction(()=>saved.length===4 && !document.querySelector('.pn-status').textContent);
  assert.deepEqual(await page.evaluate(()=>saved[3].attachment_ids),['file1']);
  assert.equal(await page.evaluate(()=>saved[3].mention_users[0]?.id),'adam');
  // Exercise the picker callback with a deterministic selection; production uses the shared picker.
  await page.evaluate(()=>FirstMateChannels.mountEmojiPicker=(host,onPick)=>{host.innerHTML='<button type="button">Choose emoji</button>';host.firstChild.onclick=()=>onPick('👍');return {destroy(){host.replaceChildren();},focus(){}};});
  await page.getByRole('button',{name:'Insert emoji',exact:true}).click();await page.getByRole('button',{name:'Choose emoji'}).click();
  assert.equal(await editor.evaluate(n=>n.value),'👍');
  await page.locator('[type=search]').fill('does not exist');assert.match(await page.locator('.pn-history').textContent(),/No notes match/);await page.locator('[type=search]').fill('');
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
  assert.deepEqual(errors,[]);
  await page.evaluate(()=>notes.destroy());
 } finally {await browser.close();await new Promise(r=>server.close(r));}
});

