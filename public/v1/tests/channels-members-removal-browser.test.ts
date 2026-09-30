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

test("real API owner and channel admin retain visible removal after refresh and reopen", async () => {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("node:http");
  const {client:owner,orgId,suffix,userId:ownerId}=await registerOwner();
  const admin=await createOrgUser(owner,orgId,suffix,"Channel Admin");
  const member=await createOrgUser(owner,orgId,suffix,"Regular Member");
  const base=`/v1/channels/organizations/${orgId}`;
  const channel=(await owner.request("POST",`${base}/channels`,{type:"private",name:"removal-proof",member_user_ids:[admin.userId,member.userId]})).channel;
  await owner.request("PATCH",`${base}/channels/${channel.id}/members/${admin.userId}`,{role:"admin"});
  const clients:Record<string,TestClient>={owner,admin:admin.client,member:member.client};
  const publicRoot=path.resolve('..');
  const output=path.resolve('../../output/channels-linear-20260929/pla15-r3');await mkdir(output,{recursive:true});
  let failNextRemoval=true;
  const server=createServer(async(req,res)=>{
    const name=new URL(req.url||'/', 'http://localhost').pathname;
    if(name==='/fixture'){
      let body='';for await(const part of req)body+=part;
      const input=JSON.parse(body);
      if(input.method==='DELETE' && input.url.includes('/members/')) {
        await new Promise(resolve=>setTimeout(resolve,160));
        if(failNextRemoval){failNextRemoval=false;res.statusCode=503;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'Temporary fixture failure'}}));return;}
      }
      const result=await clients[input.viewer]!.raw(input.method,input.url,input.payload);
      res.statusCode=result.statusCode;res.setHeader('Content-Type','application/json');res.end(result.body);return;
    }
    if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body style="margin:0;font-family:Arial"><div id="app" style="height:100vh"></div></body></html>');return;}
    const filename=path.resolve(publicRoot,'.'+name);if(!filename.startsWith(publicRoot+path.sep)){res.statusCode=403;res.end();return;}
    try{const contents=process.env.DEV_ASSETS?Buffer.from(await(await fetch('https://dev.1m8.ai'+name+'?members-r2='+Date.now())).arrayBuffer()):await readFile(filename);res.setHeader('Content-Type','text/javascript');res.end(contents);}catch{res.statusCode=404;res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};const origin=`http://127.0.0.1:${address.port}`;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:900}});page.setDefaultTimeout(15000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.addInitScript('window.__name = function(value) { return value; };');
    await page.goto(origin);
    await page.evaluate(({orgId,ownerId,base})=>{
      const w=window as any;w.viewer='owner';w.__APP={userId:ownerId,userOrgId:orgId};w.Portal={currentUser:{id:ownerId,name:'Channels Owner'},toast:(message:string)=>w.lastToast=message,ui:{showToast:(...args:any[])=>w.lastToast=args}};
      w.request=async(method:string,url:string,payload?:unknown)=>{const response=await fetch('/fixture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({viewer:w.viewer,method,url,payload})});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'API failed');return data;};
      w.ChannelsAPI={channels:{list:()=>w.request('GET',base+'/channels'),get:(_org:string,id:string)=>w.request('GET',base+'/channels/'+id),removeMember:(_org:string,id:string,userId:string)=>w.request('DELETE',base+'/channels/'+id+'/members/'+userId),addMembers:(_org:string,id:string,userIds:string[])=>w.request('POST',base+'/channels/'+id+'/members',{user_ids:userIds}),setRole:(_org:string,id:string,userId:string,role:string)=>w.request('PATCH',base+'/channels/'+id+'/members/'+userId,{role})},messages:{list:(_org:string,id:string)=>w.request('GET',base+'/channels/'+id+'/messages')},directory:{list:()=>w.request('GET',base+'/directory')},drafts:{get:async()=>({}),save:async()=>({}),remove:async()=>({})}};
      w.options={orgId,currentUser:{id:ownerId,name:'Channels Owner'},realtime:false,features:{attention:false,resources:false,workflows:false,typing:false,audioNotes:false,channelCreate:false,channelSettings:true,recording:false}};
    },{orgId,ownerId,base});
    await page.addScriptTag({url:origin+'/libraries/channels-ui/channels-ui.js'});
    await page.evaluate(async(channelId)=>{const w=window as any;w.instance=w.FirstMateChannels.create(document.querySelector('#app'),w.options);await w.instance.setChannel(channelId);},channel.id);
    const open=async()=>{await page.getByRole('button',{name:/People in channel/}).click();return page.getByRole('dialog');};
    for(const viewer of ['owner','admin']){
      if(viewer==='admin')await page.evaluate(async({userId,channelId})=>{const w=window as any;w.instance.destroy();w.viewer='admin';w.instance=w.FirstMateChannels.create(document.querySelector('#app'),{...w.options,currentUser:{id:userId,name:'Channel Admin'}});await w.instance.setChannel(channelId);},{userId:admin.userId,channelId:channel.id});
      const payload=await clients[viewer]!.request('GET',base+'/channels/'+channel.id);assert.equal(payload.channel.can_manage,true,viewer+' API can_manage');
      let dialog=await open();
      let remove=dialog.getByRole('button',{name:'Remove Regular Member from channel',exact:true});await remove.waitFor();assert.equal(await remove.innerText(),'Remove');assert.ok((await remove.boundingBox())!.width>45);
      await page.screenshot({path:path.join(output,`remove-${viewer}${process.env.DEV_ASSETS?'-dev':''}.png`)});
      await dialog.getByRole('searchbox',{name:'Search channel members',exact:true}).fill('Regular');
      await page.evaluate(()=>{
        const w=window as any;w.originalDialog=document.querySelector('[role=dialog]');w.originalBackdrop=w.originalDialog.closest('.fm-ch-modal-backdrop');w.modalCycles=0;
        w.modalObserver=new MutationObserver(records=>{for(const record of records)for(const node of [...record.addedNodes,...record.removedNodes])if(node===w.originalBackdrop || node===w.originalDialog || (node instanceof Element && node.matches('.fm-ch-modal-backdrop')))w.modalCycles++;});w.modalObserver.observe(document.body,{childList:true,subtree:true});
      });
      await remove.click();
      if(viewer==='owner'){
        await page.waitForFunction(()=>String((window as any).lastToast).includes('Temporary fixture failure'));
        await page.waitForFunction(()=>!document.querySelector('[aria-label="Remove Regular Member from channel"]')?.hasAttribute('disabled'));
        assert.equal(await dialog.getByRole('searchbox',{name:'Search channel members',exact:true}).inputValue(),'Regular');
        assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Remove Regular Member from channel');
        await dialog.getByRole('button',{name:'Remove Regular Member from channel',exact:true}).click();
      }
      assert.equal(await page.evaluate(()=>(window as any).originalDialog.isConnected),true);

      await dialog.getByRole('button',{name:new RegExp('Select Regular Member')}).waitFor();
      await page.locator('.fm-ch-system-line').getByText('Regular Member was removed from the channel.',{exact:true}).first().waitFor();
      assert.equal((await member.client.raw('GET',base+'/channels/'+channel.id+'/messages')).statusCode,403);
      assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Search channel members');
      await dialog.getByRole('button',{name:new RegExp('Select Regular Member')}).click();
      await dialog.getByRole('button',{name:'Add selected people',exact:true}).click();
      await dialog.getByRole('button',{name:'Remove Regular Member from channel',exact:true}).waitFor();
      assert.equal(await dialog.getByRole('searchbox',{name:'Search channel members',exact:true}).inputValue(),'Regular');
      assert.equal(await page.evaluate(()=>(window as any).originalDialog.isConnected && (window as any).originalDialog===document.querySelector('[role=dialog]')),true);
      assert.equal(await page.evaluate(()=>(window as any).modalCycles),0,'no modal/backdrop add or remove cycle');
      assert.equal(await dialog.getByRole('button',{name:'Add selected people',exact:true}).isDisabled(),true,'Add disabled after selections consumed');
      await page.evaluate(()=>(window as any).modalObserver.disconnect());
      await dialog.getByRole('button',{name:'Done',exact:true}).click();
      await page.evaluate(async()=>{const w=window as any;await w.instance.refresh();});
      dialog=await open();await dialog.getByRole('button',{name:'Remove Regular Member from channel',exact:true}).waitFor();await dialog.getByRole('button',{name:'Done',exact:true}).click();
    }
    // Hold a real DELETE until after Done closes the original dialog.
    let releaseDelete:()=>void=()=>{};let deletionEntered:()=>void=()=>{};
    const entered=new Promise<void>(resolve=>deletionEntered=resolve);
    const held=new Promise<void>(resolve=>releaseDelete=resolve);
    await page.route('**/fixture',async route=>{
      const input=route.request().postDataJSON();
      if(input.method==='DELETE' && input.url.endsWith('/members/'+member.userId)){deletionEntered();await held;}
      await route.continue();
    });
    const closingDialog=await open();await closingDialog.getByRole('button',{name:'Remove Regular Member from channel',exact:true}).click();await entered;
    await closingDialog.getByRole('button',{name:'Done',exact:true}).click();await closingDialog.waitFor({state:'hidden'});
    const completed=page.waitForResponse(response=>response.url().endsWith('/fixture') && response.request().postDataJSON().method==='DELETE');
    releaseDelete();await completed;await page.waitForTimeout(200);
    assert.equal(await page.getByRole('dialog').count(),0,'late removal completion does not resurrect closed modal');
    await page.unroute('**/fixture');
    await owner.request('POST',base+'/channels/'+channel.id+'/members',{user_ids:[member.userId]});
    await page.evaluate(async({userId,channelId})=>{const w=window as any;w.instance.destroy();w.viewer='member';w.instance=w.FirstMateChannels.create(document.querySelector('#app'),{...w.options,currentUser:{id:userId,name:'Regular Member'}});await w.instance.setChannel(channelId);},{userId:member.userId,channelId:channel.id});
    const dialog=await open();await dialog.locator('.fm-ch-current-members').waitFor();assert.equal(await dialog.getByRole('button',{name:/Remove .* from channel/}).count(),0);
    assert.equal((await member.client.raw('DELETE',base+'/channels/'+channel.id+'/members/'+admin.userId)).statusCode,403);
    assert.equal((await owner.raw('DELETE',base+'/channels/'+channel.id+'/members/'+ownerId)).statusCode,200); // Admin remains as channel manager.
    assert.equal((await admin.client.raw('DELETE',base+'/channels/'+channel.id+'/members/'+admin.userId)).statusCode,400); // Last manager remains protected.
    assert.deepEqual(errors,[]);
    console.log('PASS real API payload + in-place owner/admin removal/add-back, same dialog/no backdrop cycles, error/retry focus, retained search, refresh/reopen, ordinary member denial and last-manager guard');
  }catch(error){console.error(error);throw error;}finally{await page.evaluate(()=>{const w=window as any;w.instance?.destroy();}).catch(()=>{});await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
