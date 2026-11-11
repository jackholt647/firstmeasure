import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../../libraries/phone-features/phone-features.js',import.meta.url),'utf8');
function fixture(native=false){
  const handlers={},sent=[];const window={addEventListener:(name,fn)=>handlers[name]=fn,dispatchEvent:()=>{}};
  if(native)window.FirstMeasureNative={postMessage:value=>sent.push(JSON.parse(value))};
  const document={documentElement:{dataset:{}},addEventListener:()=>{}};
  vm.runInNewContext(source,{window,document,location:{href:'https://dev.1m8.ai/portal/',origin:'https://dev.1m8.ai'},navigator:{},URL,crypto:webcrypto,File,Blob,Uint8Array,atob,btoa,CustomEvent:class{constructor(type,data){Object.assign(this,{type,...data});}},setTimeout,clearTimeout});
  return{window,document,sent,handlers,api:window.PhoneFeatures,reply:(id,result,error)=>window.FirstMeasureNative.onmessage({data:JSON.stringify({id,result,error})})};
}
test('desktop has no native side effects and does not change document attributes',async()=>{
  const f=fixture();assert.equal(await f.api.ready,null);assert.equal(f.api.isNative(),false);assert.deepEqual(f.document.documentElement.dataset,{});await f.api.haptic();
  await assert.rejects(f.api.openSettings(),{code:'unsupported'});await assert.rejects(f.api.download('https://evil.test/report.pdf'));
});
test('versioned handshake, request matching, errors and close cleanup',async()=>{
  const f=fixture(true);assert.equal(f.sent[0].method,'info');f.reply(f.sent[0].id,{bridgeVersion:1,platform:'android'});await f.api.ready;assert.equal(f.document.documentElement.dataset.nativeApp,'android');
  const share=f.api.share({text:'report',url:'/portal/'});const call=f.sent.at(-1);assert.equal(call.method,'share');assert.equal(call.payload.url,'https://dev.1m8.ai/portal/');f.reply('unknown',true);f.reply(call.id,true);assert.equal(await share,true);
  const failed=f.api.haptic();f.reply(f.sent.at(-1).id,null,{code:'denied',message:'Denied'});await assert.rejects(failed,{code:'denied'});
  const pending=f.api.openSettings();f.handlers.pagehide();await assert.rejects(pending,/Page closed/);
});
test('future native protocol fails safely without activating native layout',async()=>{
  const f=fixture(true);f.reply(f.sent[0].id,{bridgeVersion:99,platform:'ios'});assert.equal(await f.api.ready,null);assert.deepEqual(f.document.documentElement.dataset,{});
});

