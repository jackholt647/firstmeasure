import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const clients = [
  ...['platform','canvassing','equipment','email','materials','lead-intake','payments','proposals','channels','communications','crew','documents','payroll','sales','training','websites'].map(name => ({
    path:`../../libraries/${name}-api/${name}-api.js`,
    name:name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('') + 'API',
    send:api => api.request('/organizations/org-1/test', { method:'POST', body:{} })
  })),
  { path:'../../libraries/calls-api/calls-api.js', name:'CallsAPI', send:api => api.rooms.create('org-1', {}) },
  { path:'../../libraries/comms-api/comms-api.js', name:'CommsAPI', send:api => api.reply('org-1','conversation-1',{}) },
  { path:'../../libraries/stats-api/stats-api.js', name:'StatsAPI', send:api => api.views.create('org-1',{}) },
  { path:'../../libraries/domains-api/domains-api.js', name:'DomainsAPI', send:api => api.connect('org-1','example.com') },
  { path:'../../libraries/audio-notes/audio-notes.js', name:'FirstMateAudioNotes', send:api => api.upload('org-1', {name:'audio.wav'}) },
  { path:'../../libraries/audio-structure/audio-structure.js', name:'FirstMateAudioStructure', send:api => api.recordAndProcess({ mount:{}, url:'/v1/test/audio' }) },
  { path:'../../libraries/assistant-api/assistant-api.js', name:'AssistantAPI', send:(api) => api.createThread('org-1', {}) },
  { path:'../../libraries/agents-api/agents-api.js', name:'AgentsAPI', send:(api) => api.createThread('org-1', 'global', {}) }
];

async function sentHeaders(client, sessionName, cookie){
  let requestOptions;
  const context = {
    window:{ __APP:sessionName ? { platformSessionCookieName:sessionName } : {},
      FirstMateAudioNotes: client.name === 'FirstMateAudioStructure' ? {
        recordInline:async () => ({file:{name:'audio.wav'}}), toWavFile:async file => file
      } : undefined },
    document:{ cookie, getElementById:() => ({}) },
    location:{ origin:'https://dev.1m8.ai', hostname:'dev.1m8.ai' },
    FormData:class FormData { append(){} },
    fetch:async (_url, options) => {
      requestOptions = options;
      return { ok:true, status:200, text:async () => '{"ok":true}' };
    }
  };
  vm.runInNewContext(readFileSync(new URL(client.path, import.meta.url), 'utf8'), context);
  await client.send(context.window[client.name]);
  const firstHeaders = requestOptions.headers;
  // A login/account switch in another tab updates cookies without reloading this client.
  context.document.cookie = `${sessionName || 'fm_platform_session'}_csrf=rotated%3Atoken`;
  await client.send(context.window[client.name]);
  assert.equal(requestOptions.headers['X-Platform-CSRF'], 'rotated:token');
  return firstHeaders;
}

test('browser bundles do not reintroduce a fixed production CSRF cookie name', () => {
  const root = new URL('../../libraries/', import.meta.url);
  for (const file of readdirSync(root, { recursive:true }).filter(file => file.endsWith('.js'))) {
    assert.ok(!readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8').includes('fm_platform_session_csrf'), file);
  }
});

for (const client of clients) {
  test(`${client.name} sends the configured development session CSRF token`, async () => {
    const headers = await sentHeaders(client, 'fm_platform_session_development',
      'fm_platform_session_csrf=stale; fm_platform_session_development_csrf=dev%3Atoken');
    assert.equal(headers['X-Platform-CSRF'], 'dev:token');
  });

  test(`${client.name} tolerates a malformed cookie`, async () => {
    const headers = await sentHeaders(client, 'fm_platform_session_development', 'fm_platform_session_development_csrf=%E0%A4%A');
    assert.equal(headers['X-Platform-CSRF'], undefined);
  });

  test(`${client.name} retains the production cookie fallback`, async () => {
    const headers = await sentHeaders(client, '', 'fm_platform_session_csrf=prod%3Atoken');
    assert.equal(headers['X-Platform-CSRF'], 'prod:token');
  });

  test(`${client.name} does not use a different session's token`, async () => {
    const headers = await sentHeaders(client, 'fm_platform_session_development', 'fm_platform_session_csrf=stale');
    assert.equal(headers['X-Platform-CSRF'], undefined);
  });
}
