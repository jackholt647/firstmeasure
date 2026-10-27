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
  const window={EventSource,dispatchEvent(){},addEventListener(){}};
  const context=vm.createContext({window,EventSource,console,location:{origin:'https://example.test',hostname:'example.test'},document:{hidden:false,addEventListener(){}},CustomEvent:class {},
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

test('only a page on dev.1m8.ai watches the live layer, on the same stream as presence', async () => {
  const run = async (hostname) => {
    const timers=[], sources=[];
    class EventSource { constructor(url){this.url=url;this.listeners={};sources.push(this);} addEventListener(name,fn){this.listeners[name]=fn;} close(){this.closed=true;} }
    const window={EventSource,location:{origin:`https://${hostname}`,hostname},dispatchEvent(){},addEventListener(){},__APP:{userOrgId:'org1'}};
    const context=vm.createContext({window,EventSource,console,location:window.location,document:{hidden:false,addEventListener(){},cookie:''},CustomEvent:class {},
      setTimeout:(fn,ms)=>{timers.push(fn);return timers.length;},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({})})});
    vm.runInContext(await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js',import.meta.url),'utf8'),context);
    timers.splice(0).forEach(fn=>fn());
    return sources.map(source=>decodeURIComponent(source.url));
  };
  const dev = await run('dev.1m8.ai');
  assert.equal(dev.length, 1, 'presence and the live layer share one connection');
  assert.match(dev[0], /watch=presence:online/);
  assert.match(dev[0], /watch=live-assets/);
  const production = await run('app.1m8.ai');
  assert.equal(production.length, 1);
  assert.doesNotMatch(production[0], /live-assets/);
});

test('a portal without platform.expanded_access opens no event stream and polls nothing', async () => {
  const timers=new Map(), sources=[], requests=[], listeners={};
  let timerId=0, expanded=false;
  class EventSource {
    constructor(url){this.url=url;this.listeners={};sources.push(this);}
    addEventListener(name,fn){this.listeners[name]=fn;}
    close(){this.closed=true;}
  }
  const window={EventSource,__APP:{userOrgId:'org',platformExpandedAssets:false},dispatchEvent(){},addEventListener(name,fn){listeners[name]=fn;}};
  const context=vm.createContext({window,EventSource,console,location:{origin:'https://example.test',hostname:'example.test'},document:{hidden:false,cookie:'',addEventListener(){}},CustomEvent:class {},
    setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),
    fetch:async url=>{requests.push(url);return {ok:false};}});
  vm.runInContext(await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js',import.meta.url),'utf8'),context);
  const flush=()=>{for(const [id,timer] of [...timers]){timers.delete(id);timer.fn();}};
  // Account presence starts at load; the page also subscribes and watches a channel.
  window.PlatformRealtime.subscribe('org','projects.',()=>{});
  window.PlatformRealtime.watchPresence('org','project:1',()=>{});
  flush(); flush();
  assert.equal(sources.length,0,'no stream for an organization the server refuses');
  assert.equal(requests.length,0,'no poll fallback either');
  assert.equal(timers.size,0,'nothing left to retry');

  // The portal's own check decides once it is loaded, and access turning on connects.
  window.Portal={platformExpandedAccess:()=>expanded};
  listeners['fm:capabilities:updated']();
  assert.equal(sources.length,0);
  expanded=true;
  listeners['fm:capabilities:updated']();
  assert.equal(sources.length,1,'one stream once expanded access is on');
  assert.match(sources[0].url,/watch=presence%3Aonline/);
});
