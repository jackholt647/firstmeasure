import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('presence reconnects on visibility changes and clears stale people on connection loss', async () => {
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget(); window.__APP = {};
  const sources = [];
  class Source extends EventTarget {
    constructor(url, options) { super(); this.url = url; this.options = options; sources.push(this); }
    close() { this.closed = true; }
    roster(users) { const event = new Event('presence'); event.data = JSON.stringify(users); this.dispatchEvent(event); }
  }
  window.EventSource = Source;
  const context = vm.createContext({ window, document, EventSource: Source, location: { origin: 'https://example.test', hostname: 'example.test' } });
  vm.runInContext(await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js', import.meta.url), 'utf8'), context);
  let roster = [];
  const stop = window.PlatformRealtime.watchPresence('org', 'project:one', users => { roster = users; });
  assert.match(sources[0].url, /presence\/project%3Aone$/);
  assert.equal(sources[0].options.withCredentials, true);
  sources[0].roster([{ user_id: 'bill' }]);
  assert.equal(roster[0].user_id, 'bill');
  sources[0].onerror(); assert.equal(roster.length, 0);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources[0].closed, true);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources.length, 2);
  sources[1].roster([{ user_id: 'sam' }]); assert.equal(roster[0].user_id, 'sam');
  stop(); assert.equal(sources[1].closed, true); assert.equal(roster.length, 0);
  window.dispatchEvent(new Event('pageshow')); assert.equal(sources.length, 2);
});

test('global tab presence survives hiding, shares the Channels observer and reports interaction', async () => {
  const document=new EventTarget();document.hidden=false;document.cookie='fm_platform_session_csrf=token';
  const window=new EventTarget();window.__APP={userOrgId:'org'};
  const sources=[],requests=[];
  class Source extends EventTarget {
    constructor(url){super();this.url=url;sources.push(this);} close(){this.closed=true;}
    emit(name,data){const e=new Event(name);e.data=JSON.stringify(data);this.dispatchEvent(e);}
  }
  window.EventSource=Source;window.fetch=async(...args)=>{requests.push(args);return {ok:true};};
  const context=vm.createContext({window,document,EventSource:Source,Date,setTimeout,clearTimeout,location:{origin:'https://example.test',hostname:'example.test'}});
  vm.runInContext(await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js',import.meta.url),'utf8'),context);
  assert.equal(sources.length,1,'starts without opening Channels');
  let users=[];const stop=window.PlatformRealtime.watchPresence('org','online',value=>users=value);
  assert.equal(sources.length,1,'Channels shares the global connection');
  sources[0].emit('session',{session_id:'one'});
  sources[0].emit('presence',[{user_id:'bill',status:'away'}]);assert.equal(users[0].status,'away');
  document.hidden=true;document.dispatchEvent(new Event('visibilitychange'));assert.ok(!sources[0].closed);
  document.dispatchEvent(new Event('pointermove'));assert.equal(requests.length,0);
  document.hidden=false;document.dispatchEvent(new Event('keydown'));assert.equal(requests.length,1);
  assert.equal(JSON.parse(requests[0][1].body).session_id,'one');
  assert.equal(requests[0][1].headers['x-platform-csrf'],'token');
  stop();assert.ok(!sources[0].closed,'closing Channels keeps global presence');
  window.dispatchEvent(new Event('pagehide'));assert.equal(sources[0].closed,true);
  window.dispatchEvent(new Event('pageshow'));assert.equal(sources.length,2);
  window.PlatformRealtime.startPresence('');assert.equal(sources[1].closed,true);
});
