import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../../libraries/phone-features/phone-features.js',import.meta.url),'utf8');
function fixture(native=false){
  const handlers={},sent=[];const window={addEventListener:(name,fn)=>handlers[name]=fn,dispatchEvent:()=>{}};
  if(native)window.FirstMeasureNative={postMessage:value=>sent.push(JSON.parse(value))};
  const document={documentElement:{dataset:{}},addEventListener:()=>{}};
  vm.runInNewContext(source,{window,document,location:{href:'https://dev.1m8.ai/portal/',origin:'https://dev.1m8.ai'},navigator:{},URL,CustomEvent:class{constructor(type,data){Object.assign(this,{type,...data});}},setTimeout,clearTimeout});
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
