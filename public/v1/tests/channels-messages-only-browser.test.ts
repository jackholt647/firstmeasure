import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

type Json = Record<string, any>;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  // SQLite/file-backed fixtures touch one JSON session per request. Serialize
  // this client's inject calls so Windows rename-over-existing cannot remove a
  // session under another touch. Held-read delivery still pauses before inject.
  let pending: Promise<unknown> = Promise.resolve();
  const raw = (method: string, url: string, payload?: unknown) => {
    const next = pending.then(() => app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    }));
    pending = next.catch(() => undefined);
    return next;
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-channels-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, "channels");
  process.env.CALLS_STORAGE_ROOT = path.join(storageRoot, "calls");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeChannelsDatabase } = await import("../channels/storage.js");
  const { closeCallsDatabase } = await import("../calls/storage.js");
  if (app) await app.close();
  (await closeChannelsDatabase());
  (await closeCallsDatabase());
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `channels-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Channels Owner",
    company: "Channels Test Org",
    organization_id: `org_channels_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { client, suffix, orgId: String(registered.organization.id), userId: String(registered.user.id) };
}

async function createOrgUser(
  owner: TestClient,
  orgId: string,
  suffix: string,
  name: string,
  options: { role?: string; permissions?: Json; field?: boolean } = {}
) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`;
  const password = `${name} test password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email,
      password,
      name,
      status: "active",
      role: options.role ?? "viewer",
      ...(options.permissions ? { org_permissions: { level: "custom", items: options.permissions } } : {}),
      send_invite: false
    }
  });
  const userId = String(created.document.id);
  if (options.field) {
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
      access_role_ids: ["crew_member"],
      application_access: {
        management: { enabled: false, role_id: "viewer", permissions: {} },
        field: { enabled: true, role_id: "crew_member", permissions: {} }
      }
    });
  }
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client, email };
}


