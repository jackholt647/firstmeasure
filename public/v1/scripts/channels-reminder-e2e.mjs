// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve(process.env.ASSET_ROOT || fileURLToPath(new URL('../../', import.meta.url)));
const output = path.resolve(process.env.OUTPUT_DIR || fileURLToPath(new URL('../../../output/channels-reminder-e2e/', import.meta.url)));
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
const page = await browser.newPage({viewport:{width:1366,height:768},locale:'en-US',timezoneId:'America/Los_Angeles'});
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
  await page.clock.install({time:new Date('2026-09-30T12:07:00-07:00')});
  await page.evaluate(()=>{
    window.reminderWrites=[];window.failReminder=false;
    ChannelsAPI.reminders={create:async(_org,id,date)=>{if(failReminder){failReminder=false;throw Error('Temporary reminder failure');}reminderWrites.push({id,date});return {};}};
    ChannelsAPI.saved={add:async()=>({})};Portal.toast=message=>window.lastError=message;
  });
  const open=async()=>{await page.locator('.fm-ch-msg').first().hover();await page.getByRole('button',{name:'More message actions',exact:true}).first().click();await page.getByRole('menuitem',{name:'Remind me about this',exact:true}).click();await page.locator('fm-date-time-picker').waitFor();};
  await open();
  const dialog=page.getByRole('dialog',{name:'Remind me',exact:true});
  const picker=page.locator('fm-date-time-picker');
  if(process.env.REPRO_ONLY){
    console.log('REPRO custom dropdown count',await picker.locator('summary').count(),'custom inputs visible',await picker.getByLabel('Hour',{exact:true}).isVisible());
    await page.screenshot({path:path.join(output,`before${process.env.DEV_ASSETS?'-dev':''}.png`),animations:'disabled'});
  } else {
    const hour=picker.getByLabel('Hour',{exact:true}),minute=picker.getByLabel('Minute',{exact:true});
    const summary=picker.locator('.custom-time summary');
    const save=()=>dialog.getByRole('button',{name:'Save reminder',exact:true}).click();
    const geometry=[];
    const checkLayout=async(viewport,state)=>{
      const measured=await picker.locator('.time-section').evaluate(n=>{const details=n.querySelector('.custom-time'),year=n.getRootNode().querySelector('.year');return{gap:n.getBoundingClientRect().bottom-details.getBoundingClientRect().bottom,yearWeight:getComputedStyle(year).fontWeight,slotsHeight:n.querySelector('.slots').getBoundingClientRect().height};});
      geometry.push({width:viewport.width,state,...measured});
      assert.ok(measured.slotsHeight>=150&&measured.slotsHeight<=320,'time list remains a compact scroll area');
      const bounds=await dialog.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=viewport.height+1,'complete reminder fits viewport');
      if(!process.env.VISUAL_BASELINE){assert.ok(measured.gap<=1,`no empty space below Custom time (${state} gap=${measured.gap})`);assert.equal(measured.yearWeight,'700','reminder year is bold');}
      await page.screenshot({path:path.join(output,`layout-${state}-${viewport.width}.png`),animations:'disabled'});
    };
    for(const [index,viewport] of [{width:1366,height:768},{width:390,height:844}].entries()){
      if(index)await open();await page.setViewportSize(viewport);
      assert.equal(await picker.locator('.days').isVisible(),true,'calendar visible immediately');
      const slots=await picker.locator('[data-slot]').evaluateAll(nodes=>nodes.map(n=>n.dataset.slot));
      assert.ok(slots.length>0 && slots.length<=96);assert.ok(slots.every(t=>['00','15','30','45'].includes(t.split(':')[1])));
      assert.equal(await hour.isVisible(),false,'custom fields initially collapsed');
      assert.equal(await summary.innerText(),'Custom time');
      await checkLayout(viewport,'closed');
      await summary.focus();await summary.press('Enter');await hour.waitFor();
      await page.waitForFunction(()=>document.querySelector('fm-date-time-picker')?.shadowRoot.activeElement?.matches('[data-time=hour]'),null,{polling:10});
      assert.equal(await hour.evaluate(n=>n.getRootNode().activeElement===n),true,'opening dropdown focuses Hour');
      await checkLayout(viewport,'open');
      await picker.locator('[data-date="2026-10-01"]').click();
      assert.equal(await picker.locator('[data-slot]').count(),96);
      assert.equal(await picker.locator('.custom-time').getAttribute('open'),'','expansion persists after date selection');
      await hour.fill('10');await minute.fill('23');await minute.press('Tab');
      await picker.locator('[data-period]').click(); // AM on future day.
      assert.equal(await picker.locator('.error').innerText(),'');
      const styles=await hour.evaluate(n=>{const c=getComputedStyle(n),s=getComputedStyle(n.getRootNode().querySelector('[data-slot]'));return{align:c.textAlign,left:c.paddingLeft,right:c.paddingRight,font:c.fontFamily,slotFont:s.fontFamily,width:n.getBoundingClientRect().width};});
      assert.equal(styles.align,'center');assert.equal(styles.left,styles.right);assert.equal(styles.font,styles.slotFont);assert.ok(styles.width<60);
      assert.ok(await picker.locator('.picker').evaluate(n=>n.scrollWidth<=n.clientWidth),'mobile has no picker overflow');
      const bounds=await dialog.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=viewport.width+1);
      await minute.fill('60');await save();assert.equal(await page.evaluate(()=>reminderWrites.length),index);assert.match(await picker.locator('.error').innerText(),/valid time/);
      await minute.fill('23');await hour.fill('0');await save();assert.equal(await page.evaluate(()=>reminderWrites.length),index);
      await hour.fill('10');await minute.press('Tab');
      await picker.locator('[data-date="2026-09-30"]').click();await save();
      assert.equal(await page.evaluate(()=>reminderWrites.length),index);assert.match(await picker.locator('.error').innerText(),/future/);
      await picker.locator('[data-date="2026-10-01"]').click();
      await page.screenshot({path:path.join(output,`custom-dropdown-${viewport.width}${process.env.DEV_ASSETS?'-dev':''}.png`),animations:'disabled'});
      if(!index){await page.evaluate(()=>window.failReminder=true);await save();assert.equal(await dialog.isVisible(),true);assert.equal(await page.evaluate(()=>window.lastError),'Temporary reminder failure');}
      await save();await dialog.waitFor({state:'hidden'});
      assert.equal(await page.evaluate(()=>reminderWrites.at(-1).date),'2026-10-01T17:23:00.000Z');
      await page.clock.runFor(200);
      console.log(`PASS ${viewport.width}: immediate calendar/15m slots; dropdown keyboard reveal/focus; centered custom numbers/font; bounds/past blocked; exact time saved`);
    }
    await writeFile(path.join(output,'layout-geometry.json'),JSON.stringify(geometry,null,2));
    // Default shared picker contract remains always-visible custom inputs.
    await page.evaluate(()=>{const input=document.createElement('input');input.type='time';input.value='10:23';document.body.append(input);FirstMateDateTimePicker.open(input);});
    assert.equal(await picker.locator('summary').count(),0);assert.equal(await picker.getByLabel('Hour',{exact:true}).isVisible(),true);
    await page.evaluate(()=>FirstMateDateTimePicker.close());
    await page.evaluate(()=>{const input=document.createElement('input');input.type='date';input.value='2026-10-01';document.body.append(input);FirstMateDateTimePicker.open(input);});
    assert.equal(await picker.locator('.year').evaluate(n=>getComputedStyle(n).fontWeight),'400','other apps retain the shared picker year style');
    await page.evaluate(()=>FirstMateDateTimePicker.close());
  }
  assert.deepEqual(errors,[]);
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
