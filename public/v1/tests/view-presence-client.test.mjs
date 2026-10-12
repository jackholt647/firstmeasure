import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js', import.meta.url), 'utf8');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

/** A page with the realtime client loaded and a stand-in EventSource that records every connection. */
function page(app = {}) {
  const document = new EventTarget(); document.hidden = false; document.cookie = 'fm_platform_session_csrf=token';
  const window = new EventTarget(); window.__APP = app;
  const sources = [], requests = [];
  class Source extends EventTarget {
    constructor(url, options) { super(); this.url = url; this.options = options; sources.push(this); }
    close() { this.closed = true; }
    open() { this.dispatchEvent(new Event('open')); }
    emit(name, data) { const event = new Event(name); event.data = JSON.stringify(data); this.dispatchEvent(event); }
    channel(channel, event, data) { this.emit('channel', { channel, event, data }); }
  }
  window.EventSource = Source;
  window.fetch = async (...args) => { requests.push(args); return { ok: true, json: async () => ({ events: [], next: 0 }) }; };
  const context = vm.createContext({ window, document, EventSource: Source, Date, setTimeout, clearTimeout, console, fetch: window.fetch, CustomEvent: class extends Event { constructor(name, init) { super(name); this.detail = init?.detail; } }, location: { origin: 'https://example.test', hostname: 'example.test' } });
  vm.runInContext(clientSource, context);
  const open = () => sources.filter(source => !source.closed);
  const watched = source => new URL(source.url).searchParams.getAll('watch').sort();
  return { window, document, sources, requests, open, watched, realtime: window.PlatformRealtime };
}

test('viewing presence rides the one stream, follows visibility and clears on connection loss', async () => {
  const { document, sources, open, watched, realtime } = page();
  let roster = [];
  const stop = realtime.watchPresence('org', 'project:one', users => { roster = users; });
  await tick();
  assert.equal(sources.length, 1, 'one connection');
  assert.match(sources[0].url, /\/organizations\/org\/events\/stream\?/);
  assert.deepEqual(watched(sources[0]), ['presence:project:one']);
  assert.equal(sources[0].options.withCredentials, true);
  sources[0].open();
  sources[0].channel('presence:project:one', 'presence', [{ user_id: 'bill' }]);
  assert.equal(roster[0].user_id, 'bill');
  // Another channel's frames are not this watcher's.
  sources[0].channel('presence:project:two', 'presence', [{ user_id: 'eve' }]);
  assert.equal(roster[0].user_id, 'bill');
  sources[0].onerror(); assert.equal(roster.length, 0, 'a lost stream clears the people it listed');
  // Hidden: this page is not looking, so it stops watching and nothing stays connected for it.
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(open().length, 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  assert.equal(open().length, 1);
  open()[0].channel('presence:project:one', 'presence', [{ user_id: 'sam' }]); assert.equal(roster[0].user_id, 'sam');
  stop();
  await tick();
  assert.equal(open().length, 0, 'nothing watched, nothing connected');
});

test('events, online presence, a project and a document share one connection, replaced without a gap', async () => {
  const { window, sources, open, watched, realtime } = page({ userOrgId: 'org' });
  const events = [], collab = [];
  realtime.subscribe('org', 'channels.', event => events.push(event));
  const stopProject = realtime.watchPresence('org', 'project:one', () => {});
  const stopDoc = realtime.watchChannel('org', 'collab:doc1', { onEvent: (event, data) => collab.push([event, data]) });
  await tick();
  // The first subscriber connected at once; the watches that followed replaced that connection.
  open()[open().length - 1].open();
  assert.equal(open().length, 1, 'four consumers, one connection');
  const first = open()[0];
  assert.deepEqual(watched(first), ['collab:doc1', 'presence:online', 'presence:project:one']);
  assert.match(first.url, /activity_age_ms=\d+/);
  first.emit('platform', { topic: 'channels.typing', payload: {} });
  first.channel('collab:doc1', 'hello', { revision: 4 });
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(collab), JSON.stringify([['hello', { revision: 4 }]]));
  // The project closes: the stream is replaced, and the old one keeps delivering until the new one is open.
  stopProject();
  await tick();
  assert.equal(open().length, 2, 'new connection first');
  const second = open()[1];
  assert.deepEqual(watched(second), ['collab:doc1', 'presence:online']);
  first.channel('collab:doc1', 'commands', { revision: 5 });
  assert.equal(collab.length, 2, 'the connection being replaced still delivers');
  second.open();
  assert.equal(first.closed, true, 'old connection closed once the new one is open');
  assert.equal(open().length, 1);
  assert.equal(realtime.diagnostics()[0].channels.join(), 'collab:doc1,presence:online');
  assert.equal(realtime.diagnostics()[0].connections, 1);
  // A channel the server refuses or ends is reported to its watcher alone.
  let down = '';
  const stopDenied = realtime.watchChannel('org', 'collab:secret', { onDown: code => { down = code; } });
  await tick();
  const third = open()[open().length - 1]; third.open();
  third.channel('collab:secret', 'error', { code: 'forbidden' });
  assert.equal(down, 'forbidden');
  stopDenied(); stopDoc();
  await tick();
  // Leaving the page lets go of the stream; coming back restores it.
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(open().length, 0);
  window.dispatchEvent(new Event('pageshow'));
  assert.equal(open().length, 1);
  assert.equal(sources.every(source => /\/events\/stream/.test(source.url)), true, 'every connection ever opened is the platform stream');
});

test('global tab presence survives hiding, shares the Channels observer and reports interaction', async () => {
  const { window, document, sources, requests, open, realtime } = page({ userOrgId: 'org' });
  await tick();
  assert.equal(sources.length, 1, 'starts without opening Channels');
  let users = []; const stop = realtime.watchPresence('org', 'online', value => { users = value; });
  await tick();
  assert.equal(sources.length, 1, 'Channels shares the global connection');
  sources[0].open();
  sources[0].channel('presence:online', 'session', { session_id: 'one' });
  sources[0].channel('presence:online', 'presence', [{ user_id: 'bill', status: 'away' }]); assert.equal(users[0].status, 'away');
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.ok(!sources[0].closed);
  document.dispatchEvent(new Event('pointermove')); assert.equal(requests.length, 0);
  document.hidden = false; document.dispatchEvent(new Event('keydown')); assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0][1].body).session_id, 'one');
  assert.equal(requests[0][1].headers['x-platform-csrf'], 'token');
  stop(); await tick(); assert.ok(!sources[0].closed, 'closing Channels keeps global presence');
  window.dispatchEvent(new Event('pagehide')); assert.equal(sources[0].closed, true);
  window.dispatchEvent(new Event('pageshow')); assert.equal(sources.length, 2);
  realtime.startPresence(''); await tick(); assert.equal(open().length, 0);
});
