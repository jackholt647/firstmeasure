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
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await app.inject({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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


test("Channels header totals unread messages across sections, clears on open and persists on mobile",async()=>{
 const {chromium}=await import('playwright-core');const {createServer}=await import('node:http');
 const {client:owner,orgId,suffix,userId:ownerId}=await registerOwner();
 const teammate=await createOrgUser(owner,orgId,suffix,'Read Teammate');
 const base=`/v1/channels/organizations/${orgId}`;
 const channel=(await owner.request('POST',base+'/channels',{type:'private',name:'read-proof',member_user_ids:[teammate.userId]})).channel;
 const general=(await owner.request('GET',base+'/channels')).channels.find((c:Json)=>c.name==='general');
 const second=(await owner.request('POST',base+'/channels',{type:'private',name:'count-two',member_user_ids:[teammate.userId]})).channel;
 await owner.request('PUT',base+'/sidebar-sections/count-custom',{label:'Custom',channel_ids:[second.id]});
 const post=base+'/channels/'+channel.id+'/messages';
 const root=(await owner.request('POST',post,{text:'Thread root'})).message;
 const ownReply=(await owner.request('POST',post,{text:'My earlier reply',parent_id:root.id})).message;
 await owner.request('POST',base+'/channels/'+channel.id+'/read',{last_read_seq:ownReply.seq});
 const reply=(await teammate.client.request('POST',post,{text:'Hidden unread reply',parent_id:root.id})).message;
 const unread=async()=>(await owner.request('GET',base+'/channels')).channels.find((item:Json)=>item.id===channel.id).unread;
 assert.equal((await unread()).unread_count,1);
 await teammate.client.request('POST',base+'/channels/'+second.id+'/messages',{text:'Second channel unread'});
 const dm=(await owner.request('POST',base+'/channels',{type:'dm',member_user_ids:[teammate.userId]})).channel;
 await teammate.client.request('POST',base+'/channels/'+dm.id+'/messages',{text:'DM unread stays separate'});
 const hidden=(await owner.request('POST',base+'/channels',{type:'private',name:'hidden-count',member_user_ids:[teammate.userId]})).channel;
 await teammate.client.request('POST',base+'/channels/'+hidden.id+'/messages',{text:'Hidden unread stays excluded'});
 await owner.request('PATCH',base+'/collaboration-preferences',{hidden_channel_ids:[hidden.id]});
 const output=path.resolve('../../output/channels-linear-20261005/pla24');await mkdir(output,{recursive:true});
 let failRead=false,holdNextRead=false;let releaseRead:()=>void=()=>{},signalRead:()=>void=()=>{};const readRequests:Json[]=[];
 const publicRoot=path.resolve('..');
 const server=createServer(async(req,res)=>{
  const name=new URL(req.url||'/','http://fixture').pathname;
  if(name==='/fixture'){
   let body='';for await(const part of req)body+=part;const input=JSON.parse(body);
   if(input.url.endsWith('/read')){readRequests.push({...input.payload,url:input.url});if(holdNextRead&&input.url.includes(channel.id)){holdNextRead=false;signalRead();await new Promise<void>(resolve=>releaseRead=resolve);}if(failRead){res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'read failed'}}));return;}}
   const response=await owner.raw(input.method,input.url,input.payload);res.statusCode=response.statusCode;res.setHeader('Content-Type','application/json');res.end(response.body);return;
  }
  if(name==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><body style="margin:0"><div id="app" style="height:100vh"></div></body></html>');return;}
  const file=path.resolve(publicRoot,'.'+name);if(!file.startsWith(publicRoot+path.sep)){res.statusCode=403;res.end();return;}
  try{const data=name==='/libraries/channels-ui/channels-ui.js'&&process.env.UI_ASSET_PATH?await readFile(process.env.UI_ASSET_PATH):process.env.DEV_ASSETS?Buffer.from(await(await fetch('https://dev.1m8.ai'+name+'?read-proof='+Date.now())).arrayBuffer()):await readFile(file);res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(data);}catch{res.statusCode=404;res.end();}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage();page.setDefaultTimeout(8000);
 const mount=async()=>{
  await page.goto(origin);await page.evaluate(({orgId,ownerId,base})=>{
   const w=window as any;w.__name=(fn:any)=>fn;w.__APP={userId:ownerId,userOrgId:orgId};w.Portal={currentUser:{id:ownerId,name:'Channels Owner'}};
   w.request=async(method:string,url:string,payload?:unknown)=>{const r=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,url,payload})});const data=await r.json();if(!r.ok)throw Error(data.error?.message);return data;};
   w.PlatformRealtime={subscribe:(_org:string,_prefix:string,handler:any)=>{w.deliverEvent=handler;return()=>{};}};
   w.ChannelsAPI={preferences:{collaboration:()=>w.request('GET',base+'/collaboration-preferences')},sidebarSections:{list:()=>w.request('GET',base+'/sidebar-sections')},channels:{list:()=>w.request('GET',base+'/channels'),get:(_o:string,id:string)=>w.request('GET',base+'/channels/'+id)},messages:{list:(_o:string,id:string)=>w.request('GET',base+'/channels/'+id+'/messages')},readState:{markRead:(_o:string,id:string,seq:number)=>w.request('POST',base+'/channels/'+id+'/read',{last_read_seq:seq})},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})}};
   w.options={orgId,currentUser:{id:ownerId,name:'Channels Owner'},features:{attention:true,resources:false,typing:false,channelSettings:false,channelCreate:false,recording:false,workflows:false,audioNotes:false}};
  },{orgId,ownerId,base});await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
  await page.evaluate(()=>{const w=window as any;w.instance=w.FirstMateChannels.create(document.querySelector('#app'),w.options);});
  await page.locator('.fm-ch-side-row[data-channel-id="'+channel.id+'"]').waitFor();
 };
 const row=()=>page.locator('.fm-ch-side-row[data-channel-id="'+channel.id+'"]');
 const open=async()=>{await row().locator('.fm-ch-side-item').click();};
 const expectCleared=async()=>{const deadline=Date.now()+6000;while((await unread()).unread_count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));await row().locator('.fm-ch-badge').waitFor({state:'detached'});assert.equal((await unread()).unread_count,0);assert.equal((await unread()).mention_count,0);};
 const header=()=>page.locator('.fm-ch-side-head').filter({has:page.locator('.fm-ch-side-title',{hasText:/^Channels$/})});
 const count=()=>header().locator('.fm-ch-group-badge');
 const expectCount=async(n:number)=>{if(n){await count().filter({hasText:String(n)}).waitFor();assert.equal(await count().innerText(),String(n));assert.equal(await count().getAttribute('aria-label'),`${n} unread ${n===1?'message':'messages'} in Channels`);}else await count().waitFor({state:'detached'});};
 const secondRow=()=>page.locator('.fm-ch-side-row[data-channel-id="'+second.id+'"]');
 try{
  await page.addInitScript('window.__name = fn => fn;');await mount();await expectCount(2);assert.equal(await row().locator('.fm-ch-badge').innerText(),'1');assert.equal(await secondRow().locator('.fm-ch-badge').innerText(),'1');assert.equal(await page.locator('.fm-ch-side-row[data-channel-id="'+dm.id+'"] .fm-ch-badge').innerText(),'1');assert.equal(await page.locator('.fm-ch-side-row[data-channel-id="'+hidden.id+'"]').count(),0);
  const colors=await count().evaluate(e=>({bg:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color}));assert.equal(colors.bg,'rgb(217, 48, 37)');assert.equal(colors.color,'rgb(255, 255, 255)');
  await header().click();await expectCount(2);assert.equal(await header().locator('.fm-ch-side-toggle').getAttribute('aria-expanded'),'false');await header().click();
  await open();await expectCleared();await expectCount(1);await mount();await expectCount(1);await page.evaluate(()=>(window as any).instance.refresh());await expectCount(1);
  await page.setViewportSize({width:390,height:850});await mount();await expectCount(1);assert.ok(await count().isVisible());await secondRow().locator('.fm-ch-side-item').click();await page.getByRole('button',{name:'Back to channels',exact:true}).click();await expectCount(1);
  await secondRow().locator('.fm-ch-side-item').click();await page.waitForTimeout(1200);await page.getByRole('button',{name:'Back to channels',exact:true}).click();await expectCount(0);await mount();await expectCount(0);
  await teammate.client.request('POST',post,{text:'Fresh unread reply',parent_id:root.id});await page.evaluate(()=>(window as any).instance.refresh());await expectCount(1);assert.equal(await row().locator('.fm-ch-badge').innerText(),'1');
  await page.screenshot({path:path.join(output,'channels-header-unread.png')});
 }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
