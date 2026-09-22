// Real-browser regression checks with an isolated in-memory API and fake devices.
// Does not log in, send messages, invite users, or change production data.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const publicRoot = path.resolve('..');
const output = path.resolve('../../output/channels-workspace');
await mkdir(output, {recursive:true});
const server = createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (name === '/') { response.setHeader('Content-Type','text/html; charset=utf-8'); response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css"></head><body style="margin:0;font-family:Arial"><main class="main" style="position:relative;height:100vh"><div id="app" style="height:100vh"></div></main></body></html>'); return; }
  const filename = path.resolve(publicRoot, '.' + name);
  if (!filename.startsWith(publicRoot + path.sep)) { response.writeHead(403); response.end(); return; }
  try { const data = await readFile(filename); response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(name) ? 'text/javascript' : 'application/octet-stream'); response.end(data); }
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
    window.leftCalls = []; window.createdConversations = []; window.sent = []; window.scheduled = []; window.uploaded = [];
    const me = {id:'owner', name:'Morgan Lee'};
    const other = {id:'guest', name:'Jordan Ellis',email:'jordan@example.test',title:'Project manager',department:'Operations',time_zone:'America/Los_Angeles',phone:'+1 555 0100',bio:'Helping the team deliver great projects.'};
    const agent = {id:'agent_assistant', name:'FirstMate'};
    const channel = {id:'general', type:'public', name:'general', display_name:'Team room', members:[me,other], member_count:2, can_manage:true, unread:{last_read_seq:0}, settings:{}, permissions:{}, is_member:true};
    const messages = [{id:'message1', channel_id:'general', seq:1, text:'Ready for the **project review**?\n\n- Review the plan\n- Confirm next steps', author:other, created_at:new Date().toISOString(), can_edit:true, can_delete:true, reactions:[]}];
    let huddle;
    window.__APP = {userId:me.id, userOrgId:'test-org', userName:me.name};
    window.Portal = {currentUser:me, ui:{showToast:(title, detail) => window.lastToast = title + ': ' + detail}, appFlags:{current:()=>true, has:()=>true}};
    window.ChannelsAPI = {
      channels:{list:async()=>({channels:[channel]}), get:async()=>({channel}), create:async(_org,input)=>{window.createdConversations.push(input);return {channel:{...channel,id:'assistant-new',type:'dm',display_name:input.name,members:[me,agent]}}}},
      messages:{list:async()=>({channel,messages}),post:async(_org,_channel,input)=>{window.sent.push(input);return {message:{...messages[0],...input,id:'sent'+window.sent.length,author:me,seq:window.sent.length+1}}},edit:async(_org,id,input)=>({message:{...messages[0],...input,id}}),thread:async()=>({root:messages[0],replies:[]})},
      preferences:{collaboration:async()=>({preferences:{send_mode:'enter'}})},
      directory:{list:async()=>({users:[me,other,agent]})},
      readState:{markRead:async()=>({})},
      drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})},
      scheduled:{create:async(_org,input)=>{window.scheduled.push(input);return {}}},
      uploads:{send:async(_org,file,channelId)=>{window.uploaded.push({size:file.size,type:file.type,channelId});return {attachment:{id:'clip1',file_name:file.name}}}},
      huddles:{create:async()=>{huddle={id:'call1',channel_id:channel.id,started_by:me.id,state:'active',started_at:new Date().toISOString(),settings:{recording_enabled:false},participants:[{...me,user_id:me.id,display_name:me.name,microphone_enabled:true},{...other,user_id:other.id,display_name:other.name,microphone_enabled:false}]};return {huddle}},join:async()=>({huddle}),get:async()=>({huddle}),mediaState:async(_org,_id,patch)=>{Object.assign(huddle.participants[0],patch);return {huddle}},signals:async()=>({signals:[],cursor:0}),signal:async()=>({}),leave:async()=>{window.leftCalls.push('call1');return {}},end:async()=>({})}
    };
    window.testOptions = {orgId:'test-org',currentUser:me,realtime:false,mode:'full',features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:true,recording:false}};
    // A real camera stream stands in for the display picker in unattended tests.
    navigator.mediaDevices.getDisplayMedia = async () => navigator.mediaDevices.getUserMedia({video:true,audio:true});
  });
  await page.addScriptTag({url:origin+'/libraries/navigation/portal-navigation.js'});
  await page.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
  await page.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
  await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(() => window.instance = FirstMateChannels.create(document.querySelector('#app'), window.testOptions));
  console.log('Channels mounted');
  if (!process.env.CHANNELS_PEER_ONLY) {
  await page.getByRole('button',{name:'View Jordan Ellis profile',exact:true}).click();
  await page.getByRole('link',{name:'jordan@example.test'}).waitFor();
  await page.screenshot({path:path.join(output,'user-profile.png')});
  await page.getByRole('button',{name:'View profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor();
  await page.locator('.fm-ch-profile-panel').getByText('Operations',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'full-user-profile.png')});
  await page.goBack(); await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  await page.goForward(); await page.locator('.fm-ch-profile-panel').waitFor();
  await page.getByRole('button',{name:'Close profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  await page.keyboard.press('Escape');
  await page.locator('.fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('.fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'Message',exact:true}).click();
  await page.waitForFunction(()=>createdConversations.length===1);
  assert.deepEqual(await page.evaluate(()=>createdConversations[0].member_user_ids),['guest']);
  await page.getByTitle('Channel settings',{exact:true}).click();
  assert.equal(await page.locator('[data-field=huddle-recording]').count(),0);
  assert.doesNotMatch(await page.locator('.fm-ch-modal').innerText(),/recording|retention/i);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  if (!process.env.CHANNELS_LAYOUT_ONLY) {
  const editor = page.locator('.fm-ch-composer .fm-ch-rich-editor');
  await editor.waitFor();
  await editor.fill('A rich message'); await editor.press('Control+a');
  await page.getByRole('button',{name:'Bold',exact:true}).click();
  assert.equal(await editor.locator('b,strong').textContent(), 'A rich message');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  console.log('Rich message sent');
  assert.match(await page.evaluate(()=>sent[0].text), /\*\*A rich message\*\*/);
  assert.equal(await page.locator('.fm-ch-msg-body strong').last().textContent(), 'A rich message');
  await editor.click(); await page.getByRole('button',{name:'Table',exact:true}).click();
  await page.getByRole('button',{name:'Insert table',exact:true}).click();
  assert.equal(await editor.locator('table tr').count(),3);
  await editor.locator('td').first().click(); await page.keyboard.type('Project A');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  assert.match(await page.evaluate(()=>sent[1].text),/Project A/);
  assert.equal(await page.locator('.fm-ch-msg-body table').count(),1);
  await page.locator('.fm-ch-msg').first().hover();
  assert.equal(await page.locator('.fm-ch-toolbar').first().locator('button').count(),4);
  await page.getByRole('button',{name:'More message actions'}).first().click();
  assert.ok(await page.getByRole('menuitem',{name:'Edit message'}).isVisible());
  await page.keyboard.press('Escape');
  await editor.fill('Send this later');
  await page.getByRole('button',{name:'Schedule message',exact:true}).click();
  const scheduleValue = await page.locator('[data-field=scheduled]').inputValue();
  const scheduledDelay = await page.evaluate(value => new Date(value).getTime() - Date.now(), scheduleValue);
  assert.ok(scheduledDelay >= 55 * 60000 && scheduledDelay <= 76 * 60000, 'picker represents a local time about one hour ahead');
  await page.getByRole('button',{name:'Schedule',exact:true}).click();
  assert.equal(await page.evaluate(()=>scheduled.length),1);
  await page.getByTitle('Record screen clip',{exact:true}).click();
  console.log('Clip opened');
  await page.getByRole('button',{name:'Start recording',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>uploaded.length),0);
  await page.getByRole('button',{name:'Start recording',exact:true}).click();
  await page.waitForTimeout(3000);
  await page.getByRole('button',{name:'Stop recording',exact:true}).click();
  await page.getByRole('button',{name:'Attach clip',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>uploaded.length),0);
  await page.getByRole('button',{name:'Attach clip',exact:true}).click();
  await page.waitForFunction(()=>uploaded.length===1);
  assert.ok(await page.evaluate(()=>uploaded[0].size>0));
  assert.equal(await page.evaluate(()=>sent.length),2);
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  console.log('Call starting');
  assert.equal(await page.locator('[data-huddle-record]').count(),0);
  assert.doesNotMatch(await page.locator('.fm-ch-modal').innerText(),/retention|recording/i);
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.locator('.fm-ch-call-stage').waitFor();
  assert.equal(await page.locator('.fm-ch-call-identity').count(),2);
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=full]').isVisible());
  await page.getByRole('button',{name:'React',exact:true}).click();
  await page.locator('.fm-ch-emoji-grid button').first().click();
  await page.locator('.fm-ch-call-reaction').waitFor();
  await page.getByRole('button',{name:'Invite people',exact:true}).click();
  await page.getByRole('button',{name:'Copy invite link',exact:true}).click();
  await page.waitForFunction(()=>/copied|copy the link/.test(document.querySelector('[data-copy-status]')?.textContent));
  await page.screenshot({path:path.join(output,'fullscreen-invite.png')});
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Call settings and troubleshooting',exact:true}).click();
  await page.locator('[data-mic] option').nth(1).waitFor({state:'attached'});
  await page.locator('[data-mic]').selectOption({index:1});
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  if (await page.locator('[data-speaker]').isEnabled()) await page.locator('[data-speaker]').selectOption({index:1});
  await page.locator('[data-noise]').uncheck();
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  await page.locator('[data-noise]').check();
  await page.getByText('Audio settings applied.',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'fullscreen-audio-settings.png')});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByTitle('Remove Jordan Ellis',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByTitle('End huddle for everyone',{exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  await page.getByRole('button',{name:'Mute microphone',exact:true}).click();
  await page.getByRole('button',{name:'Unmute microphone',exact:true}).click();
  await page.getByTitle('Minimize call',{exact:true}).click();
  await page.getByTitle('Float call',{exact:true}).click();
  const callBox = await page.locator('.fm-call-window').boundingBox();
  await page.locator('.fm-call-window [data-resize=se]').hover();
  await page.mouse.down(); await page.mouse.move(callBox.x + callBox.width - 153,callBox.y + callBox.height + 60,{steps:10}); await page.mouse.up();
  const resized = await page.locator('.fm-call-window').boundingBox();
  assert.ok(resized.width < callBox.width - 50, 'resize grip changes call width');
  await page.screenshot({path:path.join(output,'resized-call.png')});

  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  await page.locator('.fm-ch-call-stage video').waitFor();
  await page.getByRole('button',{name:'Call settings and troubleshooting',exact:true}).click();
  await page.getByRole('tab',{name:'Video & backgrounds'}).click();
  await page.locator('[data-camera] option').nth(1).waitFor({state:'attached'});
  await page.locator('[data-camera]').selectOption({index:1});
  await page.getByText('Camera selected.',{exact:true}).waitFor();
  await page.locator('[data-background]').selectOption('image');
  await page.getByText('Choose a background image first.',{exact:true}).waitFor();
  await page.locator('[data-background-file]').setInputFiles({name:'background.png',mimeType:'image/png',buffer:await page.screenshot()});
  await page.getByText('Background applied.',{exact:true}).waitFor({timeout:60000});
  await page.screenshot({path:path.join(output,'custom-background.png')});
  await page.locator('[data-background]').selectOption('blur');
  console.log('Applying background');
  await page.getByText('Background applied.',{exact:true}).waitFor({timeout:60000});
  console.log('Background applied');
  await page.locator('[data-background]').selectOption('off');
  await page.getByText('Background applied.',{exact:true}).waitFor();
  await page.getByRole('tab',{name:'Troubleshooting',exact:true}).click();
  await page.getByRole('button',{name:'Run connection check'}).click();
  await page.getByText(/Secure browser: yes/).waitFor();
  await page.getByRole('button',{name:'Test speaker',exact:true}).click();
  await page.getByText('A short tone played through your speaker.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Test microphone level',exact:true}).click();
  await page.getByText(/Microphone level:/).waitFor();
  await page.screenshot({path:path.join(output,'call-troubleshooting.png')});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  console.log('Diagnostics checked');
  await page.screenshot({path:path.join(output,'call-workspace.png')});
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  console.log('Camera disabled');
  await page.waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===0);
  await page.getByRole('button',{name:'Toggle camera',exact:true}).click();
  console.log('Camera restarted');
  await page.locator('.fm-ch-call-stage video').waitFor();
  await page.getByRole('button',{name:'Leave huddle',exact:true}).click();
  console.log('Call left');
  await page.locator('.fm-ch-huddle').waitFor({state:'detached'});
  console.log('Capturing messaging');
  await page.screenshot({path:path.join(output,'rich-messaging.png'),timeout:10000});
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.getByRole('button',{name:'Participants',exact:true}).click();
  await page.getByTitle('End huddle for everyone',{exact:true}).click();
  await page.getByRole('button',{name:'End call',exact:true}).click();
  await page.locator('.fm-ch-huddle').waitFor({state:'detached'});
  }
  console.log('Opening overlay');
  await page.evaluate(() => { instance.destroy(); document.querySelector('#app').innerHTML = '<div style="padding:40px;background:#f7f8fa;height:100%;box-sizing:border-box"><h1>Project workspace</h1><p>Keep working while the conversation stays docked.</p><button id="underlying-action">Edit project</button></div>'; });
  await page.evaluate(() => {
    const main = document.querySelector('main'); main.style.cssText = 'position:relative;height:100vh;margin-left:220px;display:flex;flex-direction:column';
    const panels = document.createElement('div'); panels.id='mainPanels'; panels.style.cssText='flex:1;min-height:0;overflow:auto';
    const app = document.querySelector('#app'); app.style.height='100%'; app.before(panels); panels.append(app);
    const topbar = document.createElement('div'); topbar.id='platformTopbar'; topbar.textContent='Workspace'; topbar.style.cssText='height:48px;flex:none;box-sizing:border-box;padding:14px 24px;border-bottom:1px solid #e4e7ec'; main.prepend(topbar);
    const sidebar = document.createElement('aside'); sidebar.style.cssText='position:fixed;left:0;top:0;bottom:0;width:220px;background:#f1f3f6;padding:24px;box-sizing:border-box'; sidebar.textContent='FirstMate · Projects'; document.body.append(sidebar);
  });
  await page.addScriptTag({url:origin+'/libraries/apps/channels/app.js'});
  await page.evaluate(() => FirstMateChannelsOverlay.open('general'));
  await page.locator('.fm-channels-overlay .fm-ch-rich-editor').waitFor();
  await page.getByRole('button',{name:'Dock conversation',exact:true}).click();
  assert.ok(await page.locator('.fm-channels-overlay[data-window=docked]').isVisible());
  const dockBox = await page.locator('.fm-channels-overlay').boundingBox();
  const contentBox = await page.locator('#app').boundingBox();
  assert.ok(contentBox.x + contentBox.width <= dockBox.x + 1,'docked conversation reserves workspace width');
  const divider = page.getByRole('separator',{name:'Resize conversation w',exact:true});
  await divider.hover(); await page.mouse.down(); await page.mouse.move(dockBox.x - 80,dockBox.y + dockBox.height/2,{steps:8}); await page.mouse.up();
  assert.ok((await page.locator('.fm-channels-overlay').boundingBox()).width > dockBox.width + 50);
  await divider.focus(); await page.keyboard.press('ArrowRight');
  await page.locator('#underlying-action').click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fm:portal-tab:activated',{detail:{}})));
  assert.ok(await page.locator('.fm-channels-overlay[data-window=docked]').isVisible());
  await page.screenshot({path:path.join(output,'docked-conversation.png')});
  await page.getByRole('button',{name:'Minimize conversation',exact:true}).click();
  assert.equal(await page.locator('.fm-channels-overlay-body').isVisible(), false);
  await page.getByRole('button',{name:'Float conversation',exact:true}).click();
  for (const [corner,dx,dy] of [['nw',30,30],['ne',-30,20],['sw',20,-20],['se',-30,-20],['n',0,16],['e',-16,0],['s',0,-16],['w',16,0]]) {
    const initial = await page.locator('.fm-channels-overlay').boundingBox();
    await page.locator(`[data-resize=${corner}]`).hover(); await page.mouse.down();
    const gripBox = await page.locator(`[data-resize=${corner}]`).boundingBox();
    await page.mouse.move(gripBox.x + gripBox.width/2 + dx,gripBox.y + gripBox.height/2 + dy,{steps:6}); await page.mouse.up();
    const changed = await page.locator('.fm-channels-overlay').boundingBox();
    if (dx) assert.notEqual(Math.round(initial.width),Math.round(changed.width),`${corner} resizes width`);
    if (dy) assert.notEqual(Math.round(initial.height),Math.round(changed.height),`${corner} resizes height`);
  }
  const wide = await page.locator('.fm-channels-overlay').boundingBox();
  await page.locator('[data-resize=se]').hover(); await page.mouse.down();
  await page.mouse.move(wide.x + 360 - 8,wide.y + wide.height - 8,{steps:6}); await page.mouse.up();
  const headBox = await page.locator('.fm-channels-overlay-head').boundingBox();
  const controlsBox = await page.locator('.fm-channels-overlay .fm-window-controls').boundingBox();
  const actionsBox = await page.locator('.fm-channels-overlay-actions').boundingBox();
  assert.ok(controlsBox.y + controlsBox.height <= headBox.y + headBox.height + 1,'controls stay in top row');
  assert.ok(actionsBox.y >= headBox.y + headBox.height,'conversation actions stay below header');
  await page.screenshot({path:path.join(output,'narrow-floating-conversation.png')});
  await page.locator('.fm-channels-overlay .fm-ch-msg-author').first().click();
  await page.getByRole('button',{name:'View profile',exact:true}).click();
  await page.locator('.fm-channels-overlay .fm-ch-profile-panel').waitFor();
  await page.screenshot({path:path.join(output,'floating-profile-panel.png')});
  await page.getByRole('button',{name:'Close profile',exact:true}).click();
  await page.locator('.fm-ch-profile-panel').waitFor({state:'detached'});
  assert.ok((await page.locator('.fm-channels-overlay').boundingBox()).width < 380, 'closing profile preserves floating window size');
  assert.ok(Math.abs((await page.locator('#mainPanels').boundingBox()).width - (await page.locator('main').boundingBox()).width)<2,'floating releases dock reservation');

  const before = await page.locator('.fm-channels-overlay').boundingBox();
  await page.locator('.fm-channels-overlay-title').hover();
  await page.mouse.down(); await page.mouse.move(before.x - 60, before.y + 80); await page.mouse.up();
  const after = await page.locator('.fm-channels-overlay').boundingBox();
  assert.notEqual(before.x,after.x);
  await page.getByRole('button',{name:'Maximize conversation',exact:true}).click();
  await page.getByRole('button',{name:'conversation window menu',exact:true}).click();
  await page.getByRole('menuitem',{name:'Pin window',exact:true}).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fm:portal-tab:activated',{detail:{}})));
  assert.ok(await page.locator('.fm-channels-overlay').isVisible());
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('.fm-channels-overlay').waitFor({state:'hidden'});
  await page.goForward();
  await page.locator('.fm-channels-overlay').waitFor({state:'visible'});
  // Windowed calls are independent and use the same four-button chrome.
  await page.getByRole('button',{name:'Float conversation',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Float conversation',exact:true}).count(),0);
  await page.getByTitle('Start or join huddle',{exact:true}).click();
  await page.getByRole('button',{name:'Start or join',exact:true}).click();
  await page.locator('main > .fm-call-window').waitFor();
  assert.equal(await page.locator('.fm-channels-overlay .fm-call-window').count(),0);
  assert.equal(await page.locator('.fm-call-window .fm-window-controls button').count(),4);
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Maximize call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=full]').isVisible());
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  // Minimized chrome offers explicit destinations with different icons.
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  const floatIcon = await page.getByRole('button',{name:'Float call',exact:true}).locator('i').getAttribute('class');
  const dockIcon = await page.getByRole('button',{name:'Dock call',exact:true}).locator('i').getAttribute('class');
  assert.notEqual(floatIcon,dockIcon);
  assert.equal(await page.locator('.fm-call-window .fm-window-controls button').count(),4);
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible());
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=floating]').isVisible());
  const callBefore = await page.locator('.fm-call-window').boundingBox();
  await page.locator('.fm-call-window .fm-window-title').hover(); await page.mouse.down();
  await page.mouse.move(260,180,{steps:8}); await page.mouse.up();
  const callMoved = await page.locator('.fm-call-window').boundingBox();
  assert.notEqual(Math.round(callBefore.x),Math.round(callMoved.x));
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Float call',exact:true}).click();
  assert.deepEqual(await page.locator('.fm-call-window').boundingBox(),callMoved);
  await page.locator('.fm-channels-overlay .fm-ch-rich-editor').first().click();
  await page.getByRole('button',{name:'Dock conversation',exact:true}).click();
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  const conversationDock=await page.locator('.fm-channels-overlay').boundingBox();
  const callDock=await page.locator('.fm-call-window').boundingBox();
  const workspaceContent=await page.locator('#mainPanels').boundingBox();
  assert.ok(callDock.x + callDock.width <= conversationDock.x + 1,'docks do not overlap');
  assert.ok(workspaceContent.x + workspaceContent.width <= callDock.x + 1,'both docks reserve page space');
  await page.screenshot({path:path.join(output,'shared-window-docks.png')});
  await page.getByRole('button',{name:'Minimize call',exact:true}).click();
  await page.getByRole('button',{name:'Dock call',exact:true}).click();
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible());
  const leavesBeforeClose = await page.evaluate(()=>leftCalls.length);
  await page.getByRole('button',{name:'Close conversation',exact:true}).click();
  await page.locator('.fm-channels-overlay').waitFor({state:'hidden'});
  assert.ok(await page.locator('.fm-call-window[data-window=docked]').isVisible(),'closing conversation preserves call and its docked state');
  assert.equal(await page.evaluate(()=>leftCalls.length),leavesBeforeClose);
  await page.getByRole('button',{name:'Close call',exact:true}).click();
  await page.locator('.fm-call-window').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>leftCalls.length),leavesBeforeClose + 1);
  assert.deepEqual(errors, []);
  console.log(process.env.CHANNELS_LAYOUT_ONLY ? 'PASS shared windows: eight resize handles, four-button chrome, previous-state restore, independent calls, multiple docks, close lifecycle, profiles and navigation' : 'PASS rich text, table round-trip, overflow menu, scheduled send, screen clip review, call tiles/fullscreen/camera restart, real background processor, diagnostics, cleanup, docking, minimizing, dragging, pinning, Back/Forward');
  }

  if (!process.env.CHANNELS_LAYOUT_ONLY) {
  // A second test uses two real RTCPeerConnections and shared in-memory signaling.
  const participants = new Map(); const signals = []; let seq = 0;
  const room = () => ({id:'peer-call',channel_id:'team',started_by:'owner',state:'active',started_at:new Date().toISOString(),settings:{},participants:[...participants.values()],signaling:{mode:'browser-peer',ice_servers:[]}});
  const bridge = async (action, userId, input = {}) => {
    if (action === 'join') participants.set(userId,{user_id:userId,display_name:userId==='owner'?'Morgan Lee':'Jordan Ellis',microphone_enabled:true,camera_enabled:false,role:userId==='owner'?'host':'participant'});
    if (action === 'media') Object.assign(participants.get(userId),input);
    if (action === 'leave') participants.get(userId).left_at = new Date().toISOString();
    if (action === 'remove') { assert.equal(userId,'owner'); Object.assign(participants.get(input.userId),{role:'removed',left_at:new Date().toISOString()}); }
    if (action === 'signal') { signals.push({...input,seq:++seq}); return {}; }
    if (action === 'signals') return {signals:signals.filter(signal=>signal.seq>input.after && signal.sender_peer_id!==input.peerId && (!signal.target_peer_id || signal.target_peer_id===input.peerId)),cursor:seq};
    return {huddle:room()};
  };
  const peers = [];
  for (const userId of ['owner','guest']) {
    const peerPage = await browser.newPage({viewport:{width:1200,height:900}}); peerPage.setDefaultTimeout(25000);
    peerPage.on('pageerror',error=>errors.push(error.message));
    peerPage.on('console',message=>{if(message.type()==='warning'||message.type()==='error') console.log(userId, message.text());});
    await peerPage.goto(origin);
    await peerPage.exposeFunction('callBridge',bridge);
    await peerPage.evaluate(userId => {
      window.peerConnections = [];
      const NativePeer = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeer { constructor(...args) { super(...args); window.peerConnections.push(this); } };
      const channel = {id:'team',type:'public',name:'team',display_name:'Team',members:[{id:'owner',name:'Morgan Lee'},{id:'guest',name:'Jordan Ellis'}],unread:{}};
      const request = (action,input)=>window.callBridge(action,userId,input);
      window.__APP = {userId,userOrgId:'test-org'};
      window.Portal = {ui:{showToast:(title,detail)=>console.log(title,detail)}};
      window.ChannelsAPI = {
        channels:{list:async()=>({channels:[channel]})}, messages:{list:async()=>({channel,messages:[]})}, readState:{markRead:async()=>({})},
        huddles:{create:()=>request('create'),join:()=>request('join'),get:()=>request('get'),leave:()=>request('leave'),mediaState:(_org,_id,input)=>request('media',input),signal:(_org,_id,input)=>request('signal',input),signals:(_org,_id,peerId,after)=>request('signals',{peerId,after}),removeParticipant:(_org,_id,userId)=>request('remove',{userId})}
      };
      navigator.mediaDevices.getDisplayMedia = async()=>navigator.mediaDevices.getUserMedia({video:true,audio:true});
      window.peerOptions = {orgId:'test-org',mode:'full',currentUser:channel.members.find(person=>person.id===userId),realtime:false,features:{attention:false,resources:false,workflows:false,ai:false,typing:false,audioNotes:false,richMessages:false,channelCreate:false,channelSettings:true,recording:false}};
    }, userId);
    await peerPage.addScriptTag({url:origin+'/libraries/calls-runtime/livekit-client.umd.js'});
    await peerPage.addScriptTag({url:origin+'/libraries/window-manager/window-manager.js'});
    await peerPage.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
    await peerPage.evaluate(()=>window.instance=FirstMateChannels.create(document.querySelector('#app'),window.peerOptions));
    peers.push(peerPage);
  }
  await Promise.all(peers.map(async peerPage=>{
    await peerPage.getByTitle('Start or join huddle',{exact:true}).click();
    await peerPage.getByRole('button',{name:'Start or join',exact:true}).click();
    await peerPage.locator('.fm-ch-call-stage').waitFor();
  }));
  console.log('Two peers joined');
  await Promise.all(peers.map(peerPage=>peerPage.waitForFunction(()=>document.querySelector('.fm-ch-huddle-status').textContent.toLowerCase().includes('connected'))));
  await Promise.all(peers.map(peerPage=>peerPage.getByRole('button',{name:'Toggle camera',exact:true}).click()));
  try { await Promise.all(peers.map(peerPage=>peerPage.waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===2))); }
  catch(error) {
    for (const peerPage of peers) {
      const snapshot = await peerPage.evaluate(() => ({
        videos:document.querySelectorAll('.fm-ch-call-stage video').length,
        peers:peerConnections.map(peer => ({
          state:peer.connectionState, signaling:peer.signalingState,
          transceivers:peer.getTransceivers().map(item => ({mid:item.mid,direction:item.currentDirection})),
          senders:peer.getSenders().map(item => ({kind:item.track?.kind,enabled:item.track?.enabled,muted:item.track?.muted,state:item.track?.readyState})),
          receivers:peer.getReceivers().map(item => ({id:item.track.id,kind:item.track.kind,muted:item.track.muted,state:item.track.readyState}))
        }))
      }));
      console.log(JSON.stringify(snapshot));
    }
    console.log('Signaling sequence',signals.map(signal=>({kind:signal.kind,sender:signal.sender_peer_id.split('_')[0]})));
    throw error;
  }
  console.log('Two-way camera and audio connected');
  await peers[0].getByRole('button',{name:'Share screen',exact:true}).click();
  await peers[1].waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===3);
  assert.equal(await peers[1].locator('.fm-ch-huddle audio').count(),1);
  await peers[0].getByRole('button',{name:'Mute microphone',exact:true}).click();
  await peers[0].getByRole('button',{name:'Stop sharing',exact:true}).click();
  await peers[1].waitForFunction(()=>document.querySelectorAll('.fm-ch-call-stage video').length===2);
  await peers[0].getByRole('button',{name:'Participants',exact:true}).click();
  await peers[0].getByTitle('Remove Jordan Ellis',{exact:true}).click();
  await peers[0].getByRole('button',{name:'Remove',exact:true}).last().click();
  await peers[1].locator('.fm-ch-huddle').waitFor({state:'detached'});
  await peers[0].getByRole('button',{name:'Leave huddle',exact:true}).click();
  assert.deepEqual(errors,[]);
  for (const peerPage of peers) await peerPage.close();
  console.log('PASS two real peers: audio/video, concurrent cameras, screen + camera, screen stop, host removal');
  }
} catch (error) { console.error(error); await page.screenshot({path:path.join(output,'failure.png'),timeout:5000}).catch(()=>{}); throw error; }
finally { await browser.close(); server.close(); }