test("Channels activity lives only in Messages and clears on viewing without replies, including persisted rows and later arrivals",async()=>{
 const {chromium}=await import('playwright-core');const {createServer}=await import('node:http');
 const {client:owner,orgId,suffix,userId:ownerId}=await registerOwner();
 const teammate=await createOrgUser(owner,orgId,suffix,'Read Teammate');
 const base=`/v1/channels/organizations/${orgId}`;
 const channel=(await owner.request('POST',base+'/channels',{type:'private',name:'read-proof',member_user_ids:[teammate.userId]})).channel;
 const general=(await owner.request('GET',base+'/channels')).channels.find((c:Json)=>c.name==='general');
 const post=base+'/channels/'+channel.id+'/messages';
 const root=(await owner.request('POST',post,{text:'Thread root'})).message;
 const ownReply=(await owner.request('POST',post,{text:'My earlier reply',parent_id:root.id})).message;
 await owner.request('POST',base+'/channels/'+channel.id+'/read',{last_read_seq:ownReply.seq});
 const reply=(await teammate.client.request('POST',post,{text:'Hidden unread reply',parent_id:root.id})).message;
 const unread=async()=>(await owner.request('GET',base+'/channels')).channels.find((item:Json)=>item.id===channel.id).unread;
 assert.equal((await unread()).unread_count,1);
 const {upsertDocument,readDocument}=await import('../platform/storage.js');
 const userDoc=await readDocument(orgId,'users',ownerId);
 await upsertDocument(orgId,'users',{id:ownerId,data:{...userDoc.data,notification_preferences:{in_app:{messages:true,mentions:true,channel_replies:true},in_app_bell:{messages:true,mentions:true,channel_replies:true}}}}, {replace:true});
 await upsertDocument(orgId,'notifications',{id:'persisted-message',data:{id:'persisted-message',kind:'channel_reply',category:'messages',preference_key:'channel_replies',source:'channel_message',title:'Old message bell',body:reply.text,status:'active',passive:true,target_user_ids:[ownerId],branch_id:'default',created_at:reply.created_at,frontend_action:{kind:'open_channel_message',channel_id:channel.id,message_id:reply.id,parent_id:root.id}}});
 await upsertDocument(orgId,'notifications',{id:'business-bell',data:{id:'business-bell',kind:'task',category:'tasks',source:'projects',title:'Business bell remains',status:'active',passive:true,target_user_ids:[ownerId],branch_id:'default',created_at:new Date().toISOString()}});
 const bell=await owner.request('GET',`/v1/platform/organizations/${orgId}/notifications`);
 assert.deepEqual(bell.notifications.map((n:Json)=>n.id),['business-bell']);
 const inbox=await owner.request('GET',base+'/inbox');assert.ok(inbox.entries.some((e:Json)=>e.message_id===reply.id),'actual Messages inbox contains reply');
 assert.equal(inbox.entries.filter((e:Json)=>e.message_id===reply.id||e.related_message_id===reply.id).length,1,'persisted duplicate does not create another Messages row');

 const output=path.resolve('../../output/channels-linear-20261005/pla32');await mkdir(output,{recursive:true});
 let failRead=false,holdNextRead=false;let releaseRead:()=>void=()=>{},signalRead:()=>void=()=>{};const readRequests:Json[]=[];
 const publicRoot=path.resolve('..');
 const server=createServer(async(req,res)=>{
  const name=new URL(req.url||'/','http://fixture').pathname;
  if(name==='/fixture'){
   let body='';for await(const part of req)body+=part;const input=JSON.parse(body);
   if(input.url.endsWith('/read')){readRequests.push({...input.payload,url:input.url});if(holdNextRead&&input.url.includes(channel.id)){holdNextRead=false;signalRead();await new Promise<void>(resolve=>releaseRead=resolve);}if(failRead){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'read failed'}}));return;}}
   const response=await owner.raw(input.method,input.url,input.payload);res.statusCode=response.statusCode;res.setHeader('Content-Type','application/json');res.end(response.body);return;
  }
  if(name==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><body style="margin:0"><div id="platformTopbar"><div id="platformMessagesSlot"><button id="platformMessagesBtn">Messages</button><span id="platformMessagesCount"></span></div><div id="platformMessagesMenu"><div id="platformMessagesList"></div></div><button id="platformBell">Notifications</button><span id="platformNotificationCount"></span><div id="platformNotificationMenu"><div class="ptb-menu-head"></div><div id="platformNotificationList"></div></div></div><div id="app" style="height:90vh"></div></body></html>');return;}
  const file=path.resolve(publicRoot,'.'+name);if(!file.startsWith(publicRoot+path.sep)){res.statusCode=403;res.end();return;}
  try{const data=name==='/libraries/channels-ui/channels-ui.js'&&process.env.UI_ASSET_PATH?await readFile(process.env.UI_ASSET_PATH):process.env.DEV_ASSETS?Buffer.from(await(await fetch('https://dev.1m8.ai'+name+'?read-proof='+Date.now())).arrayBuffer()):await readFile(file);res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(data);}catch{res.statusCode=404;res.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(8000);
 const mount=async()=>{
  await page.goto(origin);await page.evaluate(({orgId,ownerId,base})=>{
   const w=window as any;w.__name=(fn:any)=>fn;w.__APP={userId:ownerId,userOrgId:orgId};w.Portal={currentUser:{id:ownerId,name:'Channels Owner'},cfg:{userOrgId:orgId},util:{escapeHtml:(v:any)=>String(v||'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c])}};
   w.request=async(method:string,url:string,payload?:unknown)=>{const r=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,url,payload})});const data=await r.json();if(!r.ok)throw Error(data.error?.message);return data;};
   w.handlers=[];w.PlatformRealtime={subscribe:(_org:string,_prefix:string,handler:any)=>{w.handlers.push(handler);w.deliverEvent=(event:any)=>w.handlers.forEach((fn:any)=>fn(event));return()=>{};}};
   w.ChannelsAPI={channels:{list:()=>w.request('GET',base+'/channels'),get:(_o:string,id:string)=>w.request('GET',base+'/channels/'+id)},messages:{list:(_o:string,id:string)=>w.request('GET',base+'/channels/'+id+'/messages')},readState:{inbox:()=>w.request('GET',base+'/inbox'),inboxRead:(_o:string,e:any)=>w.request('POST',base+'/inbox/read',{entry_id:e.entry_id,message_id:e.message_id,kind:e.kind}),markRead:(_o:string,id:string,seq:number)=>w.request('POST',base+'/channels/'+id+'/read',{last_read_seq:seq})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})}};
   w.PlatformAPI={appFlags:{current:()=>({}),has:()=>true},notifications:{list:()=>w.request('GET',`/v1/platform/organizations/${orgId}/notifications`),acknowledge:(_o:string,id:string)=>w.request('POST',`/v1/platform/organizations/${orgId}/notification-deliveries/${id}/ack`,{})}};
   w.FirstMateChannelsNavigation={openMessage:async(d:any)=>{await w.instance.setChannel(d.channel_id);return true;}};
   w.options={orgId,currentUser:{id:ownerId,name:'Channels Owner'},features:{attention:false,resources:false,typing:false,channelSettings:false,channelCreate:false,recording:false,workflows:false,audioNotes:false}};
  },{orgId,ownerId,base});await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(()=>{const w=window as any;w.instance=w.FirstMateChannels.create(document.querySelector('#app'),w.options);});
  await page.addScriptTag({url:origin+'/libraries/platform-notifications/platform-notifications.js'});await page.addScriptTag({url:origin+'/portal/scripts/topbar.js'});await page.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));
  await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent!=='');
  await page.evaluate(async(org:string)=>{await (window as any).PlatformNotifications.load(org);},orgId);
  if((await owner.request('GET',base+'/inbox')).unread_total) assert.match(await page.locator('#platformMessagesList').innerText(),/reply/i);assert.match(await page.locator('#platformNotificationList').innerText(),/Business bell remains/);assert.doesNotMatch(await page.locator('#platformNotificationList').innerText(),/Hidden unread reply|Old message bell/);
  await page.locator('.fm-ch-side-row[data-channel-id="'+channel.id+'"]').waitFor();
 };
 const row=()=>page.locator('.fm-ch-side-row[data-channel-id="'+channel.id+'"]');
 const open=async()=>{await row().locator('.fm-ch-side-item').click();};
 const expectCleared=async()=>{const deadline=Date.now()+6000;while((await unread()).unread_count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));await row().locator('.fm-ch-badge').waitFor({state:'detached'});assert.equal((await unread()).unread_count,0);assert.equal((await unread()).mention_count,0);await page.evaluate(()=>{(window as any).deliverEvent({topic:'channels.read.updated'});});await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent==='0');assert.equal((await owner.request('GET',base+'/inbox')).entries.length,0);};
 try{
  await page.addInitScript('window.__name = fn => fn;');await mount();assert.equal(await row().locator('.fm-ch-badge').innerText(),'1');await page.locator('#platformMessagesBtn').click();await page.locator('#platformMessagesList [data-message-entry]').first().click();await expectCleared();assert.ok((await unread()).last_read_seq>=reply.seq);
  await page.evaluate(()=>(window as any).instance.refresh());await expectCleared();await mount();await expectCleared();
  const next=(await teammate.client.request('POST',post,{text:'Realtime thread reply',parent_id:root.id})).message;
  await page.evaluate(async({id,msg}:Json)=>{const w=window as any;await w.instance.setChannel(id);w.deliverEvent({topic:'channels.message.created',payload:{channel_id:id,message:msg}});},{id:channel.id,msg:next});await expectCleared();
  const active=(await teammate.client.request('POST',post,{text:'Already active reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},active);await page.waitForTimeout(1100);await expectCleared();
  const beforeHidden=(await unread()).last_read_seq;
  await page.evaluate(()=>{const w=window as any;w.fixtureHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>w.fixtureHidden});});
  const hidden=(await teammate.client.request('POST',post,{text:'Background reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},hidden);
  await page.waitForTimeout(1200);assert.equal((await unread()).last_read_seq,beforeHidden,'hidden channel must not acknowledge arrivals');
  await page.evaluate(()=>{(window as any).fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));});await expectCleared();
  await page.evaluate(()=>{document.querySelector<HTMLElement>('#app')!.style.display='none';});
  const hiddenApp=(await teammate.client.request('POST',post,{text:'Hidden app reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},hiddenApp);
  await page.waitForTimeout(1200);assert.ok((await unread()).unread_count>0,'a hidden component in a focused document must not acknowledge replies');
  await page.evaluate(()=>{document.querySelector<HTMLElement>('#app')!.style.display='';(window as any).instance.update();});await expectCleared();
  await page.setViewportSize({width:390,height:850});await page.getByRole('button',{name:'Back to channels',exact:true}).click();
  const mobile=(await teammate.client.request('POST',post,{text:'Mobile list reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},mobile);
  await page.waitForTimeout(1200);assert.ok((await unread()).unread_count>0,'mobile Back leaves the conversation unseen');
  await open();await expectCleared();await page.setViewportSize({width:1280,height:720});
  const nativeFocus=await page.evaluate(()=>document.hasFocus());assert.equal(nativeFocus,true);
  await page.evaluate(()=>{const w=window as any;w.fixtureFocused=false;w.originalFocus=document.hasFocus.bind(document);document.hasFocus=()=>w.fixtureFocused&&w.originalFocus();});
  const blurred=(await teammate.client.request('POST',post,{text:'Unfocused reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},blurred);
  await page.waitForTimeout(1200);assert.ok((await unread()).unread_count>0,'unfocused channel must retain unread replies');
  await page.evaluate(()=>{(window as any).fixtureFocused=true;window.dispatchEvent(new Event('focus'));});await expectCleared();
  await page.evaluate(async(id:string)=>(window as any).instance.setChannel(id),general.id);
  const mention=(await teammate.client.request('POST',post,{text:'New ordinary mention',mention_users:[{id:ownerId}]})).message;
  await page.evaluate(()=>(window as any).instance.refresh());await row().locator('.fm-ch-badge').waitFor({state:'visible'});assert.equal((await unread()).mention_count,1);
  failRead=true;await open();await page.waitForTimeout(1100);assert.ok((await unread()).unread_count>0);assert.ok(await row().locator('.fm-ch-badge').isVisible());
  failRead=false;await open();await expectCleared();assert.ok((await unread()).last_read_seq>=mention.seq);
  await page.evaluate(async(id:string)=>(window as any).instance.setChannel(id),general.id);
  const raced=(await teammate.client.request('POST',post,{text:'Read request snapshot',parent_id:root.id})).message;
  await page.evaluate(()=>(window as any).instance.refresh());await row().locator('.fm-ch-badge').waitFor({state:'visible'});
  const entered=new Promise<void>(resolve=>signalRead=resolve);holdNextRead=true;await open();
  await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('read request was not entered')),5000))]);
  await page.evaluate(async(id:string)=>(window as any).instance.setChannel(id),general.id);
  const unseen=(await teammate.client.request('POST',post,{text:'Later unseen reply',parent_id:root.id})).message;
  await page.evaluate((msg:Json)=>{const w=window as any;w.deliverEvent({topic:'channels.message.created',payload:{channel_id:msg.channel_id,message:msg}});},unseen);
  await upsertDocument(orgId,'notifications',{id:'held-read-huddle',data:{id:'held-read-huddle',source:'channels',kind:'huddle_invite',category:'messages',title:'Huddle after held read',body:'Later unseen activity',status:'active',passive:true,target_user_ids:[ownerId],branch_id:'default',created_at:new Date().toISOString(),frontend_action:{kind:'open_channel_message',channel_id:channel.id}}});
  releaseRead();await page.waitForTimeout(1200);assert.ok((await owner.request('GET',base+'/inbox')).entries.some((e:Json)=>e.title==='Huddle after held read'),'later unsequenced huddle survives older held read');
  assert.equal((await unread()).last_read_seq,raced.seq,'acknowledgement is bounded to the original loaded snapshot');
  assert.equal((await unread()).unread_count,1,'a later unseen arrival survives an older request');
  assert.equal(await page.evaluate(()=>(window as any).instance.state.activeChannelId),general.id,'late response cannot switch or clear the newly active channel');
  await row().locator('.fm-ch-badge').waitFor({state:'visible'});await page.evaluate(()=>{(window as any).deliverEvent({topic:'channels.unreads.changed'});});await page.locator('#platformMessagesList [data-message-entry]').filter({hasText:'Huddle after held read'}).waitFor();await page.locator('#platformMessagesBtn').click();await page.locator('#platformMessagesList [data-message-entry]').filter({hasText:'Huddle after held read'}).click();await expectCleared();
  await upsertDocument(orgId,'notifications',{id:'native-huddle',data:{id:'native-huddle',source:'channels',kind:'huddle_invite',category:'messages',title:'Native huddle invitation',body:'Join the team',status:'active',passive:true,target_user_ids:[ownerId],branch_id:'default',created_at:new Date().toISOString(),frontend_action:{kind:'open_channel_message',channel_id:channel.id,huddle_id:'fixture-huddle'}}});
  await page.evaluate(()=>{(window as any).deliverEvent({topic:'channels.unreads.changed'});});await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent==='1');
  await page.locator('#platformMessagesBtn').click();await page.locator('#platformMessagesList [data-message-entry]').filter({hasText:'Native huddle invitation'}).click();await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent==='0');const savedDeadline=Date.now()+5000;while((await owner.request('GET',base+'/inbox')).entries.length&&Date.now()<savedDeadline)await page.waitForTimeout(100);assert.equal((await owner.request('GET',base+'/inbox')).entries.length,0,'opened lifecycle notification persists as read');
  // Mount the real Messages list against a bounded project inbox response and
  // exercise native clicks: occurrence IDs acknowledge alerts, never select notes.
  await page.evaluate(()=>{
   const w=window as any;w.projectRoutes=[];w.projectApplies=0;w.projectReads=[];
   w.Portal.navigation={navigate:(route:any)=>w.projectRoutes.push(route),applyCurrent:async()=>{w.projectApplies++;}};
   w.projectInbox=[
    {entry_id:'project-linked',kind:'activity',channel_type:'project',channel_id:'project-channel',project_id:'project-route',message_id:'notification-occurrence',related_message_id:'actual-project-message',title:'Linked project activity',text:'Updated project message',unread:true,at:new Date().toISOString()},
    {entry_id:'project-lifecycle',kind:'activity',channel_type:'project',channel_id:'project-channel',project_id:'project-route',message_id:'lifecycle-occurrence',related_message_id:'',title:'Project lifecycle activity',text:'Lifecycle without message',unread:true,at:new Date().toISOString()},
    {entry_id:'project-native',kind:'mention',channel_type:'project',channel_id:'project-channel',project_id:'project-route',message_id:'ordinary-project-message',title:'Native project message',text:'Ordinary project message',unread:true,at:new Date().toISOString()}
   ];
   w.ChannelsAPI.readState.inbox=async()=>({entries:w.projectInbox,unread_total:w.projectInbox.length});
   w.ChannelsAPI.readState.inboxRead=async(_org:any,entry:any)=>{w.projectReads.push({entry_id:entry.entry_id,message_id:entry.message_id,kind:entry.kind});w.projectInbox=w.projectInbox.filter((e:any)=>e.entry_id!==entry.entry_id);return{read:true};};
   w.deliverEvent({topic:'channels.unreads.changed'});
  });
  await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent==='3');
  for(const [id,note,occurrence,kind] of [['project-linked','actual-project-message','notification-occurrence','activity'],['project-lifecycle',null,'lifecycle-occurrence','activity'],['project-native','ordinary-project-message','ordinary-project-message','mention']] as const){
   await page.locator('#platformMessagesBtn').click();await page.locator('#platformMessagesList [data-message-entry]').first().click();
   await page.waitForFunction((entryId:string)=>(window as any).projectReads.some((e:any)=>e.entry_id===entryId),id);
   const captured=await page.evaluate(()=>{const w=window as any;return{route:w.projectRoutes.at(-1),read:w.projectReads.at(-1),applies:w.projectApplies};});
   assert.deepEqual(captured.route,{project:'project-route',projectTab:'materials',projectNote:note});
   assert.deepEqual(captured.read,{entry_id:id,message_id:occurrence,kind});
   assert.equal(captured.applies,(await page.evaluate(()=>(window as any).projectReads.length)),'project route applies before acknowledgement');
  }
  await page.waitForFunction(()=>document.querySelector('#platformMessagesCount')?.textContent==='0');
  await page.screenshot({path:path.join(output,'read-cleared.png')});await page.evaluate(()=>(window as any).instance.destroy());
 }finally{releaseRead();await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test("Messages includes Channels lifecycle and followed replies, respects Off/Silent/mutes/access and bounded reads", async()=>{
 const {client:owner,orgId,suffix,userId:ownerId}=await registerOwner();
 const teammate=await createOrgUser(owner,orgId,suffix,'Inbox Teammate');
 const base=`/v1/channels/organizations/${orgId}`;
 const channel=(await owner.request('POST',base+'/channels',{type:'private',name:'message-lanes',member_user_ids:[teammate.userId]})).channel;
 const post=base+'/channels/'+channel.id+'/messages';
 const root=(await teammate.client.request('POST',post,{text:'Someone else started this thread'})).message;
 await owner.request('PUT',base+'/threads/'+root.id+'/subscription',{following:true,notify_level:'all'});
 await owner.request('POST',base+'/channels/'+channel.id+'/read',{last_read_seq:root.seq});
 const reply=(await teammate.client.request('POST',post,{text:'Followed thread arrival',parent_id:root.id})).message;
 const inbox=()=>owner.request('GET',base+'/inbox');
 assert.ok((await inbox()).entries.some((e:Json)=>e.kind==='reply'&&e.message_id===reply.id),'following participant receives actual Messages row');
 const {upsertDocument,readDocument}=await import('../platform/storage.js');
 const setPrefs=async(prefs:Json)=>{const d=await readDocument(orgId,'users',ownerId);await upsertDocument(orgId,'users',{id:ownerId,data:{...d.data,notification_preferences:prefs}},{replace:true});};
 await setPrefs({in_app:{channel_replies:false}});assert.ok(!(await inbox()).entries.some((e:Json)=>e.message_id===reply.id),'Off hides existing reply');
 await setPrefs({in_app:{channel_replies:true},in_app_sound:{channel_replies:false}});assert.ok((await inbox()).entries.some((e:Json)=>e.message_id===reply.id),'Silent remains in Messages');
 await owner.request('PUT',base+'/threads/'+root.id+'/subscription',{following:true,notify_level:'muted'});assert.ok(!(await inbox()).entries.some((e:Json)=>e.message_id===reply.id));
 await owner.request('PUT',base+'/threads/'+root.id+'/subscription',{following:true,notify_level:'all'});
 await owner.request('POST',base+'/channels/'+channel.id+'/read',{last_read_seq:reply.seq});assert.equal((await inbox()).entries.length,0);
 const notice=async(id:string,source:string,extra:Json={})=>upsertDocument(orgId,'notifications',{id,data:{id,title:id,body:'Channels activity',kind:'huddle_invite',source,category:'messages',target_user_ids:[ownerId],status:'active',passive:true,branch_id:'default',created_at:new Date().toISOString(),frontend_action:{kind:'open_channel_message',channel_id:channel.id},...extra}});
 await notice('huddle-current','channels');await notice('wrong-branch','channels',{branch_id:'other'});
 let entries=(await inbox()).entries;assert.equal(entries.length,1);assert.equal(entries[0].title,'huddle-current');assert.equal(entries[0].kind,'activity');
 let bells=await owner.request('GET',`/v1/platform/organizations/${orgId}/notifications`);assert.ok(!bells.notifications.some((n:Json)=>n.id==='huddle-current'));
 await owner.request('POST',base+'/inbox/read',{entry_id:entries[0].entry_id,message_id:entries[0].message_id,kind:'activity'});assert.equal((await inbox()).entries.length,0,'specific activity read persists without posting');
 await notice('huddle-later','channels');entries=(await inbox()).entries;assert.equal(entries[0].title,'huddle-later','later activity survives prior item acknowledgement');
 const {createEventRecord}=await import('../work/storage.js');
 const {event}=await createEventRecord({organization_id:orgId,branch_id:'default',type:'channels.channel.archived',payload:{channel_id:channel.id},idempotency_key:'message-lifecycle-event'});
 await setPrefs({in_app:{messages:true,'event.channels.channel.archived':true},in_app_bell:{messages:true,'event.channels.channel.archived':true}});
 await notice('channel-lifecycle','work.event',{kind:'passive',preference_key:'event.channels.channel.archived',context:{event_id:event!.id},frontend_action:{}});
 entries=(await inbox()).entries;assert.ok(entries.some((e:Json)=>e.title==='channel-lifecycle'),'native work event resolves authorized channel routing');
 bells=await owner.request('GET',`/v1/platform/organizations/${orgId}/notifications`);assert.ok(!bells.notifications.some((n:Json)=>n.id==='channel-lifecycle'));
 await owner.request('POST',base+'/channels/'+channel.id+'/read',{last_read_seq:reply.seq});assert.equal((await inbox()).entries.length,2,'unsequenced lifecycle notices survive a message-only bounded read');
 for(const entry of (await inbox()).entries) await owner.request('POST',base+'/inbox/read',{entry_id:entry.entry_id,message_id:entry.message_id,kind:entry.kind});assert.equal((await inbox()).entries.length,0,'opening each lifecycle notice acknowledges its exact occurrence');
 const {listChannelRecords,listMembershipChannelIds}=await import('../channels/storage.js');
 const beforeChannels=(await listChannelRecords(orgId,{includeArchived:true})).map(c=>c.id).sort();
 const beforeMemberships=(await listMembershipChannelIds(orgId,teammate.userId)).sort();
 await owner.request('POST',base+'/channels/'+channel.id+'/archive',{});
 await notice('member-archive','channels',{kind:'passive',target_user_ids:[teammate.userId],preference_key:'messages'});
 const memberInbox=()=>teammate.client.request('GET',base+'/inbox');
 const archivedEntry=(await memberInbox()).entries.find((e:Json)=>e.title==='member-archive');
 assert.ok(archivedEntry,'ordinary authorized member receives an actually archived channel alert');
 assert.deepEqual((await listChannelRecords(orgId,{includeArchived:true})).map(c=>c.id).sort(),beforeChannels,'inbox reads do not create default or assistant channels');
 assert.deepEqual((await listMembershipChannelIds(orgId,teammate.userId)).sort(),beforeMemberships,'inbox reads do not enroll the viewer in default channels');
 const deniedPost=await teammate.client.raw('POST',post,{text:'cannot post into archived channel'});assert.equal(deniedPost.statusCode,400);assert.match(deniedPost.body,/channel_archived/);
 await teammate.client.request('POST',base+'/inbox/read',{entry_id:archivedEntry.entry_id,message_id:archivedEntry.message_id,kind:'activity'});
 assert.ok(!(await memberInbox()).entries.some((e:Json)=>e.title==='member-archive'),'archived alert acknowledgement persists');
 await notice('revoked-archive','channels',{kind:'passive',target_user_ids:[teammate.userId],preference_key:'messages'});
 await owner.request('DELETE',base+'/channels/'+channel.id+'/members/'+teammate.userId);
 assert.equal((await memberInbox()).entries.length,0,'removed member cannot see archived private-channel alerts');
 await owner.request('POST',base+'/channels/'+channel.id+'/unarchive',{});
 await owner.request('POST',base+'/channels/'+channel.id+'/members',{user_ids:[teammate.userId]});
 await notice('private-after-removal','channels');await owner.request('PATCH',base+'/channels/'+channel.id+'/members/'+teammate.userId,{role:'admin'});await owner.request('DELETE',base+'/channels/'+channel.id+'/members/'+ownerId);assert.equal((await inbox()).entries.length,0,'fresh membership revocation removes private activity');
});


test("separated project notes stay outside Messages occurrence bridge while ordinary project activity remains",async()=>{
 const {client:owner,orgId,userId:ownerId}=await registerOwner();
 const {saveCapabilityValues}=await import('../platform/capabilities.js');
 const {upsertDocument}=await import('../platform/storage.js');
 const base=`/v1/channels/organizations/${orgId}`;
 const project=(await owner.request('POST',`/v1/platform/organizations/${orgId}/projects`,{data:{title:'Separated occurrence project'}})).document;
 const channel=(await owner.request('POST',base+'/channels/project/'+project.id)).channel;
 const note=(await owner.request('POST',base+'/channels/'+channel.id+'/messages',{text:'Separate note',project_note:true})).message;
 const message=(await owner.request('POST',base+'/channels/'+channel.id+'/messages',{text:'Ordinary project message'})).message;
 const add=async(id:string,messageId:string)=>upsertDocument(orgId,'notifications',{id,data:{id,title:id,body:'Recent project activity',source:'project_message',kind:'passive',category:'messages',target_user_ids:[ownerId],status:'active',passive:true,branch_id:'default',created_at:new Date().toISOString(),frontend_action:{kind:'open_project_message',project_id:project.id,channel_id:channel.id,message_id:messageId}}});
 await add('persisted-separated-note',note.id);await add('ordinary-project-activity',message.id);
 await saveCapabilityValues(orgId,{'channels.separate_project_notes':true});
 const inbox=()=>owner.request('GET',base+'/inbox');
 let entries=(await inbox()).entries;assert.ok(!entries.some((e:Json)=>e.title==='persisted-separated-note'),'old linked note occurrence obeys current project-note separation');
 const visible=entries.find((e:Json)=>e.title==='ordinary-project-activity');assert.ok(visible);assert.equal(visible.channel_type,'project');assert.equal(visible.project_id,project.id);assert.equal(visible.related_message_id,message.id);
 await saveCapabilityValues(orgId,{'channels.separate_project_notes':false});
 assert.ok((await inbox()).entries.some((e:Json)=>e.title==='persisted-separated-note'),'feature reversal preserves existing non-separated visibility');
 await saveCapabilityValues(orgId,{'channels.separate_project_notes':true});
 await owner.request('POST',base+'/inbox/read',{entry_id:visible.entry_id,message_id:visible.message_id,kind:'activity'});assert.equal((await inbox()).entries.length,0,'acknowledges only the visible occurrence while separated note remains excluded');
});
