// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve('..');
const output = path.resolve('../../output/channels-members-paste-20260929');
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const data = process.env.DEV_ASSETS ? Buffer.from(await (await fetch('https://dev.1m8.ai'+name+'?members='+Date.now())).arrayBuffer()) : await readFile(filename); response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
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
    window.testOptions = {onOpenChannel:(id,options)=>window.splitOpened={id,options},orgId:'test-org',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:true,typing:false,audioNotes:false,channelCreate:false,channelSettings:true,recording:false}};
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
  await page.evaluate(()=>{
    ChannelsAPI.channels.discover=async()=>({channels:[{id:'general',name:'general',topic:'Team discussion',is_member:true},{id:'joinable',name:'open-project',topic:'Public project',is_member:false}]});
    ChannelsAPI.channels.join=async(_org,id)=>{window.joinedChannel=id;return {channel:testChannel};};
    ChannelsAPI.channels.setRole=async(_org,_id,userId,role)=>{testChannel.members.find(m=>m.id===userId).role=role;return {channel:testChannel};};
    testChannel.members.forEach(m=>m.role=m.id==='owner'?'owner':'member');
    ChannelsAPI.messages.edit=async(_org,id,input)=>{const message=testMessages.find(m=>m.id===id);Object.assign(message,input,{edited_at:new Date().toISOString()});return {message};};
    ChannelsAPI.messages.react=async(_org,id,emoji,on)=>{const message=testMessages.find(m=>m.id===id);message.reactions=on?[{emoji,count:1,reacted:true,users:[{id:'owner',name:'Morgan Lee'}]}]:[];return {message};};
    ChannelsAPI.messages.remove=async(_org,id)=>{const message=testMessages.find(m=>m.id===id);Object.assign(message,{deleted_at:new Date().toISOString(),deleted_by_user:{name:'Morgan Lee'},can_restore:true});return {message};};
    ChannelsAPI.messages.restore=async(_org,id)=>{const message=testMessages.find(m=>m.id===id);message.deleted_at=null;return {message};};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copiedText=text},configurable:true});
  });
  const editor=page.locator('.fm-ch-composer .fm-ch-rich-editor');
  const paste=async html=>{await editor.fill('');await editor.focus();await editor.evaluate((node,html)=>{const data=new DataTransfer();data.setData('text/html',html);node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},html);};
  await paste('<p>Before <strong>bold</strong> and <em>italic</em></p><ul><li>First</li><li>Second</li></ul><table><tr><th>Heading</th></tr><tr><td>One</td></tr></table><p>Between tables</p><table><tr><th>Another</th></tr><tr><td>Two</td></tr></table><p>After <a href="https://example.test/path">link</a></p><script>window.unsafePaste=true</script><img src=x onerror="window.unsafePaste=true"><a href="javascript:alert(1)">Unsafe link</a>');
  assert.equal(await editor.locator('table').count(),2);
  assert.equal(await editor.locator('strong').innerText(),'bold');
  assert.equal(await editor.locator('em').innerText(),'italic');
  assert.equal(await editor.locator('li').count(),2);
  assert.equal(await editor.locator('script,img,[onerror],a[href^="javascript:"]').count(),0);
  assert.equal(await page.evaluate(()=>Boolean(window.unsafePaste)),false);
  const wire=await editor.evaluate(node=>node.value);
  assert.match(wire,/Before \*\*bold\*\* and _italic_[\s\S]*Heading[\s\S]*Between tables[\s\S]*Another[\s\S]*After/);
  await editor.evaluate(node=>node.value=node.value);
  assert.equal(await editor.locator('table').count(),2);
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.equal(await page.locator('.fm-ch-msg-body').last().locator('table').count(),2);
  for(const tag of ['ul','ol']) {
    await paste(`<${tag}><li>First item</li></${tag}>`);
    const ordered=await editor.locator('ol').count()>0;
    await editor.locator('li').click();await editor.press('End');await editor.press('Shift+Enter');await page.keyboard.type('Continuation');
    assert.equal(await editor.locator('li').count(),2);
    const value=await editor.evaluate(node=>node.value);
    assert.match(value,ordered?/1\. First item\n2\. Continuation/:/- First item\n- Continuation/);
    await editor.evaluate(node=>node.value=node.value);
    assert.equal(await editor.locator('li').count(),2);
    assert.equal(await editor.locator('li').nth(1).innerText(),'Continuation');
  }
  await paste('<p>Prefix</p><table>'+Array.from({length:57},(_,i)=>`<tr><td>Row ${i}</td></tr>`).join('')+'</table><p>Suffix</p>');
  assert.equal(await editor.locator('tr:visible').count(),10);
  assert.equal(await editor.getByRole('button',{name:'47 other rows have been hidden · Click to expand'}).count(),1);
  assert.match(await editor.innerText(),/Prefix[\s\S]*Suffix/);
  await editor.getByRole('button',{name:/47 other rows/}).click();
  assert.equal(await page.getByRole('dialog').locator('tr:visible').count(),57);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();await editor.fill('');
  console.log('PASS rich mixed paste, all tables/text, sanitization, Shift+Enter lists and hidden-row count');
  const row=page.locator('[data-message-id="message1"]');
  await row.hover();await row.getByRole('button',{name:'React with thumbs up'}).click();
  assert.equal(await row.locator('.fm-ch-reaction.mine').innerText(),'👍 1');
  await row.hover();await row.getByRole('button',{name:'More message actions'}).click();
  await page.getByRole('menuitem',{name:'Copy message text',exact:true}).click();
  assert.match(await page.evaluate(()=>copiedText),/Ready for the project review/);
  assert.doesNotMatch(await page.evaluate(()=>copiedText),/\*\*/);
  await row.hover();await row.getByRole('button',{name:'More message actions'}).click();await page.getByRole('menuitem',{name:'Edit message',exact:true}).click();
  await editor.fill('Updated www.example.test and https://example.test/path.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  assert.equal(await row.locator('.fm-ch-msg-body .fm-ch-msg-edited').innerText(),'(edited)');
  assert.equal(await row.locator('a[href="https://www.example.test"]').getAttribute('target'),'_blank');
  assert.equal(await row.locator('a[href="https://example.test/path"]').getAttribute('target'),'_blank');
  await row.hover();await row.getByRole('button',{name:'More message actions'}).click();await page.getByRole('menuitem',{name:'Remove message',exact:true}).click();
  assert.match(await row.innerText(),/Morgan Lee deleted a message/);
  await row.getByRole('button',{name:'Restore message'}).click();
  assert.match(await row.innerText(),/Updated www.example.test/);
  console.log('PASS message menu edit, edited marker, plain text copy, quick thumbs up, links and restore');
  await page.getByRole('button',{name:'See all company channels',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search public channels'}).fill('open-project');
  assert.equal(await page.getByRole('dialog').locator('.fm-ch-member-row').count(),1);
  await page.screenshot({path:path.join(output,'channel-directory.png')});
  await page.getByRole('button',{name:'Join channel',exact:true}).click();
  assert.equal(await page.evaluate(()=>joinedChannel),'joinable');
  await page.evaluate(()=>instance.setChannel('general'));
  await page.getByRole('button',{name:/People in channel/}).click();
  await page.getByRole('searchbox',{name:'Search channel members'}).fill('Jordan');
  await page.getByRole('button',{name:'Make manager',exact:true}).filter({visible:true}).click();
  assert.equal(await page.evaluate(()=>testChannel.members.find(m=>m.id==='guest').role),'admin');
  await page.screenshot({path:path.join(output,'channel-managers.png')});
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  if(process.env.LIVE_GIFS) {
    const config=JSON.parse(await readFile(path.join(output,'giphy-config.json'),'utf8'));
    await page.evaluate(key=>{ChannelsAPI.gifs={config:async()=>({enabled:true,sdk_key:key})};},config.GIPHY_WEB_SDK_KEY);
    await page.getByRole('button',{name:'Send a GIF',exact:true}).click();
    const picker=page.getByRole('dialog',{name:'Send a GIF',exact:true});
    await picker.locator('.fm-ch-gif-grid img').first().waitFor({timeout:30000});
    await picker.locator('.fm-ch-gif-grid img').first().click();
    await picker.getByRole('button',{name:'Send GIF',exact:true}).click();
    assert.equal(await page.evaluate(()=>sent.at(-1).text),'');
    assert.match(await page.evaluate(()=>sent.at(-1).metadata.giphy.url),/^https:\/\/media\d*\.giphy\.com\/media\//);
    await page.locator('.fm-ch-msg-content .fm-ch-gif img').last().waitFor();
    await page.screenshot({path:path.join(output,'giphy-message.png')});
    console.log('PASS official GIPHY SDK live results, preview, attachment-only GIF send and rendering');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS public directory search/join and channel manager picker');
} catch(error) { await page.screenshot({path:path.join(output,'failure.png')}); await writeFile(path.join(output,'failure.html'),await page.content()); throw error; } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
