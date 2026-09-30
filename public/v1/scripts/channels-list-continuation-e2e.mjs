// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve(process.env.CHANNELS_PUBLIC_ROOT || new URL('../../../public/', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));
const evidenceLabel=(process.env.EVIDENCE_LABEL || (process.env.DEV_ASSETS?'dev':'fixed')).replace(/[^a-z0-9-]/gi,'');
const output = path.resolve(process.env.OUTPUT_DIR || new URL('../../../output/channels-linear-20260930/pla21-round3/', import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1'));
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const data = name==='/libraries/channels-ui/channels-ui.js'&&process.env.CHANNELS_UI_FILE ? await readFile(process.env.CHANNELS_UI_FILE) : process.env.DEV_ASSETS ? Buffer.from(await (await fetch('https://dev.1m8.ai'+name+'?members='+Date.now())).arrayBuffer()) : await readFile(filename); response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
  catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log('Starting isolated browser', origin);
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1366,height:768}});
page.setDefaultTimeout(15000);
console.log('Browser ready');
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.evaluate(() => {
    window.invitedUsers = []; window.leftCalls = []; window.createdConversations = []; window.sent = []; window.scheduled = []; window.uploaded = [];
    const me = {id:'owner', name:'Morgan Lee'};
    const invitee = {id:'invitee',name:'Livia',email:'livia@example.test'};
    const other = {id:'guest', name:'Jordan Ellis',email:'jordan@example.test',title:'Project manager',department:'Operations',time_zone:'America/Los_Angeles',phone:'+1 555 0100',bio:'Helping the team deliver great projects.'};
    const agent = {id:'agent_assistant', name:'FirstMate'};
    const channel = {id:'general', type:'public', name:'general', message_seq:42, display_name:'Team room', members:[me,other,invitee], member_count:3, can_manage:true, unread:{last_read_seq:0}, settings:{}, permissions:{}, is_member:true};
    const messages = [{id:'message1', channel_id:'general', seq:1, text:'Ready for the **project review**?\n\n- Review the plan\n- Confirm next steps', author:other, created_at:new Date().toISOString(), can_edit:true, can_delete:true, reactions:[]}];
    window.sidebarPreferences = {send_mode:'enter'}; window.sidebarReads = []; window.splitOpened = null;
    window.testMessages = messages; window.testChannel = channel; window.createdHuddles = 0;
    let huddle;
    window.__APP = {userId:me.id, userOrgId:'test-org', userName:me.name};
    window.Portal = {currentUser:me, ui:{showToast:(title, detail) => window.lastToast = title + ': ' + detail}, appFlags:{current:()=>true, has:()=>true}};
    window.ChannelsAPI = {
      channels:{setNotifyLevel:async(_org,_id,userId,level)=>{channel.members.find(person=>person.id===userId).notify_level=level;return {}},list:async()=>({channels:[channel]}), get:async()=>({channel}), create:async(_org,input)=>{window.createdConversations.push(input);return {channel:{...channel,id:'assistant-new',type:'dm',display_name:input.name,members:[me,agent]}}}},
      messages:{get:async(_org,id)=>({message:messages.find(item=>item.id===id)}),list:async(_org,_channel,options={})=>({channel,messages:messages.filter(item=>!item.parent_id && (!options.before || item.seq<options.before)).slice(-(options.limit || 60))}),post:async(_org,_channel,input)=>{window.sent.push(input);const message={...messages[0],...input,id:'sent'+window.sent.length,author:me,seq:window.sent.length+1};if(input.forwarded_message_id){const original=messages.find(item=>item.id===input.forwarded_message_id);message.metadata={forwarded:{...original,message_id:original.id,channel_name:'Team room'}};message.attachments=input.forward_include_attachments?original.attachments:[];}messages.push(message);return {message}},edit:async(_org,id,input)=>({message:{...messages[0],...input,id}}),thread:async(_org,id)=>({root:messages.find(item=>item.id===id),replies:messages.filter(item=>item.parent_id===id)})},
      preferences:{collaboration:async()=>({preferences:{...window.sidebarPreferences}}),updateCollaboration:async(_org,patch)=>{Object.assign(window.sidebarPreferences,patch);return {preferences:{...window.sidebarPreferences}}}},
      directory:{list:async()=>({users:[me,other,agent,{id:'outsider',name:'Outside Person'}]})},
      readState:{markRead:async(_org,id,seq)=>{window.sidebarReads.push({id,seq});return {}}},
      drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
      scheduled:{list:async()=>({scheduled_messages:window.scheduled}),remove:async(_org,id)=>{window.scheduled=window.scheduled.filter(item=>item.id!==id);return {}},create:async(_org,input)=>{const item={...input,id:'scheduled'+(window.scheduled.length+1),state:'scheduled',sender_user_id:me.id};window.scheduled.push(item);return {scheduled_message:item}}},
      uploads:{send:async(_org,file,channelId)=>{window.uploaded.push({size:file.size,type:file.type,channelId});return {attachment:{id:'clip1',file_name:file.name}}}},
      huddles:{invite:async(_org,_id,ids)=>{window.invitedUsers.push(...ids);return {invited_user_ids:ids}},create:async()=>{window.createdHuddles++;huddle={id:'call1',channel_id:channel.id,started_by:me.id,state:'active',started_at:new Date().toISOString(),settings:{recording_enabled:false},participants:[{...me,user_id:me.id,display_name:me.name,microphone_enabled:true},{...other,user_id:other.id,display_name:other.name,microphone_enabled:false}]};return {huddle}},join:async()=>({huddle}),get:async()=>({huddle}),mediaState:async(_org,_id,patch)=>{Object.assign(huddle.participants[0],patch);return {huddle}},signals:async()=>({signals:[],cursor:0}),signal:async()=>({}),leave:async()=>{window.leftCalls.push('call1');return {}},end:async()=>({})}
    };
    window.PlatformAssistant = {openChannelConversation:async options => {window.recapOptions=options;}};
    window.testOptions = {onOpenChannel:(id,options)=>window.splitOpened={id,options},orgId:'test-org',currentUser:me,realtime:false,mode:'full',features:{attention:true,resources:false,workflows:false,ai:true,typing:false,audioNotes:false,channelCreate:false,channelSettings:true,recording:false}};
    // A real camera stream stands in for the display picker in unattended tests.
    navigator.mediaDevices.getDisplayMedia = async () => { window.displayStream = await navigator.mediaDevices.getUserMedia({video:true,audio:true}); return window.displayStream; };
  });
  await page.addScriptTag({url:origin+'/libraries/navigation/portal-navigation.js'});
  await page.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
  await page.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
  await page.evaluate(()=>{Portal.util={escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),injectCSS:(id,css)=>{if(document.getElementById(id))return;const style=document.createElement('style');style.id=id;style.textContent=css;document.head.append(style);}};});
  await page.addScriptTag({url:origin+'/libraries/apps/photos/feed.js'});
  await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.addScriptTag({url:origin+'/libraries/platform-tags/platform-tags.js'});
  await page.evaluate(() => window.instance = FirstMateChannels.create(document.querySelector('#app'), window.testOptions));
  console.log('Channels mounted');
  await page.evaluate(()=>instance.setChannel('general'));
  await page.evaluate(()=>ChannelsAPI.channels.discover=async()=>({channels:[{id:'general',name:'general',topic:'Team discussion',is_member:true}]}));

  const editor=page.locator('.fm-ch-composer .fm-ch-rich-editor').first();const results=[];
  const inspect=()=>editor.evaluate(n=>({html:n.innerHTML,value:n.value,selection:getSelection().anchorNode?.nodeName,offset:getSelection().anchorOffset,items:[...n.querySelectorAll('li')].map(li=>({text:li.textContent,type:getComputedStyle(li).listStyleType,display:getComputedStyle(li).display,height:li.getBoundingClientRect().height}))}));
  const fresh=async()=>{await page.evaluate(async()=>{instance.destroy();document.querySelector('#app').innerHTML='';instance=FirstMateChannels.create(document.querySelector('#app'),testOptions);await instance.setChannel('general');});await editor.click();};
  for(const scenario of ['bare','bare-space','blank-prefix','numbered','bulleted','typed-content','second-paragraph','empty-toolbar','empty-bullet-toolbar','empty-second','keyboard-clear']){
    await fresh();
    if(scenario==='numbered'||scenario==='bulleted'||scenario==='empty-toolbar'||scenario==='empty-bullet-toolbar')await page.locator('.fm-ch-composer').getByRole('button',{name:(scenario==='bulleted'||scenario==='empty-bullet-toolbar')?'Bulleted list':'Numbered list',exact:true}).click();
    if(scenario==='bare-space')await page.keyboard.type('1. ');
    else if(scenario==='blank-prefix'){await page.keyboard.press('Shift+Enter');await page.keyboard.type('1.');}
    else if(scenario==='second-paragraph'){await page.keyboard.type('Intro');await page.keyboard.press('Shift+Enter');await page.keyboard.type('1.');}
    else if(scenario==='bare'||scenario==='empty-second')await page.keyboard.type('1.');
    else if(scenario==='typed-content')await page.keyboard.type('1. First');
    else if(scenario==='keyboard-clear'){await page.keyboard.type('Old draft');await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await page.keyboard.type('1.');}
    else if(scenario!=='empty-toolbar'&&scenario!=='empty-bullet-toolbar')await page.keyboard.type('First');
    const before=await inspect();await page.keyboard.down('Shift');await page.keyboard.press('Enter');await page.keyboard.up('Shift');
    const immediate=await inspect();
    if(!process.env.REPRO_ONLY){assert.equal(immediate.items.length,2,scenario+' immediately displays the next marker');assert.ok(immediate.items.every(item=>item.display==='list-item'&&item.type!=='none'&&item.height>0));assert.equal(immediate.selection,'LI',scenario+' caret enters next item');if(scenario==='blank-prefix')assert.ok(await editor.evaluate(n=>n.querySelector('ol').previousSibling?.nodeName==='DIV'&&n.querySelector('ol').previousSibling.querySelector('br')),'initial blank visual line retained');}
    await page.screenshot({path:path.join(output,scenario+'-immediate-'+evidenceLabel+'.png')});
    if(scenario==='empty-second'){await page.keyboard.press('Shift+Enter');}await page.keyboard.type('Next');
    const after=await inspect();if(!process.env.REPRO_ONLY){assert.equal(after.items.length,scenario==='empty-second'?3:2);assert.equal(after.items.at(-1).text,'Next');}results.push({scenario,before,immediate,after});console.log(scenario,JSON.stringify({before,immediate,after}));
    await page.screenshot({path:path.join(output,scenario+'-'+evidenceLabel+'.png')});
  }
  await writeFile(path.join(output,'reproduction-'+evidenceLabel+'.json'),JSON.stringify({results,errors},null,2));

  if(!process.env.REPRO_ONLY){


    await fresh();await page.keyboard.press('Shift+Enter');await page.keyboard.press('Control+Home');await page.keyboard.type('1.');await page.keyboard.press('Shift+Enter');assert.ok(await editor.evaluate(n=>{const list=n.querySelector('ol');return list&&[...n.childNodes].slice([...n.childNodes].indexOf(list)+1).some(node=>node.textContent.includes('\n')||!!node.querySelector?.('br')); }),'trailing blank visual line retained');
    await fresh();await page.locator('.fm-ch-composer').getByRole('button',{name:'Numbered list',exact:true}).click();await page.keyboard.type('Filled');await editor.evaluate(n=>{const r=document.createRange();r.setStartAfter(n.querySelector('ol'));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);});await page.keyboard.press('Shift+Enter');assert.equal(await editor.locator('li').count(),1,'outside filled list boundary does not create item');

    for(const kind of ['ol','ul'])for(const boundary of ['list-start','editor-after']){
      await fresh();await page.locator('.fm-ch-composer').getByRole('button',{name:kind==='ol'?'Numbered list':'Bulleted list',exact:true}).click();
      await editor.evaluate((n,boundary)=>{const list=n.querySelector('ol,ul'),r=document.createRange();if(boundary==='list-start')r.setStart(list,0);else r.setStartAfter(list);r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);},boundary);
      await page.keyboard.press('Shift+Enter');assert.equal(await editor.locator('li').count(),2,kind+' '+boundary);await page.keyboard.type('Boundary');assert.equal(await editor.locator('li').last().innerText(),'Boundary');
    }
    await fresh();await page.keyboard.type('Intro');await page.keyboard.press('Shift+Enter');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.type('Tail');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.press('Home');await page.keyboard.press('Shift+Enter');await page.keyboard.press('ArrowUp');await page.keyboard.type('1. First');await page.keyboard.press('Shift+Enter');assert.match(await editor.evaluate(n=>n.value),/Intro\n1\. First\n2\.\s*\n\*\*Tail\*\*/);assert.equal(await editor.locator('b').last().innerText(),'Tail');

    await fresh();await page.keyboard.type('Intro');await page.keyboard.press('Shift+Enter');await page.keyboard.type('7. FirstSecond');for(let i=0;i<6;i++)await page.keyboard.press('ArrowLeft');await page.keyboard.press('Shift+Enter');assert.equal(await editor.evaluate(n=>n.value),'Intro\n7. First\n8. Second');
    for(const value of ['1.5 decimal','1.First','Intro\n1.5 decimal']){await fresh();await page.keyboard.type(value);await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('Shift+Enter');assert.equal(await editor.locator('li').count(),0);}
    await fresh();await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.type('Intro');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.press('Shift+Enter');await page.keyboard.type('3. First');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Next');assert.equal(await editor.evaluate(n=>n.value),'**Intro**\n3. First\n4. Next');
    // A real message action enters the edit composer; native keys clear its draft.
    await fresh();await page.evaluate(()=>{window.edits=[];ChannelsAPI.messages.edit=async(_org,id,input)=>{edits.push(input);return{message:{...testMessages[0],...input,id}}};});
    const row=page.locator('[data-message-id="message1"]');await row.hover();await row.getByRole('button',{name:'More message actions'}).click();await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();
    await editor.press('Control+A');await editor.press('Backspace');await page.keyboard.type('Intro');await page.keyboard.press('Shift+Enter');await page.keyboard.type('1.');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Edited');assert.equal(await editor.evaluate(n=>n.value),'Intro\n1. \n2. Edited');await page.getByRole('button',{name:'Save changes',exact:true}).click();assert.equal(await page.evaluate(()=>edits.at(-1).text),'Intro\n1. \n2. Edited');
    await fresh();await page.evaluate(async()=>{ChannelsAPI.threads={markRead:async()=>({})};await instance.openThread('message1');});const reply=page.locator('.fm-ch-panel .fm-ch-rich-editor');await reply.click();await page.locator('.fm-ch-panel').getByRole('button',{name:'Numbered list',exact:true}).click();await page.keyboard.press('Shift+Enter');assert.equal(await reply.locator('li').count(),2);await page.keyboard.type('Reply');assert.equal(await reply.evaluate(n=>n.value),'1. \n2. Reply');await page.locator('.fm-ch-panel').getByRole('button',{name:'Reply',exact:true}).click();await page.waitForFunction(()=>sent.at(-1)?.parent_id==='message1');assert.equal(await page.evaluate(()=>sent.at(-1).text),'1. \n2. Reply');
    const replyId=await page.evaluate(()=> 'sent'+sent.length);const replyRow=page.locator('.fm-ch-panel [data-message-id="'+replyId+'"]');await replyRow.hover();await replyRow.getByRole('button',{name:'More message actions'}).click();await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();await reply.press('Control+A');await reply.press('Control+A');await reply.press('Backspace');await page.locator('.fm-ch-panel').getByRole('button',{name:'Numbered list',exact:true}).click();await page.keyboard.type('1.');await page.keyboard.press('Shift+Enter');await page.keyboard.type('Thread edit');assert.equal(await reply.evaluate(n=>n.value),'1. \n2. Thread edit');await page.locator('.fm-ch-panel').getByRole('button',{name:'Reply',exact:true}).click();await page.waitForFunction(()=>edits.at(-1)?.text==='1. \n2. Thread edit');
    console.log('PASS actual native click/keys: immediate empty markers, soft-line prefixes, repeated empty items, rich/midline/decimal boundaries, main edit and thread send/edit');
  }


  const docsResults=[];
  async function docsCheck(name,fn){
    await page.evaluate(()=>sidebarPreferences.send_mode='enter');await fresh();
    try{await fn();docsResults.push({name,pass:true});console.log('DOCS PASS',name);}catch(error){docsResults.push({name,pass:false,error:error.message});console.log('DOCS FAIL',name,error.message);}
    await page.screenshot({path:path.join(output,'docs-'+name+'-'+evidenceLabel+'.png')});
  }
  for(const [marker,list,start]of [['1.','ol',1],['7.','ol',7],['1)','ol',1],['-','ul',null],['*','ul',null]])await docsCheck('auto-'+marker.replace(/[^a-z0-9]/gi,c=>c.charCodeAt(0)),async()=>{
    await page.keyboard.type(marker);await page.keyboard.press('Space');assert.equal(await editor.locator(list+' > li').count(),1,'Space starts list');
    if(start)assert.equal(await editor.locator(list).getAttribute('start'),String(start));
    await page.keyboard.type('First');const count=await page.evaluate(()=>sent.length);await page.keyboard.press('Enter');assert.equal(await editor.locator('li').count(),2,'Enter continues');assert.equal(await page.evaluate(()=>sent.length),count,'Enter must not send list draft');await page.keyboard.type('Second');assert.deepEqual(await editor.locator('li').allTextContents(),['First','Second']);
  });
  await docsCheck('toolbar-enter-exit',async()=>{
    await page.locator('.fm-ch-composer').getByRole('button',{name:'Numbered list',exact:true}).click();await page.keyboard.type('First');const count=await page.evaluate(()=>sent.length);await page.keyboard.press('Enter');assert.equal(await editor.locator('li').count(),2);await page.keyboard.press('Enter');assert.equal(await editor.locator('li').count(),1,'empty Enter exits list');await page.keyboard.type('Plain');assert.equal(await editor.evaluate(n=>n.value),'1. First\nPlain');assert.equal(await page.evaluate(()=>sent.length),count);
  });
  await docsCheck('autocorrect-backspace',async()=>{
    await page.keyboard.type('1.');await page.keyboard.press('Space');assert.equal(await editor.locator('li').count(),1);await page.keyboard.press('Backspace');assert.equal(await editor.locator('li').count(),0);assert.equal(await editor.evaluate(n=>n.textContent),'1. ','Backspace immediately restores literal typed prefix');await page.keyboard.type('literal');assert.equal(await editor.evaluate(n=>n.value),'1. literal');
  });
  await docsCheck('autocorrect-undo',async()=>{
    await page.keyboard.type('1.');await page.keyboard.press('Space');await page.keyboard.press('Control+z');assert.equal(await editor.locator('li').count(),0,'Undo reverses automatic list');assert.equal(await editor.evaluate(n=>n.textContent),'1. ','Undo retains literal prefix');await page.keyboard.press('Control+y');await page.keyboard.type('After');assert.equal(await editor.evaluate(n=>n.textContent),'1. After','Redo cannot resurrect detached selection or lose text');
  });
  await docsCheck('native-content-undo',async()=>{
    await page.keyboard.type('1.');await page.keyboard.press('Space');await page.keyboard.type('First');await page.keyboard.press('Control+z');assert.equal(await editor.locator('li').count(),1,'ordinary typing undo retains list');assert.equal(await editor.locator('li').textContent(),'');await page.keyboard.press('Control+y');assert.equal(await editor.locator('li').innerText(),'First','ordinary typing redo remains native');
  });
  await docsCheck('mid-item-enter',async()=>{
    await page.keyboard.type('7.');await page.keyboard.press('Space');await page.keyboard.type('FirstSecond');for(let i=0;i<6;i++)await page.keyboard.press('ArrowLeft');await page.keyboard.press('Enter');assert.equal(await editor.evaluate(n=>n.value),'7. First\n8. Second');
  });
  await docsCheck('nest-outdent',async()=>{
    await page.keyboard.type('-');await page.keyboard.press('Space');await page.keyboard.type('First');await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.type('Child');assert.equal(await editor.locator('ul ul li').count(),1);await page.keyboard.press('Shift+Tab');assert.equal(await editor.locator('ul ul li').count(),0);assert.deepEqual(await editor.locator('li').allTextContents(),['First','Child']);
  });
  await docsCheck('shortcuts-toggle',async()=>{
    await page.keyboard.type('Rich');await page.keyboard.press('Control+Shift+7');assert.equal(await editor.locator('ol li').count(),1);await page.keyboard.press('Control+Shift+7');assert.equal(await editor.locator('li').count(),0);await page.keyboard.press('Control+Shift+8');assert.equal(await editor.locator('ul li').count(),1);assert.equal(await editor.evaluate(n=>n.value),'- Rich');
  });
  await docsCheck('selected-paragraphs',async()=>{
    await page.evaluate(()=>sidebarPreferences.send_mode='modified_enter');await fresh();await page.waitForTimeout(50);await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.type('First');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bold',exact:true}).click();await page.keyboard.press('Enter');await page.keyboard.type('Second');await page.keyboard.press('Shift+Home');await page.locator('.fm-ch-composer').getByRole('button',{name:'Link',exact:true}).click();await page.getByLabel('Web address').fill('https://example.test/selected');await page.getByRole('button',{name:'Insert link',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await editor.click();await page.keyboard.press('Control+A');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bulleted list',exact:true}).click();assert.deepEqual(await editor.locator('li').allTextContents(),['First','Second']);assert.equal(await editor.locator('b').innerText(),'First');assert.equal(await editor.locator('a').getAttribute('href'),'https://example.test/selected');assert.equal(await editor.locator('a').innerText(),'Second');await page.locator('.fm-ch-composer').getByRole('button',{name:'Bulleted list',exact:true}).click();assert.equal(await editor.locator('li').count(),0);assert.equal(await editor.locator('b').innerText(),'First');assert.equal(await editor.locator('a').getAttribute('href'),'https://example.test/selected');assert.equal(await editor.locator('a').innerText(),'Second');
  });
  await docsCheck('boundary-tokens',async()=>{
    for(const value of ['1.5','Version 1.','-5','https://example.test/1.']){await fresh();await page.keyboard.type(value);await page.keyboard.press('Space');assert.equal(await editor.locator('li').count(),0,value+' not a list prefix');}
    for(const kind of ['Code block','Quote']){await fresh();await page.locator('.fm-ch-composer').getByRole('button',{name:kind,exact:true}).click();await page.keyboard.type('1.');await page.keyboard.press('Space');assert.equal(await editor.locator('li').count(),0,kind+' preserved');}
  });
  await docsCheck('thread-enter-send',async()=>{
    await page.evaluate(async()=>{ChannelsAPI.threads={markRead:async()=>({})};await instance.openThread('message1');});const reply=page.locator('.fm-ch-panel .fm-ch-rich-editor');await reply.click();await page.keyboard.type('-');await page.keyboard.press('Space');await page.keyboard.type('First');const count=await page.evaluate(()=>sent.length);await page.keyboard.press('Enter');await page.keyboard.type('Second');assert.deepEqual(await reply.locator('li').allTextContents(),['First','Second']);assert.equal(await page.evaluate(()=>sent.length),count);await page.locator('.fm-ch-panel').getByRole('button',{name:'Reply',exact:true}).click();await page.waitForFunction(count=>sent.length>count,count);assert.equal(await page.evaluate(()=>sent.at(-1).text),'- First\n- Second');
  });

  await docsCheck('nested-empty-enter',async()=>{
    await page.keyboard.type('1.');await page.keyboard.press('Space');await page.keyboard.type('First');await page.keyboard.press('Enter');await page.keyboard.press('Tab');await page.keyboard.type('Child');await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.type('Parent');assert.match(await editor.evaluate(n=>n.value),/1\. First\n  1\. Child\n2\. Parent/);
  });
  await docsCheck('main-edit-enter',async()=>{
    await page.evaluate(()=>{window.edits=[];ChannelsAPI.messages.edit=async(_org,id,input)=>{edits.push(input);return{message:{...testMessages[0],...input,id}}};});const row=page.locator('[data-message-id="message1"]');await row.hover();await row.getByRole('button',{name:'More message actions'}).click();await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();await editor.press('Control+A');await editor.press('Backspace');const list=await editor.evaluate(n=>n.querySelector('ol,ul')?.tagName);if(list)await page.locator('.fm-ch-composer').getByRole('button',{name:list==='OL'?'Numbered list':'Bulleted list',exact:true}).click();await page.keyboard.type('1.');await page.keyboard.press('Space');await page.keyboard.type('First');await page.keyboard.press('Enter');await page.keyboard.type('Edited');assert.equal(await editor.evaluate(n=>n.value),'1. First\n2. Edited');await page.getByRole('button',{name:'Save changes',exact:true}).click();assert.equal(await page.evaluate(()=>edits.at(-1).text),'1. First\n2. Edited');
  });
  await docsCheck('modified-send-mode',async()=>{
    await page.evaluate(()=>sidebarPreferences.send_mode='modified_enter');await fresh();await page.waitForTimeout(50);await page.keyboard.type('-');await page.keyboard.press('Space');await page.keyboard.type('First');const count=await page.evaluate(()=>sent.length);await page.keyboard.press('Enter');await page.keyboard.type('Second');assert.equal(await page.evaluate(()=>sent.length),count);await page.keyboard.press('Control+Enter');await page.waitForFunction(count=>sent.length>count,count);assert.equal(await page.evaluate(()=>sent.at(-1).text),'- First\n- Second');
  });
  await writeFile(path.join(output,'docs-results-'+evidenceLabel+'.json'),JSON.stringify({docsResults,errors},null,2));
  if(!process.env.REPRO_ONLY&&docsResults.some(item=>!item.pass))process.exitCode=1;

  assert.deepEqual(errors,[]);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
