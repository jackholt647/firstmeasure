import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('polish cancellation aborts the browser request and preserves normal API calls',async()=>{
  const source=await readFile(new URL('../../libraries/channels-api/channels-api.js',import.meta.url),'utf8');
  const window={},requests=[];
  vm.runInNewContext(source,{window,document:{cookie:''},location:{hostname:'localhost',origin:'http://fixture'},FormData,URLSearchParams,fetch:async(url,options)=>{
    requests.push({url,...options});
    if(options.signal)return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    return {ok:true,text:async()=>'{"ok":true}'};
  }});
  const controller=new AbortController();
  const request=window.ChannelsAPI.compose.polish('org','channel',{text:'helo'},{signal:controller.signal});
  assert.equal(requests[0].signal,controller.signal);
  assert.equal(requests[0].url,'http://fixture/v1/channels/organizations/org/channels/channel/compose/polish');
  assert.deepEqual(JSON.parse(requests[0].body),{text:'helo'});
  controller.abort();await assert.rejects(request,{name:'AbortError'});
  assert.equal((await window.ChannelsAPI.compose.polish('org','channel',{text:'hello'})).ok,true);
});
