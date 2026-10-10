import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-feed-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
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
  (await closeChannelsDatabase());
  (await closeCallsDatabase());
  if (app) await app.close();
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
  await enableExpandedPlatformFixture(registered.organization.id, {"platform.project_photos":true,"platform.photos_feed":true});
  return { client, suffix, orgId: String(registered.organization.id), userId: String(registered.user.id) };
}

test('manual company and department posts obey membership and posts settings', async () => {
  const {client,orgId,userId}=await registerOwner();
  const {upsertDocument}=await import('../platform/storage.js');
  const base=`/v1/channels/organizations/${orgId}/feed`;
  const company=await client.request('POST',base+'/posts/manual',{text:'Happy birthday, team!',mention_user_ids:[userId],client_msg_id:'birthday'});
  const duplicate=await client.request('POST',base+'/posts/manual',{text:'Happy birthday, team!',mention_user_ids:[userId],client_msg_id:'birthday'});
  assert.equal(company.post.id,duplicate.post.id);
  assert.equal(company.post.mention_users[0].id,userId);
  const gif=await client.request('POST',base+'/posts/manual',{text:'',giphy:{id:'birthday123',url:'https://media1.giphy.com/media/birthday123/giphy.gif',title:'Birthday GIF',width:200,height:150}});
  assert.equal(gif.post.metadata.giphy.id,'birthday123');
  assert.equal((await client.raw('POST',base+'/posts/manual',{text:''})).statusCode,400);
  assert.equal((await client.request('GET',base+'/catalog')).manual_posts.some((post:any)=>post.id===company.post.id),true);
  const comment=await client.request('POST',`${base}/posts/${company.post.id}/comments`,{text:'Cheers!'});
  assert.equal(comment.message.parent_id,company.post.id);
  await upsertDocument(orgId,'organization_departments',{id:'catalog',data:{departments:[{id:'roofing',label:'Roofing',color:'#64748b',group_id:'',subject_keys:[`organization_user:${userId}`],role_ids:[],group_kind_ids:[]}],groups:[]}});
  const department=await client.request('POST',base+'/posts/manual',{text:'Roofing crew update',department_id:'roofing'});
  assert.equal((await client.request('GET',base+'/catalog')).manual_posts.some((post:any)=>post.id===department.post.id),true);
  const settings=await client.request('GET',base+'/settings');
  const saved=await client.request('PUT',base+'/settings',{...settings.settings,company_activity_types:['media.uploaded'],department_activity_types:{roofing:['note.created']}});
  assert.deepEqual(saved.settings.department_activity_types.roofing,['note.created']);
  await upsertDocument(orgId,'organization_departments',{id:'catalog',data:{departments:[{id:'roofing',label:'Roofing',color:'#64748b',group_id:'',subject_keys:[],role_ids:[],group_kind_ids:[]}],groups:[]},expected_revision:1},{replace:true});
  const hidden=await client.request('GET',base+'/catalog');
  assert.equal(hidden.manual_posts.some((post:any)=>post.id===department.post.id),false);
  assert.equal((await client.raw('GET',`${base}/posts/${department.post.id}`)).statusCode,403);
  assert.equal((await client.raw('POST',`${base}/posts/${department.post.id}/comments`,{text:'Should be denied'})).statusCode,403);
});