test('native camera commands keep session identity and capture transfer releases its token',async()=>{
 const f=fixture(true);f.reply(f.sent[0].id,{bridgeVersion:1,platform:'android',capabilities:['nativeCameraZoom']});await f.api.ready;
 const camera=f.api.camera.session(),open=camera.open({mode:'video'});const first=f.sent.at(-1);assert.equal(first.method,'cameraOpen');assert.match(first.payload.session,/^[a-f0-9-]{36}$/);f.reply(first.id,{min:.5,max:30,value:1});assert.equal((await open).max,30);
 const zoom=camera.zoom(.5);assert.equal(f.sent.at(-1).payload.session,first.payload.session);f.reply(f.sent.at(-1).id,{value:.5});await zoom;
 const file=camera.file({token:'capture',size:3,mime:'image/jpeg',name:'photo.jpg'});assert.equal(f.sent.at(-1).method,'cameraRead');f.reply(f.sent.at(-1).id,{data:'AQID'});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.sent.at(-1).method,'cameraRelease');f.reply(f.sent.at(-1).id,true);assert.deepEqual([...new Uint8Array(await (await file).arrayBuffer())],[1,2,3]);
 const close=camera.close();assert.equal(f.sent.at(-1).payload.session,first.payload.session);f.reply(f.sent.at(-1).id,true);await close;
});
test('settings categories without terminology keys keep their supplied title',()=>{
  const company=fs.readFileSync(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const expression=company.match(/const sectionTitle = ([^\n]+);/)?.[1];assert.ok(expression);
  const title=vm.runInNewContext(expression,{terminologyLabel:(key,fallback)=>{assert.equal(typeof key,'string');return 'Translated '+fallback;}});
  assert.equal(title({title:'App download'}),'App download');assert.equal(title({title:'Company',term:'settings.company_tab'}),'Translated Company');assert.equal(title(null),'');
});

test('app download stays hidden until an organization explicitly enables it',()=>{
  const company=fs.readFileSync(new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
  const defaults=company.match(/const DEFAULT_VISIBLE_APP_FLAGS = (\{[\s\S]*?\n  \});/)[1];
  const flag=company.slice(company.indexOf('  function appFlag(group, flag){'),company.indexOf('  function appFlagValue('));
  for(const loaded of [false,true]) {
    for(const value of [undefined,false,true]) {
      const enabled=vm.runInNewContext(`const DEFAULT_VISIBLE_APP_FLAGS=${defaults};${flag};appFlag('mobile','app_download')`,{
        appFlagsLoaded:()=>loaded,window:{PlatformAPI:{appFlags:{has:()=>value===true,value:()=>value}}}
      });
      assert.equal(enabled,loaded && value===true);
    }
  }
});

test('hardware diagnostics are requested explicitly without opening a camera or sharing automatically',async()=>{
 const f=fixture(true);f.reply(f.sent[0].id,{bridgeVersion:1,platform:'android',capabilities:['physicalCameraZoom']});await f.api.ready;
 const pending=f.api.camera.diagnostics();assert.equal(f.sent.at(-1).method,'cameraDiagnostics');
 f.reply(f.sent.at(-1).id,{routes:[{logicalId:'0',physicalId:'2',min:.5,max:4}]});assert.equal((await pending).routes[0].min,.5);
 assert.equal(f.sent.some(c=>c.method==='cameraOpen'||c.method==='share'),false);
});

// Offline: durable files, background uploads and camera-roll copies (native/firstmate/README.md, "Offline").
async function nativeFixture(capabilities){const f=fixture(true);f.reply(f.sent[0].id,{bridgeVersion:1,platform:'android',capabilities});await f.api.ready;return f;}
// The adapter awaits between calls; wait for the next native call instead of counting turns of the event loop.
async function next(f,index){for(let i=0;i<500&&f.sent.length<=index;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(f.sent.length>index,'expected native call '+index);return f.sent[index];}
const bytesOf=data=>Buffer.from(data,'base64');

test('offline uploads and camera-roll copies are refused without their capability',async()=>{
  const desktop=fixture();assert.equal(desktop.api.offlineUploads.available(),false);assert.equal(desktop.api.supports('offlineUploads'),false);
  await assert.rejects(desktop.api.offlineUploads.status(),{code:'unsupported'});await assert.rejects(desktop.api.saveToPhotoLibrary({cameraToken:'t'}),{code:'unsupported'});
  const old=await nativeFixture(['camera']);assert.equal(old.api.supports('camera'),true);assert.equal(old.api.offlineUploads.available(),false);
  await assert.rejects(old.api.offlineUploads.enqueue({id:'a',url:'/v1/x'}),{code:'unsupported'});await assert.rejects(old.api.offlineUploads.putBlob('a',new Blob(['x'])),{code:'unsupported'});
  await assert.rejects(old.api.offlineUploads.cancel('a'),{code:'unsupported'});await assert.rejects(old.api.saveToPhotoLibrary({put:'a'}),{code:'unsupported'});
  assert.equal(old.sent.length,1,'an older app receives no method it does not know');
  // Each ability is its own capability: uploads without camera-roll saving.
  const uploadsOnly=await nativeFixture(['offlineUploads']);assert.equal(uploadsOnly.api.offlineUploads.available(),true);await assert.rejects(uploadsOnly.api.saveToPhotoLibrary({put:'a'}),{code:'unsupported'});
});

test('a blob is handed to the host in 256 KB steps and continues where it stopped',async()=>{
  const f=await nativeFixture(['offlineUploads']);assert.equal(f.api.offlineUploads.chunkSize,262144);
  const size=262144+10,content=Buffer.alloc(size);for(let i=0;i<size;i++)content[i]=(i*13)%251;
  const progress=[],whole=f.api.offlineUploads.putBlob('fmo1-a',new Blob([content]),{onProgress:(sent,total)=>progress.push(sent+'/'+total)});
  let call=await next(f,1);assert.equal(call.method,'offlineUploads.put');assert.deepEqual(call.payload,{id:'fmo1-a',offset:0,data:'',done:false});f.reply(call.id,{size:0,done:false,accepted:true});
  call=await next(f,2);assert.equal(call.payload.offset,0);assert.equal(call.payload.done,false);const first=bytesOf(call.payload.data);assert.equal(first.length,262144);
  assert.ok(JSON.stringify(call).length<400*1024,'one step fits the host limit for this method');f.reply(call.id,{size:262144,done:false,accepted:true});
  call=await next(f,3);assert.equal(call.payload.offset,262144);assert.equal(call.payload.done,true);const second=bytesOf(call.payload.data);assert.equal(second.length,10);
  f.reply(call.id,{size,done:true,accepted:true});const stored=await whole;assert.equal(stored.size,size);assert.equal(stored.done,true);
  assert.equal(Buffer.compare(Buffer.concat([first,second]),content),0);assert.deepEqual(progress,['262144/'+size,size+'/'+size]);

  // The host already holds the first step: only the rest is sent.
  const resumed=f.api.offlineUploads.putBlob('fmo1-b',new Blob([content]));
  call=await next(f,4);assert.equal(call.payload.data,'');f.reply(call.id,{size:262144,done:false,accepted:true});
  call=await next(f,5);assert.equal(call.payload.offset,262144);assert.equal(call.payload.done,true);
  // The host disagrees (its copy was cleared): the transfer follows it once; a second disagreement is an error.
  f.reply(call.id,{size:0,done:false,accepted:false});
  call=await next(f,6);assert.equal(call.payload.offset,0);assert.equal(bytesOf(call.payload.data).length,262144);f.reply(call.id,{size:5,done:false,accepted:false});
  await assert.rejects(resumed,{code:'put_out_of_sync'});

  // Everything is there but not marked complete: one empty step completes it.
  const finishing=f.api.offlineUploads.putBlob('fmo1-c',new Blob([content]));
  call=await next(f,7);f.reply(call.id,{size,done:false,accepted:true});
  call=await next(f,8);assert.deepEqual(call.payload,{id:'fmo1-c',offset:size,data:'',done:true});f.reply(call.id,{size,done:true,accepted:true});assert.equal((await finishing).done,true);
  // Already complete: nothing is sent again. A complete file of another size is replaced from the start.
  const complete=f.api.offlineUploads.putBlob('fmo1-d',new Blob([content]));call=await next(f,9);f.reply(call.id,{size,done:true,accepted:true});assert.equal((await complete).done,true);assert.equal(f.sent.length,10);
  const replaced=f.api.offlineUploads.putBlob('fmo1-e',new Blob([content.subarray(0,100)]));call=await next(f,10);f.reply(call.id,{size,done:true,accepted:true});
  call=await next(f,11);assert.equal(call.payload.offset,0);assert.equal(call.payload.done,true);assert.equal(bytesOf(call.payload.data).length,100);f.reply(call.id,{size:100,done:true,accepted:true});await replaced;
  await assert.rejects(f.api.offlineUploads.putBlob('x',new Blob([])),{code:'invalid_file'});await assert.rejects(f.api.offlineUploads.putBlob('x','text'),{code:'invalid_file'});
  await assert.rejects(f.api.offlineUploads.putBlob('x',{size:151*1024*1024,__proto__:Blob.prototype}),{code:'file_too_large'});assert.equal(f.sent.length,12);
});

test('an upload is queued on the host only for this application under /v1/',async()=>{
  const f=await nativeFixture(['offlineUploads','photoLibrarySave']);
  const job={id:'fmo1-a',source:{put:'fmo1-a'},url:'/v1/platform/organizations/org_1/media',fileField:'file',fileName:'roof.jpg',contentType:'image/jpeg',fields:{id:'media_1',owner_type:'project'},
    headers:{'Idempotency-Key':'fmo1-a','X-FM-Offline-User':'user_1','X-FM-Offline-Org':'org_1','X-FM-Offline-Replay':'1'},csrfCookie:'fm_platform_session_csrf',saveToPhotos:false};
  const queued=f.api.offlineUploads.enqueue(job);let call=await next(f,1);assert.equal(call.method,'offlineUploads.enqueue');
  assert.deepEqual(call.payload,{...job,url:'https://dev.1m8.ai/v1/platform/organizations/org_1/media'});f.reply(call.id,{id:'fmo1-a',state:'queued',created:true});assert.equal((await queued).state,'queued');
  for(const url of ['https://evil.test/v1/x','/portal/index.php','//evil.test/v1/x','https://dev.1m8.ai.evil.test/v1/x','http://dev.1m8.ai/v1/x'])await assert.rejects(f.api.offlineUploads.enqueue({...job,url}),{code:'untrusted_url'});
  await assert.rejects(f.api.offlineUploads.enqueue(null),{code:'invalid_request'});assert.equal(f.sent.length,2,'nothing reaches the host for another site');

  const status=f.api.offlineUploads.status(['fmo1-a']);call=await next(f,2);assert.equal(call.method,'offlineUploads.status');assert.deepEqual(call.payload,{ids:['fmo1-a']});
  f.reply(call.id,[{id:'fmo1-a',state:'done',status:201,body:'{"ok":true}',attempts:1,updatedAt:1}]);const jobs=await status;assert.equal(jobs[0].state,'done');assert.equal(JSON.parse(jobs[0].body).ok,true);
  const all=f.api.offlineUploads.status();call=await next(f,3);assert.deepEqual(call.payload,{});f.reply(call.id,[]);assert.equal((await all).length,0);
  const ack=f.api.offlineUploads.ack(['fmo1-a']);call=await next(f,4);assert.equal(call.method,'offlineUploads.ack');assert.deepEqual(call.payload,{ids:['fmo1-a']});f.reply(call.id,{acked:['fmo1-a']});assert.equal((await ack).acked[0],'fmo1-a');
  const cancel=f.api.offlineUploads.cancel('fmo1-b');call=await next(f,5);assert.equal(call.method,'offlineUploads.cancel');assert.deepEqual(call.payload,{id:'fmo1-b'});f.reply(call.id,{cancelled:true});assert.equal((await cancel).cancelled,true);

  const capture=f.api.saveToPhotoLibrary({cameraToken:'token-1',put:'ignored'});call=await next(f,6);assert.equal(call.method,'photoLibrarySave');assert.deepEqual(call.payload,{cameraToken:'token-1'});f.reply(call.id,{saved:true});assert.equal((await capture).saved,true);
  const file=f.api.saveToPhotoLibrary({put:'fmo1-a',contentType:'image/jpeg',fileName:'roof.jpg'});call=await next(f,7);assert.deepEqual(call.payload,{put:'fmo1-a',contentType:'image/jpeg',fileName:'roof.jpg'});
  f.reply(call.id,null,{code:'photos_permission_denied',message:'Denied'});await assert.rejects(file,{code:'photos_permission_denied'});
});
