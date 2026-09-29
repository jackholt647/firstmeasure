import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('SSE failure immediately polls, refreshes every second and recovers SSE with its cursor', async () => {
  const timers=new Map(), sources=[], received=[], requests=[];
  let timerId=0;
  class EventSource {
    constructor(url){this.url=url;this.listeners={};sources.push(this);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    close(){this.closed=true;}
  }
  const window={EventSource,dispatchEvent(){}};
  const context=vm.createContext({window,EventSource,console,location:{origin:'https://example.test',hostname:'example.test'},document:{hidden:false},CustomEvent:class {},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    fetch:async url=>{requests.push(url);return {ok:true,json:async()=>({events:[{seq:1,topic:'channels.typing',payload:{typing:true}}],next:1})};}});
  vm.runInContext(await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js',import.meta.url),'utf8'),context);
  const unsubscribe=window.PlatformRealtime.subscribe('org','channels.',event=>received.push(event));
  assert.equal(sources.length,1);
  sources[0].onerror();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,1,'fallback should begin immediately');
  assert.equal(received.length,1);
  const poll=[...timers].find(([,timer])=>timer.ms===1000);
  assert.ok(poll,'active fallback should poll every second');
  timers.delete(poll[0]); await poll[1].fn();
  assert.equal(received.length,1,'duplicate cursor events should not dispatch twice');
  const retry=[...timers].find(([,timer])=>timer.ms===30000);
  timers.delete(retry[0]); retry[1].fn();
  assert.equal(sources.length,2,'SSE must recover after fallback');
  assert.match(sources[1].url,/after=1/);
  sources[1].listeners.platform({lastEventId:'2',data:JSON.stringify({topic:'channels.typing',payload:{typing:false}})});
  assert.equal(received.length,2);
  unsubscribe();
  assert.ok(sources[1].closed);
  assert.equal(timers.size,0);
});