test('feed threads use shared messages/reactions, stay hidden, and reauthorize artifacts', async () => {
  const {client,orgId,userId}=await registerOwner();
  const {upsertDocument,readDocument}=await import('../platform/storage.js');
  const {listChannelRecords,readMessageRecord,findChannelByDmKey,listMessageRecords}=await import('../channels/storage.js');
  const base=`/v1/channels/organizations/${orgId}`;
  const projectId='project_feed';
  await upsertDocument(orgId,'projects',{id:projectId,data:{title:'Feed test',branch_id:'default',photos:[{id:'photo_1',src:'/photo-1.jpg',uploaded_at:'2026-09-29T12:00:00Z',uploaded_by_user_id:userId},{id:'photo_2',src:'/photo-2.jpg',uploaded_at:'2026-09-29T12:01:00Z',uploaded_by_user_id:userId}],documents:[{id:'contract_1',type:'contract',title:'Signed contract',total_cents:250000}]}});
  const refs=[{kind:'media',id:'photo_1',project_id:projectId},{kind:'media',id:'photo_2',project_id:projectId}];
  const catalog=await client.request('GET',base+'/feed/catalog');
  assert.deepEqual(catalog.views,['list','small','large','mosaic','posts']);
  const empty=await client.request('POST',base+'/feed/posts/lookup',{refs});
  assert.equal(empty.root,null);
  assert.equal(await findChannelByDmKey(orgId,'company-feed'),null,'reading does not create a hidden channel');
  const post=await client.request('POST',base+'/feed/posts/resolve',{refs});
  const duplicate=await client.request('POST',base+'/feed/posts/resolve',{refs:refs.slice(1)});
  assert.equal(post.root.id,duplicate.root.id,'upload batch has one stable root');
  assert.equal(post.root.author.id,userId);
  const root=await readMessageRecord(orgId,post.root.id);
  assert.equal(root!.metadata.feed_post,true);
  const comment=await client.request('POST',`${base}/feed/posts/${post.root.id}/comments`,{text:'Great work',client_msg_id:'comment-operation',metadata:{feed_post:true,feed_source:[{kind:'document',id:'forged'}]}});
  assert.equal(comment.message.parent_id,post.root.id);
  const stored=await readMessageRecord(orgId,comment.message.id);
  assert.equal(stored!.metadata.feed_comment,true);
  assert.equal(stored!.metadata.feed_post,undefined);
  await client.request('POST',`${base}/feed/posts/${post.root.id}/comments`,{text:'Great work',client_msg_id:'comment-operation'});
  const liked=await client.request('POST',`${base}/feed/messages/${post.root.id}/reactions`,{emoji:'👍',on:true});
  assert.equal(liked.message.reactions[0].count,1);
  const thread=await client.request('GET',`${base}/feed/posts/${post.root.id}`);
  assert.equal(thread.replies.length,1);
  assert.equal(thread.root.reply_count,1);
  assert.equal((await listChannelRecords(orgId)).some(c=>c.type==='feed'),false);
  const channels=await client.request('GET',base+'/channels');
  assert.equal(channels.channels.some((c:any)=>c.id===root!.channel_id),false);
  const search=await client.request('GET',base+'/search?q=Great');
  assert.equal(search.messages.some((m:any)=>m.id===comment.message.id),false);
  const direct=await client.raw('GET',`${base}/channels/${root!.channel_id}/messages`);
  assert.equal(direct.statusCode,404);
  const rootDelete=await client.raw('DELETE',`${base}/feed/messages/${post.root.id}`);
  assert.equal(rootDelete.statusCode,403);
  const forged=await client.raw('POST',base+'/feed/posts/resolve',{refs:[{kind:'media',id:'photo_1',project_id:'wrong_project'}]});
  assert.ok(forged.statusCode>=400);
  const target=await client.request('POST',base+'/channels',{type:'public',name:'Team'});
  const shared=await client.request('POST',`${base}/feed/messages/${comment.message.id}/share`,{channel_id:target.channel.id});
  assert.equal(shared.message.metadata.forwarded.author.id,userId);
  assert.equal(shared.message.metadata.forwarded.text,'Great work');
  await client.request('PATCH',`${base}/feed/messages/${comment.message.id}`,{text:'Looks excellent'});
  const edited=await client.request('GET',`${base}/feed/posts/${post.root.id}`);
  assert.equal(edited.replies[0].text,'Looks excellent');
  const reply=await client.request('POST',`${base}/feed/posts/${post.root.id}/comments`,{text:'Thanks!',parent_id:comment.message.id});
  assert.equal(reply.message.parent_id,post.root.id,'nested comments retain the Channels thread root');
  assert.equal(reply.message.metadata.feed_reply_to.id,comment.message.id);
  await client.request('DELETE',`${base}/feed/messages/${reply.message.id}`);
  await client.request('POST',`${base}/feed/messages/${reply.message.id}/restore`);
  assert.equal((await client.request('GET',`${base}/feed/posts/${post.root.id}`)).replies.length,2);
  const project=await readDocument(orgId,'projects',projectId);
  await upsertDocument(orgId,'projects',{id:projectId,data:{...project.data,photos:[]}});
  const revoked=await client.raw('GET',`${base}/feed/posts/${post.root.id}`);
  assert.ok(revoked.statusCode>=400,'removed artifact revokes thread access');
  const revokedReaction=await client.raw('POST',`${base}/feed/messages/${comment.message.id}/reactions`,{emoji:'❤️',on:true});
  assert.ok(revokedReaction.statusCode>=400);
});

test('view denies override defaults and document permission revocation hides comments', async () => {
  const {client,orgId,userId}=await registerOwner();
  const {upsertDocument,readDocument}=await import('../platform/storage.js');
  await upsertDocument(orgId,'projects',{id:'project_contract',data:{title:'Contract project',documents:[{id:'contract',type:'contract',total_cents:500000}]}});
  const base=`/v1/channels/organizations/${orgId}/feed`;
  const post=await client.request('POST',base+'/posts/resolve',{refs:[{kind:'document',id:'contract',project_id:'project_contract'}]});
  const user=await readDocument(orgId,'users',userId);
  await upsertDocument(orgId,'users',{id:userId,data:{...user.data,org_permissions:{level:'owner',items:{view_documents:false,view_feed_mosaic:false}}}});
  const catalog=await client.request('GET',base+'/catalog');
  assert.equal(catalog.views.includes('mosaic'),false);
  assert.equal(catalog.projects[0].data.documents.length,0);
  const response=await client.raw('GET',`${base}/posts/${post.root.id}`);
  assert.ok(response.statusCode>=400);
  const authorization=await client.request('POST',base+'/authorize',{refs:[{kind:'document',id:'contract',project_id:'project_contract'}]});
  assert.equal(authorization.sources.length,0);
});


test('durable automated event posts keep actor attribution, deduplicate and stay outside channel inboxes',async()=>{
  const {client,orgId,userId}=await registerOwner();
  const {upsertDocument}=await import('../platform/storage.js');
  const {emitWorkEvent}=await import('../work/engine.js');
  const {recordFeedEvent}=await import('../channels/feed.js');
  const {findChannelByDmKey,listMessageRecords}=await import('../channels/storage.js');
  await upsertDocument(orgId,'projects',{id:'event_project',data:{title:'Event project'}});
  const event=await emitWorkEvent({organization_id:orgId,project_id:'event_project',type:'project.created',actor_user_id:userId,context:{actor_user_id:userId},payload:{title:'Event project'},idempotency_key:'feed-test-event'},{process:false});
  assert.ok(event);
  await Promise.all(Array.from({length:4},()=>recordFeedEvent(event)));
  const channel=await findChannelByDmKey(orgId,'company-feed');assert.ok(channel);
  const messages=await listMessageRecords(orgId,channel.id,{parentId:null});assert.equal(messages.length,1);
  const thread=await client.request('POST',`/v1/channels/organizations/${orgId}/feed/posts/lookup`,{refs:[{kind:'activity',id:event.id,project_id:'event_project'}]});
  assert.equal(thread.root.author.id,userId);
  const {createAuthSession}=await import('../platform/storage.js');
  const {feedPermission}=await import('../channels/feed.js');
  assert.equal(feedPermission({permissions:{}} as any,'view_feed_small'),true);
  assert.equal(feedPermission({permissions:{'*':true,view_feed_small:false}} as any,'view_feed_small'),false);
});
